import { z } from 'zod';

/**
 * PA-63: hub credentials — a second credential class, so a Hub fronting several
 * backends never has to store any of their master tokens.
 *
 * `POCKETAGENT_AUTH_TOKEN` is the root credential: it exchanges for a session,
 * and a session grants terminal access as the server's user. A Hub holding five
 * of them is five machines rooted permanently by one Hub compromise, with no
 * revocation short of rotating every token by hand and re-pairing everything.
 * A hub credential is minted *by the backend*, is listed and revocable *from*
 * the backend, and is the only thing the Hub ever persists.
 *
 * It is deliberately **not** a permissions model: a hub credential is
 * full-access, exactly like a session. The win is revocability and the root
 * token never being written down, and narrowing what one may *do* is a separate
 * decision (explicitly out of scope on PA-63).
 */

/**
 * Prefix every minted hub token carries.
 *
 * Two reasons it is a literal scheme rather than raw base64url. A credential
 * that leaks into a paste, a log someone forwards, or a git commit is
 * recognizable as *this* kind of secret by grep and by off-the-shelf secret
 * scanners, which cannot pattern-match 43 characters of base64url. And a
 * support paste is immediately distinguishable from a session id, which is
 * otherwise the same shape.
 */
export const HUB_TOKEN_SCHEME_PREFIX = 'pah_';

/**
 * How much of a token is stored in the clear, for the list UI to show.
 *
 * `HUB_TOKEN_SCHEME_PREFIX` plus 8 characters of base64url: enough to match a
 * row against the token an operator is holding on the Hub side, and it leaves
 * 208 bits of the 256 unrevealed, which is not a brute-force target under any
 * assumption. The label is what *names* a hub; this is what identifies which
 * token a row is, given that there is deliberately no reveal path (see
 * `HubBindResponse.token`).
 */
export const HUB_TOKEN_PREFIX_LENGTH = HUB_TOKEN_SCHEME_PREFIX.length + 8;

/**
 * `POST /api/auth/hub-bind`. Authenticates with the master token exactly once.
 *
 * `token` is the master token, pasted by the operator into the Hub and passed
 * straight through to here. The Hub must not persist it: the whole point is
 * that what it keeps afterwards is the minted credential, which the backend can
 * revoke. Nothing in this protocol can enforce that, but nothing in it requires
 * the master token a second time either, which is what makes discarding it
 * possible.
 */
export const HubBindRequest = z.object({
  token: z.string().min(1).max(512),
  /** Names the requesting Hub in the backend's own list. Free text, bounded. */
  label: z.string().min(1).max(120),
});
export type HubBindRequest = z.infer<typeof HubBindRequest>;

/**
 * The one and only time a hub token is returned by any route.
 *
 * There is no reveal endpoint and no reveal action, the same posture
 * `CustomClaudeProviderStore` and `TelegramBotStore` take for their own
 * secrets — and here it is not even a UX choice: the backend stores only
 * `sha256(token)`, so past this response there is nothing left to reveal. A
 * Hub that loses its token binds again and the operator revokes the orphaned
 * row.
 */
export const HubBindResponse = z.object({
  id: z.string(),
  label: z.string(),
  token: z.string(),
  createdAt: z.number().int(),
});
export type HubBindResponse = z.infer<typeof HubBindResponse>;

/** One bound hub, as `GET /api/auth/hubs` reports it. Never includes the token. */
export const HubCredentialSummary = z.object({
  id: z.string(),
  label: z.string(),
  /** First `HUB_TOKEN_PREFIX_LENGTH` characters of the token. */
  tokenPrefix: z.string(),
  createdAt: z.number().int(),
  /** Null until the credential has actually been used to authenticate. */
  lastSeenAt: z.number().int().nullable(),
  /**
   * Observed source address of the last authenticated request, so an operator
   * can tell two similarly-labelled hubs apart and spot one they do not
   * recognize. Informational only — it is never an authentication factor, since
   * a proxy makes it the proxy's address and `X-Forwarded-For` is a claim.
   */
  lastSeenIp: z.string().nullable(),
});
export type HubCredentialSummary = z.infer<typeof HubCredentialSummary>;

export const HubCredentialListResponse = z.object({
  hubs: z.array(HubCredentialSummary),
});
export type HubCredentialListResponse = z.infer<typeof HubCredentialListResponse>;
