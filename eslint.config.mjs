import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import tseslint from 'typescript-eslint';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import determinismFence from './eslint-rules/determinism-fence.cjs';

const tsconfigRootDir = dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  {
    ignores: ['web/**', 'dist/**', 'coverage/**', 'node_modules/**'],
  },

  ...tseslint.configs.recommendedTypeChecked,
  prettierRecommended,

  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  {
    files: ['migrate-mongo-config.js'],
    languageOptions: { globals: globals.node },
  },

  {
    files: ['**/*.request.dto.ts'],
    rules: {
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          selector: 'class',
          modifiers: ['exported'],
          format: ['PascalCase'],
          custom: { regex: 'RequestDto$', match: true },
        },
      ],
    },
  },

  {
    files: ['**/*.response.dto.ts'],
    rules: {
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          selector: 'class',
          modifiers: ['exported'],
          format: ['PascalCase'],
          custom: { regex: 'ResponseDto$', match: true },
        },
      ],
    },
  },

  {
    files: ['**/*.api-examples.ts'],
    rules: {
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          selector: 'variable',
          modifiers: ['exported'],
          format: ['camelCase'],
        },
      ],
    },
  },

  // Determinism fence, half one (ADR-0003): workflow code must stay deterministic, so nothing
  // that touches Nest DI, Mongo, or the Temporal client/worker APIs may be imported here. Options
  // live in `eslint-rules/determinism-fence.cjs` (shared with
  // `test/eslint/determinism-fence.spec.ts`, which proves the rule actually rejects a forbidden
  // import) — see that file for why this is a fast CI signal, not the guarantee.
  {
    files: ['src/workflows/**/*.ts'],
    rules: {
      'no-restricted-imports': determinismFence.noRestrictedImportsOptions,
    },
  },
);
