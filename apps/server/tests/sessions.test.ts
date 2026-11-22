import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestApp, makeConfig, makeWorkspace, TEST_TOKEN, waitFor, sleep, type TestApp } from './helpers.js';
import { buildApp } from '../src/app.js';
import { openDatabase, readAgentDefaults, writeAgentDefaults } from '../src/db/index.js';
import { buildChildEnv } from '../src/sessions/env.js';
import { createClaudeAdapter } from '../src/agents/claude.js';
import { createShellAdapter } from '../src/agents/shell.js';
import { createAgyAdapter } from '../src/agents/agy.js';
import { createOpencodeAdapter } from '../src/agents/opencode.js';
import { createCodexAdapter } from '../src/agents/codex.js';
import { createPiAdapter } from '../src/agents/pi.js';
import { StructuredSession } from '../src/sessions/structured-session.js';
import { clampTitle, CreateSessionRequest, isAutoApprovingAgentMode, MAX_SESSION_TITLE_CHARS } from '@pocketagent/protocol';
import { RunExecutor } from '../src/runs/executor.js';
import { MCP_TOOLS } from '../src/mcp-server/tools.js';
import { AgySession } from '../src/sessions/agy-session.js';
import { titleOf } from '../src/webhooks/index.js';
import { formatCronRunTitle } from '../src/cron/index.js';
import { AgyTranscriptStore } from '../src/conversations/agy.js';
import { CodexTranscriptStore } from '../src/conversations/codex.js';
import Database from 'better-sqlite3';

const AGY_FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/fake-agy.mjs',
);
const OPENCODE_FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/fake-opencode-server.mjs',
);
const CODEX_FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/fake-codex-app-server.mjs',
);
const PI_FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/fake-pi-rpc.mjs',
);

function headers(t: TestApp): Record<string, string> {
  return { cookie: t.cookie };
}

async function createShellSession(t: TestApp, overrides: object = {}): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: headers(t),
    payload: { agent: 'shell', cwd: t.projectDir, cols: 80, rows: 24, ...overrides },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

/** Wait until the PTY buffer contains `needle`. */
async function waitForOutput(t: TestApp, id: string, needle: string): Promise<string> {
  const session = t.context.sessions.getOrThrow(id);
  await waitFor(() => session.buffer.replayAfter(0).data.includes(needle));
  return session.buffer.replayAfter(0).data;
}

describe('environment sanitization', () => {
  it('strips the PocketAgent namespace so the master token cannot leak', () => {
    const env = buildChildEnv({
      cwd: '/tmp',
      base: {
        PATH: '/usr/bin',
        POCKETAGENT_AUTH_TOKEN: 'super-secret',
        POCKETAGENT_WORKSPACE_ROOTS: '/home/me',
        HOME: '/home/me',
      },
    });
    expect(env.POCKETAGENT_AUTH_TOKEN).toBeUndefined();
    expect(env.POCKETAGENT_WORKSPACE_ROOTS).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/me');
  });

  it('sets terminal variables an interactive CLI expects', () => {
    const env = buildChildEnv({ cwd: '/tmp/work', base: { PATH: '/usr/bin' } });
    expect(env.TERM).toBe('xterm-256color');
    expect(env.COLORTERM).toBe('truecolor');
    expect(env.PWD).toBe('/tmp/work');
  });
});

describe('skip-permissions opt-in, off by default', () => {
  const opts = { cwd: '/tmp', cols: 80, rows: 24 };

  it('never adds the flag unless the caller explicitly asks', () => {
    const adapter = createClaudeAdapter('claude');
    expect(adapter.buildCommand(opts).args).toEqual([]);
    expect(adapter.buildCommand({ ...opts, skipPermissions: false }).args).toEqual([]);
  });

  it('adds --dangerously-skip-permissions only when explicitly opted in', () => {
    const adapter = createClaudeAdapter('claude');
    expect(adapter.buildCommand({ ...opts, skipPermissions: true }).args).toEqual([
      '--dangerously-skip-permissions',
    ]);
  });

  it('a shell has no such flag to add, opted in or not', () => {
    const adapter = createShellAdapter('/bin/bash');
    expect(adapter.buildCommand({ ...opts, skipPermissions: true }).args).toEqual(['-i']);
  });

  it('agy supports the real skipPermissions toggle over ACP — it is no longer forced', () => {
    const adapter = createAgyAdapter('agy');
    expect(adapter.supportsSkipPermissions).toBe(true);
    expect(adapter.forcesSkipPermissions).toBeUndefined();
    expect(createClaudeAdapter('claude').forcesSkipPermissions).toBeUndefined();
    expect(createShellAdapter('/bin/bash').forcesSkipPermissions).toBeUndefined();
  });

  it('opencode supports the real toggle — it has a genuine approval gate', () => {
    const adapter = createOpencodeAdapter('opencode');
    expect(adapter.supportsSkipPermissions).toBe(true);
    expect(adapter.forcesSkipPermissions).toBeUndefined();
  });

  it('codex also supports the real toggle — app-server has a genuine approval gate too', () => {
    const adapter = createCodexAdapter('codex');
    expect(adapter.supportsSkipPermissions).toBe(true);
    expect(adapter.forcesSkipPermissions).toBeUndefined();
  });

  it('pi forces skipPermissions — no approval concept exists anywhere', () => {
    const adapter = createPiAdapter('pi');
    expect(adapter.forcesSkipPermissions).toBe(true);
  });
});

