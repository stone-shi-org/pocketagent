import crypto from 'node:crypto';
import {
  HUB_TOKEN_PREFIX_LENGTH,
  HUB_TOKEN_SCHEME_PREFIX,
  type HubCredentialSummary,
} from '@pocketagent/protocol';
import type { Db, HubCredentialRow } from '../db/index.js';
import { generateToken } from './index.js';

/** What `mint` hands back. The `token` exists nowhere else, ever again. */
export interface MintedHubCredential {
  id: string;
  label: string;
  token: string;
  createdAt: number;
}

/** An authenticated hub credential, as the request gate sees it. */
export interface HubCredentialIdentity {
  id: string;
  label: string;
}

/**
 * PA-63: owns `hub_credentials`.
 *
 * Sibling of `AuthService` rather than part of it, because the two credential
 * classes answer different questions and only one of them is derived from the
 * master token at all: a session is minted by a *browser* login and expires, a
 * hub credential is minted by a machine-to-machine bind and is revoked. What
 * they share — one lookup per request, and the decision landing in `app.ts`'s
 * single `onRequest` gate — is exactly what scope item 4 of the ticket asked
 * for, so no route learns about this class individually.
 *
 * Three properties are load-bearing and each has a comment where it is
 * enforced: the stored form is a one-way digest, there is no in-memory roster,
 * and the master token is never accepted here as a bearer credential.
 */
export class HubCredentialStore {
  constructor(private readonly db: Db) {}

  /**
   * Mint a credential for a Hub that has just proved it holds the master token.
   *
   * The caller is responsible for that proof — `routes/auth.ts` does it with
   * `AuthService.verifyMasterToken`, the same check `login` uses. This class
   * deliberately has no access to the master token, so it cannot be tricked
   * into treating one as a hub credential.
   */
  mint(label: string, now = Date.now()): MintedHubCredential {
    const id = crypto.randomUUID();
    // 32 bytes, the same width as a session id. The scheme prefix is outside
    // that budget rather than eating into it.
    const token = `${HUB_TOKEN_SCHEME_PREFIX}${generateToken(32)}`;
    this.db
      .prepare(
        `INSERT INTO hub_credentials (id, label, token_sha256, token_prefix, created_at, last_seen_at, last_seen_ip)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(id, label, digest(token), token.slice(0, HUB_TOKEN_PREFIX_LENGTH), now);
    return { id, label, token, createdAt: now };
  }

  /**
   * Resolve a presented bearer token, or `null`.
   *
   * Looked up *by digest* rather than compared: the column holds no usable
   * credential, so there is no secret for an attacker to learn a byte at a time
   * and `safeTokenEqual`'s constant-time comparison would be protecting
   * nothing. Finding a row at all already requires having produced a sha256
   * preimage.
   *
   * The lookup is unconditional on every request and there is **no cache**,
   * which is what makes `revoke` take effect immediately with no restart and no
   * invalidation window. A roster held in memory would be a faster wrong
   * answer, and would also have to be reconciled after every mutation — the
   * same "read the flag fresh" discipline `SessionManager.setGlobalSkipPermissions`
   * and `plannerYoloEnabled` follow.
   */
  validate(token: string | null | undefined, ip?: string, now = Date.now()): HubCredentialIdentity | null {
    if (!token) return null;
    // Cheap rejection of anything that cannot be one of ours — a session id, a
    // webhook bearer, a copy-pasted master token — before it reaches the
    // database at all.
    if (!token.startsWith(HUB_TOKEN_SCHEME_PREFIX)) return null;

    const row = this.db
      .prepare('SELECT * FROM hub_credentials WHERE token_sha256 = ?')
      .get(digest(token)) as HubCredentialRow | undefined;
    if (!row) return null;

    // Throttled exactly as `AuthService.validateSession` throttles its own
    // `last_seen_at`: a Hub proxying a terminal makes this the hottest write in
    // the database otherwise.
    if (row.last_seen_at === null || now - row.last_seen_at > 60_000) {
      this.db
        .prepare('UPDATE hub_credentials SET last_seen_at = ?, last_seen_ip = ? WHERE id = ?')
        .run(now, ip?.slice(0, 64) ?? null, row.id);
    }
    return { id: row.id, label: row.label };
  }

  list(): HubCredentialSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM hub_credentials ORDER BY created_at DESC')
      .all() as HubCredentialRow[];
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      tokenPrefix: row.token_prefix,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      lastSeenIp: row.last_seen_ip,
    }));
  }

  /** True when a row was actually removed, so the route can 404 honestly. */
  revoke(id: string): boolean {
    return this.db.prepare('DELETE FROM hub_credentials WHERE id = ?').run(id).changes > 0;
  }
}

function digest(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}
