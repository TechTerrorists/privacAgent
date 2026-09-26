/**
 * PII engine errors (feature D-01).
 *
 * Redaction decisions are reported as data (see `types.ts`), never by
 * throwing — a caller must not be able to lose a `withheld` outcome in a
 * `catch`. This error exists for the one case a result cannot express: a
 * candidate element malformed before any scan is possible.
 *
 * Messages carry shapes only, never raw evidence text, because error strings
 * reach logs and telemetry.
 */

/** Thrown when a candidate element is malformed before scanning can begin. */
export class InvalidPiiInputError extends Error {
  constructor(public readonly detail: string) {
    super(`Invalid PII engine input: ${detail}`);
    this.name = 'InvalidPiiInputError';
  }
}
