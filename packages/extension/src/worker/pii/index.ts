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
export { createLayeredPiiEngine } from './layered.js';
export * as l2 from './l2/index.js';

let activeApi: PiiEngineApi = createStubPiiEngine();

export function getPiiEngineApi(): PiiEngineApi {
  return activeApi;
}

export function setPiiEngineApi(api: PiiEngineApi): void {
  activeApi = api;
}

export function resetPiiEngineApi(): void {
  activeApi = createStubPiiEngine();
}
