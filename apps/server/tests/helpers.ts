import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config/index.js';
import { openDatabase, type Db } from '../src/db/index.js';
import type { AgyTranscriptStore } from '../src/conversations/agy.js';
import type { PiTranscriptStore } from '../src/conversations/pi.js';
import type { PocketContext } from '../src/types.js';
import type { AgentAdapter } from '../src/agents/types.js';
import type { InstallRunner, ScriptFetcher } from '../src/agents/install.js';

/**
 * PA-104: what every test app downloads instead of a real official installer.
 * A test that wants to assert on the fetch passes its own.
 */
export const stubInstallerFetch: ScriptFetcher = async (url) => ({
  body: Buffer.from('#!/bin/sh\necho stub installer\n'),
  finalUrl: url,
});

export const TEST_TOKEN = 'test-token-that-is-long-enough-1234567890';

/**
 * The agent id tests use when they need a chat that is *not* a shell.
 *
 * `shell` is the only default adapter whose binary is reliably present on a
 * CI box, so it was the natural stand-in for "some agent" in every test that
 * just needed a session to exist. PA-25 made that stand-in wrong: a `shell`
 * session is now a row in the "Shell" category rather than a chat in a
 * project folder, so a test about project grouping, hiding, or clearing
 * finished chats has to name an agent that is not a shell. The process behind
 * it is still `/bin/bash` — only the id differs, which is the whole point.
 */
export const TEST_AGENT_ID = 'test-agent';

/** A terminal-transport adapter that runs the configured shell under a non-shell id. */
export function makeTestAgent(shellPath: string): AgentAdapter {
  return {
    id: TEST_AGENT_ID,
    displayName: 'Test Agent',
    description: 'A terminal agent for tests. Not a shell, as far as the home screen is concerned.',
    transports: ['terminal'],
    defaultTransport: 'terminal',
    buildCommand: () => ({ command: shellPath, args: ['-i'] }),
    isAvailable: () => true,
  };
}

export function makeWorkspace(): { root: string; project: string; cleanup: () => void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-test-')));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  return {
    root,
    project,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export function makeConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    POCKETAGENT_AUTH_TOKEN: TEST_TOKEN,
    POCKETAGENT_SHELL: '/bin/bash',
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export interface TestApp {
  app: FastifyInstance;
  context: PocketContext;
  db: Db;
  cookie: string;
  workspaceRoot: string;
  projectDir: string;
  cleanup: () => Promise<void>;
}

/** Boot a fully wired app against a temp workspace and an in-memory database. */
export async function createTestApp(
  configOverrides: Record<string, string> = {},
  existingDb?: Db,
  /** Injected so a test can point agy history reads at a fixture directory instead of a real `~/.gemini`. */
  agyTranscripts?: AgyTranscriptStore,
  /** Injected so a test can point pi history reads at a fixture directory instead of a real `~/.pi`. */
  piTranscripts?: PiTranscriptStore,
  /** Injected so a planner chat turn never makes a real network call. */
  plannerLlmFetch?: typeof fetch,
  /** Injected so a Telegram poll loop / `send_telegram_message` tool call
      never makes a real network call either. */
  telegramFetch?: typeof fetch,
  /** PA-68: injected so no test ever runs a real `npm install -g`. */
  agentInstallRunner?: InstallRunner,
  /** PA-70: injected so a test can read the audit trail — see
      `BuildAppOptions.loggerStream` for why the log is the only observable. */
  loggerStream?: NodeJS.WritableStream,
  /** PA-96: injected so minting a Gemini Live token never makes a real
      network call. */
  geminiFetch?: typeof fetch,
  /** PA-104: defaults to a stub, so no test can ever download a real installer. */
  agentInstallFetchScript: ScriptFetcher = stubInstallerFetch,
): Promise<TestApp> {
  const ws = makeWorkspace();
  const config = makeConfig({
    POCKETAGENT_WORKSPACE_ROOTS: ws.root,
    ...configOverrides,
  });
  const db = existingDb ?? openDatabase(':memory:');
  // A test builds its `Config` without setting `POCKETAGENT_DATA_DIR`, so
  // `config.dataDir` is the real `<REPO_ROOT>/data/` — without this override
  // every test that boots an app would create real planner-workspace
  // directories on the host next to the real database. Setting the variable
  // instead would work, but it must then point outside every workspace root
  // (`resolveDataDir` refuses otherwise), so the explicit roots stay.
  const plannerWorkspacesRoot = path.join(ws.root, 'planner-workspaces');
  // Same reasoning as `plannerWorkspacesRoot`, one layer up: without this
  // override every test that boots an app would create real
  // `data/planner-skills/` directories on the host.
  const plannerSkillsRoot = path.join(ws.root, 'planner-skills');
  const { app, context } = await buildApp({
    config,
    db,
    agyTranscripts,
    piTranscripts,
    plannerWorkspacesRoot,
    plannerSkillsRoot,
    ...(plannerLlmFetch ? { plannerLlmFetch } : {}),
    ...(telegramFetch ? { telegramFetch } : {}),
    ...(agentInstallRunner ? { agentInstallRunner } : {}),
    agentInstallFetchScript,
    ...(loggerStream ? { loggerStream } : {}),
    ...(geminiFetch ? { geminiFetch } : {}),
    // Fast enough for a test to assert against without a real 10s wait,
    // slow enough not to spin the CPU during tests that never touch Telegram.
    telegramReconcileIntervalMs: 200,
    extraAgents: [makeTestAgent(config.shell)],
    // Empty rather than `process.env`: this checkout's own `.env` is already
    // loaded by the time a test runs, so a developer with a legacy
    // `POCKETAGENT_DEEPSEEK_API_KEY` would otherwise get a custom Claude
    // provider imported into every test app. See `BuildAppOptions`.
    legacyProviderEnv: {},
    serveStatic: false,
  });
  await app.ready();

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { token: TEST_TOKEN },
  });
  const setCookie = login.cookies[0];
  const cookie = setCookie ? `${setCookie.name}=${setCookie.value}` : '';

  const origClose = app.close.bind(app);
  app.close = async () => {
    app.server.closeAllConnections?.();
    return origClose();
  };

  return {
    app,
    context,
    db,
    cookie,
    workspaceRoot: ws.root,
    projectDir: ws.project,
    cleanup: async () => {
      await app.close();
      ws.cleanup();
    },
  };
}

export function authHeaders(cookie: string): Record<string, string> {
  return { cookie };
}

/** Poll until `predicate` holds or the deadline passes. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeout = 8000, interval = 25 }: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
