import crypto from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import {
  CUSTOM_PROVIDER_LABEL_PREFIX,
  DEEPSEEK_DEFAULTS,
  DEEPSEEK_PROVIDER_DEFAULTS,
  OPENCODE_GO_PROVIDER_DEFAULTS,
  OPENCODE_ZEN_PROVIDER_DEFAULTS,
  POCKET_AGENT_LABEL_PREFIX,
  customClaudeProviderId,
  customProviderLabelSlug,
  isApiKeyProviderKind,
  isCustomClaudeProviderId,
  type CreateCustomClaudeProviderRequest,
  type CustomClaudeProviderKind,
  type CustomClaudeProviderSummary,
  type UpdateCustomClaudeProviderRequest,
} from '@pocketagent/protocol';
import {
  LEGACY_CLAUDE_PROVIDERS_MIGRATED_KEY,
  readSetting,
  writeSetting,
  type Db,
} from '../db/index.js';
import {
  SETTINGS_ENC_KEY_VAR,
  decryptSecret,
  encryptSecret,
} from '../crypto/secret-box.js';
import {
  readPlannerModels,
  readPlannerProvider,
  resolveAnthropicBaseUrlForProvider,
} from '../planner/store.js';
import type { AgentRegistry } from './registry.js';

export class CustomClaudeProviderError extends Error {
  override readonly name = 'CustomClaudeProviderError';
  constructor(
    message: string,
    readonly code: 'not_found' | 'invalid' | 'encryption_unavailable',
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/** Shape of a `custom_claude_providers` row, as SQLite hands it back. */
interface Row {
  id: string;
  name: string;
  provider_id?: string | null;
  provider_kind: string;
  base_url: string;
  api_key_ciphertext: string;
  models_json: string;
  default_model: string;
  small_model: string | null;
  allow_unattended: number;
  supports_effort: number;
  created_at: number;
  updated_at: number;
}

export interface CustomClaudeProviderStoreOptions {
  db: Db;
  /** Kept in sync on every mutation — that is the point of this class. */
  registry: AgentRegistry;
  /** `undefined` disables create/update; see `requireKey`. */
  encKey: Buffer | undefined;
  logger: FastifyBaseLogger;
}

/**
 * PA-28 / PA-154: owns `custom_claude_providers` and keeps `AgentRegistry` in
 * step with it.
 *
 * Since PA-154, a Custom Claude variant can reference an Anthropic-enabled
 * provider in `planner_providers` via `provider_id`, automatically inheriting
 * its Anthropic base URL, encrypted API key, and model catalog.
 */
export class CustomClaudeProviderStore {
  private readonly db: Db;
  private readonly registry: AgentRegistry;
  private readonly encKey: Buffer | undefined;
  private readonly logger: FastifyBaseLogger;

  constructor(opts: CustomClaudeProviderStoreOptions) {
    this.db = opts.db;
    this.registry = opts.registry;
    this.encKey = opts.encKey;
    this.logger = opts.logger;
    this.hydrate();
  }

  /** True when a key is configured, so create/update are possible at all. */
  get encryptionAvailable(): boolean {
    return this.encKey !== undefined;
  }

  list(): CustomClaudeProviderSummary[] {
    return this.rows().map(toSummary);
  }

  get(id: string): CustomClaudeProviderSummary {
    return toSummary(this.rowOrThrow(id));
  }

  create(req: CreateCustomClaudeProviderRequest): CustomClaudeProviderSummary {
    const key = this.requireKey();
    this.assertNameNotReserved(req.name);

    let providerId: string | null = null;
    let providerKind: CustomClaudeProviderKind = req.providerKind ?? 'claude-compatible';
    let baseUrl: string;
    let apiKeyCiphertext: string;
    let models: string[];

    if (req.providerId) {
      const linked = this.resolveLinkedProvider(req.providerId, req.models);
      providerId = linked.providerId;
      providerKind = linked.providerKind;
      baseUrl = linked.baseUrl;
      apiKeyCiphertext =
        req.apiKey && req.apiKey.trim().length > 0
          ? encryptSecret(req.apiKey, key)
          : linked.apiKeyCiphertext;
      models = linked.models;
    } else {
      models = normalizeModels(req.models ?? []);
      baseUrl = normalizeBaseUrl(req.baseUrl ?? '');
      apiKeyCiphertext = encryptSecret(req.apiKey ?? '', key);
    }

    const defaultModel = (req.defaultModel ?? models[0] ?? '').trim();
    assertModelKnown(defaultModel, models, 'Default model');
    const smallModel = req.smallModel?.trim() || null;
    if (smallModel) assertModelKnown(smallModel, models, 'Small model');

    const now = Date.now();
    const id = mintProviderId(req.name, new Set(this.rows().map((r) => r.id)));
    const row: Row = {
      id,
      name: req.name.trim(),
      provider_id: providerId,
      provider_kind: providerKind,
      base_url: baseUrl,
      api_key_ciphertext: apiKeyCiphertext,
      models_json: JSON.stringify(models),
      default_model: defaultModel,
      small_model: smallModel,
      allow_unattended: req.allowUnattended ? 1 : 0,
      supports_effort: req.supportsEffort !== false ? 1 : 0,
      created_at: now,
      updated_at: now,
    };
    this.insert(row);
    this.registerRow(row);
    this.logger.info(
      // Never the key, and never the ciphertext either — an audit line should
      // not be a place a credential can be recovered from with one more step.
      {
        provider: row.id,
        plannerProviderId: row.provider_id ?? null,
        baseUrl: row.base_url,
        allowUnattended: row.allow_unattended === 1,
      },
      'custom Claude provider created',
    );
    return toSummary(row);
  }

  /**
   * Apply a partial update. `apiKey` omitted *or* blank keeps the stored key —
   * the editor's password field starts empty because there is nothing to
   * prefill it with (there is no reveal endpoint, by design), so a save that
   * treated blank as "clear it" would silently break the provider.
   */
  update(id: string, req: UpdateCustomClaudeProviderRequest): CustomClaudeProviderSummary {
    const existing = this.rowOrThrow(id);
    if (req.name !== undefined) this.assertNameNotReserved(req.name);
    const rekeying = (req.apiKey ?? '').trim().length > 0;
    // Only demanded when something actually has to be encrypted. Without this,
    // an operator with no key set could not even turn `allowUnattended` off on
    // a row migrated from `.env` by an earlier boot that did have one.
    const key = rekeying ? this.requireKey() : undefined;

    const effectiveProviderId =
      req.providerId !== undefined ? req.providerId : (existing.provider_id ?? null);

    let providerKind = req.providerKind ?? existing.provider_kind;
    let baseUrl = req.baseUrl === undefined ? existing.base_url : normalizeBaseUrl(req.baseUrl);
    let apiKeyCiphertext =
      key !== undefined && req.apiKey !== undefined
        ? encryptSecret(req.apiKey, key)
        : existing.api_key_ciphertext;
    let models: string[];

    if (effectiveProviderId) {
      const linked = this.resolveLinkedProvider(effectiveProviderId, req.models);
      providerKind = linked.providerKind;
      baseUrl = linked.baseUrl;
      if (!rekeying && linked.apiKeyCiphertext) {
        apiKeyCiphertext = linked.apiKeyCiphertext;
      }
      models = linked.models;
    } else {
      models =
        req.models === undefined ? parseModels(existing.models_json) : normalizeModels(req.models);
    }

    const defaultModel = (
      req.defaultModel ??
      (models.includes(existing.default_model) ? existing.default_model : models[0]) ??
      existing.default_model
    ).trim();
    assertModelKnown(defaultModel, models, 'Default model');
    const smallModel =
      req.smallModel === undefined
        ? existing.small_model && models.includes(existing.small_model)
          ? existing.small_model
          : null
        : req.smallModel?.trim() || null;
    if (smallModel) assertModelKnown(smallModel, models, 'Small model');

    const row: Row = {
      ...existing,
      name: req.name === undefined ? existing.name : req.name.trim(),
      provider_id: effectiveProviderId,
      provider_kind: providerKind,
      base_url: baseUrl,
      api_key_ciphertext: apiKeyCiphertext,
      models_json: JSON.stringify(models),
      default_model: defaultModel,
      small_model: smallModel,
      allow_unattended:
        req.allowUnattended === undefined ? existing.allow_unattended : req.allowUnattended ? 1 : 0,
      supports_effort:
        req.supportsEffort === undefined ? (existing.supports_effort ?? 1) : req.supportsEffort ? 1 : 0,
      updated_at: Date.now(),
    };
    this.db
      .prepare(
        `UPDATE custom_claude_providers
            SET name = ?, provider_id = ?, provider_kind = ?, base_url = ?, api_key_ciphertext = ?,
                models_json = ?, default_model = ?, small_model = ?, allow_unattended = ?,
                supports_effort = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        row.name,
        row.provider_id ?? null,
        row.provider_kind,
        row.base_url,
        row.api_key_ciphertext,
        row.models_json,
        row.default_model,
        row.small_model,
        row.allow_unattended,
        row.supports_effort,
        row.updated_at,
        row.id,
      );
    this.registerRow(row);
    this.logger.info(
      {
        provider: row.id,
        plannerProviderId: row.provider_id ?? null,
        rekeyed: rekeying,
        allowUnattended: row.allow_unattended === 1,
      },
      'custom Claude provider updated',
    );
    return toSummary(row);
  }

  /**
   * PA-154: Re-synchronizes any Custom Claude variants linked to a
   * `planner_providers` row (`provider_id IS NOT NULL`) after providers or
   * models are modified in Settings -> Providers and Models.
   */
  syncFromPlannerProviders(): void {
    for (const row of this.rows()) {
      if (!row.provider_id) continue;
      const plannerProvider = readPlannerProvider(this.db, row.provider_id);
      if (
        !plannerProvider ||
        !isApiKeyProviderKind(plannerProvider.kind) ||
        !plannerProvider.endpoints.includes('anthropic')
      ) {
        continue;
      }
      const providerModels = normalizeModels(
        readPlannerModels(this.db, plannerProvider.id).map((m) => m.modelId),
      );
      const models = providerModels.length > 0 ? providerModels : parseModels(row.models_json);
      if (models.length === 0) continue;
      const baseUrl = normalizeBaseUrl(resolveAnthropicBaseUrlForProvider(plannerProvider));
      const apiKeyCiphertext = plannerProvider.secretCiphertext ?? row.api_key_ciphertext;
      const defaultModel = models.includes(row.default_model) ? row.default_model : models[0]!;
      const smallModel =
        row.small_model && models.includes(row.small_model) ? row.small_model : null;
      const providerKind = plannerProvider.kind === 'deepseek' ? 'deepseek' : 'claude-compatible';

      const updated: Row = {
        ...row,
        provider_kind: providerKind,
        base_url: baseUrl,
        api_key_ciphertext: apiKeyCiphertext,
        models_json: JSON.stringify(models),
        default_model: defaultModel,
        small_model: smallModel,
      };
      this.db
        .prepare(
          `UPDATE custom_claude_providers
              SET provider_kind = ?, base_url = ?, api_key_ciphertext = ?,
                  models_json = ?, default_model = ?, small_model = ?
            WHERE id = ?`,
        )
        .run(
          updated.provider_kind,
          updated.base_url,
          updated.api_key_ciphertext,
          updated.models_json,
          updated.default_model,
          updated.small_model,
          updated.id,
        );
      this.registerRow(updated);
    }
  }

  /**
   * Forget a provider.
   *
   * Sessions, cron jobs and webhooks that named it keep their rows — the same
   * "removing a thing never rewrites history" discipline `cron_runs` and
   * `webhook_deliveries` follow. Their agent id simply stops resolving, which
   * every consumer already handles (`structuredAgentProblem` answers "No such
   * agent", `agentDisplayName` falls back to the raw id).
   */
  remove(id: string): boolean {
    const changes = this.db.prepare('DELETE FROM custom_claude_providers WHERE id = ?').run(id)
      .changes;
    if (changes === 0) return false;
    this.registry.unregisterCustomProvider(id);
    this.logger.info({ provider: id }, 'custom Claude provider deleted');
    return true;
  }

  /**
   * One-time import of the PA-19 env-var variants into rows, run at boot.
   *
   * Existing deployments are running `claude-deepseek` / `claude-omniroute`
   * from `.env` today; "the env vars are no longer the mechanism" must not mean
   * "your working provider disappeared on upgrade". So the variables are read
   * exactly once — from raw `process.env`, deliberately not through the `Config`
   * schema, because they are no longer configuration — a row is written per
   * configured variant, and the flag is set so this never runs again.
   *
   * Skipped entirely, and **without setting the flag**, when no encryption key
   * is configured: there would be nothing to encrypt the imported key with, and
   * consuming the one-shot now would mean the import silently never happens
   * once the operator does generate a key.
   *
   * Returns how many providers were imported.
   */
  migrateLegacyEnvProviders(env: NodeJS.ProcessEnv = process.env): number {
    if (readSetting(this.db, LEGACY_CLAUDE_PROVIDERS_MIGRATED_KEY) !== null) return 0;

    const legacy = readLegacyEnv(env);
    if (legacy.length === 0) return 0;

    if (this.encKey === undefined) {
      this.logger.warn(
        { providers: legacy.map((l) => l.id) },
        `POCKETAGENT_DEEPSEEK_*/POCKETAGENT_OMNIROUTE_* are set but ${SETTINGS_ENC_KEY_VAR} is not, ` +
          'so they cannot be imported as custom Claude providers yet. Generate a key and restart; ' +
          'the import will run then.',
      );
      return 0;
    }

    const now = Date.now();
    let imported = 0;
    for (const provider of legacy) {
      const id = customClaudeProviderId(provider.id);
      // `INSERT OR IGNORE`-shaped guard rather than a plain insert: the flag is
      // the real one-shot, but a stable id means a hand-created provider could
      // already own it, and clobbering that would be worse than skipping.
      if (this.rowById(id) !== undefined) continue;
      const row: Row = {
        id,
        name: provider.name,
        provider_kind: provider.kind,
        base_url: provider.baseUrl,
        api_key_ciphertext: encryptSecret(provider.apiKey, this.encKey),
        models_json: JSON.stringify(provider.models),
        default_model: provider.defaultModel,
        small_model: provider.smallModel,
        // Off, exactly as PA-19 had it. An operator who wants an imported
        // provider on a timer has to say so in Settings, which is the whole
        // point of making it a per-provider decision.
        allow_unattended: 0,
        supports_effort: 1,
        created_at: now,
        updated_at: now,
      };
      this.insert(row);
      this.registerRow(row);
      imported += 1;
    }

    writeSetting(this.db, LEGACY_CLAUDE_PROVIDERS_MIGRATED_KEY, String(now));
    if (imported > 0) {
      this.logger.warn(
        { imported: legacy.map((l) => l.name) },
        'DEPRECATED: POCKETAGENT_DEEPSEEK_*/POCKETAGENT_OMNIROUTE_* have been imported as custom ' +
          'Claude providers and are no longer read. Manage them under Settings -> Custom Claude ' +
          'Providers, and delete the variables from .env. Note the agent id changed, so an old ' +
          'chat started as claude-deepseek continues to show that name.',
      );
    }
    return imported;
  }

  // ---- internals ------------------------------------------------------------

  /**
   * Push every stored row into the registry at construction.
   *
   * A row that cannot be decrypted is registered with a null key rather than
   * skipped or thrown on: a wrong or rotated `POCKETAGENT_SETTINGS_ENC_KEY`
   * must not stop the server booting, and the honest presentation of that state
   * is a provider that is listed but greyed out, not one that has silently
   * vanished while its row is plainly still in Settings.
   */
  private hydrate(): void {
    this.syncFromPlannerProviders();
    const rows = this.rows();
    if (rows.length > 0 && this.encKey === undefined) {
      this.logger.warn(
        { providers: rows.length },
        `${SETTINGS_ENC_KEY_VAR} is not set, so no stored custom Claude provider can be used. ` +
          'They are listed but unavailable until the key that encrypted them is configured.',
      );
    }
    for (const row of rows) this.registerRow(row);
  }

  private resolveLinkedProvider(
    providerId: string,
    fallbackModels?: readonly string[],
  ): {
    providerId: string;
    providerKind: CustomClaudeProviderKind;
    baseUrl: string;
    apiKeyCiphertext: string;
    models: string[];
  } {
    const plannerProvider = readPlannerProvider(this.db, providerId);
    if (!plannerProvider) {
      throw new CustomClaudeProviderError('Selected provider was not found.', 'invalid', 400);
    }
    if (
      !isApiKeyProviderKind(plannerProvider.kind) ||
      !plannerProvider.endpoints.includes('anthropic')
    ) {
      throw new CustomClaudeProviderError(
        `Provider "${plannerProvider.label}" does not have the Anthropic endpoint enabled.`,
        'invalid',
        400,
      );
    }
    const providerModels = normalizeModels(
      readPlannerModels(this.db, plannerProvider.id).map((m) => m.modelId),
    );
    const models =
      providerModels.length > 0
        ? providerModels
        : fallbackModels && fallbackModels.length > 0
          ? normalizeModels(fallbackModels)
          : plannerProvider.kind === 'deepseek'
            ? [...DEEPSEEK_PROVIDER_DEFAULTS.defaultModels]
            : plannerProvider.kind === 'opencode-zen'
              ? [...OPENCODE_ZEN_PROVIDER_DEFAULTS.defaultModels]
              : plannerProvider.kind === 'opencode-go'
                ? [...OPENCODE_GO_PROVIDER_DEFAULTS.defaultModels]
                : [];
    if (models.length === 0) {
      throw new CustomClaudeProviderError(
        `Provider "${plannerProvider.label}" has no models configured. Add at least one model to the provider first.`,
        'invalid',
        400,
      );
    }
    return {
      providerId: plannerProvider.id,
      providerKind: plannerProvider.kind === 'deepseek' ? 'deepseek' : 'claude-compatible',
      baseUrl: normalizeBaseUrl(resolveAnthropicBaseUrlForProvider(plannerProvider)),
      apiKeyCiphertext: plannerProvider.secretCiphertext ?? '',
      models,
    };
  }

  private registerRow(row: Row): void {
    this.registry.registerCustomProvider({
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      apiKey: this.decryptKey(row),
      models: parseModels(row.models_json),
      defaultModel: row.default_model,
      smallModel: row.small_model,
      allowUnattended: row.allow_unattended === 1,
      supportsEffort: row.supports_effort !== 0,
    });
  }

  private decryptKey(row: Row): string | null {
    if (!row.api_key_ciphertext) return null;
    if (this.encKey === undefined) return null;
    try {
      return decryptSecret(row.api_key_ciphertext, this.encKey);
    } catch {
      // The message deliberately carries no part of the ciphertext.
      this.logger.error(
        { provider: row.id },
        `Could not decrypt this custom Claude provider's API key with the configured ` +
          `${SETTINGS_ENC_KEY_VAR}. Re-enter the key in Settings to repair it.`,
      );
      return null;
    }
  }

  /**
   * A custom provider's name doubles as the plain, unprefixed slug a Jira
   * `agent:<slug>` label may name it by (`resolveLabelOverrides` in
   * `webhooks/jira.ts`) — that fallback is only ever reached once every
   * built-in coding agent id has already missed, so it can never *shadow*
   * one, but a provider named the same thing as one would still be
   * permanently unreachable by its own plain-name label, silently falling
   * back to whatever the webhook's configured agent already was. That is
   * exactly the confusing failure this guard exists to turn into an error at
   * creation/rename time instead of a support ticket later. Same reasoning
   * for the two reserved label prefixes: a name that slugs to `pocket-...` or
   * `custom-...` gets diverted into the *other* namespace's branch before the
   * plain-name fallback ever runs, so it could never be reached by its own
   * name either.
   */
  private assertNameNotReserved(name: string): void {
    const slug = customProviderLabelSlug(name);
    if (!slug) return;

    if (slug.startsWith(POCKET_AGENT_LABEL_PREFIX) || slug.startsWith(CUSTOM_PROVIDER_LABEL_PREFIX)) {
      throw new CustomClaudeProviderError(
        `Provider name cannot start with "${POCKET_AGENT_LABEL_PREFIX}" or ` +
          `"${CUSTOM_PROVIDER_LABEL_PREFIX}" (as a label slug) — that would make it unreachable by ` +
          'its own name in a Jira `agent:` label.',
        'invalid',
        400,
      );
    }

    // `registry.list()` at this point is every built-in coding agent plus
    // every *other* already-registered custom provider; only the former is
    // reserved. Filtering the latter out (rather than the still-simpler "any
    // id") is what lets renaming a provider to its own current name pass.
    const codingAgentIds = this.registry
      .list()
      .map((a) => a.id)
      .filter((id) => !isCustomClaudeProviderId(id));
    if (codingAgentIds.includes(slug)) {
      throw new CustomClaudeProviderError(
        `Provider name conflicts with the built-in agent "${slug}". Choose a name whose slug ` +
          '(lowercase, hyphenated) does not match a coding agent id.',
        'invalid',
        400,
      );
    }
  }

  private requireKey(): Buffer {
    if (this.encKey === undefined) {
      throw new CustomClaudeProviderError(
        `Set ${SETTINGS_ENC_KEY_VAR} to enable custom Claude providers.`,
        'encryption_unavailable',
        409,
      );
    }
    return this.encKey;
  }

  private rows(): Row[] {
    return this.db
      .prepare('SELECT * FROM custom_claude_providers ORDER BY name COLLATE NOCASE, created_at')
      .all() as Row[];
  }

  private rowById(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM custom_claude_providers WHERE id = ?').get(id) as
      | Row
      | undefined;
  }

  private rowOrThrow(id: string): Row {
    const row = this.rowById(id);
    if (row === undefined) {
      throw new CustomClaudeProviderError('No such custom Claude provider.', 'not_found', 404);
    }
    return row;
  }

  private insert(row: Row): void {
    this.db
      .prepare(
        `INSERT INTO custom_claude_providers
           (id, name, provider_id, provider_kind, base_url, api_key_ciphertext, models_json,
            default_model, small_model, allow_unattended, supports_effort, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.name,
        row.provider_id ?? null,
        row.provider_kind,
        row.base_url,
        row.api_key_ciphertext,
        row.models_json,
        row.default_model,
        row.small_model,
        row.allow_unattended,
        row.supports_effort,
        row.created_at,
        row.updated_at,
      );
  }
}

function toSummary(row: Row): CustomClaudeProviderSummary {
  return {
    id: row.id,
    name: row.name,
    providerId: row.provider_id ?? null,
    // Widened on read rather than trusted: the column is a plain TEXT, so a
    // hand-edited row cannot make the response fail its own schema.
    providerKind: row.provider_kind === 'deepseek' ? 'deepseek' : 'claude-compatible',
    baseUrl: row.base_url,
    models: parseModels(row.models_json),
    defaultModel: row.default_model,
    smallModel: row.small_model,
    allowUnattended: row.allow_unattended === 1,
    supportsEffort: (row.supports_effort ?? 1) !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseModels(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m): m is string => typeof m === 'string' && m.length > 0);
  } catch {
    return [];
  }
}

/** Trim, drop blanks, de-duplicate, keep first-seen order — same as the picker's. */
function normalizeModels(models: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of models) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  if (out.length === 0) {
    throw new CustomClaudeProviderError('At least one model id is required.', 'invalid', 400);
  }
  return out;
}

/**
 * A bare origin (plus optional path prefix), with any trailing slash removed.
 *
 * Claude Code appends its own `/v1/messages`, so a base URL that already ends
 * in a slash produces a double one, and some gateways 404 on that — a failure
 * that surfaces as an auth-looking error a long way from its cause.
 */
function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new CustomClaudeProviderError(
      'Base URL must be an absolute http(s) URL, e.g. https://api.example.com/anthropic.',
      'invalid',
      400,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CustomClaudeProviderError('Base URL must use http or https.', 'invalid', 400);
  }
  return trimmed;
}

function assertModelKnown(model: string, models: readonly string[], label: string): void {
  if (!models.includes(model)) {
    throw new CustomClaudeProviderError(
      `${label} "${model}" is not in this provider's model list.`,
      'invalid',
      400,
    );
  }
}

/**
 * `custom-claude:<slug>-<hex>`.
 *
 * A slug for legibility (this id shows up in logs, in a session row and in a
 * cron job's `agent` column) plus random hex so two providers can share a
 * display name without colliding — and so an id is never guessable from the
 * name alone, which matters because deleting one and creating another with the
 * same name must not silently adopt the deleted one's history.
 */
function mintProviderId(name: string, taken: ReadonlySet<string>): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'provider';
  for (;;) {
    const id = customClaudeProviderId(`${slug}-${crypto.randomBytes(4).toString('hex')}`);
    if (!taken.has(id)) return id;
  }
}

