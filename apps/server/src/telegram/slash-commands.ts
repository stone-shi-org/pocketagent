/**
 * PA-53: Pocket Agent's `/clear`, `/context` and `/mcp` slash commands (and
 * PA-121's `/compact`),
 * reimplemented for Telegram.
 *
 * There is no server-side slash-command mechanism for Pocket Agent chats
 * today — the web UI's own three commands (`apps/web/src/pages/
 * PlannerChatPage.tsx`) are intercepted entirely client-side and call
 * existing REST endpoints directly (`clearPlannerChatHistory`,
 * `context-preview`, `listMcpRegistries`); none of that logic ever reaches
 * the server as a chat message, so there is nothing to reuse from here.
 * Telegram has no client-side JS, so the interception has to move into
 * `bridge.ts`, before a message is ever handed to `PlannerChatService.sendMessage`.
 *
 * This module only *recognizes* a command; `TelegramBridge.runSlashCommand`
 * carries out each one's actual effect, since that needs live service
 * instances (`PlannerChatService`, `McpRegistryService`) this module has no
 * business holding.
 */

export type TelegramSlashCommand = 'clear' | 'context' | 'mcp' | 'compact' | 'undo';

/** Aliases mirror `PLANNER_SLASH_COMMANDS` in `PlannerChatPage.tsx` exactly —
    `/reset` is a synonym for `/clear` there, and stays one here so the two
    surfaces cannot silently drift on which words mean what. */
const COMMAND_ALIASES: Record<string, TelegramSlashCommand> = {
  clear: 'clear',
  reset: 'clear',
  context: 'context',
  mcp: 'mcp',
  // PA-121: summarize the chat's history now, as in the web chat.
  compact: 'compact',
  // PA-143: undo the last turn that modified document workspace files.
  undo: 'undo',
};

/**
 * Recognize a leading slash command in an inbound Telegram message, Telegram
 * `/command@BotUsername` suffix included (Telegram appends `@BotUsername` in
 * a group chat so multiple bots can share it; irrelevant here since every
 * pairing is a private 1:1 chat, but stripped defensively rather than left to
 * silently fail to match).
 */
export function interceptSlashCommand(text: string): TelegramSlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const firstWord = trimmed.slice(1).split(/\s+/)[0] ?? '';
  const bare = (firstWord.split('@')[0] ?? '').toLowerCase();
  return COMMAND_ALIASES[bare] ?? null;
}
