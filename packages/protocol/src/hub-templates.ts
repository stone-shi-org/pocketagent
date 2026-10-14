import { z } from 'zod';
import { EffortLevel } from './agent-events.js';
import { PlannerModelOptionalFields } from './planner.js';
import { HubHostId } from './hub-registry.js';
import { McpAuthKind, McpTransportKind } from './mcp-registry.js';
import { CustomClaudeProviderKind } from './custom-claude-providers.js';

/**
 * PA-70: the Hub's *template* API — define a Pocket Agent, an MCP registry, a
 * skill, a Claude provider or a Pocket Agent LLM provider once, and
 * instantiate it onto any bound host.
 *
 * A third module beside `hub.ts` (PA-63's credential protocol) and
 * `hub-registry.ts` (PA-66's host registry) for the reason those two are
 * already apart: each answers a different question, and only the Hub
 * implements this one. `apps/server` must never grow a dependency on it — a
 * backend has no business knowing that templates exist, because provisioning
 * reaches it through the routes it already has (see `HubTemplateKind`).
 *
 * These schemas live in the shared package rather than in `apps/hub` because
 * both sides validate the same payload: the Hub on write and on read, and the
 * browser's editor while the operator is typing. That is the same argument
 * `cron-expr.ts` and `webhook-template.ts` already record for living here — a
 * shape validated in two places by two copies eventually disagrees, and the
 * disagreement surfaces as "the editor let me save something the Hub then
 * refused".
 *
 * ## The model, in one paragraph
 *
 * A template is instantiated and then **diverges freely**. There is no
 * reconciliation loop, no desired state and no drift correction: editing a
 * template does not touch a host that already has it, and re-provisioning is
 * an explicit, confirmed overwrite. What the Hub keeps instead is a *ledger*
 * of what it put where and which revision it sent, which is what lets the UI
 * say "dev01 has r3, this template is r5" without ever acting on it.
 */

/**
 * What a template can describe.
 *
 * A closed enum, and the closure is load-bearing twice over. It is what lets
 * `parseTemplatePayload` be exhaustive rather than defensive, and it is the
 * complete list of things the Hub knows how to write to a backend — every
 * member maps onto routes that already exist there (`POST
 * /api/planner/workspaces`, `POST /api/mcp-registries`, `POST
 * /api/custom-claude-providers`, `POST /api/planner/skills/import`, `POST
 * /api/planner/providers`), so provisioning is the Hub being an API client
 * rather than a new contract between the two services.
 *
 * Deliberately absent, each for a reason recorded on the ticket: **webhooks**
 * (a slug, an HMAC secret and a delivery URL Jira points at exactly one host —
 * cloning it to three means one is real and two are dead config), **cron jobs**
 * (cloning a nightly job to three machines runs it three times) and
 * **`planner_tool_approvals`** (a record of a *decision made*, not
 * configuration; templating a remembered approval would manufacture consent
 * nobody gave on that host).
 */
export const HubTemplateKind = z.enum([
  'pocket-agent',
  'mcp-registry',
  'claude-provider',
  'skill',
  'planner-provider',
]);
export type HubTemplateKind = z.infer<typeof HubTemplateKind>;

/**
 * Legacy kind name before PA-148 replaced the singleton `planner-endpoint`
 * with the additive `planner-provider` kind. Retained so existing rows in
 * `hub_templates` and exported JSON files still parse and map cleanly.
 */
export const LegacyHubTemplateKind = z.enum([
  'pocket-agent',
  'mcp-registry',
  'claude-provider',
  'skill',
  'planner-provider',
  'planner-endpoint',
]);
export type LegacyHubTemplateKind = z.infer<typeof LegacyHubTemplateKind>;

/**
 * Whether instantiating this kind *adds* a resource to a host or *replaces*
 * host-wide configuration. Since PA-148 replaced `planner-endpoint` with the
 * additive `planner-provider` kind, every template kind is additive and
 * tracked by its remote id in the ledger.
 */
export function isSingletonKind(_kind: HubTemplateKind): boolean {
  return false;
}

const TEMPLATE_NAME = z.string().min(1).max(128);
const DESCRIPTION = z.string().max(2000);
const BASE_URL = z.string().min(1).max(2048);
const MODEL_ID = z.string().min(1).max(200);

