import { z } from 'zod';
import { EffortLevel } from './agent-events.js';
import { LIMITS } from './limits.js';
import { CronWorktreeMode } from './cron.js';
import { HubHostId } from './hub-registry.js';

/**
 * Inbound webhooks: an outside system starting agent work.
 *
 * The downstream half is the same as a scheduled job — one spec, one prompt, one
 * structured session — and both go through `runs/executor.ts`. What differs is
 * the trigger, and everything unusual in this file follows from it arriving from
 * outside the trust boundary carrying text a stranger wrote.
 */

/** Extensible by design: a second provider adds a member, not a new shape. */
export const WebhookType = z.enum(['jira', 'bamboo']);
export type WebhookType = z.infer<typeof WebhookType>;

/**
 * `hmac` proves the body came from someone holding the secret. `bearer` proves
 * only that the sender holds a token, authenticates nothing about the payload,
 * and rides in a header into every proxy log — it exists for senders that
 * cannot sign, and is never the default.
 */
export const WebhookAuthMode = z.enum(['hmac', 'bearer']);
export type WebhookAuthMode = z.infer<typeof WebhookAuthMode>;

/**
 * `per-delivery` mirrors a cron run exactly: one delivery, one fresh
 * conversation, one turn. `per-issue` resumes the conversation keyed on the
 * issue, so the agent already knows the issue's history — at the cost of a
 * transcript that grows for as long as people keep editing that ticket.
 */
export const WebhookConversationMode = z.enum(['per-delivery', 'per-issue']);
export type WebhookConversationMode = z.infer<typeof WebhookConversationMode>;

/**
 * What to do when another agent is mid-turn in the working tree a delivery
 * would run in (PA-11).
 *
 * Deliberately separate from `overlapPolicy`, which asks a different question:
 * that one is scoped to *this webhook's own conversation*, while a directory
 * can be occupied by another webhook entirely, by a scheduled job, or by a
 * human typing in a chat. One field could not express both, and folding them
 * would silently change what `skip` means.
 *
 * `queue` holds the delivery until the tree is free — it loses no work, it only
 * delays it. `allow` is the old behaviour, which was never a considered choice:
 * before this existed, nothing checked at all. The editor warns on `allow`
 * rather than refusing it, since two read-only runs in one directory is a
 * legitimate thing to want.
 */
export const WebhookDirectoryPolicy = z.enum(['queue', 'allow']);
export type WebhookDirectoryPolicy = z.infer<typeof WebhookDirectoryPolicy>;

/**
 * As `CronOverlapPolicy`, plus `queue`.
 *
 * Webhook-only: queueing a *cron* firing is a different question, tangled up
 * with the scheduler's deliberate refusal to catch up on a backlog (a week
 * offline would otherwise queue 168 hourly runs), so `CronOverlapPolicy` is
 * left alone. A superset, so every stored value still parses.
 */
export const WebhookOverlapPolicy = z.enum(['skip', 'allow', 'queue']);
export type WebhookOverlapPolicy = z.infer<typeof WebhookOverlapPolicy>;

/**
 * PA-170: how a webhook handles a project or plan key that has no explicit
 * `projectMap` / `planMap` row.
 *
 * - `off`: never consults detected routes (the default for existing webhooks on
 *   upgrade, so nothing changes silently).
 * - `suggest`: filters an unmapped key as today, carrying the detected folder
 *   and evidence in `reason` so a human can Accept (writing an explicit map
 *   row) or Dismiss. Default for new webhooks.
 * - `auto`: routes an *unambiguous* match automatically, recording
 *   `"auto-routed via <source>: …"` on the delivery row; anything ambiguous or
 *   weaker falls back to `suggest`.
 */
export const WebhookAutoRoute = z.enum(['off', 'suggest', 'auto']);
export type WebhookAutoRoute = z.infer<typeof WebhookAutoRoute>;

export const WebhookRouteSource = z.enum(['git-history', 'history', 'jira-dev-info', 'fleet']);
export type WebhookRouteSource = z.infer<typeof WebhookRouteSource>;

export const WebhookRouteConfidence = z.enum(['unambiguous', 'ambiguous']);
export type WebhookRouteConfidence = z.infer<typeof WebhookRouteConfidence>;

export const WebhookRouteCacheEntry = z.object({
  webhookId: z.string(),
  routeKey: z.string(),
  hostId: z.string().nullable(),
  cwd: z.string(),
  workspaceLabel: z.string(),
  source: WebhookRouteSource,
  confidence: WebhookRouteConfidence,
  evidence: z.string(),
  detectedAt: z.number().int(),
  confirmedAt: z.number().int().nullable(),
  confirmedBy: z.string().nullable(),
  dismissedAt: z.number().int().nullable().optional(),
});
export type WebhookRouteCacheEntry = z.infer<typeof WebhookRouteCacheEntry>;

