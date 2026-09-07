import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JIRA_SAMPLE_PAYLOAD, pocketAgentId } from '@pocketagent/protocol';
import { resolveLabelOverrides } from '../src/webhooks/jira.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

/**
 * PA-10: an inbound webhook whose agent is a **Pocket Agent** rather than a
 * coding agent.
 *
 * The weight here is on the three places the two run kinds genuinely differ,
 * because everything upstream of the trigger (signature, freshness,
 * idempotency, filter, caps) is unchanged and already covered by
 * `webhooks.test.ts`:
 *
 * - **The run produces a chat, not a session.** The delivery links to
 *   `plannerChatId`, and `dispatch` must not read "no session" as "failed" —
 *   the bug the old `sessionId !== null` success test would have had.
 * - **The approval gate.** `skipPermissions` off must *park* the turn (nothing
 *   runs, nothing decays into an allow, no timeout); on must pre-approve it.
 * - **The Jira label.** `agent:pocket-<slug>` is the half of the ticket that
 *   only works because the agent id has one value space.
 */

let t: TestApp;

afterEach(async () => {
  await t.cleanup();
});

// ---- HTTP plumbing, mirroring webhooks.test.ts ------------------------------

const post = (app: TestApp, url: string, payload?: unknown) =>
  app.app.inject({
    method: 'POST',
    url,
    headers: authHeaders(app.cookie),
    ...(payload !== undefined ? { payload } : {}),
  });

const get = (app: TestApp, url: string) =>
  app.app.inject({ method: 'GET', url, headers: authHeaders(app.cookie) });

const patch = (app: TestApp, url: string, payload: unknown) =>
  app.app.inject({ method: 'PATCH', url, headers: authHeaders(app.cookie), payload });

const sign = (secret: string, body: string): string =>
  `sha256=${crypto.createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;

const payloadFor = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...(JIRA_SAMPLE_PAYLOAD as object), timestamp: Date.now(), ...over });

function deliver(app: TestApp, slug: string, secret: string, body: string) {
  return app.app.inject({
    method: 'POST',
    url: `/api/hooks/${slug}`,
    headers: { 'content-type': 'application/json', 'x-hub-signature': sign(secret, body) },
    payload: body,
  });
}

// ---- Fake LLM --------------------------------------------------------------

function sseResponse(dataLines: string[]): Response {
  const body = dataLines.map((line) => `data: ${line}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const textReply = (content: string): Response =>
  sseResponse([JSON.stringify({ choices: [{ delta: { content } }] })]);

const toolCallReply = (name: string, args: Record<string, unknown>): Response =>
  sseResponse([
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', function: { name, arguments: JSON.stringify(args) } },
            ],
          },
        },
      ],
    }),
  ]);

/**
 * A webhook pointed at a fresh Pocket Agent, with the LLM endpoint configured.
 *
 * `plannerLlmFetch` is the fifth positional argument to `createTestApp`, so a
 * pocket run never makes a real network call — the same seam
 * `planner-chats.test.ts` uses.
 */
