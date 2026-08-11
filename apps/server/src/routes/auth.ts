import type { FastifyPluginAsync } from 'fastify';
import { AUTH_COOKIE_NAME, LoginRequest } from '@pocketagent/protocol';
import { isOriginAllowed } from '../auth/index.js';

export const authRoutes: FastifyPluginAsync = async (app) => {
  const { auth, config } = app.pocket;

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

  app.get('/api/auth/me', async (request, reply) => {
    const session = auth.validateSession(request.cookies[AUTH_COOKIE_NAME]);
    return reply.send({
      authenticated: session !== null,
      expiresAt: session?.expiresAt ?? null,
    });
  });
};
