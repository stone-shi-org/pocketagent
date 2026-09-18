import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          root: './apps/server',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          // PTY tests spawn real processes; give them room on a loaded machine.
          testTimeout: 20_000,
          hookTimeout: 20_000,
          // Each file gets a fresh process so node-pty and SQLite handles do not
          // leak between suites.
          pool: 'forks',
        },
      },
      {
        test: {
          name: 'hub',
          root: './apps/hub',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          // The proxy suites bind real sockets and open real SQLite handles —
          // a splice cannot be exercised through `app.inject()` — so each file
          // gets its own process for the same reason the server's do.
          pool: 'forks',
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'web',
          root: './apps/web',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
    ],
  },
});
