/**
 * Inference session cache (feature C-02).
 *
 * Creating a session is the expensive part of ONNX Runtime: the graph is
 * parsed, optimized (constant folding, node fusion) and compiled for the
 * chosen backend. Doing that per step would blow the PRD §11.1 budget on its
 * own, so sessions are created once and reused.
 *
 * Three behaviours matter more than the caching itself:
 *
 * - **Concurrent requests share one initialization.** The in-flight promise is
 *   cached, not just the result, so two callers asking for the same model at
 *   once compile it once. Without this, a page with several Tier 1 regions
 *   would compile the detector several times in parallel and blow the memory
 *   budget.
 * - **Failure does not poison the cache.** A rejected initialization is
 *   evicted, so a transient failure (device lost, momentary OOM) can be
 *   retried. Caching the rejection would disable a backend permanently.
 * - **Nothing here holds data.** Keys are model identity plus backend
 *   configuration. Screenshots, tensors and inference results are never stored.
 */

import type { BackendName, ModelDescriptor } from './types.js';

/**
 * A cached session, reduced to what this module uses.
 *
 * Structural rather than importing ONNX Runtime's class, so the cache is
 * testable without a runtime and without a GPU.
 */
export interface ReleasableSession {
  release(): Promise<void>;
}

/** Builds a session for a model. Supplied by the runtime, injected for tests. */
export type SessionFactory<S extends ReleasableSession> = (
  model: ModelDescriptor,
  backend: BackendName
) => Promise<S>;

/**
 * Cache key: model identity plus everything that changes the compiled result.
 *
 * `version` is included so a re-exported model never resolves to a session
 * compiled from the previous bytes, and `backend` because the same graph
 * compiled for WebGPU and for WASM are different objects entirely.
 */
export function sessionKey(model: ModelDescriptor, backend: BackendName): string {
  return `${model.id}@${model.version}#${backend}`;
}

/** Default ceiling. Small: the PRD portfolio is five models (§5.1). */
const DEFAULT_MAX_SESSIONS = 8;

export interface SessionCacheOptions {
  /** Maximum live sessions before the least recently used is evicted. */
  readonly maxSessions?: number;
}

/**
 * Keyed cache of inference sessions with in-flight de-duplication.
 *
 * Not an LRU by access time on purpose — eviction order is insertion order,
 * which for a fixed model portfolio is both sufficient and predictable.
 */
export class SessionCache<S extends ReleasableSession> {
  private readonly sessions = new Map<string, Promise<S>>();
  /**
   * Live borrowers per key.
   *
   * A session must not be released while a run is still executing on it —
   * doing so hands the run freed memory, and on WebGPU a destroyed buffer.
   * Eviction and disposal therefore defer releasing any key with a non-zero
   * count until its last borrower finishes.
   */
  private readonly leases = new Map<string, number>();
  /** Keys whose release is waiting on their last borrower. */
  private readonly deferred = new Map<string, Promise<S>>();
  /** Resolvers woken when a key's lease count reaches zero. */
  private readonly drained = new Map<string, Array<() => void>>();
  private readonly maxSessions: number;
  private disposed = false;

  constructor(
    private readonly factory: SessionFactory<S>,
    options: SessionCacheOptions = {}
  ) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  /** Live entries, including initializations still in flight. */
  get size(): number {
    return this.sessions.size;
  }

  /** Whether a key is present, without triggering creation. */
  has(model: ModelDescriptor, backend: BackendName): boolean {
    return this.sessions.has(sessionKey(model, backend));
  }

