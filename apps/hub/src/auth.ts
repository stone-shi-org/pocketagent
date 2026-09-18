import { generateToken, safeTokenEqual } from '@pocketagent/node-kit';
import type { HubDb, HubSessionRow } from './db.js';

export interface HubSession {
  id: string;
  expiresAt: number;
}

/**
 * The Hub's operator session store.
 *
 * Structurally identical to `AuthService` on the backend, and that is the
 * point of single sign-on here: the Hub answers the *same* `/api/auth/*`
 * shapes at its own origin, so the shipped `LoginPage` and `App` authenticate
 * against it with no client branch and no new protocol type. "Log in once, not
 * once per machine" is then a property of there being one origin, rather than
 * a feature anyone had to build into the browser.
 *
 * What is not shared is the cookie *name*. Cookies are not port-scoped, so a
 * Hub on `:8788` and a backend on `:8787` of one hostname — the obvious
 * development setup — would otherwise share a jar and silently overwrite each
 * other's session. The cookie is HttpOnly and never read by JavaScript, so
 * using a different name costs the frontend nothing.
 */
export const HUB_AUTH_COOKIE_NAME = 'pocketagent_hub_sid';

export class HubAuthService {
  constructor(
    private readonly db: HubDb,
    private readonly operatorToken: string,
    private readonly ttlMs: number,
  ) {}

  verifyOperatorToken(candidate: string): boolean {
    return safeTokenEqual(this.operatorToken, candidate);
  }

  createSession(userAgent: string | null, now = Date.now()): HubSession {
    const id = generateToken(32);
    const expiresAt = now + this.ttlMs;
    this.db
      .prepare(
        `INSERT INTO hub_sessions (id, created_at, expires_at, last_seen_at, user_agent)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, now, expiresAt, now, userAgent?.slice(0, 256) ?? null);
    return { id, expiresAt };
  }

  validateSession(id: string | undefined, now = Date.now()): HubSession | null {
    if (!id) return null;
    const row = this.db.prepare('SELECT * FROM hub_sessions WHERE id = ?').get(id) as
      | HubSessionRow
      | undefined;
    if (!row) return null;
    if (row.expires_at <= now) {
      this.destroySession(id);
      return null;
    }
    if (now - row.last_seen_at > 60_000) {
      this.db.prepare('UPDATE hub_sessions SET last_seen_at = ? WHERE id = ?').run(now, id);
    }
    return { id: row.id, expiresAt: row.expires_at };
  }

  destroySession(id: string): void {
    this.db.prepare('DELETE FROM hub_sessions WHERE id = ?').run(id);
  }
}