describe('session HTTP routes', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(() => t.cleanup());

  it('lists the built-in agents without exposing any command line', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/agents', headers: headers(t) });
    const ids = res.json().agents.map((a: { id: string }) => a.id);
    expect(ids).toContain('shell');
    expect(ids).toContain('claude');
    expect(res.body).not.toContain('/bin/bash');
  });

  it('reports supportsSkipPermissions only for the agent that actually has the flag', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/agents', headers: headers(t) });
    const agents = res.json().agents as { id: string; supportsSkipPermissions: boolean }[];
    expect(agents.find((a) => a.id === 'claude')?.supportsSkipPermissions).toBe(true);
    expect(agents.find((a) => a.id === 'shell')?.supportsSkipPermissions).toBe(false);
  });

  it('exposes installedVersion, latestVersion, and hasUpdate fields on every agent (PA-90)', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/agents', headers: headers(t) });
    const agents = res.json().agents as {
      id: string;
      installedVersion: string | null;
      latestVersion: string | null;
      hasUpdate: boolean;
    }[];
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      expect('installedVersion' in agent).toBe(true);
      expect('latestVersion' in agent).toBe(true);
      expect(typeof agent.hasUpdate).toBe('boolean');
    }
  });

  it('refreshes agents on POST /api/agents/refresh and returns updated list (PA-90)', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/agents/refresh', headers: headers(t) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { agents: { id: string; installedVersion: string | null; hasUpdate: boolean }[] };
    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.agents.length).toBeGreaterThan(0);
  });

  it('ignores skipPermissions for an agent that does not support it, rather than silently spawning it unsafely', async () => {
    // A shell has no approval concept and no `--dangerously-skip-permissions`
    // equivalent; the manager must not just pass the client's wish straight
    // through to a session that has no idea what to do with it.
    const id = await createShellSession(t, { skipPermissions: true });
    const info = t.context.sessions.find(id);
    expect(info?.skipPermissionsEnabled).toBe(false);
  });

  it('creates a running session', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'shell', cwd: t.projectDir, cols: 100, rows: 30 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('running');
    expect(body.agent).toBe('shell');
    expect(body.cwd).toBe(t.projectDir);
    expect(body.cols).toBe(100);
    expect(body.pid).toBeGreaterThan(0);
  });

  it('refuses a cwd outside the workspace roots', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'shell', cwd: '/etc' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });

  it('refuses a symlink escape from inside a root', async () => {
    const link = path.join(t.workspaceRoot, 'escape');
    fs.symlinkSync('/etc', link);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'shell', cwd: link },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses an unknown agent', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'rm-rf', cwd: t.projectDir },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unknown_agent');
  });

  it('offers no way to specify a command, argv, or env', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: {
        agent: 'shell',
        cwd: t.projectDir,
        command: '/usr/bin/curl',
        args: ['evil.example'],
        env: { LD_PRELOAD: '/tmp/evil.so' },
      },
    });
    expect(res.statusCode).toBe(201);

    const session = t.context.sessions.getOrThrow(res.json().id);
    expect(session.spec.command).toBe('/bin/bash');
    expect(session.spec.args).toEqual(['-i']);
    expect(session.spec.env.LD_PRELOAD).toBeUndefined();
  });

  it('rejects an out-of-range terminal size', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'shell', cwd: t.projectDir, cols: 100000, rows: 30 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('enforces the session limit', async () => {
    await t.cleanup();
    t = await createTestApp({ MAX_SESSIONS: '2' });

    await createShellSession(t);
    await createShellSession(t);

    const third = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'shell', cwd: t.projectDir },
    });
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('too_many_sessions');
  });

  it('returns 404 for an unknown session', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/sessions/does-not-exist',
      headers: headers(t),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('agy adapter: structured, forced skip-permissions', () => {
  let t: TestApp;

  let origHome: string | undefined;
  let fakeHome: string;

  beforeEach(async () => {
    // Isolate HOME so the test machine's own `~/.gemini/antigravity-cli/settings.json`
    // (which may set `toolPermission: "always-proceed"`) never leaks into these tests.
    origHome = process.env.HOME;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-agy-home-'));
    process.env.HOME = fakeHome;
    // Points the adapter at a fixture script instead of the real CLI: real
    // agy costs real inference and network access, which a test suite must
    // not depend on. See tests/fixtures/fake-agy.mjs.
    t = await createTestApp({ POCKETAGENT_AGY_BIN: AGY_FIXTURE });
  });
  afterEach(async () => {
    await t.cleanup();
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('reports supportsSkipPermissions and no longer forces skip-permissions for agy', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/agents', headers: headers(t) });
    const agents = res.json().agents as {
      id: string;
      supportsSkipPermissions: boolean;
      forcesSkipPermissions: boolean;
    }[];
    expect(agents.find((a) => a.id === 'agy')?.supportsSkipPermissions).toBe(true);
    expect(agents.find((a) => a.id === 'agy')?.forcesSkipPermissions).toBe(false);
    expect(agents.find((a) => a.id === 'claude')?.forcesSkipPermissions).toBe(false);
    expect(agents.find((a) => a.id === 'shell')?.forcesSkipPermissions).toBe(false);
  });

  it('is unavailable when the configured binary cannot be resolved', async () => {
    await t.cleanup();
    t = await createTestApp({ POCKETAGENT_AGY_BIN: '/no/such/agy-binary' });
    const res = await t.app.inject({ method: 'GET', url: '/api/agents', headers: headers(t) });
    const agents = res.json().agents as { id: string; available: boolean }[];
    expect(agents.find((a) => a.id === 'agy')?.available).toBe(false);
  });

  it('creates a structured session with approvals on by default, respects skipPermissions opt-in, and rejects terminal', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'agy', cwd: t.projectDir, cols: 80, rows: 24 },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.agent).toBe('agy');
    expect(body.transport).toBe('structured');
    expect(body.skipPermissionsEnabled).toBe(false);

    const bypassed = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'agy', cwd: t.projectDir, cols: 80, rows: 24, skipPermissions: true },
    });
    expect(bypassed.statusCode).toBe(201);
    expect(bypassed.json().skipPermissionsEnabled).toBe(true);

    const rejected = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'agy', cwd: t.projectDir, cols: 80, rows: 24, transport: 'terminal' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe('unsupported_transport');
  });

  it('runs a real turn through the manager over ACP', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'agy', cwd: t.projectDir, cols: 80, rows: 24 },
    });
    const id = created.json().id as string;

    const session = t.context.sessions.getOrThrow(id);
    if (session.transport !== 'structured') throw new Error('expected a structured session');
    session.prompt('hello');

    await waitFor(() =>
      session.buffer.replayAfter(0).events.some((e) => e.event.kind === 'turn_complete'),
    );
    const kinds = session.buffer.replayAfter(0).events.map((e) => e.event.kind);
    expect(kinds).toContain('session_started');
    expect(kinds).toContain('tool_use');
    expect(kinds).toContain('turn_complete');

    const info = t.context.sessions.find(id);
    expect(info?.skipPermissionsEnabled).toBe(false);
  });

  it('discloses bypass and warns without escalating argv when agy settings.json has toolPermission: "proceed-in-sandbox"', async () => {
    const settingsDir = path.join(fakeHome, '.gemini', 'antigravity-cli');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ toolPermission: 'proceed-in-sandbox' }),
    );
    const argvFile = path.join(fakeHome, 'argv.jsonl');
    process.env.AGY_FIXTURE_ARGV_FILE = argvFile;

    try {
      const created = await t.app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: headers(t),
        payload: { agent: 'agy', cwd: t.projectDir, cols: 80, rows: 24 },
      });
      expect(created.statusCode).toBe(201);
      const body = created.json();
      // Disclosed honestly as bypassed in both API response and SQLite row...
      expect(body.skipPermissionsEnabled).toBe(true);
      expect(body.providerDisclosure).toBeNull();
      expect(body.approvalDisclosure).toContain('auto-approves file edits');
      const row = t.db
        .prepare('SELECT skip_permissions FROM sessions WHERE id = ?')
        .get(body.id) as { skip_permissions: number };
      expect(row.skip_permissions).toBe(1);

      // ...WITHOUT adding `--dangerously-skip-permissions` to agy's argv!
      const spawnedArgs = JSON.parse(fs.readFileSync(argvFile, 'utf8').trim()) as string[];
      expect(spawnedArgs).not.toContain('--dangerously-skip-permissions');

      const session = t.context.sessions.getOrThrow(body.id as string);
      if (session.transport !== 'structured') throw new Error('expected structured session');
      const events = session.buffer.replayAfter(0).events.map((e) => e.event);
      expect(
        events.some(
          (e) =>
            e.kind === 'notice' &&
            e.level === 'warn' &&
            e.text.includes('settings.json') &&
            e.text.includes('proceed-in-sandbox'),
        ),
      ).toBe(true);
    } finally {
      delete process.env.AGY_FIXTURE_ARGV_FILE;
    }
  });

  it('keeps persisted skip_permissions sticky at 1 after respawning under request-review (PA-183)', async () => {
    const settingsDir = path.join(fakeHome, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(settingsDir, 'settings.json');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ toolPermission: 'always-proceed' }));

    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'agy', cwd: t.projectDir, cols: 80, rows: 24 },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect(created.json().skipPermissionsEnabled).toBe(true);

    const session = t.context.sessions.getOrThrow(id);
    if (session.transport !== 'structured') throw new Error('expected structured session');

    // Trigger a between-turn child exit, then tighten settings.json to request-review.
    session.prompt('CRASH_BETWEEN_TURNS');
    await waitFor(() =>
      session.buffer
        .replayAfter(0)
        .events.some((e) => e.event.kind === 'notice' && e.event.text.includes('stopped between turns')),
    );
    fs.writeFileSync(settingsPath, JSON.stringify({ toolPermission: 'request-review' }));

    // Next turn respawns agy acp and re-reads settings.json.
    session.prompt('after tighten');
    await waitFor(
      () =>
        session.buffer.replayAfter(0).events.filter((e) => e.event.kind === 'turn_complete').length === 2,
    );

    // Live badge follows current state (now supervised)...
    expect(t.context.sessions.toInfo(session).skipPermissionsEnabled).toBe(false);
    // ...but the persisted SQLite record and historical rowToInfo stay sticky at 1!
    t.context.sessions.persist(session);
    const row = t.db
      .prepare('SELECT skip_permissions FROM sessions WHERE id = ?')
      .get(id) as { skip_permissions: number };
    expect(row.skip_permissions).toBe(1);

    // Terminating and evicting from memory reads via rowToInfo, which must still report bypassed.
    session.terminate();
    await waitFor(() => !session.isAlive());
    (t.context.sessions as unknown as { live: Map<string, unknown> }).live.delete(id);
    const historyRes = await t.app.inject({
      method: 'GET',
      url: `/api/sessions/${id}`,
      headers: headers(t),
    });
    expect(historyRes.statusCode).toBe(200);
    expect(historyRes.json().skipPermissionsEnabled).toBe(true);
  });

  it('omits agy approvalDisclosure when host settings.json sets toolPermission: "strict" (PA-183)', async () => {
    const settingsDir = path.join(fakeHome, '.gemini', 'antigravity-cli');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ toolPermission: 'strict' }),
    );

    const agentsRes = await t.app.inject({ method: 'GET', url: '/api/agents', headers: headers(t) });
    const agyAgent = (agentsRes.json().agents as Array<{ id: string; providerDisclosure: string | null; approvalDisclosure?: string | null }>).find(
      (a) => a.id === 'agy',
    );
    expect(agyAgent?.providerDisclosure).toBeNull();
    expect(agyAgent?.approvalDisclosure).toBeNull();

    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'agy', cwd: t.projectDir, cols: 80, rows: 24 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().providerDisclosure).toBeNull();
    expect(created.json().approvalDisclosure).toBeNull();
  });

  it('surfaces in-flight background command titles on SessionInfo and drain-state blockers (PA-183)', async () => {
    const taskFile = path.join(fakeHome, 'bg-drain.done');
    process.env.AGY_FIXTURE_BACKGROUND_TASK_FILE = taskFile;
    try {
      const created = await t.app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: headers(t),
        payload: { agent: 'agy', cwd: t.projectDir, cols: 80, rows: 24 },
      });
      const id = created.json().id as string;
      const session = t.context.sessions.getOrThrow(id);
      if (session.transport !== 'structured') throw new Error('expected structured session');

      session.prompt('BACKGROUND_TASK');
      await waitFor(() =>
        session.buffer.replayAfter(0).events.some((e) => e.event.kind === 'turn_complete'),
      );

      const info = t.context.sessions.toInfo(session);
      expect(info.busy).toBe(true);
      expect(info.backgroundCommands).toEqual(['sleep 1 && echo bg']);

      const drain = await t.app.inject({
        method: 'GET',
        url: '/api/admin/drain-state',
        headers: headers(t),
      });
      const blocker = (drain.json().blockers as Array<{ id: string; detail?: string | null }>).find(
        (b) => b.id === id,
      );
      expect(blocker?.detail).toBe('Background command: sleep 1 && echo bg');

      await session.interrupt();
      expect(t.context.sessions.toInfo(session).busy).toBe(false);
      expect(t.context.sessions.toInfo(session).backgroundCommands).toBeUndefined();
    } finally {
      delete process.env.AGY_FIXTURE_BACKGROUND_TASK_FILE;
    }
  });
});

