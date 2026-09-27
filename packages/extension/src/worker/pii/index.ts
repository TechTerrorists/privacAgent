/**
 * Worker PII engine entry point (feature D-01).
 *
 * Consumers import from here and depend only on the `PiiEngineApi` interface.
 * The active engine is the conservative stub until D-02 onward register a
 * real detector-backed engine through {@link setPiiEngineApi}; no caller
 * changes when that happens. Mirrors `worker/inference`'s registry.
 */

import type { PiiEngineApi } from './api.js';
import { createStubPiiEngine } from './stub.js';

export * from './types.js';
export * from './errors.js';
export { PII_CANARIES, PLACEHOLDER_PATTERN } from './canaries.js';
export type { PiiCanaryCase } from './canaries.js';
export type {
  PiiCropInput,
  PiiEngineApi,
  PiiEngineName,
  RawElementCandidate,
  RedactedTextContext,
  RedactElementOutcome,
} from './api.js';
export { createStubPiiEngine } from './stub.js';

let activeApi: PiiEngineApi = createStubPiiEngine();

/** The engine every consumer should use. */
export function getPiiEngineApi(): PiiEngineApi {
  return activeApi;
}

/**
 * Replaces the active engine.
 *
 * D-02 onward call this once, after a detector loads, to install a real
 * layered engine. Tests use it to inject a stub and must call
 * {@link resetPiiEngineApi} afterwards, since the registry is module-level
 * state.
 */
export function setPiiEngineApi(api: PiiEngineApi): void {
  activeApi = api;
}

/** Restores the conservative stub. */
export function resetPiiEngineApi(): void {
  activeApi = createStubPiiEngine();
}
