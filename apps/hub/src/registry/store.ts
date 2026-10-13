import { decryptSecret, encryptSecret } from '@pocketagent/node-kit';
import {
  HUB_TOKEN_PREFIX_LENGTH,
  MCP_TOKEN_PREFIX_LENGTH,
  type HubFleetTokenState,
  type HubHostCapabilities,
  type HubHostEntry,
  type HubHostStatus,
} from '@pocketagent/protocol';
import type { HubDb, HubHostRow } from '../db.js';

/** What the health poller last learned, kept in memory rather than in SQLite. */
export interface HostHealth extends HubHostStatus {
  /** `HostInfo.id` the backend reported on the last successful probe. */
  observedHostId: string | null;
}

export const UNPROBED: HostHealth = {
  online: false,
  version: null,
  protocol: null,
  lastCheckedAt: null,
  error: null,
  observedHostId: null,
};

export interface ResolvedHost {
  readonly row: HubHostRow;
  /** Decrypted `pah_` token, or null when unbound or undecryptable. */
  readonly credential: string | null;
}

/**
 * The host registry.
 *
 * Two properties are deliberate and load-bearing.
 *
 * **Every read is a read.** `resolve()` hits SQLite on every proxied request
 * with no in-memory cache, which is what makes "removing a host stops all
 * proxying to it immediately" true with no restart and no invalidation
 * window. It is the same discipline `HubCredentialStore.validate` follows on
 * the backend, and for the same reason: an in-memory roster is a faster wrong
 * answer. A SQLite point lookup on an indexed primary key is not a cost worth
 * trading correctness for.
 *
 * **Health lives in memory, the registry lives on disk.** A probe result is
 * worthless after a restart — it describes a moment, and the poller produces a
 * fresh one within 30 s — so persisting it would only create a window where
 * the UI confidently reports a host as online because it was online yesterday.
 */
export class HostRegistry {
  private readonly health = new Map<string, HostHealth>();
  private readonly capabilities = new Map<string, HubHostCapabilities>();

  constructor(
    private readonly db: HubDb,
    private readonly encKey: Buffer,
  ) {}

  listRows(): HubHostRow[] {
    return this.db
      .prepare('SELECT * FROM hub_hosts ORDER BY is_default DESC, created_at')
      .all() as HubHostRow[];
  }

  getRow(id: string): HubHostRow | null {
    return (this.db.prepare('SELECT * FROM hub_hosts WHERE id = ?').get(id) as
      | HubHostRow
      | undefined) ?? null;
  }

  defaultRow(): HubHostRow | null {
    return (this.db.prepare('SELECT * FROM hub_hosts WHERE is_default = 1').get() as
      | HubHostRow
      | undefined) ?? null;
  }

  /**
   * The per-request lookup the proxy uses.
   *
   * `hostId: null` means the default host (PA-66 D6b's bare `/api/*` mount).
   * Returns null for an unknown *or* disabled host, deliberately collapsing
   * the two: the Hub answers both with the same 404, so an operator who can
   * reach the Hub but should not know which machines are registered learns
   * nothing from probing ids. That mirrors the backend's own "unknown slug and
   * disabled webhook are one response" posture.
   */
  resolve(hostId: string | null): ResolvedHost | null {
    const row = hostId === null ? this.defaultRow() : this.getRow(hostId);
    if (row === null || row.enabled !== 1) return null;
    return { row, credential: this.credentialFor(row) };
  }

  /**
   * Decrypt a stored credential, or null.
   *
   * A row whose ciphertext will not open — the operator rotated
   * `POCKETAGENT_SETTINGS_ENC_KEY` — returns null rather than throwing, so the
   * host stays *listed and visibly unbound* instead of vanishing or taking a
   * request down. The proxy then refuses it: an unbound host is never dialed
   * without a credential, which would land on the backend as a 401 and look
   * like the backend's fault.
   */
  credentialFor(row: HubHostRow): string | null {
    if (row.credential_enc === null) return null;
    try {
      return decryptSecret(row.credential_enc, this.encKey);
    } catch {
      return null;
    }
  }

