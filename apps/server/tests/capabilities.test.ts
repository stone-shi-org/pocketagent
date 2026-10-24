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
  MDNS_TXT_KEYS,
  NOTABLE_EXECUTABLES,
} from '@pocketagent/protocol';
import {
  buildHostHardware,
  NVIDIA_SMI_ARGS,
  NVIDIA_SMI_BIN,
  parseNvidiaSmiCsv,
  probeNvidiaSmi,
  refreshHardwareProbe,
} from '../src/capabilities/hardware.js';
import { recordAgentAuthProbe } from '../src/db/index.js';
import { advertisedTxt } from '../src/discovery/mdns.js';
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

  it('reports hasWorkspaceIndex boolean on HostCapabilities without exposing workspace names, paths, or contents (PA-144)', async () => {
    t = await createTestApp();

    // Initially no document workspaces exist -> hasWorkspaceIndex is false
    const initialRes = await t.app.inject({
      method: 'GET',
      url: '/api/capabilities',
      headers: authHeaders(t.cookie),
    });
    expect(initialRes.statusCode).toBe(200);
    const initialCard = HostCapabilities.parse(initialRes.json());
    expect(initialCard.hasWorkspaceIndex).toBe(false);

    // Create a workspace with indexMode: 'off' -> still false
    const secretWsDir = path.join(tempDir!, 'confidential-mna-deal-room');
    fs.mkdirSync(secretWsDir, { recursive: true });
    fs.writeFileSync(path.join(secretWsDir, 'secret-term-sheet.md'), 'Project Aurora acquisition price $450M');

    const ws = t.context.docWorkspaces.create({
      name: 'Confidential M&A Deal Room',
      path: secretWsDir,
      indexMode: 'off',
    });

    const offRes = await t.app.inject({
      method: 'GET',
      url: '/api/capabilities',
      headers: authHeaders(t.cookie),
    });
    const offCard = HostCapabilities.parse(offRes.json());
    expect(offCard.hasWorkspaceIndex).toBe(false);

    // Enable keyword index -> hasWorkspaceIndex becomes true, and card never leaks workspace name, path, or contents
    t.context.docWorkspaces.update(ws.id, { indexMode: 'keyword' });
    const onRes = await t.app.inject({
      method: 'GET',
      url: '/api/capabilities',
      headers: authHeaders(t.cookie),
    });
    const onCard = HostCapabilities.parse(onRes.json());
    expect(onCard.hasWorkspaceIndex).toBe(true);
    const serialized = JSON.stringify(onCard);
    expect(serialized).not.toContain('Confidential M&A Deal Room');
    expect(serialized).not.toContain('confidential-mna-deal-room');
    expect(serialized).not.toContain('secret-term-sheet');
    expect(serialized).not.toContain('Project Aurora');
  });

  it('detects Linux cgroup v2 and v1 CPU/RAM limits and containerization (PA-174)', () => {
    const cgV2 = path.join(tempDir!, 'cgroup-v2');
    fs.mkdirSync(cgV2, { recursive: true });
    fs.writeFileSync(path.join(cgV2, 'cpu.max'), '400000 100000\n');
    fs.writeFileSync(path.join(cgV2, 'memory.max'), String(8 * 1024 ** 3) + '\n');
    const dockerEnv = path.join(tempDir!, '.dockerenv');
    fs.writeFileSync(dockerEnv, '');

    const hwV2 = buildHostHardware({
      platform: 'linux',
      arch: 'x64',
      cpuModel: 'AMD EPYC 7763 64-Core Processor',
      cpuThreads: 16,
      totalMemoryBytes: 128 * 1024 ** 3,
      cgroupDir: cgV2,
      dockerEnvPath: dockerEnv,
    });
    expect(hwV2.cpu).toEqual({
      model: 'AMD EPYC 7763 64-Core Processor',
      threads: 16,
      limitThreads: 4,
    });
    expect(hwV2.memory).toEqual({
      totalBytes: 128 * 1024 ** 3,
      limitBytes: 8 * 1024 ** 3,
    });
    expect(hwV2.memory.limitBytes).toBeLessThan(hwV2.memory.totalBytes);
    expect(hwV2.gpus).toEqual([]);
    expect(hwV2.containerized).toBe(true);

    // Unlimited cgroup v2 (`max`) and no container markers
    const cgV2Max = path.join(tempDir!, 'cgroup-v2-max');
    fs.mkdirSync(cgV2Max, { recursive: true });
    fs.writeFileSync(path.join(cgV2Max, 'cpu.max'), 'max 100000\n');
    fs.writeFileSync(path.join(cgV2Max, 'memory.max'), 'max\n');

    const hwUnlimited = buildHostHardware({
      platform: 'linux',
      arch: 'x64',
      cpuModel: 'Intel(R) Xeon(R) Gold 6338',
      cpuThreads: 32,
      totalMemoryBytes: 64 * 1024 ** 3,
      cgroupDir: cgV2Max,
    });
    expect(hwUnlimited.cpu.limitThreads).toBeNull();
    expect(hwUnlimited.memory.limitBytes).toBeNull();
    expect(hwUnlimited.containerized).toBe(false);

    // Cgroup v1 fallback: numeric quota + absurdly large kernel unlimited memory sentinel
    const cgV1 = path.join(tempDir!, 'cgroup-v1');
    fs.mkdirSync(path.join(cgV1, 'cpu'), { recursive: true });
    fs.mkdirSync(path.join(cgV1, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(cgV1, 'cpu', 'cpu.cfs_quota_us'), '250000\n');
    fs.writeFileSync(path.join(cgV1, 'cpu', 'cpu.cfs_period_us'), '100000\n');
    fs.writeFileSync(path.join(cgV1, 'memory', 'memory.limit_in_bytes'), '9223372036854771712\n');
    const procCgroup = path.join(tempDir!, 'proc-self-cgroup');
    fs.writeFileSync(procCgroup, '12:memory:/docker/0123456789abcdef\n11:cpu,cpuacct:/docker/0123456789abcdef\n');

    const hwV1 = buildHostHardware({
      platform: 'linux',
      arch: 'x64',
      cpuModel: 'Intel(R) Core(TM) i9-13900K',
      cpuThreads: 24,
      totalMemoryBytes: 64 * 1024 ** 3,
      cgroupDir: cgV1,
      procSelfCgroupPath: procCgroup,
      dockerEnvPath: path.join(tempDir!, 'no-dockerenv'),
      containerEnvPath: path.join(tempDir!, 'no-containerenv'),
    });
    expect(hwV1.cpu.limitThreads).toBe(2.5);
    expect(hwV1.memory.limitBytes).toBeNull();
    expect(hwV1.containerized).toBe(true);
  });

  it('detects NVIDIA GPUs from /proc/driver/nvidia/gpus/*/information gated by /dev/nvidia<minor> and merges cached nvidia-smi VRAM (PA-174)', () => {
    const procNvidia = path.join(tempDir!, 'proc-nvidia-gpus');
    const devDir = path.join(tempDir!, 'dev');
    const gpu0Dir = path.join(procNvidia, '0000:0a:00.0');
    const gpu1Dir = path.join(procNvidia, '0000:42:00.0');
    fs.mkdirSync(gpu0Dir, { recursive: true });
    fs.mkdirSync(gpu1Dir, { recursive: true });
    fs.mkdirSync(devDir, { recursive: true });

    fs.writeFileSync(
      path.join(gpu0Dir, 'information'),
      [
        'Model: \t\t NVIDIA GeForce RTX 4090',
        'IRQ:   \t\t 132',
        'GPU UUID: \t GPU-11111111-2222-3333-4444-555555555555',
        'Device Minor: \t 0',
        'GPU Excluded:\t No',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(gpu1Dir, 'information'),
      [
        'Model: \t\t NVIDIA RTX A6000',
        'IRQ:   \t\t 133',
        'GPU UUID: \t GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        'Device Minor: \t 1',
        'GPU Excluded:\t No',
      ].join('\n') + '\n',
    );

    // Only /dev/nvidia0 is exposed into the container -> minor 1 must NOT be advertised.
    fs.writeFileSync(path.join(devDir, 'nvidia0'), '');

    const withSmi = buildHostHardware({
      platform: 'linux',
      arch: 'x64',
      procNvidiaGpusDir: procNvidia,
      devDir,
      cachedNvidiaSmi: [{ model: 'NVIDIA GeForce RTX 4090', vramBytes: 24564 * 1024 * 1024 }],
    });
    expect(withSmi.gpus).toEqual([
      {
        vendor: 'nvidia',
        model: 'NVIDIA GeForce RTX 4090',
        vramBytes: 24564 * 1024 * 1024,
        source: 'smi',
      },
    ]);

    // When nvidia-smi is missing or fails, falls back to source: 'proc' and vramBytes: null
    const withoutSmi = buildHostHardware({
      platform: 'linux',
      arch: 'x64',
      procNvidiaGpusDir: procNvidia,
      devDir,
      cachedNvidiaSmi: [],
    });
    expect(withoutSmi.gpus).toEqual([
      {
        vendor: 'nvidia',
        model: 'NVIDIA GeForce RTX 4090',
        vramBytes: null,
        source: 'proc',
      },
    ]);

    // When /dev/nvidia0 is also absent (container without --gpus), reports gpus: []
    const emptyDev = path.join(tempDir!, 'dev-empty');
    fs.mkdirSync(emptyDev, { recursive: true });
    const unexposed = buildHostHardware({
      platform: 'linux',
      arch: 'x64',
      procNvidiaGpusDir: procNvidia,
      devDir: emptyDev,
      cachedNvidiaSmi: [{ model: 'NVIDIA GeForce RTX 4090', vramBytes: 24564 * 1024 * 1024 }],
    });
    expect(unexposed.gpus).toEqual([]);
  });

  it('detects AMD and Intel GPUs from /sys/class/drm/card*/device with PCI-id table lookup and raw-id fallback (PA-174)', () => {
    const drmDir = path.join(tempDir!, 'sys-drm');
    const card0Dev = path.join(drmDir, 'card0', 'device');
    const card1Dev = path.join(drmDir, 'card1', 'device');
    const card2Dev = path.join(drmDir, 'card2', 'device');
    const card3Dev = path.join(drmDir, 'card3', 'device');
    const connectorDev = path.join(drmDir, 'card0-DP-1', 'device');
    fs.mkdirSync(card0Dev, { recursive: true });
    fs.mkdirSync(card1Dev, { recursive: true });
    fs.mkdirSync(card2Dev, { recursive: true });
    fs.mkdirSync(card3Dev, { recursive: true });
    fs.mkdirSync(connectorDev, { recursive: true });

    // card0: known AMD GPU with VRAM in bytes
    fs.writeFileSync(path.join(card0Dev, 'vendor'), '0x1002\n');
    fs.writeFileSync(path.join(card0Dev, 'device'), '0x744c\n');
    fs.writeFileSync(path.join(card0Dev, 'mem_info_vram_total'), '25753026560\n');

    // card1: known Intel GPU without mem_info_vram_total
    fs.writeFileSync(path.join(card1Dev, 'vendor'), '0x8086\n');
    fs.writeFileSync(path.join(card1Dev, 'device'), '0x56a0\n');

    // card2: unknown AMD PCI ID -> falls back to normalized hex ID
    fs.writeFileSync(path.join(card2Dev, 'vendor'), '0x1002\n');
    fs.writeFileSync(path.join(card2Dev, 'device'), '0x9999\n');

    // card3: NVIDIA (0x10de) in sysfs -> ignored so unexposed container GPUs never leak via sysfs
    fs.writeFileSync(path.join(card3Dev, 'vendor'), '0x10de\n');
    fs.writeFileSync(path.join(card3Dev, 'device'), '0x1cb1\n');

    // card0-DP-1: connector -> ignored
    fs.writeFileSync(path.join(connectorDev, 'vendor'), '0x1002\n');
    fs.writeFileSync(path.join(connectorDev, 'device'), '0x744c\n');

    const hw = buildHostHardware({
      platform: 'linux',
      arch: 'x64',
      sysDrmDir: drmDir,
    });
    expect(hw.gpus).toEqual([
      {
        vendor: 'amd',
        model: 'Radeon RX 7900 XTX',
        vramBytes: 25753026560,
        source: 'sysfs',
      },
      {
        vendor: 'intel',
        model: 'Arc A770',
        vramBytes: null,
        source: 'sysfs',
      },
      {
        vendor: 'amd',
        model: '0x9999',
        vramBytes: null,
        source: 'sysfs',
      },
    ]);
  });

  it('detects macOS chip name, unified memory, and a single apple GPU entry with vramBytes: null (PA-174)', async () => {
    t = await createTestApp();
    const card = await buildHostCapabilities(t.context, {
      platform: 'darwin',
      arch: 'arm64',
      osVersion: '24.2.0',
      hardware: {
        cpuModel: 'Apple M3 Max',
        cpuThreads: 16,
        totalMemoryBytes: 64 * 1024 ** 3,
      },
    });
    expect(card.hardware).toEqual({
      cpu: {
        model: 'Apple M3 Max',
        threads: 16,
        limitThreads: null,
      },
      memory: {
        totalBytes: 64 * 1024 ** 3,
        limitBytes: null,
      },
      gpus: [
        {
          vendor: 'apple',
          model: 'Apple M3 Max',
          vramBytes: null,
          source: 'sysfs',
        },
      ],
      containerized: false,
    });
  });

  it('probes nvidia-smi with fixed argv on Refresh and never exposes hardware in /health or mDNS TXT (PA-174)', async () => {
    expect(parseNvidiaSmiCsv('Quadro P1000, 4096\nNVIDIA L40S, 46068\n')).toEqual([
      { model: 'Quadro P1000', vramBytes: 4096 * 1024 * 1024 },
      { model: 'NVIDIA L40S', vramBytes: 46068 * 1024 * 1024 },
    ]);

    // Missing executable -> []
    expect(await probeNvidiaSmi({ executablePath: null })).toEqual([]);

    // Fake nvidia-smi script verifying fixed argv
    const binDir = path.join(tempDir!, 'smi-bin');
    fs.mkdirSync(binDir, { recursive: true });
    const fakeSmi = path.join(binDir, NVIDIA_SMI_BIN);
    const argsFile = path.join(tempDir!, 'smi-args.txt');
    fs.writeFileSync(
      fakeSmi,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\necho "NVIDIA A100-SXM4-80GB, 81920"\n`,
      { mode: 0o755 },
    );

    const probed = await refreshHardwareProbe({ executablePath: fakeSmi });
    expect(probed).toEqual([{ model: 'NVIDIA A100-SXM4-80GB', vramBytes: 81920 * 1024 * 1024 }]);
    const recordedArgs = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
    expect(recordedArgs).toEqual([...NVIDIA_SMI_ARGS]);

    t = await createTestApp();
    const healthRes = await t.app.inject({ method: 'GET', url: '/health' });
    expect(healthRes.statusCode).toBe(200);
    expect(Object.keys(healthRes.json()).sort()).toEqual([
      'protocol',
      'status',
      'uptimeSeconds',
      'version',
    ]);
    expect(healthRes.json().hardware).toBeUndefined();

    const txt = advertisedTxt('1.5.0');
    expect(Object.keys(txt).sort()).toEqual(Object.values(MDNS_TXT_KEYS).sort());
    expect(JSON.stringify(txt)).not.toContain('hardware');
    expect(JSON.stringify(txt)).not.toContain('gpus');
  });
});

