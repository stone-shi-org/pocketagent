import crypto from 'node:crypto';
import type { Db, AuthSessionRow } from '../db/index.js';

/**
 * Constant-time comparison that does not leak length either. Hashing both sides
 * first gives two equal-length digests, so `timingSafeEqual` cannot throw and
 * the comparison time is independent of the candidate's length.
 */
export function safeTokenEqual(expected: string, candidate: string): boolean {
  const a = crypto.createHash('sha256').update(expected, 'utf8').digest();
  const b = crypto.createHash('sha256').update(candidate, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

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

/**
 * Cross-site WebSocket connections are not covered by SameSite cookies in every
 * browser/version combination, and `fetch` preflight does not apply to WS. So we
 * check `Origin` explicitly on both the REST mutations and the WS handshake.
 *
 * Returns true when the request should be allowed.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: string[] | null,
  host: string | undefined,
): boolean {
  // Non-browser clients (curl, tests, native apps) send no Origin. The cookie
  // is still required, so this is not an authentication bypass.
  if (origin === undefined) return true;

  const normalized = origin.replace(/\/$/, '');

  if (allowedOrigins && allowedOrigins.length > 0) {
    return allowedOrigins.includes(normalized);
  }

  // Default policy: same-origin only. Compare the Origin's host against the
  // Host header the request was routed to.
  if (!host) return false;
  try {
    return new URL(normalized).host === host;
  } catch {
    return false;
  }
}
