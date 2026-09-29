/**
 * ONNX runtime types (feature C-02).
 *
 * C-01 owns the *inference contract* — what an operation returns and whether it
 * establishes detector coverage. This module owns the layer beneath: which
 * backend actually executes a graph, how sessions are cached, and what we are
 * willing to say about either. Nothing here describes page content, and
 * nothing here is transmitted.
 */

/**
 * Execution backends, in the order they are attempted (PRD §5.2).
 *
 * `wasm-threaded` is not a separate ONNX Runtime execution provider — it is the
 * `wasm` provider with `numThreads > 1`. It is named separately because the
 * prerequisite is completely different (cross-origin isolation, not a GPU
 * adapter) and because the distinction is the single biggest performance
 * difference on machines without WebGPU.
 */
export type BackendName = 'webgpu' | 'wasm-threaded' | 'wasm';

/** The ladder, highest capability first. */
export const BACKEND_ORDER: readonly BackendName[] = ['webgpu', 'wasm-threaded', 'wasm'];

/** Why a backend was not used. */
export type BackendRejection =
  /** A prerequisite is missing: no GPU adapter, not cross-origin isolated. */
  | 'unsupported'
  /**
   * Prerequisites looked satisfied but initialization threw.
   *
   * Tracked separately from `unsupported` because feature detection lying is
   * the common real-world case — `navigator.gpu` exists but `requestAdapter()`
   * resolves null, or an adapter exists but session creation fails on a driver
   * bug. Detection alone must never count as a working backend.
   */
  | 'init_failed';

/** One rung of the ladder, and what happened on it. */
export interface BackendAttempt {
  readonly backend: BackendName;
  readonly outcome: 'selected' | BackendRejection;
  /**
   * A short, fixed reason code. Never an exception message, model name or any
   * other free text that could carry payload into logs.
   */
  readonly reason?: string;
}

/** Whether the runtime can execute anything at all. */
export type RuntimeStatus =
  /** `initialize()` has not been called or has not finished. */
  | 'uninitialized'
  /** A backend initialized and executed successfully. */
  | 'ready'
  /** Every rung of the ladder failed. Nothing can run. */
  | 'unavailable';

/**
 * What the host environment claims to support.
 *
 * Detection only. A `true` here is a reason to *try* a backend, never evidence
 * that it works — see {@link BackendRejection}.
 */
export interface RuntimeCapabilities {
  /** `navigator.gpu` exists and returned an adapter. */
  readonly webgpu: boolean;
  /** `crossOriginIsolated === true`. Without it, threads are impossible. */
  readonly crossOriginIsolated: boolean;
  /** `SharedArrayBuffer` is constructible. Implied by isolation, checked anyway. */
  readonly sharedArrayBuffer: boolean;
  /** Hardware concurrency the platform reports, clamped to something sane. */
  readonly hardwareConcurrency: number;
}

/**
 * Identity of a model, for cache keying.
 *
 * `version` is part of the key so a re-exported model with the same id can
 * never be served from a stale session. A-13 owns downloading and verifying
 * the bytes; this module only receives them.
 */
export interface ModelDescriptor {
  readonly id: string;
  readonly version: string;
  /** The model itself. Supplied by the caller; never fetched by this module. */
  readonly bytes: Uint8Array;
}

/**
 * Bounded diagnostics, safe to log or surface in the UI.
 *
 * Deliberately counts and status codes only: no model bytes, no tensor values,
 * no image buffers, no exception text. A-14 telemetry can consume this as-is.
 */
export interface RuntimeDiagnostics {
  readonly status: RuntimeStatus;
  /** The backend actually in use, or `undefined` when nothing initialized. */
  readonly backend?: BackendName;
  /** Every rung tried, in order, with its outcome. */
  readonly attempts: readonly BackendAttempt[];
  readonly capabilities: RuntimeCapabilities;
  /** Number of live cached sessions. */
  readonly sessionCount: number;
  /** Threads requested of the WASM backend. 1 means single-threaded. */
  readonly threads: number;
}
