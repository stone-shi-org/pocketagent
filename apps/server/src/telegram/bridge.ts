import type { AgentEvent, PermissionRequestEvent, PlannerToolApprovalChoice } from '@pocketagent/protocol';
import { PlannerChatError, type PlannerChatService } from '../planner/chats.js';
import type { McpRegistryService } from '../planner/mcp/registry-service.js';
import type { TelegramLinksStore } from './links-store.js';
import { interceptSlashCommand } from './slash-commands.js';
import type { TelegramCallbackQuery, TelegramClient, TelegramMessage, TelegramUpdate } from './client.js';

/** Leaves room below Telegram's own 4096-character hard cap on one message's
    text rather than splitting at exactly that limit, so a
    chunk boundary landing mid multi-byte character (Telegram counts UTF-16
    code units, not bytes) has slack either side. */
const CHUNK_SIZE = 3800;

export interface TelegramBridgeDeps {
  links: TelegramLinksStore;
  plannerChats: PlannerChatService;
  mcpRegistry: McpRegistryService;
  logger?: { warn: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void };
}

/**
 * PA-53: turns one Telegram bot's inbound updates into Pocket Agent chat
 * turns, and that chat's events back into Telegram replies.
 *
 * Deliberately separate from `poller.ts` (which only owns *fetching*
 * updates via long-poll) so this class is unit-testable against a fake
 * `TelegramClient` with no real long-poll loop involved.
 *
 * The resolve-or-create-chat / observe-before-prompt / await-first-yield
 * shape below is `RunExecutor.startPocketAgent`'s exact pattern
 * (`runs/executor.ts`) — driving a chat turn with no browser attached is not
 * a new problem, a webhook already solved it, and this reuses that solution
 * rather than inventing a second one.
 */
export class TelegramBridge {
  constructor(private readonly deps: TelegramBridgeDeps) {}

  async handleUpdate(botId: string, update: TelegramUpdate, client: TelegramClient): Promise<void> {
    if (update.callback_query) {
      await this.handleCallbackQuery(botId, update.callback_query, client);
      return;
    }
    const message = update.message;
    if (!message || typeof message.text !== 'string' || message.text.length === 0) return;
    await this.handleMessage(botId, message, client);
  }

  private async handleMessage(botId: string, message: TelegramMessage, client: TelegramClient): Promise<void> {
    const telegramChatId = String(message.chat.id);
    const link = this.deps.links.get(botId, telegramChatId);
    if (!link) {
      await client.sendMessage(
        telegramChatId,
        'This Telegram chat is not paired with a Pocket Agent yet. Ask an operator to pair it under ' +
          'Settings -> Telegram.',
      );
      return;
    }

    // Opportunistic refresh, the same "read fresh, degrade quietly" posture
    // every other cache row in this app takes — never blocks the reply on it.
    const label = message.from?.username ? `@${message.from.username}` : (message.from?.first_name ?? null);
    if (label) this.deps.links.touchLabel(botId, telegramChatId, label);

    const text = message.text!.trim();
    const command = interceptSlashCommand(text);
    if (command) {
      const reply = await this.runSlashCommand(command, link.plannerChatId, link.workspaceId);
      await this.sendChunked(client, telegramChatId, reply);
      return;
    }

    if (!link.workspaceId) {
      await client.sendMessage(
        telegramChatId,
        'This pairing has no Pocket Agent assigned. Ask an operator to fix it under Settings -> Telegram.',
      );
      return;
    }

    let chat = link.plannerChatId ? this.deps.plannerChats.get(link.plannerChatId) : null;
    if (!chat) {
      try {
        chat = this.deps.plannerChats.create({
          workspaceId: link.workspaceId,
          skipToolApprovals: link.skipToolApprovals,
        });
      } catch (err) {
        const reason = err instanceof PlannerChatError ? err.message : (err as Error).message;
        await client.sendMessage(telegramChatId, `Could not start a chat: ${reason}`);
        return;
      }
      this.deps.links.setPlannerChatId(botId, telegramChatId, chat.id);
    }
    const chatId = chat.id;

    // Watch before prompting — see `PlannerChatService.observe`'s own doc
    // comment. A turn that pauses for approval ends its generator while
    // genuinely still running; without this, the reply and the approval
    // prompt below would never be seen.
    const unsubscribe = this.deps.plannerChats.observe(chatId, (event) => {
      void this.forwardEvent(botId, telegramChatId, event, client);
    });

    const turn = this.deps.plannerChats.sendMessage(chatId, text);
    try {
      const first = await turn.next();
      if (first.done === true) {
        unsubscribe();
        return;
      }
    } catch (err) {
      unsubscribe();
      await client.sendMessage(telegramChatId, `Error: ${(err as Error).message}`);
      return;
    }

    void this.drain(turn, unsubscribe, telegramChatId, client);
  }

