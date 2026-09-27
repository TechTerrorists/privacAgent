import type { MessageBus } from '../messaging/bus.js';
import { isNeverSendOrigin } from '../worker/pii/policy/evaluate.js';
import type { PolicyStore } from '../worker/pii/policy/store.js';
import type { SitePolicy, UserMarkedRegion } from '../worker/pii/policy/types.js';

declare module '../messaging/types.js' {
  interface OperationMap {
    'policy:get': { request: { origin: string }; response: SitePolicy };
    'policy:setAlwaysRedactSelectors': {
      request: { origin: string; selectors: readonly string[] };
      response: { ok: boolean; reason?: string };
    };
    'policy:setNeverSend': {
      request: { origin: string; value: boolean };
      response: { ok: boolean; reason?: string };
    };
    'policy:addUserMarkedRegion': {
      request: { origin: string; region: UserMarkedRegion };
      response: { ok: boolean; reason?: string };
    };
    'policy:removeUserMarkedRegion': {
      request: { origin: string; regionId: string };
      response: { ok: true };
    };
  }
}

const WRITE_SOURCES = ['ui', 'content'] as const;

export function registerPolicyHandlers(bus: MessageBus, store: PolicyStore): () => void {
  const unregisters = [
    bus.registerHandler('policy:get', async ({ origin }) => store.getPolicy(origin)),
    bus.registerHandler(
      'policy:setAlwaysRedactSelectors',
      async ({ origin, selectors }) => store.setAlwaysRedactSelectors(origin, selectors),
      { allowedSources: WRITE_SOURCES }
    ),
    bus.registerHandler(
      'policy:setNeverSend',
      async ({ origin, value }) => store.setNeverSend(origin, value),
      { allowedSources: WRITE_SOURCES }
    ),
    bus.registerHandler(
      'policy:addUserMarkedRegion',
      async ({ origin, region }) => store.addUserMarkedRegion(origin, region),
      { allowedSources: WRITE_SOURCES }
    ),
    bus.registerHandler(
      'policy:removeUserMarkedRegion',
      async ({ origin, regionId }) => {
        await store.removeUserMarkedRegion(origin, regionId);
        return { ok: true as const };
      },
      { allowedSources: WRITE_SOURCES }
    ),
  ];

  return () => {
    for (const unregister of unregisters) unregister();
  };
}

export async function guardEgress(
  store: PolicyStore,
  origin: string
): Promise<{ readonly allowed: boolean }> {
  const policy = await store.getPolicy(origin);
  return { allowed: !isNeverSendOrigin(policy) };
}
