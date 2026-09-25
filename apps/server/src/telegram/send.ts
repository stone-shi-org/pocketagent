/**
 * PA-105: every formatted message Telegram receives goes through here, so
 * the plain-text fallback exists in exactly one place.
 *
 * The rule: **a formatting bug may lose the formatting, never the message.**
 * If Telegram answers `400 can't parse entities`, the same chunk is resent
 * as plain text and a warning is logged. The plain text is the chunk's
 * original Markdown, not the HTML, which would arrive with visible tags. Any
 * other failure (a revoked token, a network error, a blocked bot) is not
 * caused by formatting, so resending would fail the same way. It propagates
 * exactly as it did before PA-105.
 *
 * The log line carries Telegram's error description and nothing from the
 * message itself. The text is model output and may carry whatever a
 * webhook-driven chat was fed.
 */
import {
  TelegramApiError,
  type TelegramClient,
  type TelegramSendMessageOptions,
} from './client.js';
import { markdownToTelegramHtml, splitMarkdownForTelegram, visibleLength } from './format.js';

export interface TelegramSendLogger {
  warn: (obj: unknown, msg?: string) => void;
}

/** True only for Telegram rejecting the markup itself. */
export function isEntityParseError(err: unknown): boolean {
  return (
    err instanceof TelegramApiError &&
    err.status === 400 &&
    /can't parse entities/i.test(err.message)
  );
}

/** Send `html` with `parse_mode: HTML`, falling back to `plain` if Telegram
    cannot parse it. `replyMarkup` rides on both attempts, so an approval
    prompt keeps its buttons either way. */
export async function sendHtmlWithPlainFallback(
  client: TelegramClient,
  telegramChatId: string,
  html: string,
  plain: string,
  opts: {
    replyMarkup?: TelegramSendMessageOptions['replyMarkup'];
    logger?: TelegramSendLogger;
  } = {},
): Promise<void> {
  const replyMarkup = opts.replyMarkup ? { replyMarkup: opts.replyMarkup } : {};
  try {
    await client.sendMessage(telegramChatId, html, { parseMode: 'HTML', ...replyMarkup });
  } catch (err) {
    if (!isEntityParseError(err)) throw err;
    opts.logger?.warn(
      { telegramError: (err as Error).message },
      'Telegram rejected a formatted message; resending it as plain text',
    );
    await client.sendMessage(telegramChatId, plain, replyMarkup);
  }
}

/**
 * Deliver model-written Markdown as one or more formatted messages. It is
 * split on block boundaries *before* conversion (see
 * `splitMarkdownForTelegram`), so no tag or fence spans two messages. The
 * return value is the number of messages sent.
 */
export async function sendMarkdown(
  client: TelegramClient,
  telegramChatId: string,
  markdown: string,
  opts: { logger?: TelegramSendLogger } = {},
): Promise<number> {
  const chunks = splitMarkdownForTelegram(markdown);
  for (const chunk of chunks) {
    const html = markdownToTelegramHtml(chunk);
    // Telegram refuses a message whose parsed text is empty (a chunk that
    // was only an empty fence, say). Sending the source keeps "nothing
    // lost" true.
    if (visibleLength(html) === 0) await client.sendMessage(telegramChatId, chunk);
    else await sendHtmlWithPlainFallback(client, telegramChatId, html, chunk, opts);
  }
  return chunks.length;
}

/** Plain text (notices, slash-command replies), split on the same
    boundaries but never given a `parse_mode`. */
export async function sendPlainText(
  client: TelegramClient,
  telegramChatId: string,
  text: string,
): Promise<void> {
  for (const chunk of splitMarkdownForTelegram(text, { rich: false })) {
    await client.sendMessage(telegramChatId, chunk);
  }
}
