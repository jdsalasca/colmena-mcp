import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'widget/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