/**
 * Validated Jira project key: uppercase letters/digits/underscores, 1-16 chars,
 * starting with a letter.
 */
export const JIRA_PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{0,15}$/;

export const AcceptWebhookRouteRequest = z.object({
  cwd: z.string().min(1).max(4096).optional(),
});
export type AcceptWebhookRouteRequest = z.infer<typeof AcceptWebhookRouteRequest>;

/**
 * More statuses than a cron run has, because most deliveries never become runs.
 *
 * `rejected` auth failed · `invalid` authentic but unusable · `duplicate` body
 * already seen · `filtered` matched no filter · `throttled` over a concurrency
 * cap or a full queue · `skipped` refused by the overlap policy, or cancelled
 * out of the queue by a human · `queued` waiting for another agent to finish in
 * the same working tree · then the run's own four, identical to `CronRunStatus`.
 *
 * `queued` is the only non-terminal status that is not also *running*: it holds
 * no session, so it counts against neither the concurrency caps nor the
 * "force-fail whatever a dead server left open" pass at boot. See
 * `QUEUED_DELIVERY` in the server's `db/index.ts` for the three predicates that
 * had to learn about it.
 */
export const WebhookDeliveryStatus = z.enum([
  'rejected',
  'invalid',
  'duplicate',
  'filtered',
  'throttled',
  'skipped',
  'queued',
  'starting',
  'running',
  'succeeded',
  'failed',
]);
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatus>;

/**
 * `retry` (PA-125) is a human re-running a stored payload from the history
 * panel. Deliveries travel over HTTP only and the browser does not schema-parse
 * them, so the new value needed no `PROTOCOL_VERSION` bump.
 */
export const WebhookDeliveryTrigger = z.enum(['delivery', 'test', 'retry']);
export type WebhookDeliveryTrigger = z.infer<typeof WebhookDeliveryTrigger>;

/** `skipped` is what a `test` delivery records: authentic by construction. */
export const WebhookSignatureState = z.enum(['valid', 'invalid', 'missing', 'skipped']);
export type WebhookSignatureState = z.infer<typeof WebhookSignatureState>;

/**
 * The URL segment. Lowercase, 1–64 chars, no leading or trailing hyphen.
 *
 * Exported so the editor validates exactly what the route accepts — the same
 * argument that keeps the cron solver in this package. No dots (avoids
 * extension sniffing), no underscores (visually ambiguous in a URL), and
 * uppercase is *rejected* rather than silently lowercased, so the URL you typed
 * is the URL you got.
 */
export const WEBHOOK_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Slugs that would collide with a UI route or a future endpoint under the same
 * namespace. Small, and free to keep.
 */
export const WEBHOOK_RESERVED_SLUGS: readonly string[] = [
  'new',
  'edit',
  'test',
  'preview',
  'health',
  'api',
  'hooks',
  'webhooks',
  'deliveries',
  'secret',
];

const Name = z.string().min(1).max(64);

/**
 * Which deliveries actually run.
 *
 * Every field means "no constraint" when absent or empty, which is the footgun
 * of the whole feature — an empty filter starts an agent for every issue event
 * in every project the Jira user can see. The editor says so out loud.
 *
 * Semantics: OR within a category, AND across categories. Names compare
 * case-insensitively; project keys are upper-cased on both sides. `excludeActors`
 * is the one category that runs the other way — see its own doc comment.
 *
 * `changedFields` deliberately does **not** match `jira:issue_created`, which
 * carries no changelog. "Notify me when status changes" firing on creation is
 * the classic surprise, so the non-match is the documented behaviour rather
 * than a special case.
 *
 * No `.default()` on `labelMode`: this schema is reached through `.partial()`
 * for updates, and `.partial()` does not strip a default — it would silently
 * reset the mode on any PATCH that omitted it.
 */
