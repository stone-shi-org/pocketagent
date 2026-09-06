import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StructuredLikeSession } from '../src/sessions/manager.js';
import { readQueuedPrompts } from '../src/db/index.js';
import { createTestApp, type TestApp } from './helpers.js';

/**
 * A human's own follow-up prompt, waiting for a busy working tree (PA-11).
 *
 * The riskiest half of the feature, so the assertions are mostly about what
 * must never happen to a message a person actually typed: never silently
 * dropped, never lost to a restart, and always escapable.
 */

let ctx: TestApp;

beforeEach(async () => {
  ctx = await createTestApp();
});

afterEach(async () => {
  await ctx.cleanup();
});

/** A structured session in `cwd`, optionally already mid-turn. */
async function session(cwd: string, busy = false): Promise<StructuredLikeSession> {
  const created = await ctx.context.sessions.create({
    agent: 'claude',
    cwd,
    cols: 0,
    rows: 0,
    transport: 'structured',
    title: 'chat',
  });
  expect(created.transport).toBe('structured');
  const structured = created as StructuredLikeSession;
  if (busy) expect(structured.prompt('working')).toBe(true);
  return structured;
}

describe('PromptQueueService', () => {
  it('sends a prompt straight through when nothing holds the tree', async () => {
    const mine = await session(ctx.projectDir);
    // `queued: false` means "carry on as before": the existing prompt path is
    // untouched in the common case.
    expect(ctx.context.promptQueue.submit(mine, 'hello')).toEqual({ queued: false });
    expect(readQueuedPrompts(ctx.db)).toHaveLength(0);
  });

  it('does not queue behind the session\'s own turn', async () => {
    // A second prompt into a session that is already working is the agent's
    // business, not the queue's — deferring it here would break
    // interrupt-and-redirect for no benefit.
    const mine = await session(ctx.projectDir, true);
    expect(ctx.context.promptQueue.submit(mine, 'and also this')).toEqual({ queued: false });
  });

  it('queues behind another session working in the same tree, and says so', async () => {
    const other = await session(ctx.projectDir, true);
    const mine = await session(ctx.projectDir);

    const events: string[] = [];
    ctx.context.promptQueue.subscribe({
      onQueued: (sessionId, _promptId, position) => events.push(`queued:${sessionId}:${position}`),
      onReleased: (sessionId, _promptId, reason) => events.push(`released:${sessionId}:${reason}`),
    });

    const outcome = ctx.context.promptQueue.submit(mine, 'my message');
    expect(outcome.queued).toBe(true);
    if (!outcome.queued) throw new Error('unreachable');
    expect(outcome.position).toBe(1);
    expect(outcome.treeRoot).toBe(ctx.projectDir);
    // Told immediately: a typed message that appears to vanish is the one
    // outcome this must never produce.
    expect(events).toEqual([`queued:${mine.id}:1`]);

    // Persisted, so a restart cannot eat it.
    const rows = readQueuedPrompts(ctx.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe('my message');
    expect(rows[0]?.session_id).toBe(mine.id);

    // And visible to whoever reattaches, plus on the project tree.
    expect(ctx.context.promptQueue.forSession(mine.id)).toHaveLength(1);
    expect(ctx.context.promptQueue.queuedByTree().get(ctx.projectDir)).toHaveLength(1);

    // The other agent concludes; the message goes in by itself.
    ctx.context.sessions.terminate(other.id);
    await vi.waitFor(() => {
      expect(readQueuedPrompts(ctx.db)).toHaveLength(0);
      expect(events).toContain(`released:${mine.id}:sent`);
    }, 10_000);
  });

  it('cancels a waiting prompt on request', async () => {
    await session(ctx.projectDir, true);
    const mine = await session(ctx.projectDir);
    const released: string[] = [];
    ctx.context.promptQueue.subscribe({
      onQueued: () => undefined,
      onReleased: (_s, _p, reason) => released.push(reason),
    });

    const outcome = ctx.context.promptQueue.submit(mine, 'never mind');
    if (!outcome.queued) throw new Error('expected it to queue');
    expect(ctx.context.promptQueue.resolve(outcome.promptId, 'cancel')).toBe(true);

    expect(readQueuedPrompts(ctx.db)).toHaveLength(0);
    expect(released).toEqual(['cancelled']);
    // Gone for good: a second attempt has nothing to act on.
    expect(ctx.context.promptQueue.resolve(outcome.promptId, 'cancel')).toBe(false);
  });

  it('sends a waiting prompt anyway when the human insists', async () => {
    // `force` is the only thing anywhere that bypasses tree occupancy, and it
    // exists only here — where a person is present to own the consequence. An
    // override they can see beats one they cannot.
    const other = await session(ctx.projectDir, true);
    const mine = await session(ctx.projectDir);
    const released: string[] = [];
    ctx.context.promptQueue.subscribe({
      onQueued: () => undefined,
      onReleased: (_s, _p, reason) => released.push(reason),
    });

    const outcome = ctx.context.promptQueue.submit(mine, 'go now');
    if (!outcome.queued) throw new Error('expected it to queue');

    // The other session is still mid-turn, and it stays that way.
    expect(ctx.context.sessions.busyTreeRoots()).toContain(ctx.projectDir);
    expect(ctx.context.promptQueue.resolve(outcome.promptId, 'force')).toBe(true);
    expect(released).toEqual(['sent']);
    expect(readQueuedPrompts(ctx.db)).toHaveLength(0);
    expect(ctx.context.sessions.find(other.id)?.status).toBe('running');
  });

  it('is not blocked by a busy terminal session in the same tree', async () => {
    // `busyTreeRoots` deliberately excludes terminal sessions — a PTY has no
    // end-of-turn signal, so counting one would mean a queue that never drains.
    // This check has to use the same rule, or a prompt would park behind a
    // holder the queue itself does not believe in and only the sweep would
    // release it.
    const shell = await ctx.context.sessions.create({
      agent: 'shell',
      cwd: ctx.projectDir,
      cols: 80,
      rows: 24,
    });
    expect(shell.transport).toBe('terminal');
    const mine = await session(ctx.projectDir);
    expect(ctx.context.promptQueue.submit(mine, 'hello')).toEqual({ queued: false });
  });

  it('sends rather than drops when the queue is full', async () => {
    // The depth cap exists to bound a machine-generated burst. A person
    // pressing send is not that, and refusing their message would be worse
    // than the contention the queue is avoiding.
    const queue = ctx.context.webhooks.runQueue;
    await session(ctx.projectDir, true);
    const mine = await session(ctx.projectDir);
    vi.spyOn(queue, 'enqueue').mockReturnValue(false);

    expect(ctx.context.promptQueue.submit(mine, 'still send me')).toEqual({ queued: false });
    expect(readQueuedPrompts(ctx.db)).toHaveLength(0);
  });

  it('gives up on a waiting prompt whose session has gone', async () => {
    const other = await session(ctx.projectDir, true);
    const mine = await session(ctx.projectDir);
    const released: string[] = [];
    ctx.context.promptQueue.subscribe({
      onQueued: () => undefined,
      onReleased: (_s, _p, reason) => released.push(reason),
    });

    const outcome = ctx.context.promptQueue.submit(mine, 'orphan');
    if (!outcome.queued) throw new Error('expected it to queue');

    // The chat itself is dropped while its message waits. There is nothing to
    // deliver into, and the tree must not stay claimed by it.
    ctx.context.sessions.terminate(mine.id);
    ctx.context.sessions.forget(mine.id);
    ctx.context.sessions.terminate(other.id);

    await vi.waitFor(() => {
      expect(readQueuedPrompts(ctx.db)).toHaveLength(0);
      expect(released).toContain('cancelled');
    }, 10_000);
  });
});
