import type { FastifyPluginAsync } from 'fastify';
import {
  AUTH_COOKIE_NAME,
  HubBindRequest,
  type HubBindResponse,
  type HubCredentialListResponse,
  LoginRequest,
} from '@pocketagent/protocol';
import { isOriginAllowed } from '../auth/index.js';

export const authRoutes: FastifyPluginAsync = async (app) => {
  const { auth, hubCredentials, config } = app.pocket;

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: config.cookieSecure,
    path: '/',
  };

  app.post(
    '/api/auth/login',
    {
      config: {
        // Brute-forcing a 256-bit token is hopeless, but rate limiting also caps
        // the damage from a weak token the user set by hand.
        rateLimit: { max: 8, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      if (!isOriginAllowed(request.headers.origin, config.allowedOrigins, request.headers.host)) {
        return reply.code(403).send({ error: { code: 'forbidden_origin', message: 'Origin not allowed.' } });
      }

      const parsed = LoginRequest.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: { code: 'bad_request', message: 'A token is required.' } });
      }

      if (!auth.verifyMasterToken(parsed.data.token)) {
        request.log.warn({ ip: request.ip }, 'failed login attempt');
        // Deliberately vague, and identical timing to success.
        return reply
          .code(401)
          .send({ error: { code: 'invalid_token', message: 'Invalid access token.' } });
      }

      const session = auth.createSession(request.headers['user-agent'] ?? null);
      reply.setCookie(AUTH_COOKIE_NAME, session.id, {
        ...cookieOptions,
        maxAge: Math.floor(config.sessionTtlMs / 1000),
      });
      request.log.info({ ip: request.ip }, 'login succeeded');
      return reply.send({ ok: true, expiresAt: session.expiresAt });
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const sid = request.cookies[AUTH_COOKIE_NAME];
    if (sid) auth.destroySession(sid);
    reply.clearCookie(AUTH_COOKIE_NAME, cookieOptions);
    return reply.send({ ok: true });
  });

  /**
   * PA-63: exchange the master token, once, for a named hub credential.
   *
   * Public in `PUBLIC_API_PATHS` for the same reason `login` is — a Hub binding
   * for the first time has nothing else to present — and guarded identically:
   * the master token in the body, `login`'s own rate limit, and this
   * in-handler Origin check (the gate skips it for a public path, so it has to
   * be done here or CSRF protection would be missing on a state-changing POST).
   *
   * Binding requires the *master* token specifically, never a hub credential.
   * That is what stops a compromised Hub from minting itself a sibling that
   * would survive the revocation of the credential it was holding — the one
   * escalation the "full access, like a session" scope would otherwise allow.
   */
  app.post(
    '/api/auth/hub-bind',
    { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!isOriginAllowed(request.headers.origin, config.allowedOrigins, request.headers.host)) {
        return reply
          .code(403)
          .send({ error: { code: 'forbidden_origin', message: 'Origin not allowed.' } });
      }

      const parsed = HubBindRequest.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: { code: 'bad_request', message: 'A token and a label are required.' },
        });
      }

      if (!auth.verifyMasterToken(parsed.data.token)) {
        // Same vague answer, and the same log line, as a failed login: this is
        // the master token being guessed, and which endpoint it was guessed at
        // does not change what happened.
        request.log.warn({ ip: request.ip }, 'failed hub bind attempt');
        return reply
          .code(401)
          .send({ error: { code: 'invalid_token', message: 'Invalid access token.' } });
      }

      const label = parsed.data.label.trim();
      const minted = hubCredentials.mint(label.length > 0 ? label : 'Hub');
      // The id and label are logged; the token is not, and neither is anything
      // derived from it. An audit line must never be one step from recovering a
      // credential — the same rule provider-mutation logging follows.
      request.log.info({ ip: request.ip, hubId: minted.id, label: minted.label }, 'hub bound');
      const body: HubBindResponse = {
        id: minted.id,
        label: minted.label,
        token: minted.token,
        createdAt: minted.createdAt,
      };
      return reply.send(body);
    },
  );

  /**
   * List and revoke bound hubs — the property a master token cannot offer.
   *
   * Behind the normal gate, so either a session cookie or a hub credential is
   * accepted. That a Hub can revoke its siblings is a deliberate, accepted cost
   * of "full access, exactly like a session" (PA-63, Q1): it is denial of
   * service rather than escalation, and a Hub still cannot mint, because
   * `hub-bind` above takes the master token only.
   */
  app.get('/api/auth/hubs', async (_request, reply) => {
    const body: HubCredentialListResponse = { hubs: hubCredentials.list() };
    return reply.send(body);
  });

  app.delete<{ Params: { id: string } }>('/api/auth/hubs/:id', async (request, reply) => {
    // A plain row delete, and the next request presenting that token fails —
    // there is no cache to invalidate and nothing to restart. See
    // `HubCredentialStore.validate`.
    if (!hubCredentials.revoke(request.params.id)) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such hub.' } });
    }
    request.log.info({ hubId: request.params.id }, 'hub credential revoked');
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', async (request, reply) => {
    const session = auth.validateSession(request.cookies[AUTH_COOKIE_NAME]);
    return reply.send({
      authenticated: session !== null,
      expiresAt: session?.expiresAt ?? null,
    });
  });
};