export const JiraWebhookFilter = z.object({
  events: z.array(z.string().min(1).max(64)).max(20).optional(),
  projectKeys: z.array(z.string().min(1).max(32)).max(50).optional(),
  issueTypes: z.array(Name).max(30).optional(),
  changedFields: z.array(Name).max(30).optional(),
  /**
   * Compared against the issue's assignee display name, case-insensitively.
   * Matched the same way `labels`/`issueTypes` are — free text, not an
   * account id — because the filter has no Jira credentials of its own to
   * resolve a name to one. An unassigned issue never matches a non-empty
   * list; there is deliberately no separate "(unassigned)" sentinel value to
   * type, since an assignee list is opt-in and empty already means "anyone,
   * including nobody".
   */
  assignees: z.array(Name).max(30).optional(),
  /**
   * The cheapest real control this feature has. "Only run when the issue is
   * labelled `agent-ready`" narrows the trigger population from "anyone who can
   * comment on a ticket" to "anyone who can set a label on this project" — in
   * most Jira instances a dramatically smaller and more trusted set.
   */
  labels: z.array(Name).max(30).optional(),
  labelMode: z.enum(['any', 'all']).optional(),
  /**
   * The one field in this schema that inverts the whole file's semantics: every
   * other field is an allow-list ("must be one of these"), and this is a
   * block-list ("must not be any of these"). It exists for one concrete
   * problem — an agent that comments on the issue it was triggered by re-fires
   * `comment_created` for its own comment, and without something deterministic
   * here the only thing stopping a loop is the agent itself *noticing* and
   * choosing not to act again, which is a judgment call, not a guarantee.
   * Listing the agent's own Jira account display name here makes the refusal
   * structural instead. Matched against `actor` case-insensitively, like every
   * other name field; a `null` actor (a payload shape that omits `user`) is
   * never excluded, since there is nothing to compare against — the same
   * "cannot prove a negative" posture `eq()` already has everywhere else.
   */
  excludeActors: z.array(Name).max(30).optional(),
});
export type JiraWebhookFilter = z.infer<typeof JiraWebhookFilter>;

/**
 * One row of "issues in this Jira project go to this directory".
 *
 * Deliberately just a directory: agent, worktree mode, model and effort stay
 * the webhook's single configured values no matter which row matched — a
 * per-project override of *those* would make one webhook behave like several
 * independent ones with no independent history, secret or cap. `cwd` is
 * validated through workspace containment at the route, exactly like the
 * webhook's own top-level `cwd`.
 */
export const JiraProjectMapEntry = z.object({
  projectKey: z.string().min(1).max(32),
  cwd: z.string().min(1).max(4096),
  /**
   * PA-171: run this project on *another* agent server, by its Hub host id.
   * Absent means this server, so every row written before the field existed is
   * unchanged. A remote `cwd` is not containment-checked here — this server
   * cannot see that machine's folders — but re-resolved by the target's own
   * `start_session` against its own workspace folders, which refuses anything
   * outside them.
   */
  hostId: HubHostId.optional(),
});
export type JiraProjectMapEntry = z.infer<typeof JiraProjectMapEntry>;

/**
 * One row pairing an issue type with a specific prompt template.
 *
 * `issueType` can be "All type" / "*" (fallback rule) or a specific Jira issue
 * type name like "Bug", "Story", "Task", "Incident", etc.
 */
export const JiraPromptTemplateMapEntry = z.object({
  issueType: z.string().min(1).max(64),
  promptTemplate: z.string().min(1).max(LIMITS.maxInputChars),
});
export type JiraPromptTemplateMapEntry = z.infer<typeof JiraPromptTemplateMapEntry>;

/**
 * Which Bamboo build deliveries actually run — same philosophy as
 * `JiraWebhookFilter`: every field means "no constraint" when absent or
 * empty, OR within a category, AND across categories. `planKeys` compare
 * case-insensitively, upper-cased on both sides, like Jira's `projectKeys`.
 *
 * `excludeTriggerReasons` mirrors `excludeActors` — a block-list rather than
 * an allow-list — for the same loop-prevention reason: an agent that pushes a
 * fix can retrigger the very plan that started it.
 */
export const BambooWebhookFilter = z.object({
  planKeys: z.array(z.string().min(1).max(32)).max(50).optional(),
  buildStates: z.array(z.enum(['Successful', 'Failed', 'Unknown'])).max(3).optional(),
  notificationTypes: z.array(z.string().min(1).max(64)).max(20).optional(),
  excludeTriggerReasons: z.array(Name).max(30).optional(),
});
export type BambooWebhookFilter = z.infer<typeof BambooWebhookFilter>;

/**
 * One row of "builds of this plan go to this directory" — the Bamboo
 * equivalent of `JiraProjectMapEntry`, keyed on plan key instead of project
 * key for the same reason: a plan key is the one field Bamboo always sends
 * that identifies where the code being built actually lives.
 */
export const BambooPlanMapEntry = z.object({
  planKey: z.string().min(1).max(32),
  cwd: z.string().min(1).max(4096),
  /** PA-171: as `JiraProjectMapEntry.hostId`. */
  hostId: HubHostId.optional(),
});
export type BambooPlanMapEntry = z.infer<typeof BambooPlanMapEntry>;

