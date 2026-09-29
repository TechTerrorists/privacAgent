import { afterEach, describe, expect, it, vi } from 'vitest';

import { executionProviderFor, selectBackend, threadsFor } from './backend.js';
import { BACKEND_ORDER, type BackendName } from './types.js';

/**
 * Prerequisite checks read globals. Each test sets exactly the globals its
 * scenario needs and restores them afterwards.
 */
function setEnvironment(options: {
  crossOriginIsolated?: boolean;
  sharedArrayBuffer?: boolean;
  cores?: number;
  webgpuAdapter?: 'adapter' | 'null' | 'absent' | 'throws';
}): void {
  vi.stubGlobal('crossOriginIsolated', options.crossOriginIsolated ?? false);

  if (options.sharedArrayBuffer === false) {
    vi.stubGlobal('SharedArrayBuffer', undefined);
  }

  vi.stubGlobal('navigator', {
    hardwareConcurrency: options.cores ?? 1,
    ...(options.webgpuAdapter && options.webgpuAdapter !== 'absent'
      ? {
          gpu: {
            requestAdapter: () => {
              if (options.webgpuAdapter === 'throws') throw new Error('driver');
              return Promise.resolve(options.webgpuAdapter === 'adapter' ? {} : null);
            },
          },
        }
      : {}),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('backend ladder order', () => {
  it('attempts WebGPU, then threaded WASM, then plain WASM', () => {
    expect(BACKEND_ORDER).toEqual(['webgpu', 'wasm-threaded', 'wasm']);
  });

  it('maps backends onto ONNX Runtime execution providers', () => {
    expect(executionProviderFor('webgpu')).toBe('webgpu');
    // Threaded WASM is the same provider with a thread count, not its own EP.
    expect(executionProviderFor('wasm-threaded')).toBe('wasm');
    expect(executionProviderFor('wasm')).toBe('wasm');
  });

  it('requests threads only for the threaded backend', () => {
    setEnvironment({ cores: 8 });
    expect(threadsFor('wasm')).toBe(1);
    expect(threadsFor('webgpu')).toBe(1);
    expect(threadsFor('wasm-threaded')).toBeGreaterThan(1);
  });
});

describe('prerequisite checks', () => {
  it('skips WebGPU when no adapter is returned', async () => {
    setEnvironment({ webgpuAdapter: 'null' });
    const selection = await selectBackend(() => Promise.resolve());

    expect(selection.attempts[0]).toEqual({
      backend: 'webgpu',
      outcome: 'unsupported',
      reason: 'no_adapter',
    });
  });

  it('treats a throwing adapter request as unsupported rather than crashing', async () => {
    setEnvironment({ webgpuAdapter: 'throws' });
    const selection = await selectBackend(() => Promise.resolve());

    expect(selection.attempts[0]?.outcome).toBe('unsupported');
  });

  it('skips threaded WASM when the context is not cross-origin isolated', async () => {
    // This is Firefox's permanent state for extension pages (bugzilla 1673477).
    setEnvironment({ crossOriginIsolated: false, cores: 8 });
    const selection = await selectBackend(() => Promise.resolve());

    const threaded = selection.attempts.find((a) => a.backend === 'wasm-threaded');
    expect(threaded).toEqual({
      backend: 'wasm-threaded',
      outcome: 'unsupported',
      reason: 'not_cross_origin_isolated',
    });
    expect(selection.backend).toBe('wasm');
  });

  it('attempts threaded WASM when isolated with more than one core', async () => {
    setEnvironment({ crossOriginIsolated: true, cores: 8 });
    const selection = await selectBackend(() => Promise.resolve());

    expect(selection.backend).toBe('wasm-threaded');
  });
});

describe('detection is not initialization', () => {
  it('falls through when a detected backend fails to initialize', async () => {
    // The common real-world case: an adapter exists, but the driver fails.
    setEnvironment({ crossOriginIsolated: true, cores: 8, webgpuAdapter: 'adapter' });

    const selection = await selectBackend((backend) =>
      backend === 'webgpu' ? Promise.reject(new TypeError('device lost')) : Promise.resolve()
    );

    expect(selection.attempts[0]).toEqual({
      backend: 'webgpu',
      outcome: 'init_failed',
      reason: 'TypeError',
    });
    expect(selection.backend).toBe('wasm-threaded');
  });

  it('never reports a backend it did not successfully execute', async () => {
    setEnvironment({ crossOriginIsolated: true, cores: 8, webgpuAdapter: 'adapter' });

    const selection = await selectBackend(() => Promise.reject(new Error('nope')));

    expect(selection.backend).toBeUndefined();
    for (const attempt of selection.attempts) {
      expect(attempt.outcome).not.toBe('selected');
    }
  });

  it('records a reason code rather than the exception message', async () => {
    setEnvironment({ cores: 1 });
    const selection = await selectBackend(() =>
      Promise.reject(new Error('node Conv_17 failed on tensor [1,3,640,640]'))
    );

    const serialized = JSON.stringify(selection.attempts);
    expect(serialized).not.toContain('Conv_17');
    expect(serialized).not.toContain('640');
  });
});

describe('bounded fallback', () => {
  it('tries each rung exactly once and then stops', async () => {
    setEnvironment({ crossOriginIsolated: true, cores: 8, webgpuAdapter: 'adapter' });
    const tried: BackendName[] = [];

    const selection = await selectBackend((backend) => {
      tried.push(backend);
      return Promise.reject(new Error('fail'));
    });

    expect(tried).toEqual(['webgpu', 'wasm-threaded', 'wasm']);
    expect(selection.attempts).toHaveLength(3);
  });

  it('stops at the first backend that works', async () => {
    setEnvironment({ crossOriginIsolated: true, cores: 8, webgpuAdapter: 'adapter' });
    const tried: BackendName[] = [];

    await selectBackend((backend) => {
      tried.push(backend);
      return Promise.resolve();
    });

    expect(tried).toEqual(['webgpu']);
  });
});
