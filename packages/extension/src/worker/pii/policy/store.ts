import { emptyPolicy, type SitePolicy, type UserMarkedRegion } from './types.js';
import { isExactOrigin, validatePolicy } from './validate.js';

export interface PolicyStorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

function keyFor(origin: string): string {
  return `privacagent:policy:${origin}`;
}

function isSitePolicy(value: unknown): value is SitePolicy {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.origin === 'string' &&
    Array.isArray(candidate.alwaysRedactSelectors) &&
    candidate.alwaysRedactSelectors.every((s) => typeof s === 'string') &&
    typeof candidate.neverSend === 'boolean' &&
    Array.isArray(candidate.userMarkedRegions) &&
    candidate.userMarkedRegions.every(
      (r) =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as UserMarkedRegion).id === 'string' &&
        typeof (r as UserMarkedRegion).selector === 'string'
    )
  );
}

export interface PolicyStore {
  getPolicy(origin: string): Promise<SitePolicy>;
  setAlwaysRedactSelectors(
    origin: string,
    selectors: readonly string[],
    probe?: ParentNode
  ): Promise<{ ok: boolean; reason?: string }>;
  setNeverSend(origin: string, value: boolean): Promise<{ ok: boolean; reason?: string }>;
  addUserMarkedRegion(
    origin: string,
    region: UserMarkedRegion,
    probe?: ParentNode
  ): Promise<{ ok: boolean; reason?: string }>;
  removeUserMarkedRegion(origin: string, regionId: string): Promise<void>;
  deletePolicy(origin: string): Promise<void>;
}

export function createStoragePolicyStore(area: PolicyStorageAreaLike): PolicyStore {
  async function readPolicy(origin: string): Promise<SitePolicy> {
    const result = await area.get(keyFor(origin));
    const stored = result[keyFor(origin)];
    return isSitePolicy(stored) && stored.origin === origin ? stored : emptyPolicy(origin);
  }

  async function writePolicy(
    policy: SitePolicy,
    probe: ParentNode | undefined
  ): Promise<{ ok: boolean; reason?: string }> {
    const validation = validatePolicy(policy, probe);
    if (!validation.ok) return { ok: false, reason: validation.reason };
    await area.set({ [keyFor(policy.origin)]: policy });
    return { ok: true };
  }

  return {
    getPolicy: readPolicy,

    async setAlwaysRedactSelectors(origin, selectors, probe) {
      if (!isExactOrigin(origin)) return { ok: false, reason: 'origin_not_exact' };
      const current = await readPolicy(origin);
      return writePolicy({ ...current, alwaysRedactSelectors: [...selectors] }, probe);
    },

    async setNeverSend(origin, value) {
      if (!isExactOrigin(origin)) return { ok: false, reason: 'origin_not_exact' };
      const current = await readPolicy(origin);
      await area.set({ [keyFor(origin)]: { ...current, neverSend: value } });
      return { ok: true };
    },

    async addUserMarkedRegion(origin, region, probe) {
      if (!isExactOrigin(origin)) return { ok: false, reason: 'origin_not_exact' };
      const current = await readPolicy(origin);
      const withoutDuplicate = current.userMarkedRegions.filter((r) => r.id !== region.id);
      return writePolicy({ ...current, userMarkedRegions: [...withoutDuplicate, region] }, probe);
    },

    async removeUserMarkedRegion(origin, regionId) {
      if (!isExactOrigin(origin)) return;
      const current = await readPolicy(origin);
      await area.set({
        [keyFor(origin)]: {
          ...current,
          userMarkedRegions: current.userMarkedRegions.filter((r) => r.id !== regionId),
        },
      });
    },

    async deletePolicy(origin) {
      await area.remove(keyFor(origin));
    },
  };
}