/**
 * One row pairing a build state with a specific prompt template.
 *
 * `buildState` can be "All states" / "*" (fallback rule) or a specific value
 * (`Successful`, `Failed`, `Unknown`) — the Bamboo equivalent of
 * `JiraPromptTemplateMapEntry.issueType`.
 */
export const BambooPromptTemplateMapEntry = z.object({
  buildState: z.string().min(1).max(64),
  promptTemplate: z.string().min(1).max(LIMITS.maxInputChars),
});
export type BambooPromptTemplateMapEntry = z.infer<typeof BambooPromptTemplateMapEntry>;

/**
 * Discriminated on `type` so a second provider is purely additive.
 *
 * A discriminated union cannot be `.partial()`-ed, so a PATCH replaces `config`
 * wholesale rather than merging into it. That is the better semantic anyway: a
 * half-updated filter is more surprising than one the client re-sends complete.
 *
 * `projectMap` defaults to `[]`, meaning "no routing configured" — every
 * delivery runs in the webhook's own `cwd`, exactly as before this field
 * existed. Once it is non-empty, a delivery for a project key that is not in
 * it is filtered rather than falling back to `cwd`: routing by project and
 * "one of these projects wasn't set up yet" are different situations, and
 * silently running the wrong project in the wrong checkout is worse than
 * declining and saying which project had no mapping. Uniqueness of
 * `projectKey` across rows is checked in the route, not here — this schema
 * intentionally carries no `.refine()`, for the same two reasons
 * `WebhookFields` below gives.
 *
 * `promptTemplateMap` defaults to `[]`. When populated, incoming issues match
 * against mapped issue types before falling back to "All type" / top-level template.
 */
export const WebhookConfig = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('jira'),
    filter: JiraWebhookFilter,
    projectMap: z.array(JiraProjectMapEntry).max(50).default([]),
    promptTemplateMap: z.array(JiraPromptTemplateMapEntry).max(50).default([]),
  }),
  /**
   * `planMap`/`promptTemplateMap` follow `projectMap`'s rule exactly: empty
   * means "no routing, everything runs in the webhook's own `cwd`"; once
   * non-empty, an unmapped plan is filtered rather than falling back, because
   * "unrouted" and "nobody set this plan up yet" are different situations.
   */
  z.object({
    type: z.literal('bamboo'),
    filter: BambooWebhookFilter,
    planMap: z.array(BambooPlanMapEntry).max(50).default([]),
    promptTemplateMap: z.array(BambooPromptTemplateMapEntry).max(50).default([]),
  }),
]);
export type WebhookConfig = z.infer<typeof WebhookConfig>;

/**
 * Every editable field, with no `.default()` and no refinement.
 *
 * The same split — and the same two Zod traps — that `cron.ts` documents:
 * `.refine()` returns a `ZodEffects` with no `.partial()`, and `.partial()`
 * applies defaults rather than removing them, so a PATCH omitting a key would
 * reset it. Defaults therefore live only on `CreateWebhookRequest`.
 *
 * This schema goes further than cron's and uses **no `.refine()` at all**, so
 * both traps are avoided outright and `UpdateWebhookRequest` is a plain
 * `.partial()`. The two cross-field rules live in the route instead, where they
 * can say something useful: slug uniqueness and reserved names need the
 * database, and "this agent has no structured transport" needs the registry.
 *
 * Note what is absent. No `transport`: a webhook run is always structured, for
 * the same reason a cron run is — nobody is there to type at a terminal. No
 * `cols`/`rows`. No `secret` or `token`: the server generates both, because a
 * client-chosen webhook secret is a weak secret.
 */
