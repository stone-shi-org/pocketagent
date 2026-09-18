import { afterEach, describe, expect, it, vi } from 'vitest';
import { RestartRequest } from '@pocketagent/protocol';
import { RESTART_EXIT_CODE } from '../src/admin/index.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

/**
 * PA-69: drain-then-exit restart.
 *
 * The rules worth pinning here are mostly rules about what must *not* happen:
 * no restart while work is in flight, no restart into a supervisor that will
 * not bring us back, no timeout that eventually proceeds on its own, and no
 * way whatsoever for a request to name what should be installed.
 *
 * Nothing here ever exits the process: `AdminService` only ever calls a hook
 * that `server.ts` installs, and a test installs a spy instead. That seam is
 * the reason this suite can exist at all.
 */

let t: TestApp;

afterEach(async () => {
  await t?.cleanup();
});

const get = (url: string) => t.app.inject({ method: 'GET', url, headers: authHeaders(t.cookie) });
const post = (url: string, payload?: unknown) =>
  t.app.inject({
    method: 'POST',
    url,
    headers: authHeaders(t.cookie),
    ...(payload !== undefined ? { payload } : {}),
  });

/** A structured session that has been prompted, so it is genuinely mid-turn. */
async function startBusySession(title = 'refactoring the parser'): Promise<string> {
  const session = await t.context.sessions.create({
    agent: 'claude',
    cwd: t.projectDir,
    cols: 0,
    rows: 0,
    transport: 'structured',
    title,
  });
  // `busySince` is stamped by the prompt, and that is what "mid-turn" means
  // for the run queue and therefore for the drain check too.
  expect((session as unknown as { prompt: (text: string) => boolean }).prompt('go')).toBe(true);
  expect(t.context.sessions.busyTreeRoots()).toContain(t.projectDir);
  return session.id;
}

describe('GET /api/admin/drain-state', () => {
  it('needs a credential like every other /api route', async () => {
    t = await createTestApp();
    // Not in `PUBLIC_API_PATHS`, and it must never be: it enumerates what a
    // machine is working on, and `/health` is the only unauthenticated read.
    const res = await t.app.inject({ method: 'GET', url: '/api/admin/drain-state' });
    expect(res.statusCode).toBe(401);
  });

  it('reports nothing in the way, and no restart support, on a fresh app', async () => {
    t = await createTestApp();
    const body = (await get('/api/admin/drain-state')).json();
    expect(body.blockers).toEqual([]);
    // No hook installed, because `buildApp` never installs one — only
    // `server.ts` does. A test app that could exit would kill the runner.
    expect(body.restartSupported).toBe(false);
  });

  it('is readable without committing to anything', async () => {
    t = await createTestApp();
    const hook = vi.fn();
    t.context.admin.setRestartHook(hook);
    await get('/api/admin/drain-state');
    await get('/api/admin/drain-state');
    // The whole reason this route exists rather than making callers POST and
    // interpret a 409: looking must never be able to stop the server.
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/restart', () => {
  it('refuses rather than exiting when no supervisor can restart us', async () => {
    t = await createTestApp();
    const res = await post('/api/admin/restart', {});
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe('restart_unsupported');
  });

  it('accepts a clean drain, answers before exiting, and reports the exit code', async () => {
    t = await createTestApp();
    const hook = vi.fn();
    t.context.admin.setRestartHook(hook);

    const res = await post('/api/admin/restart', {});
    // 202: accepted and not yet done. The process is still up as this is read.
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.accepted).toBe(true);
    expect(body.forced).toBe(false);
    expect(body.overridden).toEqual([]);
    // Non-zero on purpose. `Restart=on-failure` — this repo's own recommended
    // unit and what production runs — ignores a clean exit, so an `exit(0)`
    // here would make this endpoint a remote off switch.
    expect(body.exitCode).toBe(RESTART_EXIT_CODE);
    expect(RESTART_EXIT_CODE).not.toBe(0);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]![0]).toEqual({ forced: false });
  });

  it('refuses while a session is mid-turn, and names it', async () => {
    t = await createTestApp();
    const hook = vi.fn();
    t.context.admin.setRestartHook(hook);
    const sessionId = await startBusySession('refactoring the parser');

    const res = await post('/api/admin/restart', {});
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe('drain_blocked');
    // The acceptance criterion is that the refusal *names* the blocker, in the
    // message and not only in a structured field — a `curl` caller sees the
    // message, and "something is running" would send them hunting.
    expect(body.error.message).toContain('refactoring the parser');
    expect(body.blockers).toHaveLength(1);
    expect(body.blockers[0].kind).toBe('session');
    expect(body.blockers[0].id).toBe(sessionId);
    expect(body.blockers[0].reason).toBe('mid_turn');
    expect(body.blockers[0].cwd).toBe(t.projectDir);
    expect(typeof body.blockers[0].since).toBe('number');
    // Nothing decays into an allow: a refusal must not have already exited.
    expect(hook).not.toHaveBeenCalled();
  });

  it('never times out into a restart while work is in flight', async () => {
    t = await createTestApp();
    t.context.admin.setRestartHook(vi.fn());
    await startBusySession();

    // Asked repeatedly, exactly as an impatient operator or a polling script
    // would. The same refusal, forever: this path has no timer anywhere, which
    // is the standing no-decay rule the approval invariants state.
    for (let i = 0; i < 3; i++) {
      expect((await post('/api/admin/restart', {})).statusCode).toBe(409);
    }
    expect((await get('/api/admin/drain-state')).json().blockers).toHaveLength(1);
  });

  it('force restarts anyway, and records what it overrode', async () => {
    t = await createTestApp();
    const hook = vi.fn();
    t.context.admin.setRestartHook(hook);
    const sessionId = await startBusySession('a long turn');

    const res = await post('/api/admin/restart', { force: true });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.forced).toBe(true);
    // Echoed back rather than silently dropped: an upgrade that interrupts a
    // turn without saying so is explicitly rejected by the ticket.
    expect(body.overridden.map((b: { id: string }) => b.id)).toEqual([sessionId]);
    expect(hook).toHaveBeenCalledWith({ forced: true });
  });

  it('reports a session parked on an approval as awaiting a human, not as running', async () => {
    t = await createTestApp();
    t.context.admin.setRestartHook(vi.fn());
    const sessionId = await startBusySession('waiting on me');

    // A real approval would come from the SDK; what matters to the drain check
    // is the distinction it draws, so drive the same accessor the service
    // reads. A turn parked on an approval is still mid-turn — `busySince` is
    // cleared only by `turn_complete` — but the thing blocking it is a person,
    // and an operator deciding whether to force needs to know which it is.
    const session = t.context.sessions.get(sessionId) as unknown as {
      pendingPermissions: () => unknown[];
    };
    const pending = [{ kind: 'permission_request' }];
    session.pendingPermissions = () => pending;

    const blockers = (await get('/api/admin/drain-state')).json().blockers;
    expect(blockers).toHaveLength(1);
    expect(blockers[0].reason).toBe('awaiting_approval');
  });
});

