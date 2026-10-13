import crypto from 'node:crypto';
import { generateToken } from '@pocketagent/node-kit';
import { HUB_MCP_TOKEN_PREFIX_LENGTH, HUB_MCP_TOKEN_SCHEME_PREFIX } from '@pocketagent/protocol';
import type { HubDb, HubMcpTokenRow } from '../db.js';

/** The principal a `phm_` token resolves to, for the gate and the tools. */
export interface HubMcpPrincipal {
  readonly id: string;
  readonly label: string;
}

/**
 * PA-134: owns `hub_mcp_tokens` — the coordinator → Hub credential, and the
 * first bearer this Hub has ever accepted.
 *
 * The backend's `McpTokenStore` / `HubCredentialStore` shape, kept for the same
 * reasons:
 *
 * - **Only `sha256(token)` is stored.** The Hub only ever *verifies* one, so
 *   there is nothing for `secret-box` to protect and no reveal path to build.
 *   The raw token leaves this process exactly once, as the bearer of the MCP
 *   registry the Hub provisions on the coordinator.
 * - **No in-memory roster.** `validate` reads the row on every request, so a
 *   revocation takes effect on the next request with no restart.
 * - **Minted only from inside the Hub.** There is no route that mints one; the
 *   fleet-enable flow does, behind the operator's session cookie, and an MCP
 *   principal can reach none of it.
 *
 * What it does *not* carry is scopes: the Hub's `/mcp` has one catalog and the
 * token is accepted nowhere else (see the gate in `app.ts`), so the path *is*
 * the scope.
 */
export class HubMcpTokenStore {
  constructor(private readonly db: HubDb) {}

  mint(label: string, now = Date.now()): { id: string; token: string; prefix: string } {
    const id = crypto.randomUUID();
    const token = `${HUB_MCP_TOKEN_SCHEME_PREFIX}${generateToken(32)}`;
    const prefix = token.slice(0, HUB_MCP_TOKEN_PREFIX_LENGTH);
    this.db
      .prepare(
        `INSERT INTO hub_mcp_tokens (id, label, token_sha256, token_prefix, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(id, label, digest(token), prefix, now);
    return { id, token, prefix };
  }

  /**
   * Resolve a presented bearer, or null. Looked up by digest, so there is no
   * comparison for timing to leak.
   */
  validate(token: string | null | undefined, now = Date.now()): HubMcpPrincipal | null {
    if (!token || !token.startsWith(HUB_MCP_TOKEN_SCHEME_PREFIX)) return null;
    const row = this.db.prepare('SELECT * FROM hub_mcp_tokens WHERE token_sha256 = ?').get(digest(token)) as
      | HubMcpTokenRow
      | undefined;
    if (!row) return null;
    if (row.last_seen_at === null || now - row.last_seen_at > 60_000) {
      this.db.prepare('UPDATE hub_mcp_tokens SET last_seen_at = ? WHERE id = ?').run(now, row.id);
    }
    return { id: row.id, label: row.label };
  }

  /** By id — used by the MCP endpoint to re-read a principal on every call. */
  resolve(id: string): HubMcpPrincipal | null {
    const row = this.get(id);
    return row ? { id: row.id, label: row.label } : null;
  }

  get(id: string): HubMcpTokenRow | null {
    return (this.db.prepare('SELECT * FROM hub_mcp_tokens WHERE id = ?').get(id) as HubMcpTokenRow | undefined) ?? null;
  }

  revoke(id: string): boolean {
    return this.db.prepare('DELETE FROM hub_mcp_tokens WHERE id = ?').run(id).changes > 0;
  }
}

function digest(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