const WebhookFields = z
  .object({
    name: z.string().min(1).max(128),
    /** Omitted on create means "derive one from the name". */
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(WEBHOOK_SLUG_RE, {
        message: 'Use 1–64 lowercase letters, digits and hyphens, not starting or ending with a hyphen.',
      }),
    enabled: z.boolean(),
    config: WebhookConfig,
    authMode: WebhookAuthMode,
    cwd: z.string().min(1).max(4096),
    /**
     * PA-171: the host the top-level `cwd` (the fallback when no map row
     * matches) lives on. `null` means this server. Nullable rather than
     * optional so a PATCH can move the target back to local.
     */
    hostId: HubHostId.nullable(),
    /**
     * A coding-agent id from the server's `AgentRegistry` (`claude`, `codex`,
     * …), **or** a Pocket Agent as `pocket:<plannerWorkspaceId>` — see
     * `POCKET_AGENT_ID_PREFIX` in `planner.ts` for why PA-10 widened this one
     * string instead of adding a discriminator beside it.
     *
     * Still just a bounded string here: which coding agents exist lives in the
     * registry and which Pocket Agents exist lives in `planner_workspaces`, so
     * neither is expressible in a schema. Both are checked in the route.
     */
    agent: z.string().min(1).max(64),
    worktreeMode: CronWorktreeMode,
    /**
     * Nullable, not merely optional: absence in a PATCH means "leave it alone",
     * so without an explicit `null` a model could never be cleared once set.
     */
    model: z.string().min(1).max(200).nullable(),
    effort: EffortLevel.nullable(),
    skipPermissions: z.boolean(),
    autoSelectAgentModel: z.boolean(),
    promptTemplate: z.string().min(1).max(LIMITS.maxInputChars),
    conversationMode: WebhookConversationMode,
    overlapPolicy: WebhookOverlapPolicy,
    directoryPolicy: WebhookDirectoryPolicy,
    autoRoute: WebhookAutoRoute,
    /**
     * PA-39: let a single delivery override `directoryPolicy` to `allow` by
     * carrying the bare Jira label `skip-queue` (`JIRA_SKIP_QUEUE_LABEL`).
     *
     * Off by default, like every other override of a safety default in this
     * file (`skipPermissions`, `directoryPolicy` itself) — a label any project
     * member (or, on a Service Desk project, an anonymous customer) can attach
     * must not silently change delivery behaviour until an operator opts a
     * specific webhook into honouring it. Jira-only: `BambooEventFacts` has no
     * `labels` field, so the editor hides this for a Bamboo webhook and the
     * server ignores it for one regardless of how it is stored.
     */
    skipQueueLabelEnabled: z.boolean(),
    /**
     * The Jira display name this webhook's own comments are posted under —
     * the account behind whatever Jira credential actually posts them. Used
     * only to assemble `{{comment.body}}` (`assembleCommentThread` in
     * `webhook-template.ts`): a comment whose author matches this is the
     * agent's own past words and is shown as a short preview rather than in
     * full, so a multi-round thread stays readable without an agent needing
     * a separate MCP call just to see what is already in the ticket.
     *
     * Blank means "unknown" — the safe default, since nothing gets trimmed
     * rather than guessing wrong and hiding text a human wrote. Jira-only,
     * exactly like `skipQueueLabelEnabled`: the editor hides this for a
     * Bamboo webhook (which has no comment concept at all) and the server
     * ignores it for one regardless of how it is stored.
     */
    agentIdentity: z.string().max(200),
    /** Runs this webhook may have going at once. The global cap still applies. */
    maxConcurrent: z.number().int().min(1).max(10),
    /** Keep raw payloads for debugging. Bounded and scrubbed regardless. */
    storePayloads: z.boolean(),
  })
  .partial({
    slug: true,
    model: true,
    effort: true,
    hostId: true,
  });

export const CreateWebhookRequest = WebhookFields.extend({
  enabled: z.boolean().default(true),
  hostId: HubHostId.nullable().default(null),
  authMode: WebhookAuthMode.default('hmac'),
  worktreeMode: CronWorktreeMode.default('none'),
  conversationMode: WebhookConversationMode.default('per-delivery'),
  overlapPolicy: WebhookOverlapPolicy.default('skip'),
  directoryPolicy: WebhookDirectoryPolicy.default('queue'),
  autoRoute: WebhookAutoRoute.default('suggest'),
  maxConcurrent: z.number().int().min(1).max(10).default(2),
  storePayloads: z.boolean().default(true),
  /**
   * No `.default()` here, unlike before this field had a second provider:
   * `DEFAULT_JIRA_PROMPT_TEMPLATE` is Jira-specific, and a `.default()` cannot
   * see the sibling `config.type` to pick between it and
   * `DEFAULT_BAMBOO_PROMPT_TEMPLATE`. The route applies the type-appropriate
   * default when this is omitted, exactly like `specFrom` already resolves
   * other cross-field concerns (slug derivation, agent-transport checks) that
   * a schema alone cannot express.
   */
  promptTemplate: z.string().min(1).max(LIMITS.maxInputChars).optional(),
  /**
   * Defaults to **false**, unlike `CreateCronJobRequest.skipPermissions`.
   *
   * A scheduled job's inverted default rests on two things: nobody is awake at
   * 3am, which transfers, and the operator wrote the prompt, which does not. A
   * webhook's prompt is built partly from text an issue reporter typed — in a
   * Service Desk project, possibly an anonymous customer. Inheriting cron's
   * inversion would be exactly the quiet default flip CLAUDE.md's first
   * invariant forbids, on the one code path where the prompt is partly written
   * by a stranger.
   *
   * Turning it on is a deliberate act. When it is on the editor warns more
   * strongly than cron's does, `Webhook.skipPermissionsEnabled` is surfaced
   * persistently, and the value is copied onto every delivery row at delivery
   * time so turning it off later does not retroactively make past bypassed
   * deliveries look supervised.
   */
  skipPermissions: z.boolean().default(false),
  autoSelectAgentModel: z.boolean().default(false),
  skipQueueLabelEnabled: z.boolean().default(false),
  agentIdentity: z.string().max(200).default(''),
});
export type CreateWebhookRequest = z.infer<typeof CreateWebhookRequest>;

