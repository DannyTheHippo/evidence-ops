import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import tseslint from 'typescript-eslint';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';

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
);
