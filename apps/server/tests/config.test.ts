import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { REPO_ROOT, loadConfig } from '../src/config/index.js';
import { resolvePlannerSkillsRoot } from '../src/planner/skills.js';
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

  it('leaves voice input disabled (liveSttUrl null) when POCKETAGENT_LIVE_STT_URL is unset', () => {
    const config = loadConfig(env({ POCKETAGENT_AUTH_TOKEN: TEST_TOKEN }));
    expect(config.liveSttUrl).toBeNull();
  });

  it('parses and normalizes a configured live-stt URL, stripping a trailing slash', () => {
    const config = loadConfig(
      env({ POCKETAGENT_AUTH_TOKEN: TEST_TOKEN, POCKETAGENT_LIVE_STT_URL: 'http://10.100.0.50:8000/' }),
    );
    expect(config.liveSttUrl).toBe('http://10.100.0.50:8000');
  });

  it('fails the boot on a malformed POCKETAGENT_LIVE_STT_URL rather than failing on first use', () => {
    expect(() =>
      loadConfig(env({ POCKETAGENT_AUTH_TOKEN: TEST_TOKEN, POCKETAGENT_LIVE_STT_URL: 'not a url' })),
    ).toThrow(/POCKETAGENT_LIVE_STT_URL is not a valid URL/);
  });

  it('seeds liveSttModel and liveSttTtsModel from env when provided (PA-81)', () => {
    const config = loadConfig(
      env({
        POCKETAGENT_AUTH_TOKEN: TEST_TOKEN,
        POCKETAGENT_LIVE_STT_MODEL: 'whisper-large-v3-turbo-q8_0',
        POCKETAGENT_LIVE_STT_TTS_MODEL: 'kokoro-82m-v1',
      }),
    );
    expect(config.liveSttModel).toBe('whisper-large-v3-turbo-q8_0');
    expect(config.liveSttTtsModel).toBe('kokoro-82m-v1');
  });

  it('leaves liveSttModel and liveSttTtsModel null when env vars are unset or blank (PA-81)', () => {
    const config = loadConfig(
      env({
        POCKETAGENT_AUTH_TOKEN: TEST_TOKEN,
        POCKETAGENT_LIVE_STT_MODEL: '   ',
      }),
    );
    expect(config.liveSttModel).toBeNull();
    expect(config.liveSttTtsModel).toBeNull();
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

  describe('POCKETAGENT_DATA_DIR (PA-62)', () => {
    it('unset reproduces the pre-PA-62 paths exactly', () => {
      const config = loadConfig(env({ POCKETAGENT_AUTH_TOKEN: TEST_TOKEN }));
      expect(config.dataDir).toBe(path.join(REPO_ROOT, 'data'));
      // The literal this replaced, spelled out rather than derived from
      // `dataDir`, so a change to either side of the join fails here.
      expect(config.databasePath).toBe(path.join(REPO_ROOT, 'data', 'pocketagent.db'));
    });

    it('set, it relocates the database and both planner roots together', () => {
      const ws = makeWorkspace();
      const target = path.join(ws.root, 'state');
      try {
        const config = loadConfig(
          env({ POCKETAGENT_AUTH_TOKEN: TEST_TOKEN, POCKETAGENT_DATA_DIR: target }),
        );
        expect(config.dataDir).toBe(target);
        expect(config.databasePath).toBe(path.join(target, 'pocketagent.db'));
        // The whole point of one root rather than one database path: the
        // planner's scratch and skills directories are mutable app-owned state
        // and have to land on the same mounted volume.
        expect(resolvePlannerSkillsRoot(config.dataDir)).toBe(path.join(target, 'planner-skills'));
      } finally {
        ws.cleanup();
      }
    });

    it('accepts a root that does not exist yet — first boot creates it', () => {
      const ws = makeWorkspace();
      const target = path.join(ws.root, 'not', 'there', 'yet');
      try {
        const config = loadConfig(
          env({ POCKETAGENT_AUTH_TOKEN: TEST_TOKEN, POCKETAGENT_DATA_DIR: target }),
        );
        expect(config.dataDir).toBe(target);
      } finally {
        ws.cleanup();
      }
    });

    it('resolves symlinks in an existing ancestor before testing containment', () => {
      const ws = makeWorkspace();
      const link = path.join(path.dirname(ws.root), `link-${path.basename(ws.root)}`);
      fs.symlinkSync(ws.root, link);
      try {
        const config = loadConfig(
          env({
            POCKETAGENT_AUTH_TOKEN: TEST_TOKEN,
            POCKETAGENT_DATA_DIR: path.join(link, 'state'),
          }),
        );
        // Collapsed to the real path, so a symlinked data root cannot sneak
        // past the workspace-root refusal below.
        expect(config.dataDir).toBe(path.join(ws.root, 'state'));
      } finally {
        fs.unlinkSync(link);
        ws.cleanup();
      }
    });

    it('expands a leading ~', () => {
      const config = loadConfig(
        env({ POCKETAGENT_AUTH_TOKEN: TEST_TOKEN, POCKETAGENT_DATA_DIR: '~/pa-state' }),
      );
      expect(config.dataDir).toBe(path.join(fs.realpathSync(os.homedir()), 'pa-state'));
    });

    it('refuses a data root inside a workspace root', () => {
      // An agent working in that tree can rewrite or delete the database, which
      // holds webhook signing secrets and encrypted provider keys.
      const ws = makeWorkspace();
      try {
        expect(() =>
          loadConfig(
            env({
              POCKETAGENT_AUTH_TOKEN: TEST_TOKEN,
              POCKETAGENT_WORKSPACE_ROOTS: ws.root,
              POCKETAGENT_DATA_DIR: path.join(ws.project, 'state'),
            }),
          ),
        ).toThrow(/is inside the workspace root/);
      } finally {
        ws.cleanup();
      }
    });

    it('refuses a data root that is exactly a workspace root', () => {
      const ws = makeWorkspace();
      try {
        expect(() =>
          loadConfig(
            env({
              POCKETAGENT_AUTH_TOKEN: TEST_TOKEN,
              POCKETAGENT_WORKSPACE_ROOTS: ws.root,
              POCKETAGENT_DATA_DIR: ws.root,
            }),
          ),
        ).toThrow(/is inside the workspace root/);
      } finally {
        ws.cleanup();
      }
    });

    it('allows a workspace root inside the data root', () => {
      // The reverse direction is a plausible container layout — one volume
      // holding both the repos and the state — and the hazard does not run
      // that way.
      const ws = makeWorkspace();
      try {
        const config = loadConfig(
          env({
            POCKETAGENT_AUTH_TOKEN: TEST_TOKEN,
            POCKETAGENT_WORKSPACE_ROOTS: ws.project,
            POCKETAGENT_DATA_DIR: ws.root,
          }),
        );
        expect(config.dataDir).toBe(ws.root);
      } finally {
        ws.cleanup();
      }
    });

    it('never applies the refusal to the default, even when the checkout is inside a root', () => {
      // A dev checkout very often sits inside a project folder, so applying the
      // containment rule to the unset default would fail the boot of installs
      // that have worked for months. This is the regression that would make
      // PA-62 a breaking change rather than an additive one.
      const config = loadConfig(
        env({
          POCKETAGENT_AUTH_TOKEN: TEST_TOKEN,
          POCKETAGENT_WORKSPACE_ROOTS: path.dirname(REPO_ROOT),
          POCKETAGENT_DATA_DIR: undefined,
        }),
      );
      expect(config.dataDir).toBe(path.join(REPO_ROOT, 'data'));
    });

    it('treats an empty value as unset rather than as the process cwd', () => {
      const config = loadConfig(
        env({ POCKETAGENT_AUTH_TOKEN: TEST_TOKEN, POCKETAGENT_DATA_DIR: '   ' }),
      );
      expect(config.dataDir).toBe(path.join(REPO_ROOT, 'data'));
    });

    it('refuses "/" as the data root', () => {
      expect(() =>
        loadConfig(env({ POCKETAGENT_AUTH_TOKEN: TEST_TOKEN, POCKETAGENT_DATA_DIR: '/' })),
      ).toThrow(/refuses to use "\/"/);
    });
  });
});