describe('a Pocket Agent turn blocks a drain', () => {
  /** An endpoint plus a model, the two preconditions a turn validates. */
  async function configurePlanner(): Promise<string> {
    await t.app.inject({
      method: 'PATCH',
      url: '/api/planner/settings',
      headers: authHeaders(t.cookie),
      payload: { baseUrl: 'https://api.example.com' },
    });
    const chat = (await post('/api/planner/chats', { modelId: 'gpt-4o' })).json();
    return chat.id as string;
  }

  it('sees a turn the session manager cannot', async () => {
    // The gap this closes: a Pocket Agent turn has no session, no cwd and no
    // worktree, so `busyTreeRoots` is structurally blind to it. A drain that
    // consulted only the session manager would answer "nothing in the way" and
    // then destroy a live webhook- or Telegram-driven turn with nobody
    // watching.
    let release: (() => void) | undefined;
    const hang = new Promise<Response>((resolve) => {
      release = () => resolve(new Response('data: [DONE]\n\n', { status: 200 }));
    });
    t = await createTestApp({}, undefined, undefined, undefined, (() =>
      hang) as unknown as typeof fetch);
    t.context.admin.setRestartHook(vi.fn());
    const chatId = await configurePlanner();

    const turn = t.context.plannerChats.sendMessage(chatId, 'do the thing');
    // One step: past the synchronous preconditions and the `user_prompt`
    // yield, so the turn is registered and now parked awaiting the LLM.
    await turn.next();

    expect(t.context.sessions.busyTreeRoots()).toEqual([]);
    const body = (await get('/api/admin/drain-state')).json();
    expect(body.blockers).toHaveLength(1);
    expect(body.blockers[0].kind).toBe('planner_chat');
    expect(body.blockers[0].id).toBe(chatId);
    expect(body.blockers[0].reason).toBe('mid_turn');
    // A planner workspace is app-owned scratch space, not a checkout.
    expect(body.blockers[0].cwd).toBeNull();

    expect((await post('/api/admin/restart', {})).statusCode).toBe(409);

    release?.();
    await turn.return(undefined);
  });

  it('stops blocking once the turn is over', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    t.context.admin.setRestartHook(vi.fn());
    const chatId = await configurePlanner();

    const turn = t.context.plannerChats.sendMessage(chatId, 'do the thing');
    for await (const _event of turn) {
      // drain
    }

    // The `finally` in `sendMessage` is what releases it, so an in-flight
    // failure or an abandoned stream cannot leave a tree blocked forever.
    expect((await get('/api/admin/drain-state')).json().blockers).toEqual([]);
    expect((await post('/api/admin/restart', {})).statusCode).toBe(202);
  });

  it('keeps blocking while a turn is parked on an unanswered approval', async () => {
    // Sharper than the session case: a pending planner approval lives in
    // memory only, so restarting does not pause this turn and let someone
    // answer later — it destroys the approval and the turn with it.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"write_file","arguments":"{\\"path\\":\\"x.txt\\",\\"content\\":\\"hi\\"}"}}]}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    t.context.admin.setRestartHook(vi.fn());
    const chatId = await configurePlanner();

    const events = [];
    for await (const event of t.context.plannerChats.sendMessage(chatId, 'write a file')) {
      events.push(event);
    }
    // The turn ended its own generator at the pause — that is the planner's
    // approval mechanism — so `activeTurns` is empty and only `pendingTurns`
    // knows this chat is still working.
    expect(events.some((e) => e.kind === 'permission_request')).toBe(true);

    const blockers = (await get('/api/admin/drain-state')).json().blockers;
    expect(blockers).toHaveLength(1);
    expect(blockers[0].kind).toBe('planner_chat');
    expect(blockers[0].reason).toBe('awaiting_approval');
    expect((await post('/api/admin/restart', {})).statusCode).toBe(409);
  });
});

