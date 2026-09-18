import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentInstallEvent, InstallableAgentListResponse } from '@pocketagent/protocol';
import { INSTALLABLE_AGENT_IDS } from '@pocketagent/protocol';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';
import { installableAgents, npmInstallCommand } from '../src/agents/catalog.js';
import { deriveSetupState } from '../src/agents/auth-probe.js';
import { installFailure, verifyInstalled, type InstallRunner } from '../src/agents/install.js';
import { createClaudeAdapter } from '../src/agents/claude.js';
import { createCodexAdapter } from '../src/agents/codex.js';
import { authHeaders, createTestApp, makeConfig, makeWorkspace, TEST_TOKEN, type TestApp } from './helpers.js';

/**
 * Reverses the SSE wire format, exactly as `planner-chats.test.ts` does.
 * `app.inject()` buffers a hijacked stream, so the whole frame sequence
 * arrives as one payload — which is what makes every acceptance criterion
 * here testable with no live server and no real install.
 *
 * Heartbeat comment frames (`: ping`) are dropped: they are not `data:`
 * frames and carry no JSON, which is precisely why a comment was chosen for
 * the keep-alive.
 */
function parseEvents(payload: string): AgentInstallEvent[] {
  return payload
    .split('\n\n')
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && c.startsWith('data:'))
    .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')) as AgentInstallEvent);
}

/**
 * A prefix the server will actually search, so `prefixDetectable` is true and
 * the tests exercise the install path rather than the refusal. `~/.npm-global`
 * is one of `agentBinSearchDirs()` by construction — see that function.
 */
const DETECTABLE_PREFIX = path.join(os.homedir(), '.npm-global');

