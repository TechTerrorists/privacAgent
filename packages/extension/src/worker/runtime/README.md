# ONNX runtime (C-02)

Local model execution behind C-01's inference interfaces: backend selection,
session caching, and explicit resource ownership.

**Feature-list acceptance:** backend selection WebGPU → WASM threads → WASM;
cross-origin isolation for threads; session cache; tensors released per step.

This feature ships **no models**. C-05–C-09 supply the real detector, OCR, face
and icon models; A-13 owns downloading and verifying them.

## Backend matrix

| Context                                       | WebGPU               | Threaded WASM  | WASM |
| --------------------------------------------- | -------------------- | -------------- | ---- |
| Chrome, offscreen document → dedicated worker | if an adapter exists | **yes**        | yes  |
| Firefox, background page → dedicated worker   | flagged, assume no   | **impossible** | yes  |

Threaded WASM needs `crossOriginIsolated`, which needs the COOP/COEP manifest
keys. Chrome grants those to extension pages. **Firefox cannot** — extension
pages are not cross-origin isolated
([bugzilla 1673477](https://bugzilla.mozilla.org/show_bug.cgi?id=1673477),
blocked on per-extension process isolation). Firefox running single-threaded
WASM is a platform ceiling, not a misconfiguration.

Chrome's own cross-origin isolation is also not implemented for service
workers, which is why the worker is hosted by an offscreen _document_: a real
extension page that receives the isolation, and whose dedicated worker inherits
it. The browser test asserts both rather than assuming them.

## Detection is not initialization

The ladder never reports a backend it has not executed on. Each rung is
attempted by compiling **and running** the test model; only then is it marked
`selected`. Every cheaper check lies in practice:

- `navigator.gpu` exists on machines whose `requestAdapter()` returns null;
- an adapter can exist on a driver where session creation fails;
- `crossOriginIsolated` can be true while the thread pool still fails to spawn.

Fallback is bounded by construction: each rung is tried exactly once, in fixed
order, with no retries, so a broken driver cannot produce a retry storm.

`initialize()` **returns** diagnostics rather than throwing when nothing works —
the attempt log is the most valuable thing it produces, and throwing would
discard it exactly when it matters. Usage still fails loudly: `loadModel()` and
`run()` raise `RuntimeUnavailableError`.

## Session cache

Keyed by `${model.id}@${model.version}#${backend}`. Version is in the key so a
re-exported model never resolves to a session compiled from older bytes;
backend is in the key because the same graph compiled for WebGPU and for WASM
are different objects.

Three behaviours matter more than the caching:

- **Concurrent callers share one initialization.** The in-flight promise is
  cached, not just the result. Without this, a page with several Tier 1 regions
  would compile the detector several times in parallel.
- **Failure does not poison the cache.** A rejected initialization is evicted so
  a transient failure can be retried; caching the rejection would disable a
  backend permanently.
- **Nothing here holds data.** Keys are identity and configuration. No
  screenshots, tensors or results are stored.

`dispose()` releases everything, including sessions that finish compiling after
disposal began. A-04 calls it on shutdown or idle unload; this module
implements no idle policy of its own.

## Tensor ownership

Three categories, one of which is ours:

| Category                  | Disposed by                             |
| ------------------------- | --------------------------------------- |
| Caller-owned inputs       | never disposed here                     |
| Runtime-owned temporaries | this module, on success **and** failure |
| Returned outputs          | the caller                              |

`withTensorScope()` frees registered tensors in a `finally`, so an inference
failure — when temporaries are most likely to be stranded — cannot leak. A
tensor that is being returned is handed over with `scope.release()`.

`run()` copies outputs into plain `Float32Array`s and disposes the ONNX tensors
before returning. A WebGPU-backed tensor escaping into consumer code is a leak
waiting to happen, since the consumer has no idea it holds a GPU buffer, and
PRD §11.2 allows 300 MB of GPU memory for the entire client.

## Packaging

`onnxruntime-web` unpacks to 144 MB, so shipping it wholesale is not an option.
The build emits exactly one variant: `ort-wasm-simd-threaded.jsep.*`, ~28 MB,
which covers the whole ladder in a single artifact — WebGPU via JSEP, threaded
WASM and single-threaded WASM. The wasm-only build is half the size but drops
WebGPU entirely.

The binary is emitted by Vite, not copied by hand: the default entry references
it through `new URL(..., import.meta.url)`, which the build rewrites to a hashed
local asset. `env.wasm.wasmPaths` is therefore left unset — assigning it would
override a correct path with a guess. Copying manually _as well_ produced two
28 MB copies.

Nothing is fetched from a CDN. MV3 forbids remote code, and the project forbids
a network client independently.

### CSP

`'wasm-unsafe-eval'` is required for any WASM compilation in MV3 from Chrome 103
on. Despite the name it does **not** re-enable JavaScript `eval`; it permits
WASM compilation and nothing else, and it is the only relaxation MV3 allows
(`script-src` accepts `'self'`, `'none'` and this token, nothing more).

`web-ext lint` reports two `DANGEROUS_EVAL` warnings against ONNX Runtime's
bundle, which uses the `Function` constructor. The browser test asserts that no
CSP violation occurs during initialization, so that path is not reached under
our policy.

## Test model

`testdata/linear.onnx` (409 bytes) computes `Y = [2,2,2,2] * X + [1,2,3,4]`, so
`[1,2,3,4]` must produce `[3,6,9,12]`. Generated by
`tools/generate-test-model.py`; provenance and licence are this repository's.

```sh
uv run --locked python tools/generate-test-model.py
```

Its IR version is pinned to 9. The `onnx` package defaults to its own newest
(14), which ONNX Runtime Web rejects with "Unsupported model IR version" —
every backend then fails and it looks like a runtime fault rather than a model
one.

## Running the tests

```sh
# unit: ladder, cache, tensors
pnpm vitest run packages/extension/src/worker/runtime

# real extension, real worker. Headless: covers threaded and single-threaded WASM.
pnpm build:chrome && pnpm exec playwright test onnx-runtime --project=chromium

# adds WebGPU coverage. Needs a GPU and a display; runs headed.
PA_WEBGPU=1 pnpm exec playwright test onnx-runtime --project=chromium
```

Headless Chromium on Linux exposes no GPU process, so the default run always
records `no_adapter` for WebGPU. `PA_WEBGPU=1` launches headed with
`--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan
--ignore-gpu-blocklist`, which is what makes the top rung reachable.
`PA_BROWSER_CHANNEL` overrides the browser channel.

The single-threaded baseline is forced through `backendOrder: ['wasm']` rather
than waited for: on a machine with threads the ladder never descends to it, yet
it is the rung Firefox always lands on and the one the degraded-device suite
depends on.

The browser test is the one that establishes the acceptance criteria: unit
tests prove the ladder's logic with stubs, but only the browser test proves ONNX
Runtime initializes, the packaged WASM loads under MV3's CSP, the host is
cross-origin isolated, and a graph produces the right numbers in a dedicated
worker. It prints the selected backend and full attempt log so real coverage can
be recorded rather than guessed.

Chromium only. Firefox extension verification needs a `web-ext` + Selenium
harness that does not exist yet (PRD §12.3); Firefox runtime coverage is
deferred and is not claimed anywhere.

## Integration points

| Concern                                       | Owner                                               |
| --------------------------------------------- | --------------------------------------------------- |
| Inference contracts and coverage rules        | C-01                                                |
| Cross-context transport                       | A-03 — `worker.ts`'s protocol is a placeholder seam |
| Worker host lifecycle, keepalive, idle unload | A-04 — calls `dispose()`                            |
| Model download, integrity, IndexedDB caching  | A-13 — supplies `ModelDescriptor.bytes`             |
| Per-model benchmark table                     | C-03                                                |
| Model preprocessing / postprocessing          | later C-lane features                               |

`createOnnxInferenceApi()` implements C-01's `InferenceApi` and currently
returns `unavailable` for all four operations with `synthetic: false`, because
there are no models yet. It is **not** registered with `setInferenceApi` — the
deterministic fake stays active, so nothing changes for other lanes. Reporting
`empty` instead would be the precise failure C-01's three-way result exists to
prevent: "the runtime is up" is not "the image was examined".
