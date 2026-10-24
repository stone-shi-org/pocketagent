import type { FastifyBaseLogger } from 'fastify';
import {
  HUB_MCP_TOKEN_PREFIX_LENGTH,
  WebhookRoutingHost,
  type WebhookRoutingState,
} from '@pocketagent/protocol';
import { decryptSecret, encryptSecret, SETTINGS_ENC_KEY_VAR } from '../crypto/secret-box.js';
import type { Db } from '../db/index.js';
import { readSetting, writeSetting } from '../db/index.js';

const URL_KEY = 'webhook_routing_url';
const TOKEN_KEY = 'webhook_routing_token_enc';
const PREFIX_KEY = 'webhook_routing_token_prefix';
const SELF_KEY = 'webhook_routing_self_host_id';
const HOSTS_KEY = 'webhook_routing_hosts_json';
const UPDATED_KEY = 'webhook_routing_updated_at';

/**
 * PA-171: the target-side "webhook runs dispatched through the Hub may skip
 * approvals here" switch. Stored like the global skip-permissions switch — a
 * row in `settings`, off when absent — and read fresh on every dispatched
 * start, so turning it off tightens the next run with no restart.
 */
export const WEBHOOK_DISPATCH_SKIP_APPROVALS_KEY = 'webhook_dispatch_skip_approvals';

export function readWebhookDispatchSkipApprovals(db: Db): boolean {
  return readSetting(db, WEBHOOK_DISPATCH_SKIP_APPROVALS_KEY) === '1';
}

export function writeWebhookDispatchSkipApprovals(db: Db, on: boolean): void {
  writeSetting(db, WEBHOOK_DISPATCH_SKIP_APPROVALS_KEY, on ? '1' : '0');
}

export class WebhookRoutingError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/**
 * PA-171: the Hub address and the `webhook`-kind Hub MCP token this backend's
 * webhooks dispatch remote runs with.
 *
 * `FleetMcpAttachStore`'s twin, kept separate on purpose: that token is
 * `read + dispatch` to every host and exists for sessions a human starts, while
 * this one is `dispatch` only, limited to the hosts an operator allowed on the
 * Hub page, and is the credential the Hub uses to recognise a call as a
 * webhook run (`MCP_DISPATCH_ORIGIN_META_KEY`). Two purposes, two tokens, so
 * revoking one never silently widens or breaks the other.
 *
 * The token is a `phm_` bearer the Hub minted and verifies; this process must
 * present it, so it is stored reversibly as `secret-box` ciphertext — and no
 * route returns it, in plaintext or ciphertext. Without
 * `POCKETAGENT_SETTINGS_ENC_KEY` the feature is unavailable (a 409 naming the
 * variable), never plaintext.
 */
export class WebhookRoutingStore {
  constructor(
    private readonly opts: { db: Db; encKey: Buffer | undefined; logger?: FastifyBaseLogger },
  ) {}

  state(): WebhookRoutingState {
    const url = readSetting(this.opts.db, URL_KEY);
    const stored = readSetting(this.opts.db, TOKEN_KEY);
    const updated = readSetting(this.opts.db, UPDATED_KEY);
    const credential = this.credential();
    return {
      configured: credential !== null,
      url: url || null,
      tokenPrefix: readSetting(this.opts.db, PREFIX_KEY) || null,
      unreadable: Boolean(stored) && credential === null,
      selfHostId: readSetting(this.opts.db, SELF_KEY) || null,
      hosts: this.hosts(),
      updatedAt: updated ? Number(updated) : null,
    };
  }

  set(input: { url: string; token: string; selfHostId: string; hosts: readonly WebhookRoutingHost[] }): WebhookRoutingState {
    if (this.opts.encKey === undefined) {
      throw new WebhookRoutingError(
        `Set ${SETTINGS_ENC_KEY_VAR} on this host to let its webhooks dispatch runs to other hosts.`,
        'encryption_unavailable',
        409,
      );
    }
    writeSetting(this.opts.db, URL_KEY, input.url);
    writeSetting(this.opts.db, TOKEN_KEY, encryptSecret(input.token, this.opts.encKey));
    writeSetting(this.opts.db, PREFIX_KEY, input.token.slice(0, HUB_MCP_TOKEN_PREFIX_LENGTH));
    writeSetting(this.opts.db, SELF_KEY, input.selfHostId);
    // A row naming this backend itself runs locally, so it is never a target.
    writeSetting(
      this.opts.db,
      HOSTS_KEY,
      JSON.stringify(input.hosts.filter((h) => h.id !== input.selfHostId)),
    );
    writeSetting(this.opts.db, UPDATED_KEY, String(Date.now()));
    return this.state();
  }

  clear(): WebhookRoutingState {
    this.opts.db
      .prepare('DELETE FROM settings WHERE key IN (?, ?, ?, ?, ?, ?)')
      .run(URL_KEY, TOKEN_KEY, PREFIX_KEY, SELF_KEY, HOSTS_KEY, UPDATED_KEY);
    return this.state();
  }

  /** This backend's own id on the Hub, or null when routing was never set up. */
  selfHostId(): string | null {
    return readSetting(this.opts.db, SELF_KEY) || null;
  }

  /** The hosts a mapping row may name. */
  hosts(): WebhookRoutingHost[] {
    const raw = readSetting(this.opts.db, HOSTS_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((item) => {
        const ok = WebhookRoutingHost.safeParse(item);
        return ok.success ? [ok.data] : [];
      });
    } catch {
      return [];
    }
  }

  /** Whether a mapping row may name `hostId` as its target. */
  allows(hostId: string): boolean {
    return this.hosts().some((h) => h.id === hostId);
  }

  labelFor(hostId: string): string {
    return this.hosts().find((h) => h.id === hostId)?.label ?? hostId;
  }

  /** The URL and the decrypted token, or null when unset or undecryptable. */
  credential(): { url: string; token: string } | null {
    const url = readSetting(this.opts.db, URL_KEY);
    const stored = readSetting(this.opts.db, TOKEN_KEY);
    if (!url || !stored || this.opts.encKey === undefined) return null;
    try {
      return { url, token: decryptSecret(stored, this.opts.encKey) };
    } catch {
      this.opts.logger?.error(
        `Could not decrypt the stored webhook routing token with the configured ${SETTINGS_ENC_KEY_VAR}. ` +
          'Turn webhook routing off and on again from the Hub page to replace it.',
      );
      return null;
    }
  }
}
