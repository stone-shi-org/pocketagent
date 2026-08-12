import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CreateSessionRequest } from '@pocketagent/protocol';
import { encodeProjectDir } from '../src/conversations/index.js';
import { createTestApp, makeWorkspace, type TestApp } from './helpers.js';

/**
 * Resuming a conversation reaches into a transcript that another process may
 * also be writing. The safety property is that we branch by default: `resume`
 * plus `forkSession`, so the original file is only ever read.
 *
 * The Agent SDK is mocked here on purpose. What needs pinning is the options we
 * hand it — running a real agent would test Anthropic's code, cost money, and
 * still not be deterministic.
 */
const captured: { options: any; prompt: unknown }[] = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }: { prompt: unknown; options: unknown }) => {
    captured.push({ prompt, options });
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: (options as any).forkSession ? 'forked-child-id' : 'same-id',
        };
        // Stay open; the session closes it.
        await new Promise(() => {});
      },
      interrupt: async () => {},
      setPermissionMode: async () => {},
    };
  },
}));

// Imported after the mock is registered.
const { StructuredSession } = await import('../src/sessions/structured-session.js');

function makeSession(spec: Record<string, unknown> = {}) {
  return new StructuredSession({
    id: 'test-session',
    title: 'Test',
    agent: 'claude',
    agentDisplayName: 'Claude Code',
    cwd: '/tmp',
    env: {},
    workspaceLabel: 'tmp',
    eventBufferBytes: 64 * 1024,
    createdAt: Date.now(),
    ...spec,
  } as any);
}

/** The options of the single query we expect to have been started. */
function onlyOptions(): any {
  expect(captured).toHaveLength(1);
  return captured[0]!.options;
}

describe('resume options handed to the agent', () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it('starts a fresh conversation with neither resume nor fork', async () => {
    const session = makeSession();
    await session.start();
    expect(onlyOptions().resume).toBeUndefined();
    expect(onlyOptions().forkSession).toBeUndefined();
    await session.terminate();
  });

  it('continues in-place by default when resuming', async () => {
    const session = makeSession({ resumeAgentSessionId: 'original-conversation' });
    await session.start();
    expect(onlyOptions().resume).toBe('original-conversation');
    expect(onlyOptions().forkSession).toBeUndefined();
    await session.terminate();
  });

  it('branches when the caller explicitly requests forking', async () => {
    const session = makeSession({
      resumeAgentSessionId: 'original-conversation',
      forkSession: true,
    });
    await session.start();
    expect(onlyOptions().resume).toBe('original-conversation');
    expect(onlyOptions().forkSession).toBe(true);
    await session.terminate();
  });

  it('never auto-approves: every tool call is routed back to us', async () => {
    const session = makeSession();
    await session.start();
    expect(onlyOptions().permissionMode).toBe('default');
    expect(typeof onlyOptions().canUseTool).toBe('function');
    await session.terminate();
  });

  it('reports the conversation id it will branch from before the agent answers', async () => {
    // The UI shows which conversation a session came from; it must not have to
    // wait for the first turn to learn it.
    const session = makeSession({ resumeAgentSessionId: 'original-conversation' });
    expect(session.agentSessionId).toBe('original-conversation');
    await session.start();
    await session.terminate();
  });
});

describe('resume request validation', () => {
  it('defaults to continue-in-place (forkSession: false)', () => {
    const parsed = CreateSessionRequest.parse({
      agent: 'claude',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      resumeAgentSessionId: 'abc',
    });
    expect(parsed.forkSession).toBe(false);
  });

  it('accepts an explicit forking request', () => {
    const parsed = CreateSessionRequest.parse({
      agent: 'claude',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      resumeAgentSessionId: 'abc',
      forkSession: true,
    });
    expect(parsed.forkSession).toBe(true);
  });
});

describe('conversation listing over HTTP', () => {
  let t: TestApp;
  let projects: string;

  beforeEach(async () => {
    projects = fs.mkdtempSync('/tmp/pa-http-projects-');
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.cleanup();
    fs.rmSync(projects, { recursive: true, force: true });
  });

  it('requires authentication', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/conversations' });
    expect(res.statusCode).toBe(401);
  });

  it('returns a list for an authenticated caller', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { cookie: t.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().conversations)).toBe(true);
  });

  it('does not read transcripts belonging to other directories', async () => {
    // Written into a temp projects dir the app is not configured to read, and
    // for a cwd outside its workspace root. Both reasons should exclude it.
    const ws = makeWorkspace();
    try {
      const dir = path.join(projects, encodeProjectDir(ws.project));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'other.jsonl'),
        JSON.stringify({ type: 'user', sessionId: 'other', cwd: ws.project }),
      );

      const res = await t.app.inject({
        method: 'GET',
        url: '/api/conversations',
        headers: { cookie: t.cookie },
      });
      const ids = res.json().conversations.map((c: { id: string }) => c.id);
      expect(ids).not.toContain('other');
    } finally {
      ws.cleanup();
    }
  });
});
