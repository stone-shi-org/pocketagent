import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';
import { TelegramLinkError } from '../src/telegram/links-store.js';
import { SECRET_KEY_BYTES } from '../src/crypto/secret-box.js';

const ENC_KEY = crypto.randomBytes(SECRET_KEY_BYTES).toString('base64');

/** See the identical helper's doc comment in `telegram-bots.test.ts`: without
    this, `buildApp`'s own background `TelegramPollerService` reaches the real
    Telegram Bot API for the bot row this file creates. */
function noNetworkTelegramFetch(): typeof fetch {
  return (async (url: string | URL) => {
    const method = url.toString().split('/').pop();
    if (method === 'getUpdates') {
      // See `telegram-bots.test.ts`'s identical helper: an instantly-resolving
      // fake spins the poller's loop as a tight microtask recursion that
      // starves Node's event loop. A short real delay fixes it.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ ok: true, result: [] }));
    }
    return new Response(JSON.stringify({ ok: false, description: 'Not Found' }), { status: 404 });
  }) as unknown as typeof fetch;
}

/**
 * PA-53: `telegram_links` — a *cache* of which Pocket Agent chat a paired
 * Telegram id is talking to, modeled on `webhook_issue_sessions`. What
 * matters here: a pairing's primary key is `(botId, telegramChatId)`, so two
 * different Telegram ids paired to the same agent never share state; deleting
 * the Pocket Agent a pairing points at detaches it (`SET NULL`) rather than
 * deleting the pairing; and `setPlannerChatId`/`touchLabel` each touch only
 * the one field they claim to, never clobbering the other — the bug the
 * original single-`upsert()` design would have had for the boolean
 * `skipToolApprovals` column (see `TelegramLinksStore`'s own doc comment).
 */
describe('TelegramLinksStore', () => {
  let t: TestApp;
  let botId: string;
  let workspaceId: string;

  beforeEach(async () => {
    t = await createTestApp(
      { POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY },
      undefined,
      undefined,
      undefined,
      undefined,
      noNetworkTelegramFetch(),
    );
    const bot = t.context.telegramBots.create({ name: 'Bot', botToken: 'unused-in-this-file' });
    botId = bot.id;
    workspaceId = t.context.plannerWorkspaces.getDefault()!.id;
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('creates a pairing, defaults skipToolApprovals to false, and refuses a duplicate', () => {
    const link = t.context.telegramLinks.create(botId, { telegramChatId: '42', workspaceId });
    expect(link.skipToolApprovals).toBe(false);
    expect(link.plannerChatId).toBeNull();
    expect(link.workspaceName).toBe(t.context.plannerWorkspaces.getDefault()!.name);

    expect(() => t.context.telegramLinks.create(botId, { telegramChatId: '42', workspaceId })).toThrow(
      TelegramLinkError,
    );
  });

  it('two different chat ids under the same bot are independent pairings ("its own session")', () => {
    t.context.telegramLinks.create(botId, { telegramChatId: '1', workspaceId });
    t.context.telegramLinks.create(botId, { telegramChatId: '2', workspaceId });
    t.context.telegramLinks.setPlannerChatId(botId, '1', 'chat-for-1');

    expect(t.context.telegramLinks.get(botId, '1')?.plannerChatId).toBe('chat-for-1');
    expect(t.context.telegramLinks.get(botId, '2')?.plannerChatId).toBeNull();
  });

  it('setPlannerChatId never touches skipToolApprovals or the label', () => {
    t.context.telegramLinks.create(botId, {
      telegramChatId: '1',
      workspaceId,
      skipToolApprovals: true,
      telegramUserLabel: '@alice',
    });
    t.context.telegramLinks.setPlannerChatId(botId, '1', 'chat-1');
    const link = t.context.telegramLinks.get(botId, '1')!;
    expect(link.skipToolApprovals).toBe(true);
    expect(link.telegramUserLabel).toBe('@alice');
    expect(link.plannerChatId).toBe('chat-1');
  });

  it('touchLabel never touches plannerChatId or skipToolApprovals', () => {
    t.context.telegramLinks.create(botId, { telegramChatId: '1', workspaceId, skipToolApprovals: true });
    t.context.telegramLinks.setPlannerChatId(botId, '1', 'chat-1');
    t.context.telegramLinks.touchLabel(botId, '1', '@bob');
    const link = t.context.telegramLinks.get(botId, '1')!;
    expect(link.telegramUserLabel).toBe('@bob');
    expect(link.plannerChatId).toBe('chat-1');
    expect(link.skipToolApprovals).toBe(true);
  });

  it('update() changes only the fields provided', () => {
    const second = t.context.telegramLinks.create(botId, { telegramChatId: '1', workspaceId });
    expect(second.skipToolApprovals).toBe(false);
    const updated = t.context.telegramLinks.update(botId, '1', { skipToolApprovals: true });
    expect(updated.skipToolApprovals).toBe(true);
    expect(updated.workspaceId).toBe(workspaceId);
  });

  it('throws not_found updating a pairing that does not exist', () => {
    expect(() => t.context.telegramLinks.update(botId, 'nope', { skipToolApprovals: true })).toThrow(
      TelegramLinkError,
    );
  });

  it('detaches (SET NULL) rather than deletes the pairing when its workspace is removed', async () => {
    const second = await t.context.plannerWorkspaces.create(t.context.plannerWorkspacesRoot, 'Second Agent');
    t.context.telegramLinks.create(botId, { telegramChatId: '1', workspaceId: second.id });
    await t.context.plannerWorkspaces.remove(second.id);

    const link = t.context.telegramLinks.get(botId, '1');
    expect(link).not.toBeNull();
    expect(link!.workspaceId).toBeNull();
  });

  it('findByPlannerChatId finds the pairing bound to a chat', () => {
    t.context.telegramLinks.create(botId, { telegramChatId: '1', workspaceId });
    t.context.telegramLinks.setPlannerChatId(botId, '1', 'chat-xyz');
    const found = t.context.telegramLinks.findByPlannerChatId('chat-xyz');
    expect(found).toHaveLength(1);
    expect(found[0]!.telegramChatId).toBe('1');
    expect(t.context.telegramLinks.findByPlannerChatId('nonexistent')).toHaveLength(0);
  });

  it('remove() deletes a pairing, and is a no-op the second time', () => {
    t.context.telegramLinks.create(botId, { telegramChatId: '1', workspaceId });
    expect(t.context.telegramLinks.remove(botId, '1')).toBe(true);
    expect(t.context.telegramLinks.remove(botId, '1')).toBe(false);
    expect(t.context.telegramLinks.get(botId, '1')).toBeNull();
  });
});
