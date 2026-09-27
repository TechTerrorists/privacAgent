/**
 * Offscreen ML host (feature C-02).
 *
 * Creates the dedicated worker that runs ONNX inference and exposes a small
 * request/response bridge over it. Deliberately minimal:
 *
 * - **A-03** owns the typed cross-context message bus. This bridge is local to
 *   C-02 and becomes an adapter onto that bus when it lands.
 * - **A-04** owns when this document is created, kept alive and torn down.
 *   Nothing here implements an idle policy.
 *
 * The worker is created as a module worker from the extension's own origin, so
 * it inherits this page's cross-origin isolation — which is what makes
 * threaded WASM possible on Chrome.
 */

import type { RuntimeWorkerRequest, RuntimeWorkerResponse } from '../worker/runtime/worker.js';

/** Path of the built worker bundle, relative to the extension root. */
const WORKER_PATH = '/worker/runtime.js';

let worker: Worker | undefined;
let nextRequestId = 0;
const pending = new Map<number, (response: RuntimeWorkerResponse) => void>();

function ensureWorker(): Worker {
  if (worker) return worker;

  worker = new Worker(WORKER_PATH, { type: 'module', name: 'privacagent-ml' });
  worker.addEventListener('message', (event: MessageEvent<RuntimeWorkerResponse>) => {
    const resolve = pending.get(event.data.id);
    if (!resolve) return;
    pending.delete(event.data.id);
    resolve(event.data);
  });
  return worker;
}

/** Sends one request to the worker and resolves with its response. */
export function callWorker(
  request: Omit<RuntimeWorkerRequest, 'id'>
): Promise<RuntimeWorkerResponse> {
  const id = (nextRequestId += 1);
  const target = ensureWorker();

  return new Promise<RuntimeWorkerResponse>((resolve) => {
    pending.set(id, resolve);
    target.postMessage({ ...request, id } as RuntimeWorkerRequest);
  });
}

/** Terminates the worker. A-04 calls the real teardown; this is the mechanism. */
export function terminateWorker(): void {
  worker?.terminate();
  worker = undefined;
  pending.clear();
}

/**
 * Test surface.
 *
 * The C-02 browser tests drive the runtime through this page because it is the
 * only context that is both cross-origin isolated and able to own a worker.
 * Exposed on `globalThis` rather than through messaging so the tests do not
 * depend on A-03's bus, which does not exist yet.
 */
declare global {
  interface Window {
    privacagentRuntimeHost?: {
      call: typeof callWorker;
      terminate: typeof terminateWorker;
      crossOriginIsolated: boolean;
    };
  }
}

window.privacagentRuntimeHost = {
  call: callWorker,
  terminate: terminateWorker,
  crossOriginIsolated: globalThis.crossOriginIsolated === true,
};
