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

export { SETTINGS_FIELDS, RESTART_REQUIRED_KEYS } from './fields.js';
export type { SettingsField } from './fields.js';