describe('agent install catalog', () => {
  /**
   * The pins here and the pins the container image bakes in must not drift.
   *
   * They are deliberately duplicated — the runtime image does not ship
   * `docker/`, so the catalog cannot read that file at run time — and this is
   * what keeps the duplication honest, the same way PA-65 lets four
   * `package.json` versions coexist behind a test that fails when they
   * disagree. Without it, `docker/agent-versions.env` would be bumped and the
   * on-demand install would quietly keep fetching last month's version.
   */
  it('pins the same versions docker/agent-versions.env does', () => {
    const envPath = path.resolve(import.meta.dirname, '../../../docker/agent-versions.env');
    const raw = readFileSync(envPath, 'utf8');
    const pins = new Map<string, string>();
    for (const line of raw.split('\n')) {
      const match = /^([A-Z0-9_]+)=(.+)$/.exec(line.trim());
      if (match?.[1] && match[2]) pins.set(match[1], match[2].trim());
    }
    const byId = new Map(installableAgents().map((a) => [a.id, a]));
    expect(byId.get('claude')?.version).toBe(pins.get('CLAUDE_CODE_VERSION'));
    expect(byId.get('codex')?.version).toBe(pins.get('CODEX_VERSION'));
    expect(byId.get('opencode')?.version).toBe(pins.get('OPENCODE_VERSION'));
    expect(byId.get('pi')?.version).toBe(pins.get('PI_VERSION'));
  });

  /**
   * `agy` is the one declared agent with no npm package, and the reason is a
   * supply-chain hazard rather than an oversight (the registry names that look
   * right are unrelated placeholders). Pinning it here asserts the decision so
   * a future "completeness" pass has to argue with a failing test.
   */
  it('does not offer to install agy', () => {
    expect(INSTALLABLE_AGENT_IDS).not.toContain('agy');
    expect(installableAgents().map((a) => a.id)).not.toContain('agy');
  });

  it('never installs a floating version', () => {
    for (const agent of installableAgents()) {
      expect(agent.version).toMatch(/^\d+\.\d+\.\d+/);
      const { args } = npmInstallCommand(agent.id, '/tmp/prefix');
      expect(args).toContain(`${agent.packageName}@${agent.version}`);
      expect(args.join(' ')).not.toContain('latest');
    }
  });

  /**
   * Both halves of the prefix decision, because each one on its own has
   * shipped broken somewhere: the flag alone loses to an inherited
   * `NPM_CONFIG_PREFIX` (npm reads env config case-insensitively, which is why
   * the Dockerfile has to `env -u` it), and the env var alone would be
   * overridden by a user-level npmrc.
   */
  it('aims npm at the prefix twice, by flag and by environment', () => {
    const { args, env } = npmInstallCommand('claude', '/opt/agents');
    expect(args).toContain('--prefix=/opt/agents');
    expect(env.NPM_CONFIG_PREFIX).toBe('/opt/agents');
    // Corepack hard-fails any `npm` call inside a project declaring another
    // package manager, which this repository does.
    expect(env.COREPACK_ENABLE_STRICT).toBe('0');
  });

  it('never builds a shell command', () => {
    for (const agent of installableAgents()) {
      const { args } = npmInstallCommand(agent.id, '/tmp/p');
      for (const arg of args) {
        expect(arg).not.toMatch(/[;&|`$><]/);
      }
    }
  });
});

describe('install failure reporting', () => {
  /**
   * Acceptance criterion: a failure surfaces the real error. The three ways
   * this goes wrong are different problems with different fixes, so they must
   * not collapse into one string.
   */
  it('distinguishes npm missing, npm failing, and a timeout', () => {
    expect(installFailure({ code: null, timedOut: false, startError: 'ENOENT' }, 'p')).toMatch(/Could not run npm/);
    expect(installFailure({ code: 1, timedOut: false, startError: null }, 'p')).toMatch(/exited with code 1/);
    expect(installFailure({ code: null, timedOut: true, startError: null }, 'p')).toMatch(/longer than/);
    expect(installFailure({ code: 0, timedOut: false, startError: null }, 'p')).toBeNull();
  });
});

describe('post-install verification', () => {
  /**
   * npm's exit code is necessary but not sufficient — the Dockerfile keeps a
   * `test -x` for exactly this case, having once shipped an install that
   * reported success into a prefix nothing read. Driven against a real
   * temporary prefix so the assertion does not depend on which agents happen
   * to be installed on the machine running the tests.
   */
  const tmp = path.join(os.tmpdir(), `pa-verify-${process.pid}`);

  it('reports nothing resolved when the install produced no binary', () => {
    expect(verifyInstalled('definitely-not-a-real-binary-xyz', tmp)).toEqual({
      resolved: null,
      fromPrefix: false,
    });
  });

  /**
   * The subtle case: the binary resolves, so the agent is usable and this is
   * not a failure — but it resolves from *outside* the prefix, meaning an
   * existing copy earlier on PATH will run instead of the one just installed.
   * An operator's upgrade then silently does nothing, which is why this is
   * distinguished rather than folded into success.
   */
  it('distinguishes a binary shadowed from outside the prefix', () => {
    const shell = verifyInstalled('sh', tmp);
    expect(shell.resolved).not.toBeNull();
    expect(shell.fromPrefix).toBe(false);
  });
});

describe('setup state derivation', () => {
  /**
   * `available` wins outright. A cached `ready` from before someone deleted
   * the binary must read as `not-installed`: the whole point of the state
   * model is that an operator is never told an agent is usable when it is not.
   */
  it('reports not-installed even when a probe once said ready', () => {
    expect(deriveSetupState(false, { state: 'ready', detail: 'Signed in' })).toEqual({
      setupState: 'not-installed',
      setupDetail: null,
    });
  });

  it('reports unknown when nothing has been probed', () => {
    expect(deriveSetupState(true, null).setupState).toBe('unknown');
    expect(deriveSetupState(true, { state: null, detail: null }).setupState).toBe('unknown');
  });

  it('never upgrades an unknown probe result to ready', () => {
    expect(deriveSetupState(true, { state: 'unknown', detail: 'no subcommand' })).toEqual({
      setupState: 'unknown',
      setupDetail: 'no subcommand',
    });
  });

  it('carries a signed-out reason through so it is actionable', () => {
    expect(deriveSetupState(true, { state: 'signed-out', detail: 'Run `codex login`' })).toEqual({
      setupState: 'signed-out',
      setupDetail: 'Run `codex login`',
    });
  });
});

describe('auth probe interpretation', () => {
  const claude = createClaudeAdapter('claude');
  const codex = createCodexAdapter('codex');

  /**
   * Driven with recorded output rather than a real credentialed CLI, which is
   * the entire reason `authProbe.interpret` is a pure function instead of a
   * method that spawns. The `ready` sample is real output from
   * `claude auth status` on the development host.
   */
  it('reads claude auth status JSON', () => {
    const ready = claude.authProbe?.interpret({
      stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"enterprise"}',
      stderr: '',
      code: 0,
      timedOut: false,
    });
    expect(ready?.state).toBe('ready');
    expect(ready?.detail).toContain('claude.ai');
    // The account email is deliberately not echoed into the agent list.
    expect(ready?.detail).not.toContain('@');

    expect(
      claude.authProbe?.interpret({ stdout: '{"loggedIn":false}', stderr: '', code: 1, timedOut: false })?.state,
    ).toBe('signed-out');
  });

  /**
   * A CLI that changes its output format must degrade to `unknown`, never to
   * `ready` (which recreates the cryptic-first-session failure) and never to
   * `signed-out` (which would nag an operator authenticated by env var).
   */
  it('degrades to unknown when claude stops answering JSON', () => {
    for (const stdout of ['', 'Logged in as someone', 'not json at all']) {
      expect(claude.authProbe?.interpret({ stdout, stderr: '', code: 0, timedOut: false })?.state).toBe('unknown');
    }
    expect(claude.authProbe?.interpret({ stdout: '', stderr: '', code: null, timedOut: true })?.state).toBe('unknown');
  });

  /**
   * "not logged in" contains "logged in", so the negative has to be tested
   * first — the obvious `/logged in/` check alone reports a signed-out CLI as
   * ready.
   */
  it('does not read codex "not logged in" as logged in', () => {
    expect(
      codex.authProbe?.interpret({ stdout: 'Not logged in', stderr: '', code: 1, timedOut: false })?.state,
    ).toBe('signed-out');
    expect(
      codex.authProbe?.interpret({ stdout: 'Logged in using ChatGPT', stderr: '', code: 0, timedOut: false })?.state,
    ).toBe('ready');
    expect(codex.authProbe?.interpret({ stdout: 'huh?', stderr: '', code: 0, timedOut: false })?.state).toBe('unknown');
  });

  /** The agents that genuinely cannot be asked declare no probe at all. */
  it('declares no probe for agents with no non-interactive way to answer', async () => {
    const { createAgyAdapter } = await import('../src/agents/agy.js');
    const { createOpencodeAdapter } = await import('../src/agents/opencode.js');
    const { createPiAdapter } = await import('../src/agents/pi.js');
    expect(createAgyAdapter('agy').authProbe).toBeUndefined();
    expect(createOpencodeAdapter('opencode').authProbe).toBeUndefined();
    expect(createPiAdapter('pi').authProbe).toBeUndefined();
  });
});

describe('install routes', () => {
  let t: TestApp;
  let runner: InstallRunner;
  let calls: { args: string[]; cwd: string }[];
  let behaviour: (onOutput: (c: string) => void) => Promise<{
    code: number | null;
    timedOut: boolean;
    startError: string | null;
  }>;

  beforeEach(async () => {
    calls = [];
    behaviour = async (onOutput) => {
      onOutput('added 1 package\n');
      return { code: 0, timedOut: false, startError: null };
    };
    runner = async ({ args, cwd, onOutput }) => {
      calls.push({ args, cwd });
      return behaviour(onOutput);
    };
    t = await createTestApp(
      { POCKETAGENT_AGENT_INSTALL_PREFIX: DETECTABLE_PREFIX },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runner,
    );
  });

  afterEach(async () => {
    await t.context.agentInstall.settle();
    await t.cleanup();
  });

  const post = (payload: unknown, url = '/api/agents/install') =>
    t.app.inject({ method: 'POST', url, headers: authHeaders(t.cookie), payload });

  it('lists the catalog with its prefix', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/agents/installable',
      headers: authHeaders(t.cookie),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as InstallableAgentListResponse;
    expect(body.agents.map((a) => a.id).sort()).toEqual([...INSTALLABLE_AGENT_IDS].sort());
    expect(body.prefix).toBe(DETECTABLE_PREFIX);
    expect(body.prefixDetectable).toBe(true);
  });

  it('requires authentication', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/agents/installable' });
    expect(res.statusCode).toBe(401);
  });

  /**
   * THE acceptance criterion: the browser never supplies an executable or
   * argv, so an arbitrary package name is refused.
   *
   * Asserting that the runner was never invoked is the part that matters most
   * — a 400 that had already spawned something would satisfy a status-only
   * assertion while being exactly the bug this guards against.
   */
  it('rejects an arbitrary package name and runs nothing', async () => {
    for (const id of ['@evil/pkg', 'left-pad', 'claude; rm -rf /', '../../etc/passwd', '']) {
      const res = await post({ id });
      expect(res.statusCode, `id=${id}`).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
    }
    expect(calls).toEqual([]);
  });

  it('rejects a well-formed id that is not in the catalog', async () => {
    // `agy` is a real agent this server knows about — it is simply not
    // installable — so this is the case a handler-level lookup would be most
    // likely to get wrong.
    const res = await post({ id: 'agy' });
    expect(res.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it('rejects a body that smuggles a package name alongside a valid id', async () => {
    const res = await post({ id: 'claude', packageName: 'evil', version: '9.9.9', registry: 'http://evil' });
    // Extra keys are ignored by the schema rather than rejected, but they must
    // not reach the installer: the argv comes from the catalog alone.
    expect(res.statusCode, res.body).toBe(200);
    await t.context.agentInstall.settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.join(' ')).toContain('@anthropic-ai/claude-code@');
    expect(calls[0]?.args.join(' ')).not.toContain('evil');
    expect(calls[0]?.args.join(' ')).not.toContain('9.9.9');
  });

  /** A POST, so `app.ts`'s single Origin gate covers it. */
  it('refuses a cross-origin install', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/agents/install',
      headers: { cookie: t.cookie, origin: 'https://evil.example', host: '127.0.0.1:8787' },
      payload: { id: 'claude' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden_origin');
    expect(calls).toEqual([]);
  });

  it('streams progress and finishes', async () => {
    const res = await post({ id: 'pi' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    // Defeats nginx's default response buffering, which would otherwise hold
    // the whole stream until the install finished.
    expect(res.headers['x-accel-buffering']).toBe('no');

    const events = parseEvents(res.payload);
    expect(events.map((e) => e.kind)).toEqual(['install_started', 'install_log', 'install_finished']);
    const started = events[0];
    expect(started?.kind === 'install_started' && started.packageName).toBe(
      '@earendil-works/pi-coding-agent',
    );
    expect(started?.kind === 'install_started' && started.attached).toBe(false);
    const log = events[1];
    expect(log?.kind === 'install_log' && log.text).toContain('added 1 package');
    expect(calls[0]?.args).toContain('install');
  });

  /**
   * The installer must not run from the server's own cwd. On a host where npm
   * is a corepack shim, an `npm` call inside this repository fails outright
   * because the repo declares pnpm — so this is a real failure mode, not a
   * hypothetical one.
   */
  it('runs the installer outside the repository', async () => {
    await post({ id: 'pi' });
    await t.context.agentInstall.settle();
    expect(calls[0]?.cwd).toBe(os.tmpdir());
    expect(calls[0]?.cwd).not.toBe(process.cwd());
  });

  /**
   * Acceptance criterion: the real error, not a generic failure — and it has
   * to outlive the stream, or it only holds while the operator is watching.
   */
  it('surfaces npm\'s own error in the stream and persists the failure', async () => {
    behaviour = async (onOutput) => {
      onOutput('npm error 403 Forbidden - GET https://registry.npmjs.org/@openai/codex\n');
      return { code: 1, timedOut: false, startError: null };
    };
    const res = await post({ id: 'codex' });
    const events = parseEvents(res.payload);
    const log = events.find((e) => e.kind === 'install_log');
    expect(log?.kind === 'install_log' && log.text).toContain('403 Forbidden');
    const finished = events.find((e) => e.kind === 'install_finished');
    expect(finished?.kind === 'install_finished' && finished.ok).toBe(false);
    expect(finished?.kind === 'install_finished' && finished.error).toMatch(/exited with code 1/);

    const agents = await t.app.inject({ method: 'GET', url: '/api/agents', headers: authHeaders(t.cookie) });
    const row = (agents.json().agents as { id: string; lastInstallOk: boolean | null; lastInstallError: string | null }[])
      .find((a) => a.id === 'codex');
    expect(row?.lastInstallOk).toBe(false);
    expect(row?.lastInstallError).toMatch(/exited with code 1/);
  });

  it('reports a failure when npm cannot be started at all', async () => {
    behaviour = async () => ({ code: null, timedOut: false, startError: 'spawn npm ENOENT' });
    const res = await post({ id: 'pi' });
    const finished = parseEvents(res.payload).find((e) => e.kind === 'install_finished');
    expect(finished?.kind === 'install_finished' && finished.error).toMatch(/Could not run npm/);
    expect(finished?.kind === 'install_finished' && finished.error).toMatch(/ENOENT/);
  });

  /**
   * A second install of a different agent is refused rather than queued: these
   * are large downloads and `RunQueue` is the wrong tool (it keys on working
   * trees, and an install has none).
   */
  it('refuses a concurrent install of a different agent', async () => {
    let release: () => void = () => undefined;
    behaviour = async () =>
      new Promise((resolve) => {
        release = () => resolve({ code: 0, timedOut: false, startError: null });
      });
    const first = post({ id: 'pi' });
    // Let the handler reach the runner before racing it.
    await new Promise((r) => setTimeout(r, 50));
    const second = await post({ id: 'codex' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('busy');
    release();
    await first;
  });

  /**
   * Re-POSTing the same id while it runs attaches to the job instead of
   * starting a second install — which is what makes navigating away and back
   * safe, and is the whole reason the job outlives the stream.
   */
  it('attaches to an install already in flight rather than starting a second', async () => {
    let release: () => void = () => undefined;
    behaviour = async (onOutput) => {
      onOutput('reticulating splines\n');
      return new Promise((resolve) => {
        release = () => resolve({ code: 0, timedOut: false, startError: null });
      });
    };
    const first = post({ id: 'pi' });
    await new Promise((r) => setTimeout(r, 50));
    const second = post({ id: 'pi' });
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [, secondRes] = await Promise.all([first, second]);

    // One invocation of the installer, two streams.
    expect(calls).toHaveLength(1);
    const events = parseEvents(secondRes.payload);
    const started = events[0];
    expect(started?.kind === 'install_started' && started.attached).toBe(true);
    // The attached stream replays the log it missed rather than starting blank.
    expect(events.some((e) => e.kind === 'install_log' && e.text.includes('reticulating'))).toBe(true);
  });

  /** A prefix the server does not search would make an install invisible. */
  it('refuses to install into a prefix it would never find', async () => {
    const other = await createTestApp(
      { POCKETAGENT_AGENT_INSTALL_PREFIX: '/tmp/pocketagent-nowhere' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runner,
    );
    try {
      const list = await other.app.inject({
        method: 'GET',
        url: '/api/agents/installable',
        headers: authHeaders(other.cookie),
      });
      expect((list.json() as InstallableAgentListResponse).prefixDetectable).toBe(false);
      const res = await other.app.inject({
        method: 'POST',
        url: '/api/agents/install',
        headers: authHeaders(other.cookie),
        payload: { id: 'pi' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('prefix_undetectable');
      expect(calls).toEqual([]);
    } finally {
      await other.context.agentInstall.settle();
      await other.cleanup();
    }
  });
});

describe('agent setup state over HTTP', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('reports a setup state and a bin-override flag for every agent', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/agents', headers: authHeaders(t.cookie) });
    const agents = res.json().agents as {
      id: string;
      available: boolean;
      setupState: string;
      binOverridden: boolean;
    }[];
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      expect(['not-installed', 'signed-out', 'ready', 'unknown']).toContain(agent.setupState);
      if (!agent.available) expect(agent.setupState).toBe('not-installed');
      expect(typeof agent.binOverridden).toBe('boolean');
    }
  });

  /**
   * An absolute path takes `resolveExecutable`'s early return, so the install
   * prefix is never consulted for that agent and an install would land
   * somewhere the server never looks. The browser cannot work this out — it
   * never sees `claudeBin` — so the server has to say it.
   */
  it('flags an agent whose binary is pinned to an absolute path', async () => {
    const ws = makeWorkspace();
    const db = openDatabase(':memory:');
    const { app, context } = await buildApp({
      config: makeConfig({
        POCKETAGENT_WORKSPACE_ROOTS: ws.root,
        POCKETAGENT_CLAUDE_BIN: '/opt/custom/claude',
      }),
      db,
      plannerWorkspacesRoot: path.join(ws.root, 'pw'),
      plannerSkillsRoot: path.join(ws.root, 'ps'),
      legacyProviderEnv: {},
      serveStatic: false,
    });
    try {
      await app.ready();
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: TEST_TOKEN } });
      const sc = login.cookies[0];
      const cookie = sc ? `${sc.name}=${sc.value}` : '';
      const res = await app.inject({ method: 'GET', url: '/api/agents', headers: { cookie } });
      const agents = res.json().agents as { id: string; binOverridden: boolean }[];
      expect(agents.find((a) => a.id === 'claude')?.binOverridden).toBe(true);
      expect(agents.find((a) => a.id === 'codex')?.binOverridden).toBe(false);
      expect(context.config.claudeBin).toBe('/opt/custom/claude');
    } finally {
      await app.close();
      ws.cleanup();
    }
  });
});
