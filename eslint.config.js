const tseslint = require('typescript-eslint');
const prettier = require('eslint-config-prettier');

module.exports = tseslint.config(
  { ignores: ['dist/**', 'reference/**', 'tools/**', 'supabase/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
