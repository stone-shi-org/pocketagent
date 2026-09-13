import type { CreateTelegramLinkRequest, TelegramLink, UpdateTelegramLinkRequest } from '@pocketagent/protocol';
import type { Db } from '../db/index.js';

export class TelegramLinkError extends Error {
  override readonly name = 'TelegramLinkError';
  constructor(
    message: string,
    readonly code: 'not_found' | 'invalid',
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/** Shape of a `telegram_links` row, as SQLite hands it back. */
interface Row {
  bot_id: string;
  telegram_chat_id: string;
  telegram_user_label: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
  planner_chat_id: string | null;
  skip_tool_approvals: number;
  created_at: number;
  updated_at: number;
}

/**
 * PA-53: owns `telegram_links` — a *cache* of which Pocket Agent chat a
 * paired Telegram id is talking to, modeled on `readWebhookIssueSession`/
 * `upsertWebhookIssueSession` (`db/index.ts`).
 *
 * Unlike that pair, this store splits "patch one field on an existing row"
 * into dedicated methods (`setPlannerChatId`, `touchLabel`) rather than one
 * generic upsert: `skip_tool_approvals` is a `NOT NULL` boolean column with no
 * representable "leave unspecified" value the way a nullable `TEXT` column's
 * `COALESCE(excluded.x, table.x)` idiom gets for free, so a single upsert
 * that only sometimes receives that field cannot tell "explicitly false" from
 * "not provided" once the value has already been converted to `0`/`1` for
 * binding. Reading the row and writing back exactly what changed (as `update`
 * already does for the route-driven case) sidesteps the ambiguity entirely
 * rather than working around it with a NULL sentinel.
 */
export class TelegramLinksStore {
  constructor(private readonly db: Db) {}

  /** Every pairing across every bot, joined with its workspace's current
      display name — what the Settings UI's Pairings list reads. */
  list(): TelegramLink[] {
    return this.rows().map(toLink);
  }

  listForBot(botId: string): TelegramLink[] {
    return this.rows()
      .filter((r) => r.bot_id === botId)
      .map(toLink);
  }

  /** `null` when this Telegram chat has not been paired — the caller's cue
      to reply with a fixed "not paired" message rather than starting a chat. */
  get(botId: string, telegramChatId: string): TelegramLink | null {
    const row = this.rowById(botId, telegramChatId);
    return row ? toLink(row) : null;
  }

  create(botId: string, req: CreateTelegramLinkRequest): TelegramLink {
    if (this.rowById(botId, req.telegramChatId)) {
      throw new TelegramLinkError('This Telegram chat is already paired.', 'invalid', 409);
    }
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO telegram_links (
           bot_id, telegram_chat_id, telegram_user_label, workspace_id,
           planner_chat_id, skip_tool_approvals, created_at, updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        botId,
        req.telegramChatId,
        req.telegramUserLabel ?? null,
        req.workspaceId,
        req.skipToolApprovals === true ? 1 : 0,
        now,
        now,
      );
    return this.get(botId, req.telegramChatId)!;
  }

  update(botId: string, telegramChatId: string, req: UpdateTelegramLinkRequest): TelegramLink {
    const existing = this.rowById(botId, telegramChatId);
    if (!existing) throw new TelegramLinkError('No such pairing.', 'not_found', 404);
    const workspaceId = req.workspaceId ?? existing.workspace_id;
    const skipToolApprovals = req.skipToolApprovals ?? existing.skip_tool_approvals === 1;
    this.db
      .prepare(
        `UPDATE telegram_links SET workspace_id = ?, skip_tool_approvals = ?, updated_at = ?
          WHERE bot_id = ? AND telegram_chat_id = ?`,
      )
      .run(workspaceId, skipToolApprovals ? 1 : 0, Date.now(), botId, telegramChatId);
    return this.get(botId, telegramChatId)!;
  }

  /** Attach a freshly-created (or re-resolved) chat id to an existing
      pairing — the one write `TelegramBridge` performs after
      `PlannerChatService.create()`. A no-op (0 rows affected) if the pairing
      was removed in the interim; the bridge does not treat that as an error. */
  setPlannerChatId(botId: string, telegramChatId: string, plannerChatId: string): void {
    this.db
      .prepare(
        'UPDATE telegram_links SET planner_chat_id = ?, updated_at = ? WHERE bot_id = ? AND telegram_chat_id = ?',
      )
      .run(plannerChatId, Date.now(), botId, telegramChatId);
  }

  /** Opportunistic display-label refresh from an inbound message's `from`
      field — best-effort, never something a caller needs to check the
      result of. */
  touchLabel(botId: string, telegramChatId: string, label: string): void {
    this.db
      .prepare(
        'UPDATE telegram_links SET telegram_user_label = ?, updated_at = ? WHERE bot_id = ? AND telegram_chat_id = ?',
      )
      .run(label, Date.now(), botId, telegramChatId);
  }

  remove(botId: string, telegramChatId: string): boolean {
    return (
      this.db
        .prepare('DELETE FROM telegram_links WHERE bot_id = ? AND telegram_chat_id = ?')
        .run(botId, telegramChatId).changes > 0
    );
  }

  /** Every pairing bound to a given planner chat id — at most one, in
      practice, but read as a list so a caller never has to special-case
      "zero" vs "one" differently from any other query here. */
  findByPlannerChatId(plannerChatId: string): TelegramLink[] {
    return this.rows()
      .filter((r) => r.planner_chat_id === plannerChatId)
      .map(toLink);
  }

  // ---- internals ------------------------------------------------------------

  private rows(): Row[] {
    return this.db
      .prepare(
        `SELECT l.*, w.name AS workspace_name
           FROM telegram_links l
           LEFT JOIN planner_workspaces w ON w.id = l.workspace_id
          ORDER BY l.created_at`,
      )
      .all() as Row[];
  }

  private rowById(botId: string, telegramChatId: string): Row | undefined {
    return this.db
      .prepare(
        `SELECT l.*, w.name AS workspace_name
           FROM telegram_links l
           LEFT JOIN planner_workspaces w ON w.id = l.workspace_id
          WHERE l.bot_id = ? AND l.telegram_chat_id = ?`,
      )
      .get(botId, telegramChatId) as Row | undefined;
  }
}

function toLink(row: Row): TelegramLink {
  return {
    botId: row.bot_id,
    telegramChatId: row.telegram_chat_id,
    telegramUserLabel: row.telegram_user_label,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    plannerChatId: row.planner_chat_id,
    skipToolApprovals: row.skip_tool_approvals === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