async function setupPocketWebhook(
  fetchImpl: ReturnType<typeof vi.fn>,
  over: Record<string, unknown> = {},
): Promise<{
  agentId: string;
  workspaceId: string;
  workspacePath: string;
  slug: string;
  secret: string;
  hookId: string;
}> {
  t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
  await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });

  const ws = (await post(t, '/api/planner/workspaces', { name: 'Release Notes' })).json();
  const agentId = pocketAgentId(ws.id);

  const res = await post(t, '/api/webhooks', {
    name: 'Triage via pocket',
    slug: 'pocket-triage',
    cwd: t.projectDir,
    agent: agentId,
    model: 'gpt-4o-mini',
    config: { type: 'jira', filter: {} },
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json();
  return {
    agentId,
    workspaceId: ws.id,
    workspacePath: ws.path,
    slug: body.webhook.slug,
    secret: body.secret,
    hookId: body.webhook.id,
  };
}

/**
 * A pocket run settles asynchronously: `startPocketAgent` returns once the
 * turn's first event has been pulled, and `turn_complete` arrives through the
 * observer a few microtasks later. Polling the delivery row is how the run
 * pipeline is already observed elsewhere, and it keeps the "no timeout
 * anywhere in the approval path" rule honest — this waits for a *status*, never
 * for a duration.
 */
async function deliveryFor(
  app: TestApp,
  hookId: string,
  predicate: (d: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const deliveries = (await get(app, `/api/webhooks/${hookId}/deliveries`)).json().deliveries;
    const match = (deliveries as Record<string, unknown>[]).find(predicate);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no delivery matched in time');
}

/**
 * Poll a chat's transcript until it contains an event of this kind.
 *
 * Necessary because `onPlannerChat` flips the delivery row to `running` the
 * moment the chat exists — before the turn has emitted anything — so a delivery
 * status of `running` is not evidence that a `permission_request` has landed
 * yet. The parked case has no later status change to wait on by construction,
 * which is the whole point of it.
 */
async function eventOfKind(
  app: TestApp,
  chatId: string,
  kind: string,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const events = (await get(app, `/api/planner/chats/${chatId}/history`)).json()
      .events as Record<string, unknown>[];
    const match = events.find((e) => e.kind === kind);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no ${kind} event in time`);
}

// ---------------------------------------------------------------------------

describe('webhook agent validation accepts a Pocket Agent', () => {
  it('creates a webhook whose agent is a Pocket Agent, and names it in the DTO', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => textReply('ok'));
    const { hookId, agentId } = await setupPocketWebhook(fetchImpl);

    const hook = (await get(t, `/api/webhooks/${hookId}`)).json();
    expect(hook.agent).toBe(agentId);
    // Not the raw `pocket:<uuid>` — an operator has to be able to tell which
    // agent this is from the list row alone.
    expect(hook.agentDisplayName).toBe('Pocket Agent · Release Notes');
  });

  it('refuses a Pocket Agent id that names no planner workspace', async () => {
    t = await createTestApp();
    const res = await post(t, '/api/webhooks', {
      name: 'Bad pocket',
      slug: 'bad-pocket',
      cwd: t.projectDir,
      agent: pocketAgentId('does-not-exist'),
      config: { type: 'jira', filter: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/No such Pocket Agent/);
  });

  it('still refuses a coding agent with no structured mode', async () => {
    // The widening must not have loosened the original check.
    t = await createTestApp();
    const res = await post(t, '/api/webhooks', {
      name: 'Shell hook',
      slug: 'shell-hook',
      cwd: t.projectDir,
      agent: 'shell',
      config: { type: 'jira', filter: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/no structured mode/);
  });

  it('refuses a Pocket Agent on a PATCH too, not only on create', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => textReply('ok'));
    const { hookId } = await setupPocketWebhook(fetchImpl);
    const res = await patch(t, `/api/webhooks/${hookId}`, { agent: pocketAgentId('nope') });
    expect(res.statusCode).toBe(400);
  });
});

describe('a Pocket Agent webhook delivery', () => {
  it('runs the rendered prompt in a new chat and succeeds with no session at all', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => textReply('Triaged it.'));
    const { slug, secret, hookId, workspaceId } = await setupPocketWebhook(fetchImpl);

    const res = await deliver(t, slug, secret, payloadFor());
    expect(res.statusCode).toBe(202);

    const delivery = await deliveryFor(t, hookId, (d) => d.status === 'succeeded');
    // The load-bearing assertion: a pocket run has no session, and that is a
    // success rather than the failure `dispatch`'s old test would have recorded.
    expect(delivery.sessionId).toBeNull();
    expect(delivery.agentSessionId).toBeNull();
    expect(delivery.plannerChatId).toEqual(expect.any(String));
    expect(delivery.error).toBeNull();

    // The chat is real, belongs to the chosen agent, and holds the prompt.
    const chats = (await get(t, `/api/planner/chats?workspaceId=${workspaceId}`)).json().chats;
    expect(chats).toHaveLength(1);
    expect(chats[0].id).toBe(delivery.plannerChatId);

    const events = (await get(t, `/api/planner/chats/${chats[0].id}/history`)).json().events;
    const userPrompt = events.find((e: { kind: string }) => e.kind === 'user_prompt');
    expect(userPrompt.text).toContain('PA-123');
    expect(events.some((e: { kind: string }) => e.kind === 'turn_complete')).toBe(true);

    // The webhook's configured model reached the LLM call.
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(init.body as string).model).toBe('gpt-4o-mini');
  });

  it('writes the transcript under the Pocket Agent workspace, not a worktree', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => textReply('done'));
    const { slug, secret, hookId, workspaceId } = await setupPocketWebhook(fetchImpl, {
      // Explicitly asked for per-delivery worktrees; a pocket run has no
      // checkout to branch, so this must be ignored rather than acted on.
      worktreeMode: 'new-branch',
    });

    await deliver(t, slug, secret, payloadFor());
    const delivery = await deliveryFor(t, hookId, (d) => d.status === 'succeeded');

    const ws = (await get(t, '/api/planner/workspaces')).json().workspaces.find(
      (w: { id: string }) => w.id === workspaceId,
    );
    const transcript = path.join(ws.path, '.transcripts', `${String(delivery.plannerChatId)}.jsonl`);
    expect(await fs.readFile(transcript, 'utf8')).toContain('user_prompt');

    // And no worktree was made under the project.
    await expect(fs.readdir(path.join(t.projectDir, '.worktrees'))).rejects.toThrow();
  });

  it('reuses one chat per issue in per-issue mode, and a fresh one per delivery otherwise', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => textReply('ok'));
    const { slug, secret, hookId, workspaceId } = await setupPocketWebhook(fetchImpl, {
      conversationMode: 'per-issue',
      debounceSeconds: 0,
      overlapPolicy: 'allow',
    });

    await deliver(t, slug, secret, payloadFor({ timestamp: Date.now() }));
    const first = await deliveryFor(t, hookId, (d) => d.status === 'succeeded');

    // A different body (so idempotency does not swallow it) for the same issue.
    await deliver(t, slug, secret, payloadFor({ timestamp: Date.now() + 1 }));
    const second = await deliveryFor(
      t,
      hookId,
      (d) => d.status === 'succeeded' && d.id !== first.id,
    );

    expect(second.plannerChatId).toBe(first.plannerChatId);
    const chats = (await get(t, `/api/planner/chats?workspaceId=${workspaceId}`)).json().chats;
    expect(chats).toHaveLength(1);
  });

  it('records a failure when the Pocket Agent has no LLM endpoint configured', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => textReply('ok'));
    const { slug, secret, hookId } = await setupPocketWebhook(fetchImpl);
    // Clear the endpoint after the webhook was saved — a real, and entirely
    // likely, way for a configured webhook to stop being runnable.
    await patch(t, '/api/planner/settings', { baseUrl: null });

    await deliver(t, slug, secret, payloadFor());
    const delivery = await deliveryFor(t, hookId, (d) => d.status === 'failed');
    expect(delivery.error).toMatch(/not configured/i);
  });

  it('fails the delivery, rather than throwing, when the Pocket Agent was deleted', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => textReply('ok'));
    const { slug, secret, hookId, workspaceId } = await setupPocketWebhook(fetchImpl);
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/api/planner/workspaces/${workspaceId}`,
      headers: authHeaders(t.cookie),
    });
    expect(del.statusCode).toBe(204);

    await deliver(t, slug, secret, payloadFor());
    const delivery = await deliveryFor(t, hookId, (d) => d.status === 'failed');
    expect(delivery.error).toMatch(/no longer exists/);

    // The webhook itself still describes itself, with the bare id as the
    // fallback display name — an orphaned row must still be readable.
    const hook = (await get(t, `/api/webhooks/${hookId}`)).json();
    expect(hook.agentDisplayName).toBe(hook.agent);
  });
});

