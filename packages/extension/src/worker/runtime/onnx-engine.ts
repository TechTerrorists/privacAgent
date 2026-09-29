/**
 * ONNX-backed inference engine (feature C-02).
 *
 * Implements C-01's `InferenceApi` over the real runtime. Every operation
 * currently returns `unavailable`, because C-02 delivers execution
 * infrastructure and **no models** — the detector, OCR, face and icon models
 * arrive in C-05 through C-09.
 *
 * That is the honest result, and a useful one. It reports `synthetic: false`
 * with a real reason, so:
 *
 * - `countsAsDetectorCoverage()` returns false, exactly as it must when nothing
 *   examined the pixels;
 * - `requiresRestrictedEgress()` returns true, which exercises D-10's
 *   restricted egress path end to end before any model exists.
 *
 * The alternative — reporting `empty` because the runtime started — is the
 * precise failure C-01's three-way result exists to prevent: "the runtime is
 * up" is not "the image was examined".
 *
 * This engine is **not** registered with `setInferenceApi`. The deterministic
 * fake stays active until a model-backed engine exists, so no other lane's
 * behaviour changes when this lands.
 */

import type { InferenceApi, InferenceOptions } from '../inference/api.js';
import type {
  FaceDetection,
  IconClassification,
  InferenceImage,
  InferenceResult,
  InferenceUnavailableReason,
  OcrLine,
  UiDetection,
} from '../inference/types.js';
import type { OnnxRuntime } from './runtime.js';

/**
 * Builds an `InferenceApi` backed by the ONNX runtime.
 *
 * @param runtime An initialized runtime. Its status decides which
 *   unavailability reason callers see.
 */
export function createOnnxInferenceApi(runtime: OnnxRuntime): InferenceApi {
  const unavailable = <T>(image: InferenceImage): InferenceResult<T> => ({
    frame: image.frame,
    engine: 'onnx',
    // Never synthetic: nothing was fabricated. Nothing was examined either,
    // which is what `status` says.
    synthetic: false,
    status: 'unavailable',
    reason: reasonFor(runtime),
  });

  return {
    engine: 'onnx',
    synthetic: false,

    runDetector(image: InferenceImage, _options?: InferenceOptions) {
      return Promise.resolve(unavailable<UiDetection>(image));
    },
    runOCR(image: InferenceImage, _options?: InferenceOptions) {
      return Promise.resolve(unavailable<OcrLine>(image));
    },
    runFaces(image: InferenceImage, _options?: InferenceOptions) {
      return Promise.resolve(unavailable<FaceDetection>(image));
    },
    runIcons(image: InferenceImage, _options?: InferenceOptions) {
      return Promise.resolve(unavailable<IconClassification>(image));
    },
  };
}

/**
 * Distinguishes "the runtime could not start" from "the runtime is fine but
 * has no model", so the side panel's restricted-mode banner (F-07) can tell
 * the user something true.
 */
function reasonFor(runtime: OnnxRuntime): InferenceUnavailableReason {
  return runtime.diagnostics().status === 'ready' ? 'model_not_loaded' : 'backend_unavailable';
}
