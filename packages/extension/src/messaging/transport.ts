/**
 * Transports for cross-context messaging (feature A-03).
 *
 * Re-exports:
 * 1. Transport interface (transport-types.ts)
 * 2. WorkerTransport (worker-transport.ts): completely decoupled from extension/platform APIs.
 * 3. ExtensionTransport (extension-transport.ts): uses the A-02 platform adapter.
 */

export * from './transport-types.js';
export * from './worker-transport.js';
export * from './extension-transport.js';
