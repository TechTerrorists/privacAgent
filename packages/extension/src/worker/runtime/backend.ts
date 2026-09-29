/**
 * Backend selection (feature C-02).
 *
 * Walks WebGPU → threaded WASM → single-threaded WASM, and **proves** each rung
 * before accepting it. Proving means actually creating a session and running
 * it, because every cheaper check lies in practice:
 *
 * - `navigator.gpu` exists on machines whose `requestAdapter()` returns null.
 * - An adapter can exist on a driver where session creation fails.
 * - `crossOriginIsolated` can be true while a thread pool still fails to spawn.
 *
 * So the ladder is driven by a probe that compiles and executes the tiny test
 * model. Whatever the probe survives is the backend we report, and there is no
 * path by which a merely-detected backend is announced as working.
 *
 * ## Platform ceilings
 *
 * `wasm-threaded` requires `crossOriginIsolated`, which requires the COOP/COEP
 * manifest keys. Chrome grants those to extension pages; **Firefox cannot**
 * (bugzilla 1673477 — extension pages are not cross-origin isolated, pending
 * per-extension process isolation). Firefox therefore falls through to
 * single-threaded WASM by design, not by misconfiguration.
 */

import { availableThreads, canUseWasmThreads, hasWebGpuAdapter } from './capabilities.js';
import { toReasonCode } from './errors.js';
import { BACKEND_ORDER, type BackendAttempt, type BackendName } from './types.js';

/** Threads to request for a given backend. Only `wasm-threaded` asks for more than one. */
export function threadsFor(backend: BackendName): number {
  return backend === 'wasm-threaded' ? availableThreads() : 1;
}

/** ONNX Runtime's execution provider name for a backend. */
export function executionProviderFor(backend: BackendName): 'webgpu' | 'wasm' {
  return backend === 'webgpu' ? 'webgpu' : 'wasm';
}

/**
 * Whether a backend's prerequisites are present.
 *
 * A `true` here only authorises an attempt. It is never sufficient on its own.
 */
export async function prerequisitesMet(backend: BackendName): Promise<boolean> {
  switch (backend) {
    case 'webgpu':
      return hasWebGpuAdapter();
    case 'wasm-threaded':
      return canUseWasmThreads();
    case 'wasm':
      // The portable baseline. If this cannot run, nothing can.
      return true;
  }
}

/** Compiles and runs the test model on a backend. Rejects if it cannot. */
export type BackendProbe = (backend: BackendName) => Promise<void>;

export interface BackendSelection {
  /** The backend that actually initialized and executed, if any. */
  readonly backend?: BackendName;
  /** Every rung tried, in order. */
  readonly attempts: readonly BackendAttempt[];
}

/**
 * Walks the ladder and returns the first backend that genuinely works.
 *
 * Bounded by construction: each rung is attempted exactly once, in a fixed
 * order, with no retries. A failing backend steps down rather than looping,
 * so a broken driver cannot produce an unbounded retry storm.
 *
 * @param probe Compiles and runs the test model. Must reject on any failure.
 * @param order Overridable for tests; defaults to the PRD ladder.
 */
export async function selectBackend(
  probe: BackendProbe,
  order: readonly BackendName[] = BACKEND_ORDER
): Promise<BackendSelection> {
  const attempts: BackendAttempt[] = [];

  for (const backend of order) {
    if (!(await prerequisitesMet(backend))) {
      attempts.push({ backend, outcome: 'unsupported', reason: prerequisiteReason(backend) });
      continue;
    }

    try {
      await probe(backend);
      attempts.push({ backend, outcome: 'selected' });
      return { backend, attempts };
    } catch (cause) {
      // Detection passed but the backend does not work. Step down.
      attempts.push({ backend, outcome: 'init_failed', reason: toReasonCode(cause) });
    }
  }

  return { attempts };
}

/** A fixed code explaining an unmet prerequisite. Never free text. */
function prerequisiteReason(backend: BackendName): string {
  switch (backend) {
    case 'webgpu':
      return 'no_adapter';
    case 'wasm-threaded':
      return 'not_cross_origin_isolated';
    case 'wasm':
      return 'unavailable';
  }
}
