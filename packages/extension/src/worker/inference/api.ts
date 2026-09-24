/**
 * The worker inference interface (feature C-01).
 *
 * Four operations, one shape. Every call is asynchronous because the real
 * engine (C-02) runs models on WebGPU or WASM inside the ML worker; every call
 * returns a three-way result rather than throwing, so unavailability survives
 * as data instead of becoming an exception a caller might swallow.
 *
 * Callers depend on this interface, never on a concrete engine. C-02 swaps the
 * implementation through `setInferenceApi` without touching a single caller.
 */

import type { FixtureName } from './fixtures.js';
import type {
  FaceDetection,
  IconClassification,
  InferenceEngineName,
  InferenceImage,
  InferenceRegion,
  InferenceResult,
  OcrLine,
  UiDetection,
} from './types.js';

/** The four operations, by name. */
export type InferenceOperation = 'runDetector' | 'runOCR' | 'runFaces' | 'runIcons';

/** Every operation accepts these. */
export interface InferenceOptions {
  /**
   * Restrict inference to a sub-region, in the image's own frame. Returned
   * boxes stay in that same frame, so they remain comparable with the input.
   */
  readonly region?: InferenceRegion;
  /**
   * Select a documented fixture instead of deriving a result from the input.
   * Honoured only by the fake engine; real engines ignore it.
   */
  readonly fixture?: FixtureName;
}

/**
 * On-device inference.
 *
 * Implementations must not perform network I/O, persist raw images, or log
 * payloads. Inputs and outputs stay inside the worker.
 */
export interface InferenceApi {
  readonly engine: InferenceEngineName;
  /** True when this engine fabricates results rather than reading pixels. */
  readonly synthetic: boolean;

  /** Locate interactive UI elements. Sees the viewport at 640 px long side. */
  runDetector(
    image: InferenceImage,
    options?: InferenceOptions
  ): Promise<InferenceResult<UiDetection>>;

  /**
   * Read text. Returns privacy evidence, which must be scanned for PII on its
   * own and never merged into interaction-map element names (PRD §6.1).
   */
  runOCR(image: InferenceImage, options?: InferenceOptions): Promise<InferenceResult<OcrLine>>;

  /** Locate faces. Boxes only; the model never identifies anyone. */
  runFaces(
    image: InferenceImage,
    options?: InferenceOptions
  ): Promise<InferenceResult<FaceDetection>>;

  /** Classify icon crops that carry no accessible name. */
  runIcons(
    image: InferenceImage,
    options?: InferenceOptions
  ): Promise<InferenceResult<IconClassification>>;
}
