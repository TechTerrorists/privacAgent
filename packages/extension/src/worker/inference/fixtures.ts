/**
 * Documented fixtures (feature C-01).
 *
 * The fake engine derives a result from whatever input it is handed, which
 * always produces `ok`. The other two outcomes have to be reachable on purpose
 * rather than by finding an input that happens to hash into them — otherwise
 * the `empty` / `unavailable` distinction, which is the privacy-critical part
 * of this feature, could not be tested at all.
 *
 * Fixture outputs are a **stable contract**, not an implementation detail.
 * Other lanes assert against them, so changing the derivation is a breaking
 * change for every one of those suites.
 */

import type { InferenceImage, InferenceUnavailableReason } from './types.js';

export const FIXTURE_NAMES = ['ordinary', 'empty', 'unavailable'] as const;

/**
 * - `ordinary`: derive a non-empty result from the input (the default).
 * - `empty`: the model ran and found nothing. Counts as coverage.
 * - `unavailable`: the model could not run. Does not count as coverage.
 */
export type FixtureName = (typeof FIXTURE_NAMES)[number];

/** The reason the `unavailable` fixture reports. */
export const FIXTURE_UNAVAILABLE_REASON: InferenceUnavailableReason = 'model_not_loaded';

/** Viewport-sized input, matching the detector's 640 px long side (PRD §5.1). */
export const FIXTURE_VIEWPORT: InferenceImage = {
  width: 640,
  height: 640,
  frame: 'image',
};

/** A Tier 2 crop at the §3.2 ceiling of 512 px on the long side. */
export const FIXTURE_CROP: InferenceImage = {
  width: 512,
  height: 512,
  frame: 'crop',
};

/** A 128×128 tile, the face detector's input size. */
export const FIXTURE_FACE_TILE: InferenceImage = {
  width: 128,
  height: 128,
  frame: 'image',
};

/** A 64×64 icon crop, the icon classifier's input size. */
export const FIXTURE_ICON: InferenceImage = {
  width: 64,
  height: 64,
  frame: 'crop',
};
