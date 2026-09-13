import { z } from 'zod';

/**
 * PA-53: Telegram as a second conversational surface for Pocket Agent, in
 * parallel to the web UI.
 *
 * A `telegram_bots` row is a configured bot — its token encrypted at rest
 * with the same `crypto/secret-box.ts` primitive `custom_claude_providers`
 * already uses, following that store's shape closely (see
 * `TelegramBotStore`'s own doc comment). A `telegram_links` row pairs one
 * Telegram chat id to one Pocket Agent workspace, and that pairing is what
 * gives the id its own, independent planner chat — "session from telegram id
 * will be it's own session" falls directly out of the pairing's primary key
 * being `(bot_id, telegram_chat_id)`.
 */

export const TelegramBotSummary = z.object({
  id: z.string(),
  name: z.string(),
  /** Never the token itself, in either plaintext or ciphertext — the same
      "presence, not value" idiom `PlannerSettingsDto.hasApiKey` already uses.
      There is deliberately no reveal endpoint (see `TelegramBotStore`). */
  hasBotToken: z.boolean(),
  /** Resolved via the Bot API's `getMe` after a successful save or "Test",
      shown so an operator can confirm which bot a token actually belongs to.
      Null until that has happened once. */
  botUsername: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type TelegramBotSummary = z.infer<typeof TelegramBotSummary>;

/**
 * `encryptionAvailable` is false when `POCKETAGENT_SETTINGS_ENC_KEY` is
 * unset — mirrors `CustomClaudeProviderListResponse`: existing bots still
 * list, but nothing can be created or edited until a key is configured.
 */
export const TelegramBotListResponse = z.object({
  bots: z.array(TelegramBotSummary),
  encryptionAvailable: z.boolean(),
});
export type TelegramBotListResponse = z.infer<typeof TelegramBotListResponse>;

const NAME = z.string().min(1).max(128);
const BOT_TOKEN = z.string().max(512);

export const CreateTelegramBotRequest = z.object({
  name: NAME,
  /** Plaintext, only ever on the wire — encrypted before it reaches the
      database and never sent back. Required on create. */
  botToken: BOT_TOKEN.min(1),
  enabled: z.boolean().optional(),
});
export type CreateTelegramBotRequest = z.infer<typeof CreateTelegramBotRequest>;

/**
 * Partial update. `botToken` omitted or blank keeps the stored token — same
 * convention as `UpdateCustomClaudeProviderRequest.apiKey`: the editor's
 * token field starts empty (there is nothing to prefill it with, by design),
 * so a save must not treat blank as "clear it".
 */
export const UpdateTelegramBotRequest = z.object({
  name: NAME.optional(),
  botToken: BOT_TOKEN.optional(),
  enabled: z.boolean().optional(),
});
export type UpdateTelegramBotRequest = z.infer<typeof UpdateTelegramBotRequest>;

/** `POST /api/telegram/bots/:id/test`'s response — calls the Bot API's
    `getMe` with whichever token is currently stored (or, mid-create-form, the
    one just typed) and reports back rather than silently saving a bad token. */
export const TelegramBotTestResult = z.object({
  ok: z.boolean(),
  message: z.string(),
  username: z.string().nullable(),
});
export type TelegramBotTestResult = z.infer<typeof TelegramBotTestResult>;

/** One paired Telegram chat id, as the browser sees it. */
export const TelegramLink = z.object({
  botId: z.string(),
  telegramChatId: z.string(),
  /** Display-only label (an `@username` or first name), filled in from the
      first inbound message once the pairing is used; not required at pairing
      time since a numeric chat id is all Telegram guarantees an operator can
      obtain up front. */
  telegramUserLabel: z.string().nullable(),
  workspaceId: z.string().nullable(),
  /** Copied at pairing/rename time, the same redundant-display-fallback
      convention `webhook_deliveries.webhook_name` uses, so a pairing whose
      Pocket Agent was since deleted still shows what it *was* paired to. */
  workspaceName: z.string().nullable(),
  /** Set once the pairing's first message has created a chat; null until then. */
  plannerChatId: z.string().nullable(),
  /**
   * Per-pairing, off-by-default opt-in that pre-approves this pairing's
   * mutating tool calls — the sixth documented override of "never answer a
   * prompt for the user" (see CLAUDE.md). Unlike a webhook-created chat's
   * `skipToolApprovalsEnabled` (on by default, because nobody is watching a
   * webhook), a Telegram pairing has exactly the human it's paired to,
   * present the whole time — so the default here is real approval relay over
   * Telegram, and this stays off unless an operator deliberately wants one
   * paired id to run unattended.
   */
  skipToolApprovals: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type TelegramLink = z.infer<typeof TelegramLink>;

export const TelegramLinkListResponse = z.object({
  links: z.array(TelegramLink),
});
export type TelegramLinkListResponse = z.infer<typeof TelegramLinkListResponse>;

export const CreateTelegramLinkRequest = z.object({
  telegramChatId: z.string().min(1).max(64),
  telegramUserLabel: z.string().max(200).nullable().optional(),
  workspaceId: z.string().min(1),
  skipToolApprovals: z.boolean().optional(),
});
export type CreateTelegramLinkRequest = z.infer<typeof CreateTelegramLinkRequest>;

export const UpdateTelegramLinkRequest = z.object({
  workspaceId: z.string().min(1).optional(),
  skipToolApprovals: z.boolean().optional(),
});
export type UpdateTelegramLinkRequest = z.infer<typeof UpdateTelegramLinkRequest>;
