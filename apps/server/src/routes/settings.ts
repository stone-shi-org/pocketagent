import type { FastifyPluginAsync } from 'fastify';
import { UpdateSettingsRequest, type SettingsResponse } from '@pocketagent/protocol';
import type { PocketContext } from '../types.js';
import { SETTINGS_FIELDS, writeSettingsField, type SettingsField } from '../settings/index.js';

/**
 * The full settings resource: everything in `SETTINGS_FIELDS` (database-backed,
 * seeded once from `.env` — see `settings/index.ts` and CLAUDE.md) plus the
 * pre-existing `skipPermissionsEnabled` switch, plus a read-only block of
 * facts that are fixed at boot and never move here (`host`/`port`/
 * `databasePath`/`nodeEnv` — see `FixedServerInfo` in the protocol package for
 * why).
 *
 * Two fields use a different shape on the wire than in `Config`, because the
 * HTTP DTO favors what's pleasant to edit over what's convenient to store:
 * `sessionTtlMs` (milliseconds) <-> `sessionTtlHours`, and `codeServerBaseUrl`
 * <-> `codeServerUrl`. Everything else round-trips through each field's own
 * `parse`/`serialize` (the same codec used for the `settings` table row) for
 * the string-shaped fields, or passes through unchanged for the ones that are
 * already a plain number/boolean in both places.
 */
function dtoKeyFor(field: SettingsField): string {
  if (field.key === 'codeServerBaseUrl') return 'codeServerUrl';
  if (field.key === 'sessionTtlMs') return 'sessionTtlHours';
  return field.key;
}

function toDtoValue(field: SettingsField, configValue: unknown): unknown {
  if (field.key === 'sessionTtlMs') return Math.round((configValue as number) / 3_600_000);
  if (typeof configValue === 'number' || typeof configValue === 'boolean') return configValue;
  return field.serialize(configValue as never);
}

function fromDtoValue(field: SettingsField, dtoValue: unknown): unknown {
  if (field.key === 'sessionTtlMs') return Math.round((dtoValue as number) * 3_600_000);
  if (typeof dtoValue === 'number' || typeof dtoValue === 'boolean') return dtoValue;
  return field.parse(dtoValue as string);
}

function buildSettingsResponse(context: PocketContext): SettingsResponse {
  const { config, sessions } = context;
  const settings: Record<string, unknown> = {
    skipPermissionsEnabled: sessions.getGlobalSkipPermissions(),
  };
  for (const field of SETTINGS_FIELDS) {
    settings[dtoKeyFor(field)] = toDtoValue(field, config[field.key]);
  }
  return {
    fixed: {
      host: config.host,
      port: config.port,
      databasePath: config.databasePath,
      nodeEnv: config.nodeEnv,
      isNetworkExposed: config.isNetworkExposed,
    },
    settings: settings as SettingsResponse['settings'],
    restartRequiredKeys: SETTINGS_FIELDS.filter((f) => !f.live).map(dtoKeyFor),
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
