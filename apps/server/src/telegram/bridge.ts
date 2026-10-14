import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_PROMPT,
  MAX_IMAGE_BYTES,
  type AgentEvent,
  type PermissionRequestEvent,
  type PlannerToolApprovalChoice,
  type PromptAttachment,
  type PromptImage,
} from '@pocketagent/protocol';
import { AttachmentError, type AttachmentStaging } from '../attachments/index.js';
import { PlannerChatError, type PlannerChatService } from '../planner/chats.js';
import type { McpRegistryService } from '../planner/mcp/registry-service.js';
import type { TelegramLinksStore } from './links-store.js';
import { interceptSlashCommand, type TelegramSlashCommand } from './slash-commands.js';
import type {
  TelegramCallbackQuery,
  TelegramClient,
  TelegramMessage,
  TelegramPhotoSize,
  TelegramUpdate,
} from './client.js';
import { escapeHtml } from './format.js';
import { sendHtmlWithPlainFallback, sendMarkdown, sendPlainText } from './send.js';

/** How much of a tool call's input an approval prompt shows. It is the
    model's own argument, so it can be arbitrarily long, and the prompt has to
    fit one message because the buttons ride on it. */
const APPROVAL_INPUT_MAX = 3000;
const APPROVAL_TITLE_MAX = 300;

/** Truncate without splitting a surrogate pair. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = max;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return `${s.slice(0, cut)}\n… (truncated)`;
}

export interface TelegramBridgeDeps {
  links: TelegramLinksStore;
  plannerChats: PlannerChatService;
  mcpRegistry: McpRegistryService;
  /** PA-137: where a document sent to the bot is staged before it lands.
      Without it the bridge refuses files, as it did before PA-137. */
  attachmentStaging?: AttachmentStaging;
  /** PA-137: how long an album waits for its next part. Default 1.5 s. */
  albumWindowMs?: number;
  logger?: { warn: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void };
}

/** PA-137: a message's files, downloaded and landed. */
interface ReceivedMedia {
  image?: PromptImage;
  attachments: PromptAttachment[];
}

/** PA-137: Telegram's own album limit. */
const MAX_ALBUM_PARTS = 10;
const DEFAULT_ALBUM_WINDOW_MS = 1500;
/** The browser's downscale target (`apps/web/src/agent/image-budget.ts`); a
    Telegram photo size above it is skipped for a smaller one. */
const MAX_PHOTO_SIDE_PX = 2000;

/**
 * PA-137: the photo size to send inline — the largest that fits the image
 * budget (bytes and sides), else the smallest Telegram made. Telegram lists
 * sizes smallest first and always encodes them as JPEG.
 */
