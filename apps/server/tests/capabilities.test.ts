import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CAPABILITIES_VERSION,
  HostCapabilities,
  NOTABLE_EXECUTABLES,
} from '@pocketagent/protocol';
import { recordAgentAuthProbe } from '../src/db/index.js';
import { buildHostCapabilities, readGitOriginUrl } from '../src/routes/capabilities.js';
import { authHeaders, createTestApp, TEST_TOKEN, type TestApp } from './helpers.js';

describe('PA-133: Host capability cards', () => {
  let t: TestApp | null = null;
  let tempDir: string | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-133-caps-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (t) {
      await t.cleanup();
      t = null;
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('requires authentication on GET /api/capabilities', async () => {
    t = await createTestApp();
    const unauth = await t.app.inject({ method: 'GET', url: '/api/capabilities' });
    expect(unauth.statusCode).toBe(401);

    const authed = await t.app.inject({
      method: 'GET',
      url: '/api/capabilities',
      headers: authHeaders(t.cookie),
    });
    expect(authed.statusCode).toBe(200);
    expect(HostCapabilities.safeParse(authed.json()).success).toBe(true);
  });

  it('returns the exact same HostCapabilities shape from GET /api/capabilities and the get_capabilities MCP tool', async () => {
    t = await createTestApp();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (t.app.server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: authHeaders(t.cookie),
      payload: {
        hostDescription: 'Build box with iOS distribution certs',
        hostTags: ['ios-signing', 'macos-arm64'],
      },
    });

    const httpRes = await t.app.inject({
      method: 'GET',
      url: '/api/capabilities',
      headers: authHeaders(t.cookie),
    });
    expect(httpRes.statusCode).toBe(200);
    const httpCard = HostCapabilities.parse(httpRes.json());

    const mintRes = await t.app.inject({
      method: 'POST',
      url: '/api/mcp/tokens',
      headers: authHeaders(t.cookie),
      payload: { label: 'cap-reader', scopes: ['read'] },
    });
    expect(mintRes.statusCode).toBe(201);
    const { token } = mintRes.json() as { token: string };

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    try {
      const mcpRes = await client.callTool({ name: 'get_capabilities', arguments: {} });
      expect(mcpRes.isError).toBeFalsy();
      const content = (mcpRes.content as { type: string; text: string }[])[0]!;
      const mcpCard = HostCapabilities.parse(JSON.parse(content.text));
      expect(mcpCard).toEqual(httpCard);
      expect(mcpCard.capabilitiesVersion).toBe(CAPABILITIES_VERSION);
      expect(mcpCard.description).toBe('Build box with iOS distribution certs');
      expect(mcpCard.tags).toEqual(['ios-signing', 'macos-arm64']);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it('reports xcodebuild on a darwin host when installed, and never reports xcodebuild on a Linux host', async () => {
    t = await createTestApp();
    const binDir = path.join(tempDir!, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    for (const exe of ['xcodebuild', 'xcrun', 'swift', 'git', 'node', 'docker']) {
      const file = path.join(binDir, exe);
      fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }

    const darwinCard = await buildHostCapabilities(t.context, {
      platform: 'darwin',
      arch: 'arm64',
      osVersion: '24.1.0',
      searchDirs: [binDir],
    });
    expect(darwinCard.platform).toBe('darwin');
    expect(darwinCard.arch).toBe('arm64');
    expect(darwinCard.osVersion).toBe('24.1.0');
    expect(darwinCard.executables).toContain('xcodebuild');
    expect(darwinCard.executables).toContain('xcrun');
    expect(darwinCard.executables).toContain('swift');
    expect(darwinCard.executables).toContain('git');

    const linuxCard = await buildHostCapabilities(t.context, {
      platform: 'linux',
      arch: 'x64',
      osVersion: '6.8.0',
      searchDirs: [binDir],
    });
    expect(linuxCard.platform).toBe('linux');
    expect(linuxCard.executables).not.toContain('xcodebuild');
    expect(linuxCard.executables).not.toContain('xcrun');
    expect(linuxCard.executables).toContain('swift');
    expect(linuxCard.executables).toContain('git');
    expect(linuxCard.executables).toContain('node');
    expect(linuxCard.executables).toContain('docker');
  });

  it('spawns zero subprocesses when serving GET /api/capabilities', async () => {
    const repoDir = path.join(tempDir!, 'sample-repo');
    fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, '.git', 'config'),
      '[remote "origin"]\n\turl = git@github.com:acme/sample-repo.git\n',
    );
    t = await createTestApp({ POCKETAGENT_WORKSPACE_ROOTS: repoDir });

    const spawnSpy = vi.spyOn(childProcess, 'spawn');
    const spawnSyncSpy = vi.spyOn(childProcess, 'spawnSync');
    const execSpy = vi.spyOn(childProcess, 'exec');
    const execFileSpy = vi.spyOn(childProcess, 'execFile');
    const execSyncSpy = vi.spyOn(childProcess, 'execSync');
    const execFileSyncSpy = vi.spyOn(childProcess, 'execFileSync');

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/capabilities',
      headers: authHeaders(t.cookie),
    });
    expect(res.statusCode).toBe(200);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(spawnSyncSpy).not.toHaveBeenCalled();
    expect(execSpy).not.toHaveBeenCalled();
    expect(execFileSpy).not.toHaveBeenCalled();
    expect(execSyncSpy).not.toHaveBeenCalled();
    expect(execFileSyncSpy).not.toHaveBeenCalled();
  });

  it('reuses deriveSetupState and cached last_auth_* columns without probing', async () => {
    t = await createTestApp();
    recordAgentAuthProbe(t.db, 'claude', {
      state: 'signed-out',
      detail: 'Run claude login',
    });

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/capabilities',
      headers: authHeaders(t.cookie),
    });
    expect(res.statusCode).toBe(200);
    const card = HostCapabilities.parse(res.json());
    expect(card.agents.some((a) => a.id === 'shell')).toBe(false);
    const claude = card.agents.find((a) => a.id === 'claude')!;
    expect(claude).toBeDefined();
    if (claude.available) {
      expect(claude.setupState).toBe('signed-out');
      expect(claude.setupDetail).toBe('Run claude login');
    } else {
      expect(claude.setupState).toBe('not-installed');
    }
  });

  it('reports projects with git origin URLs (including worktrees) and strips embedded credentials', async () => {
    const mainRepo = path.join(tempDir!, 'main-repo');
    const worktreeRepo = path.join(tempDir!, 'wt-repo');
    const plainDir = path.join(tempDir!, 'plain-dir');

    const commonGitDir = path.join(mainRepo, '.git');
    const wtGitDir = path.join(commonGitDir, 'worktrees', 'wt-1');
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.mkdirSync(worktreeRepo, { recursive: true });
    fs.mkdirSync(plainDir, { recursive: true });

    fs.writeFileSync(
      path.join(commonGitDir, 'config'),
      '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://user:ghp_secret_token@github.com/acme/main-repo.git\n',
    );
    fs.writeFileSync(path.join(worktreeRepo, '.git'), `gitdir: ${wtGitDir}\n`);
    fs.writeFileSync(path.join(wtGitDir, 'commondir'), '../..\n');

    expect(await readGitOriginUrl(mainRepo)).toBe('https://github.com/acme/main-repo.git');
    expect(await readGitOriginUrl(worktreeRepo)).toBe('https://github.com/acme/main-repo.git');
    expect(await readGitOriginUrl(plainDir)).toBeNull();

    t = await createTestApp({
      POCKETAGENT_WORKSPACE_ROOTS: [mainRepo, worktreeRepo, plainDir].join(','),
    });
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/capabilities',
      headers: authHeaders(t.cookie),
    });
    expect(res.statusCode).toBe(200);
    const card = HostCapabilities.parse(res.json());
    expect(JSON.stringify(card)).not.toContain('ghp_secret_token');
    const byPath = Object.fromEntries(card.projects.map((p) => [p.path, p]));
    expect(byPath[fs.realpathSync(mainRepo)]?.gitRemoteUrl).toBe(
      'https://github.com/acme/main-repo.git',
    );
    expect(byPath[fs.realpathSync(worktreeRepo)]?.gitRemoteUrl).toBe(
      'https://github.com/acme/main-repo.git',
    );
    expect(byPath[fs.realpathSync(plainDir)]?.gitRemoteUrl).toBeNull();
  });

  it('reports Pocket Agents with identityPrompt, effective enabledTools, and skills', async () => {
    t = await createTestApp();
    const createWs = await t.app.inject({
      method: 'POST',
      url: '/api/planner/workspaces',
      headers: authHeaders(t.cookie),
      payload: {
        name: 'iOS Release Agent',
      },
    });
    expect(createWs.statusCode).toBe(201);
    const wsId = (createWs.json() as { id: string }).id;

    const patchWs = await t.app.inject({
      method: 'PATCH',
      url: `/api/planner/workspaces/${wsId}`,
      headers: authHeaders(t.cookie),
      payload: {
        identityPrompt: 'Handles Xcode archiving and TestFlight uploads on macOS.',
      },
    });
    expect(patchWs.statusCode).toBe(200);

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/capabilities',
      headers: authHeaders(t.cookie),
    });
    expect(res.statusCode).toBe(200);
    const card = HostCapabilities.parse(res.json());
    const found = card.pocketAgents.find((p) => p.id === wsId);
    expect(found).toBeDefined();
    expect(found?.name).toBe('iOS Release Agent');
    expect(found?.identityPrompt).toBe(
      'Handles Xcode archiving and TestFlight uploads on macOS.',
    );
    expect(found?.enabledTools.length).toBeGreaterThan(0);
    expect(Array.isArray(found?.skills)).toBe(true);
  });

  it('validates, persists, and audits hostDescription and hostTags via PATCH /api/settings', async () => {
    const logLines: string[] = [];
    const loggerStream = new Writable({
      write(chunk, _enc, cb) {
        logLines.push(String(chunk));
        cb();
      },
    });
    t = await createTestApp(
      { LOG_LEVEL: 'info' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      loggerStream,
    );

    const invalidPatch = await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: authHeaders(t.cookie),
      payload: { hostTags: ['Not Valid Tag!'] },
    });
    expect(invalidPatch.statusCode).toBe(400);

    const validPatch = await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: authHeaders(t.cookie),
      payload: {
        hostDescription: 'Has the photo archive and signing keys',
        hostTags: ['photo-archive', 'ios-signing'],
      },
    });
    expect(validPatch.statusCode).toBe(200);
    expect(validPatch.json().settings.hostDescription).toBe(
      'Has the photo archive and signing keys',
    );
    expect(validPatch.json().settings.hostTags).toEqual(['photo-archive', 'ios-signing']);

    const auditEntries = logLines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is Record<string, unknown> => entry?.msg === 'settings updated');
    expect(
      auditEntries.some(
        (entry) =>
          entry.by === 'session' &&
          entry.hostDescription === 'Has the photo archive and signing keys' &&
          Array.isArray(entry.hostTags) &&
          entry.hostTags.includes('photo-archive'),
      ),
    ).toBe(true);

    const capsRes = await t.app.inject({
      method: 'GET',
      url: '/api/capabilities',
      headers: authHeaders(t.cookie),
    });
    const card = HostCapabilities.parse(capsRes.json());
    expect(card.description).toBe('Has the photo archive and signing keys');
    expect(card.tags).toEqual(['photo-archive', 'ios-signing']);
    expect(JSON.stringify(card)).not.toContain(TEST_TOKEN);
    for (const exe of card.executables) {
      expect(NOTABLE_EXECUTABLES).toContain(exe);
    }
  });
});
