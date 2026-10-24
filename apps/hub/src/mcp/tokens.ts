import crypto from 'node:crypto';
import { generateToken } from '@pocketagent/node-kit';
import {
  HUB_MCP_SCOPES,
  HUB_MCP_TOKEN_PREFIX_LENGTH,
  HUB_MCP_TOKEN_SCHEME_PREFIX,
  HUB_WEBHOOK_ROUTING_SCOPES,
  HubMcpScope,
  type HubMcpClientToken,
  type HubMcpTokenKind,
} from '@pocketagent/protocol';
import type { HubDb, HubMcpTokenRow } from '../db.js';

/** The principal a `phm_` token resolves to, for the gate and the tools. */
export interface HubMcpPrincipal {
  readonly id: string;
  readonly label: string;
  /** PA-169: `coordinator` (PA-134's Fleet agent) or an operator-minted `client`; PA-171: a backend's `webhook` routing token. */
  readonly kind: HubMcpTokenKind;
  /** PA-169: what this token may call. A coordinator holds every scope. */
  readonly scopes: readonly HubMcpScope[];
  /** PA-169: the hosts it may see and reach; `null` = every host. */
  readonly hosts: readonly string[] | null;
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
 * PA-169 adds a second kind, `client`: a token an operator mints on `HubPage`
 * for a coding agent, carrying scopes and an optional host allowlist. The path
 * is still the only place either kind is accepted (the gate in `app.ts` is
 * unchanged); the scopes and hosts narrow what a client may do *there*, and
 * are re-read with the row on every call, so narrowing a token takes effect on
 * its next call with no restart. A coordinator row has NULL in both columns,
 * which is what every pre-PA-169 row is, and means "every scope, every host".
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
   * PA-169: a token for a coding agent, with its own scopes and hosts. Called
   * only from the cookie-authenticated `/api/hub/mcp/tokens` route — no MCP
   * principal can reach that, so a leaked token cannot mint its successor.
   */
  mintClient(
    label: string,
    scopes: readonly HubMcpScope[],
    hosts: readonly string[] | null,
    now = Date.now(),
  ): { id: string; token: string; prefix: string } {
    const id = crypto.randomUUID();
    const token = `${HUB_MCP_TOKEN_SCHEME_PREFIX}${generateToken(32)}`;
    const prefix = token.slice(0, HUB_MCP_TOKEN_PREFIX_LENGTH);
    this.db
      .prepare(
        `INSERT INTO hub_mcp_tokens (id, label, token_sha256, token_prefix, created_at, last_seen_at, kind, scopes_json, hosts_json)
         VALUES (?, ?, ?, ?, ?, NULL, 'client', ?, ?)`,
      )
      .run(id, label, digest(token), prefix, now, JSON.stringify(normaliseScopes(scopes)), hostsJson(hosts));
    return { id, token, prefix };
  }

  /**
   * PA-171: a source backend's webhook-routing token — `dispatch` only, the
   * hosts its operator allowed. Minted only by `WebhookRoutingService`, behind
   * the Hub cookie. Its kind is what makes the Hub state a webhook dispatch
   * origin to the target (`MCP_DISPATCH_ORIGIN_META_KEY`), so no other token
   * can claim to be a webhook run.
   */
  mintWebhook(label: string, hosts: readonly string[], now = Date.now()): { id: string; token: string; prefix: string } {
    const id = crypto.randomUUID();
    const token = `${HUB_MCP_TOKEN_SCHEME_PREFIX}${generateToken(32)}`;
    const prefix = token.slice(0, HUB_MCP_TOKEN_PREFIX_LENGTH);
    this.db
      .prepare(
        `INSERT INTO hub_mcp_tokens (id, label, token_sha256, token_prefix, created_at, last_seen_at, kind, scopes_json, hosts_json)
         VALUES (?, ?, ?, ?, ?, NULL, 'webhook', ?, ?)`,
      )
      .run(id, label, digest(token), prefix, now, JSON.stringify([...HUB_WEBHOOK_ROUTING_SCOPES]), hostsJson(hosts));
    return { id, token, prefix };
  }

