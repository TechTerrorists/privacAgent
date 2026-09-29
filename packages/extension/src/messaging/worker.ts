/**
 * Worker-safe messaging entry point (feature A-03).
 *
 * Dedicated entry point for Web Workers and MessagePort peers.
 * Free of browser extension runtime imports and webextension-polyfill.
 */

export * from './types.js';
export * from './errors.js';
export * from './validation.js';
export * from './transport-types.js';
export * from './worker-transport.js';
export * from './bus.js';
export * from './stubs.js';
