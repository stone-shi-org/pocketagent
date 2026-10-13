import type { Config } from '../config/index.js';
import { readSetting, writeSetting, type Db } from '../db/index.js';
import { SETTINGS_FIELDS, type SettingsField } from './fields.js';

/**
 * Writes each field's *current* (env-derived) value into `settings` the first
 * time it's ever seen — and never again. Mirrors `workspaces_seeded` /
 * `global_skip_permissions` (see `db/index.ts`): a present row always means
 * "the database has already decided this," even if that decision was itself
 * only a seed from `.env` on some earlier boot.
 */
export function seedSettingsFromEnvIfNeeded(db: Db, config: Config): void {
  for (const field of SETTINGS_FIELDS) {
    if (readSetting(db, field.dbKey) === null) {
      writeSetting(db, field.dbKey, field.serialize(config[field.key]));
    }
  }
}

/**
 * Seeds anything missing, then overlays every persisted value onto `config`.
 * From the moment this returns, `.env` is no longer consulted for any of
 * `SETTINGS_FIELDS` — only `PATCH /api/settings` (which writes here too) can
 * change them again.
 */
export function applyRuntimeSettings(db: Db, config: Config): Config {
  seedSettingsFromEnvIfNeeded(db, config);
  const next: Config = { ...config };
  for (const field of SETTINGS_FIELDS) {
    const raw = readSetting(db, field.dbKey);
    if (raw !== null) {
      (next as unknown as Record<string, unknown>)[field.key] = field.parse(raw);
    }
  }
  return next;
}

/** Look up a field descriptor by its `Config` key, e.g. from a validated PATCH body. */
export function findSettingsField(key: string): SettingsField | undefined {
  return SETTINGS_FIELDS.find((f) => f.key === key);
}

/**
 * Persists a validated value and mutates `config` in place (not a copy) so
 * that every existing call site reading `config.<key>` live — several routes
 * read it per-request, `SessionManager` reads several fields off `this.opts`
 * per use — observes the change immediately, with no restart. Fields whose
 * consuming module snapshotted the old value into its own constructor closure
 * (see `SettingsField.live`) don't notice until the next boot; the value is
 * still durably correct for that boot.
 */
export function writeSettingsField(db: Db, config: Config, field: SettingsField, value: unknown): void {
  writeSetting(db, field.dbKey, field.serialize(value as never));
  (config as unknown as Record<string, unknown>)[field.key] = value;
}

/**
 * Two fields use a different shape on the wire than in `Config`, because the
 * HTTP DTO (`RuntimeSettings`, `packages/protocol/src/http.ts`) favors what's
 * pleasant to edit over what's convenient to store: `sessionTtlMs`
 * (milliseconds) <-> `sessionTtlHours`, and `codeServerBaseUrl` <->
 * `codeServerUrl`. Everything else round-trips through each field's own
 * `parse`/`serialize` for the string-shaped fields, or passes through
 * unchanged for the ones that are already a plain number/boolean in both
 * places.
 *
 * `dtoKeyFor`/`toDtoValue`/`fromDtoValue` used to live in `routes/settings.ts`
 * alone; PA-56 moved them here (and exported `buildRuntimeSettingsSnapshot`
 * below) so `read_settings`/`update_settings` (planner tools,
 * `planner/tools.ts`) read and write the exact same DTO shape `PATCH
 * /api/settings` does, rather than a second projection of `SETTINGS_FIELDS`
 * that could quietly stop matching it.
 */
export function dtoKeyFor(field: SettingsField): string {
  if (field.key === 'codeServerBaseUrl') return 'codeServerUrl';
  if (field.key === 'sessionTtlMs') return 'sessionTtlHours';
  return field.key;
}

export function toDtoValue(field: SettingsField, configValue: unknown): unknown {
  if (field.key === 'sessionTtlMs') return Math.round((configValue as number) / 3_600_000);
  if (field.key === 'hostTags') return Array.isArray(configValue) ? [...(configValue as string[])] : [];
  if (typeof configValue === 'number' || typeof configValue === 'boolean') return configValue;
  return field.serialize(configValue as never);
}

export function fromDtoValue(field: SettingsField, dtoValue: unknown): unknown {
  if (field.key === 'sessionTtlMs') return Math.round((dtoValue as number) * 3_600_000);
  if (field.key === 'hostTags') {
    return Array.isArray(dtoValue)
      ? field.parse(JSON.stringify(dtoValue))
      : field.parse(String(dtoValue));
  }
  if (typeof dtoValue === 'number' || typeof dtoValue === 'boolean') return dtoValue;
  return field.parse(dtoValue as string);
}

/**
 * The `SETTINGS_FIELDS`-backed half of `GET /api/settings`'s response —
 * everything except the `fixed` block, which is boot-time server facts
 * (`host`/`port`/`databasePath`/`nodeEnv`) that stay in `routes/settings.ts`
 * rather than here, since nothing outside an HTTP response needs them.
 * `skipPermissionsEnabled` is folded in here (as a plain argument, not a
 * `SessionManager` dependency of this module) because it rides on the same
 * DTO even though it is not one of `SETTINGS_FIELDS` — see that field's own
 * doc comment in `routes/settings.ts`.
 */
export function buildRuntimeSettingsSnapshot(
  config: Config,
  skipPermissionsEnabled: boolean,
): { settings: Record<string, unknown>; restartRequiredKeys: string[] } {
  const settings: Record<string, unknown> = { skipPermissionsEnabled };
  for (const field of SETTINGS_FIELDS) {
    settings[dtoKeyFor(field)] = toDtoValue(field, config[field.key]);
  }
  return { settings, restartRequiredKeys: SETTINGS_FIELDS.filter((f) => !f.live).map(dtoKeyFor) };
}

export { SETTINGS_FIELDS, RESTART_REQUIRED_KEYS } from './fields.js';
export type { SettingsField } from './fields.js';