describe('the approval gate on a Pocket Agent webhook run', () => {
  it('parks the turn — nothing runs, nothing decays into an allow — with skipPermissions off', async () => {
    // One mutating tool call, then (if it were ever allowed to continue) a
    // reply. `write_file` is gated, so the second response must never be asked
    // for.
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() =>
        toolCallReply('write_file', { path: '/tmp/should-never-exist-pa10', content: 'x' }),
      )
      .mockImplementation(() => textReply('continued'));

    const { slug, secret, hookId } = await setupPocketWebhook(fetchImpl);
    // The default, asserted rather than assumed: a webhook does not inherit
    // cron's inverted default.
    expect((await get(t, `/api/webhooks/${hookId}`)).json().skipPermissionsEnabled).toBe(false);

    await deliver(t, slug, secret, payloadFor());

    // The delivery reaches `running` and stays there: parked is genuinely still
    // running, and there is no timeout to rescue it.
    const delivery = await deliveryFor(t, hookId, (d) => d.status === 'running');
    const chatId = String(delivery.plannerChatId);

    await eventOfKind(t, chatId, 'permission_request');
    const events = (await get(t, `/api/planner/chats/${chatId}/history`)).json().events;
    // Nothing executed, and the model was never asked what to do next.
    expect(events.some((e: { kind: string }) => e.kind === 'tool_result')).toBe(false);
    expect(events.some((e: { kind: string }) => e.kind === 'turn_complete')).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(fs.stat('/tmp/should-never-exist-pa10')).rejects.toThrow();

    // Still running after a sweep — the sweep must not force-fail a parked run.
    t.context.webhooks.sweep();
    const after = (await get(t, `/api/webhooks/${hookId}/deliveries`)).json().deliveries[0];
    expect(after.status).toBe('running');
  });

  it('settles the delivery when a human answers the parked approval later', async () => {
    // Absolute, and inside the Pocket Agent's own workspace — a relative path
    // would resolve against the server process's cwd, which is not what this
    // test is about.
    let target = '';
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() => toolCallReply('mkdir', { path: target }))
      .mockImplementation(() => textReply('all done'));

    const { slug, secret, hookId, workspacePath } = await setupPocketWebhook(fetchImpl);
    target = path.join(workspacePath, 'made-by-pa10');
    await deliver(t, slug, secret, payloadFor());
    const parked = await deliveryFor(t, hookId, (d) => d.status === 'running');
    const chatId = String(parked.plannerChatId);

    const request = await eventOfKind(t, chatId, 'permission_request');

    // The human answers in the Pocket Agent UI, which streams to *their*
    // browser — the webhook's sink learns of it only through the chat observer.
    // That is the whole reason `PlannerChatService.observe` exists.
    const resolved = await post(t, `/api/planner/chats/${chatId}/approvals/${request.id}`, {
      decision: 'allow_once',
    });
    expect(resolved.statusCode).toBe(200);

    const settled = await deliveryFor(
      t,
      hookId,
      (d) => d.id === parked.id && d.status === 'succeeded',
    );
    expect(settled.error).toBeNull();

    expect((await fs.stat(target)).isDirectory()).toBe(true);
  });

  it('pre-approves the chat when skipPermissions is on, and says so on the chat', async () => {
    let target = '';
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() => toolCallReply('mkdir', { path: target }))
      .mockImplementation(() => textReply('made it'));

    const { slug, secret, hookId, workspacePath } = await setupPocketWebhook(fetchImpl, {
      skipPermissions: true,
    });
    target = path.join(workspacePath, 'auto-approved-pa10');

    await deliver(t, slug, secret, payloadFor());
    const delivery = await deliveryFor(t, hookId, (d) => d.status === 'succeeded');
    const chatId = String(delivery.plannerChatId);

    const result = await eventOfKind(t, chatId, 'tool_result');
    expect(result.isError).toBe(false);
    const events = (await get(t, `/api/planner/chats/${chatId}/history`)).json().events;
    expect(events.some((e: { kind: string }) => e.kind === 'permission_request')).toBe(false);

    expect((await fs.stat(target)).isDirectory()).toBe(true);

    // Disclosure, per CLAUDE.md's first invariant: the chat says so
    // persistently, not just at the moment it was created. Asserted through the
    // list, which is what `PlannerChatPage` reads the flag from.
    const listed = (await get(t, '/api/planner/chats')).json().chats.find(
      (c: { id: string }) => c.id === chatId,
    );
    expect(listed.skipToolApprovalsEnabled).toBe(true);

    // And the bypass is not persisted as a remembered decision — turning the
    // webhook's toggle off must not leave the tool looking individually
    // approved for everyone.
    expect((await get(t, '/api/planner/tool-approvals')).json().approvals).toEqual([]);
  });

  it('settles a parked pocket run exactly once when the server shuts down', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() => toolCallReply('mkdir', { path: '/tmp/pa10-shutdown' }))
      .mockImplementation(() => textReply('never reached'));

    const { slug, secret, hookId } = await setupPocketWebhook(fetchImpl);
    await deliver(t, slug, secret, payloadFor());
    const parked = await deliveryFor(t, hookId, (d) => d.status === 'running');
    await eventOfKind(t, String(parked.plannerChatId), 'permission_request');

    // `abandonAll` settles the sink directly and clears the executor's
    // in-flight map, while the background drain pumping the generator can
    // outlive that call by a microtask — `settle`'s in-flight guard is what
    // keeps that from reporting the same delivery settled twice.
    t.context.webhooks.stop();

    const settled = (await get(t, `/api/webhooks/${hookId}/deliveries`)).json().deliveries[0];
    expect(settled.status).toBe('failed');
    expect(settled.error).toMatch(/shut down/i);
    expect(settled.finishedAt).toEqual(expect.any(Number));
  });

  it('never sets the bypass on a chat a human created over HTTP', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => textReply('ok'));
    await setupPocketWebhook(fetchImpl);
    // Even if a client tries to ask for it, the schema has no such field.
    const chat = (await post(t, '/api/planner/chats', { skipToolApprovals: true })).json();
    expect(chat.skipToolApprovalsEnabled).toBe(false);
  });
});

