import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';
import { SECRET_KEY_BYTES, decryptSecret } from '../src/crypto/secret-box.js';
import { TelegramBotStore, type TelegramBotStoreOptions } from '../src/telegram/bots-store.js';

/**
 * PA-53: `telegram_bots` — a secret-backed row, following
 * `CustomClaudeProviderStore`'s exact shape (PA-28). What matters here: the
 * token never comes back out over HTTP in any form; it is genuinely encrypted
 * at rest, not hashed (a poll loop has to hand the plaintext to Telegram); a
 * bot with no encryption key configured still lists but cannot be created or
 * edited; and `revealToken` — the one place the plaintext is ever
 * reconstructed — degrades to `null` rather than throwing when it cannot
 * decrypt, so one bad row cannot take a poll loop down.
 */

const ENC_KEY = crypto.randomBytes(SECRET_KEY_BYTES).toString('base64');

/**
 * Every `createTestApp` call in this file must pass this: `buildApp` always
 * starts a `TelegramPollerService` (see `app.ts`), and its reconcile tick
 * (sped up to 200ms by `createTestApp` itself) picks up any bot row this file
 * creates whether or not the test cares about polling — without an injected
 * fetch it would otherwise reach the real Telegram Bot API on a background
 * timer for the lifetime of the test.
 */
function noNetworkTelegramFetch(): typeof fetch {
  return (async (url: string | URL) => {
    const method = url.toString().split('/').pop();
    if (method === 'getUpdates') {
      // A real `getUpdates` blocks server-side for up to ~25s when idle,
      // which is what naturally paces `TelegramPollerService`'s loop. An
      // instantly-resolving fake has no such pacing and spins the loop as a
      // tight microtask recursion that starves Node's event loop (timers
      // never get a turn) — a short real `setTimeout` here is the fix, not a
      // faithfulness nicety.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ ok: true, result: [] }));
    }
    return new Response(JSON.stringify({ ok: false, description: 'Not Found' }), { status: 404 });
  }) as unknown as typeof fetch;
}

describe('TelegramBotStore', () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await createTestApp(
      { POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY },
      undefined,
      undefined,
      undefined,
      undefined,
      noNetworkTelegramFetch(),
    );
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('stores the token encrypted, not in the clear, and reveals it correctly internally', () => {
    const store = ctx.context.telegramBots;
    const bot = store.create({ name: 'House Bot', botToken: '123:abc-def' });
    const row = ctx.db
      .prepare('SELECT bot_token_ciphertext FROM telegram_bots WHERE id = ?')
      .get(bot.id) as { bot_token_ciphertext: string };
    expect(row.bot_token_ciphertext).not.toContain('123:abc-def');
    expect(decryptSecret(row.bot_token_ciphertext, Buffer.from(ENC_KEY, 'base64'))).toBe('123:abc-def');
    expect(store.revealToken(bot.id)).toBe('123:abc-def');
  });

  it('never returns the token from list()/get()/create()/update()', () => {
    const store = ctx.context.telegramBots;
    const bot = store.create({ name: 'House Bot', botToken: '123:abc-def' });
    const updated = store.update(bot.id, { name: 'Renamed Bot' });
    for (const summary of [bot, updated, store.get(bot.id), ...store.list()]) {
      expect(JSON.stringify(summary)).not.toContain('abc-def');
      expect(JSON.stringify(summary)).not.toContain('ciphertext');
      expect(summary.hasBotToken).toBe(true);
    }
  });

  it('keeps the stored token when update omits or blanks botToken', () => {
    const store = ctx.context.telegramBots;
    const bot = store.create({ name: 'House Bot', botToken: '123:abc-def' });
    store.update(bot.id, { name: 'Renamed' });
    expect(store.revealToken(bot.id)).toBe('123:abc-def');
    store.update(bot.id, { botToken: '' });
    expect(store.revealToken(bot.id)).toBe('123:abc-def');
    store.update(bot.id, { botToken: '456:ghi' });
    expect(store.revealToken(bot.id)).toBe('456:ghi');
  });

  it('clears the resolved username when the token is re-keyed, but not on a plain rename', () => {
    const store = ctx.context.telegramBots;
    const bot = store.create({ name: 'House Bot', botToken: '123:abc-def' });
    store.setUsername(bot.id, 'house_bot');
    expect(store.update(bot.id, { name: 'Renamed' }).botUsername).toBe('house_bot');
    expect(store.update(bot.id, { botToken: '999:zzz' }).botUsername).toBeNull();
  });

  it('lists but refuses to create/update without an encryption key configured', async () => {
    const noKeyCtx = await createTestApp({}, undefined, undefined, undefined, undefined, noNetworkTelegramFetch());
    try {
      const store = noKeyCtx.context.telegramBots;
      expect(store.encryptionAvailable).toBe(false);
      expect(() => store.create({ name: 'X', botToken: 'tok' })).toThrow();
    } finally {
      await noKeyCtx.cleanup();
    }
  });

  it('lists a row created under one key as unusable (revealToken null) once the key is wrong', () => {
    const otherKey = crypto.randomBytes(SECRET_KEY_BYTES).toString('base64');
    const loggerStub = { warn() {}, error() {}, info() {} } as unknown as TelegramBotStoreOptions['logger'];
    const store = ctx.context.telegramBots;
    const bot = store.create({ name: 'House Bot', botToken: '123:abc-def' });

    const wrongKeyStore = new TelegramBotStore({
      db: ctx.db,
      encKey: Buffer.from(otherKey, 'base64'),
      logger: loggerStub,
    });
    expect(wrongKeyStore.revealToken(bot.id)).toBeNull();
    // Still listed — greyed out, not vanished.
    expect(wrongKeyStore.list().map((b) => b.id)).toContain(bot.id);
  });

  it('every enabled row is what listEnabledRows() surfaces for the poller', () => {
    const store = ctx.context.telegramBots;
    const a = store.create({ name: 'A', botToken: 'a', enabled: true });
    const b = store.create({ name: 'B', botToken: 'b', enabled: false });
    const ids = store.listEnabledRows().map((r) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });

  it('deletes a bot and cascades its pairings', () => {
    const store = ctx.context.telegramBots;
    const links = ctx.context.telegramLinks;
    const bot = store.create({ name: 'House Bot', botToken: '123:abc-def' });
    const workspaceId = ctx.context.plannerWorkspaces.getDefault()!.id;
    links.create(bot.id, { telegramChatId: '111', workspaceId });
    expect(store.remove(bot.id)).toBe(true);
    expect(store.remove(bot.id)).toBe(false);
    expect(links.get(bot.id, '111')).toBeNull();
  });
});