  create(entry: { id: string; label: string; baseUrl: string }, now = Date.now()): void {
    // The first host added becomes the default, because a Hub with hosts and
    // no default would answer the bare `/api/*` mount with a 404 and present
    // as "the Hub is broken" rather than "nothing is marked default".
    const isDefault = this.defaultRow() === null ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO hub_hosts (id, label, base_url, enabled, is_default, created_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .run(entry.id, entry.label, entry.baseUrl, isDefault, now);
  }

  update(
    id: string,
    patch: { label?: string; baseUrl?: string; enabled?: boolean; isDefault?: boolean },
  ): boolean {
    const row = this.getRow(id);
    if (row === null) return false;
    if (patch.isDefault === true) {
      // Exactly one default, enforced by demoting the rest in the same
      // transaction rather than by a partial unique index: SQLite has those,
      // but an index would make "promote B" a two-statement dance that can
      // fail in the middle and leave zero defaults.
      this.db.transaction(() => {
        this.db.prepare('UPDATE hub_hosts SET is_default = 0').run();
        this.db.prepare('UPDATE hub_hosts SET is_default = 1 WHERE id = ?').run(id);
      })();
    }
    this.db
      .prepare(
        `UPDATE hub_hosts
            SET label = COALESCE(?, label),
                base_url = COALESCE(?, base_url),
                enabled = COALESCE(?, enabled)
          WHERE id = ?`,
      )
      .run(
        patch.label ?? null,
        patch.baseUrl ?? null,
        patch.enabled === undefined ? null : patch.enabled ? 1 : 0,
        id,
      );
    return true;
  }

  /**
   * Store a freshly minted credential.
   *
   * The master token that bought it is not a parameter here, and that is the
   * point: it reaches the bind route, is spent on one request to the backend,
   * and never travels further. Nothing in this class can persist it because
   * nothing in this class is ever given it.
   */
  bind(
    id: string,
    credential: { id: string; token: string },
    backendHostId: string | null,
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        `UPDATE hub_hosts
            SET credential_enc = ?, credential_prefix = ?, credential_id = ?,
                bound_at = ?, backend_host_id = COALESCE(?, backend_host_id)
          WHERE id = ?`,
      )
      .run(
        encryptSecret(credential.token, this.encKey),
        credential.token.slice(0, HUB_TOKEN_PREFIX_LENGTH),
        credential.id,
        now,
        backendHostId,
        id,
      );
  }

  // ---- PA-134: the scoped dispatch token -----------------------------------

  /**
   * The decrypted `pam_` dispatch token for a host, or null. Same posture as
   * `credentialFor`: a ciphertext that will not open is "no token", never a
   * throw, and a host with none is never dialed for dispatch.
   */
  mcpCredentialFor(row: HubHostRow): string | null {
    if (row.mcp_credential_enc === null) return null;
    try {
      return decryptSecret(row.mcp_credential_enc, this.encKey);
    } catch {
      return null;
    }
  }

  mcpTokenState(row: HubHostRow): HubFleetTokenState {
    if (row.mcp_credential_enc !== null) return this.mcpCredentialFor(row) === null ? 'unreadable' : 'ok';
    return this.credentialFor(row) === null ? 'unbound' : 'missing';
  }

  /** Store a freshly minted, already-verified dispatch token. */
  setMcpCredential(id: string, minted: { id: string; token: string }): void {
    this.db
      .prepare(
        `UPDATE hub_hosts SET mcp_credential_enc = ?, mcp_credential_prefix = ?, mcp_client_id = ? WHERE id = ?`,
      )
      .run(encryptSecret(minted.token, this.encKey), minted.token.slice(0, MCP_TOKEN_PREFIX_LENGTH), minted.id, id);
  }

  clearMcpCredential(id: string): void {
    this.db
      .prepare(
        `UPDATE hub_hosts SET mcp_credential_enc = NULL, mcp_credential_prefix = NULL, mcp_client_id = NULL WHERE id = ?`,
      )
      .run(id);
  }

  remove(id: string): boolean {
    const row = this.getRow(id);
    if (row === null) return false;
    this.db.prepare('DELETE FROM hub_hosts WHERE id = ?').run(id);
    this.health.delete(id);
    this.capabilities.delete(id);
    // Removing the default leaves the bare `/api/*` mount unrouted, so promote
    // the oldest survivor rather than leaving the Hub in a state where its own
    // UI cannot load. Nothing is chosen cleverly: "the next one" is
    // predictable, and the operator can move it.
    if (row.is_default === 1) {
      const next = this.db.prepare('SELECT id FROM hub_hosts ORDER BY created_at').get() as
        | { id: string }
        | undefined;
      if (next) this.db.prepare('UPDATE hub_hosts SET is_default = 1 WHERE id = ?').run(next.id);
    }
    return true;
  }

  recordHealth(id: string, health: HostHealth): void {
    this.health.set(id, health);
  }

  healthFor(id: string): HostHealth {
    return this.health.get(id) ?? UNPROBED;
  }

  recordCapabilities(id: string, state: HubHostCapabilities | null): void {
    if (state === null) {
      this.capabilities.delete(id);
      return;
    }
    this.capabilities.set(id, state);
  }

  capabilitiesFor(id: string): HubHostCapabilities | null {
    return this.capabilities.get(id) ?? null;
  }

  /** Project a row plus its last probe into the shape the browser reads. */
  entryFor(row: HubHostRow): HubHostEntry {
    const health = this.healthFor(row.id);
    return {
      id: row.id,
      label: row.label,
      baseUrl: row.base_url,
      enabled: row.enabled === 1,
      isDefault: row.is_default === 1,
      boundAt: row.bound_at,
      credentialPrefix: row.credential_prefix,
      backendHostId: row.backend_host_id,
      // Only ever true when both ids are known: a host that has never been
      // probed, or one bound before the first probe, must not read as
      // "changed" merely because one side is null.
      identityChanged:
        row.backend_host_id !== null &&
        health.observedHostId !== null &&
        health.observedHostId !== row.backend_host_id,
      status: {
        online: health.online,
        version: health.version,
        protocol: health.protocol,
        lastCheckedAt: health.lastCheckedAt,
        error: health.error,
      },
      capabilities: this.capabilitiesFor(row.id),
    };
  }

  list(): HubHostEntry[] {
    return this.listRows().map((row) => this.entryFor(row));
  }
}
