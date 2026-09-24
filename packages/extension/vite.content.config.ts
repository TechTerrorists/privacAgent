import { defineConfig, type UserConfig } from 'vite';

/**
 * Dedicated build for the content script (feature A-01).
 *
 * The content script is injected on demand with `scripting.executeScript`,
 * which runs the file as a *classic* script, not a module. It therefore has to
 * be one self-contained file with no `import` statements and no shared chunks,
 * which neither of the main builds can produce: @crxjs only bundles entries it
 * recognises (background, declared content scripts, HTML), and the Firefox
 * build emits ESM with code splitting on.
 *
 * So it gets its own pass: single input, IIFE, dynamic imports inlined. This
 * runs after the main build with `emptyOutDir: false`, so it adds to the same
 * output directory instead of replacing it.
 */

/** Where this build emits, relative to the extension root. Identical on both targets. */
export const CONTENT_SCRIPT_PATH = 'content/index.js';

const isBrowser = (mode: string): mode is 'chrome' | 'firefox' =>
  mode === 'chrome' || mode === 'firefox';

export default defineConfig(({ mode }): UserConfig => {
  if (!isBrowser(mode)) {
    throw new Error(`Unknown build target "${mode}". Use --mode chrome or --mode firefox.`);
  }

  return {
    define: {
      __BROWSER__: JSON.stringify(mode),
      __CONTENT_SCRIPT_PATH__: JSON.stringify(CONTENT_SCRIPT_PATH),
    },
    build: {
      outDir: `dist/${mode}`,
      // The main build already emptied it; this pass adds to it.
      emptyOutDir: false,
      minify: false,
      sourcemap: true,
      target: 'esnext',
      rollupOptions: {
        input: { 'content/index': 'src/content/index.ts' },
        output: {
          // `iife` implies code splitting off, so every dependency is inlined
          // into this one file and nothing can be hoisted into a shared chunk
          // and emitted as a bare `import`. That is the property that keeps
          // the file injectable; do not switch this to `es`.
          format: 'iife',
          entryFileNames: '[name].js',
        },
      },
    },
  };
});
