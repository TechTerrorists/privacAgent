/**
 * Detector coverage (feature C-01).
 *
 * The Egress Guard is fail-closed: every text field must carry a record of
 * which detectors actually scanned it, and a field without that record is
 * rejected rather than sent (PRD §10.2). This module is the single place that
 * decides whether an inference result establishes such a record, so that the
 * rule cannot drift between callers.
 *
 * Two outcomes do **not** count:
 *
 * - `unavailable` — the input was never examined. D-10 turns this into
 *   restricted egress mode rather than letting the content through.
 * - anything `synthetic` — the fake engine fabricates plausible results
 *   without looking at pixels. Letting those satisfy coverage would mean a
 *   development build could assemble a payload that looks fully scanned.
 */

import type { InferenceResult, InferenceUnavailableReason } from './types.js';

/**
 * Whether a result proves a real detector examined the input.
 *
 * True only for a genuine `ok` or `empty` result. Note that `empty` counts:
 * a model that ran and found nothing has covered the region.
 */
export function countsAsDetectorCoverage(result: InferenceResult<unknown>): boolean {
  if (result.synthetic) return false;
  return result.status === 'ok' || result.status === 'empty';
}

/**
 * Whether restricted egress mode should be entered for this result (D-10).
 *
 * Note this is not the negation of coverage: a synthetic result does not
 * establish coverage, but it also is not a detector failure. Callers that need
 * "is it safe to send" should use {@link countsAsDetectorCoverage}.
 */
export function requiresRestrictedEgress(result: InferenceResult<unknown>): boolean {
  return result.status === 'unavailable';
}

/**
 * The reason inference was unavailable, or `undefined` if it ran.
 *
 * Useful for the side panel's restricted-mode banner, which tells the user why
 * the agent is operating with reduced information (F-07).
 */
export function unavailableReason(
  result: InferenceResult<unknown>
): InferenceUnavailableReason | undefined {
  return result.status === 'unavailable' ? result.reason : undefined;
}
