/**
 * Vault errors (feature D-04).
 *
 * Mirrors `worker/pii/errors.ts`: expected outcomes (scope missing, capacity
 * exhausted, a use-binding that doesn't match the scope's task) are reported
 * as typed results, never by throwing. This error exists only for a caller
 * contract violation — a malformed scope initializer — which indicates a bug
 * in the caller, not data the vault examined and rejected.
 *
 * The message carries structural detail only, never a stored value, because
 * error strings reach logs and telemetry.
 */
export class InvalidVaultInputError extends Error {
  constructor(public readonly detail: string) {
    super(`Invalid vault input: ${detail}`);
    this.name = 'InvalidVaultInputError';
  }
}
