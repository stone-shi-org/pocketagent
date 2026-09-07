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
): Promise<TestApp> {
  const ws = makeWorkspace();
  const config = makeConfig({
    POCKETAGENT_WORKSPACE_ROOTS: ws.root,
    ...configOverrides,
  });
  const db = existingDb ?? openDatabase(':memory:');
  // `config.databasePath` always points at the real `<REPO_ROOT>/data/`
  // (it is not test-aware, by design — see its doc comment), so without this
  // override every test that boots an app would create real planner-workspace
  // directories on the host next to the real database.
  const plannerWorkspacesRoot = path.join(ws.root, 'planner-workspaces');
  const { app, context } = await buildApp({
    config,
    db,
    agyTranscripts,
    piTranscripts,
    plannerWorkspacesRoot,
    ...(plannerLlmFetch ? { plannerLlmFetch } : {}),
    extraAgents: [makeTestAgent(config.shell)],
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
