import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/web-ext-artifacts/**',
      '**/*.tsbuildinfo',
      'packages/protocol/src/generated/**',
      '.venv/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Feature A-06 adds the rule that fails the build when `fetch`/XHR is called
  // outside the single network chokepoint in the background context.
  {
    files: ['packages/protocol/scripts/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
  {
    files: ['**/*.config.ts', '**/*.config.js', '**/vite.config.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
      },
    },
  }
);