describe('Telegram bot routes', () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await createTestApp(
      { POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY },
      undefined,
      undefined,
      undefined,
      undefined,
      noNetworkTelegramFetch(),
    );
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  const post = (url: string, payload: unknown) =>
    ctx.app.inject({ method: 'POST', url, headers: authHeaders(ctx.cookie), payload });
  const get = (url: string) => ctx.app.inject({ method: 'GET', url, headers: authHeaders(ctx.cookie) });
  const patch = (url: string, payload: unknown) =>
    ctx.app.inject({ method: 'PATCH', url, headers: authHeaders(ctx.cookie), payload });
  const del = (url: string) => ctx.app.inject({ method: 'DELETE', url, headers: authHeaders(ctx.cookie) });

  it('creates, lists, updates and deletes a bot over HTTP with no token ever in a response body', async () => {
    const created = await post('/api/telegram/bots', { name: 'House Bot', botToken: 'sk-telegram-token' });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    expect(created.body).not.toContain('sk-telegram-token');

    const listed = await get('/api/telegram/bots');
    expect(listed.statusCode).toBe(200);
    expect(listed.json().bots.map((b: { id: string }) => b.id)).toContain(id);
    expect(listed.body).not.toContain('sk-telegram-token');

    const updated = await patch(`/api/telegram/bots/${encodeURIComponent(id)}`, { enabled: false });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().enabled).toBe(false);

    const removed = await del(`/api/telegram/bots/${encodeURIComponent(id)}`);
    expect(removed.statusCode).toBe(204);
    expect((await get('/api/telegram/bots')).json().bots).toHaveLength(0);
  });

  it('rejects an empty botToken on create with a 400, not a 500', async () => {
    const res = await post('/api/telegram/bots', { name: 'X', botToken: '' });
    expect(res.statusCode).toBe(400);
  });

  it('404s deleting or updating an unknown bot id', async () => {
    expect((await del('/api/telegram/bots/nope')).statusCode).toBe(404);
    expect((await patch('/api/telegram/bots/nope', { name: 'X' })).statusCode).toBe(404);
  });

  it('test-token reports failure for an unreachable/garbage token without throwing', async () => {
    const res = await post('/api/telegram/bots/test-token', { botToken: 'not-a-real-token' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
  });
});

describe('Telegram pairing routes', () => {
  let ctx: TestApp;
  let botId: string;
  let workspaceId: string;
  beforeEach(async () => {
    ctx = await createTestApp(
      { POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY },
      undefined,
      undefined,
      undefined,
      undefined,
      noNetworkTelegramFetch(),
    );
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/telegram/bots',
      headers: authHeaders(ctx.cookie),
      payload: { name: 'House Bot', botToken: 'sk-telegram-token' },
    });
    botId = created.json().id as string;
    workspaceId = ctx.context.plannerWorkspaces.getDefault()!.id;
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  const post = (url: string, payload: unknown) =>
    ctx.app.inject({ method: 'POST', url, headers: authHeaders(ctx.cookie), payload });
  const get = (url: string) => ctx.app.inject({ method: 'GET', url, headers: authHeaders(ctx.cookie) });

  it('pairs a Telegram id to a workspace, lists it, and refuses a duplicate pairing', async () => {
    const created = await post(`/api/telegram/bots/${botId}/links`, {
      telegramChatId: '555',
      workspaceId,
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().workspaceId).toBe(workspaceId);
    expect(created.json().skipToolApprovals).toBe(false);

    const listed = await get(`/api/telegram/bots/${botId}/links`);
    expect(listed.json().links).toHaveLength(1);

    const duplicate = await post(`/api/telegram/bots/${botId}/links`, { telegramChatId: '555', workspaceId });
    expect(duplicate.statusCode).toBe(409);
  });

  it('updates and removes a pairing', async () => {
    await post(`/api/telegram/bots/${botId}/links`, { telegramChatId: '555', workspaceId });
    const updated = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/telegram/bots/${botId}/links/555`,
      headers: authHeaders(ctx.cookie),
      payload: { skipToolApprovals: true },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().skipToolApprovals).toBe(true);

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/telegram/bots/${botId}/links/555`,
      headers: authHeaders(ctx.cookie),
    });
    expect(removed.statusCode).toBe(204);
    expect((await get(`/api/telegram/bots/${botId}/links`)).json().links).toHaveLength(0);
  });
});
