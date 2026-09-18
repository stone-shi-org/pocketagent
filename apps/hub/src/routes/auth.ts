import type { FastifyPluginAsync } from 'fastify';
import { LoginRequest } from '@pocketagent/protocol';
import { isOriginAllowed } from '@pocketagent/node-kit';
import { HUB_AUTH_COOKIE_NAME } from '../auth.js';

/**
 * The Hub's own `/api/auth/*`, answering the *same* shapes the backend does.
 *
 * That identity is the whole of "single sign-on": the shipped `LoginPage` and
 * `App.tsx` post to `/api/auth/login` and read `/api/auth/me` with no idea
 * whether a Hub or a backend is on the other end, so an operator authenticates
 * once to an origin and every host behind it is reachable. Inventing a
 * `/api/hub/auth/*` namespace instead would have forced a client branch and
 * broken the property PA-67 is built on — that a standalone install renders
 * and behaves identically.
 */
export const hubAuthRoutes: FastifyPluginAsync = async (app) => {
  const { auth, config } = app.hub;

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: config.cookieSecure,
    path: '/',
  };

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } },
    async (request, reply) => {
      // The gate skips public paths, so the CSRF check has to happen here or a
      // state-changing POST would have none. Same arrangement as the backend's.
      if (!isOriginAllowed(request.headers.origin, config.allowedOrigins, request.headers.host)) {
        return reply
          .code(403)
          .send({ error: { code: 'forbidden_origin', message: 'Origin not allowed.' } });
      }
      const parsed = LoginRequest.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: { code: 'bad_request', message: 'A token is required.' } });
      }
      if (!auth.verifyOperatorToken(parsed.data.token)) {
        request.log.warn({ ip: request.ip }, 'failed hub login attempt');
        return reply
          .code(401)
          .send({ error: { code: 'invalid_token', message: 'Invalid access token.' } });
      }
      const session = auth.createSession(request.headers['user-agent'] ?? null);
      reply.setCookie(HUB_AUTH_COOKIE_NAME, session.id, {
        ...cookieOptions,
        maxAge: Math.floor(config.sessionTtlMs / 1000),
      });
      request.log.info({ ip: request.ip }, 'hub login succeeded');
      return reply.send({ ok: true, expiresAt: session.expiresAt });
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const sid = request.cookies[HUB_AUTH_COOKIE_NAME];
    if (sid) auth.destroySession(sid);
    reply.clearCookie(HUB_AUTH_COOKIE_NAME, cookieOptions);
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', async (request, reply) => {
    const session = auth.validateSession(request.cookies[HUB_AUTH_COOKIE_NAME]);
    return reply.send({
      authenticated: session !== null,
      expiresAt: session?.expiresAt ?? null,
    });
  });
};