  private async handleCallbackQuery(
    botId: string,
    query: TelegramCallbackQuery,
    client: TelegramClient,
  ): Promise<void> {
    const parsed = parseApprovalCallbackData(query.data);
    const telegramChatId = query.message ? String(query.message.chat.id) : null;
    if (!parsed || !telegramChatId) {
      await client.answerCallbackQuery(query.id, 'This button is no longer valid.');
      return;
    }
    const link = this.deps.links.get(botId, telegramChatId);
    if (!link?.plannerChatId) {
      await client.answerCallbackQuery(query.id, 'No conversation found for this pairing.');
      return;
    }

    await client.answerCallbackQuery(query.id);
    const chatId = link.plannerChatId;
    const unsubscribe = this.deps.plannerChats.observe(chatId, (event) => {
      void this.forwardEvent(botId, telegramChatId, event, client);
    });
    const turn = this.deps.plannerChats.resolveApproval(chatId, parsed.approvalId, parsed.choice);
    try {
      const first = await turn.next();
      if (first.done === true) {
        unsubscribe();
        return;
      }
    } catch (err) {
      unsubscribe();
      await client.sendMessage(telegramChatId, `Error: ${(err as Error).message}`);
      return;
    }
    void this.drain(turn, unsubscribe, telegramChatId, client);
  }

  /** Pump a turn's generator to completion in the background — somebody has
      to, or it never advances past whatever it just yielded — mirroring
      `RunExecutor.startPocketAgent`'s own background drain exactly. */
  private async drain(
    turn: AsyncGenerator<AgentEvent>,
    unsubscribe: () => void,
    telegramChatId: string,
    client: TelegramClient,
  ): Promise<void> {
    try {
      while (true) {
        const next = await turn.next();
        if (next.done === true) break;
      }
    } catch (err) {
      this.deps.logger?.warn({ err }, 'Telegram bridge turn failed while streaming');
      await client.sendMessage(telegramChatId, `Error: ${(err as Error).message}`).catch(() => {});
    } finally {
      unsubscribe();
    }
  }

  /**
   * Translate one persisted chat event into a Telegram side effect. Only
   * `text` (the final reply), `permission_request` (an approval relay, see
   * §5 of the approved plan) and `notice` (a mid-stream error) produce
   * anything — `text_delta` is transport-only and Telegram is not a
   * token-streaming surface, and `tool_use`/`tool_result`/`turn_complete`/
   * `permission_resolved` have no useful rendering in a chat bubble.
   */
  private async forwardEvent(
    botId: string,
    telegramChatId: string,
    event: AgentEvent,
    client: TelegramClient,
  ): Promise<void> {
    try {
      if (event.kind === 'text' && event.text.trim().length > 0) {
        await this.sendChunked(client, telegramChatId, event.text);
      } else if (event.kind === 'permission_request') {
        await this.sendApprovalPrompt(telegramChatId, event, client);
      } else if (event.kind === 'notice' && event.level !== 'info') {
        await client.sendMessage(telegramChatId, event.text);
      }
    } catch (err) {
      this.deps.logger?.warn({ err, botId }, 'Telegram bridge failed to forward an event');
    }
  }

