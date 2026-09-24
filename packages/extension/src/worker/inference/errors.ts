/**
 * Inference errors (feature C-01).
 *
 * The four operations report unavailability through a returned result rather
 * than by throwing, so a caller cannot lose the distinction between "found
 * nothing" and "could not look" in a `catch`. These errors exist for the two
 * cases a result cannot express: a caller that would rather throw than branch,
 * and an input that is malformed before any model is reached.
 *
 * Messages carry shapes and sizes only — never pixels, decoded text or any
 * other payload — because error strings reach logs and telemetry.
 */

import type { InferenceOperation } from './api.js';
import type { InferenceUnavailableReason } from './types.js';

/** Thrown by callers that opt into throwing on an `unavailable` result. */
export class InferenceUnavailableError extends Error {
  constructor(
    public readonly operation: InferenceOperation,
    public readonly reason: InferenceUnavailableReason,
    message?: string
  ) {
    super(message ?? `Inference operation "${operation}" is unavailable: ${reason}.`);
    this.name = 'InferenceUnavailableError';
  }
}

/** Thrown when an image or region is malformed, before any model runs. */
export class InvalidInferenceInputError extends Error {
  constructor(public readonly detail: string) {
    super(`Invalid inference input: ${detail}`);
    this.name = 'InvalidInferenceInputError';
  }
}
