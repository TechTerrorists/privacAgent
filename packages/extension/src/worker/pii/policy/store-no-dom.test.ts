import { describe, expect, it } from 'vitest';

import { createStoragePolicyStore, type PolicyStorageAreaLike } from './store.js';

function createMemoryArea(): PolicyStorageAreaLike {
  const data = new Map<string, unknown>();
  return {
    async get(key) {
      return data.has(key) ? { [key]: data.get(key) } : {};
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    async remove(key) {
      data.delete(key);
    },
  };
}

const ORIGIN = 'https://example.test';

describe('policy store without a DOM (MV3 service worker background context)', () => {
  it('persists a structurally-valid policy with no probe argument at all', async () => {
    expect(typeof document).toBe('undefined');
    const store = createStoragePolicyStore(createMemoryArea());
    const result = await store.setAlwaysRedactSelectors(ORIGIN, ['.sensitive', '#id']);
    expect(result).toEqual({ ok: true });
    const policy = await store.getPolicy(ORIGIN);
    expect(policy.alwaysRedactSelectors).toEqual(['.sensitive', '#id']);
  });

  it('still rejects an empty or overlong selector without a DOM', async () => {
    const store = createStoragePolicyStore(createMemoryArea());
    const empty = await store.setAlwaysRedactSelectors(ORIGIN, ['']);
    expect(empty).toEqual({ ok: false, reason: 'selector_empty' });

    const overlong = await store.setAlwaysRedactSelectors(ORIGIN, ['x'.repeat(400)]);
    expect(overlong).toEqual({ ok: false, reason: 'selector_too_long' });
  });

  it('still rejects too many selectors without a DOM', async () => {
    const store = createStoragePolicyStore(createMemoryArea());
    const result = await store.setAlwaysRedactSelectors(
      ORIGIN,
      Array.from({ length: 51 }, (_, i) => `.s${i}`)
    );
    expect(result).toEqual({ ok: false, reason: 'too_many_selectors' });
  });

  it('cannot catch invalid CSS syntax without a DOM — that is caught later at content-script match time', async () => {
    const store = createStoragePolicyStore(createMemoryArea());
    const result = await store.setAlwaysRedactSelectors(ORIGIN, [':::not-checkable-here']);
    expect(result).toEqual({ ok: true });
  });
});