/**
 * A Pocket Agent (planner workspace) definition.
 *
 * Note what is **not** here: `path` and `createPath`, the two fields
 * `CreatePlannerWorkspaceRequest` also accepts. They are absent from the
 * schema rather than rejected at runtime, so this cannot be re-widened by a
 * refactor that drops a check.
 *
 * Two independent reasons. A planner workspace's `path` column is `UNIQUE` and
 * absolute, and since PA-62 its root lives under that host's own
 * `POCKETAGENT_DATA_DIR` — so a path is host-specific by construction and a
 * template carrying one is wrong on every machine whose data root differs,
 * which is every containerised host by design. And pointing an agent at an
 * operator-chosen directory hands that agent's `write_file`/`exec_command`/
 * `rmdir` tools full read/write/delete trust over it (see
 * `PlannerWorkspaceRegistry.create`'s own doc comment for that deliberate
 * widening); doing it in bulk, remotely, from the one process whose compromise
 * this ticket already names as the risk is a much larger grant than "provision
 * a new host quickly" asks for. Instantiation therefore always takes the
 * app-created-scratch-directory branch, and an operator who wants one agent
 * pointed somewhere real does it in that host's own editor, which already
 * exists and already discloses what it does.
 *
 * `defaultModelId` *is* portable, which is worth stating because it looks like
 * it should not be: it is the provider's own model **name** (the string that
 * goes into the LLM request body), not a `planner_models` row id — see
 * `PlannerWorkspace.defaultModelId`. It travels to any host whose endpoint
 * offers the same name, and a host whose endpoint does not is a reported
 * mismatch rather than a corrupt row.
 *
 * `disabledTools` carries tool *names* from the global catalog, which are
 * stable strings. Disabled skills and disabled MCP registries are deliberately
 * not carried: both reference ids minted on the host that owns them
 * (`global:<slug>` / `<workspaceId>:<slug>`, and `mcp:<slug>-<hex>`), so a
 * template cannot name one meaningfully.
 */
export const PocketAgentTemplatePayload = z.object({
  name: z.string().min(1).max(128),
  defaultModelId: z.string().max(200).nullable(),
  identityPrompt: z.string().max(4000).nullable(),
  memoryEnabled: z.boolean(),
  mcpEnabled: z.boolean(),
  /** Tool names to turn *off*, matching `planner_agent_disabled_tools`'
      deny-list semantics — everything defaults to enabled, so a tool added to
      a host's catalog later is on there without this template mentioning it. */
  disabledTools: z.array(z.string().min(1).max(200)).max(200),
});
export type PocketAgentTemplatePayload = z.infer<typeof PocketAgentTemplatePayload>;

/**
 * An MCP registry entry, minus its credential.
 *
 * `headerName` is carried and `headerValue` is a hole: the name is
 * configuration (`X-Api-Key`), the value is the secret. Worth knowing before
 * provisioning one: `POST /api/mcp-registries` runs a connection check as part
 * of creation, so instantiating this makes the *receiving host* dial the third
 * party — which is the intent, but it is a side effect the confirmation names.
 */
export const SingleMcpRegistryTemplatePayload = z
  .object({
    name: z.string().min(1).max(128),
    transport: McpTransportKind,
    url: z.string().min(1).max(2048),
    authKind: McpAuthKind,
    headerName: z.string().min(1).max(200).nullable(),
    description: DESCRIPTION.nullable(),
    enabled: z.boolean(),
  })
  // Mirrors `CreateMcpRegistryRequest`'s own refinement, minus the half that
  // is a secret. Enforced here rather than left to the backend so the editor
  // refuses it while the operator is typing: a template saved with
  // `authKind: 'header'` and no header name would look fine until a
  // provisioning run failed on every host at once, which is the failure mode
  // keeping these schemas in the shared package exists to prevent.
  .refine((v) => v.authKind !== 'header' || (v.headerName ?? '').length > 0, {
    message: 'A header name is required when auth is set to header.',
    path: ['headerName'],
  });
export type SingleMcpRegistryTemplatePayload = z.infer<typeof SingleMcpRegistryTemplatePayload>;

/**
 * A bundle of MCP registry entries within a single template (PA-111).
 */
