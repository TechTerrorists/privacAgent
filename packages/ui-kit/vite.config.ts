import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const resolveFromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * `vite` (and plain `vite build`) serves the standalone preview, which is what
 * F-01 ships as its demo surface. `vite build --mode lib` emits the consumable
 * package instead: ESM bundle plus the compiled token stylesheet.
 */
export default defineConfig(({ mode }) => {
  if (mode === 'lib') {
    return {
      plugins: [tailwindcss()],
      esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
      build: {
        outDir: resolveFromRoot('dist'),
        emptyOutDir: true,
        lib: {
          entry: resolveFromRoot('src/index.ts'),
          formats: ['es'] as const,
          fileName: 'index',
        },
        cssCodeSplit: false,
        rollupOptions: { external: ['preact'] },
      },
    };
  }

  return {
    root: resolveFromRoot('src/preview'),
    base: './',
    plugins: [tailwindcss()],
    esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
    build: {
      outDir: resolveFromRoot('dist/preview'),
      emptyOutDir: false,
    },
  };
});