export const UpdateWebhookRequest = WebhookFields.partial();
export type UpdateWebhookRequest = z.infer<typeof UpdateWebhookRequest>;

/** Counts for the delivery-history header, so the noise is legible at a glance. */
export const WebhookDeliveryCounts = z.object({
  total: z.number().int(),
  ran: z.number().int(),
  filtered: z.number().int(),
  rejected: z.number().int(),
  /** Waiting on a working tree right now — work that has not happened yet. */
  queued: z.number().int(),
});
export type WebhookDeliveryCounts = z.infer<typeof WebhookDeliveryCounts>;

export const Webhook = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  enabled: z.boolean(),
  type: WebhookType,
  /**
   * The path to POST to — `/api/hooks/<slug>`, never an absolute URL.
   *
   * The server genuinely cannot know its own external origin: the bind is
   * loopback by default and `Host`/`X-Forwarded-Host` are attacker-supplied
   * claims. A server-composed URL would be a guess presented as a fact, and a
   * wrong one sends the user to debug Jira for an hour. The browser composes the
   * origin and labels which one it used.
   */
  deliveryPath: z.string(),
  authMode: WebhookAuthMode,
  /** Whether a bearer token has been generated. Never the token itself. */
  hasToken: z.boolean(),
  /** When the secret was last generated or rotated. Never the secret itself. */
  secretSetAt: z.number().int(),
  config: WebhookConfig,
  cwd: z.string(),
  workspaceLabel: z.string(),
  /** PA-171: the host the top-level `cwd` is on; `null` = this server. */
  hostId: HubHostId.nullable(),
  agent: z.string(),
  agentDisplayName: z.string(),
  worktreeMode: CronWorktreeMode,
  model: z.string().nullable(),
  /**
   * Absent means "whatever was cached for this agent"; explicit `null` means
   * "the model's own default". A read DTO has to expose all three states or a
   * PATCH cannot round-trip what it read.
   */
  effort: EffortLevel.nullable().optional(),
  skipPermissionsEnabled: z.boolean(),
  autoSelectAgentModel: z.boolean(),
  promptTemplate: z.string(),
  conversationMode: WebhookConversationMode,
  overlapPolicy: WebhookOverlapPolicy,
  directoryPolicy: WebhookDirectoryPolicy,
  autoRoute: WebhookAutoRoute,
  routeCache: z.array(WebhookRouteCacheEntry).optional(),
  skipQueueLabelEnabled: z.boolean(),
  agentIdentity: z.string(),
  maxConcurrent: z.number().int(),
  storePayloads: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /**
   * Null until the first delivery arrives — and that null is load-bearing
   * information, not an empty state to hide. Nothing can prove Jira is able to
   * reach this server; a received delivery is the only evidence, so its absence
   * is what the UI shows.
   */
  lastDeliveryAt: z.number().int().nullable(),
  lastDeliveryStatus: WebhookDeliveryStatus.nullable(),
  lastError: z.string().nullable(),
  deliveryCounts: WebhookDeliveryCounts,
});
export type Webhook = z.infer<typeof Webhook>;

export const WebhookRouteDetectResponse = z.object({
  entries: z.array(WebhookRouteCacheEntry),
});
export type WebhookRouteDetectResponse = z.infer<typeof WebhookRouteDetectResponse>;

/**
 * The one response that carries the secret.
 *
 * "Shown once" is imported from password UX, where it follows from storing a
 * hash. HMAC needs the plaintext server-side, so the database holds it either
 * way and the server can always re-display it — pretending otherwise buys
 * nothing and costs the user their afternoon. So it is returned at creation and
 * from an explicit, rate-limited, logged reveal, and never from a list or get.
 */
export const WebhookCreatedResponse = z.object({
  webhook: Webhook,
  secret: z.string(),
  /** Present only when `authMode` is `'bearer'`. */
  token: z.string().optional(),
});
export type WebhookCreatedResponse = z.infer<typeof WebhookCreatedResponse>;

