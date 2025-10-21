module.exports = {
  root: true,
  ignorePatterns: ['__mocks__/**'],
  env: {
    es2021: true,
    node: true,
    'jest/globals': true,
  },
  extends: [
    '@react-native/eslint-config',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
    'plugin:import/typescript',
    'plugin:jest/recommended',
    'prettier',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  plugins: ['@typescript-eslint', 'import', 'react', 'react-hooks', 'jest'],
  rules: {
    'react/react-in-jsx-scope': 'off',
    'import/no-default-export': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-misused-promises': 'error',
    'react/prop-types': 'off'
  },
  settings: {
    react: {
      version: 'detect',
    },
  },
};
