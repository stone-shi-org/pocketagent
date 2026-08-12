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
const permissionModeCalls: string[] = [];

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
      setPermissionMode: async (mode: string) => {
        permissionModeCalls.push(mode);
      },
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
    permissionModeCalls.length = 0;
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

/**
 * The operator's global skip-permissions switch (`SessionManager.setGlobalSkipPermissions`)
 * is the one deliberate override of "never answer a prompt for the user" — see CLAUDE.md.
 * These pin what `StructuredSession.applyGlobalSkipPermissions` actually does to an
 * already-running session, independent of the manager or the HTTP layer around it.
 */
describe('global skip-permissions switch, applied to a running session', () => {
  beforeEach(() => {
    captured.length = 0;
    permissionModeCalls.length = 0;
  });

  it('is off until applied, and tracks the switch once it is', async () => {
    const session = makeSession();
    expect(session.globalBypassActive).toBe(false);
    await session.start();
    await session.applyGlobalSkipPermissions(true);
    expect(session.globalBypassActive).toBe(true);
    expect(permissionModeCalls).toEqual(['bypassPermissions']);
    await session.terminate();
  });

  it('drains an approval already parked waiting for a human, as an allow', async () => {
    const session = makeSession();
    await session.start();
    const controller = new AbortController();
    const resultPromise = onlyOptions().canUseTool('Bash', { command: 'echo hi' }, {
      signal: controller.signal,
    });
    expect(session.pendingPermissions()).toHaveLength(1);

    await session.applyGlobalSkipPermissions(true);

    await expect(resultPromise).resolves.toEqual({ behavior: 'allow' });
    expect(session.pendingPermissions()).toHaveLength(0);
    await session.terminate();
  });

  it('restores plain "default" mode when switched back off on a session with no opt-in of its own', async () => {
    const session = makeSession();
    await session.start();
    await session.applyGlobalSkipPermissions(true);
    await session.applyGlobalSkipPermissions(false);
    expect(session.globalBypassActive).toBe(false);
    expect(permissionModeCalls).toEqual(['bypassPermissions', 'default']);
    await session.terminate();
  });

  it('leaves bypassPermissions in place when switched off on a session that opted in itself', async () => {
    const session = makeSession({ skipPermissions: true });
    await session.start();
    await session.applyGlobalSkipPermissions(true);
    permissionModeCalls.length = 0;
    await session.applyGlobalSkipPermissions(false);
    // The session's own opt-in still applies — turning off the *global*
    // switch must not silently start asking for approval on a session that
    // separately chose to bypass it.
    expect(permissionModeCalls).toEqual(['bypassPermissions']);
    await session.terminate();
  });

  it('never mutates spec — history and persistence still show what the session actually started with', async () => {
    const session = makeSession();
    await session.start();
    await session.applyGlobalSkipPermissions(true);
    expect(session.spec.skipPermissions).not.toBe(true);
    await session.terminate();
  });
});

/**
 * The SDK's built-in `AskUserQuestion` tool rides the exact same `canUseTool`
 * channel as every other tool, but the human's answer has to travel back as
 * the tool's own `updatedInput` rather than a bare allow — see the
 * `resolvePermission` comment. A plain allow with no answer is what used to
 * make the agent report the call as failed and fall back to asking in plain
 * text.
 */
describe('AskUserQuestion: a question, not an approval', () => {
  beforeEach(() => {
    captured.length = 0;
    permissionModeCalls.length = 0;
  });

  const QUESTION_INPUT = {
    questions: [
      {
        question: 'Which library should we use?',
        header: 'Library',
        options: [
          { label: 'date-fns', description: 'Smaller, tree-shakeable' },
          { label: 'moment', description: 'Legacy, larger bundle' },
        ],
        multiSelect: false,
      },
    ],
  };

  it('parses the question onto the emitted event instead of leaving it as raw JSON', async () => {
    const session = makeSession();
    await session.start();
    const controller = new AbortController();
    void onlyOptions().canUseTool('AskUserQuestion', QUESTION_INPUT, { signal: controller.signal });

    const pending = session.pendingPermissions();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.questions).toEqual(QUESTION_INPUT.questions);
    await session.terminate();
  });

  it('does not parse a question for an ordinary tool call', async () => {
    const session = makeSession();
    await session.start();
    const controller = new AbortController();
    void onlyOptions().canUseTool('Bash', { command: 'ls' }, { signal: controller.signal });

    expect(session.pendingPermissions()[0]?.questions).toBeNull();
    await session.terminate();
  });

  it('falls back to null rather than throwing when the input does not match the schema', async () => {
    const session = makeSession();
    await session.start();
    const controller = new AbortController();
    void onlyOptions().canUseTool('AskUserQuestion', { questions: 'not an array' }, {
      signal: controller.signal,
    });

    expect(session.pendingPermissions()[0]?.questions).toBeNull();
    await session.terminate();
  });

  it('hands the chosen answer back as updatedInput, not a bare allow', async () => {
    const session = makeSession();
    await session.start();
    const controller = new AbortController();
    const resultPromise = onlyOptions().canUseTool('AskUserQuestion', QUESTION_INPUT, {
      signal: controller.signal,
    });

    const id = session.pendingPermissions()[0]?.id;
    expect(id).toBeDefined();
    session.resolvePermission(id!, 'allow', undefined, {
      answers: { 'Which library should we use?': 'date-fns' },
    });

    await expect(resultPromise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {
        ...QUESTION_INPUT,
        answers: { 'Which library should we use?': 'date-fns' },
      },
    });
    await session.terminate();
  });

  it('still supports a bare allow when the client sends no structured answer', async () => {
    // Backward compatibility / a client that has not been updated: this is the
    // pre-fix behaviour, deliberately preserved for every *other* tool.
    const session = makeSession();
    await session.start();
    const controller = new AbortController();
    const resultPromise = onlyOptions().canUseTool('Bash', { command: 'ls' }, {
      signal: controller.signal,
    });
    const id = session.pendingPermissions()[0]?.id;
    session.resolvePermission(id!, 'allow');
    await expect(resultPromise).resolves.toEqual({ behavior: 'allow' });
    await session.terminate();
  });

  it('leaves a pending question for the human instead of guessing an answer when the global switch is flipped on', async () => {
    const session = makeSession();
    await session.start();
    const controller = new AbortController();
    const resultPromise = onlyOptions().canUseTool('AskUserQuestion', QUESTION_INPUT, {
      signal: controller.signal,
    });

    await session.applyGlobalSkipPermissions(true);

    // Unlike every other tool, this must NOT have been auto-resolved.
    expect(session.pendingPermissions()).toHaveLength(1);

    const id = session.pendingPermissions()[0]!.id;
    session.resolvePermission(id, 'allow', undefined, { answers: { 'Which library should we use?': 'moment' } });
    await expect(resultPromise).resolves.toMatchObject({ behavior: 'allow' });
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