export const McpRegistryBundleTemplatePayload = z.object({
  registries: z.array(SingleMcpRegistryTemplatePayload).min(1).max(50),
});
export type McpRegistryBundleTemplatePayload = z.infer<typeof McpRegistryBundleTemplatePayload>;

/**
 * An MCP registry template payload — either a single registry or a bundle of registries.
 */
export const McpRegistryTemplatePayload = z.union([
  SingleMcpRegistryTemplatePayload,
  McpRegistryBundleTemplatePayload,
]);
export type McpRegistryTemplatePayload = z.infer<typeof McpRegistryTemplatePayload>;

export function isMcpRegistryBundle(
  payload: McpRegistryTemplatePayload,
): payload is McpRegistryBundleTemplatePayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'registries' in payload &&
    Array.isArray((payload as McpRegistryBundleTemplatePayload).registries)
  );
}

export function mcpRegistriesFromPayload(
  payload: McpRegistryTemplatePayload,
): SingleMcpRegistryTemplatePayload[] {
  return isMcpRegistryBundle(payload) ? payload.registries : [payload];
}

/**
 * A custom Claude provider, minus its API key.
 *
 * `allowUnattended` is carried but defaults off and is named explicitly in the
 * per-host confirmation, because it is PA-28's own opt-in: it lifts the
 * attended-use block that otherwise keeps a third-party provider out of
 * scheduled jobs and inbound webhooks. That flag is off by default in the
 * column, in the create request *and* in the editor precisely so turning it on
 * is a deliberate act; a template that flipped it on across a fleet silently
 * would be exactly the quiet default flip the first invariant forbids.
 */
export const ClaudeProviderTemplatePayload = z.object({
  name: z.string().min(1).max(128),
  providerKind: CustomClaudeProviderKind,
  baseUrl: BASE_URL,
  models: z.array(MODEL_ID).min(1).max(50),
  defaultModel: MODEL_ID,
  smallModel: MODEL_ID.nullable(),
  allowUnattended: z.boolean(),
  supportsEffort: z.boolean().optional(),
});
export type ClaudeProviderTemplatePayload = z.infer<typeof ClaudeProviderTemplatePayload>;

/**
 * A skill: frontmatter plus body, carried as content.
 *
 * This is the one kind that needed a new backend route. `POST
 * /api/planner/skills` takes a filesystem *path on the receiving host*, which
 * the Hub cannot know and must not guess, and no other protocol type carries a
 * skill's body at all — `PlannerSkillInfo` is metadata. So `POST
 * /api/planner/skills/import` exists, and this payload is its body.
 *
 * `slug` is carried explicitly rather than derived from `name` on the
 * receiving host, because the ledger's `remoteId` is `global:<slug>`: a slug
 * re-derived per host could differ (a different build's slugifier, a name that
 * slugifies to a taken directory and gets a `-2` suffix) and the Hub would
 * then be unable to find what it provisioned.
 *
 * v1 limitation, stated rather than discovered: one `SKILL.md`, no auxiliary
 * files. A skill directory *can* hold more (`copyIntoGlobalCatalog` copies a
 * tree), and a template that silently dropped the rest would be worse than one
 * that refuses, so the editor says so.
 */
export const SkillTemplatePayload = z.object({
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/, {
      message: 'A skill slug is lowercase letters, digits and hyphens.',
    }),
  name: z.string().min(1).max(128),
  description: z.string().min(1).max(2000),
  body: z.string().min(1).max(100_000),
});
export type SkillTemplatePayload = z.infer<typeof SkillTemplatePayload>;

/**
 * One model inside a `planner-provider` (or legacy `planner-endpoint`) template.
 */
export const PlannerProviderTemplateModel = z.object({
  modelId: MODEL_ID,
  label: z.string().min(1).max(128),
  supportsEffort: z.boolean().optional(),
  defaultEffort: EffortLevel.nullable().optional(),
  // PA-122 / PA-137: context limits, caching, PDF and prices are portable —
  // their values mean the same thing on every host, and none is a secret.
  ...PlannerModelOptionalFields,
});
export type PlannerProviderTemplateModel = z.infer<typeof PlannerProviderTemplateModel>;

/**
 * PA-148: one OpenAI-compatible Pocket Agent LLM provider and its models.
 *
 * Replaces PA-70's singleton `planner-endpoint` kind with an additive
 * resource: instantiating it creates a `planner_providers` row and its
 * attached `planner_models` rows on the receiving host, and records the
 * provider's remote id in `hub_provisionings` so re-provisioning requires
 * explicit overwrite confirmation just like every other additive template.
 */