export function pickPhotoSize(sizes: readonly TelegramPhotoSize[]): TelegramPhotoSize | null {
  if (sizes.length === 0) return null;
  const fits = sizes.filter(
    (s) => Math.max(s.width, s.height) <= MAX_PHOTO_SIDE_PX && (s.file_size === undefined || s.file_size <= MAX_IMAGE_BYTES),
  );
  const pool = fits.length > 0 ? fits : [...sizes].sort((a, b) => a.width * a.height - b.width * b.height).slice(0, 1);
  return pool.reduce((best, s) => (s.width * s.height > best.width * best.height ? s : best));
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
  /**
   * PA-122: one relay per paired chat, held until the chat has nothing left
   * for the person (`PlannerChatService.whenIdle`) rather than until the turn
   * this bridge started ends. A message sent while the chat is busy is
   * queued and may be answered by a follow-up turn nobody here is draining;
   * a relay tied to one turn would never forward that reply. One per chat,
   * so a turn and a steer landing in it are not forwarded twice.
   */
  private readonly relays = new Map<string, () => void>();

  /**
   * PA-137: albums being collected. An album arrives as several updates
   * sharing a `media_group_id`, with no marker on the last one, so each part
   * restarts a short timer and the whole album becomes one message when it
   * runs out (the reporter's choice on the ticket: coalesce). Nothing is
   * downloaded while buffering — the pairing check comes first, as for any
   * message.
   */
  private readonly albums = new Map<string, { messages: TelegramMessage[]; timer: NodeJS.Timeout; client: TelegramClient }>();

  constructor(private readonly deps: TelegramBridgeDeps) {}

  /** Flushes nothing: pending albums are dropped. Called on shutdown. */
  stop(): void {
    for (const album of this.albums.values()) clearTimeout(album.timer);
    this.albums.clear();
  }

  private bufferAlbum(botId: string, message: TelegramMessage, client: TelegramClient): void {
    const key = `${botId}\u0000${String(message.chat.id)}\u0000${message.media_group_id}`;
    const existing = this.albums.get(key);
    if (existing) clearTimeout(existing.timer);
    const messages = existing?.messages ?? [];
    if (messages.length < MAX_ALBUM_PARTS) messages.push(message);
    const timer = setTimeout(() => {
      this.albums.delete(key);
      void this.handleMessage(botId, messages, client).catch((err: unknown) =>
        this.deps.logger?.warn({ err, botId }, 'Telegram bridge failed to handle an album'),
      );
    }, this.deps.albumWindowMs ?? DEFAULT_ALBUM_WINDOW_MS);
    timer.unref?.();
    this.albums.set(key, { messages, timer, client });
  }

  private ensureRelay(botId: string, telegramChatId: string, chatId: string, client: TelegramClient): void {
    const key = `${botId}\u0000${telegramChatId}\u0000${chatId}`;
    if (this.relays.has(key)) return;
    const unsubscribe = this.deps.plannerChats.observe(chatId, (event) => {
      void this.forwardEvent(botId, telegramChatId, event, client);
    });
    const stopWaiting = this.deps.plannerChats.whenIdle(chatId, () => this.endRelay(key));
    this.relays.set(key, () => {
      unsubscribe();
      stopWaiting();
    });
  }

  private endRelay(key: string): void {
    const stop = this.relays.get(key);
    if (!stop) return;
    this.relays.delete(key);
    stop();
  }

  private endRelayIfIdle(botId: string, telegramChatId: string, chatId: string): void {
    if (!this.deps.plannerChats.isBusy(chatId)) this.endRelay(`${botId}\u0000${telegramChatId}\u0000${chatId}`);
  }

  /** PA-122: a message for a chat that is mid-turn is queued, not refused. */
  private async queueForBusyChat(
    botId: string,
    telegramChatId: string,
    chatId: string,
    text: string,
    client: TelegramClient,
    media: ReceivedMedia = { attachments: [] },
  ): Promise<void> {
    try {
      this.deps.plannerChats.queuePrompt(chatId, text, {
        ...(media.image ? { image: media.image } : {}),
        ...(media.attachments.length > 0 ? { attachments: media.attachments } : {}),
      });
    } catch (err) {
      this.deps.plannerChats.removeAttachments(chatId, media.attachments);
      await client.sendMessage(telegramChatId, `Error: ${(err as Error).message}`);
      return;
    }
    this.ensureRelay(botId, telegramChatId, chatId, client);
    await client.sendMessage(telegramChatId, "Queued — I'll read this after the current step.");
  }

  async handleUpdate(botId: string, update: TelegramUpdate, client: TelegramClient): Promise<void> {
    if (update.callback_query) {
      await this.handleCallbackQuery(botId, update.callback_query, client);
      return;
    }
    const message = update.message;
    if (!message) return;
    const hasText = typeof message.text === 'string' && message.text.length > 0;
    // PA-137: a document or a photo is a message too, with or without a caption.
    const hasMedia = message.document !== undefined || (message.photo?.length ?? 0) > 0;
    if (!hasText && !hasMedia) return;
    if (hasMedia && message.media_group_id) {
      this.bufferAlbum(botId, message, client);
      return;
    }
    await this.handleMessage(botId, [message], client);
  }

  /** One message, or (PA-137) every part of one album. */
  private async handleMessage(botId: string, parts: TelegramMessage[], client: TelegramClient): Promise<void> {
    const message = parts[0]!;
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

    const text = (parts.map((p) => p.text ?? p.caption ?? '').find((t) => t.trim().length > 0) ?? '').trim();
    const hasMedia = parts.some((p) => p.document !== undefined || (p.photo?.length ?? 0) > 0);
    const command = hasMedia ? null : interceptSlashCommand(text);
    if (command === 'undo') {
      await this.runUndoCommand(telegramChatId, link.plannerChatId, client);
      return;
    }
    if (command) {
      const reply = await this.runSlashCommand(command, link.plannerChatId, link.workspaceId, text);
      // Plain text: these replies are ours, not the model's, and carry no
      // Markdown worth rendering (PA-105).
      await sendPlainText(client, telegramChatId, reply);
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

    let media: ReceivedMedia = { attachments: [] };
    if (hasMedia) {
      const received = await this.receiveMedia(botId, telegramChatId, chatId, parts, client);
      if (!received) return;
      media = received;
    }

    if (this.deps.plannerChats.isBusy(chatId)) {
      await this.queueForBusyChat(botId, telegramChatId, chatId, text, client, media);
      return;
    }

    // Watch before prompting — see `PlannerChatService.observe`'s own doc
    // comment. A turn that pauses for approval ends its generator while
    // genuinely still running; without this, the reply and the approval
    // prompt below would never be seen.
    this.ensureRelay(botId, telegramChatId, chatId, client);

    const turn = this.deps.plannerChats.sendMessage(chatId, text, {
      ...(media.image ? { image: media.image } : {}),
      ...(media.attachments.length > 0 ? { attachments: media.attachments } : {}),
    });
    try {
      const first = await turn.next();
      if (first.done === true) {
        this.endRelayIfIdle(botId, telegramChatId, chatId);
        return;
      }
    } catch (err) {
      // Another turn started between the check above and this one.
      if (err instanceof PlannerChatError && err.code === 'busy') {
        await this.queueForBusyChat(botId, telegramChatId, chatId, text, client, media);
        return;
      }
      // Refused outright: what it landed goes, as for a refused web message.
      this.deps.plannerChats.removeAttachments(chatId, media.attachments);
      this.endRelayIfIdle(botId, telegramChatId, chatId);
      await client.sendMessage(telegramChatId, `Error: ${(err as Error).message}`);
      return;
    }

    void this.drain(turn, telegramChatId, client);
  }

  /**
   * PA-137: downloads a message's photos and documents and lands them in the
   * chat's workspace, exactly as a web upload lands (`landAttachments`, so
   * extraction and inlining follow). Runs only for a paired chat with an
   * agent: an unpaired chat was refused above before a byte was fetched.
   * The first photo goes inline as the message's image, as on the web; any
   * further photo and every document is a file. Returns `null` after
   * replying when the files cannot be received, and then nothing is sent.
   *
   * The download URL carries the bot token, so nothing here logs a URL or a
   * download error's own message — `TelegramClient.downloadFile` only ever
   * throws fixed sentences.
   */
  private async receiveMedia(
    botId: string,
    telegramChatId: string,
    chatId: string,
    parts: TelegramMessage[],
    client: TelegramClient,
  ): Promise<ReceivedMedia | null> {
    const staging = this.deps.attachmentStaging;
    if (!staging) {
      await client.sendMessage(telegramChatId, 'This server does not accept files over Telegram.');
      return null;
    }
    const chats = this.deps.plannerChats;
    try {
      chats.assertCanAcceptFiles(chatId, chats.isBusy(chatId) ? 'queue' : 'send');
    } catch (err) {
      await client.sendMessage(telegramChatId, `Error: ${(err as Error).message}`);
      return null;
    }

    const principal = `telegram:${botId}`;
    const stagedIds: string[] = [];
    let image: PromptImage | undefined;
    let skipped = 0;
    try {
      for (const part of parts) {
        if (part.photo?.length) {
          const size = pickPhotoSize(part.photo);
          if (!size) continue;
          if (!image) {
            const data = await downloadToBuffer(client, size.file_id, MAX_IMAGE_BYTES);
            image = { mediaType: 'image/jpeg', data: data.toString('base64') };
            continue;
          }
          if (stagedIds.length >= MAX_ATTACHMENTS_PER_PROMPT) {
            skipped++;
            continue;
          }
          stagedIds.push(await this.stageFile(client, staging, size.file_id, `photo_${stagedIds.length + 1}.jpg`, 'image/jpeg', null, principal));
        }
        if (part.document) {
          if (stagedIds.length >= MAX_ATTACHMENTS_PER_PROMPT) {
            skipped++;
            continue;
          }
          const doc = part.document;
          stagedIds.push(
            await this.stageFile(
              client,
              staging,
              doc.file_id,
              doc.file_name ?? 'file',
              doc.mime_type ?? 'application/octet-stream',
              doc.file_size ?? null,
              principal,
            ),
          );
        }
      }
      const staged = staging.take(stagedIds, principal);
      const attachments = await chats.landAttachments(chatId, staging, staged);
      this.deps.logger?.info(
        { botId, files: attachments.length, bytes: attachments.reduce((n, f) => n + f.size, 0), photo: image !== undefined },
        'telegram attachments received',
      );
      if (skipped > 0) {
        await client.sendMessage(
          telegramChatId,
          `Only ${MAX_ATTACHMENTS_PER_PROMPT} files go with one message, so ${skipped} were left out.`,
        );
      }
      return { ...(image ? { image } : {}), attachments };
    } catch (err) {
      staging.discard(stagedIds, principal);
      const reason = err instanceof AttachmentError || err instanceof Error ? err.message : 'unknown error';
      this.deps.logger?.warn({ botId, code: (err as { code?: string }).code ?? null }, 'telegram attachment could not be received');
      await client.sendMessage(telegramChatId, `Could not receive the file: ${reason}`);
      return null;
    }
  }

  private async stageFile(
    client: TelegramClient,
    staging: AttachmentStaging,
    fileId: string,
    name: string,
    mediaType: string,
    declaredSize: number | null,
    principal: string,
  ): Promise<string> {
    if (declaredSize !== null && declaredSize > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError(`"${name}" is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB.`, 'too_large');
    }
    const { filePath } = await client.getFile(fileId);
    const body = await client.downloadFile(filePath);
    const staged = await staging.stage(body, { name, mediaType, principal });
    return staged.attachmentId;
  }

  private async handleCallbackQuery(
    botId: string,
    query: TelegramCallbackQuery,
    client: TelegramClient,
  ): Promise<void> {
    const telegramChatId = query.message ? String(query.message.chat.id) : null;
    if (!telegramChatId) {
      await client.answerCallbackQuery(query.id, 'This button is no longer valid.');
      return;
    }

    const parsedUndo = parseUndoCallbackData(query.data);
    if (parsedUndo) {
      const link = this.deps.links.get(botId, telegramChatId);
      if (!link?.plannerChatId) {
        await client.answerCallbackQuery(query.id, 'No conversation found for this pairing.');
        return;
      }
      if (parsedUndo.action === 'cancel') {
        await client.answerCallbackQuery(query.id, 'Undo cancelled.');
        await sendPlainText(client, telegramChatId, 'Undo cancelled.');
        return;
      }
      await client.answerCallbackQuery(query.id);
      try {
        const res = await this.deps.plannerChats.undoTurn(link.plannerChatId, parsedUndo.turnId, {
          force: parsedUndo.action === 'force',
        });
        if (!res.ok && res.skippedConflicts.length > 0) {
          const conflictLines = res.skippedConflicts.map(
            (c) => `- ${c.relPath} (changed since turn by ${c.currentActor})`,
          );
          await client.sendMessage(
            telegramChatId,
            `Some files changed since that turn:\n${conflictLines.join('\n')}\n\nOverwrite them anyway?`,
            {
              replyMarkup: {
                inline_keyboard: [
                  [
                    { text: 'Overwrite anyway', callback_data: undoCallbackData(parsedUndo.turnId, 'force') },
                    { text: 'Cancel', callback_data: undoCallbackData(parsedUndo.turnId, 'cancel') },
                  ],
                ],
              },
            },
          );
          return;
        }
        const restoredMsg =
          res.restoredPaths.length > 0
            ? `Undone (${res.restoredPaths.length} file${res.restoredPaths.length === 1 ? '' : 's'} restored: ${res.restoredPaths.join(', ')}).`
            : 'Nothing left to undo for that turn.';
        await sendPlainText(client, telegramChatId, restoredMsg);
      } catch (err) {
        await sendPlainText(client, telegramChatId, `Could not undo turn: ${(err as Error).message}`);
      }
      return;
    }

    const parsed = parseApprovalCallbackData(query.data);
    if (!parsed) {
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
    this.ensureRelay(botId, telegramChatId, chatId, client);
    const turn = this.deps.plannerChats.resolveApproval(chatId, parsed.approvalId, parsed.choice);
    try {
      const first = await turn.next();
      if (first.done === true) {
        this.endRelayIfIdle(botId, telegramChatId, chatId);
        return;
      }
    } catch (err) {
      this.endRelayIfIdle(botId, telegramChatId, chatId);
      await client.sendMessage(telegramChatId, `Error: ${(err as Error).message}`);
      return;
    }
    void this.drain(turn, telegramChatId, client);
  }

  /** Pump a turn's generator to completion in the background — somebody has
      to, or it never advances past whatever it just yielded — mirroring
      `RunExecutor.startPocketAgent`'s own background drain exactly. */
  private async drain(turn: AsyncGenerator<AgentEvent>, telegramChatId: string, client: TelegramClient): Promise<void> {
    try {
      while (true) {
        const next = await turn.next();
        if (next.done === true) break;
      }
    } catch (err) {
      this.deps.logger?.warn({ err }, 'Telegram bridge turn failed while streaming');
      await client.sendMessage(telegramChatId, `Error: ${(err as Error).message}`).catch(() => {});
    }
    // The relay is not ended here: it lasts until the chat is idle, which a
    // queued follow-up may postpone past this turn (`ensureRelay`).
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
      // PA-121: `interim` text is the model narrating its way to a tool
      // call; the chat bubble is for the answer, as it always was.
      if (event.kind === 'text' && !event.interim && event.text.trim().length > 0) {
        // PA-105: the model writes Markdown; Telegram renders its HTML subset.
        await sendMarkdown(client, telegramChatId, event.text, { logger: this.deps.logger });
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
    // PA-105: the title and the arguments are both the model's tool input, so
    // both are escaped before any tag is added. The arguments go in `<pre>`
    // because a human is being asked to approve exactly this call, and
    // before PA-105 the prompt did not show them at all.
    const title = truncate(event.title, APPROVAL_TITLE_MAX);
    const input = formatApprovalInput(event, APPROVAL_INPUT_MAX);
    const html = `Approval needed: <b>${escapeHtml(title)}</b>` + (input ? `\n<pre>${escapeHtml(input)}</pre>` : '');
    const plain = `Approval needed: ${title}` + (input ? `\n${input}` : '');
    await sendHtmlWithPlainFallback(client, telegramChatId, html, plain, {
      logger: this.deps.logger,
      replyMarkup: {
        inline_keyboard: approvalKeyboard(event.rememberScopes).map(row),
      },
    });
  }

  /**
   * Carry out `/clear`, `/context` or `/mcp` directly against the service
   * layer — no HTTP round trip, since this runs inside the server that would
   * otherwise be answering that request. See `slash-commands.ts`'s own doc
   * comment for why this cannot instead reuse the web UI's implementation.
   */
  private async runSlashCommand(
    command: TelegramSlashCommand,
    plannerChatId: string | null,
    workspaceId: string | null,
    text = '',
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

    if (command === 'compact') {
      // Anything after the command is what the summary should focus on.
      const focus = text.trim().replace(/^\/\S+\s*/, '');
      try {
        const result = await this.deps.plannerChats.compact(plannerChatId, focus || null);
        return result.compacted
          ? `Compacted: about ${result.tokensBefore.toLocaleString('en-US')} → ${result.tokensAfter.toLocaleString('en-US')} tokens of context.`
          : result.message;
      } catch (err) {
        return `Could not compact: ${(err as Error).message}`;
      }
    }

    // command === 'context'
    const preview = await this.deps.plannerChats.previewContext(plannerChatId);
    const budget = preview.budget;
    const lines =
      budget?.compactionEnabled
        ? [
            // PA-121: a token budget, not a turn count, once compaction is on.
            `Context: about ${preview.totalTokens.toLocaleString('en-US')} of ${budget.contextWindow.toLocaleString('en-US')} ` +
              `tokens (${budget.modelId ?? 'no model'}${budget.contextWindowSource === 'model' ? '' : ', window assumed'}); ` +
              `compacts at ${budget.thresholdTokens.toLocaleString('en-US')}.`,
            budget.compactions > 0
              ? `Compacted ${budget.compactions} time(s); ${preview.window.inWindowMessages} message(s) kept after the latest summary.`
              : `${preview.window.inWindowMessages} message(s) in context, not compacted yet.`,
          ]
        : [
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

  private async runUndoCommand(
    telegramChatId: string,
    plannerChatId: string | null,
    client: TelegramClient,
  ): Promise<void> {
    if (!plannerChatId) {
      await sendPlainText(client, telegramChatId, 'There is no conversation to undo yet.');
      return;
    }
    const last = await this.deps.plannerChats.findLastUndoableTurn(plannerChatId);
    if (!last) {
      await sendPlainText(client, telegramChatId, 'Nothing to undo — no recent turn changed any workspace files.');
      return;
    }
    const fileLines = last.changedFiles.map(
      (f) => `- ${f.relPath}${f.summary ? ` (${f.summary})` : ''}`,
    );
    const msg =
      `Undo the last turn's changes (${last.changedFiles.length} file${last.changedFiles.length === 1 ? '' : 's'})?\n` +
      fileLines.join('\n');
    await client.sendMessage(telegramChatId, msg, {
      replyMarkup: {
        inline_keyboard: [
          [
            { text: 'Undo turn', callback_data: undoCallbackData(last.turnId, 'confirm') },
            { text: 'Cancel', callback_data: undoCallbackData(last.turnId, 'cancel') },
          ],
        ],
      },
    });
  }
}

/** `<approvalId>:<choice>` — well under Telegram's 64-byte `callback_data`
    limit (a UUID plus the longest choice string is ~52 bytes), and `:` never
    appears in either part so a plain split is exact. */
function approvalCallbackData(approvalId: string, choice: PlannerToolApprovalChoice): string {
  return `${approvalId}:${choice}`;
}

type UndoCallbackAction = 'confirm' | 'force' | 'cancel';
const VALID_UNDO_ACTIONS: ReadonlySet<string> = new Set(['confirm', 'force', 'cancel']);

function undoCallbackData(turnId: string, action: UndoCallbackAction): string {
  return `undo:${turnId}:${action}`;
}

function parseUndoCallbackData(
  data: string | undefined,
): { turnId: string; action: UndoCallbackAction } | null {
  if (!data) return null;
  if (data.startsWith('undo:')) {
    const parts = data.split(':');
    if (parts.length !== 3) return null;
    const [, turnId, action] = parts;
    if (!turnId || !action || !VALID_UNDO_ACTIONS.has(action)) return null;
    return { turnId, action: action as UndoCallbackAction };
  }
  if (data.startsWith('tg_undo:')) {
    const parts = data.split(':');
    if (parts.length !== 4) return null;
    const [, , turnId, action] = parts;
    if (!turnId || !action || !VALID_UNDO_ACTIONS.has(action)) return null;
    return { turnId, action: action as UndoCallbackAction };
  }
  return null;
}

/**
 * Formats the `<pre>` body of a Telegram approval prompt.
 * PA-140: for `sheet_edit`, formats cell-level diff lines
 * (`Summary!B7: =SUM(B2:B6) → =SUM(B2:B8)`) instead of raw JSON.
 */
export function formatApprovalInput(
  event: Pick<PermissionRequestEvent, 'toolName' | 'input' | 'filePath'>,
  maxChars = APPROVAL_INPUT_MAX,
): string {
  if (event.toolName === 'sheet_edit') {
    const rawDiff = event.input._diff;
    if (
      rawDiff &&
      typeof rawDiff === 'object' &&
      typeof (rawDiff as { before?: unknown }).before === 'string' &&
      typeof (rawDiff as { after?: unknown }).after === 'string'
    ) {
      const beforeLines = (rawDiff as { before: string }).before.split('\n');
      const afterLines = (rawDiff as { after: string }).after.split('\n');
      const count = Math.max(beforeLines.length, afterLines.length);
      const lines: string[] = [];
      if (event.filePath) lines.push(event.filePath);
      for (let i = 0; i < count; i++) {
        const b = beforeLines[i] ?? '';
        const a = afterLines[i] ?? '';
        if (b === a) {
          if (b) lines.push(b);
          continue;
        }
        const bColon = b.indexOf(': ');
        const aColon = a.indexOf(': ');
        if (bColon > 0 && bColon === aColon && b.slice(0, bColon) === a.slice(0, aColon)) {
          const prefix = b.slice(0, bColon);
          lines.push(`${prefix}: ${b.slice(bColon + 2)} → ${a.slice(aColon + 2)}`);
        } else if (b && a) {
          lines.push(`${b} → ${a}`);
        } else {
          lines.push(a || b);
        }
      }
      if (lines.length > 0) {
        return truncate(lines.join('\n'), maxChars);
      }
    }
  }
  const cleanInput =
    '_diff' in event.input
      ? Object.fromEntries(Object.entries(event.input).filter(([k]) => k !== '_diff'))
      : event.input;
  return Object.keys(cleanInput).length > 0 ? truncate(JSON.stringify(cleanInput, null, 2), maxChars) : '';
}

/**
 * The approval buttons. PA-134: `rememberScopes` (set only for a target-scoped
 * tool, a Hub dispatch) drops the choices the server would refuse, so a
 * Telegram tap cannot ask to remember a dispatch fleet-wide either.
 */
export function approvalKeyboard(
  rememberScopes: readonly ('workspace' | 'global')[] | undefined,
): [string, PlannerToolApprovalChoice][][] {
  const scopes = rememberScopes ?? ['workspace', 'global'];
  const choices: [string, PlannerToolApprovalChoice][] = [['Allow once', 'allow_once']];
  if (scopes.includes('workspace')) choices.push(['Allow (this agent)', 'allow_workspace']);
  if (scopes.includes('global')) choices.push(['Allow (always)', 'allow_global']);
  choices.push(['Deny', 'deny']);
  const rows: [string, PlannerToolApprovalChoice][][] = [];
  for (let i = 0; i < choices.length; i += 2) rows.push(choices.slice(i, i + 2));
  return rows;
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

/** PA-137: a small Telegram file (a photo) into memory, refusing past `maxBytes`. */
async function downloadToBuffer(client: TelegramClient, fileId: string, maxBytes: number): Promise<Buffer> {
  const { filePath, fileSize } = await client.getFile(fileId);
  if (fileSize !== null && fileSize > maxBytes) {
    throw new AttachmentError(`The photo is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB.`, 'too_large');
  }
  const stream = await client.downloadFile(filePath);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) {
      stream.destroy();
      throw new AttachmentError(`The photo is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB.`, 'too_large');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
