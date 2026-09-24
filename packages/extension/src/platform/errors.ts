/**
 * Platform adapter specific errors (feature A-02).
 */

/**
 * Thrown or returned as an asynchronous rejection when an operation is invoked
 * on a browser platform that does not support that capability.
 *
 * Example: attempting to create or close an offscreen document on Firefox.
 */
export class UnsupportedPlatformCapabilityError extends Error {
  constructor(
    public readonly capability: string,
    public readonly browser: string,
    message?: string
  ) {
    super(
      message ?? `Platform capability "${capability}" is not supported on browser "${browser}".`
    );
    this.name = 'UnsupportedPlatformCapabilityError';
  }
}
