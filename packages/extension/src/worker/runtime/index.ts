/**
 * ONNX runtime entry point (feature C-02).
 *
 * Consumers import from here. The runtime is created but never registered as
 * C-01's active engine — see `onnx-engine.ts` for why.
 */

export * from './types.js';
export * from './errors.js';
export * from './capabilities.js';
export {
  executionProviderFor,
  prerequisitesMet,
  selectBackend,
  threadsFor,
  type BackendProbe,
  type BackendSelection,
} from './backend.js';
export {
  SessionCache,
  sessionKey,
  type ReleasableSession,
  type SessionCacheOptions,
  type SessionFactory,
} from './session-cache.js';
export { TensorScope, withTensorScope, type Disposable } from './tensors.js';
export {
  OnnxRuntime,
  type OnnxRuntimeOptions,
  type RuntimeInput,
  type RuntimeOutput,
} from './runtime.js';
export { createOnnxInferenceApi } from './onnx-engine.js';
