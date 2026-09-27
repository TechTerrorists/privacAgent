import { defineConfig, type UserConfig } from 'vite';

/**
 * Build pass for the ML worker and its offscreen host (feature C-02).
 *
 * A third pass, after the main build and alongside the content-script pass,
 * for two reasons:
 *
 * - @crxjs derives its inputs from the manifest, and neither of these appears
 *   there. The offscreen document is opened at runtime by URL, not declared.
 * - Both need identical output paths on Chrome and Firefox so the host can
 *   reference the worker by a single constant.
 *
 * Unlike the content script this emits ESM: module workers support `import`,
 * so code splitting here is safe.
 *
 * It also copies ONNX Runtime's WASM assets into the package. They must be
 * local — MV3 forbids remote code, and the project forbids a network client
 * independently — so nothing is ever fetched from a CDN.
 */

/**
 * ONNX Runtime's WASM binary is emitted by Vite, not copied by hand.
 *
 * The default `onnxruntime-web` entry references its binary through
 * `new URL(..., import.meta.url)`, which Vite rewrites to a hashed asset in
 * this bundle — so the file is packaged locally, served from the extension's
 * own origin, and located without configuring `env.wasm.wasmPaths`. Copying it
 * manually as well produced two 28 MB copies of the same binary.
 *
 * The variant that entry pulls in (`ort-wasm-simd-threaded.jsep.*`) covers the
 * whole backend ladder in one artifact: WebGPU via JSEP, threaded WASM, and
 * single-threaded WASM. The wasm-only build is half the size but drops WebGPU
 * entirely, and shipping several variants would cost more than this one does.
 */
const ENTRIES = {
  'worker/runtime': 'src/worker/runtime/worker.ts',
  'offscreen/runtime-host': 'src/offscreen/runtime-host.html',
} as const;

const isBrowser = (mode: string): mode is 'chrome' | 'firefox' =>
  mode === 'chrome' || mode === 'firefox';

export default defineConfig(({ mode }): UserConfig => {
  if (!isBrowser(mode)) {
    throw new Error(`Unknown build target "${mode}". Use --mode chrome or --mode firefox.`);
  }

  const outDir = `dist/${mode}`;

  return {
    define: {
      __BROWSER__: JSON.stringify(mode),
    },
    build: {
      outDir,
      // The main and content passes already wrote here.
      emptyOutDir: false,
      minify: false,
      sourcemap: true,
      target: 'esnext',
      rollupOptions: {
        input: { ...ENTRIES },
        output: {
          format: 'es',
          entryFileNames: '[name].js',
          chunkFileNames: 'worker/chunks/[name]-[hash].js',
          assetFileNames: 'worker/assets/[name]-[hash][extname]',
        },
      },
    },
  };
});