export const WebhookSecretResponse = z.object({
  secret: z.string(),
  token: z.string().optional(),
  secretSetAt: z.number().int(),
});
export type WebhookSecretResponse = z.infer<typeof WebhookSecretResponse>;

/** PA-171: a remote run's last reported state while its delivery is open. */
export const WebhookRemoteState = z.enum(['queued', 'running', 'awaiting_approval']);
export type WebhookRemoteState = z.infer<typeof WebhookRemoteState>;

export const WebhookDelivery = z.object({
  id: z.string(),
  webhookId: z.string().nullable(),
  webhookName: z.string(),
  agent: z.string(),
  status: WebhookDeliveryStatus,
  trigger: WebhookDeliveryTrigger,
  signatureState: WebhookSignatureState,
  event: z.string().nullable(),
  eventType: z.string().nullable(),
  issueKey: z.string().nullable(),
  projectKey: z.string().nullable(),
  actor: z.string().nullable(),
  /** Why it did not run, in words a human can act on. */
  reason: z.string().nullable(),
  /** What this delivery ran with, copied at delivery time. */
  skipPermissionsEnabled: z.boolean(),
  /**
   * PA-39: whether this delivery actually bypassed the directory queue
   * because it carried the `skip-queue` label and its webhook had opted in.
   * `false` for the overwhelming majority of deliveries — including one from
   * a webhook whose `directoryPolicy` was already `allow`, where the label
   * would have been a no-op — so this field only ever means "the label is
   * why this one ran ahead of a busy directory."
   */
  queueSkippedByLabel: z.boolean(),
  payloadBytes: z.number().int(),
  payloadTruncated: z.boolean(),
  receivedAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
  sessionId: z.string().nullable(),
  agentSessionId: z.string().nullable(),
  /**
   * PA-10: the Pocket Agent chat this delivery ran in, when its agent was a
   * Pocket Agent rather than a coding agent.
   *
   * Mutually exclusive with `sessionId`/`agentSessionId` in practice — a pocket
   * run creates no session at all — and it is what the delivery row links to
   * (`#/planner/<id>`), so a pocket delivery is as inspectable as a coding one.
   * Non-null is therefore also the honest client-side test for "this was a
   * pocket run", which is why the UI does not need `agent` parsed a second time.
   */
  plannerChatId: z.string().nullable(),
  cwd: z.string().nullable(),
  error: z.string().nullable(),
  /** When this delivery was parked on a working tree. Null if it never queued. */
  queuedAt: z.number().int().nullable(),
  /**
   * 1-based place in line while `status` is `queued`, else null.
   *
   * Derived from the live queue rather than stored: a position is a fact about
   * the other rows, so persisting it would mean rewriting every waiter's row
   * each time one is granted or cancelled.
   */
  queuePosition: z.number().int().nullable(),
  /** The working tree this delivery is waiting on. Null if it never queued. */
  queueKey: z.string().nullable(),
  /** PA-125: the delivery this one re-ran, when `trigger` is `retry`. */
  retryOf: z.string().nullable(),
  /**
   * PA-125: why this delivery cannot be retried, or null if it can. Computed by
   * the server's one rule (`retryProblem`) so the button's disabled state and
   * the route's 409 cannot disagree — the browser has no other way to know
   * whether a payload was stored, since the list never carries it.
   */
  retryProblem: z.string().nullable(),
  /** PA-170: unconfirmed route suggestion when this delivery was filtered for an unmapped key. */
  routeSuggestion: WebhookRouteCacheEntry.nullable().optional(),
  /**
   * PA-171: the host this delivery was dispatched to through the Hub, or null
   * for a run on this server. When set, `sessionId` / `plannerChatId` are ids
   * *on that host*, and the transcript is reached through the Hub at
   * `#/h/<remoteHostId>/s/<id>` (or `/planner/<id>`).
   */
  remoteHostId: z.string().nullable(),
  /** PA-171: `session:<id>` or `chat:<id>` on `remoteHostId`, exactly as the Hub returned it. */
  remoteRef: z.string().nullable(),
  /**
   * PA-171: what the last Hub `wait` reported while the delivery is `running`:
   * `queued` (behind another run in that host's working tree), `awaiting_approval`
   * (a human must answer on that host), or `running`. Null once settled, and
   * for a local run.
   */
  remoteState: WebhookRemoteState.nullable(),
});
export type WebhookDelivery = z.infer<typeof WebhookDelivery>;

