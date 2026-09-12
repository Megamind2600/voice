import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Flat ESLint config.
 *
 * Deliberately uses the NON-type-checked ruleset: `tsc --noEmit` already runs in the same
 * CI job and covers everything type-aware linting would, at a fraction of the time. On a
 * 252 minute/month Actions budget, running the type-aware ruleset too would roughly double
 * lint time for no additional signal.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'public/data/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2022 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-var': 'error',
      'prefer-const': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none',
      }],
      // Bit-packed binary code shifts and masks constantly; a rule against bitwise ops
      // would generate pure noise here.
      'no-bitwise': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // Fixtures legitimately build containers out of thin air.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['src/**/*.tsx'],
    rules: {
      // Preact's JSX runtime, not React's.
      'react/react-in-jsx-scope': 'off',
    },
  },
  {
    files: ['vite.config.ts', 'scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
