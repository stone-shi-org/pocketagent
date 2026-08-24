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

export const TEST_TOKEN = 'test-token-that-is-long-enough-1234567890';

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
): Promise<TestApp> {
  const ws = makeWorkspace();
  const config = makeConfig({
    POCKETAGENT_WORKSPACE_ROOTS: ws.root,
    ...configOverrides,
  });
  const db = existingDb ?? openDatabase(':memory:');
  const { app, context } = await buildApp({ config, db, agyTranscripts, piTranscripts, serveStatic: false });
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
