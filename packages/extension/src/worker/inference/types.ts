/**
 * Local inference types (feature C-01).
 *
 * These describe what the on-device vision models take and return. They are
 * deliberately *local*: raw inference evidence never extends the outbound E-01
 * schema, because nothing here is safe to transmit before the privacy pipeline
 * has run over it. The one thing borrowed from E-01 is the `BBox` tuple, so a
 * box that later becomes part of a Screen State needs no reshaping.
 */

import type { BBox } from '@privacagent/protocol';

export type { BBox };

/**
 * Coordinate frame a box is expressed in (PRD §4.2).
 *
 * - `image`: origin at the top-left of the screenshot, device px (CSS px × DPR).
 * - `crop`: origin at the top-left of a crop taken from that screenshot.
 *
 * Inference never emits page or viewport coordinates. Converting to the page
 * frame belongs to A-08 and is applied by C-06; doing it here would silently
 * bake in a scroll offset that was correct only at capture time.
 */
export type InferenceFrame = 'image' | 'crop';

/** Model confidence, 0..1 inclusive. */
export type Confidence = number;

/** Which engine produced a result. C-02 adds `onnx`. */
export type InferenceEngineName = 'fake' | 'onnx';

/**
 * An image or crop handed to a model.
 *
 * `bitmap` is optional so the whole surface stays callable under Node, where
 * `ImageBitmap` does not exist. The fake engine never reads it, and no engine
 * may retain it beyond the call.
 */
export interface InferenceImage {
  /** Width in device px. Must be a positive integer. */
  readonly width: number;
  /** Height in device px. Must be a positive integer. */
  readonly height: number;
  readonly frame: InferenceFrame;
  readonly bitmap?: ImageBitmap;
}

/** A sub-region of an image, in that image's own frame. `[x, y, w, h]`. */
export type InferenceRegion = BBox;

/**
 * UI element classes the detector can emit.
 *
 * The first group is structural (C-05). The second is the privacy group added
 * by C-14, which the §6.8 crop allowlist keys on when deciding whether a
 * region may be transmitted at all.
 */
export type UiElementClass =
  | 'button'
  | 'input'
  | 'checkbox'
  | 'radio'
  | 'dropdown'
  | 'link'
  | 'icon'
  | 'image'
  | 'text_block'
  | 'toggle'
  | 'tab'
  | 'avatar'
  | 'photo'
  | 'video'
  | 'document_image'
  | 'handwriting'
  | 'map'
  | 'chart';

/** One detection from the UI element detector. */
export interface UiDetection {
  readonly cls: UiElementClass;
  readonly bbox: BBox;
  readonly conf: Confidence;
}

/** One face box. The model locates faces; it never identifies them. */
export interface FaceDetection {
  readonly bbox: BBox;
  readonly conf: Confidence;
}

/** One classified icon. */
export interface IconClassification {
  readonly bbox: BBox;
  /** Icon meaning, e.g. `search`. C-09 ships roughly 150 labels. */
  readonly label: string;
  readonly conf: Confidence;
}

/**
 * Per-character OCR confidence.
 *
 * Kept per character rather than per word because §6.8 masks a region whose
 * mean character confidence falls below 0.7, and D-12 needs character-level
 * geometry to align a detected span back to the exact pixels it came from.
 */
export interface OcrCharacter {
  readonly char: string;
  readonly conf: Confidence;
}

/** One OCR word, with the characters that compose it. */
export interface OcrWord {
  readonly text: string;
  readonly bbox: BBox;
  readonly conf: Confidence;
  readonly characters: readonly OcrCharacter[];
}

/**
 * One OCR line.
 *
 * This is **privacy evidence**, not interaction-map data (PRD §6.1). OCR text
 * must be scanned for PII independently and must never be folded into an
 * element's accessible name: a button whose DOM label reads "Profile" may
 * render a person's name in pixels, and merging the two loses exactly the
 * evidence the redaction pass needs.
 */
export interface OcrLine {
  readonly text: string;
  readonly bbox: BBox;
  /** Mean of this line's character confidences. Below 0.7, §6.8 masks the region. */
  readonly meanCharConfidence: Confidence;
  readonly words: readonly OcrWord[];
}

/**
 * Why inference could not run.
 *
 * This is never a detection outcome. It means the input was not examined, so
 * the caller has no coverage for it.
 */
export type InferenceUnavailableReason =
  'model_not_loaded' | 'backend_unavailable' | 'out_of_memory' | 'timeout' | 'internal_error';

/** Provenance carried by every result, whatever the status. */
export interface InferenceResultMeta {
  /** The frame the returned boxes are in: the frame of the input image. */
  readonly frame: InferenceFrame;
  readonly engine: InferenceEngineName;
  /**
   * True when the result was fabricated rather than inferred from pixels.
   * Synthetic results never satisfy detector coverage — see `coverage.ts`.
   */
  readonly synthetic: boolean;
}

/** The model ran and found at least one item. `items` is never empty. */
export interface InferenceOk<T> extends InferenceResultMeta {
  readonly status: 'ok';
  readonly items: readonly T[];
}

/**
 * The model ran to completion over the input and found nothing.
 *
 * This is a *successful* outcome and counts as coverage: the region was
 * examined, and there was nothing there.
 */
export interface InferenceEmpty extends InferenceResultMeta {
  readonly status: 'empty';
}

/**
 * The model could not run. The input was **not** examined.
 *
 * Distinct from `empty` on purpose. D-10 enters restricted egress mode when a
 * detector is unavailable, and the Egress Guard's coverage check (PRD §10.2)
 * rejects any field lacking a record that a detector scanned it. Collapsing
 * this into an empty detection would make both silently pass.
 */
export interface InferenceUnavailable extends InferenceResultMeta {
  readonly status: 'unavailable';
  readonly reason: InferenceUnavailableReason;
}

/** The three-way outcome every operation returns. */
export type InferenceResult<T> = InferenceOk<T> | InferenceEmpty | InferenceUnavailable;
