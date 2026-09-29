import { afterEach, describe, expect, it, vi } from 'vitest';

import { OnnxRuntime } from './runtime.js';
import type { ModelDescriptor } from './types.js';

/**
 * Exercises the runtime against a stub ONNX Runtime.
 *
 * These cover lifecycle and ownership, which are engine-independent. Real
 * execution, backend selection against real hardware and CSP behaviour are
 * covered by `tests/onnx-runtime.spec.ts`; stubs cannot establish those.
 */

const MODEL: ModelDescriptor = { id: 'm', version: '1', bytes: new Uint8Array([1]) };
const PROBE = new Uint8Array([9]);

function stubOrt(options: { onCreate?: () => void; threadsAfterInit?: number } = {}) {
  const released: string[] = [];
  let created = 0;

  const env = { wasm: { numThreads: 0 } as { wasmPaths?: string; numThreads: number } };

  const ort = {
    env,
    Tensor: class {
      constructor(
        public type: string,
        public data: Float32Array,
        public dims: readonly number[]
      ) {}
      dispose(): void {}
    },
    InferenceSession: {
      create: vi.fn(async (bytes: Uint8Array) => {
        options.onCreate?.();
        // Tagged by source so a probe session cannot be mistaken for a cached
        // model session when asserting what was released.
        const id = `${bytes[0] === PROBE[0] ? 'probe' : 'model'}-${(created += 1)}`;
        if (options.threadsAfterInit !== undefined) {
          // Real ONNX Runtime settles on an effective thread count; the stub
          // mimics that so the runtime can be checked for reporting it.
          env.wasm.numThreads = options.threadsAfterInit;
        }
        return {
          id,
          run: vi.fn(async () => ({
            output: { type: 'float32', data: new Float32Array([1]), dims: [1], dispose() {} },
          })),
          release: vi.fn(async () => {
            released.push(id);
          }),
        };
      }),
    },
  };

  return { ort, released, sessionsCreated: () => created };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('int64 tensors', () => {
  it('constructs an int64 input and copies out an int64 output as a fresh buffer', async () => {
    const seenTypes: string[] = [];
    const { ort } = stubOrt();
    const int64Ort = {
      ...ort,
      Tensor: class {
        constructor(
          public type: string,
          public data: Float32Array | BigInt64Array,
          public dims: readonly number[]
        ) {
          seenTypes.push(type);
        }
        dispose(): void {}
      },
      InferenceSession: {
        create: async () => ({
          run: async (feeds: Record<string, { data: BigInt64Array }>) => ({
            output: {
              type: 'int64',
              data: feeds.input!.data,
              dims: [1, 4],
              dispose(): void {},
            },
          }),
          release: async () => undefined,
        }),
      },
    };

    const runtime = new OnnxRuntime({
      backendOrder: ['wasm'],
      loadOrt: () => Promise.resolve(int64Ort as never),
    });
    await runtime.initialize(PROBE);

    const inputData = new BigInt64Array([101n, 2054n, 2003n, 102n]);
    const outputs = await runtime.run(MODEL, {
      input: { type: 'int64', data: inputData, dims: [1, 4] },
    });

    expect(seenTypes).toContain('int64');
    expect(outputs.output!.type).toBe('int64');
    expect(outputs.output!.data).toEqual(inputData);
    expect(outputs.output!.data).not.toBe(inputData);

    await runtime.dispose();
  });
});

describe('repeated initialization', () => {
  it('releases the previous cache instead of orphaning its sessions', async () => {
    const { ort, released } = stubOrt();
    const runtime = new OnnxRuntime({
      backendOrder: ['wasm'],
      loadOrt: () => Promise.resolve(ort as never),
    });

    await runtime.initialize(PROBE);
    await runtime.loadModel(MODEL);

    // Probe sessions are released by the probe itself, so counting every
    // release would pass regardless. Only the cached model session matters.
    expect(released.filter((id) => id.startsWith('model'))).toHaveLength(0);

    await runtime.initialize(PROBE);

    // The cached model session must be released, not silently orphaned along
    // with the cache that held it.
    expect(released.filter((id) => id.startsWith('model'))).toHaveLength(1);
    expect(runtime.diagnostics().sessionCount).toBe(0);

    await runtime.dispose();
  });
});

describe('initialization racing disposal', () => {
  it('does not report ready when disposed mid-initialization', async () => {
    let releaseCreate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });

    const { ort } = stubOrt({ onCreate: () => undefined });
    const slowOrt = {
      ...ort,
      InferenceSession: {
        create: async (bytes: Uint8Array) => {
          await gate;
          return ort.InferenceSession.create(bytes);
        },
      },
    };

    const runtime = new OnnxRuntime({
      backendOrder: ['wasm'],
      loadOrt: () => Promise.resolve(slowOrt as never),
    });

    const initializing = runtime.initialize(PROBE);
    await runtime.dispose();
    releaseCreate();
    await initializing;

    // A runtime disposed during startup must not come back claiming to work.
    expect(runtime.diagnostics().status).not.toBe('ready');
    await expect(runtime.loadModel(MODEL)).rejects.toThrow();
  });
});

describe('reported thread count', () => {
  it('reports the threads the engine settled on, not the number requested', async () => {
    // The engine may clamp, or fail to spawn its pool and fall back to one
    // thread. Reporting the requested count would assert a capability that was
    // never verified — the same failure mode the backend ladder exists to avoid.
    const { ort } = stubOrt({ threadsAfterInit: 1 });
    const runtime = new OnnxRuntime({
      backendOrder: ['wasm-threaded'],
      loadOrt: () => Promise.resolve(ort as never),
    });

    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 });

    await runtime.initialize(PROBE);

    expect(runtime.diagnostics().threads).toBe(1);

    await runtime.dispose();
    vi.unstubAllGlobals();
  });
});

describe('disposal during inference', () => {
  it('does not release a session that a run is still using', async () => {
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let runStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      runStarted = resolve;
    });

    const released: string[] = [];
    const ort = {
      env: { wasm: { numThreads: 1 } },
      Tensor: class {
        constructor(
          public type: string,
          public data: Float32Array,
          public dims: readonly number[]
        ) {}
        dispose(): void {}
      },
      InferenceSession: {
        // Only the model's session is gated. Gating every session would also
        // stall the probe inside `initialize`, hanging the test before it
        // begins rather than exercising disposal.
        create: async (bytes: Uint8Array) => {
          const isProbe = bytes[0] === PROBE[0];
          return {
            run: async () => {
              if (!isProbe) {
                runStarted();
                await runGate;
              }
              return { output: { data: new Float32Array([1]), dims: [1], dispose() {} } };
            },
            release: async () => {
              if (!isProbe) released.push('released');
            },
          };
        },
      },
    };

    const runtime = new OnnxRuntime({
      backendOrder: ['wasm'],
      loadOrt: () => Promise.resolve(ort as never),
    });
    await runtime.initialize(PROBE);

    const running = runtime.run(MODEL, {
      input: { type: 'float32', data: new Float32Array([1]), dims: [1] },
    });
    // Wait until inference has genuinely started. Disposing earlier would race
    // the borrow rather than exercise it.
    await started;

    const disposing = runtime.dispose();

    // Give disposal real time to run. Asserting synchronously would pass even
    // without the fix, because the release is asynchronous and simply had not
    // happened yet.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Freeing the session here would hand the in-flight run freed memory.
    expect(released).toHaveLength(0);

    releaseRun();
    await running;
    await disposing;

    expect(released).toHaveLength(1);
  });
});
