import crypto from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type {
  CreateTelegramBotRequest,
  TelegramBotSummary,
  UpdateTelegramBotRequest,
} from '@pocketagent/protocol';
import type { Db } from '../db/index.js';
import { SETTINGS_ENC_KEY_VAR, decryptSecret, encryptSecret } from '../crypto/secret-box.js';

export class TelegramBotError extends Error {
  override readonly name = 'TelegramBotError';
  constructor(
    message: string,
    readonly code: 'not_found' | 'invalid' | 'encryption_unavailable',
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/** Shape of a `telegram_bots` row, as SQLite hands it back. */
interface Row {
  id: string;
  name: string;
  bot_token_ciphertext: string;
  bot_username: string | null;
  enabled: number;
  polling_offset: number | null;
  created_at: number;
  updated_at: number;
}

export interface TelegramBotStoreOptions {
  db: Db;
  /** `undefined` disables create/update; see `requireKey`. */
  encKey: Buffer | undefined;
  logger: FastifyBaseLogger;
}

/**
 * PA-53: owns `telegram_bots`.
 *
 * Deliberately the same shape as `CustomClaudeProviderStore` — a bot is a row
 * with a secret encrypted at rest, and this class is the only thing that ever
 * decrypts it. Unlike a custom Claude provider, a bot is not registered into
 * any live roster: nothing here needs a "reachable in the very next request"
 * property, because a Telegram bot isn't picked from an agent selector — it's
 * polled in the background by `TelegramPollerService`, which calls `list()`
 * on its own reconcile tick (see that class's doc comment for why polling
 * beats a push-on-mutation callback here).
 *
 * The token exists in plaintext in exactly two places: the create/update
 * request body, and the value `revealToken` hands to a poll loop's outbound
 * `fetch` call. It is never logged, never returned by a route (no reveal
 * endpoint — same posture as `CustomClaudeProviderStore`, not the planner LLM
 * key), and never stored unencrypted.
 */
export class TelegramBotStore {
  private readonly db: Db;
  private readonly encKey: Buffer | undefined;
  private readonly logger: FastifyBaseLogger;

  constructor(opts: TelegramBotStoreOptions) {
    this.db = opts.db;
    this.encKey = opts.encKey;
    this.logger = opts.logger;
    if (this.rows().length > 0 && this.encKey === undefined) {
      this.logger.warn(
        { bots: this.rows().length },
        `${SETTINGS_ENC_KEY_VAR} is not set, so no stored Telegram bot token can be used. ` +
          'They are listed but unavailable until the key that encrypted them is configured.',
      );
    }
  }

  /** True when a key is configured, so create/update are possible at all. */
  get encryptionAvailable(): boolean {
    return this.encKey !== undefined;
  }

  list(): TelegramBotSummary[] {
    return this.rows().map(toSummary);
  }

  /** Every *enabled* bot, as raw rows — what `TelegramPollerService.reconcile`
      diffs against its own currently-running poll loops. */
  listEnabledRows(): Row[] {
    return this.rows().filter((r) => r.enabled === 1);
  }

  get(id: string): TelegramBotSummary {
    return toSummary(this.rowOrThrow(id));
  }

  create(req: CreateTelegramBotRequest): TelegramBotSummary {
    const key = this.requireKey();
    const now = Date.now();
    const id = mintBotId(req.name, new Set(this.rows().map((r) => r.id)));
    const row: Row = {
      id,
      name: req.name.trim(),
      bot_token_ciphertext: encryptSecret(req.botToken, key),
      bot_username: null,
      enabled: req.enabled === false ? 0 : 1,
      polling_offset: null,
      created_at: now,
      updated_at: now,
    };
    this.insert(row);
    this.logger.info({ bot: row.id, enabled: row.enabled === 1 }, 'Telegram bot created');
    return toSummary(row);
  }

  /**
   * Apply a partial update. `botToken` omitted *or* blank keeps the stored
   * token — same reasoning `CustomClaudeProviderStore.update` gives: there is
   * no reveal endpoint, so the editor's token field starts empty with nothing
   * to prefill it with, and a save that treated blank as "clear it" would
   * silently break the bot.
   */
  update(id: string, req: UpdateTelegramBotRequest): TelegramBotSummary {
    const existing = this.rowOrThrow(id);
    const rekeying = (req.botToken ?? '').trim().length > 0;
    const key = rekeying ? this.requireKey() : undefined;

    const row: Row = {
      ...existing,
      name: req.name === undefined ? existing.name : req.name.trim(),
      bot_token_ciphertext:
        key !== undefined && req.botToken !== undefined
          ? encryptSecret(req.botToken, key)
          : existing.bot_token_ciphertext,
      // A re-keyed or renamed bot's previously-resolved username can no
      // longer be trusted to still be correct — cleared so the UI shows
      // "not verified yet" rather than a stale identity, resolved again on
      // the next successful poll or "Test".
      bot_username: rekeying ? null : existing.bot_username,
      enabled: req.enabled === undefined ? existing.enabled : req.enabled ? 1 : 0,
      updated_at: Date.now(),
    };
    this.db
      .prepare(
        `UPDATE telegram_bots
            SET name = ?, bot_token_ciphertext = ?, bot_username = ?, enabled = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(row.name, row.bot_token_ciphertext, row.bot_username, row.enabled, row.updated_at, row.id);
    this.logger.info({ bot: row.id, rekeyed: rekeying, enabled: row.enabled === 1 }, 'Telegram bot updated');
    return toSummary(row);
  }

  /** Persist the username `getMe` resolved, so the list shows a verified
      identity rather than only the operator-chosen display name. Silent —
      called opportunistically after a successful API call, never something a
      route waits on. */
  setUsername(id: string, username: string | null): void {
    this.db
      .prepare('UPDATE telegram_bots SET bot_username = ?, updated_at = ? WHERE id = ?')
      .run(username, Date.now(), id);
  }

  getPollingOffset(id: string): number | null {
    return this.rowById(id)?.polling_offset ?? null;
  }

  setPollingOffset(id: string, offset: number): void {
    this.db.prepare('UPDATE telegram_bots SET polling_offset = ? WHERE id = ?').run(offset, id);
  }

  /**
   * Forget a bot. `telegram_links` CASCADEs — see `TELEGRAM_DDL`'s own doc
   * comment for why a pairing outliving its bot is meaningless. The Pocket
   * Agent chats those pairings pointed at are untouched, same as every other
   * "remove drops the pointer, never the transcript" rule in this app.
   */
  remove(id: string): boolean {
    const changes = this.db.prepare('DELETE FROM telegram_bots WHERE id = ?').run(id).changes;
    if (changes === 0) return false;
    this.logger.info({ bot: id }, 'Telegram bot deleted');
    return true;
  }

  /**
   * Decrypt this bot's token for an outbound Bot API call. Internal-only —
   * never exposed through a route, the same boundary `CustomClaudeProviderStore`
   * draws around its own decrypted key. Returns `null` when decryption is not
   * possible (no key configured, or a wrong/rotated one) rather than
   * throwing, so a poll loop can skip this bot and retry on the next
   * reconcile tick instead of taking the whole poller down.
   */
  revealToken(id: string): string | null {
    const row = this.rowById(id);
    if (!row || this.encKey === undefined) return null;
    try {
      return decryptSecret(row.bot_token_ciphertext, this.encKey);
    } catch {
      this.logger.error(
        { bot: id },
        `Could not decrypt this Telegram bot's token with the configured ${SETTINGS_ENC_KEY_VAR}. ` +
          'Re-enter the token in Settings to repair it.',
      );
      return null;
    }
  }

  // ---- internals ------------------------------------------------------------

  private requireKey(): Buffer {
    if (this.encKey === undefined) {
      throw new TelegramBotError(
        `Set ${SETTINGS_ENC_KEY_VAR} to enable Telegram bots.`,
        'encryption_unavailable',
        409,
      );
    }
    return this.encKey;
  }

  private rows(): Row[] {
    return this.db
      .prepare('SELECT * FROM telegram_bots ORDER BY name COLLATE NOCASE, created_at')
      .all() as Row[];
  }

  private rowById(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM telegram_bots WHERE id = ?').get(id) as Row | undefined;
  }

  private rowOrThrow(id: string): Row {
    const row = this.rowById(id);
    if (row === undefined) {
      throw new TelegramBotError('No such Telegram bot.', 'not_found', 404);
    }
    return row;
  }

  private insert(row: Row): void {
    this.db
      .prepare(
        `INSERT INTO telegram_bots
           (id, name, bot_token_ciphertext, bot_username, enabled, polling_offset, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.name,
        row.bot_token_ciphertext,
        row.bot_username,
        row.enabled,
        row.polling_offset,
        row.created_at,
        row.updated_at,
      );
  }
}

function toSummary(row: Row): TelegramBotSummary {
  return {
    id: row.id,
    name: row.name,
    hasBotToken: true,
    botUsername: row.bot_username,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * `telegram:<slug>-<hex>`.
 *
 * Same reasoning as `mintProviderId` in `custom-providers-store.ts`: a slug
 * for legibility in a log line, plus random hex so two bots can share a
 * display name without colliding and so deleting one and creating another
 * with the same name never silently adopts the deleted one's history.
 */
function mintBotId(name: string, taken: ReadonlySet<string>): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'bot';
  for (;;) {
    const id = `telegram:${slug}-${crypto.randomBytes(4).toString('hex')}`;
    if (!taken.has(id)) return id;
  }
}