export const PlannerProviderTemplatePayload = z.object({
  label: z.string().min(1).max(128),
  /** PA-147: subscription providers are not templatable (an OAuth login is one person's account on one host). */
  kind: z.literal('openai-compatible').optional().default('openai-compatible'),
  baseUrl: BASE_URL,
  allowUnattended: z.boolean().optional().default(false),
  models: z.array(PlannerProviderTemplateModel).max(50),
});
export type PlannerProviderTemplatePayload = z.infer<typeof PlannerProviderTemplatePayload>;

/**
 * Legacy PA-70 singleton payload. Retained so existing `planner-endpoint` rows
 * in `hub_templates` and exported JSON files still parse and map cleanly onto a
 * `planner-provider` named after the template.
 */
export const PlannerEndpointTemplatePayload = z.object({
  baseUrl: BASE_URL,
  models: z.array(PlannerProviderTemplateModel).max(50),
  embeddingBaseUrl: BASE_URL.nullable().optional().default(null),
  embeddingModelId: MODEL_ID.nullable().optional().default(null),
  webSearchBaseUrl: BASE_URL.nullable().optional().default(null),
  urlFetchBaseUrl: BASE_URL.nullable().optional().default(null),
});
export type PlannerEndpointTemplatePayload = z.infer<typeof PlannerEndpointTemplatePayload>;

/** One kind's payload, resolved. */
export type HubTemplatePayload =
  | { kind: 'pocket-agent'; payload: PocketAgentTemplatePayload }
  | { kind: 'mcp-registry'; payload: McpRegistryTemplatePayload }
  | { kind: 'claude-provider'; payload: ClaudeProviderTemplatePayload }
  | { kind: 'skill'; payload: SkillTemplatePayload }
  | { kind: 'planner-provider'; payload: PlannerProviderTemplatePayload };

/**
 * Parse a payload against its kind's schema — the single place that mapping
 * lives, used by the Hub on write *and* on read and by the editor.
 *
 * Re-validating on read is not belt-and-braces: `payload_json` is a text
 * column, and a row edited by hand (or written by an older build with a
 * different schema) must not be able to reach an outbound request to somebody
 * else's machine unvalidated.
 *
 * PA-148: a legacy `planner-endpoint` payload is mapped on read to a
 * `planner-provider` named `fallbackLabel` (the template's own name, or
 * `"Default"` if none was supplied).
 */
export function parseTemplatePayload(
  kind: HubTemplateKind | 'planner-endpoint',
  raw: unknown,
  fallbackLabel?: string,
): { ok: true; value: HubTemplatePayload } | { ok: false; message: string } {
  if (kind === 'planner-endpoint') {
    const parsed = PlannerEndpointTemplatePayload.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid template payload.' };
    }
    const label = fallbackLabel && fallbackLabel.trim().length > 0 ? fallbackLabel.trim() : 'Default';
    return {
      ok: true,
      value: {
        kind: 'planner-provider',
        payload: {
          label: label.slice(0, 128),
          kind: 'openai-compatible',
          baseUrl: parsed.data.baseUrl,
          allowUnattended: false,
          models: parsed.data.models,
        },
      },
    };
  }
  const schema = {
    'pocket-agent': PocketAgentTemplatePayload,
    'mcp-registry': McpRegistryTemplatePayload,
    'claude-provider': ClaudeProviderTemplatePayload,
    skill: SkillTemplatePayload,
    'planner-provider': PlannerProviderTemplatePayload,
  }[kind];
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid template payload.' };
  }
  // The cast is safe because `kind` selected the schema that produced `data`;
  // TypeScript cannot follow that through the lookup table.
  return { ok: true, value: { kind, payload: parsed.data } as HubTemplatePayload };
}

