import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'packages/contracts/src/generated/**',
      'coverage/**',
      'reports/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
];