interface LegacyProvider {
  /** The un-prefixed part of the id, kept stable so a re-run is idempotent. */
  id: string;
  name: string;
  kind: CustomClaudeProviderKind;
  baseUrl: string;
  apiKey: string;
  models: string[];
  defaultModel: string;
  smallModel: string | null;
}

/**
 * The PA-19 env vars, read once for the import and nowhere else.
 *
 * The API key is the switch, exactly as it was: a variant with no key was never
 * usable, so there is nothing to import for it. The defaults reproduce what
 * `Config.claudeProviders` used to compute, so an operator's working setup comes
 * across unchanged rather than subtly re-defaulted.
 */
function readLegacyEnv(env: NodeJS.ProcessEnv): LegacyProvider[] {
  const out: LegacyProvider[] = [];

  const deepseekKey = env.POCKETAGENT_DEEPSEEK_API_KEY?.trim();
  if (deepseekKey) {
    const models = splitModels(env.POCKETAGENT_DEEPSEEK_MODELS) ?? [...DEEPSEEK_DEFAULTS.models];
    const defaultModel = env.POCKETAGENT_DEEPSEEK_MODEL?.trim() || DEEPSEEK_DEFAULTS.defaultModel;
    const smallModel =
      env.POCKETAGENT_DEEPSEEK_SMALL_MODEL?.trim() || DEEPSEEK_DEFAULTS.smallModel;
    out.push({
      id: 'deepseek',
      name: 'Claude Code (DeepSeek)',
      kind: 'deepseek',
      baseUrl: env.POCKETAGENT_DEEPSEEK_BASE_URL?.trim() || DEEPSEEK_DEFAULTS.baseUrl,
      apiKey: deepseekKey,
      // The catalog has to contain whatever the two model slots name, or the
      // imported row would fail its own `assertModelKnown` on the first edit.
      models: withModels(models, [defaultModel, smallModel]),
      defaultModel,
      smallModel,
    });
  }

  const omnirouteKey = env.POCKETAGENT_OMNIROUTE_API_KEY?.trim();
  const omnirouteBase = env.POCKETAGENT_OMNIROUTE_BASE_URL?.trim();
  const omnirouteModel = env.POCKETAGENT_OMNIROUTE_MODEL?.trim();
  // Unlike DeepSeek, none of these had a default worth guessing — a gateway URL
  // and its catalog are per-installation. Without both a URL and a model there
  // is no row that could be valid, so it is skipped rather than half-imported.
  if (omnirouteKey && omnirouteBase && omnirouteModel) {
    const smallModel = env.POCKETAGENT_OMNIROUTE_SMALL_MODEL?.trim() || null;
    out.push({
      id: 'omniroute',
      name: 'Claude Code (Omniroute)',
      kind: 'claude-compatible',
      baseUrl: omnirouteBase,
      apiKey: omnirouteKey,
      models: withModels(splitModels(env.POCKETAGENT_OMNIROUTE_MODELS) ?? [], [
        omnirouteModel,
        smallModel,
      ]),
      defaultModel: omnirouteModel,
      smallModel,
    });
  }

  return out;
}

function splitModels(raw: string | undefined): string[] | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(',').map((m) => m.trim()).filter(Boolean);
  return parts.length > 0 ? parts : null;
}

function withModels(models: readonly string[], required: readonly (string | null)[]): string[] {
  const out = [...models];
  for (const model of required) {
    if (model && !out.includes(model)) out.push(model);
  }
  return out;
}
