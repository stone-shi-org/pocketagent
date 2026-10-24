import type { FastifyBaseLogger } from 'fastify';
import {
  MCP_SERVER_PATH,
  type HubWebhookRoutingHost,
  type HubWebhookRoutingState,
  type McpDispatchOrigin,
} from '@pocketagent/protocol';
import type { HubDb, HubHostRow, HubWebhookRoutingRow } from '../db.js';
import type { HostRegistry } from '../registry/store.js';
import { callBackend, errorMessage } from '../templates/provisioner.js';
import type { HubMcpServer } from './server.js';
import type { HubMcpTokenStore } from './tokens.js';

export class WebhookRoutingServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/**
 * PA-171: let one backend's webhooks dispatch their runs to other hosts.
 *
 * `HubMcpAttachService`'s shape, for a narrower purpose. Each *source* backend
 * gets its own `webhook`-kind Hub MCP token — `dispatch` scope only, limited to
 * the hosts the operator ticked — minted here and handed over once with the
 * Hub's `pah_` credential to that backend's `POST /api/webhook-routing`, where
 * it is stored as `secret-box` ciphertext. The Hub keeps only the digest.
 *
 * The token's kind is the point. A call on it is a webhook run by
 * construction, so the Fleet tools state that to the target in `_meta`
 * (`originFor`); no other principal can, and the target honours the statement
 * only from a token a Hub minted. Whether that run may then skip approvals is
 * the *target's* setting, never this Hub's and never the source webhook's.
 *
 * Changing the allowlist re-mints: the backend needs the host labels for its
 * editor anyway, and the Hub cannot re-send a token it only holds the digest
 * of. A source mid-wait simply presents the new token on its next call.
 */
export class WebhookRoutingService {
  constructor(
    private readonly opts: {
      db: HubDb;
      registry: HostRegistry;
      tokens: HubMcpTokenStore;
      mcpServer: HubMcpServer;
      fetchImpl: typeof fetch;
      log: FastifyBaseLogger;
      /**
       * Make sure a target's dispatch token carries hub provenance, so the
       * dispatch origin counts there (`FleetService.ensureDispatchProvenance`).
       */
      ensureDispatchProvenance?: (host: HubHostRow) => Promise<void>;
    },
  ) {}

  state(): HubWebhookRoutingState {
    const rows = new Map(this.rows().map((row) => [row.host_id, row]));
    const hosts: HubWebhookRoutingHost[] = this.opts.registry.listRows().map((host) => {
      const row = rows.get(host.id);
      if (!row) {
        return { hostId: host.id, label: host.label, state: 'none', allowedHosts: [], tokenPrefix: null, message: null };
      }
      const allowedHosts = parseHosts(row.allowed_hosts_json);
      const tokenAlive = row.token_id !== null && this.opts.tokens.get(row.token_id) !== null;
      if (row.last_error !== null || !tokenAlive) {
        return {
          hostId: host.id,
          label: host.label,
          state: 'failed',
          allowedHosts,
          tokenPrefix: row.token_prefix,
          message: row.last_error ?? 'Its token was revoked. Save the routing again to replace it.',
        };
      }
      return { hostId: host.id, label: host.label, state: 'routed', allowedHosts, tokenPrefix: row.token_prefix, message: null };
    });
    return { hosts };
  }

  /** Turn routing on for `sourceId`, or change its allowlist (re-minting). */
  async set(sourceId: string, hubUrl: string, allowedHosts: readonly string[]): Promise<HubWebhookRoutingState> {
    const source = this.opts.registry.getRow(sourceId);
    if (!source) throw new WebhookRoutingServiceError(`No host "${sourceId}" on this Hub.`, 'not_found', 404);
    if (this.opts.registry.credentialFor(source) === null) {
      throw new WebhookRoutingServiceError(`${source.label} is not bound to this Hub.`, 'unbound', 409);
    }
    const targets: HubHostRow[] = [];
    for (const id of new Set(allowedHosts)) {
      if (id === source.id) continue; // its own rows run locally
      const row = this.opts.registry.getRow(id);
      if (!row) throw new WebhookRoutingServiceError(`No host "${id}" on this Hub.`, 'bad_request', 400);
      targets.push(row);
    }
    if (targets.length === 0) {
      throw new WebhookRoutingServiceError(
        'Pick at least one other host. To stop routing, switch it off instead.',
        'bad_request',
        400,
      );
    }
    await this.push(source, hubUrl, targets);
    // Best-effort: a target this fails on still takes dispatches; its own
    // skip-approvals switch simply cannot apply until its token is replaced.
    for (const t of targets) {
      await this.opts.ensureDispatchProvenance?.(t).catch((err: unknown) => {
        this.opts.log.warn({ hostId: t.id, reason: (err as Error).message }, 'hub webhook routing: target dispatch token not refreshed');
      });
    }
    return this.state();
  }

  async disable(sourceId: string): Promise<HubWebhookRoutingState> {
    await this.withdraw(sourceId);
    return this.state();
  }

