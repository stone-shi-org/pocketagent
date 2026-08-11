import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { makeWorkspace, TEST_TOKEN } from './helpers.js';

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', LOG_LEVEL: 'silent', ...overrides } as NodeJS.ProcessEnv;
}

describe('config', () => {
  it('refuses to start without an auth token, and says how to make one', () => {
    const ws = makeWorkspace();
    try {
      expect(() =>
        loadConfig(env({ POCKETAGENT_WORKSPACE_ROOTS: ws.root, POCKETAGENT_AUTH_TOKEN: undefined })),
      ).toThrow(/POCKETAGENT_AUTH_TOKEN is not set[\s\S]*pnpm generate-token/);
    } finally {
      ws.cleanup();
    }
  });

  it('rejects a short token rather than silently accepting it', () => {
    const ws = makeWorkspace();
    try {
      expect(() =>
        loadConfig(env({ POCKETAGENT_WORKSPACE_ROOTS: ws.root, POCKETAGENT_AUTH_TOKEN: 'hunter2' })),
      ).toThrow(/only 7 characters/);
    } finally {
      ws.cleanup();
    }
  });

  it('starts with no workspace roots — they are a seed now, not a requirement', () => {
    // Folders are managed from the app and stored in the database. Unset means
    // no folders at all, which is safe; it never meant "the whole filesystem".
    const config = loadConfig(env({ POCKETAGENT_AUTH_TOKEN: TEST_TOKEN }));
    expect(config.workspaceRoots).toEqual([]);
  });

  it('never seeds "/" as a workspace root', () => {
    const config = loadConfig(
      env({ POCKETAGENT_AUTH_TOKEN: TEST_TOKEN, POCKETAGENT_WORKSPACE_ROOTS: '/' }),
    );
    expect(config.workspaceRoots).toEqual([]);
  });

  it('canonicalizes roots through symlinks and de-duplicates them', () => {
    const ws = makeWorkspace();
    const link = path.join(path.dirname(ws.root), `link-${path.basename(ws.root)}`);
    fs.symlinkSync(ws.root, link);
    try {
      const config = loadConfig(
        env({
          POCKETAGENT_AUTH_TOKEN: TEST_TOKEN,
          POCKETAGENT_WORKSPACE_ROOTS: `${ws.root}, ${link}`,
        }),
      );
      expect(config.workspaceRoots).toEqual([ws.root]);
    } finally {
      fs.unlinkSync(link);
      ws.cleanup();
    }
  });

  it('defaults to loopback and flags non-loopback binds', () => {
    const ws = makeWorkspace();
    try {
      const base = { POCKETAGENT_AUTH_TOKEN: TEST_TOKEN, POCKETAGENT_WORKSPACE_ROOTS: ws.root };
      expect(loadConfig(env(base)).host).toBe('127.0.0.1');
      expect(loadConfig(env(base)).isNetworkExposed).toBe(false);
      expect(loadConfig(env({ ...base, HOST: '0.0.0.0' })).isNetworkExposed).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it('marks cookies Secure in production but not in development', () => {
    const ws = makeWorkspace();
    const base = { POCKETAGENT_AUTH_TOKEN: TEST_TOKEN, POCKETAGENT_WORKSPACE_ROOTS: ws.root };
    try {
      expect(loadConfig({ ...env(base), NODE_ENV: 'production' } as NodeJS.ProcessEnv).cookieSecure).toBe(true);
      expect(loadConfig(env(base)).cookieSecure).toBe(false);
      expect(
        loadConfig({ ...env(base), NODE_ENV: 'production', POCKETAGENT_COOKIE_SECURE: 'false' } as NodeJS.ProcessEnv)
          .cookieSecure,
      ).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  it('rejects out-of-range numeric settings', () => {
    const ws = makeWorkspace();
    try {
      expect(() =>
        loadConfig(
          env({
            POCKETAGENT_AUTH_TOKEN: TEST_TOKEN,
            POCKETAGENT_WORKSPACE_ROOTS: ws.root,
            PORT: '99999',
          }),
        ),
      ).toThrow(/PORT/);
    } finally {
      ws.cleanup();
    }
  });
});
