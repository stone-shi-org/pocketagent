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

import { PassThrough, Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

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
  /** PA-137: a file sent as a document (any type, photos sent "as file" included). */
  document?: TelegramDocument;
  /** PA-137: a compressed photo, as every size Telegram made of it, smallest first. */
  photo?: TelegramPhotoSize[];
  /** PA-137: the text sent with a document or photo; it becomes the prompt. */
  caption?: string;
  /** PA-137: shared by every message of one album (several files sent together). */
  media_group_id?: string;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width: number;
  height: number;
  file_size?: number;
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

/** PA-137: a 20 MB file over a slow link, with room to spare. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

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

  /**
   * PA-137: where a file can be downloaded from. The Bot API serves files of
   * at most 20 MB this way, which is also `MAX_ATTACHMENT_BYTES`.
   */
  async getFile(fileId: string): Promise<{ filePath: string; fileSize: number | null }> {
    const result = (await this.call('getFile', { file_id: fileId })) as { file_path?: string; file_size?: number };
    if (!result.file_path) throw new TelegramApiError('Telegram did not return a path for that file.');
    return { filePath: result.file_path, fileSize: result.file_size ?? null };
  }

  /**
   * PA-137: the file's bytes, as a stream the caller caps. The URL carries
   * the bot token, so no error from here ever includes it: a failure is
   * reported as a fixed sentence plus the status, never the underlying
   * message (which, for a fetch error, can echo the URL).
   */
  async downloadFile(filePath: string, signal?: AbortSignal): Promise<Readable> {
    if (!/^[A-Za-z0-9_\-./]{1,512}$/.test(filePath) || filePath.includes('..')) {
      throw new TelegramApiError('Telegram returned an unexpected file path.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener('abort', onExternalAbort);
    let res: Response;
    try {
      res = await this.fetchImpl(`https://api.telegram.org/file/bot${this.token}/${filePath}`, {
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
      throw new TelegramApiError('Downloading the file from Telegram failed.');
    }
    if (!res.ok || !res.body) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
      throw new TelegramApiError(`Downloading the file from Telegram failed (HTTP ${res.status}).`, res.status);
    }
    const source = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
    const out = new PassThrough();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    };
    // A mid-stream failure must not carry the URL either, so it is replaced
    // rather than forwarded — and destroys `out`, so a reader never hangs.
    source.once('error', () => {
      done();
      out.destroy(new TelegramApiError('Downloading the file from Telegram failed.'));
    });
    source.once('end', done);
    // A reader that gives up (the size cap) stops the download too.
    out.once('close', () => {
      done();
      source.destroy();
    });
    source.pipe(out);
    return out;
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
