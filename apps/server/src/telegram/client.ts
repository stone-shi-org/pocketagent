/**
 * PA-53: a minimal Telegram Bot API client.
 *
 * Plain `fetch` against `https://api.telegram.org/bot<token>/<method>`, no SDK
 * dependency — consistent with this codebase's "hand-roll the small thing"
 * posture already used for `cron-expr.ts`. Only the handful of methods the
 * bridge actually needs are here: `getMe` (bot identity, for Settings' "Test"
 * button and `TelegramBotStore.setUsername`), `getUpdates` (the long-poll
 * loop `TelegramPollerService` drives), `sendMessage` (every outbound reply,
 * including an approval prompt's inline keyboard) and `answerCallbackQuery`
 * (clearing a pressed inline-keyboard button's loading spinner).
 */

/** The subset of Telegram's `Update` object the bridge reads. Deliberately
    untyped beyond this — Telegram's schema is large, and the bridge cares
    about exactly two update kinds. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number | string; type: string };
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: { chat: { id: number | string } };
  from: { id: number; username?: string; first_name?: string };
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface TelegramSendMessageOptions {
  replyMarkup?: { inline_keyboard: TelegramInlineKeyboardButton[][] };
  /** PA-105: omitted sends plain text, exactly as before. `send.ts` is the
      only caller that sets it, because it is the one that knows how to fall
      back when Telegram rejects the markup. */
  parseMode?: 'HTML';
}

export class TelegramApiError extends Error {
  override readonly name = 'TelegramApiError';
  /** The HTTP status, when Telegram answered at all. PA-105's plain-text
      fallback keys on a 400 plus the description, and must not fire for a
      401 (revoked token) or a network failure. */
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

/** Long-poll timeout, in seconds, sent to `getUpdates`. Telegram holds the
    connection open for up to this long waiting for a new update before
    answering with an empty list — the whole point of long-polling over a
    fixed-interval `setInterval` is that a quiet bot costs nothing but one
    held connection. */
export const LONG_POLL_TIMEOUT_SECONDS = 25;

/** Bounds every non-`getUpdates` call, which must never block anywhere near
    that long — a stuck `sendMessage` must not stall the poll loop behind it. */
const REQUEST_TIMEOUT_MS = 15_000;

export interface TelegramClientOptions {
  token: string;
  /** Injected in tests so no real network call is ever made. */
  fetchImpl?: typeof fetch;
}

export class TelegramClient {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TelegramClientOptions) {
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async getMe(): Promise<{ id: number; username: string | null }> {
    const result = (await this.call('getMe', {})) as { id: number; username?: string };
    return { id: result.id, username: result.username ?? null };
  }

  /**
   * Long-poll for new updates. `signal` is the poll loop's own
   * `AbortController` — aborting it (on `TelegramPollerService.stop()`) must
   * cancel the in-flight request rather than leaving it to time out on its
   * own, or a shutdown would hang for up to `LONG_POLL_TIMEOUT_SECONDS`.
   */
  async getUpdates(opts: { offset?: number; signal?: AbortSignal }): Promise<TelegramUpdate[]> {
    const result = (await this.call(
      'getUpdates',
      {
        timeout: LONG_POLL_TIMEOUT_SECONDS,
        ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
      },
      // The long-poll call itself waits up to `LONG_POLL_TIMEOUT_SECONDS` on
      // Telegram's side, so its own request timeout has to be longer than
      // that plus network slack, not the short `REQUEST_TIMEOUT_MS` every
      // other method uses.
      (LONG_POLL_TIMEOUT_SECONDS + 10) * 1000,
      opts.signal,
    )) as TelegramUpdate[] | undefined;
    return result ?? [];
  }

  async sendMessage(chatId: string, text: string, opts: TelegramSendMessageOptions = {}): Promise<void> {
    await this.call('sendMessage', {
      chat_id: chatId,
      text,
      ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
      ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
    });
  }

  /** `text` shows as a small toast on the pressed button; omitted clears the
      loading spinner with no visible feedback, which is what a successful
      approval choice wants (the result is the reply that follows, not a toast). */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  private async call(
    method: string,
    body: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
    externalSignal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort);
    try {
      const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: boolean; result?: unknown; description?: string }
        | null;
      if (!res.ok || !json || json.ok !== true) {
        throw new TelegramApiError(
          json?.description ?? `Telegram API ${method} failed with HTTP ${res.status}.`,
          res.status,
        );
      }
      return json.result;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }
}
