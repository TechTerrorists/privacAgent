import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const resolveFromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * The kit is consumed from source inside this workspace (see the `exports` map), so this
 * config only ever serves or builds the standalone preview. There is no library build step
 * to keep in sync with the package entry.
 */
export default defineConfig({
  root: resolveFromRoot('src/preview'),
  base: './',
  plugins: [tailwindcss()],
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  build: {
    outDir: resolveFromRoot('dist/preview'),
    emptyOutDir: true,
  },
});