describe('the Jira label can name a Pocket Agent', () => {
  it('resolves agent:pocket-<slug> against the live Pocket Agent list', () => {
    const pocketAgents = [
      { id: 'ws-1', name: 'Release Notes' },
      { id: 'ws-2', name: 'Docs & Diagrams' },
    ];

    expect(resolveLabelOverrides(['agent:pocket-release-notes'], ['claude'], pocketAgents)).toEqual({
      agent: pocketAgentId('ws-1'),
    });
    // The slug shape matches `PlannerWorkspaceRegistry`'s own directory naming,
    // so `&` collapses to a separator rather than surviving.
    expect(resolveLabelOverrides(['agent-pocket-docs-diagrams'], ['claude'], pocketAgents)).toEqual({
      agent: pocketAgentId('ws-2'),
    });
    // Coding agents still resolve, and are not shadowed by the namespace.
    expect(resolveLabelOverrides(['agent:claude'], ['claude'], pocketAgents)).toEqual({
      agent: 'claude',
    });
    // An unknown Pocket Agent is ignored, leaving the configured agent in
    // place, exactly as an unknown coding agent already is.
    expect(resolveLabelOverrides(['agent:pocket-nope'], ['claude'], pocketAgents)).toEqual({});
    // Omitting the list keeps every pre-PA-10 caller behaving identically.
    expect(resolveLabelOverrides(['agent:pocket-release-notes'], ['claude'])).toEqual({});
  });

  it('moves a delivery from a coding agent to a Pocket Agent, and records what ran', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => textReply('handled by the pocket agent'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const ws = (await post(t, '/api/planner/workspaces', { name: 'Release Notes' })).json();

    // Configured with a *coding* agent, with label auto-select on.
    const created = (
      await post(t, '/api/webhooks', {
        name: 'Label routed',
        slug: 'label-routed',
        cwd: t.projectDir,
        agent: 'claude',
        model: 'gpt-4o-mini',
        autoSelectAgentModel: true,
        config: { type: 'jira', filter: {} },
      })
    ).json();

    const body = payloadFor({
      issue: {
        ...(JIRA_SAMPLE_PAYLOAD as { issue: Record<string, unknown> }).issue,
        fields: {
          ...((JIRA_SAMPLE_PAYLOAD as { issue: { fields: Record<string, unknown> } }).issue.fields),
          labels: ['agent:pocket-release-notes'],
        },
      },
    });
    await deliver(t, created.webhook.slug, created.secret, body);

    const delivery = await deliveryFor(t, created.webhook.id, (d) => d.status === 'succeeded');
    expect(delivery.plannerChatId).toEqual(expect.any(String));
    expect(delivery.sessionId).toBeNull();
    // The row records the agent that actually ran, not the configured one —
    // otherwise the history would claim a claude session that never existed.
    expect(delivery.agent).toBe(pocketAgentId(ws.id));

    const chats = (await get(t, `/api/planner/chats?workspaceId=${ws.id}`)).json().chats;
    expect(chats).toHaveLength(1);
  });

  it('starts a new chat when a label names a different Pocket Agent (PA-26)', async () => {
    // The pocket half of PA-26. A chat belongs to the Pocket Agent that has
    // been having it — its own tools, model and workspace — so continuing it
    // under a *different* agent would honour the label for the run and ignore
    // it for the conversation.
    const fetchImpl = vi.fn().mockImplementation(() => textReply('ok'));
    const { slug, secret, hookId, workspaceId } = await setupPocketWebhook(fetchImpl, {
      conversationMode: 'per-issue',
      autoSelectAgentModel: true,
      overlapPolicy: 'allow',
    });
    // A second Pocket Agent for the label to name.
    const other = (await post(t, '/api/planner/workspaces', { name: 'Docs Bot' })).json();

    await deliver(t, slug, secret, payloadFor({ timestamp: Date.now() }));
    const first = await deliveryFor(t, hookId, (d) => d.status === 'succeeded');

    const relabelled = payloadFor({
      timestamp: Date.now() + 1,
      issue: {
        ...(JIRA_SAMPLE_PAYLOAD as { issue: Record<string, unknown> }).issue,
        fields: {
          ...((JIRA_SAMPLE_PAYLOAD as { issue: { fields: Record<string, unknown> } }).issue.fields),
          labels: ['agent:pocket-docs-bot'],
        },
      },
    });
    await deliver(t, slug, secret, relabelled);
    const second = await deliveryFor(
      t,
      hookId,
      (d) => d.status === 'succeeded' && d.id !== first.id,
    );

    // Not the first chat, and in the agent the label named.
    expect(second.plannerChatId).not.toBe(first.plannerChatId);
    expect(second.agent).toBe(pocketAgentId(other.id));
    const mine = (await get(t, `/api/planner/chats?workspaceId=${workspaceId}`)).json().chats;
    const theirs = (await get(t, `/api/planner/chats?workspaceId=${other.id}`)).json().chats;
    expect(mine.map((c: { id: string }) => c.id)).toEqual([first.plannerChatId]);
    expect(theirs.map((c: { id: string }) => c.id)).toEqual([second.plannerChatId]);

    // And a third delivery back on the configured agent does not land in the
    // chat the label detoured to — the mismatch check works in both
    // directions. It starts a fresh chat rather than rejoining the *first*
    // one: the cache holds a single conversation per issue, so the abandoned
    // chat is no longer reachable through this webhook. That is the same
    // documented limitation a pruned cache row already has, and it is still
    // strictly better than continuing another agent's transcript.
    await deliver(t, slug, secret, payloadFor({ timestamp: Date.now() + 2 }));
    const third = await deliveryFor(
      t,
      hookId,
      (d) => d.status === 'succeeded' && d.id !== first.id && d.id !== second.id,
    );
    expect(third.plannerChatId).not.toBe(second.plannerChatId);
    expect(third.plannerChatId).not.toBe(first.plannerChatId);
    expect(third.agent).toBe(pocketAgentId(workspaceId));
  });

  it('never queues on a directory, because it occupies none (PA-11)', async () => {
    // The directory queue serializes deliveries that would share a *working
    // tree*. A Pocket Agent run has no cwd, no worktree and no session — its
    // workspace is app-owned planner scratch space — so it must take no queue
    // key at all. Keying it on the webhook's configured `cwd` (which is what a
    // coding delivery with `worktreeMode: 'none'` uses) would make two pocket
    // deliveries serialize behind a directory neither of them ever touches.
    const fetchImpl = vi.fn().mockImplementation(() => textReply('ok'));
    const { hookId, slug, secret } = await setupPocketWebhook(fetchImpl, {
      // `allow` so the *conversation* gate cannot be what lets these through:
      // the only thing under test is the directory gate.
      overlapPolicy: 'allow',
      maxConcurrent: 5,
    });

    await deliver(t, slug, secret, payloadFor({ timestamp: Date.now() }));
    await deliver(t, slug, secret, payloadFor({ timestamp: Date.now() + 1 }));

    const deliveries = (await get(t, `/api/webhooks/${hookId}/deliveries`)).json()
      .deliveries as Record<string, unknown>[];
    expect(deliveries).toHaveLength(2);
    for (const d of deliveries) {
      expect(d.status).not.toBe('queued');
      expect(d.queueKey).toBeNull();
    }
  });
});
