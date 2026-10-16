import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'out/**', 'node_modules/**', '.vscode-test/**', 'docs/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'eqeqeq': ['error', 'always'],
      'no-console': 'error'
    }
  }
);