/**
 * A secret this template needs but does not contain.
 *
 * The whole point of the feature's secret handling: a template declares the
 * *shape* of what is missing, and the value is supplied per host at
 * instantiation time. Nothing in the Hub's database has a column a secret
 * could go in — the enforcement is structural rather than a rule someone has
 * to remember — and the request body that carries one is redacted wholesale by
 * the Hub's pino config.
 *
 * The cost, accepted deliberately: re-provisioning asks again. Storing the
 * filled holes (even encrypted) would move the Hub from "holds a revocable
 * credential per host" to "holds every upstream API key the fleet uses", none
 * of which this product can revoke, and would make one
 * `POCKETAGENT_SETTINGS_ENC_KEY` the only thing between a Hub compromise and
 * every third-party account behind it.
 */
export const SecretHole = z.object({
  /** The key an instantiate request fills, e.g. `apiKey`. */
  key: z.string().min(1).max(64),
  /** What to put on the input's label. */
  label: z.string().min(1).max(200),
  /** False when the backend accepts the resource without it. */
  required: z.boolean(),
  /** Where it ends up, so an operator knows which credential to paste. */
  description: z.string().max(400),
});
export type SecretHole = z.infer<typeof SecretHole>;

/**
 * Which holes a given payload has.
 *
 * Derived from the payload rather than stored, because it is a *function* of
 * it: an MCP registry with `authKind: 'none'` needs no secret at all, and one
 * switched from `bearer` to `header` needs a different one. A stored list
 * would be a second source of truth that drifts on the first edit.
 */
export function secretHolesFor(spec: HubTemplatePayload): SecretHole[] {
  switch (spec.kind) {
    case 'pocket-agent':
    case 'skill':
      return [];
    case 'mcp-registry': {
      const list = mcpRegistriesFromPayload(spec.payload);
      const isBundle = isMcpRegistryBundle(spec.payload) && list.length > 1;
      const holes: SecretHole[] = [];
      list.forEach((reg, i) => {
        if (reg.authKind === 'bearer') {
          holes.push({
            key: isBundle ? `bearerToken_${i}` : 'bearerToken',
            label: isBundle ? `Bearer token for "${reg.name}"` : 'Bearer token',
            required: true,
            description: `Sent as a bearer token to ${reg.url}. Stored encrypted on the receiving host.`,
          });
        } else if (reg.authKind === 'header') {
          holes.push({
            key: isBundle ? `headerValue_${i}` : 'headerValue',
            label: isBundle
              ? `Value for ${reg.headerName ?? 'the auth header'} (${reg.name})`
              : `Value for ${reg.headerName ?? 'the auth header'}`,
            required: true,
            description: `Sent as the ${reg.headerName ?? 'auth'} header to ${reg.url}. Stored encrypted on the receiving host.`,
          });
        }
      });
      return holes;
    }
    case 'claude-provider':
      return [
        {
          key: 'apiKey',
          label: 'API key',
          required: true,
          description: `Emitted to the ${spec.payload.name} CLI as ANTHROPIC_AUTH_TOKEN for ${spec.payload.baseUrl}. Stored encrypted on the receiving host.`,
        },
      ];
    case 'planner-provider':
      return [
        {
          key: 'apiKey',
          label: 'API key',
          required: false,
          description: `The API key for ${spec.payload.label} (${spec.payload.baseUrl}). Stored encrypted on the receiving host.`,
        },
      ];
  }
}

/**
 * What happened to one host in one provisioning run.
 *
 * Six values rather than ok/failed, because the interesting cases are all in
 * the middle and an operator needs to tell them apart: `skipped` means the
 * ledger already had this host and no overwrite was confirmed, `conflict`
 * means something is already there that this Hub did not put there,
 * `unsupported` means the host's build has no such route, and `failed` means
 * the write was attempted and refused.
 */
export const ProvisioningOutcome = z.enum([
  'provisioned',
  'overwritten',
  'skipped',
  'conflict',
  'unsupported',
  'failed',
]);
export type ProvisioningOutcome = z.infer<typeof ProvisioningOutcome>;

/**
 * One sub-step of a run that did not apply, with the rest still applied.
 *
 * Exists for exactly one real case, and it is not hypothetical: a Pocket Agent
 * template's `disabledTools` is validated against the *receiving host's* live
 * tool catalog, so a host one release behind answers `400` for a tool name it
 * has never heard of. Failing the whole provisioning for that would be wrong —
 * the agent was created and is usable — so the tool is reported here and the
 * run keeps going.
 */
export const ProvisioningItem = z.object({
  label: z.string().min(1).max(200),
  ok: z.boolean(),
  message: z.string().max(400),
});
export type ProvisioningItem = z.infer<typeof ProvisioningItem>;

