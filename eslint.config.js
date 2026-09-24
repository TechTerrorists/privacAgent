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
        projectService: {
          // Build tooling lives outside the package projects; tsconfig.node.json
          // is what `pnpm typecheck` uses for these, so type-aware linting and
          // typechecking agree on them.
          allowDefaultProject: ['*.config.ts', 'packages/*/*.config.ts'],
          defaultProject: 'tsconfig.node.json',
        },
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
  //
  // Config files used to opt out of type-aware linting here. They no longer
  // need to: tsconfig.node.json covers them, so they are both linted and
  // typechecked like any other source file.
  {
    files: ['packages/protocol/scripts/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
  {
    files: ['**/*.config.js'],
    languageOptions: {
      parserOptions: {
        projectService: false,
      },
    },
  }
);
