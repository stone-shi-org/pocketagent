import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authHeaders, createTestApp, waitFor, type TestApp } from './helpers.js';
import { TelegramBridge } from '../src/telegram/bridge.js';
import { TelegramClient } from '../src/telegram/client.js';
import type { TelegramUpdate } from '../src/telegram/client.js';
import { SECRET_KEY_BYTES } from '../src/crypto/secret-box.js';

const ENC_KEY = crypto.randomBytes(SECRET_KEY_BYTES).toString('base64');

/**
 * PA-53: `TelegramBridge` — the core "inbound Telegram message becomes a
 * Pocket Agent chat turn, and that turn's events become Telegram replies"
 * loop, exercised against a real `PlannerChatService` (mocked only at the LLM
 * HTTP boundary, the same posture `planner-chats.test.ts` takes) and a fake
 * Telegram transport (mocked at the Bot API HTTP boundary — no real network
 * call, no real long-poll loop; `poller.ts` is exercised separately).
 *
 * What matters here, matching the approved plan's own emphasis: an unpaired
 * id never spends a token or touches a workspace; a paired id's first message
 * creates its own chat and every later message resumes the same one (never
 * another pairing's); the three slash commands short-circuit before any LLM
 * call; and a mutating tool call goes through real approval relay (an inline
 * keyboard, resolvable via a synthesized callback query) unless the pairing
 * itself opted into `skipToolApprovals`.
 *
 * Each test builds its own `createTestApp()` (rather than sharing one from
 * `beforeEach`) because a custom `llmFetch` mock can only be installed at
 * construction time, and `createTestApp` mints a fresh temporary workspace
 * root on every call — reusing one test's `db` across a second `createTestApp`
 * call would leave the workspace registry pointed at the *first* call's root
 * while `workspaceRoot` reports the second's, which is exactly backwards for
 * the `mkdir` test below.
 */

// ---- LLM fetch mocking, mirroring planner-chats.test.ts's own helpers -----

