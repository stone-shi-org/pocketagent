import { TelegramClient } from './client.js';
import type { TelegramBotStore } from './bots-store.js';
import type { TelegramBridge } from './bridge.js';

/**
 * How often to re-list enabled bots and start/stop a long-poll loop per one
 * that changed. Modeled on `CronService`'s own `TICK_INTERVAL_MS` reconcile
 * tick rather than a push-on-mutation callback from `TelegramBotStore`: a bot
 * row changes rarely (an operator editing Settings), so a short poll against
 * state is simpler than wiring a notification path through the store for an
 * event this infrequent, and it recovers for free from the same class of
 * "missed the notification" bug a fixed tick always does.
 */
const RECONCILE_INTERVAL_MS = 10_000;

/** How long to back off after a bot's `getUpdates` call fails (a network
    blip, a revoked token) before retrying — long enough not to hammer a
    persistently-broken bot, short enough that a transient blip recovers
    quickly. */
const POLL_ERROR_BACKOFF_MS = 15_000;

export interface TelegramPollerOptions {
  bots: TelegramBotStore;
  bridge: TelegramBridge;
  logger?: { warn: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void };
  /** Injected in tests so no real network call is ever made. */
  fetchImpl?: typeof fetch;
  /** Injected in tests to run the reconcile tick faster/slower than the real default. */
  reconcileIntervalMs?: number;
}

/**
 * PA-53: the persistent background service that keeps one long-poll loop
 * (`getUpdates`) running per enabled Telegram bot.
 *
 * Shaped like `CronService`: `init()`/`stop()` wired into `app.ts` next to
 * `cron`/`webhooks`, one fixed reconcile tick against the database rather
 * than a chain of per-bot timers, and a poll failure must never crash the
 * whole service — the same "one broken job must not starve the others"
 * discipline `CronService.tick` follows for scheduled jobs.
 *
 * Deliberately *not* a shared `setInterval` for the per-bot polling itself:
 * `getUpdates` blocks on Telegram's side for up to `LONG_POLL_TIMEOUT_SECONDS`
 * per call, so each bot needs its own self-rescheduling loop rather than a
 * tick that would either overlap or stall behind a slow bot.
 *
 * Long-poll, not an inbound webhook — see the approved plan's §2.1: Telegram
 * webhook mode would require a publicly-reachable HTTPS URL, which this app's
 * own loopback-by-default posture should not force on every installer just to
 * get a bot working behind NAT or Tailscale. Every network call this service
 * makes is outbound.
 */
export class TelegramPollerService {
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly opts: TelegramPollerOptions) {}

  async init(): Promise<void> {
    this.reconcile();
    this.reconcileTimer = setInterval(() => this.reconcile(), this.opts.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref?.();
  }

  stop(): void {
    if (this.reconcileTimer !== null) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
  }

  /** Which bots currently have a running poll loop — exposed for tests only. */
  activeBotIds(): string[] {
    return [...this.active.keys()];
  }

  private reconcile(): void {
    const wanted = new Set(this.opts.bots.listEnabledRows().map((row) => row.id));
    for (const [botId, controller] of this.active) {
      if (!wanted.has(botId)) {
        controller.abort();
        this.active.delete(botId);
      }
    }
    for (const botId of wanted) {
      if (this.active.has(botId)) continue;
      const controller = new AbortController();
      this.active.set(botId, controller);
      void this.pollLoop(botId, controller.signal);
    }
  }

  private async pollLoop(botId: string, signal: AbortSignal): Promise<void> {
    let offset = this.opts.bots.getPollingOffset(botId) ?? undefined;
    while (!signal.aborted) {
      const token = this.opts.bots.revealToken(botId);
      if (!token) {
        // No key configured, or this row's ciphertext no longer decrypts —
        // `TelegramBotStore` has already logged why. Back off rather than
        // spinning, and let the next reconcile tick decide whether this bot
        // is still supposed to be running at all.
        await sleep(POLL_ERROR_BACKOFF_MS, signal);
        continue;
      }
      const client = new TelegramClient({ token, ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}) });

      let updates;
      try {
        updates = await client.getUpdates({ offset, signal });
      } catch (err) {
        if (signal.aborted) return;
        this.opts.logger?.warn({ err, botId }, 'Telegram getUpdates failed; backing off');
        await sleep(POLL_ERROR_BACKOFF_MS, signal);
        continue;
      }
      if (signal.aborted) return;

      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await this.opts.bridge.handleUpdate(botId, update, client);
        } catch (err) {
          this.opts.logger?.warn({ err, botId, updateId: update.update_id }, 'Telegram update handling failed');
        }
      }
      if (updates.length > 0) this.opts.bots.setPollingOffset(botId, offset!);
    }
  }
}

/** `setTimeout` that resolves early (without rejecting) if `signal` aborts —
    so `stop()` does not have to wait out a full backoff before a poll loop
    actually exits. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