describe('opencode adapter: structured, real approval gate', () => {
  let t: TestApp;

  beforeEach(async () => {
    // Points the adapter at a fixture HTTP+SSE server instead of the real
    // CLI: real opencode needs a working model provider, which the sandbox
    // this was built in could not reliably reach. See
    // tests/fixtures/fake-opencode-server.mjs.
    t = await createTestApp({ POCKETAGENT_OPENCODE_BIN: OPENCODE_FIXTURE });
  });
  afterEach(() => t.cleanup());

  it('reports supportsSkipPermissions without forcesSkipPermissions', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/agents', headers: headers(t) });
    const agents = res.json().agents as {
      id: string;
      supportsSkipPermissions: boolean;
      forcesSkipPermissions: boolean;
    }[];
    const opencode = agents.find((a) => a.id === 'opencode');
    expect(opencode?.supportsSkipPermissions).toBe(true);
    expect(opencode?.forcesSkipPermissions).toBe(false);
  });

  it('creates a structured session that defaults to asking, unlike agy', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'opencode', cwd: t.projectDir, cols: 80, rows: 24 },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.agent).toBe('opencode');
    expect(body.transport).toBe('structured');
    expect(body.skipPermissionsEnabled).toBe(false);
  });

  it('runs a real turn through the manager and surfaces a genuine permission request', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'opencode', cwd: t.projectDir, cols: 80, rows: 24 },
    });
    const id = created.json().id as string;

    const session = t.context.sessions.getOrThrow(id);
    if (session.transport !== 'structured') throw new Error('expected a structured session');
    session.prompt('NEEDS_PERMISSION');

    await waitFor(() =>
      session.buffer.replayAfter(0).events.some((e) => e.event.kind === 'permission_request'),
    );
    const request = session
      .buffer.replayAfter(0)
      .events.map((e) => e.event)
      .find((e) => e.kind === 'permission_request');
    expect(request).toBeTruthy();

    expect(session.resolvePermission(request!.id, 'allow')).toBe(true);

    await waitFor(() =>
      session.buffer.replayAfter(0).events.some((e) => e.event.kind === 'turn_complete'),
    );
    const kinds = session.buffer.replayAfter(0).events.map((e) => e.event.kind);
    expect(kinds).toContain('tool_result');
  });

  it('creates a session that skips permissions when explicitly opted in', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: {
        agent: 'opencode',
        cwd: t.projectDir,
        cols: 80,
        rows: 24,
        skipPermissions: true,
      },
    });
    expect(created.json().skipPermissionsEnabled).toBe(true);

    const id = created.json().id as string;
    const session = t.context.sessions.getOrThrow(id);
    if (session.transport !== 'structured') throw new Error('expected a structured session');
    session.prompt('NEEDS_PERMISSION');

    await waitFor(() =>
      session.buffer.replayAfter(0).events.some((e) => e.event.kind === 'turn_complete'),
    );
    const kinds = session.buffer.replayAfter(0).events.map((e) => e.event.kind);
    expect(kinds).not.toContain('permission_request');
  });
});

