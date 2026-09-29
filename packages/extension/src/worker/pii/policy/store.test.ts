// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { createStoragePolicyStore, type PolicyStorageAreaLike } from './store.js';
import { emptyPolicy } from './types.js';

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

describe('policy store', () => {
  it('returns an empty policy for an origin with nothing stored', async () => {
    const store = createStoragePolicyStore(createMemoryArea());
    expect(await store.getPolicy(ORIGIN)).toEqual(emptyPolicy(ORIGIN));
  });

  it('persists always-redact selectors and reads them back', async () => {
    const store = createStoragePolicyStore(createMemoryArea());
    const result = await store.setAlwaysRedactSelectors(ORIGIN, ['.sensitive'], document);
    expect(result).toEqual({ ok: true });
    const policy = await store.getPolicy(ORIGIN);
    expect(policy.alwaysRedactSelectors).toEqual(['.sensitive']);
  });

  it('refuses to persist an invalid selector', async () => {
    const store = createStoragePolicyStore(createMemoryArea());
    const result = await store.setAlwaysRedactSelectors(ORIGIN, ['[unterminated'], document);
    expect(result.ok).toBe(false);
    const policy = await store.getPolicy(ORIGIN);
    expect(policy.alwaysRedactSelectors).toEqual([]);
  });

  it('refuses to persist anything under a non-exact origin', async () => {
    const store = createStoragePolicyStore(createMemoryArea());
    const result = await store.setAlwaysRedactSelectors(
      'https://example.test/path',
      ['.x'],
      document
    );
    expect(result).toEqual({ ok: false, reason: 'origin_not_exact' });
  });

  it('toggles neverSend without touching other fields', async () => {
    const store = createStoragePolicyStore(createMemoryArea());
    await store.setAlwaysRedactSelectors(ORIGIN, ['.a'], document);
    await store.setNeverSend(ORIGIN, true);
    const policy = await store.getPolicy(ORIGIN);
    expect(policy.neverSend).toBe(true);
    expect(policy.alwaysRedactSelectors).toEqual(['.a']);
  });

  it('adds and removes a user-marked region, replacing by id rather than duplicating', async () => {
    const store = createStoragePolicyStore(createMemoryArea());
    await store.addUserMarkedRegion(ORIGIN, { id: 'r1', selector: '#a' }, document);
    await store.addUserMarkedRegion(ORIGIN, { id: 'r1', selector: '#b' }, document);
    let policy = await store.getPolicy(ORIGIN);
    expect(policy.userMarkedRegions).toEqual([{ id: 'r1', selector: '#b' }]);

    await store.removeUserMarkedRegion(ORIGIN, 'r1');
    policy = await store.getPolicy(ORIGIN);
    expect(policy.userMarkedRegions).toEqual([]);
  });

  it('deletePolicy removes the whole stored definition', async () => {
    const store = createStoragePolicyStore(createMemoryArea());
    await store.setNeverSend(ORIGIN, true);
    await store.deletePolicy(ORIGIN);
    expect(await store.getPolicy(ORIGIN)).toEqual(emptyPolicy(ORIGIN));
  });

  it('never stores vault contents or raw captured regions — only selectors, flags and ids', async () => {
    const store = createStoragePolicyStore(createMemoryArea());
    await store.setAlwaysRedactSelectors(ORIGIN, ['.a'], document);
    await store.addUserMarkedRegion(ORIGIN, { id: 'r1', selector: '#b' }, document);
    const policy = await store.getPolicy(ORIGIN);
    expect(Object.keys(policy).sort()).toEqual(
      ['alwaysRedactSelectors', 'neverSend', 'origin', 'userMarkedRegions'].sort()
    );
  });
});
