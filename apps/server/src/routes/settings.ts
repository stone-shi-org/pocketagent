import type { FastifyPluginAsync } from 'fastify';
import { UpdateSettingsRequest, type SettingsResponse } from '@pocketagent/protocol';
import { tmuxSessionScopeSliceProblem } from '../config/index.js';
import type { PocketContext } from '../types.js';
import {
  SETTINGS_FIELDS,
  writeSettingsField,
  dtoKeyFor,
  fromDtoValue,
  buildRuntimeSettingsSnapshot,
} from '../settings/index.js';

/**
 * The full settings resource: everything in `SETTINGS_FIELDS` (database-backed,
 * seeded once from `.env` — see `settings/index.ts` and CLAUDE.md) plus the
 * pre-existing `skipPermissionsEnabled` switch, plus a read-only block of
 * facts that are fixed at boot and never move here (`host`/`port`/
 * `databasePath`/`nodeEnv` — see `FixedServerInfo` in the protocol package for
 * why). The DTO-shaping helpers (`dtoKeyFor`/`toDtoValue`/`fromDtoValue`) and
 * the `SETTINGS_FIELDS`-projection loop now live in `settings/index.ts` — see
 * that module's own doc comment for why — so `skipPermissionsEnabled` plus
 * `fixed` is all that is specific to this route.
 */
function buildSettingsResponse(context: PocketContext): SettingsResponse {
  const { config, sessions } = context;
  const snapshot = buildRuntimeSettingsSnapshot(config, sessions.getGlobalSkipPermissions());
  return {
    fixed: {
      host: config.host,
      port: config.port,
      databasePath: config.databasePath,
      nodeEnv: config.nodeEnv,
      isNetworkExposed: config.isNetworkExposed,
    },
    settings: snapshot.settings as SettingsResponse['settings'],
    restartRequiredKeys: snapshot.restartRequiredKeys,
  };
}

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/settings', async () => buildSettingsResponse(app.pocket));

  /**
   * Partial update: only the keys present in the body are touched. Every
   * `SETTINGS_FIELDS` key persists to the `settings` table and mutates the
   * shared `config` object in place, so "live" fields (see
   * `settings/fields.ts`) take effect immediately for anything that reads
   * `config.<field>` at the point of use — several routes and `SessionManager`
   * already do. "Restart-required" fields still persist; whatever captured
   * the old value into its own constructor closure just doesn't notice until
   * the next boot.
   *
   * `skipPermissionsEnabled` is not one of `SETTINGS_FIELDS` — it keeps going
   * through `SessionManager`, which also has to reach into every currently
   * running structured session. See the "global skip-permissions switch"
   * invariant in CLAUDE.md before changing this.
   */
  app.patch('/api/settings', async (request, reply) => {
    const parsed = UpdateSettingsRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }
    const patch = parsed.data as Record<string, unknown>;
    if (typeof patch.tmuxSessionScopeSlice === 'string') {
      const sliceProblem = tmuxSessionScopeSliceProblem(patch.tmuxSessionScopeSlice);
      if (sliceProblem !== null) {
        return reply.code(400).send({
          error: { code: 'bad_request', message: sliceProblem },
        });
      }
    }
    const { config, sessions, db } = app.pocket;

    if (patch.skipPermissionsEnabled !== undefined) {
      await sessions.setGlobalSkipPermissions(patch.skipPermissionsEnabled as boolean);
    }

    for (const field of SETTINGS_FIELDS) {
      const dtoKey = dtoKeyFor(field);
      if (!(dtoKey in patch)) continue;
      const value = fromDtoValue(field, patch[dtoKey]);
      writeSettingsField(db, config, field, value);
      // Pino's level is a live setter; nothing else re-reads `config.logLevel`
      // after Fastify's own construction, so this is the one field that needs
      // an explicit push alongside the generic mutate-and-persist above.
      if (field.key === 'logLevel') app.log.level = value as string;
    }

    return reply.send(buildSettingsResponse(app.pocket));
  });
};