describe('codex adapter: structured, real approval gate via app-server', () => {
  let t: TestApp;

  beforeEach(async () => {
    // Points the adapter at a fixture JSON-RPC process instead of the real
    // CLI: real codex needs a live ChatGPT/API login and burns real usage.
    // See tests/fixtures/fake-codex-app-server.mjs.
    t = await createTestApp({ POCKETAGENT_CODEX_BIN: CODEX_FIXTURE });
  });
  afterEach(() => t.cleanup());

  it('reports supportsSkipPermissions without forcesSkipPermissions', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/agents', headers: headers(t) });
    const agents = res.json().agents as {
      id: string;
      supportsSkipPermissions: boolean;
      forcesSkipPermissions: boolean;
    }[];
    const codex = agents.find((a) => a.id === 'codex');
    expect(codex?.supportsSkipPermissions).toBe(true);
    expect(codex?.forcesSkipPermissions).toBe(false);
  });

  it('creates a structured session that defaults to asking', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'codex', cwd: t.projectDir, cols: 80, rows: 24 },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.agent).toBe('codex');
    expect(body.transport).toBe('structured');
    expect(body.skipPermissionsEnabled).toBe(false);
  });

  it('runs a real turn through the manager and surfaces a genuine approval request', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'codex', cwd: t.projectDir, cols: 80, rows: 24 },
    });
    const id = created.json().id as string;

    const session = t.context.sessions.getOrThrow(id);
    if (session.transport !== 'structured') throw new Error('expected a structured session');
    session.prompt('NEEDS_PERMISSION');

    await waitFor(() =>
      session.buffer.replayAfter(0).events.some((e) => e.event.kind === 'permission_request'),
    );
    const request = session
      .buffer.replayAfter(0)
      .events.map((e) => e.event)
      .find((e) => e.kind === 'permission_request');
    expect(request).toBeTruthy();

    expect(session.resolvePermission(request!.id, 'allow')).toBe(true);

    await waitFor(() =>
      session.buffer.replayAfter(0).events.some((e) => e.event.kind === 'turn_complete'),
    );
    const kinds = session.buffer.replayAfter(0).events.map((e) => e.event.kind);
    expect(kinds).toContain('tool_result');
  });

  it('creates a session that skips approvals when explicitly opted in', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'codex', cwd: t.projectDir, cols: 80, rows: 24, skipPermissions: true },
    });
    expect(created.json().skipPermissionsEnabled).toBe(true);

    const id = created.json().id as string;
    const session = t.context.sessions.getOrThrow(id);
    if (session.transport !== 'structured') throw new Error('expected a structured session');
    session.prompt('NEEDS_PERMISSION');

    await waitFor(() =>
      session.buffer.replayAfter(0).events.some((e) => e.event.kind === 'turn_complete'),
    );
    const kinds = session.buffer.replayAfter(0).events.map((e) => e.event.kind);
    expect(kinds).not.toContain('permission_request');
  });
});

describe('pi adapter: structured, forced skip-permissions (no approval concept at all)', () => {
  let t: TestApp;

  beforeEach(async () => {
    // Points the adapter at a fixture RPC process instead of the real CLI:
    // no provider in this environment had working credentials for pi. See
    // tests/fixtures/fake-pi-rpc.mjs.
    t = await createTestApp({ POCKETAGENT_PI_BIN: PI_FIXTURE });
  });
  afterEach(() => t.cleanup());

  it('reports forcesSkipPermissions', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/agents', headers: headers(t) });
    const agents = res.json().agents as { id: string; forcesSkipPermissions: boolean }[];
    expect(agents.find((a) => a.id === 'pi')?.forcesSkipPermissions).toBe(true);
  });

  it('creates a structured session that is always bypassed, even without asking', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'pi', cwd: t.projectDir, cols: 80, rows: 24 },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.agent).toBe('pi');
    expect(body.transport).toBe('structured');
    expect(body.skipPermissionsEnabled).toBe(true);
    // Unlike the shared-daemon adapters, pi owns one real process per
    // session — a genuine pid is reported, same as a PTY session.
    expect(body.pid).toBeGreaterThan(0);
  });

  it('runs a real turn through the manager, driving a real persistent process', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'pi', cwd: t.projectDir, cols: 80, rows: 24 },
    });
    const id = created.json().id as string;

    const session = t.context.sessions.getOrThrow(id);
    if (session.transport !== 'structured') throw new Error('expected a structured session');
    session.prompt('hello');

    await waitFor(() =>
      session.buffer.replayAfter(0).events.some((e) => e.event.kind === 'turn_complete'),
    );
    const kinds = session.buffer.replayAfter(0).events.map((e) => e.event.kind);
    expect(kinds).toContain('session_started');
    expect(kinds).toContain('tool_use');
    expect(kinds).toContain('turn_complete');
    expect(kinds).not.toContain('permission_request');
  });
});

