/**
 * ONNX Runtime facade (feature C-02).
 *
 * Owns runtime configuration, backend selection and the session cache. This is
 * the only module that imports `onnxruntime-web`, and it does so through a
 * dynamic import inside {@link OnnxRuntime.initialize} so that the surrounding
 * modules stay unit-testable under Node without pulling in a WASM runtime.
 *
 * ## Assets
 *
 * The runtime's `.mjs` loader and `.wasm` binary are copied into the extension
 * at build time and loaded from the extension's own origin. Nothing is fetched
 * from a CDN and no network client is introduced — MV3 forbids remote code,
 * and the project's egress rule forbids it independently.
 *
 * ## Output ownership
 *
 * `run()` copies outputs into plain typed arrays and disposes the ONNX tensors
 * before returning. A WebGPU-backed tensor escaping into consumer code is a
 * leak waiting to happen — the consumer has no idea it holds a GPU buffer —
 * and PRD §11.2 allows only 300 MB of GPU memory for the entire client. The
 * copy costs a few microseconds on tensors this size and removes the whole
 * class of bug.
 */

import { executionProviderFor, selectBackend, threadsFor } from './backend.js';
import { detectCapabilities } from './capabilities.js';
import {
  InferenceExecutionError,
  ModelLoadError,
  RuntimeDisposedError,
  RuntimeUnavailableError,
  toReasonCode,
} from './errors.js';
import { SessionCache, type ReleasableSession } from './session-cache.js';
import { withTensorScope } from './tensors.js';
import type {
  BackendAttempt,
  BackendName,
  ModelDescriptor,
  RuntimeCapabilities,
  RuntimeDiagnostics,
  RuntimeStatus,
} from './types.js';

/** Minimal shape of the ONNX Runtime Web module, so this file needs no `any`. */
interface OrtModule {
  env: {
    wasm: { wasmPaths?: string; numThreads?: number };
  };
  Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => OrtTensor;
  InferenceSession: {
    create(
      model: Uint8Array,
      options: { executionProviders: readonly string[] }
    ): Promise<OrtSession>;
  };
}

interface OrtTensor {
  readonly data: Float32Array;
  readonly dims: readonly number[];
  dispose(): void;
}

interface OrtSession extends ReleasableSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}

/** A named float32 input. */
export interface RuntimeInput {
  readonly data: Float32Array;
  readonly dims: readonly number[];
}

/** A named float32 output, copied out of the runtime's memory. */
export interface RuntimeOutput {
  readonly data: Float32Array;
  readonly dims: readonly number[];
}

export interface OnnxRuntimeOptions {
  /**
   * Overrides where ONNX Runtime looks for its WASM binary. Leave unset: the
   * build emits the binary locally and wires its URL automatically.
   */
  readonly assetBasePath?: string;
  readonly maxSessions?: number;
  /**
   * Overrides the ladder. Used to exercise a lower rung deliberately — the
   * single-threaded WASM baseline is otherwise unreachable on a machine that
   * has threads, and the degraded-device suite (PRD §12.3) needs to force it.
   */
  readonly backendOrder?: readonly BackendName[];
  /** Injected for tests. Defaults to importing `onnxruntime-web`. */
  readonly loadOrt?: () => Promise<OrtModule>;
}

/**
 * Local ONNX execution.
 *
 * One instance per worker. A-04 owns when that worker starts and stops; this
 * class deliberately implements no idle policy of its own.
 */
export class OnnxRuntime {
  private status: RuntimeStatus = 'uninitialized';
  private backend: BackendName | undefined;
  private attempts: readonly BackendAttempt[] = [];
  private capabilities: RuntimeCapabilities = {
    webgpu: false,
    crossOriginIsolated: false,
    sharedArrayBuffer: false,
    hardwareConcurrency: 1,
  };
  /** Threads the engine settled on, observed after initialization. */
  private threads = 1;
  private ort: OrtModule | undefined;
  private cache: SessionCache<OrtSession> | undefined;
  private disposed = false;

  constructor(private readonly options: OnnxRuntimeOptions = {}) {}

