import type { Db, AuthSessionRow } from '../db/index.js';

/**
 * PA-66 moved the primitives below into `packages/node-kit`, so `apps/hub` can
 * use the identical constant-time compare, token generator, bearer parser and
 * Origin policy without depending on this package (which would drag node-pty
 * and the agent SDKs into a gateway image). They are re-exported from here
 * because every existing import in this server names this path, and the move
 * is only safe as a *pure* one — the existing suite is its regression guard.
 *
 * `AuthService` deliberately stayed: a session store is bound to its own table
 * in its own schema, and the Hub's sessions are not this server's.
 */
export { bearerTokenFrom, generateToken, isOriginAllowed, safeTokenEqual } from '@pocketagent/node-kit';

import { generateToken, safeTokenEqual } from '@pocketagent/node-kit';

export interface AuthSession {
  id: string;
  expiresAt: number;
}

/**
 * Server-side session store. The master token is exchanged once at login for a
 * random session id; only that id ever reaches the browser, in an HttpOnly
 * cookie. The token itself is never sent to, or stored by, the client.
 */
export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly masterToken: string,
    private readonly ttlMs: number,
  ) {}

  verifyMasterToken(candidate: string): boolean {
    return safeTokenEqual(this.masterToken, candidate);
  }

  createSession(userAgent: string | null, now = Date.now()): AuthSession {
    const id = generateToken(32);
    const expiresAt = now + this.ttlMs;
    this.db
      .prepare(
        `INSERT INTO auth_sessions (id, created_at, expires_at, last_seen_at, user_agent)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, now, expiresAt, now, userAgent?.slice(0, 256) ?? null);
    return { id, expiresAt };
  }

  /** Returns the session if the id is valid and unexpired, else null. */
  validateSession(id: string | undefined, now = Date.now()): AuthSession | null {
    if (!id) return null;
    const row = this.db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(id) as
      | AuthSessionRow
      | undefined;
    if (!row) return null;
    if (row.expires_at <= now) {
      this.destroySession(id);
      return null;
    }
    // Throttle writes: only bump last_seen at most once a minute.
    if (now - row.last_seen_at > 60_000) {
      this.db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?').run(now, id);
    }
    return { id: row.id, expiresAt: row.expires_at };
  }

  destroySession(id: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(id);
  }

  destroyAllSessions(): void {
    this.db.prepare('DELETE FROM auth_sessions').run();
  }
}
