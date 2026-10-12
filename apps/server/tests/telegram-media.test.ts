import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authHeaders, createTestApp, waitFor, type TestApp } from './helpers.js';
import { pickPhotoSize, TelegramBridge } from '../src/telegram/bridge.js';
import { TelegramClient, type TelegramMessage, type TelegramUpdate } from '../src/telegram/client.js';
import { SECRET_KEY_BYTES } from '../src/crypto/secret-box.js';
import { makePdf } from './helpers-documents.js';

/**
 * PA-137 Phase 2: documents and photos sent to a paired bot. Driven against a
 * real `PlannerChatService` (the LLM mocked at its HTTP boundary) and a fake
 * Bot API that serves `getFile` and the file download, so the whole path —
 * pairing check, download, staging, landing, extraction, inlining — runs for
 * real with no network.
 */

const ENC_KEY = crypto.randomBytes(SECRET_KEY_BYTES).toString('base64');
const BOT_TOKEN = '123456:SECRET-bot-token-value';

function sseResponse(dataLines: string[]): Response {
  return new Response(dataLines.map((line) => `data: ${line}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

/** A Bot API that knows a few files by id. */
function fakeBotApi(files: Record<string, Buffer>, opts: { failDownload?: boolean } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const href = url.toString();
    if (href.includes('/file/bot')) {
      calls.push({ url: href, method: 'download', body: {} });
      if (opts.failDownload) throw new TypeError(`fetch failed for ${href}`);
      const id = href.split('/').pop()!.replace(/^path-/, '');
      const data = files[id];
      return data ? new Response(data) : new Response('nope', { status: 404 });
    }
    const method = href.split('/').pop() ?? '';
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    calls.push({ url: href, method, body });
    if (method === 'getFile') {
      const id = String(body.file_id);
      return new Response(JSON.stringify({ ok: true, result: { file_path: `path-${id}`, file_size: files[id]?.length } }));
    }
    return new Response(JSON.stringify({ ok: true, result: {} }));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function quietPollerFetch(): typeof fetch {
  return (async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ ok: true, result: [] }));
  }) as unknown as typeof fetch;
}

function update(message: Partial<TelegramMessage> & { chatId: string }, updateId = 1): TelegramUpdate {
  const { chatId, ...rest } = message;
  return {
    update_id: updateId,
    message: { message_id: updateId, date: Date.now(), chat: { id: chatId, type: 'private' }, ...rest },
  };
}

async function setup(files: Record<string, Buffer>, opts: { failDownload?: boolean; albumWindowMs?: number } = {}) {
  const llmBodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const llmFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    llmBodies.push(JSON.parse(String(init.body)));
    return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'Got it.' } }] })]);
  });
  const t = await createTestApp(
    { POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY },
    undefined,
    undefined,
    undefined,
    llmFetch as unknown as typeof fetch,
    quietPollerFetch(),
  );
  await t.app.inject({
    method: 'PATCH',
    url: '/api/planner/settings',
    headers: authHeaders(t.cookie),
    payload: { baseUrl: 'https://api.example.com' },
  });
  const botId = t.context.telegramBots.create({ name: 'Bot', botToken: BOT_TOKEN }).id;
  const workspace = t.context.plannerWorkspaces.getDefault()!;
  await t.app.inject({
    method: 'PATCH',
    url: `/api/planner/workspaces/${workspace.id}`,
    headers: authHeaders(t.cookie),
    payload: { defaultModelId: 'gpt-4o' },
  });
  const logged: string[] = [];
  const record = (obj: unknown, msg?: string) => logged.push(`${JSON.stringify(obj)} ${msg ?? ''}`);
  const logger = { warn: vi.fn(record), info: vi.fn(record) };
  const bridge = new TelegramBridge({
    links: t.context.telegramLinks,
    plannerChats: t.context.plannerChats,
    mcpRegistry: t.context.mcpRegistry,
    attachmentStaging: t.context.attachmentStaging,
    albumWindowMs: opts.albumWindowMs ?? 50,
    logger,
  });
  const api = fakeBotApi(files, opts);
  const client = new TelegramClient({ token: BOT_TOKEN, fetchImpl: api.fetchImpl });
  return { t, bridge, botId, workspace, client, calls: api.calls, llmBodies, logged };
}

const lastUserText = (bodies: Array<{ messages: Array<{ role: string; content: unknown }> }>): unknown =>
  [...bodies[bodies.length - 1]!.messages].reverse().find((m) => m.role === 'user')?.content;

describe('Telegram documents and photos', () => {
  let current: TestApp | null = null;
  afterEach(async () => {
    await current?.cleanup();
    current = null;
  });

  it('downloads nothing for an unpaired chat', async () => {
    const s = await setup({ doc1: makePdf(['x']) });
    current = s.t;
    await s.bridge.handleUpdate(s.botId, update({ chatId: '999', document: { file_id: 'doc1', file_name: 'a.pdf' } }), s.client);
    expect(s.calls.some((c) => c.method === 'getFile' || c.method === 'download')).toBe(false);
    expect(String(s.calls.find((c) => c.method === 'sendMessage')!.body.text)).toMatch(/not paired/i);
    expect(s.t.context.attachmentStaging.size()).toBe(0);
  });

  it('lands a PDF in the agent\'s uploads, with the caption as the prompt and its text extracted', async () => {
    const s = await setup({ doc1: makePdf(['Invoice total 99 EUR']) });
    current = s.t;
    s.t.context.telegramLinks.create(s.botId, { telegramChatId: '111', workspaceId: s.workspace.id });
    await s.bridge.handleUpdate(
      s.botId,
      update({ chatId: '111', caption: 'What is the total?', document: { file_id: 'doc1', file_name: 'invoice.pdf', mime_type: 'application/pdf' } }),
      s.client,
    );
    await waitFor(() => s.llmBodies.length > 0);
    const text = String(lastUserText(s.llmBodies));
    expect(text.startsWith('What is the total?\n\n[Attached file saved to: artifacts/uploads/invoice_')).toBe(true);
    expect(text).toContain('Invoice total 99 EUR');
    const uploads = fs.readdirSync(path.join(s.workspace.path, 'artifacts', 'uploads'));
    expect(uploads.some((n) => /^invoice_.*\.pdf$/.test(n))).toBe(true);
    expect(uploads.some((n) => /^invoice_.*\.pdf\.txt$/.test(n))).toBe(true);
    await waitFor(() => s.calls.some((c) => c.method === 'sendMessage' && /Got it/.test(String(c.body.text))));
  });

  it('sends the largest photo size within the budget inline, as the message\'s image', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x00, 0x04, 0x00, 0x03, 0x01, 0x22, 0x00]);
    const s = await setup({ small: Buffer.from('tiny'), mid: jpeg, huge: Buffer.from('too big') });
    current = s.t;
    s.t.context.telegramLinks.create(s.botId, { telegramChatId: '111', workspaceId: s.workspace.id });
    await s.bridge.handleUpdate(
      s.botId,
      update({
        chatId: '111',
        caption: 'What is this?',
        photo: [
          { file_id: 'small', width: 90, height: 67, file_size: 4 },
          { file_id: 'mid', width: 1024, height: 768, file_size: jpeg.length },
          { file_id: 'huge', width: 4000, height: 3000, file_size: 7 },
        ],
      }),
      s.client,
    );
    await waitFor(() => s.llmBodies.length > 0);
    const content = lastUserText(s.llmBodies) as Array<{ type: string; image_url?: { url: string }; text?: string }>;
    expect(content[0]?.image_url?.url).toBe(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
    expect(content[1]?.text).toBe('What is this?');
    // Only the chosen size was fetched.
    expect(s.calls.filter((c) => c.method === 'getFile').map((c) => c.body.file_id)).toEqual(['mid']);
  });

  it('coalesces an album into one message', async () => {
    const s = await setup({ a: Buffer.from('# A'), b: Buffer.from('# B') });
    current = s.t;
    s.t.context.telegramLinks.create(s.botId, { telegramChatId: '111', workspaceId: s.workspace.id });
    await s.bridge.handleUpdate(
      s.botId,
      update({ chatId: '111', media_group_id: 'g1', caption: 'Compare these', document: { file_id: 'a', file_name: 'a.md' } }, 1),
      s.client,
    );
    await s.bridge.handleUpdate(
      s.botId,
      update({ chatId: '111', media_group_id: 'g1', document: { file_id: 'b', file_name: 'b.md' } }, 2),
      s.client,
    );
    await waitFor(() => s.llmBodies.length > 0);
    await new Promise((r) => setTimeout(r, 150));
    expect(s.llmBodies).toHaveLength(1);
    const text = String(lastUserText(s.llmBodies));
    expect(text.startsWith('Compare these')).toBe(true);
    expect(text).toContain('<<<FILE a.md');
    expect(text).toContain('<<<FILE b.md');
  });

  it('queues a file sent while the chat is busy, as text is', async () => {
    const s = await setup({ d: Buffer.from('later') });
    current = s.t;
    s.t.context.telegramLinks.create(s.botId, { telegramChatId: '111', workspaceId: s.workspace.id });
    const chat = s.t.context.plannerChats.create({ workspaceId: s.workspace.id });
    s.t.context.telegramLinks.setPlannerChatId(s.botId, '111', chat.id);
    (s.t.context.plannerChats as unknown as { activeTurns: Map<string, number> }).activeTurns.set(chat.id, 1);
    await s.bridge.handleUpdate(s.botId, update({ chatId: '111', document: { file_id: 'd', file_name: 'later.txt' } }), s.client);
    const queued = s.t.context.plannerChats.queuedPrompts(chat.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.attachmentNames).toEqual(['later.txt']);
    expect(s.llmBodies).toHaveLength(0);
  });

  it('never logs the bot token, even when a download fails', async () => {
    const s = await setup({ doc1: makePdf(['x']) }, { failDownload: true });
    current = s.t;
    s.t.context.telegramLinks.create(s.botId, { telegramChatId: '111', workspaceId: s.workspace.id });
    await s.bridge.handleUpdate(s.botId, update({ chatId: '111', document: { file_id: 'doc1', file_name: 'a.pdf' } }), s.client);
    const reply = s.calls.filter((c) => c.method === 'sendMessage').pop()!;
    expect(String(reply.body.text)).toBe('Could not receive the file: Downloading the file from Telegram failed.');
    expect(s.logged.join('\n')).not.toContain(BOT_TOKEN);
    expect(String(reply.body.text)).not.toContain(BOT_TOKEN);
    expect(s.llmBodies).toHaveLength(0);
    expect(s.t.context.attachmentStaging.size()).toBe(0);
  });

  it('refuses a document over 20 MB before downloading it', async () => {
    const s = await setup({});
    current = s.t;
    s.t.context.telegramLinks.create(s.botId, { telegramChatId: '111', workspaceId: s.workspace.id });
    await s.bridge.handleUpdate(
      s.botId,
      update({ chatId: '111', document: { file_id: 'big', file_name: 'big.zip', file_size: 21 * 1024 * 1024 } }),
      s.client,
    );
    expect(s.calls.some((c) => c.method === 'getFile')).toBe(false);
    expect(String(s.calls.filter((c) => c.method === 'sendMessage').pop()!.body.text)).toMatch(/larger than 20 MB/);
  });
});

describe('pickPhotoSize', () => {
  it('prefers the largest size inside the budget, and falls back to the smallest', () => {
    const sizes = [
      { file_id: 's', width: 320, height: 240, file_size: 10_000 },
      { file_id: 'm', width: 1280, height: 960, file_size: 200_000 },
      { file_id: 'l', width: 2560, height: 1920, file_size: 900_000 },
    ];
    expect(pickPhotoSize(sizes)?.file_id).toBe('m');
    expect(pickPhotoSize([{ file_id: 'x', width: 5000, height: 4000 }, { file_id: 'y', width: 3000, height: 2500 }])?.file_id).toBe('y');
    expect(pickPhotoSize([])).toBeNull();
  });
});