  /**
   * Selects a backend by compiling and running `probeModel` on each rung.
   *
   * @param probeModel A small model used only to prove a backend works. Bytes
   *   are supplied by the caller; this module never fetches them.
   * @returns Diagnostics describing what was tried and what was chosen.
   * @returns Diagnostics with `status: "unavailable"` when no backend executes;
   *   `loadModel` and `run` then throw RuntimeUnavailableError.
   */
  async initialize(probeModel: Uint8Array): Promise<RuntimeDiagnostics> {
    if (this.disposed) throw new RuntimeDisposedError();

    const ort = await (this.options.loadOrt?.() ?? loadOnnxRuntime());
    this.ort = ort;

    // Only set when explicitly overridden. The bundled entry locates its own
    // binary through `import.meta.url`, which the build rewrites to a hashed
    // local asset; assigning `wasmPaths` unconditionally would override that
    // correct path with a guess.
    if (this.options.assetBasePath !== undefined) {
      ort.env.wasm.wasmPaths = this.options.assetBasePath;
    }

    this.capabilities = await detectCapabilities();

    const selection = await selectBackend(async (backend) => {
      // Threads must be set before session creation: ONNX Runtime reads this
      // when it spins up its worker pool, not per run.
      ort.env.wasm.numThreads = threadsFor(backend);
      const session = await ort.InferenceSession.create(probeModel, {
        executionProviders: [executionProviderFor(backend)],
      });
      // Creation alone is not proof — some backends fail only at first
      // execution, so the probe releases the session and reports success only
      // after the graph has actually run.
      try {
        await session.run(buildProbeFeeds(ort));
      } finally {
        await session.release().catch(() => undefined);
      }
    }, this.options.backendOrder);

    this.attempts = selection.attempts;

    if (!selection.backend) {
      // Reported, not thrown. The attempt log is the most valuable thing this
      // method produces, and throwing would discard it exactly when it matters.
      // Usage still fails loudly: `loadModel` and `run` raise
      // RuntimeUnavailableError, so an unusable runtime cannot go unnoticed.
      this.status = 'unavailable';
      this.backend = undefined;
      this.threads = 1;
      const orphaned = this.cache;
      this.cache = undefined;
      await orphaned?.dispose();
      return this.diagnostics();
    }

    // A dispose() that landed while the probes were running must win. Without
    // this the runtime would come back reporting `ready` after being shut down.
    if (this.disposed) {
      this.status = 'uninitialized';
      return this.diagnostics();
    }

    this.backend = selection.backend;

    // Read back what the probe left, rather than re-asserting the request. The
    // engine settles on its own effective count — it may clamp, or fail to
    // spawn its pool and fall back to one thread — and overwriting here would
    // replace the observed value with the number we asked for, asserting a
    // capability nothing verified.
    this.threads = ort.env.wasm.numThreads ?? 1;

    // Replace, but release first: a second initialize() would otherwise orphan
    // every session the previous cache still held.
    const previous = this.cache;
    this.cache = undefined;
    await previous?.dispose();

    this.status = 'ready';
    this.cache = new SessionCache<OrtSession>(
      (model, backend) =>
        ort.InferenceSession.create(model.bytes, {
          executionProviders: [executionProviderFor(backend)],
        }),
      this.options.maxSessions === undefined ? {} : { maxSessions: this.options.maxSessions }
    );

    return this.diagnostics();
  }

  /** Compiles a model and caches its session. Safe to call repeatedly. */
  async loadModel(model: ModelDescriptor): Promise<void> {
    const { cache, backend } = this.requireReady();
    try {
      await cache.acquire(model, backend);
    } catch (cause) {
      throw new ModelLoadError(model.id, model.version, toReasonCode(cause));
    }
  }

  /**
   * Runs a model.
   *
   * Input `Float32Array`s stay owned by the caller and are never disposed.
   * Output tensors are copied and disposed here, so the returned arrays are
   * plain memory the caller owns outright.
   */
  async run(
    model: ModelDescriptor,
    feeds: Readonly<Record<string, RuntimeInput>>
  ): Promise<Record<string, RuntimeOutput>> {
    const { cache, backend, ort } = this.requireReady();

    // Compiled first so a load failure still surfaces as ModelLoadError rather
    // than being flattened into an execution error by the borrow below.
    await this.loadModel(model);

    try {
      // `use` holds a lease for the whole run, so eviction or disposal cannot
      // release the session out from under an in-flight inference.
      return await cache.use(model, backend, (session) =>
        withTensorScope(async (scope) => {
          const inputs: Record<string, OrtTensor> = {};
          for (const [name, input] of Object.entries(feeds)) {
            // Owned: built here from caller data, so freed on every path. The
            // caller's Float32Array is untouched.
            inputs[name] = scope.own(new ort.Tensor('float32', input.data, input.dims));
          }

          const results = await session.run(inputs);

          const outputs: Record<string, RuntimeOutput> = {};
          for (const [name, tensor] of Object.entries(results)) {
            scope.own(tensor);
            outputs[name] = {
              // Copied: the tensor is disposed when the scope closes.
              data: new Float32Array(tensor.data),
              dims: [...tensor.dims],
            };
          }
          return outputs;
        })
      );
    } catch (cause) {
      throw new InferenceExecutionError(model.id, toReasonCode(cause));
    }
  }

  /** Bounded status information. Contains no payload of any kind. */
  diagnostics(): RuntimeDiagnostics {
    const diagnostics: RuntimeDiagnostics = {
      status: this.status,
      attempts: this.attempts,
      capabilities: this.capabilities,
      sessionCount: this.cache?.size ?? 0,
      threads: this.backend ? this.threads : 1,
    };
    return this.backend ? { ...diagnostics, backend: this.backend } : diagnostics;
  }

  /**
   * Releases every session and marks the runtime unusable.
   *
   * A-04 calls this on host shutdown or idle unload.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.status = 'uninitialized';
    const cache = this.cache;
    this.cache = undefined;
    this.backend = undefined;
    await cache?.dispose();
  }

  private requireReady(): {
    cache: SessionCache<OrtSession>;
    backend: BackendName;
    ort: OrtModule;
  } {
    if (this.disposed) throw new RuntimeDisposedError();
    if (this.status !== 'ready' || !this.cache || !this.backend || !this.ort) {
      throw new RuntimeUnavailableError(this.attempts.map((attempt) => attempt.backend));
    }
    return { cache: this.cache, backend: this.backend, ort: this.ort };
  }
}

/**
 * Feeds for the probe model (`Y = A * X + B` over a 1x4 float32 tensor).
 *
 * Kept in lockstep with tools/generate-test-model.py.
 */
function buildProbeFeeds(ort: OrtModule): Record<string, OrtTensor> {
  return { input: new ort.Tensor('float32', new Float32Array([1, 2, 3, 4]), [1, 4]) };
}

/**
 * Imports ONNX Runtime Web.
 *
 * Dynamic so that modules importing this file stay loadable under Node, and so
 * the 28 MB WASM binary is only touched once inference is genuinely wanted.
 */
async function loadOnnxRuntime(): Promise<OrtModule> {
  const module = await import('onnxruntime-web');
  return module as unknown as OrtModule;
}
