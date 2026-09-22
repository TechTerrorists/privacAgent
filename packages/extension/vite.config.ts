import { defineConfig, type Plugin, type UserConfig } from 'vite';
import { crx, type ManifestV3Export } from '@crxjs/vite-plugin';
import { createManifest, type Browser, type Manifest } from './src/manifest.js';
import pkg from './package.json' with { type: 'json' };

const VERSION = pkg.version;

const isBrowser = (mode: string): mode is Browser => mode === 'chrome' || mode === 'firefox';

/**
 * Entry points, keyed by the path they are emitted at. The keys double as
 * output filenames (`entryFileNames: '[name].js'`), which is what lets the
 * Firefox manifest keep the same paths as the source tree.
 */
const ENTRIES = {
  'src/background/index': 'src/background/index.ts',
  'src/content/index': 'src/content/index.ts',
  'src/ui/sidepanel': 'src/ui/sidepanel.html',
} as const;

/**
 * Rewrites the `.ts` entry paths in a manifest to the `.js` files the build
 * actually emits. @crxjs does this for Chrome; Firefox needs it done by hand.
 */
function toBuiltPaths(manifest: Manifest): Manifest {
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replace(/\.ts$/, '.js');
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, rewrite(v)])
      );
    }
    return value;
  };

  return rewrite(manifest) as Manifest;
}

/** Writes `manifest.json` for the Firefox build (@crxjs is Chrome-only). */
function emitFirefoxManifest(): Plugin {
  return {
    name: 'privacagent:emit-firefox-manifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: JSON.stringify(toBuiltPaths(createManifest('firefox', VERSION)), null, 2),
      });
    },
  };
}

export default defineConfig(({ mode }): UserConfig => {
  if (!isBrowser(mode)) {
    throw new Error(
      `Unknown build target "${mode}". Use --mode chrome or --mode firefox (see the build:* scripts).`
    );
  }

  const shared = {
    define: {
      __BROWSER__: JSON.stringify(mode),
      // The two toolchains emit the content script under different names:
      // @crxjs writes a loader that keeps the `.ts` path, the Firefox build
      // emits plain `.js`. Callers of `scripting.executeScript` use this
      // constant instead of hard-coding either one.
      __CONTENT_SCRIPT_PATH__: JSON.stringify(
        mode === 'chrome' ? 'src/content/index.ts' : 'src/content/index.js'
      ),
    },
    build: {
      outDir: `dist/${mode}`,
      emptyOutDir: true,
      // Readable output keeps the Chrome Web Store and AMO source reviews cheap.
      minify: false,
      sourcemap: true,
      target: 'esnext',
    },
  } satisfies UserConfig;

  if (mode === 'chrome') {
    return {
      ...shared,
      plugins: [crx({ manifest: createManifest('chrome', VERSION) as ManifestV3Export })],
      // @crxjs serves over a fixed port so the service worker can reconnect.
      server: { port: 5173, strictPort: true, hmr: { port: 5173 } },
    };
  }

  return {
    ...shared,
    plugins: [emitFirefoxManifest()],
    build: {
      ...shared.build,
      rollupOptions: {
        input: { ...ENTRIES },
        output: {
          format: 'es',
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
});
