import { z } from 'zod';

/**
 * PA-28: a user-managed Claude Code provider variant.
 *
 * Replaces the two compiled-in variants (`claude-deepseek` /
 * `claude-omniroute`, PA-19) that were configured through
 * `POCKETAGENT_DEEPSEEK_*` / `POCKETAGENT_OMNIROUTE_*` env vars and registered
 * once at boot. A provider is now a row the user creates from Settings, its API
 * key encrypted at rest, and it is registered into the live `AgentRegistry`
 * synchronously on every mutation — no restart.
 *
 * The agent id a provider occupies is `custom-claude:<id>`, minted by
 * `customClaudeProviderId` in `session.ts` (co-located with
 * `usesClaudeTranscripts`, whose rule it changes).
 */

/**
 * Which third party this provider points at.
 *
 * **Presentation only.** `createClaudeProviderAdapter` does not branch on it —
 * a provider is a base URL, a key and a model list whatever this says. It exists
 * so the editor can prefill DeepSeek's published Anthropic-compatible endpoint
 * and its catalog ids instead of making a user retype them, which is the one
 * case where a guess is actually correct. Anything else is
 * `claude-compatible`: per-installation, so there is nothing to prefill.
 */
export const CustomClaudeProviderKind = z.enum(['deepseek', 'claude-compatible']);
export type CustomClaudeProviderKind = z.infer<typeof CustomClaudeProviderKind>;

/**
 * A provider as the browser sees it. **Never carries the API key**, in either
 * plaintext or ciphertext, and there is deliberately no reveal endpoint that
 * would: unlike a webhook's HMAC secret (which the sender also has to hold, so
 * "shown once" is a UX choice there rather than a cryptographic one), nothing
 * outside this server ever needs to read this key back. Editing a provider
 * re-enters it, or leaves the field blank to keep what is stored.
 */
export const CustomClaudeProviderSummary = z.object({
  /** The full agent id, `custom-claude:<slug>-<hex>` — what a session, cron job or webhook stores. */
  id: z.string(),
  /** Display name, shown wherever an agent is named. */
  name: z.string(),
  providerKind: CustomClaudeProviderKind,
  /** Bare origin. Claude Code appends its own path, so no `/v1` or `/messages`. */
  baseUrl: z.string(),
  /** The picker's catalog for this provider — see `AgentAdapter.staticModels`. */
  models: z.array(z.string()),
  defaultModel: z.string(),
  /** Model for the CLI's title/compaction slots, or null to reuse `defaultModel`. */
  smallModel: z.string().nullable(),
  /**
   * Lifts the `requiresAttendedUse` block that keeps a provider variant out of
   * scheduled jobs and inbound webhooks. Off by default, and surfaced on the
   * row rather than only at creation — see the invariant in CLAUDE.md.
   */
  allowUnattended: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type CustomClaudeProviderSummary = z.infer<typeof CustomClaudeProviderSummary>;

/**
 * `encryptionAvailable` is false when `POCKETAGENT_SETTINGS_ENC_KEY` is unset.
 * The feature then degrades rather than failing to boot (an existing
 * deployment must not stop starting because it has not generated a key yet):
 * existing rows still list and still delete, but nothing can be created or
 * edited, and the editor says which variable to set instead of offering a form
 * whose save will be refused.
 */
export const CustomClaudeProviderListResponse = z.object({
  providers: z.array(CustomClaudeProviderSummary),
  encryptionAvailable: z.boolean(),
});
export type CustomClaudeProviderListResponse = z.infer<typeof CustomClaudeProviderListResponse>;

/** Bounds shared by both requests, so a create and an edit cannot disagree. */
const NAME = z.string().min(1).max(128);
const BASE_URL = z.string().min(1).max(2048);
const MODEL_ID = z.string().min(1).max(200);
const API_KEY = z.string().max(4096);

export const CreateCustomClaudeProviderRequest = z.object({
  name: NAME,
  providerKind: CustomClaudeProviderKind,
  baseUrl: BASE_URL,
  /**
   * Plaintext, and only ever on the wire: the server encrypts it before it
   * reaches the database and never sends it back. Required on create — a
   * provider with no key is an agent row that greys out and can do nothing.
   */
  apiKey: API_KEY.min(1),
  models: z.array(MODEL_ID).min(1).max(50),
  defaultModel: MODEL_ID,
  smallModel: MODEL_ID.nullable().optional(),
  allowUnattended: z.boolean().optional(),
});
export type CreateCustomClaudeProviderRequest = z.infer<typeof CreateCustomClaudeProviderRequest>;

/**
 * Partial update: only the keys present are touched, the same convention every
 * other PATCH here uses.
 *
 * `apiKey` is the one field with a special empty case — omitted *or* blank means
 * "keep the stored key", so the editor can render a password input that starts
 * empty (it has nothing to prefill it with, by design) without a save silently
 * wiping the credential.
 */
export const UpdateCustomClaudeProviderRequest = z.object({
  name: NAME.optional(),
  providerKind: CustomClaudeProviderKind.optional(),
  baseUrl: BASE_URL.optional(),
  apiKey: API_KEY.optional(),
  models: z.array(MODEL_ID).min(1).max(50).optional(),
  defaultModel: MODEL_ID.optional(),
  smallModel: MODEL_ID.nullable().optional(),
  allowUnattended: z.boolean().optional(),
});
export type UpdateCustomClaudeProviderRequest = z.infer<typeof UpdateCustomClaudeProviderRequest>;

/**
 * DeepSeek's published Anthropic-compatible route and its real catalog ids,
 * used by the editor to prefill a `deepseek` provider.
 *
 * Carried in the protocol rather than hardcoded in the editor because these are
 * also what the one-time legacy migration writes for an operator upgrading from
 * `POCKETAGENT_DEEPSEEK_*`, and two copies would drift. The ids come from
 * DeepSeek's own `GET /models`: the retired `deepseek-chat`/`deepseek-reasoner`
 * aliases still resolve but *both* serve `deepseek-v4-flash`, which put the same
 * model in the picker twice under two names (PA-19).
 */
export const DEEPSEEK_DEFAULTS = {
  baseUrl: 'https://api.deepseek.com/anthropic',
  models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  defaultModel: 'deepseek-v4-pro',
  /**
   * Explicit rather than falling back to `defaultModel`: the small slot drives
   * conversation titles and compaction summaries, which run constantly and do
   * not need the expensive model.
   */
  smallModel: 'deepseek-v4-flash',
} as const;