export const ProvisioningResult = z.object({
  hostId: HubHostId,
  hostLabel: z.string(),
  outcome: ProvisioningOutcome,
  /** Always human-readable, always the answer to "why did this happen". */
  message: z.string(),
  /** The backend's own id for what was written, or null. */
  remoteId: z.string().nullable(),
  items: z.array(ProvisioningItem),
});
export type ProvisioningResult = z.infer<typeof ProvisioningResult>;

/**
 * One ledger row: what this Hub put on which host, and at which revision.
 *
 * `stale` is the whole of "editing a template does not silently change
 * already-provisioned hosts": the edit bumps `HubTemplate.revision`, this row
 * keeps the revision that was actually sent, and the difference is *displayed*
 * rather than acted on. Showing it is what the no-sync model owes an operator
 * in exchange for never correcting drift — without it, "which hosts are
 * behind?" is unanswerable.
 */
export const HubProvisioningEntry = z.object({
  hostId: HubHostId,
  remoteId: z.string().nullable(),
  templateRevision: z.number().int(),
  provisionedAt: z.number().int(),
  lastResult: ProvisioningOutcome,
  stale: z.boolean(),
});
export type HubProvisioningEntry = z.infer<typeof HubProvisioningEntry>;

export const HubTemplate = z.object({
  id: z.string(),
  kind: HubTemplateKind,
  name: TEMPLATE_NAME,
  description: DESCRIPTION,
  /** Bumped on every edit; the ledger records which one a host received. */
  revision: z.number().int(),
  /** Validated against `kind`'s own schema on the way out, not just in. */
  payload: z.unknown(),
  secretHoles: z.array(SecretHole),
  provisionings: z.array(HubProvisioningEntry),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type HubTemplate = z.infer<typeof HubTemplate>;

export const HubTemplateListResponse = z.object({
  templates: z.array(HubTemplate),
});
export type HubTemplateListResponse = z.infer<typeof HubTemplateListResponse>;

export const CreateHubTemplateRequest = z.object({
  kind: HubTemplateKind,
  name: TEMPLATE_NAME,
  description: DESCRIPTION.optional(),
  /** Validated by `parseTemplatePayload` against `kind`, not here — one
      mapping, read by the route and by the editor. */
  payload: z.unknown(),
});
export type CreateHubTemplateRequest = z.infer<typeof CreateHubTemplateRequest>;

/**
 * Partial update. `kind` is deliberately absent: changing it would leave a
 * payload that no longer matches and a ledger pointing at resources of the old
 * kind, and "make a new template" is both clearer and one click.
 */
export const UpdateHubTemplateRequest = z.object({
  name: TEMPLATE_NAME.optional(),
  description: DESCRIPTION.optional(),
  payload: z.unknown().optional(),
});
export type UpdateHubTemplateRequest = z.infer<typeof UpdateHubTemplateRequest>;

export const InstantiateHubTemplateRequest = z.object({
  /** One run may target several hosts; they are provisioned in order. */
  hostIds: z.array(HubHostId).min(1).max(50),
  /**
   * The secret-shaped holes, filled for *this* run.
   *
   * Per host rather than per run would be the more flexible shape, and is
   * deliberately not what this is: the common case is one credential the
   * operator wants on every machine, and a per-host map makes the simple case
   * carry the complex case's ceremony. Provisioning two hosts with different
   * keys is two runs, which is also how the acceptance criterion reads
   * ("per-host secrets entered separately").
   */
  secrets: z.record(z.string().min(1).max(64), z.string().max(8192)).optional(),
  /**
   * Required to overwrite a resource this Hub already provisioned here.
   *
   * Absent or false, an already-provisioned host is `skipped` and **nothing is
   * written** — re-provisioning is never implicit. It also never reaches
   * something this Hub did not put there: that is a `conflict`, and no value
   * of this flag overwrites one.
   */
  overwrite: z.boolean().optional(),
});
export type InstantiateHubTemplateRequest = z.infer<typeof InstantiateHubTemplateRequest>;

export const InstantiateHubTemplateResponse = z.object({
  results: z.array(ProvisioningResult),
});
export type InstantiateHubTemplateResponse = z.infer<typeof InstantiateHubTemplateResponse>;
