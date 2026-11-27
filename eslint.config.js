import { builtinModules } from 'node:module';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

// Node built-ins, with and without the `node:` prefix. packages/core must stay
// isomorphic (it also runs in the browser), so it may import none of them.
const nodeBuiltins = builtinModules.filter((name) => !name.startsWith('_'));

export default ts.config(
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/build/',
      '**/coverage/',
      '**/.svelte-kit/',
      'packages/core/src/version.ts',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,svelte}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        extraFileExtensions: ['.svelte'],
        parser: ts.parser,
      },
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    languageOptions: {
      // Isomorphic code. Node globals (process, Buffer) are caught by tsc, since
      // core compiles with `"types": []`.
      globals: { ...globals['shared-node-browser'] },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: nodeBuiltins.map((name) => ({
            name,
            message: 'packages/core must stay isomorphic: no Node built-in modules.',
          })),
          patterns: [
            {
              group: ['node:*'],
              message: 'packages/core must stay isomorphic: no Node built-in modules.',
            },
          ],
        },
      ],
    },
  },
);