describe('PTY lifecycle', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(() => t.cleanup());

  it('runs a command and returns its output', async () => {
    const id = await createShellSession(t);
    const session = t.context.sessions.getOrThrow(id);

    await sleep(300);
    session.write('echo hello-from-pty\n');

    const output = await waitForOutput(t, id, 'hello-from-pty');
    // Echoed once by the tty and once as the command's own output.
    expect(output.match(/hello-from-pty/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('presents itself as a real terminal to the child process', async () => {
    const id = await createShellSession(t);
    const session = t.context.sessions.getOrThrow(id);

    await sleep(300);
    session.write('test -t 0 && echo IS_A_TTY\n');
    await waitForOutput(t, id, 'IS_A_TTY');

    session.write('echo TERM_IS=$TERM\n');
    const output = await waitForOutput(t, id, 'TERM_IS=xterm-256color');
    expect(output).toContain('TERM_IS=xterm-256color');
  });

  it('starts the process in the requested directory', async () => {
    const id = await createShellSession(t);
    const session = t.context.sessions.getOrThrow(id);
    await sleep(300);
    session.write('pwd\n');
    const output = await waitForOutput(t, id, t.projectDir);
    expect(output).toContain(t.projectDir);
  });

  it('does not leak the master token into the child environment', async () => {
    const id = await createShellSession(t);
    const session = t.context.sessions.getOrThrow(id);
    await sleep(300);
    session.write('echo "TOKENCOUNT=$(env | grep -c POCKETAGENT || true)"\n');
    const output = await waitForOutput(t, id, 'TOKENCOUNT=0');
    expect(output).toContain('TOKENCOUNT=0');
  });

  it('propagates a resize to the child process', async () => {
    const id = await createShellSession(t, { cols: 80, rows: 24 });
    const session = t.context.sessions.getOrThrow(id);
    await sleep(300);

    expect(session.resize(132, 43)).toBe(true);
    expect(session.cols).toBe(132);

    session.write('echo "SIZE=$(tput cols)x$(tput lines)"\n');
    const output = await waitForOutput(t, id, 'SIZE=132x43');
    expect(output).toContain('SIZE=132x43');
  });

  it('ignores a resize to the same dimensions', async () => {
    const id = await createShellSession(t, { cols: 80, rows: 24 });
    const session = t.context.sessions.getOrThrow(id);
    expect(session.resize(80, 24)).toBe(false);
  });

  it('delivers Ctrl+C to the foreground job without killing the shell', async () => {
    const id = await createShellSession(t);
    const session = t.context.sessions.getOrThrow(id);
    await sleep(300);

    session.write('sleep 30\n');
    await sleep(400);
    session.signal('SIGINT');

    // The shell survives and accepts the next command.
    await sleep(300);
    session.write('echo STILL_ALIVE\n');
    await waitForOutput(t, id, 'STILL_ALIVE');
    expect(session.status).toBe('running');
  });

  it('detects process exit and records the exit code', async () => {
    const id = await createShellSession(t);
    const session = t.context.sessions.getOrThrow(id);
    await sleep(300);

    session.write('exit 7\n');
    await waitFor(() => !session.isAlive());

    expect(session.status).toBe('exited');
    expect(session.exitCode).toBe(7);
    expect(session.endedAt).toBeGreaterThan(0);
  });

  it('persists the exit to SQLite', async () => {
    const id = await createShellSession(t);
    const session = t.context.sessions.getOrThrow(id);
    await sleep(300);
    session.write('exit 3\n');
    await waitFor(() => !session.isAlive());

    const row = t.db.prepare('SELECT status, exit_code FROM sessions WHERE id = ?').get(id) as {
      status: string;
      exit_code: number;
    };
    expect(row.status).toBe('exited');
    expect(row.exit_code).toBe(3);
  });

  it('terminates a session through the API', async () => {
    const id = await createShellSession(t);
    const session = t.context.sessions.getOrThrow(id);
    await sleep(300);

    const res = await t.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${id}`,
      headers: headers(t),
    });
    expect(res.statusCode).toBe(200);

    await waitFor(() => !session.isAlive());
    expect(session.status).toBe('killed');
  });

  it('keeps the output buffer readable after the process dies', async () => {
    const id = await createShellSession(t);
    const session = t.context.sessions.getOrThrow(id);
    await sleep(300);
    session.write('echo LAST_WORDS\n');
    await waitForOutput(t, id, 'LAST_WORDS');

    session.write('exit\n');
    await waitFor(() => !session.isAlive());

    expect(session.buffer.replayAfter(0).data).toContain('LAST_WORDS');
  });

  it('reports a finished session in the list with its final status', async () => {
    const id = await createShellSession(t);
    const session = t.context.sessions.getOrThrow(id);
    await sleep(300);
    session.write('exit 0\n');
    await waitFor(() => !session.isAlive());

    const res = await t.app.inject({ method: 'GET', url: '/api/sessions', headers: headers(t) });
    const found = res.json().sessions.find((s: { id: string }) => s.id === id);
    expect(found.status).toBe('exited');
  });

  it('keeps sessions independent of each other', async () => {
    const a = await createShellSession(t);
    const b = await createShellSession(t);
    const sessionA = t.context.sessions.getOrThrow(a);
    const sessionB = t.context.sessions.getOrThrow(b);

    await sleep(300);
    sessionA.write('echo FROM_A\n');
    sessionB.write('echo FROM_B\n');

    await waitForOutput(t, a, 'FROM_A');
    await waitForOutput(t, b, 'FROM_B');

    expect(sessionA.buffer.replayAfter(0).data).not.toContain('FROM_B');

    // Killing one leaves the other running.
    sessionA.terminate();
    await waitFor(() => !sessionA.isAlive());
    expect(sessionB.isAlive()).toBe(true);
  });
});

/**
 * A structured session's own `spec.title` is fixed at creation and never
 * updated; Claude Code's own generated title, once `SessionManager` finds
 * one, is what `toInfo()`/`persist()` prefer to show instead. These
 * construct a `StructuredSession` directly, without starting it, so they pin
 * the preference logic itself rather than the (already separately tested)
 * lookup and the event wiring that triggers it.
 */
describe('derived conversation titles', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(() => t.cleanup());

  function makeStructuredSession(id = 'struct-1'): StructuredSession {
    return new StructuredSession({
      id,
      title: 'Claude Code · project',
      agent: 'claude',
      agentDisplayName: 'Claude Code',
      cwd: t.projectDir,
      env: {},
      workspaceLabel: 'project',
      eventBufferBytes: 64 * 1024,
      createdAt: Date.now(),
    });
  }

  it('shows the fixed creation-time title until a derived one is found', () => {
    const session = makeStructuredSession();
    expect(t.context.sessions.toInfo(session).title).toBe('Claude Code · project');
  });

  it('prefers the derived title once one is found', () => {
    const session = makeStructuredSession();
    session.setDerivedTitle('Fix the login bug');
    expect(t.context.sessions.toInfo(session).title).toBe('Fix the login bug');
  });

  it('never mutates spec.title — only the display value changes', () => {
    const session = makeStructuredSession();
    session.setDerivedTitle('Fix the login bug');
    expect(session.spec.title).toBe('Claude Code · project');
  });

  it('does not apply a structured session\'s derived-title concept to a terminal session', async () => {
    const id = await createShellSession(t);
    const session = t.context.sessions.getOrThrow(id);
    // A PtySession has no `derivedTitle` at all; `toInfo` must not read
    // through anything by mistake for the other transport.
    expect(t.context.sessions.toInfo(session).title).toBe(session.spec.title);
  });

  it('persists the derived title, so a session read back from the database shows it too', () => {
    const session = makeStructuredSession('struct-2');
    // Mirrors how `persistence.test.ts` seeds a row directly: `persist` is an
    // UPDATE, so a row has to exist first, same as it would after `create()`.
    t.db
      .prepare(
        `INSERT INTO sessions
           (id, title, agent, command, args_json, cwd, env_keys_json, status, pid,
            cols, rows, created_at, started_at, transport)
         VALUES (?, ?, 'claude', '', '[]', ?, '[]', 'running', NULL, 0, 0, ?, ?, 'structured')`,
      )
      .run(session.id, session.spec.title, session.spec.cwd, session.spec.createdAt, session.spec.createdAt);

    session.setDerivedTitle('Fix the login bug');
    t.context.sessions.persist(session);

    const row = t.db.prepare('SELECT title FROM sessions WHERE id = ?').get(session.id) as {
      title: string;
    };
    expect(row.title).toBe('Fix the login bug');
  });
});

describe('structured agent defaults caching', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(() => t.cleanup());

  function makeStructuredSession(id = 'struct-defaults'): StructuredSession {
    return new StructuredSession({
      id,
      title: 'Claude Code · project',
      agent: 'claude',
      agentDisplayName: 'Claude Code',
      cwd: t.projectDir,
      env: {},
      workspaceLabel: 'project',
      eventBufferBytes: 64 * 1024,
      createdAt: Date.now(),
    });
  }

  it('maps wire model id to concrete alias from cached catalog when session_started fires', () => {
    const session = makeStructuredSession();
    t.context.sessions.wire(session);

    // Pre-populate agent_defaults with catalog containing default and opus[1m] sharing resolvedModel
    const catalog = [
      {
        value: 'default',
        resolvedModel: 'claude-opus-5[1m]',
        displayName: 'Default (recommended)',
        description: '',
        supportsEffort: true,
        supportedEffortLevels: ['low'],
      },
      {
        value: 'opus[1m]',
        resolvedModel: 'claude-opus-5[1m]',
        displayName: 'Opus (1M context)',
        description: '',
        supportsEffort: true,
        supportedEffortLevels: ['low'],
      },
      {
        value: 'sonnet',
        resolvedModel: 'claude-sonnet-5',
        displayName: 'Sonnet',
        description: '',
        supportsEffort: false,
        supportedEffortLevels: [],
      },
    ];
    writeAgentDefaults(t.db, 'claude', { modelsJson: JSON.stringify(catalog) });

    // session_started fires with raw wire id
    session.emit('event', 1, {
      kind: 'session_started',
      agentSessionId: 'sess-1',
      model: 'claude-opus-5[1m]',
      cwd: t.projectDir,
      tools: [],
      permissionMode: 'default',
    });

    const defaults = readAgentDefaults(t.db, 'claude');
    expect(defaults?.model).toBe('opus[1m]');
  });
});

describe('session title clamping & agy derived titles (PA-163)', () => {
  const TES_46_LONG_TITLE =
    '[TES-46] LLM coding benchmark: Java problems from interview-question-bank, judged on Piston (retries, tools, LLM judge, composite score)';

  it('protocol: CreateSessionRequest truncates a 200-char title to 128 chars ending in an ellipsis, leaves a short title unchanged, and never splits non-BMP emoji in half', () => {
    const longTitle = 'A'.repeat(200);
    const parsedLong = CreateSessionRequest.parse({
      agent: 'agy',
      cwd: '/tmp/project',
      title: longTitle,
    });
    expect(parsedLong.title).toHaveLength(MAX_SESSION_TITLE_CHARS);
    expect(parsedLong.title?.endsWith('…')).toBe(true);
    expect(parsedLong.title).toBe(`${'A'.repeat(127)}…`);

    const parsedShort = CreateSessionRequest.parse({
      agent: 'agy',
      cwd: '/tmp/project',
      title: '  Short   session \n title  ',
    });
    expect(parsedShort.title).toBe('Short session title');

    // 100 rocket emojis = 200 UTF-16 code units; cutting at 127 would land
    // right between the high surrogate (index 126) and low surrogate (index 127)
    // of the 64th emoji.
    const emojiTitle = '🚀'.repeat(100);
    const clampedEmoji = clampTitle(emojiTitle);
    expect(clampedEmoji.length).toBeLessThanOrEqual(MAX_SESSION_TITLE_CHARS);
    expect(clampedEmoji.endsWith('…')).toBe(true);
    // Must contain no lone high or low surrogates.
    expect(clampedEmoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(clampedEmoji).toBe(`${'🚀'.repeat(63)}…`);
  });

  it('webhook titleOf and cron formatCronRunTitle clamp over-long inputs to at most 128 characters', () => {
    const summary150 = 'x'.repeat(150);
    const jiraTitle = titleOf('Jira Triage', 'jira', {
      event: 'jira:issue_updated',
      eventType: 'issue_updated',
      issueKey: 'TES-46',
      projectKey: 'TES',
      issueType: 'Task',
      status: 'In Progress',
      priority: 'Medium',
      summary: summary150,
      description: '',
      assignee: null,
      reporter: null,
      actor: null,
      labels: [],
      components: [],
      comment: null,
      changelog: [],
      changeHeadline: null,
      timestamp: Date.now(),
    });
    expect(jiraTitle.startsWith('[TES-46] ')).toBe(true);
    expect(jiraTitle.length).toBeLessThanOrEqual(MAX_SESSION_TITLE_CHARS);
    expect(jiraTitle.endsWith('…')).toBe(true);

    const cronTitle = formatCronRunTitle('Nightly '.repeat(25), 'UTC', Date.UTC(2026, 9, 20, 9, 0));
    expect(cronTitle.length).toBeLessThanOrEqual(MAX_SESSION_TITLE_CHARS);
    expect(cronTitle.endsWith('…')).toBe(true);
  });

  describe('manager and HTTP integration', () => {
    let t: TestApp;
    let agyRootDir: string;
    let annotationsDir: string;

    beforeEach(async () => {
      agyRootDir = fs.mkdtempSync('/tmp/pa-pa163-agy-');
      annotationsDir = path.join(agyRootDir, 'annotations');
      fs.mkdirSync(annotationsDir, { recursive: true });
      const agyTranscripts = new AgyTranscriptStore({
        brainDir: path.join(agyRootDir, 'brain'),
        annotationsDir,
        summariesDbPath: path.join(agyRootDir, 'conversation_summaries.db'),
      });
      t = await createTestApp(
        { POCKETAGENT_AGY_BIN: AGY_FIXTURE },
        undefined,
        agyTranscripts,
      );
    });

    afterEach(async () => {
      await t.cleanup();
      fs.rmSync(agyRootDir, { recursive: true, force: true });
    });

    it('SessionManager.create() clamps over-long titles from MCP, cron, and webhook sources and persists the clamped title', async () => {
      expect(TES_46_LONG_TITLE.length).toBe(136);
      for (const rawTitle of [
        TES_46_LONG_TITLE,
        `MCP · ${'long-client-label-'.repeat(10)}`,
        formatCronRunTitle('CronJob-'.repeat(20), 'UTC', Date.now()),
      ]) {
        const session = await t.context.sessions.create({
          agent: 'agy',
          cwd: t.projectDir,
          cols: 80,
          rows: 24,
          transport: 'structured',
          title: rawTitle,
        });
        const info = t.context.sessions.toInfo(session);
        expect(info.title.length).toBeLessThanOrEqual(MAX_SESSION_TITLE_CHARS);
        const row = t.db.prepare('SELECT title FROM sessions WHERE id = ?').get(session.id) as {
          title: string;
        };
        expect(row.title.length).toBeLessThanOrEqual(MAX_SESSION_TITLE_CHARS);
        session.terminate();
      }
    });

    it('regression: continuing a finished session that was saved with a 136-character title succeeds over POST /api/sessions', async () => {
      // Seed a legacy finished session row with the exact 136-character TES-46 title.
      t.db
        .prepare(
          `INSERT INTO sessions
             (id, title, agent, command, args_json, cwd, env_keys_json, status, pid,
              cols, rows, created_at, started_at, ended_at, transport, agent_session_id, skip_permissions)
           VALUES ('bWgXsQizFDnP', ?, 'agy', '', '[]', ?, '[]', 'exited', NULL, 0, 0, 1000, 1000, 2000, 'structured', 'f919dbb7-tes46', 1)`,
        )
        .run(TES_46_LONG_TITLE, t.projectDir);

      const oldInfo = t.context.sessions.find('bWgXsQizFDnP');
      expect(oldInfo?.title).toBe(TES_46_LONG_TITLE);

      // Resuming with the raw 136-character title (as older clients or direct API callers do) succeeds instead of 400.
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: headers(t),
        payload: {
          agent: 'agy',
          cwd: t.projectDir,
          cols: 80,
          rows: 24,
          transport: 'structured',
          resumeAgentSessionId: 'f919dbb7-tes46',
          forkSession: false,
          title: oldInfo!.title,
          skipPermissions: true,
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      const created = res.json();
      expect(created.title.length).toBe(MAX_SESSION_TITLE_CHARS);
      expect(created.title.endsWith('…')).toBe(true);
    });

    it('agy manager: a resumed agy session with a 136-char title shows the agy title after session_started / turn_complete and persists it, and a new session picks up its title after the first turn', async () => {
      fs.writeFileSync(
        path.join(annotationsDir, 'f919dbb7-tes46.pbtxt'),
        'title:"LLM Java Coding Benchmark Implementation"',
      );

      // 1. Resumed agy session starting with the 136-char title
      const resumed = await t.context.sessions.create({
        agent: 'agy',
        cwd: t.projectDir,
        cols: 80,
        rows: 24,
        transport: 'structured',
        resumeAgentSessionId: 'f919dbb7-tes46',
        title: TES_46_LONG_TITLE,
      });
      if (resumed.transport !== 'structured') throw new Error('expected structured session');

      resumed.prompt('continue benchmark');
      await waitFor(() =>
        resumed.buffer.replayAfter(0).events.some((e) => e.event.kind === 'turn_complete'),
      );
      await waitFor(
        () => t.context.sessions.toInfo(resumed).title === 'LLM Java Coding Benchmark Implementation',
      );
      const resumedRow = t.db.prepare('SELECT title FROM sessions WHERE id = ?').get(resumed.id) as {
        title: string;
      };
      expect(resumedRow.title).toBe('LLM Java Coding Benchmark Implementation');
      resumed.terminate();

      // 2. Brand-new agy session picks up its title after the first turn
      const fresh = await t.context.sessions.create({
        agent: 'agy',
        cwd: t.projectDir,
        cols: 80,
        rows: 24,
        transport: 'structured',
      });
      if (fresh.transport !== 'structured') throw new Error('expected structured session');
      expect(t.context.sessions.toInfo(fresh).title).not.toBe('Fresh Agy Conversation Title');

      // Real agy writes `<conversationId>.pbtxt` once the conversation starts;
      // under ACP, `agentSessionId` is already minted during `start()`.
      if (fresh.agentSessionId) {
        fs.writeFileSync(
          path.join(annotationsDir, `${fresh.agentSessionId}.pbtxt`),
          'title:"Fresh Agy Conversation Title"',
        );
      }

      fresh.prompt('hello agy');
      await waitFor(() =>
        fresh.buffer.replayAfter(0).events.some((e) => e.event.kind === 'turn_complete'),
      );
      await waitFor(
        () => t.context.sessions.toInfo(fresh).title === 'Fresh Agy Conversation Title',
      );
      const freshRow = t.db.prepare('SELECT title FROM sessions WHERE id = ?').get(fresh.id) as {
        title: string;
      };
      expect(freshRow.title).toBe('Fresh Agy Conversation Title');
      fresh.terminate();
    });
  });

  describe('codex derived titles (PA-164)', () => {
    let t: TestApp;
    let codexDir: string;
    let sessionIndexPath: string;
    let stateDbPath: string;

    beforeEach(async () => {
      codexDir = fs.mkdtempSync('/tmp/pa-pa164-codex-');
      sessionIndexPath = path.join(codexDir, 'session_index.jsonl');
      stateDbPath = path.join(codexDir, 'state_5.sqlite');
      const codexTranscripts = new CodexTranscriptStore({ codexDir });
      t = await createTestApp(
        { POCKETAGENT_CODEX_BIN: CODEX_FIXTURE },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        codexTranscripts,
      );
    });

    afterEach(async () => {
      await t.cleanup();
      fs.rmSync(codexDir, { recursive: true, force: true });
    });

    it('codex manager: a resumed codex session picks up its derived title on session_started / turn_complete and persists it, and a new session picks up its title from session_index.jsonl or state_5.sqlite after turn_complete', async () => {
      // Seed state_5.sqlite with a title for `thread_existing`
      const db = new Database(stateDbPath);
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT ''
        );
      `);
      db.prepare('INSERT INTO threads (id, title) VALUES (?, ?)').run(
        'thread_existing',
        'Resumed Codex Thread From SQLite',
      );
      db.close();

      // 1. Resumed codex session picks up its title on session_started
      const resumed = await t.context.sessions.create({
        agent: 'codex',
        cwd: t.projectDir,
        cols: 80,
        rows: 24,
        transport: 'structured',
        resumeAgentSessionId: 'thread_existing',
        title: TES_46_LONG_TITLE,
      });
      if (resumed.transport !== 'structured') throw new Error('expected structured session');

      await waitFor(
        () => t.context.sessions.toInfo(resumed).title === 'Resumed Codex Thread From SQLite',
      );
      const resumedRow = t.db.prepare('SELECT title FROM sessions WHERE id = ?').get(resumed.id) as {
        title: string;
      };
      expect(resumedRow.title).toBe('Resumed Codex Thread From SQLite');
      resumed.terminate();

      // 2. Brand-new codex session picks up its title from session_index.jsonl after the first turn
      const fresh = await t.context.sessions.create({
        agent: 'codex',
        cwd: t.projectDir,
        cols: 80,
        rows: 24,
        transport: 'structured',
      });
      if (fresh.transport !== 'structured') throw new Error('expected structured session');
      expect(t.context.sessions.toInfo(fresh).title).toBe(`Codex · ${path.basename(t.projectDir)}`);
      expect(fresh.agentSessionId).toBeTruthy();

      fs.writeFileSync(
        sessionIndexPath,
        JSON.stringify({
          id: fresh.agentSessionId,
          thread_name: 'Fresh Codex Thread Title',
          updated_at: '2026-10-20T18:00:00Z',
        }) + '\n',
      );

      fresh.prompt('hello codex');
      await waitFor(() =>
        fresh.buffer.replayAfter(0).events.some((e) => e.event.kind === 'turn_complete'),
      );
      await waitFor(
        () => t.context.sessions.toInfo(fresh).title === 'Fresh Codex Thread Title',
      );
      const freshRow = t.db.prepare('SELECT title FROM sessions WHERE id = ?').get(fresh.id) as {
        title: string;
      };
      expect(freshRow.title).toBe('Fresh Codex Thread Title');
      fresh.terminate();
    });
  });

  describe('agy mode approval rules, sticky persistence, and unattended gating (PA-184)', () => {
    let t: TestApp;
    let fakeHome: string;
    const origHome = process.env.HOME;

    beforeEach(async () => {
      fakeHome = fs.mkdtempSync('/tmp/pa-pa184-home-');
      fs.mkdirSync(path.join(fakeHome, '.gemini', 'antigravity-cli'), { recursive: true });
      fs.writeFileSync(
        path.join(fakeHome, '.gemini', 'antigravity-cli', 'settings.json'),
        JSON.stringify({ toolPermission: 'request-review' }),
      );
      process.env.HOME = fakeHome;
      t = await createTestApp({ POCKETAGENT_AGY_BIN: AGY_FIXTURE });
    });

    afterEach(async () => {
      await t.cleanup();
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    });

    it('fails closed on isAutoApprovingAgentMode', () => {
      expect(isAutoApprovingAgentMode(undefined)).toBe(false);
      expect(isAutoApprovingAgentMode(null)).toBe(false);
      expect(isAutoApprovingAgentMode('default')).toBe(false);
      expect(isAutoApprovingAgentMode('plan')).toBe(false);
      expect(isAutoApprovingAgentMode('accept-edits')).toBe(true);
      expect(isAutoApprovingAgentMode('auto')).toBe(true);
      expect(isAutoApprovingAgentMode('future-auto-mode')).toBe(true);
    });

    it('discloses auto-approving modes persistently and keeps persisted skip_permissions sticky after switching back', async () => {
      // Safe mode (`plan`) stays supervised.
      const planRes = await t.app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: headers(t),
        payload: { agent: 'agy', cwd: t.projectDir, cols: 80, rows: 24, transport: 'structured', mode: 'plan' },
      });
      expect(planRes.statusCode, planRes.body).toBe(201);
      const planInfo = planRes.json();
      expect(planInfo.agentMode).toBe('plan');
      expect(planInfo.skipPermissionsEnabled).toBe(false);
      const planRow = t.db.prepare('SELECT skip_permissions FROM sessions WHERE id = ?').get(planInfo.id) as {
        skip_permissions: number;
      };
      expect(planRow.skip_permissions).toBe(0);

      // Switching live from `plan` -> `accept-edits` discloses immediately and latches DB skip_permissions = 1.
      const livePlan = t.context.sessions.get(planInfo.id);
      if (!(livePlan instanceof AgySession)) throw new Error('expected AgySession');
      await livePlan.setMode('accept-edits');
      expect(t.context.sessions.toInfo(livePlan).agentMode).toBe('accept-edits');
      expect(t.context.sessions.toInfo(livePlan).skipPermissionsEnabled).toBe(true);
      const latchedRow = t.db.prepare('SELECT skip_permissions FROM sessions WHERE id = ?').get(planInfo.id) as {
        skip_permissions: number;
      };
      expect(latchedRow.skip_permissions).toBe(1);

      // Switching back to `default` clears live skipPermissionsEnabled but keeps persisted skip_permissions = 1.
      await livePlan.setMode('default');
      expect(t.context.sessions.toInfo(livePlan).agentMode).toBe('default');
      expect(t.context.sessions.toInfo(livePlan).skipPermissionsEnabled).toBe(false);
      const stickyRow = t.db.prepare('SELECT skip_permissions FROM sessions WHERE id = ?').get(planInfo.id) as {
        skip_permissions: number;
      };
      expect(stickyRow.skip_permissions).toBe(1);
      livePlan.terminate();
    });

    it('refuses auto-approving modes for MCP principals and unattended triggers without skipPermissions', async () => {
      // 1. MCP tools do not expose an agent mode knob for starting sessions.
      const startTool = MCP_TOOLS.find((tool) => tool.name === 'start_session');
      const runTool = MCP_TOOLS.find((tool) => tool.name === 'run_coding_task');
      expect(Object.keys(startTool?.input ?? {})).not.toContain('mode');
      expect(Object.keys(runTool?.input ?? {})).not.toContain('mode');

      // 2. Direct POST /api/sessions with an MCP principal rejects `auto` / `accept-edits` / unknown modes with 403,
      //    while allowing `plan`.
      const ws = makeWorkspace();
      const db = openDatabase(':memory:');
      const config = makeConfig({
        POCKETAGENT_WORKSPACE_ROOTS: ws.root,
        POCKETAGENT_AGY_BIN: AGY_FIXTURE,
      });
      const { app: mcpApp, context: mcpContext } = await buildApp({
        config,
        db,
        plannerWorkspacesRoot: path.join(ws.root, 'planner-workspaces'),
        plannerSkillsRoot: path.join(ws.root, 'planner-skills'),
        attachmentStagingDir: path.join(ws.root, 'attachment-staging'),
        browserOptions: { findExecutable: () => null },
        legacyProviderEnv: {},
        serveStatic: false,
      });
      mcpApp.addHook('preHandler', async (req) => {
        if (req.headers['x-test-mcp'] === '1') {
          req.mcpPrincipal = {
            id: 'mcp-1',
            label: 'test-mcp',
            scopes: ['read', 'sessions'],
          };
        }
      });
      await mcpApp.ready();
      try {
        const login = await mcpApp.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { token: TEST_TOKEN },
        });
        const cookie = login.cookies[0] ? `${login.cookies[0].name}=${login.cookies[0].value}` : '';
        const mcpHeaders = { cookie, 'x-test-mcp': '1' };

        for (const forbiddenMode of ['auto', 'accept-edits', 'unknown-future']) {
          const res = await mcpApp.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: mcpHeaders,
            payload: {
              agent: 'agy',
              cwd: ws.project,
              cols: 80,
              rows: 24,
              transport: 'structured',
              mode: forbiddenMode,
            },
          });
          expect(res.statusCode, `${forbiddenMode}: ${res.body}`).toBe(403);
          expect(res.json().error.code).toBe('mode_forbidden');
        }

        const safeMcpRes = await mcpApp.inject({
          method: 'POST',
          url: '/api/sessions',
          headers: mcpHeaders,
          payload: {
            agent: 'agy',
            cwd: ws.project,
            cols: 80,
            rows: 24,
            transport: 'structured',
            mode: 'plan',
          },
        });
        expect(safeMcpRes.statusCode, safeMcpRes.body).toBe(201);
        expect(safeMcpRes.json().agentMode).toBe('plan');
        mcpContext.sessions.terminate(safeMcpRes.json().id);
      } finally {
        await mcpApp.close();
        ws.cleanup();
      }

      // 3. RunExecutor (cron & webhooks) rejects auto-approving modes unless skipPermissions is true.
      const executor = new RunExecutor({
        sessions: t.context.sessions,
        workspaces: t.context.workspaces,
        worktrees: t.context.worktrees,
      });
      const noopSink = () => {
        let settledError: string | null = null;
        return {
          get error() {
            return settledError;
          },
          onCwd() {},
          onSessionStarted() {},
          onAgentSessionId() {},
          onSettled(_s: 'succeeded' | 'failed', err: string | null) {
            settledError = err;
          },
        };
      };

      const refusedSink = noopSink();
      const refused = await executor.start(
        'run-refused',
        {
          cwd: t.projectDir,
          agent: 'agy',
          title: 'Unattended auto',
          prompt: 'hello',
          skipPermissions: false,
          mode: 'auto',
          worktree: { mode: 'none' },
        },
        refusedSink,
      );
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error).toContain('auto-approving mode');

      const allowedPlan = await executor.start(
        'run-plan',
        {
          cwd: t.projectDir,
          agent: 'agy',
          title: 'Unattended plan',
          prompt: 'REPORT_MODE',
          skipPermissions: false,
          mode: 'plan',
          worktree: { mode: 'none' },
        },
        noopSink(),
      );
      expect(allowedPlan.ok).toBe(true);
      if (allowedPlan.ok) {
        expect(t.context.sessions.toInfo(allowedPlan.session).agentMode).toBe('plan');
        allowedPlan.session.terminate();
      }

      const allowedAuto = await executor.start(
        'run-auto',
        {
          cwd: t.projectDir,
          agent: 'agy',
          title: 'Unattended auto with skip',
          prompt: 'REPORT_MODE',
          skipPermissions: true,
          mode: 'auto',
          worktree: { mode: 'none' },
        },
        noopSink(),
      );
      expect(allowedAuto.ok).toBe(true);
      if (allowedAuto.ok) {
        expect(t.context.sessions.toInfo(allowedAuto.session).agentMode).toBe('auto');
        allowedAuto.session.terminate();
      }
    });
  });
});