  /** PA-171: narrow or widen a webhook-routing token's hosts. Takes effect on its next call. */
  setWebhookHosts(id: string, hosts: readonly string[]): boolean {
    return (
      this.db
        .prepare("UPDATE hub_mcp_tokens SET hosts_json = ? WHERE id = ? AND kind = 'webhook'")
        .run(hostsJson(hosts), id).changes > 0
    );
  }

  /** PA-169: change a client token's label, scopes or hosts. Coordinator rows are not editable here. */
  updateClient(
    id: string,
    patch: { label?: string; scopes?: readonly HubMcpScope[]; hosts?: readonly string[] | null },
  ): HubMcpTokenRow | null {
    const row = this.get(id);
    if (!row || row.kind !== 'client') return null;
    this.db
      .prepare('UPDATE hub_mcp_tokens SET label = ?, scopes_json = ?, hosts_json = ? WHERE id = ?')
      .run(
        patch.label ?? row.label,
        patch.scopes !== undefined ? JSON.stringify(normaliseScopes(patch.scopes)) : row.scopes_json,
        patch.hosts !== undefined ? hostsJson(patch.hosts) : row.hosts_json,
        id,
      );
    return this.get(id);
  }

  list(): HubMcpTokenRow[] {
    return this.db.prepare('SELECT * FROM hub_mcp_tokens ORDER BY created_at').all() as HubMcpTokenRow[];
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
    return principalOf(row);
  }

  /** By id — used by the MCP endpoint to re-read a principal on every call. */
  resolve(id: string): HubMcpPrincipal | null {
    const row = this.get(id);
    return row ? principalOf(row) : null;
  }

  get(id: string): HubMcpTokenRow | null {
    return (this.db.prepare('SELECT * FROM hub_mcp_tokens WHERE id = ?').get(id) as HubMcpTokenRow | undefined) ?? null;
  }

  revoke(id: string): boolean {
    return this.db.prepare('DELETE FROM hub_mcp_tokens WHERE id = ?').run(id).changes > 0;
  }
}

/** The row as the UI lists it — never the digest. */
export function toClientTokenSummary(row: HubMcpTokenRow): HubMcpClientToken {
  const principal = principalOf(row);
  return {
    id: row.id,
    label: row.label,
    kind: principal.kind,
    tokenPrefix: row.token_prefix,
    scopes: [...principal.scopes],
    hosts: principal.hosts === null ? null : [...principal.hosts],
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * Fail closed in every direction a hand-edited or half-written row could go:
 * an unknown kind is a client, a client with unreadable scopes has none, and an
 * unreadable host list allows no host. Only a coordinator row with NULL
 * columns means "everything" — which is what every PA-134 row is.
 */
function principalOf(row: HubMcpTokenRow): HubMcpPrincipal {
  const kind: HubMcpTokenKind =
    row.kind === 'coordinator' ? 'coordinator' : row.kind === 'webhook' ? 'webhook' : 'client';
  let scopes: HubMcpScope[];
  if (row.scopes_json === null) {
    scopes = kind === 'coordinator' ? [...HUB_MCP_SCOPES] : [];
  } else {
    scopes = normaliseScopes(parseStringArray(row.scopes_json) ?? []);
  }
  let hosts: string[] | null;
  // A webhook token always names its hosts; NULL there is a corrupted row, and
  // "every host" is the wrong way to fail.
  if (row.hosts_json === null) hosts = kind === 'webhook' ? [] : null;
  else hosts = parseStringArray(row.hosts_json) ?? [];
  return { id: row.id, label: row.label, kind, scopes, hosts };
}

function normaliseScopes(scopes: readonly string[]): HubMcpScope[] {
  const wanted = new Set(scopes);
  // Catalog order, de-duplicated, unknown values dropped.
  return HUB_MCP_SCOPES.filter((scope) => wanted.has(scope) && HubMcpScope.safeParse(scope).success);
}

function hostsJson(hosts: readonly string[] | null): string | null {
  return hosts === null ? null : JSON.stringify([...new Set(hosts)]);
}

function parseStringArray(text: string): string[] | null {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : null;
  } catch {
    return null;
  }
}

function digest(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
