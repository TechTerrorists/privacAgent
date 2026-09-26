import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.{ts,tsx}', 'bench/**/*.test.ts'],
    environment: 'node',
  },
});