describe('what a restart actually costs', () => {
  it('loses a structured session whatever the process backend is', async () => {
    // The ticket's acceptance criterion says "direct-backend sessions are
    // gone", which understates it in the direction that matters: production
    // runs the *tmux* backend, and a structured session does not survive there
    // either. `StructuredSession.survivesServerRestart` is hardcoded false
    // because the SDK owns the process — structured sessions bypass backends
    // entirely — so every cron run, webhook delivery and agent chat is lost on
    // restart while terminal/tmux sessions are re-adopted.
    //
    // Pinned here because the disclosure the UI shows before restarting is
    // written from it. Re-adoption itself is covered by `tmux-restart.test.ts`
    // and the `interrupted` marking by `persistence.test.ts`; this is the fact
    // neither of them states.
    t = await createTestApp();
    const id = await startBusySession();
    const session = t.context.sessions.get(id) as unknown as {
      survivesServerRestart: boolean;
      backendId: string;
    };
    expect(session.survivesServerRestart).toBe(false);
    // Not 'direct' and not 'tmux': the evidence that no backend choice can
    // change the answer above.
    expect(session.backendId).toBe('agent-sdk');
  });

  it('does not count queued work, which survives a restart by design', async () => {
    // A queued webhook delivery (`queued_spec_json`) and a queued human prompt
    // (`session_prompt_queue`) are both persisted, and both are deliberately
    // left alone by the boot sweeps, so they resume afterwards. Counting them
    // as blockers would refuse a restart to protect work in no danger — the
    // mirror of the rule that a queued delivery is a third class of row, in
    // neither `OPEN_DELIVERY` nor `NOISE_STATUSES`.
    t = await createTestApp();
    t.context.admin.setRestartHook(vi.fn());
    const busyId = await startBusySession('the one actually working');

    // A second session in the same tree; its prompt queues behind the first.
    const waiter = await t.context.sessions.create({
      agent: 'claude',
      cwd: t.projectDir,
      cols: 0,
      rows: 0,
      transport: 'structured',
      title: 'waiting its turn',
    });
    const outcome = t.context.promptQueue.submit(
      waiter as Parameters<typeof t.context.promptQueue.submit>[0],
      'my message',
    );
    expect(outcome.queued).toBe(true);

    // Exactly one blocker: the session genuinely mid-turn. The waiter holds no
    // turn, and its prompt is on disk.
    const blockers = (await get('/api/admin/drain-state')).json().blockers;
    expect(blockers.map((b: { id: string }) => b.id)).toEqual([busyId]);
  });
});

describe('the UI can never name an artifact to install', () => {
  it('accepts exactly one field, and it is not a version', () => {
    // Acceptance criterion: "No path exists by which the UI can name the
    // artifact to install." The update source is fixed at deploy time in the
    // compose file or unit. This assertion is the tripwire — adding a field
    // here has to argue with a failing test rather than slip in.
    expect(Object.keys(RestartRequest.shape)).toEqual(['force']);
  });

  it('drops anything else a caller tries to smuggle in', async () => {
    t = await createTestApp();
    const hook = vi.fn();
    t.context.admin.setRestartHook(hook);

    const res = await post('/api/admin/restart', {
      force: false,
      image: 'evil/pocketagent:latest',
      version: '9.9.9',
      ref: 'https://example.com/payload.tar.gz',
    });

    expect(res.statusCode).toBe(202);
    // Zod strips unknown keys, so the extras never reach the service — and
    // the hook takes no artifact argument at all, so there is nothing
    // downstream that could act on one even if they did.
    expect(hook).toHaveBeenCalledWith({ forced: false });
    expect(RestartRequest.parse({ force: true, image: 'x' })).toEqual({ force: true });
  });

  it('defaults force to off, so an unqualified request is the safe one', () => {
    expect(RestartRequest.parse({})).toEqual({ force: false });
  });
});
