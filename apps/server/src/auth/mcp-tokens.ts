import crypto from 'node:crypto';
import {
  MCP_TOKEN_PREFIX_LENGTH,
  MCP_TOKEN_SCHEME_PREFIX,
  McpScope,
  type McpClientTokenSummary,
} from '@pocketagent/protocol';
import type { Db, McpClientTokenRow } from '../db/index.js';
import { generateToken } from './index.js';

/** An authenticated MCP client, as the request gate and the tools see it. */
export interface McpClientIdentity {
  id: string;
  label: string;
  scopes: readonly McpScope[];
}

export interface MintedMcpClientToken {
  id: string;
  label: string;
  scopes: McpScope[];
  token: string;
  createdAt: number;
}

/**
 * PA-118: owns `mcp_client_tokens` — the third credential class.
 *
 * Deliberately `HubCredentialStore`'s twin (PA-63), and every property that
 * makes that store safe is kept here for the same reason:
 *
 * - **The stored form is `sha256(token)`.** The backend only ever verifies one,
 *   so there is nothing for `secret-box` to protect and no reveal route to
 *   build; a copied `pocketagent.db` yields nothing presentable.
 * - **No in-memory roster.** `validate` reads the row on every request, which
 *   is what makes `revoke` take effect on the very next request with no
 *   restart and no invalidation window.
 * - **The master token is never accepted.** Minting takes a cookie session
 *   (see `routes/mcp-tokens.ts`); there is no exchange of the master token for
 *   one of these, so the unrevocable root credential never becomes a bearer.
 *
 * What differs is that a token carries **scopes**, and that the gate accepts
 * one only on the MCP endpoint — a `pam_` token on `/api/projects` is a 401.
 */
export class McpTokenStore {
  constructor(private readonly db: Db) {}

  mint(label: string, scopes: readonly McpScope[], now = Date.now()): MintedMcpClientToken {
    const id = crypto.randomUUID();
    const token = `${MCP_TOKEN_SCHEME_PREFIX}${generateToken(32)}`;
    const unique = normaliseScopes(scopes);
    this.db
      .prepare(
        `INSERT INTO mcp_client_tokens
           (id, label, token_sha256, token_prefix, scopes_json, created_at, last_seen_at, last_seen_ip)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(id, label, digest(token), token.slice(0, MCP_TOKEN_PREFIX_LENGTH), JSON.stringify(unique), now);
    return { id, label, scopes: unique, token, createdAt: now };
  }

  /**
   * Resolve a presented bearer token, or `null`. Looked up by digest, so there
   * is no comparison for timing to leak — finding a row already requires a
   * sha256 preimage.
   */
  validate(token: string | null | undefined, ip?: string, now = Date.now()): McpClientIdentity | null {
    if (!token || !token.startsWith(MCP_TOKEN_SCHEME_PREFIX)) return null;
    const row = this.db
      .prepare('SELECT * FROM mcp_client_tokens WHERE token_sha256 = ?')
      .get(digest(token)) as McpClientTokenRow | undefined;
    if (!row) return null;
    // Throttled exactly as `HubCredentialStore.validate` throttles its own.
    if (row.last_seen_at === null || now - row.last_seen_at > 60_000) {
      this.db
        .prepare('UPDATE mcp_client_tokens SET last_seen_at = ?, last_seen_ip = ? WHERE id = ?')
        .run(now, ip?.slice(0, 64) ?? null, row.id);
    }
    return identityOf(row);
  }

  /**
   * Re-read one client by id. Used by long-lived MCP sessions, which must not
   * keep serving a token that was revoked after the session was opened.
   */
  get(id: string): McpClientIdentity | null {
    const row = this.db.prepare('SELECT * FROM mcp_client_tokens WHERE id = ?').get(id) as
      | McpClientTokenRow
      | undefined;
    return row ? identityOf(row) : null;
  }

  list(liveSessionsFor: (clientId: string) => number = () => 0): McpClientTokenSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM mcp_client_tokens ORDER BY created_at DESC')
      .all() as McpClientTokenRow[];
    return rows.map((row) => summaryOf(row, liveSessionsFor(row.id)));
  }

  summary(id: string, liveSessions = 0): McpClientTokenSummary | null {
    const row = this.db.prepare('SELECT * FROM mcp_client_tokens WHERE id = ?').get(id) as
      | McpClientTokenRow
      | undefined;
    return row ? summaryOf(row, liveSessions) : null;
  }

  /** True when a row was actually removed. Work the client started keeps running. */
  revoke(id: string): boolean {
    return this.db.prepare('DELETE FROM mcp_client_tokens WHERE id = ?').run(id).changes > 0;
  }
}

function identityOf(row: McpClientTokenRow): McpClientIdentity {
  return { id: row.id, label: row.label, scopes: parseScopes(row.scopes_json) };
}

function summaryOf(row: McpClientTokenRow, liveSessions: number): McpClientTokenSummary {
  return {
    id: row.id,
    label: row.label,
    tokenPrefix: row.token_prefix,
    scopes: parseScopes(row.scopes_json),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    lastSeenIp: row.last_seen_ip,
    liveSessions,
  };
}

/**
 * A row whose scopes cannot be parsed grants **nothing** rather than
 * everything: failing closed is the only safe reading of a corrupted grant.
 */
function parseScopes(json: string): McpScope[] {
  try {
    const raw: unknown = JSON.parse(json);
    if (!Array.isArray(raw)) return [];
    return normaliseScopes(raw.filter((s): s is McpScope => McpScope.safeParse(s).success));
  } catch {
    return [];
  }
}

function normaliseScopes(scopes: readonly McpScope[]): McpScope[] {
  return McpScope.options.filter((s) => scopes.includes(s));
}

function digest(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}