/**
 * PA-125: delivery statuses a human may re-run. A delivery that never reached
 * the run (`throttled` by a cap, `skipped` by the overlap policy) or one that
 * ran and `failed`. Not `rejected`/`invalid` (never authenticated or parsed),
 * not `filtered`/`duplicate` (they did what they should), and never anything
 * still in flight. One list, read by the route and the button alike.
 */
export const RETRYABLE_DELIVERY_STATUSES: readonly WebhookDeliveryStatus[] = [
  'failed',
  'throttled',
  'skipped',
];

/** One delivery in full, for the detail view. Payload only when it was stored. */
export const WebhookDeliveryDetail = WebhookDelivery.extend({
  payload: z.string().nullable(),
  renderedPrompt: z.string().nullable(),
});
export type WebhookDeliveryDetail = z.infer<typeof WebhookDeliveryDetail>;

export const WebhookListResponse = z.object({ webhooks: z.array(Webhook) });
export type WebhookListResponse = z.infer<typeof WebhookListResponse>;

export const WebhookDeliveryListResponse = z.object({
  deliveries: z.array(WebhookDelivery),
  counts: WebhookDeliveryCounts,
});
export type WebhookDeliveryListResponse = z.infer<typeof WebhookDeliveryListResponse>;

/**
 * A call to `/api/hooks/:slug` that matched no runnable webhook.
 *
 * `unknown_slug`: no webhook has this path at all. `disabled`: the webhook
 * exists but is turned off. The two are one indistinguishable HTTP response
 * by design — see the "unknown slug, disabled webhook and bad signature are
 * one response" invariant — this type exists purely for an operator to look
 * at server-side; it never reaches or is influenced by the caller.
 */
export const WebhookHitReason = z.enum(['unknown_slug', 'disabled']);
export type WebhookHitReason = z.infer<typeof WebhookHitReason>;

export const WebhookHit = z.object({
  id: z.string(),
  slug: z.string(),
  /** Set only for `reason: 'disabled'` — there is no webhook for the other case. */
  webhookId: z.string().nullable(),
  webhookName: z.string().nullable(),
  reason: WebhookHitReason,
  receivedAt: z.number().int(),
});
export type WebhookHit = z.infer<typeof WebhookHit>;

/**
 * One chronological feed across every webhook: real deliveries and the hits
 * that never became one, discriminated so the UI can render either without
 * a runtime type check. `webhookId`/`webhookName` are visible on both members
 * (`WebhookDelivery` already carries them), which is what lets a single list
 * answer "which webhook did this call match, or did it match none at all".
 */
export const WebhookHistoryEntry = z.discriminatedUnion('kind', [
  WebhookDelivery.extend({ kind: z.literal('delivery') }),
  WebhookHit.extend({ kind: z.literal('hit') }),
]);
export type WebhookHistoryEntry = z.infer<typeof WebhookHistoryEntry>;

export const WebhookHistoryResponse = z.object({
  entries: z.array(WebhookHistoryEntry),
});
export type WebhookHistoryResponse = z.infer<typeof WebhookHistoryResponse>;

/** Body for `POST /api/webhooks/:id/test` and `.../preview`. */
export const WebhookTestRequest = z.object({
  /** Raw JSON to run through the pipeline. Omitted uses the built-in sample. */
  payload: z.string().max(256 * 1024).optional(),
  /** Preview only: try this template instead of the saved one. */
  promptTemplate: z.string().max(LIMITS.maxInputChars).optional(),
});
export type WebhookTestRequest = z.infer<typeof WebhookTestRequest>;

export const WebhookPreviewResponse = z.object({
  prompt: z.string(),
  missing: z.array(z.string()),
  truncated: z.boolean(),
  /** Null when the sample or payload matched the filter and would have run. */
  filteredReason: z.string().nullable(),
});
export type WebhookPreviewResponse = z.infer<typeof WebhookPreviewResponse>;

/**
 * The slim shape `ProjectInfo` embeds so the home screen can show a webhook row
 * before it has ever received anything.
 *
 * Alongside `cronJobs` rather than folded into `chats`, and for a sharper
 * version of the same reason: a webhook is a spec, not a conversation, and
 * "configured but never fired" is a webhook's most likely steady state — so a
 * surface that only appeared after the first delivery would hide exactly the
 * case that needs attention.
 */
export const WebhookSummary = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  type: WebhookType,
  /** Pre-composed, e.g. `Jira issue events · ENG, PLAT` or `Bamboo · Failed · EM-EM`. */
  triggerLabel: z.string(),
  lastDeliveryAt: z.number().int().nullable(),
  lastDeliveryStatus: WebhookDeliveryStatus.nullable(),
  skipPermissionsEnabled: z.boolean(),
});
export type WebhookSummary = z.infer<typeof WebhookSummary>;
