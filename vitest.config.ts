import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'bench/**/*.test.ts'],
    environment: 'node',
  },
});
