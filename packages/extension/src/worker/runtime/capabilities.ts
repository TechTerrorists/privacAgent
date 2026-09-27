/**
 * Environment capability detection (feature C-02).
 *
 * Every function here answers "is it worth *trying* this?" and nothing more.
 * The backend ladder treats a positive answer as permission to attempt
 * initialization, never as evidence that the backend works — `navigator.gpu`
 * routinely exists on machines where `requestAdapter()` resolves to null, and
 * an adapter can exist on a driver that fails at session creation.
 *
 * Detection must never throw: it runs in a worker during startup, and an
 * exception here would take down the whole runtime rather than degrading to a
 * lower rung.
 */

import type { RuntimeCapabilities } from './types.js';

/** Upper bound on worker threads. Beyond this, contention costs more than it buys. */
const MAX_THREADS = 4;

/** Whether this context is cross-origin isolated. */
export function isCrossOriginIsolated(): boolean {
  return typeof globalThis.crossOriginIsolated === 'boolean'
    ? globalThis.crossOriginIsolated
    : false;
}

/**
 * Whether `SharedArrayBuffer` can actually be constructed.
 *
 * Cross-origin isolation implies it, but the constructor can still be absent
 * behind flags or enterprise policy, so it is checked rather than inferred.
 */
export function hasSharedArrayBuffer(): boolean {
  try {
    return typeof SharedArrayBuffer === 'function' && new SharedArrayBuffer(1).byteLength === 1;
  } catch {
    return false;
  }
}

/** Reported cores, clamped. Defaults low rather than high when unknown. */
export function availableThreads(): number {
  const reported =
    typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 1;
  if (!Number.isFinite(reported) || reported < 1) return 1;
  // Half the cores, as ONNX Runtime itself defaults to, so a perception step
  // never saturates a machine the user is also browsing on.
  return Math.max(1, Math.min(MAX_THREADS, Math.floor(reported / 2)));
}

/**
 * Whether threaded WASM is worth attempting.
 *
 * Both conditions are required by the platform, not by us: WASM threads are
 * pthreads over one shared linear memory, that memory is a `SharedArrayBuffer`,
 * and `SharedArrayBuffer` requires cross-origin isolation.
 */
export function canUseWasmThreads(): boolean {
  return isCrossOriginIsolated() && hasSharedArrayBuffer() && availableThreads() > 1;
}

/**
 * Whether a WebGPU adapter exists.
 *
 * Asynchronous because presence of `navigator.gpu` says nothing — the adapter
 * request is the first point at which the answer is real. Resolves false on
 * any failure rather than rejecting, so the ladder can simply step down.
 */
export async function hasWebGpuAdapter(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return false;
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

/** Snapshot of what this environment claims to support. */
export async function detectCapabilities(): Promise<RuntimeCapabilities> {
  return {
    webgpu: await hasWebGpuAdapter(),
    crossOriginIsolated: isCrossOriginIsolated(),
    sharedArrayBuffer: hasSharedArrayBuffer(),
    hardwareConcurrency: availableThreads(),
  };
}
