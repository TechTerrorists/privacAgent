import { describe, expect, it, vi } from 'vitest';

import { SessionCache, sessionKey, type ReleasableSession } from './session-cache.js';
import type { ModelDescriptor } from './types.js';

const MODEL: ModelDescriptor = { id: 'detector', version: '1', bytes: new Uint8Array([1, 2]) };

function fakeSession(): ReleasableSession & { released: number } {
  return {
    released: 0,
    release() {
      this.released += 1;
      return Promise.resolve();
    },
  };
}

/** A factory that resolves only when told to, for exercising concurrency. */
function deferredFactory() {
  let resolve!: (session: ReleasableSession) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<ReleasableSession>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const factory = vi.fn(() => promise);
  return { factory, resolve, reject };
}

describe('cache identity', () => {
  it('keys on model id, version and backend', () => {
    expect(sessionKey(MODEL, 'wasm')).toBe('detector@1#wasm');
    expect(sessionKey(MODEL, 'webgpu')).not.toBe(sessionKey(MODEL, 'wasm'));
    expect(sessionKey({ ...MODEL, version: '2' }, 'wasm')).not.toBe(sessionKey(MODEL, 'wasm'));
  });

  it('reuses a session for the same key', async () => {
    const factory = vi.fn(() => Promise.resolve(fakeSession()));
    const cache = new SessionCache(factory);

    const first = await cache.acquire(MODEL, 'wasm');
    const second = await cache.acquire(MODEL, 'wasm');

    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('compiles separately per backend and per version', async () => {
    const factory = vi.fn(() => Promise.resolve(fakeSession()));
    const cache = new SessionCache(factory);

    await cache.acquire(MODEL, 'wasm');
    await cache.acquire(MODEL, 'webgpu');
    await cache.acquire({ ...MODEL, version: '2' }, 'wasm');

    expect(factory).toHaveBeenCalledTimes(3);
    expect(cache.size).toBe(3);
  });
});

describe('concurrent initialization', () => {
  it('initializes once when several callers race for the same model', async () => {
    const { factory, resolve } = deferredFactory();
    const cache = new SessionCache(factory);

    // Both called before either resolves: the second must join the first.
    const a = cache.acquire(MODEL, 'wasm');
    const b = cache.acquire(MODEL, 'wasm');

    const session = fakeSession();
    resolve(session);

    expect(await a).toBe(session);
    expect(await b).toBe(session);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe('failure recovery', () => {
  it('does not poison the cache when initialization rejects', async () => {
    let attempt = 0;
    const good = fakeSession();
    const cache = new SessionCache(() => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('device lost')) : Promise.resolve(good);
    });

    await expect(cache.acquire(MODEL, 'wasm')).rejects.toThrow();
    expect(cache.has(MODEL, 'wasm')).toBe(false);

    // A transient failure must be retryable, or one bad moment disables the
    // backend for the rest of the session.
    expect(await cache.acquire(MODEL, 'wasm')).toBe(good);
    expect(attempt).toBe(2);
  });

  it('propagates the rejection to every concurrent caller', async () => {
    const { factory, reject } = deferredFactory();
    const cache = new SessionCache(factory);

    const a = cache.acquire(MODEL, 'wasm');
    const b = cache.acquire(MODEL, 'wasm');
    reject(new Error('boom'));

    await expect(a).rejects.toThrow();
    await expect(b).rejects.toThrow();
    expect(cache.size).toBe(0);
  });
});

describe('disposal', () => {
  it('releases every cached session', async () => {
    const sessions = [fakeSession(), fakeSession()];
    let index = 0;
    const cache = new SessionCache(() => Promise.resolve(sessions[index++]!));

    await cache.acquire(MODEL, 'wasm');
    await cache.acquire(MODEL, 'webgpu');
    await cache.dispose();

    expect(sessions[0]!.released).toBe(1);
    expect(sessions[1]!.released).toBe(1);
    expect(cache.size).toBe(0);
  });

  it('releases a session that finishes initializing after disposal began', async () => {
    const { factory, resolve } = deferredFactory();
    const cache = new SessionCache(factory);

    const acquiring = cache.acquire(MODEL, 'wasm');
    const disposing = cache.dispose();

    const session = fakeSession();
    resolve(session);

    await disposing;
    await expect(acquiring).rejects.toThrow();
    // The in-flight session must not be stranded with nothing left to free it.
    expect(session.released).toBe(1);
  });

  it('refuses further acquisition once disposed', async () => {
    const cache = new SessionCache(() => Promise.resolve(fakeSession()));
    await cache.dispose();

    await expect(cache.acquire(MODEL, 'wasm')).rejects.toThrow(/disposed/i);
  });

  it('survives a session whose release rejects', async () => {
    const cache = new SessionCache(() =>
      Promise.resolve({ release: () => Promise.reject(new Error('gone')) })
    );
    await cache.acquire(MODEL, 'wasm');

    // Shutdown must not throw: there is nothing useful left to do with it.
    await expect(cache.dispose()).resolves.toBeUndefined();
  });

  it('evicts one session without touching the others', async () => {
    const sessions = [fakeSession(), fakeSession()];
    let index = 0;
    const cache = new SessionCache(() => Promise.resolve(sessions[index++]!));

    await cache.acquire(MODEL, 'wasm');
    await cache.acquire(MODEL, 'webgpu');
    await cache.evict(MODEL, 'wasm');

    expect(sessions[0]!.released).toBe(1);
    expect(sessions[1]!.released).toBe(0);
    expect(cache.size).toBe(1);
  });
});

describe('bounded growth', () => {
  it('evicts the oldest session past the ceiling', async () => {
    const created: ReturnType<typeof fakeSession>[] = [];
    const cache = new SessionCache(
      () => {
        const session = fakeSession();
        created.push(session);
        return Promise.resolve(session);
      },
      { maxSessions: 2 }
    );

    await cache.acquire({ ...MODEL, id: 'a' }, 'wasm');
    await cache.acquire({ ...MODEL, id: 'b' }, 'wasm');
    await cache.acquire({ ...MODEL, id: 'c' }, 'wasm');

    expect(cache.size).toBe(2);
    expect(created[0]!.released).toBe(1);
    expect(created[2]!.released).toBe(0);
  });
});
