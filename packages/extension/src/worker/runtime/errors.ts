/**
 * Runtime errors (feature C-02).
 *
 * Messages carry fixed reason codes, model identity and sizes — never model
 * bytes, tensor values or the text of an underlying exception. ONNX Runtime
 * error strings can embed node names and shapes from the graph, and these
 * strings reach logs, so the cause is recorded as a code rather than quoted.
 */

import type { BackendName } from './types.js';

/** No backend on the ladder initialized. Nothing can execute. */
export class RuntimeUnavailableError extends Error {
  constructor(public readonly attempted: readonly BackendName[]) {
    super(`No ONNX backend initialized. Attempted: ${attempted.join(' -> ')}.`);
    this.name = 'RuntimeUnavailableError';
  }
}

/** A model could not be turned into a session. */
export class ModelLoadError extends Error {
  constructor(
    public readonly modelId: string,
    public readonly version: string,
    public readonly reason: string
  ) {
    super(`Failed to load model "${modelId}@${version}": ${reason}.`);
    this.name = 'ModelLoadError';
  }
}

/** A session existed but the run failed. */
export class InferenceExecutionError extends Error {
  constructor(
    public readonly modelId: string,
    public readonly reason: string
  ) {
    super(`Inference failed for model "${modelId}": ${reason}.`);
    this.name = 'InferenceExecutionError';
  }
}

/** Raised when the runtime is used after `dispose()`. */
export class RuntimeDisposedError extends Error {
  constructor() {
    super('The ONNX runtime has been disposed.');
    this.name = 'RuntimeDisposedError';
  }
}

/**
 * Reduces an unknown thrown value to a short, fixed code.
 *
 * Nothing from the original message survives. Callers that need to distinguish
 * causes should do so on the code, not by parsing text.
 */
export function toReasonCode(cause: unknown): string {
  if (cause instanceof Error) {
    // Only the constructor name, which is bounded and carries no payload.
    return cause.name || 'error';
  }
  return 'unknown';
}
