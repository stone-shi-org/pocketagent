import type { FastifyBaseLogger } from 'fastify';
import { HUB_MCP_TOKEN_PREFIX_LENGTH, type FleetMcpAttachState } from '@pocketagent/protocol';
import { decryptSecret, encryptSecret, SETTINGS_ENC_KEY_VAR } from '../crypto/secret-box.js';
import type { Db } from '../db/index.js';
import { readSetting, writeSetting } from '../db/index.js';

const URL_KEY = 'fleet_mcp_url';
const TOKEN_KEY = 'fleet_mcp_token_enc';
const PREFIX_KEY = 'fleet_mcp_token_prefix';
const UPDATED_KEY = 'fleet_mcp_updated_at';

export class FleetMcpAttachError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/**
 * PA-169 Phase 3: the Hub's `/mcp` address and the Hub MCP client token this
 * backend was handed for its own sessions ("attach Fleet MCP").
 *
 * The token is a `phm_` bearer the *Hub* minted and verifies; this process
 * must present it, so unlike a hub credential it is stored reversibly — as
 * `secret-box` ciphertext in `settings`, the posture every other secret this
 * server must replay has. No route returns it, in plaintext or ciphertext:
 * the state carries a prefix only. With `POCKETAGENT_SETTINGS_ENC_KEY` unset
 * the feature is unavailable (a 409 naming the variable), never plaintext.
 *
 * It reaches exactly one place: the Agent SDK's `mcpServers` option of a
 * structured `claude` session a human started with the toggle on, in memory.
 * Nothing is written into the repository, and the child environment never
 * sees it (an SDK option, not an env var).
 */
export class FleetMcpAttachStore {
  constructor(
    private readonly opts: { db: Db; encKey: Buffer | undefined; logger: FastifyBaseLogger },
  ) {}

  state(): FleetMcpAttachState {
    const url = readSetting(this.opts.db, URL_KEY);
    const stored = readSetting(this.opts.db, TOKEN_KEY);
    const updated = readSetting(this.opts.db, UPDATED_KEY);
    const credential = this.credential();
    return {
      configured: credential !== null,
      url: url || null,
      tokenPrefix: readSetting(this.opts.db, PREFIX_KEY) || null,
      unreadable: Boolean(stored) && credential === null,
      updatedAt: updated ? Number(updated) : null,
    };
  }

  set(url: string, token: string): FleetMcpAttachState {
    if (this.opts.encKey === undefined) {
      throw new FleetMcpAttachError(
        `Set ${SETTINGS_ENC_KEY_VAR} on this host to let its sessions attach the Hub's MCP server.`,
        'encryption_unavailable',
        409,
      );
    }
    writeSetting(this.opts.db, URL_KEY, url);
    writeSetting(this.opts.db, TOKEN_KEY, encryptSecret(token, this.opts.encKey));
    writeSetting(this.opts.db, PREFIX_KEY, token.slice(0, HUB_MCP_TOKEN_PREFIX_LENGTH));
    writeSetting(this.opts.db, UPDATED_KEY, String(Date.now()));
    return this.state();
  }

  clear(): FleetMcpAttachState {
    this.opts.db
      .prepare('DELETE FROM settings WHERE key IN (?, ?, ?, ?)')
      .run(URL_KEY, TOKEN_KEY, PREFIX_KEY, UPDATED_KEY);
    return this.state();
  }

  /** The URL and the decrypted token, or null when unset or undecryptable. */
  credential(): { url: string; token: string } | null {
    const url = readSetting(this.opts.db, URL_KEY);
    const stored = readSetting(this.opts.db, TOKEN_KEY);
    if (!url || !stored || this.opts.encKey === undefined) return null;
    try {
      return { url, token: decryptSecret(stored, this.opts.encKey) };
    } catch {
      this.opts.logger.error(
        `Could not decrypt the stored Fleet MCP token with the configured ${SETTINGS_ENC_KEY_VAR}. ` +
          'Turn Fleet MCP attach off and on again from the Hub page to replace it.',
      );
      return null;
    }
  }
}
