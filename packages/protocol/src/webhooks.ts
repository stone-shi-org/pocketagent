import { z } from 'zod';
import { EffortLevel } from './agent-events.js';
import { LIMITS } from './limits.js';
import { CronOverlapPolicy, CronWorktreeMode } from './cron.js';
import { DEFAULT_JIRA_PROMPT_TEMPLATE } from './webhook-template.js';

/**
 * Inbound webhooks: an outside system starting agent work.
 *
 * The downstream half is the same as a scheduled job — one spec, one prompt, one
 * structured session — and both go through `runs/executor.ts`. What differs is
 * the trigger, and everything unusual in this file follows from it arriving from
 * outside the trust boundary carrying text a stranger wrote.
 */

/** Extensible by design: a second provider adds a member, not a new shape. */
export const WebhookType = z.enum(['jira']);
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
 * More statuses than a cron run has, because most deliveries never become runs.
 *
 * `rejected` auth failed · `invalid` authentic but unusable · `duplicate` body
 * already seen · `filtered` matched no filter · `throttled` over a concurrency
 * cap · `skipped` refused by the overlap policy · then the run's own four,
 * identical to `CronRunStatus`.
 */
export const WebhookDeliveryStatus = z.enum([
  'rejected',
  'invalid',
  'duplicate',
  'filtered',
  'throttled',
  'skipped',
  'starting',
  'running',
  'succeeded',
  'failed',
]);
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatus>;

export const WebhookDeliveryTrigger = z.enum(['delivery', 'test']);
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
 * case-insensitively; project keys are upper-cased on both sides.
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
});
export type JiraProjectMapEntry = z.infer<typeof JiraProjectMapEntry>;

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
 */
export const WebhookConfig = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('jira'),
    filter: JiraWebhookFilter,
    projectMap: z.array(JiraProjectMapEntry).max(50).default([]),
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
    agent: z.string().min(1).max(64),
    worktreeMode: CronWorktreeMode,
    /**
     * Nullable, not merely optional: absence in a PATCH means "leave it alone",
     * so without an explicit `null` a model could never be cleared once set.
     */
    model: z.string().min(1).max(200).nullable(),
    effort: EffortLevel.nullable(),
    skipPermissions: z.boolean(),
    promptTemplate: z.string().min(1).max(LIMITS.maxInputChars),
    conversationMode: WebhookConversationMode,
    overlapPolicy: CronOverlapPolicy,
    /** Runs this webhook may have going at once. The global cap still applies. */
    maxConcurrent: z.number().int().min(1).max(10),
    /**
     * Collapse a burst on one issue into a single run. Only meaningful for
     * `per-issue`, where a chatty automation rule would otherwise append turn
     * after turn to one conversation, each paying for the whole history.
     */
    debounceSeconds: z.number().int().min(0).max(3600),
    /** Keep raw payloads for debugging. Bounded and scrubbed regardless. */
    storePayloads: z.boolean(),
  })
  .partial({
    slug: true,
    model: true,
    effort: true,
  });

export const CreateWebhookRequest = WebhookFields.extend({
  enabled: z.boolean().default(true),
  authMode: WebhookAuthMode.default('hmac'),
  worktreeMode: CronWorktreeMode.default('none'),
  conversationMode: WebhookConversationMode.default('per-delivery'),
  overlapPolicy: CronOverlapPolicy.default('skip'),
  maxConcurrent: z.number().int().min(1).max(10).default(2),
  debounceSeconds: z.number().int().min(0).max(3600).default(10),
  storePayloads: z.boolean().default(true),
  promptTemplate: z
    .string()
    .min(1)
    .max(LIMITS.maxInputChars)
    .default(DEFAULT_JIRA_PROMPT_TEMPLATE),
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
  promptTemplate: z.string(),
  conversationMode: WebhookConversationMode,
  overlapPolicy: CronOverlapPolicy,
  maxConcurrent: z.number().int(),
  debounceSeconds: z.number().int(),
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
  payloadBytes: z.number().int(),
  payloadTruncated: z.boolean(),
  receivedAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
  sessionId: z.string().nullable(),
  agentSessionId: z.string().nullable(),
  cwd: z.string().nullable(),
  error: z.string().nullable(),
});
export type WebhookDelivery = z.infer<typeof WebhookDelivery>;

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
  /** Pre-composed, e.g. `Jira issue events · ENG, PLAT`. */
  triggerLabel: z.string(),
  lastDeliveryAt: z.number().int().nullable(),
  lastDeliveryStatus: WebhookDeliveryStatus.nullable(),
  skipPermissionsEnabled: z.boolean(),
});
export type WebhookSummary = z.infer<typeof WebhookSummary>;