  private async sendApprovalPrompt(
    telegramChatId: string,
    event: PermissionRequestEvent,
    client: TelegramClient,
  ): Promise<void> {
    const row = (choices: [string, PlannerToolApprovalChoice][]) =>
      choices.map(([label, choice]) => ({
        text: label,
        callback_data: approvalCallbackData(event.id, choice),
      }));
    await client.sendMessage(telegramChatId, `Approval needed: ${event.title}`, {
      replyMarkup: {
        inline_keyboard: [
          row([
            ['Allow once', 'allow_once'],
            ['Allow (this agent)', 'allow_workspace'],
          ]),
          row([
            ['Allow (always)', 'allow_global'],
            ['Deny', 'deny'],
          ]),
        ],
      },
    });
  }

  private async sendChunked(client: TelegramClient, telegramChatId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    for (let i = 0; i < trimmed.length; i += CHUNK_SIZE) {
      await client.sendMessage(telegramChatId, trimmed.slice(i, i + CHUNK_SIZE));
    }
  }

  /**
   * Carry out `/clear`, `/context` or `/mcp` directly against the service
   * layer — no HTTP round trip, since this runs inside the server that would
   * otherwise be answering that request. See `slash-commands.ts`'s own doc
   * comment for why this cannot instead reuse the web UI's implementation.
   */
  private async runSlashCommand(
    command: 'clear' | 'context' | 'mcp',
    plannerChatId: string | null,
    workspaceId: string | null,
  ): Promise<string> {
    if (command === 'mcp') {
      const registries = this.deps.mcpRegistry.list().filter((r) => r.enabled);
      if (registries.length === 0) return 'No MCP registries are configured and enabled.';
      return registries.map((r) => `- ${r.name}: ${r.toolCount} tool(s)`).join('\n');
    }

    if (!plannerChatId) {
      // Nothing has been said in this pairing yet, so there is no chat and no
      // context to act on — not an error, just nothing to do.
      return command === 'clear' ? 'There is no conversation to clear yet.' : 'There is no conversation yet.';
    }

    if (command === 'clear') {
      await this.deps.plannerChats.clearHistory(plannerChatId);
      return 'History cleared.';
    }

    // command === 'context'
    const preview = await this.deps.plannerChats.previewContext(plannerChatId);
    const lines = [
      `Context window: ${preview.window.inWindowMessages} message(s) in window, ` +
        `${preview.window.foldedMessages} folded into memory (limit ${preview.window.windowLimit}).`,
    ];
    if (!preview.memoryEnabled) {
      lines.push('Memory is disabled for this agent.');
    } else if (preview.candidates.length === 0) {
      lines.push('No memory candidates yet.');
    } else {
      lines.push('Memory candidates:');
      for (const candidate of preview.candidates) {
        const mark = candidate.selected ? '*' : '-';
        lines.push(`${mark} (${candidate.score.toFixed(2)}) ${candidate.memory.content}`);
      }
    }
    void workspaceId; // kept for a future per-workspace formatting hook; unused today
    return lines.join('\n');
  }
}

/** `<approvalId>:<choice>` — well under Telegram's 64-byte `callback_data`
    limit (a UUID plus the longest choice string is ~52 bytes), and `:` never
    appears in either part so a plain split is exact. */
function approvalCallbackData(approvalId: string, choice: PlannerToolApprovalChoice): string {
  return `${approvalId}:${choice}`;
}

const VALID_CHOICES: ReadonlySet<string> = new Set(['allow_once', 'allow_workspace', 'allow_global', 'deny']);

function parseApprovalCallbackData(
  data: string | undefined,
): { approvalId: string; choice: PlannerToolApprovalChoice } | null {
  if (!data) return null;
  const idx = data.lastIndexOf(':');
  if (idx < 0) return null;
  const approvalId = data.slice(0, idx);
  const choice = data.slice(idx + 1);
  if (!approvalId || !VALID_CHOICES.has(choice)) return null;
  return { approvalId, choice: choice as PlannerToolApprovalChoice };
}
