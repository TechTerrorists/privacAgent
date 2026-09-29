/**
 * Worker vault entry point (feature D-04).
 *
 * Unlike `worker/inference` and `worker/pii`, this module has no
 * "swap the active implementation" registry: a vault is stateful
 * per-instance (it owns live scopes and timers), so the caller that hosts it
 * — the ML worker's top-level session wiring, or a test — constructs one
 * explicitly with {@link createVault} and holds onto it, rather than reaching
 * for a shared global.
 */

export * from './types.js';
export * from './errors.js';
export type { Clock, ManualClock, TimerHandle } from './clock.js';
export { createManualClock, createRealClock } from './clock.js';
export type {
  CreateScopeResult,
  InternInput,
  InternResult,
  InternUnavailableReason,
  VaultApi,
  VaultScopeInit,
} from './api.js';
export type { VaultOptions } from './vault.js';
export { createVault } from './vault.js';
export type { TestLifecycleHost } from './testHost.js';
export { createTestLifecycleHost } from './testHost.js';