  /**
   * A host is about to be removed. As a source its token goes; as a target it
   * leaves every allowlist (the token's hosts narrow on the next call, and the
   * row says so). Best-effort, like every removal step.
   */
  async beforeHostRemoved(hostId: string): Promise<void> {
    if (this.row(hostId)) await this.withdraw(hostId);
    for (const row of this.rows()) {
      const hosts = parseHosts(row.allowed_hosts_json);
      if (!hosts.includes(hostId)) continue;
      const left = hosts.filter((h) => h !== hostId);
      if (row.token_id) this.opts.tokens.setWebhookHosts(row.token_id, left);
      this.opts.db
        .prepare('UPDATE hub_webhook_routing SET allowed_hosts_json = ?, updated_at = ? WHERE host_id = ?')
        .run(JSON.stringify(left), Date.now(), row.host_id);
    }
  }

  /**
   * The dispatch origin a call on `principalId` carries, or null when it is
   * not a webhook-routing token (or its row is gone).
   */
  originFor(principalId: string): McpDispatchOrigin | null {
    const row = this.opts.db
      .prepare('SELECT * FROM hub_webhook_routing WHERE token_id = ?')
      .get(principalId) as HubWebhookRoutingRow | undefined;
    if (!row) return null;
    const source = this.opts.registry.getRow(row.host_id);
    return { kind: 'webhook', sourceHostId: row.host_id, sourceLabel: source?.label ?? row.host_id };
  }

  private async push(source: HubHostRow, hubUrl: string, targets: readonly HubHostRow[]): Promise<void> {
    const previous = this.row(source.id);
    if (previous?.token_id) await this.revokeToken(previous.token_id);
    const hostIds = targets.map((t) => t.id);
    const minted = this.opts.tokens.mintWebhook(`webhook:${source.label}`.slice(0, 80), hostIds);
    const url = `${hubUrl.replace(/\/+$/, '')}${MCP_SERVER_PATH}`;
    const credential = this.opts.registry.credentialFor(source);
    let lastError: string | null = null;
    if (credential === null) {
      lastError = `${source.label} is not bound to this Hub.`;
    } else {
      const res = await callBackend(this.opts.fetchImpl, source.base_url, credential, {
        method: 'POST',
        path: '/api/webhook-routing',
        body: {
          url,
          token: minted.token,
          selfHostId: source.id,
          hosts: targets.map((t) => ({ id: t.id, label: t.label })),
        },
      });
      if (res.transportError !== null) lastError = `Could not reach ${source.label}: ${res.transportError}`;
      else if (res.status === 404) lastError = `${source.label} predates webhook routing (PA-171); upgrade it.`;
      else if (!res.ok) lastError = `${source.label} refused: ${errorMessage(res)}`;
    }
    if (lastError !== null) await this.revokeToken(minted.id);
    this.opts.db
      .prepare(
        `INSERT INTO hub_webhook_routing (host_id, hub_url, token_id, token_prefix, allowed_hosts_json, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(host_id) DO UPDATE SET hub_url = excluded.hub_url, token_id = excluded.token_id,
           token_prefix = excluded.token_prefix, allowed_hosts_json = excluded.allowed_hosts_json,
           last_error = excluded.last_error, updated_at = excluded.updated_at`,
      )
      .run(
        source.id,
        hubUrl,
        lastError === null ? minted.id : null,
        minted.prefix,
        JSON.stringify(hostIds),
        lastError,
        Date.now(),
      );
    this.opts.log.warn(
      {
        hostId: source.id,
        tokenPrefix: minted.prefix,
        allowedHosts: hostIds,
        ok: lastError === null,
        ...(lastError ? { reason: lastError } : {}),
      },
      'hub webhook routing: token handed to backend',
    );
  }

  private async withdraw(hostId: string): Promise<void> {
    const row = this.row(hostId);
    if (!row) return;
    if (row.token_id) await this.revokeToken(row.token_id);
    const host = this.opts.registry.getRow(hostId);
    const credential = host ? this.opts.registry.credentialFor(host) : null;
    if (host && credential) {
      const res = await callBackend(this.opts.fetchImpl, host.base_url, credential, {
        method: 'DELETE',
        path: '/api/webhook-routing',
      });
      if (!res.ok && res.status !== 404) {
        // Never blocks: the token is already revoked here.
        this.opts.log.warn(
          { hostId, reason: res.transportError ?? errorMessage(res) },
          'hub webhook routing: backend did not clear',
        );
      }
    }
    this.opts.db.prepare('DELETE FROM hub_webhook_routing WHERE host_id = ?').run(hostId);
    this.opts.log.warn({ hostId, tokenPrefix: row.token_prefix }, 'hub webhook routing: withdrawn');
  }

  private async revokeToken(id: string): Promise<void> {
    this.opts.tokens.revoke(id);
    await this.opts.mcpServer.revoke(id);
  }

  private rows(): HubWebhookRoutingRow[] {
    return this.opts.db.prepare('SELECT * FROM hub_webhook_routing ORDER BY host_id').all() as HubWebhookRoutingRow[];
  }

  private row(hostId: string): HubWebhookRoutingRow | null {
    return (
      (this.opts.db.prepare('SELECT * FROM hub_webhook_routing WHERE host_id = ?').get(hostId) as
        | HubWebhookRoutingRow
        | undefined) ?? null
    );
  }
}

function parseHosts(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
