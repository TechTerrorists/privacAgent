/**
 * Tensor ownership and disposal (feature C-02).
 *
 * ## The ownership rule
 *
 * Three categories, and only one of them is ours to free:
 *
 * - **Caller-owned inputs.** Passed in by a consumer. Never disposed here; the
 *   caller may still be holding the backing `Float32Array`.
 * - **Runtime-owned temporaries.** Created inside an operation. Always disposed
 *   when the operation ends, on the success path *and* the failure path.
 * - **Returned outputs.** Created inside an operation but handed back. Disposed
 *   by whoever received them, once they are done.
 *
 * Getting this wrong is expensive on WebGPU, where a tensor holds a GPU buffer:
 * leak them and memory climbs until the device is lost; free them too eagerly
 * and the caller reads freed memory. PRD §11.2 budgets 300 MB of GPU memory
 * for the whole client, so a per-step leak is not survivable.
 *
 * {@link withTensorScope} makes the common case correct by default: anything
 * registered is freed on the way out unless it was explicitly handed over.
 */

/** The part of an ONNX Runtime tensor this module needs. */
export interface Disposable {
  dispose(): void;
}

/**
 * Tracks tensors created during one operation.
 *
 * Disposal is best-effort per tensor: one failing `dispose()` must not prevent
 * the rest from being freed, since that would turn a single bad tensor into a
 * full leak.
 */
export class TensorScope {
  private readonly owned = new Set<Disposable>();
  private disposed = false;

  /** Registers a tensor as runtime-owned. Returns it for chaining. */
  own<T extends Disposable>(tensor: T): T {
    if (!this.disposed) this.owned.add(tensor);
    return tensor;
  }

  /**
   * Hands ownership back to the caller.
   *
   * Use for anything being returned: the scope stops tracking it, so closing
   * the scope leaves it intact.
   */
  release<T extends Disposable>(tensor: T): T {
    this.owned.delete(tensor);
    return tensor;
  }

  /** How many tensors this scope would free right now. */
  get size(): number {
    return this.owned.size;
  }

  /** Frees everything still owned. Idempotent. */
  disposeAll(): void {
    for (const tensor of this.owned) {
      try {
        tensor.dispose();
      } catch {
        // A tensor that cannot be disposed is already in an unusable state.
        // Swallow it so the remaining tensors are still freed.
      }
    }
    this.owned.clear();
    this.disposed = true;
  }
}

/**
 * Runs `operation` with a scope that is always cleaned up.
 *
 * The `finally` is the point of this helper: an inference failure is exactly
 * when temporaries are most likely to be left behind, and exactly when a naive
 * implementation forgets to free them.
 *
 * @example
 * const output = await withTensorScope(async (scope) => {
 *   const input = scope.own(new Tensor('float32', data, dims));
 *   const result = await session.run({ input });
 *   return scope.release(result.output); // survives the scope
 * });
 */
export async function withTensorScope<T>(
  operation: (scope: TensorScope) => Promise<T>
): Promise<T> {
  const scope = new TensorScope();
  try {
    return await operation(scope);
  } finally {
    scope.disposeAll();
  }
}
