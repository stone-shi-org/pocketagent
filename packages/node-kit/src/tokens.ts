import crypto from 'node:crypto';

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

/**
 * Parse an `Authorization: Bearer <token>` header, or `null`.
 *
 * One definition, used by every bearer-accepting path in this repo: the
 * backend's request gate for hub credentials (PA-63), a webhook whose sender
 * cannot sign its payloads (`routes/webhook-delivery.ts`), and — since PA-66 —
 * the Hub, which *presents* one of those credentials rather than accepting it.
 * They are unrelated credential classes, but "what counts as a Bearer header"
 * must not be able to differ between two auth paths: a second copy is how one
 * ends up accepting a form the other rejects.
 */
export function bearerTokenFrom(header: string | string[] | undefined): string | null {
  if (header === undefined) return null;
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1]?.trim() ?? null;
}
