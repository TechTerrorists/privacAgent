/**
 * Worker inference entry point (feature C-01).
 *
 * Consumers import from here and depend only on the `InferenceApi` interface.
 * The active engine is the deterministic fake until C-02 registers a real one
 * through {@link setInferenceApi}; no caller changes when that happens.
 */

import type { InferenceApi } from './api.js';
import { createFakeInferenceApi } from './fake.js';

export * from './types.js';
export * from './errors.js';
export * from './coverage.js';
export * from './fixtures.js';
export type { InferenceApi, InferenceOperation, InferenceOptions } from './api.js';
export { createFakeInferenceApi } from './fake.js';

let activeApi: InferenceApi = createFakeInferenceApi();

/** The engine every consumer should use. */
export function getInferenceApi(): InferenceApi {
  return activeApi;
}

/**
 * Replaces the active engine.
 *
 * C-02 calls this once, after backend selection succeeds, to install the ONNX
 * engine. Tests use it to inject a stub and must call {@link resetInferenceApi}
 * afterwards, since the registry is module-level state.
 */
export function setInferenceApi(api: InferenceApi): void {
  activeApi = api;
}

/** Restores the deterministic fake. */
export function resetInferenceApi(): void {
  activeApi = createFakeInferenceApi();
}
