/**
 * ML worker entry point (feature C-02).
 *
 * Runs ONNX inference off the main thread, in a dedicated worker. Deliberately
 * thin: A-03 owns the typed cross-context message bus, and A-04 owns starting,
 * keeping alive and shutting down the host. This file exists so C-02's runtime
 * can be exercised in a *real* worker rather than only in unit tests, and so
 * there is an obvious seam for A-03 to replace.
 *
 * The protocol here is intentionally minimal and local to C-02. Do not build
 * on it — when A-03 lands, this handler becomes an adapter onto the real bus.
 *
 * Nothing in this worker performs network I/O. Model bytes arrive in the
 * message that asks for them to be loaded; A-13 owns fetching and verifying
 * those bytes.
 */

import { OnnxRuntime, type RuntimeTensorType } from './runtime.js';
import type { BackendName, ModelDescriptor, RuntimeDiagnostics } from './types.js';

/** Requests this worker understands. */
export type RuntimeWorkerRequest =
  | {
      readonly id: number;
      readonly kind: 'initialize';
      readonly probeModel: ArrayBuffer;
      /** Forces a lower rung, for degraded-device coverage. */
      readonly backendOrder?: readonly BackendName[];
    }
  | {
      readonly id: number;
      readonly kind: 'run';
      readonly model: { id: string; version: string; bytes: ArrayBuffer };
      readonly feeds: Record<
        string,
        { type: RuntimeTensorType; data: Float32Array | BigInt64Array; dims: readonly number[] }
      >;
    }
  | { readonly id: number; readonly kind: 'diagnostics' }
  | { readonly id: number; readonly kind: 'dispose' };

/** Responses this worker sends. */
export type RuntimeWorkerResponse =
  | { readonly id: number; readonly ok: true; readonly diagnostics: RuntimeDiagnostics }
  | {
      readonly id: number;
      readonly ok: true;
      readonly outputs: Record<
        string,
        { type: RuntimeTensorType; data: Float32Array | BigInt64Array; dims: readonly number[] }
      >;
    }
  | { readonly id: number; readonly ok: false; readonly error: string };

/**
 * Rebuilt on each `initialize` so the ladder can be overridden per run. A-04
 * owns the worker's lifetime; this only controls the runtime inside it.
 */
let runtime = new OnnxRuntime();

/**
 * Handles one request.
 *
 * Exported so unit tests can drive it without a real `Worker`, and so A-03 can
 * call it directly once it owns transport.
 */
export async function handleRequest(request: RuntimeWorkerRequest): Promise<RuntimeWorkerResponse> {
  try {
    switch (request.kind) {
      case 'initialize': {
        await runtime.dispose();
        runtime = new OnnxRuntime(
          request.backendOrder ? { backendOrder: request.backendOrder } : {}
        );
        const diagnostics = await runtime.initialize(new Uint8Array(request.probeModel));
        return { id: request.id, ok: true, diagnostics };
      }
      case 'run': {
        const model: ModelDescriptor = {
          id: request.model.id,
          version: request.model.version,
          bytes: new Uint8Array(request.model.bytes),
        };
        const outputs = await runtime.run(model, request.feeds);
        return { id: request.id, ok: true, outputs };
      }
      case 'diagnostics':
        return { id: request.id, ok: true, diagnostics: runtime.diagnostics() };
      case 'dispose':
        await runtime.dispose();
        return { id: request.id, ok: true, diagnostics: runtime.diagnostics() };
    }
  } catch (cause) {
    // Only the error's name, never its message: ONNX Runtime error strings can
    // embed graph node names and tensor shapes, and this crosses a boundary.
    return {
      id: request.id,
      ok: false,
      error: cause instanceof Error ? cause.name : 'UnknownError',
    };
  }
}

/**
 * The worker globals this file uses.
 *
 * Declared structurally rather than via the `WebWorker` lib, because this
 * package compiles with the `DOM` lib for the content script and side panel,
 * and the two libraries define conflicting globals.
 */
interface WorkerScope {
  postMessage(message: RuntimeWorkerResponse): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<RuntimeWorkerRequest>) => void
  ): void;
}

// Guarded so the module can be imported by tests in a non-worker context.
const scope = globalThis as unknown as Partial<WorkerScope>;
if (typeof scope.postMessage === 'function' && typeof scope.addEventListener === 'function') {
  const worker = scope as WorkerScope;
  worker.addEventListener('message', (event) => {
    void handleRequest(event.data).then((response) => {
      worker.postMessage(response);
    });
  });
}
