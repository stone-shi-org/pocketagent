import type { FastifyBaseLogger } from 'fastify';
import {
  HUB_MCP_ATTACH_SCOPES,
  MCP_SERVER_PATH,
  type HubMcpAttachHost,
  type HubMcpAttachState,
} from '@pocketagent/protocol';
import type { HubDb, HubHostRow, HubMcpAttachRow } from '../db.js';
import type { HostRegistry } from '../registry/store.js';
import { callBackend, errorMessage } from '../templates/provisioner.js';
import type { HubMcpServer } from './server.js';
import type { HubMcpTokenStore } from './tokens.js';

/**
 * PA-169 Phase 3: offer the Hub's `/mcp` to the sessions a human starts on
 * each bound backend ("attach Fleet MCP").
 *
 * Each backend gets **its own** Hub MCP client token (`read` + `dispatch`,
 * never `admin`), minted here and handed over once with the Hub's `pah_`
 * credential to that backend's `POST /api/fleet-mcp`, where it is stored as
 * `secret-box` ciphertext. One token per backend, so revoking one machine's
 * attachment never touches another's, and the audit line on every dispatch
 * names which machine's session asked. The Hub keeps only the digest, like
 * every other `phm_` token.
 *
 * The loop guard is on the backend, not here: a session the Hub dispatched is
 * an MCP-started session there, and the backend refuses to attach Fleet MCP
 * to any session an MCP principal started. So A → B → A ends at B: B's session
 * has no Fleet tools to dispatch with.
 */
export class HubMcpAttachService {
  constructor(
    private readonly opts: {
      db: HubDb;
      registry: HostRegistry;
      tokens: HubMcpTokenStore;
      mcpServer: HubMcpServer;
      fetchImpl: typeof fetch;
      log: FastifyBaseLogger;
    },
  ) {}

  state(): HubMcpAttachState {
    const rows = new Map(this.rows().map((row) => [row.host_id, row]));
    const hubUrl = this.rows()[0]?.hub_url ?? null;
    const hosts: HubMcpAttachHost[] = this.opts.registry.listRows().map((host) => {
      const row = rows.get(host.id);
      if (!row) return { hostId: host.id, label: host.label, state: 'none', tokenPrefix: null, message: null };
      const tokenAlive = row.token_id !== null && this.opts.tokens.get(row.token_id) !== null;
      if (row.last_error !== null || !tokenAlive) {
        return {
          hostId: host.id,
          label: host.label,
          state: 'failed',
          tokenPrefix: row.token_prefix,
          message: row.last_error ?? 'Its token was revoked on this page. Turn attaching off and on again to replace it.',
        };
      }
      return { hostId: host.id, label: host.label, state: 'attached', tokenPrefix: row.token_prefix, message: null };
    });
    return { enabled: rows.size > 0, hubUrl, hosts };
  }

  /** Offer Fleet MCP on every bound host (again, replacing any earlier token). */
  async enable(hubUrl: string): Promise<HubMcpAttachState> {
    for (const host of this.opts.registry.listRows()) {
      if (this.opts.registry.credentialFor(host) === null) continue;
      await this.attach(host, hubUrl);
    }
    return this.state();
  }

  async disable(): Promise<HubMcpAttachState> {
    for (const row of this.rows()) await this.detach(row.host_id);
    return this.state();
  }

  /** A host was just bound: if attaching is on, it is offered too. */
  async onHostBound(hostId: string): Promise<void> {
    const hubUrl = this.rows()[0]?.hub_url;
    const host = this.opts.registry.getRow(hostId);
    if (!hubUrl || !host) return;
    await this.attach(host, hubUrl);
  }

  /** A host is about to be removed: its token goes, best-effort on the backend. */
  async beforeHostRemoved(hostId: string): Promise<void> {
    if (this.row(hostId)) await this.detach(hostId);
  }

  private async attach(host: HubHostRow, hubUrl: string): Promise<void> {
    const previous = this.row(host.id);
    if (previous?.token_id) await this.revokeToken(previous.token_id);
    const minted = this.opts.tokens.mintClient(`attach:${host.label}`.slice(0, 80), HUB_MCP_ATTACH_SCOPES, null);
    const url = `${hubUrl.replace(/\/+$/, '')}${MCP_SERVER_PATH}`;
    const credential = this.opts.registry.credentialFor(host);
    let lastError: string | null = null;
    if (credential === null) {
      lastError = `${host.label} is not bound to this Hub.`;
    } else {
      const res = await callBackend(this.opts.fetchImpl, host.base_url, credential, {
        method: 'POST',
        path: '/api/fleet-mcp',
        body: { url, token: minted.token },
      });
      if (res.transportError !== null) lastError = `Could not reach ${host.label}: ${res.transportError}`;
      else if (res.status === 404) lastError = `${host.label} predates Fleet MCP attach (PA-169); upgrade it.`;
      else if (!res.ok) lastError = `${host.label} refused: ${errorMessage(res)}`;
    }
    if (lastError !== null) {
      // Nothing holds it, so nothing should be able to use it.
      await this.revokeToken(minted.id);
    }
    this.opts.db
      .prepare(
        `INSERT INTO hub_mcp_attach (host_id, hub_url, token_id, token_prefix, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(host_id) DO UPDATE SET hub_url = excluded.hub_url, token_id = excluded.token_id,
           token_prefix = excluded.token_prefix, last_error = excluded.last_error, updated_at = excluded.updated_at`,
      )
      .run(host.id, hubUrl, lastError === null ? minted.id : null, minted.prefix, lastError, Date.now());
    this.opts.log.warn(
      { hostId: host.id, tokenPrefix: minted.prefix, ok: lastError === null, ...(lastError ? { reason: lastError } : {}) },
      'hub mcp attach: token offered to backend sessions',
    );
  }

  private async detach(hostId: string): Promise<void> {
    const row = this.row(hostId);
    if (!row) return;
    if (row.token_id) await this.revokeToken(row.token_id);
    const host = this.opts.registry.getRow(hostId);
    const credential = host ? this.opts.registry.credentialFor(host) : null;
    if (host && credential) {
      const res = await callBackend(this.opts.fetchImpl, host.base_url, credential, { method: 'DELETE', path: '/api/fleet-mcp' });
      if (!res.ok && res.status !== 404) {
        // Never blocks: the token is already revoked here, so the backend's
        // copy is dead whatever it says.
        this.opts.log.warn({ hostId, reason: res.transportError ?? errorMessage(res) }, 'hub mcp attach: backend did not clear');
      }
    }
    this.opts.db.prepare('DELETE FROM hub_mcp_attach WHERE host_id = ?').run(hostId);
    this.opts.log.warn({ hostId, tokenPrefix: row.token_prefix }, 'hub mcp attach: withdrawn');
  }

  private async revokeToken(id: string): Promise<void> {
    this.opts.tokens.revoke(id);
    await this.opts.mcpServer.revoke(id);
  }

  private rows(): HubMcpAttachRow[] {
    return this.opts.db.prepare('SELECT * FROM hub_mcp_attach ORDER BY host_id').all() as HubMcpAttachRow[];
  }

  private row(hostId: string): HubMcpAttachRow | null {
    return (this.opts.db.prepare('SELECT * FROM hub_mcp_attach WHERE host_id = ?').get(hostId) as HubMcpAttachRow | undefined) ?? null;
  }
}
