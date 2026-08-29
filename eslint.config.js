import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', 'smoke.mts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      // Terminal code deals in control characters by nature.
      'no-control-regex': 'off',
      eqeqeq: ['error', 'smart'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'apps/server/tests/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['apps/server/scripts/**', '*.config.js', '*.config.ts'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },
  {
    // Plain-JS process fixtures spawned by tests (e.g. a fake `agy` CLI) —
    // not TypeScript, so they need `no-undef`'s Node globals spelled out
    // explicitly the same way the scripts above do.
    files: ['apps/server/tests/fixtures/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // The callbacks passed to page.evaluate() are serialized and run inside the
    // browser, so DOM globals are legitimately in scope there.
    files: [
      'apps/server/scripts/browser-demo.mjs',
      'apps/server/scripts/native-ui-demo.mjs',
      'apps/server/scripts/resume-adopt-ui-demo.mjs',
      'apps/server/scripts/home-ui-demo.mjs',
      'apps/server/scripts/resume-history-demo.mjs',
      'apps/server/scripts/desktop-ui-demo.mjs',
      'apps/server/scripts/copy-ui-demo.mjs',
      'apps/server/scripts/cron-ui-demo.mjs',
    ],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // Frontend source runs in the browser.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  {
    // The service worker has its own global scope (`self`, no `window`).
    files: ['apps/web/public/sw.js'],
    languageOptions: { globals: globals.serviceworker },
  },
);
