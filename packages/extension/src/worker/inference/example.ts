/**
 * Minimal consumer example (feature C-01).
 *
 * Shows the shape a real caller takes: run the operations it needs, then ask
 * whether the results establish detector coverage before treating any of it as
 * safe. This is the pattern C-10 (fusion) and the D-lane consumers follow.
 *
 * The important part is that coverage is asked about explicitly. A caller that
 * only looked at `items.length` would read an unavailable OCR model as "no
 * text here" and quietly transmit an unscanned region.
 */

import { countsAsDetectorCoverage, requiresRestrictedEgress } from './coverage.js';
import { getInferenceApi } from './index.js';
import type { InferenceImage, InferenceRegion } from './types.js';

/** What a consumer learns about one region. */
export interface RegionPerception {
  /** Number of UI elements found. Zero may mean "none present" or "not examined". */
  readonly detectionCount: number;
  /** Number of OCR lines found. */
  readonly textLineCount: number;
  /** Whether a face was seen anywhere in the region. */
  readonly hasFace: boolean;
  /**
   * True only if every privacy-relevant detector genuinely examined the region.
   * False for synthetic results, so a fake engine can never look like coverage.
   */
  readonly fullyScanned: boolean;
  /** True if any detector was unavailable, which forces restricted egress (D-10). */
  readonly restricted: boolean;
}

/**
 * Perceives one region with the active engine.
 *
 * @param image The screenshot or crop to examine.
 * @param region Optional sub-region, in the image's own frame.
 */
export async function perceiveRegion(
  image: InferenceImage,
  region?: InferenceRegion
): Promise<RegionPerception> {
  const api = getInferenceApi();
  const options = region ? { region } : undefined;

  const [detections, text, faces] = await Promise.all([
    api.runDetector(image, options),
    api.runOCR(image, options),
    api.runFaces(image, options),
  ]);

  return {
    detectionCount: detections.status === 'ok' ? detections.items.length : 0,
    textLineCount: text.status === 'ok' ? text.items.length : 0,
    hasFace: faces.status === 'ok',
    // OCR and face detection are the privacy-relevant ones here: they decide
    // whether text and faces in the pixels were looked for at all.
    fullyScanned: countsAsDetectorCoverage(text) && countsAsDetectorCoverage(faces),
    restricted: [detections, text, faces].some(requiresRestrictedEgress),
  };
}
