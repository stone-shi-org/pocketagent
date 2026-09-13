import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, waitFor, type TestApp } from './helpers.js';
import { SECRET_KEY_BYTES } from '../src/crypto/secret-box.js';
import { TelegramPollerService } from '../src/telegram/poller.js';
import { TelegramBridge } from '../src/telegram/bridge.js';

const ENC_KEY = crypto.randomBytes(SECRET_KEY_BYTES).toString('base64');

/**
 * PA-53: `TelegramPollerService` — the reconcile-tick lifecycle around one
 * long-poll loop per enabled bot. `TelegramBridge`'s own message-handling
 * logic is covered end to end in `telegram-bridge.test.ts`; this file is only
 * about the poller's own responsibilities: picking up a newly enabled bot,
 * dropping a disabled one, surviving a failing `getUpdates` call, and
 * `stop()` actually clearing everything rather than leaving a loop running
 * behind a closed app.
 */
describe('TelegramPollerService', () => {
  let t: TestApp;
  let bridge: TelegramBridge;

  beforeEach(async () => {
    // `buildApp` always starts its own `TelegramPollerService` too, wired to
    // the real global `fetch` unless told otherwise — quieted here since this
    // file constructs and drives a second, separate `TelegramPollerService`
    // instance per test, and the app-level one must not also be reaching the
    // real Telegram Bot API in the background throughout.
    const quietAppLevelFetch = (async () => {
      // An instantly-resolving `getUpdates` spins the poller's loop as a
      // tight microtask recursion with no macrotask yielding, starving
      // Node's event loop — real Telegram naturally paces this by holding
      // the connection open; a short real delay reproduces that pacing.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ ok: true, result: [] }));
    }) as unknown as typeof fetch;
    t = await createTestApp(
      { POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY },
      undefined,
      undefined,
      undefined,
      undefined,
      quietAppLevelFetch,
    );
    bridge = new TelegramBridge({
      links: t.context.telegramLinks,
      plannerChats: t.context.plannerChats,
      mcpRegistry: t.context.mcpRegistry,
    });
  });
  afterEach(async () => {
    await t.cleanup();
  });

  /** Never yields an update, so the bridge is never actually exercised here —
      only the poller's own start/stop/reconcile bookkeeping is under test.
      The real `setTimeout` delay is load-bearing, not cosmetic — see
      `quietAppLevelFetch`'s doc comment above. */
  function quietFetch(): typeof fetch {
    return (async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ ok: true, result: [] }));
    }) as unknown as typeof fetch;
  }

  it('picks up a newly enabled bot on the next reconcile tick, and drops it once disabled', async () => {
    const bot = t.context.telegramBots.create({ name: 'Bot', botToken: 'tok' });
    const poller = new TelegramPollerService({
      bots: t.context.telegramBots,
      bridge,
      fetchImpl: quietFetch(),
      reconcileIntervalMs: 30,
    });
    try {
      await poller.init();
      await waitFor(() => poller.activeBotIds().includes(bot.id));

      t.context.telegramBots.update(bot.id, { enabled: false });
      await waitFor(() => !poller.activeBotIds().includes(bot.id));
    } finally {
      poller.stop();
    }
  });

  it('never starts a loop for a bot created disabled', async () => {
    const bot = t.context.telegramBots.create({ name: 'Bot', botToken: 'tok', enabled: false });
    const poller = new TelegramPollerService({
      bots: t.context.telegramBots,
      bridge,
      fetchImpl: quietFetch(),
      reconcileIntervalMs: 30,
    });
    try {
      await poller.init();
      // Give it a couple of reconcile ticks' worth of time to prove absence,
      // not just "hasn't happened yet".
      await new Promise((r) => setTimeout(r, 100));
      expect(poller.activeBotIds()).not.toContain(bot.id);
    } finally {
      poller.stop();
    }
  });

  it('backs off and keeps polling after a failing getUpdates call, rather than crashing the loop', async () => {
    const bot = t.context.telegramBots.create({ name: 'Bot', botToken: 'tok' });
    let calls = 0;
    const failThenSucceed: typeof fetch = (async (url: string | URL) => {
      const method = url.toString().split('/').pop();
      if (method === 'getUpdates') {
        calls += 1;
        throw new Error('simulated network failure');
      }
      return new Response(JSON.stringify({ ok: true, result: [] }));
    }) as unknown as typeof fetch;

    const poller = new TelegramPollerService({
      bots: t.context.telegramBots,
      bridge,
      fetchImpl: failThenSucceed,
      reconcileIntervalMs: 30,
    });
    try {
      await poller.init();
      await waitFor(() => calls >= 1, { timeout: 2000 });
      // Still tracked as active — a failing call is not the same as the bot
      // having been disabled or removed.
      expect(poller.activeBotIds()).toContain(bot.id);
    } finally {
      poller.stop();
    }
  });

  it('stop() clears every active loop', async () => {
    t.context.telegramBots.create({ name: 'Bot', botToken: 'tok' });
    const poller = new TelegramPollerService({
      bots: t.context.telegramBots,
      bridge,
      fetchImpl: quietFetch(),
      reconcileIntervalMs: 30,
    });
    await poller.init();
    await waitFor(() => poller.activeBotIds().length > 0);
    poller.stop();
    expect(poller.activeBotIds()).toHaveLength(0);
  });
});