function sseResponse(dataLines: string[]): Response {
  return new Response(dataLines.map((line) => `data: ${line}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function fakeCompletionResponse(content: string): Response {
  return sseResponse([JSON.stringify({ choices: [{ delta: { content } }] })]);
}

function fakeToolCallResponse(name: string, args: Record<string, unknown>, callId = 'call_1'): Response {
  return sseResponse([
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: callId, function: { name, arguments: JSON.stringify(args) } }] } }],
    }),
  ]);
}

// ---- Telegram fetch mocking -------------------------------------------------

interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
}

function fakeTelegramTransport(): { fetchImpl: typeof fetch; calls: TelegramCall[] } {
  const calls: TelegramCall[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = url.toString().split('/').pop() ?? '';
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    calls.push({ method, body });
    if (method === 'getMe') {
      return new Response(JSON.stringify({ ok: true, result: { id: 1, username: 'test_bot' } }));
    }
    return new Response(JSON.stringify({ ok: true, result: {} }));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function messageUpdate(chatId: string, text: string, updateId = 1): TelegramUpdate {
  return {
    update_id: updateId,
    message: { message_id: updateId, date: Date.now(), chat: { id: chatId, type: 'private' }, text },
  };
}

function callbackUpdate(chatId: string, data: string, updateId = 1): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: { id: `cb-${updateId}`, data, message: { chat: { id: chatId } }, from: { id: 1 } },
  };
}

/**
 * `buildApp` always starts its own `TelegramPollerService` in the
 * background, independently of the `TelegramBridge` instance each test
 * constructs and drives directly below — without this, that background
 * poller would reach the real Telegram Bot API for the bot row `setup()`
 * creates, on a timer, for the lifetime of every test in this file.
 */
function quietAppLevelTelegramFetch(): typeof fetch {
  return (async () => {
    // See `telegram-bots.test.ts`'s `noNetworkTelegramFetch` doc comment: an
    // instantly-resolving `getUpdates` spins the poller's loop as a tight
    // microtask recursion that starves Node's event loop entirely.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ ok: true, result: [] }));
  }) as unknown as typeof fetch;
}

/** Build a fully-wired app (real `PlannerChatService`, mocked LLM transport)
    and a `TelegramBridge` against its live services, plus a fake Telegram
    transport to assert outbound calls against. */
async function setup(llmFetch?: ReturnType<typeof vi.fn>): Promise<{
  t: TestApp;
  bridge: TelegramBridge;
  botId: string;
  workspaceId: string;
  client: TelegramClient;
  calls: TelegramCall[];
}> {
  const t = await createTestApp(
    { POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY },
    undefined,
    undefined,
    undefined,
    llmFetch as unknown as typeof fetch,
    quietAppLevelTelegramFetch(),
  );
  await t.app.inject({
    method: 'PATCH',
    url: '/api/planner/settings',
    headers: authHeaders(t.cookie),
    payload: { baseUrl: 'https://api.example.com' },
  });
  const botId = t.context.telegramBots.create({ name: 'Test Bot', botToken: 'unused' }).id;
  const workspaceId = t.context.plannerWorkspaces.getDefault()!.id;
  // A Telegram-paired chat has no browser to pick a model in, so — same as a
  // real deployment would — the agent needs its own default model configured
  // (PA-6 round 4) before `PlannerChatService.resolveModelId` has anything to
  // resolve; `lastModelId` is otherwise only ever populated *after* a turn
  // has already resolved one.
  await t.app.inject({
    method: 'PATCH',
    url: `/api/planner/workspaces/${workspaceId}`,
    headers: authHeaders(t.cookie),
    payload: { defaultModelId: 'gpt-4o' },
  });
  const bridge = new TelegramBridge({
    links: t.context.telegramLinks,
    plannerChats: t.context.plannerChats,
    mcpRegistry: t.context.mcpRegistry,
  });
  const { fetchImpl, calls } = fakeTelegramTransport();
  const client = new TelegramClient({ token: 'unused', fetchImpl });
  return { t, bridge, botId, workspaceId, client, calls };
}

describe('TelegramBridge', () => {
  let current: TestApp | null = null;
  afterEach(async () => {
    await current?.cleanup();
    current = null;
  });

  it('replies with a fixed message and creates nothing for an unpaired chat id', async () => {
    const { t, bridge, botId, client, calls } = await setup();
    current = t;

    await bridge.handleUpdate(botId, messageUpdate('999', 'hello'), client);

    const sends = calls.filter((c) => c.method === 'sendMessage');
    expect(sends).toHaveLength(1);
    expect(String(sends[0]!.body.text)).toMatch(/not paired/i);
    expect(t.context.telegramLinks.get(botId, '999')).toBeNull();
  });

  it("creates its own chat on a paired id's first message, and resumes the same chat on the next one", async () => {
    const llmFetch = vi.fn().mockResolvedValueOnce(fakeCompletionResponse('Hello there!'));
    const { t, bridge, botId, workspaceId, client, calls } = await setup(llmFetch);
    current = t;
    t.context.telegramLinks.create(botId, { telegramChatId: '111', workspaceId });

    await bridge.handleUpdate(botId, messageUpdate('111', 'Hi'), client);
    await waitFor(() => calls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('Hello there!')));

    const link = t.context.telegramLinks.get(botId, '111');
    expect(link?.plannerChatId).toBeTruthy();
    const chatId = link!.plannerChatId!;

    llmFetch.mockResolvedValueOnce(fakeCompletionResponse('Again!'));
    await bridge.handleUpdate(botId, messageUpdate('111', 'And again', 2), client);
    await waitFor(() => calls.filter((c) => c.method === 'sendMessage').length >= 2);

    // Same chat, not a new one — "session from telegram id will be it's own session".
    expect(t.context.telegramLinks.get(botId, '111')?.plannerChatId).toBe(chatId);
    const history = await t.context.plannerChats.history(chatId);
    expect(history.filter((e) => e.kind === 'user_prompt')).toHaveLength(2);
  });

  it('two different paired ids under one bot get two independent chats', async () => {
    const llmFetch = vi
      .fn()
      .mockResolvedValueOnce(fakeCompletionResponse('Reply to A'))
      .mockResolvedValueOnce(fakeCompletionResponse('Reply to B'));
    const { t, bridge, botId, workspaceId, client, calls } = await setup(llmFetch);
    current = t;
    t.context.telegramLinks.create(botId, { telegramChatId: 'A', workspaceId });
    t.context.telegramLinks.create(botId, { telegramChatId: 'B', workspaceId });

    await bridge.handleUpdate(botId, messageUpdate('A', 'hi from A'), client);
    await waitFor(() => calls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('Reply to A')));
    await bridge.handleUpdate(botId, messageUpdate('B', 'hi from B', 2), client);
    await waitFor(() => calls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('Reply to B')));

    const chatA = t.context.telegramLinks.get(botId, 'A')!.plannerChatId;
    const chatB = t.context.telegramLinks.get(botId, 'B')!.plannerChatId;
    expect(chatA).toBeTruthy();
    expect(chatB).toBeTruthy();
    expect(chatA).not.toBe(chatB);
  });

  it('slash commands never reach the LLM, and /clear + /mcp answer sensibly with no chat yet', async () => {
    const llmFetch = vi.fn();
    const { t, bridge, botId, workspaceId, client, calls } = await setup(llmFetch);
    current = t;
    t.context.telegramLinks.create(botId, { telegramChatId: '222', workspaceId });

    await bridge.handleUpdate(botId, messageUpdate('222', '/clear'), client);
    await waitFor(() => calls.some((c) => c.method === 'sendMessage'));
    expect(String(calls.find((c) => c.method === 'sendMessage')!.body.text)).toMatch(/no conversation to clear/i);

    await bridge.handleUpdate(botId, messageUpdate('222', '/mcp', 2), client);
    await waitFor(() => calls.filter((c) => c.method === 'sendMessage').length >= 2);
    expect(String(calls[calls.length - 1]!.body.text)).toMatch(/no mcp registries/i);

    expect(llmFetch).not.toHaveBeenCalled();
    // No chat was ever created by a slash command alone.
    expect(t.context.telegramLinks.get(botId, '222')?.plannerChatId).toBeNull();
  });

  it('pauses on a mutating tool call, relays it as an inline-keyboard approval prompt, and resolves via a callback query', async () => {
    const llmFetch = vi
      .fn()
      .mockResolvedValueOnce(fakeToolCallResponse('mkdir', { path: 'somewhere-irrelevant' }))
      .mockResolvedValueOnce(fakeCompletionResponse('Ok, cancelled.'));
    const { t, bridge, botId, workspaceId, client, calls } = await setup(llmFetch);
    current = t;
    t.context.telegramLinks.create(botId, { telegramChatId: '333', workspaceId });

    await bridge.handleUpdate(botId, messageUpdate('333', 'make a directory'), client);
    await waitFor(() =>
      calls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('Approval needed')),
    );
    const approvalSend = calls.find((c) => String(c.body.text ?? '').includes('Approval needed'))!;
    expect(String(approvalSend.body.text)).toContain('Run mkdir');
    const keyboard = (approvalSend.body.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard;
    const denyButton = keyboard.flat().find((b) => b.callback_data.endsWith(':deny'));
    expect(denyButton).toBeTruthy();

    await bridge.handleUpdate(botId, callbackUpdate('333', denyButton!.callback_data, 2), client);
    await waitFor(() => calls.some((c) => c.method === 'answerCallbackQuery'));
    await waitFor(() =>
      calls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('Ok, cancelled.')),
    );
  });

  it('a pairing with skipToolApprovals never sees an approval prompt, and the tool just runs', async () => {
    const llmFetch = vi.fn();
    const { t, bridge, botId, workspaceId, client, calls } = await setup(llmFetch);
    current = t;
    t.context.telegramLinks.create(botId, { telegramChatId: '444', workspaceId, skipToolApprovals: true });

    const targetDir = path.join(t.workspaceRoot, 'made-by-telegram');
    llmFetch
      .mockResolvedValueOnce(fakeToolCallResponse('mkdir', { path: targetDir }))
      .mockResolvedValueOnce(fakeCompletionResponse('Made it.'));

    await bridge.handleUpdate(botId, messageUpdate('444', 'make a directory'), client);
    await waitFor(() => calls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('Made it.')));

    expect(calls.some((c) => String(c.body.text ?? '').includes('Approval needed'))).toBe(false);
    const stat = await fs.stat(targetDir);
    expect(stat.isDirectory()).toBe(true);
  });
});