  /**
   * Returns the session for a model, creating it at most once.
   *
   * Concurrent callers with the same key receive the same promise. If that
   * promise rejects, the entry is removed so the next caller retries rather
   * than inheriting the failure.
   */
  async acquire(model: ModelDescriptor, backend: BackendName): Promise<S> {
    if (this.disposed) throw new Error('SessionCache has been disposed.');

    const key = sessionKey(model, backend);
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const pending = this.factory(model, backend);

    // Registered before awaiting, so a second caller arriving during
    // initialization joins this attempt instead of starting another.
    this.sessions.set(key, pending);

    try {
      const session = await pending;
      // If dispose() ran while this was initializing, it captured this very
      // promise and is already releasing the session. Releasing here too would
      // be a double free, so this path only reports the failure.
      if (this.disposed) {
        void session;
        throw new Error('SessionCache was disposed during initialization.');
      }
      this.evictIfNeeded(key);
      return session;
    } catch (cause) {
      // Evict only our own entry: a retry may already have replaced it.
      if (this.sessions.get(key) === pending) this.sessions.delete(key);
      throw cause;
    }
  }

  /**
   * Borrows a session for the duration of `use`.
   *
   * The session is guaranteed not to be released while `use` is running, even
   * if eviction or disposal happens concurrently. Callers that execute
   * inference must go through this rather than {@link acquire}, which only
   * warms the cache.
   */
  async use<T>(
    model: ModelDescriptor,
    backend: BackendName,
    consumer: (session: S) => Promise<T>
  ): Promise<T> {
    const key = sessionKey(model, backend);
    const session = await this.acquire(model, backend);

    this.leases.set(key, (this.leases.get(key) ?? 0) + 1);
    try {
      return await consumer(session);
    } finally {
      const remaining = (this.leases.get(key) ?? 1) - 1;
      if (remaining > 0) {
        this.leases.set(key, remaining);
      } else {
        this.leases.delete(key);
        // Anything that wanted this key gone now gets its turn.
        const pending = this.deferred.get(key);
        if (pending) {
          this.deferred.delete(key);
          void releaseQuietly(pending);
        }
        for (const wake of this.drained.get(key) ?? []) wake();
        this.drained.delete(key);
      }
    }
  }

  /** Releases one session and drops it. No-op if absent. */
  async evict(model: ModelDescriptor, backend: BackendName): Promise<void> {
    const key = sessionKey(model, backend);
    const pending = this.sessions.get(key);
    if (!pending) return;

    this.sessions.delete(key);
    await releaseQuietly(pending);
  }

  /**
   * Releases every session.
   *
   * A-04 calls this on host shutdown or idle unload. This module deliberately
   * implements no idle policy of its own — one owner for that decision.
   *
   * In-flight initializations are awaited and then released, so a session that
   * finishes compiling after disposal is still freed rather than leaked.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    const entries = [...this.sessions.entries()];
    this.sessions.clear();

    // Wait for in-flight runs before freeing anything they are using.
    await Promise.all(entries.map(([key]) => this.whenDrained(key)));
    await Promise.all(entries.map(([, pending]) => releaseQuietly(pending)));
  }

  /** Resolves once nothing is borrowing `key`. */
  private whenDrained(key: string): Promise<void> {
    if ((this.leases.get(key) ?? 0) === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.drained.get(key) ?? [];
      waiters.push(resolve);
      this.drained.set(key, waiters);
    });
  }

  private evictIfNeeded(justAdded: string): void {
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next();
      if (oldest.done || oldest.value === justAdded) return;

      const evicted = this.sessions.get(oldest.value);
      this.sessions.delete(oldest.value);
      if (!evicted) continue;

      if ((this.leases.get(oldest.value) ?? 0) > 0) {
        // Still in use. Drop it from the cache so it stops being handed out,
        // but defer the release until the last borrower finishes — otherwise
        // an unlucky caller runs inference on a freed session.
        this.deferred.set(oldest.value, evicted);
      } else {
        void releaseQuietly(evicted);
      }
    }
  }
}

/**
 * Releases a session, ignoring both a failed initialization and a failed
 * release. Disposal must not throw: it runs during shutdown, where there is
 * nothing useful left to do with an error.
 */
async function releaseQuietly(pending: Promise<ReleasableSession>): Promise<void> {
  try {
    await (await pending).release();
  } catch {
    // Either it never initialized, or it is already gone.
  }
}
