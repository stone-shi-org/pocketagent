import type { FastifyPluginAsync } from 'fastify';
import { UpdateGlobalSettingsRequest } from '@pocketagent/protocol';

/**
 * Server-wide settings. Today this is exactly one dangerous switch.
 *
 * `skipPermissionsEnabled` here is the operator's global override of the
 * per-session `CreateSessionRequest.skipPermissions` opt-in — see the
 * "global skip-permissions switch" note in CLAUDE.md before changing this
 * file. It is deliberately its own small resource rather than folded into
 * `/api/sessions` or `/api/workspaces`: it is not scoped to a session or a
 * directory, it is a fact about this whole server.
 */
export const settingsRoutes: FastifyPluginAsync = async (app) => {
  const { sessions } = app.pocket;

  app.get('/api/settings', async () => ({
    skipPermissionsEnabled: sessions.getGlobalSkipPermissions(),
  }));

  /**
   * Flip the global switch.
   *
   * Applies immediately to every currently running *structured* session and
   * to every session created from here on, regardless of transport. It does
   * not reach back into a terminal/PTY session already running — see
   * `SessionManager.setGlobalSkipPermissions` for why that is not just
   * unimplemented but structurally not possible without either killing the
   * process or giving the terminal transport an answerable approval channel,
   * which CLAUDE.md rules out.
   */
  app.patch('/api/settings', async (request, reply) => {
    const parsed = UpdateGlobalSettingsRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }

    await sessions.setGlobalSkipPermissions(parsed.data.skipPermissionsEnabled);
    return reply.send({ skipPermissionsEnabled: sessions.getGlobalSkipPermissions() });
  });
};
