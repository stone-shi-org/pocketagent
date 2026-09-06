import crypto from 'node:crypto';
import type {
  BambooPlanMapEntry,
  BambooPromptTemplateMapEntry,
  BambooWebhookFilter,
  JiraProjectMapEntry,
  JiraPromptTemplateMapEntry,
  JiraWebhookFilter,
  Webhook,
  WebhookAuthMode,
  WebhookConversationMode,
  WebhookDelivery,
  WebhookDeliveryCounts,
  WebhookDeliveryDetail,
  WebhookDeliveryStatus,
  WebhookDeliveryTrigger,
  WebhookDirectoryPolicy,
  QueuedRunSummary,
  WebhookHistoryEntry,
  WebhookHit,
  WebhookOverlapPolicy,
  WebhookSignatureState,
  WebhookType,
} from '@pocketagent/protocol';
import {
  BAMBOO_SAMPLE_PAYLOAD,
  BambooWebhookFilter as BambooWebhookFilterSchema,
  DEFAULT_BAMBOO_PROMPT_TEMPLATE,
  DEFAULT_JIRA_PROMPT_TEMPLATE,
  JIRA_SAMPLE_PAYLOAD,
  JiraWebhookFilter as JiraWebhookFilterSchema,
  bambooTemplateVariables,
  jiraTemplateVariables,
  parsePocketAgentId,
  renderBambooTemplate,
  renderJiraTemplate,
} from '@pocketagent/protocol';
import type { Db, WebhookDeliveryRow, WebhookHitLogRow, WebhookRow } from '../db/index.js';
import {
  countActiveWebhookDeliveries,
  deleteWebhook,
  deleteWebhookDeliveriesFor,
  insertWebhook,
  insertWebhookDelivery,
  insertWebhookHit,
  markStaleWebhookDeliveriesFailed,
  pruneOldWebhookDeliveries,
  pruneOldWebhookHits,
  pruneOldWebhookIssueSessions,
  readActiveWebhookDeliveries,
  readQueuedWebhookDeliveries,
  readWebhook,
  readWebhookBySlug,
  readWebhookDeliveries,
  readWebhookDelivery,
  readWebhookHits,
  readWebhookIssueSession,
  readWebhooks,
  updateWebhook,
  updateWebhookDelivery,
  upsertWebhookIssueSession,
} from '../db/index.js';
import type { SessionManager, StructuredLikeSession } from '../sessions/manager.js';
import type { WorkspaceRegistry } from '../workspaces/index.js';
import { isContained } from '../workspaces/index.js';
import type { WorktreeService } from '../git/worktree.js';
import type { AgentRegistry } from '../agents/registry.js';
import { safeTokenEqual } from '../auth/index.js';
import type { PocketRunSpec, RunSink, RunSpec } from '../runs/executor.js';
import { RunExecutor, mintBranchName } from '../runs/executor.js';
import type { PlannerChatService } from '../planner/chats.js';
import type { PlannerWorkspaceRegistry } from '../planner/workspaces.js';
import type { QueueStore, QueuedItem } from '../runs/queue.js';
import { RunQueue } from '../runs/queue.js';
import { treeRootOf, worktreePathFor } from '../git/worktree-paths.js';
import type { JiraEventFacts } from './jira.js';
import {
  evaluateJiraFilter,
  parseJiraEvent,
  resolveComponentBranchName,
  resolveLabelOverrides,
  resolveProjectRoute,
  resolvePromptTemplate,
} from './jira.js';
import type { BambooEventFacts } from './bamboo.js';
import {
  evaluateBambooFilter,
  parseBambooEvent,
  resolvePlanRoute,
  resolvePromptTemplateByBuildState,
} from './bamboo.js';

/** The parsed facts for either provider — everything past parsing treats this opaquely by field, not by type. */
type AnyEventFacts = JiraEventFacts | BambooEventFacts;

/** The subject key used structurally: the per-subject conversation cache and branch names. */
function subjectKeyOf(type: WebhookType, facts: AnyEventFacts): string {
  return type === 'bamboo' ? (facts as BambooEventFacts).planKey : (facts as JiraEventFacts).issueKey;
}

/** The key project/plan routing matches against — Jira routes by project, Bamboo by plan (its only natural unit). */
function routeKeyOf(type: WebhookType, facts: AnyEventFacts): string | null {
  return type === 'bamboo' ? (facts as BambooEventFacts).planKey : (facts as JiraEventFacts).projectKey;
}

/** The key prompt-template routing matches against — Jira by issue type, Bamboo by build state. */
function templateRouteKeyOf(type: WebhookType, facts: AnyEventFacts): string | null {
  return type === 'bamboo' ? (facts as BambooEventFacts).buildState : (facts as JiraEventFacts).issueType;
}

/** A short session title. Bamboo has no "summary" field, so it composes one from plan/build facts. */
function titleOf(hookName: string, type: WebhookType, facts: AnyEventFacts): string {
  if (type === 'bamboo') {
    const b = facts as BambooEventFacts;
    return `[${b.planKey}] Build ${b.buildNumber ?? '?'} ${b.buildState.toLowerCase()}`;
  }
  const j = facts as JiraEventFacts;
  return j.summary ? `[${j.issueKey}] ${j.summary}` : `${hookName} · ${j.issueKey}`;
}

/** The generic delivery-row fields every provider's facts map onto (see `db/index.ts`'s `issue_key`/`project_key` columns). */
function deliveryRowFieldsOf(
  type: WebhookType,
  facts: AnyEventFacts,
): { event: string; eventType: string | null; issueKey: string; projectKey: string | null; actor: string | null; timestamp: number | null } {
  if (type === 'bamboo') {
    const b = facts as BambooEventFacts;
    return {
      event: b.notification,
      eventType: b.buildState,
      issueKey: b.planKey,
      projectKey: b.projectKey,
      actor: null,
      timestamp: b.timestamp,
    };
  }
  const j = facts as JiraEventFacts;
  return {
    event: j.event,
    eventType: j.eventType,
    issueKey: j.issueKey,
    projectKey: j.projectKey,
    actor: j.actor,
    timestamp: j.timestamp,
  };
}

/** How often to reconcile deliveries against session liveness and prune. */
const SWEEP_INTERVAL_MS = 30_000;

/** Delivery rows kept per webhook, split by class — see `pruneOldWebhookDeliveries`. */
const KEEP_RUNS_PER_WEBHOOK = 50;
const KEEP_NOISE_PER_WEBHOOK = 20;

/**
 * Rows kept in `webhook_hit_log`, globally rather than per anything — a
 * bad slug flooded by one caller and a hundred different disabled webhooks
 * are the same kind of noise, so one shared budget is enough.
 */
const KEEP_WEBHOOK_HITS = 300;

/** Longest slug attempt recorded, so a huge attacker-supplied path segment cannot bloat storage. */
const MAX_STORED_SLUG_LENGTH = 128;

/** The per-issue conversation cache is a cache; a dropped row costs a fresh chat. */
const ISSUE_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * Session slots a webhook may never take.
 *
 * A webhook has no natural rate ceiling the way a cron ticker does: one Jira
 * bulk edit is hundreds of signed, filtered, entirely legitimate deliveries.
 * Without a reservation they would exhaust `maxSessions` and the human could not
 * start their own chat because Jira ate the pool. "Jira can never consume your
 * last two session slots" is a promise worth keeping, so it is a constant here
 * rather than an emergent property of the caps.
 */
const RESERVED_HUMAN_SESSIONS = 2;

/**
 * How far a payload's own `timestamp` may be from now.
 *
 * The timestamp lives *inside* the signed body, so unlike the delivery header it
 * cannot be altered without breaking the HMAC — which is what makes it usable as
 * a freshness check at all. The window is generous because clock skew between
 * the Jira host and this server causes false rejections, and the observed skew
 * is logged on every rejection: "webhooks stopped working" with no diagnostic is
 * the failure mode of a clock check.
 */
const FRESHNESS_WINDOW_MS = 5 * 60_000;

/** Stored payloads are bounded independently of accepted ones. */
const MAX_STORED_PAYLOAD_BYTES = 64 * 1024;

/** Payload keys scrubbed before persisting — Jira custom fields can hold anything. */
const SECRET_ISH_KEY = /(secret|token|password|authorization|api[-_]?key|credential)/i;

export class WebhookServiceError extends Error {
  override readonly name = 'WebhookServiceError';
  constructor(
    message: string,
    // Only the codes actually thrown from here. Slug-format, reserved-name and
    // agent-transport checks live in the route, where they can produce a better
    // message and answer 400 directly.
    readonly code: 'not_found' | 'slug_taken' | 'invalid_filter',
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export interface WebhookServiceOptions {
  db: Db;
  sessions: SessionManager;
  workspaces: WorkspaceRegistry;
  worktrees: WorktreeService;
  agents: AgentRegistry;
  /**
   * PA-10: needed to run a webhook whose agent is a Pocket Agent
   * (`pocket:<plannerWorkspaceId>`) — the registry resolves the id to a
   * display name and proves it still exists, and the chat service runs the turn.
   */
  plannerWorkspaces: PlannerWorkspaceRegistry;
  plannerChats: PlannerChatService;
  /** Ceiling shared with interactive sessions; the reservation is carved from it. */
  maxSessions: number;
  logger?: {
    info: (o: object, m?: string) => void;
    warn: (o: object, m?: string) => void;
  };
  /** Injectable for tests, so delivery behaviour is checkable without waiting. */
  now?: () => number;
}

/** Fields shared by every provider — the part the ticket that added Bamboo called "reuse as-is". */
export interface WebhookSpecCommon {
  name: string;
  slug: string;
  enabled: boolean;
  authMode: WebhookAuthMode;
  cwd: string;
  agent: string;
  worktreeMode: 'none' | 'new-branch' | 'current-branch';
  model: string | null;
  effort?: string | null;
  skipPermissions: boolean;
  autoSelectAgentModel?: boolean;
  promptTemplate: string;
  conversationMode: WebhookConversationMode;
  overlapPolicy: WebhookOverlapPolicy;
  directoryPolicy: WebhookDirectoryPolicy;
  maxConcurrent: number;
  storePayloads: boolean;
}

/** The fields a create/update accepts, already normalized by the route. */
export type WebhookSpec =
  | (WebhookSpecCommon & {
      type: 'jira';
      filter: JiraWebhookFilter;
      projectMap: JiraProjectMapEntry[];
      promptTemplateMap?: JiraPromptTemplateMapEntry[];
    })
  | (WebhookSpecCommon & {
      type: 'bamboo';
      filter: BambooWebhookFilter;
      planMap: BambooPlanMapEntry[];
      promptTemplateMap?: BambooPromptTemplateMapEntry[];
    });

/**
 * `update()`'s patch shape for the type-specific fields, deliberately *not*
 * `Partial<WebhookSpec>` — a `Partial` of a discriminated union distributes
 * per-member, so `patch.projectMap` would not type-check against the Bamboo
 * member at all. `routeMap` is the one generic name for "whichever provider's
 * project/plan map this is", since a webhook's `type` never changes after
 * creation and the caller (the route) already knows which shape it is sending.
 */
interface WebhookSpecConfigPatch {
  filter?: JiraWebhookFilter | BambooWebhookFilter;
  routeMap?: JiraProjectMapEntry[] | BambooPlanMapEntry[];
  promptTemplateMap?: JiraPromptTemplateMapEntry[] | BambooPromptTemplateMapEntry[];
}

/** What the delivery route needs back to answer the request. */
export interface DeliveryOutcome {
  status: WebhookDeliveryStatus;
  httpStatus: number;
  deliveryId: string | null;
  sessionId: string | null;
  /**
   * PA-10: set instead of `sessionId` when the delivery ran in a Pocket Agent.
   *
   * Only consumed by `POST /api/webhooks/:id/test`, whose caller (the editor's
   * "Send test" button) navigates straight to what the test started. Without
   * it, testing a pocket webhook looks like nothing happened: `sessionId` is
   * null by design and `reason` is null on success, so the editor had no branch
   * to take. Never reaches `/api/hooks/:slug`'s response, which says nothing
   * about internals to an unauthenticated caller.
   */
  plannerChatId?: string | null;
  reason: string | null;
  duplicate: boolean;
}

/**
 * Everything needed to start one delivery's run, decided at delivery time.
 *
 * Serialized into `webhook_deliveries.queued_spec_json` when a delivery has to
 * wait. Deliberately *not* the facts it was derived from: re-deriving later
 * would re-read a payload that may not have been stored and re-decide the
 * agent, model and branch against a webhook whose configuration has since
 * changed. What was decided is what runs.
 *
 * The per-issue conversation decision is the one thing *not* frozen — see
 * `startRun`. Whether an issue's conversation is live, ended, or elsewhere is a
 * fact about right now, so it is asked again at the moment the run starts.
 */
interface FrozenRun {
  subjectKey: string;
  prompt: string;
  /** The routed project directory, before any worktree is made. */
  cwd: string;
  /**
   * The effective agent, after any Jira-label override.
   *
   * Frozen with the rest, because a label can move a delivery *across* the
   * coding/pocket boundary in either direction (PA-10) and re-resolving when a
   * queued run finally starts could pick a different kind of agent than the one
   * this delivery was accepted as.
   */
  agent: string;
  /**
   * Which kind of run, resolved before the queue sees it — the two take
   * different spec types, and only one of them occupies a working tree.
   */
  spec:
    | { kind: 'coding'; run: Omit<RunSpec, 'prompt'> }
    | { kind: 'pocket'; run: Omit<PocketRunSpec, 'prompt'> };
}

export class WebhookService {
  private timer: NodeJS.Timeout | null = null;
  private readonly db: Db;
  private readonly executor: RunExecutor;
  /**
   * The directory queue (PA-11), and which tree each in-flight delivery holds.
   *
   * `heldKeys` is what makes the release exact: a delivery that was granted a
   * tree has to hand back the *same* key when it settles, and asking the row
   * for it later would break for a delivery that started without queueing at
   * all (the common case, which still holds a tree while it runs).
   */
  private readonly queue: RunQueue;
  private readonly heldKeys = new Map<string, string>();
  private unsubscribeTreeIdle: (() => void) | null = null;

  constructor(private readonly opts: WebhookServiceOptions) {
    this.db = opts.db;
    this.executor = new RunExecutor({
      sessions: opts.sessions,
      workspaces: opts.workspaces,
      worktrees: opts.worktrees,
      plannerChats: opts.plannerChats,
      label: 'webhook delivery',
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
    this.queue = new RunQueue({
      // Asked of the sessions, never cached — see `SessionManager.busyTreeRoots`.
      busyTreeRoots: () => opts.sessions.busyTreeRoots(),
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    });
    this.queue.register(this.queueStore);
  }

  /**
   * How the queue reads and writes `webhook_deliveries`.
   *
   * `RunQueue` itself never touches a table, exactly as `RunExecutor` never
   * does; this is the webhook half of that split.
   */
  private readonly queueStore: QueueStore = {
    pending: (): QueuedItem[] => {
      const items: QueuedItem[] = [];
      for (const row of readQueuedWebhookDeliveries(this.db)) {
        // A row with no frozen spec cannot be run — it can only have come from
        // a write that was interrupted between the status and the spec. Close
        // it out rather than leaving it queued forever behind nothing.
        if (row.queued_spec_json === null || row.queue_key === null) {
          updateWebhookDelivery(this.db, row.id, {
            status: 'failed',
            error: 'This delivery was queued but its saved run was incomplete.',
            finished_at: this.now(),
          });
          continue;
        }
        items.push({
          id: row.id,
          key: row.queue_key,
          enqueuedAt: row.queued_at ?? row.received_at,
          run: () => this.runQueued(row.id, row.queue_key as string),
        });
      }
      return items;
    },
    onQueued: (item, position): void => {
      this.opts.logger?.info(
        { deliveryId: item.id, key: item.key, position },
        'webhook delivery queued behind another agent in the same working tree',
      );
    },
    onDequeued: (item, reason): void => {
      if (reason !== 'cancelled') return;
      // `skipped` already means "never started, on purpose", which is exactly
      // what a human cancelling a waiter is.
      this.closeDeliveryById(item.id, 'skipped', 'Removed from the queue.');
    },
  };

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /**
   * Reconcile against reality, then start sweeping.
   *
   * Must run *after* `SessionManager.init()`, for the same reason
   * `CronService.init()` must: this reconciles delivery rows against an
   * already-reconciled session table.
   */
  init(): void {
    const failed = markStaleWebhookDeliveriesFailed(this.db, this.now());
    if (failed > 0) {
      this.opts.logger?.info(
        { failed },
        'closed out webhook deliveries left open by a previous server',
      );
    }
    // Only now is the liveness picture true, so only now can the queue decide
    // what is free. `markStaleWebhookDeliveriesFailed` deliberately leaves
    // `queued` rows alone (see `QUEUED_DELIVERY`), so this adopts them.
    this.unsubscribeTreeIdle = this.opts.sessions.onTreeIdle(() => this.queue.pump());
    this.queue.init();
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Stop sweeping and close out anything in flight. Called before session shutdown. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unsubscribeTreeIdle?.();
    this.unsubscribeTreeIdle = null;
    // Waiters stay `queued` on disk; only the in-memory queue is dropped, so
    // the next boot adopts them rather than losing them.
    this.queue.clear();
    this.heldKeys.clear();
    this.executor.abandonAll('The server shut down while this delivery was in progress.');
  }

  /**
   * Close out deliveries whose session is gone, then prune.
   *
   * Public and synchronous so a test can drive it, exactly as `CronService.tick`
   * is. Liveness is asked of the session, never inferred from a clock: a
   * delivery parked on an unanswered approval is genuinely still running.
   */
  sweep(): void {
    try {
      for (const row of readActiveWebhookDeliveries(this.db)) {
        // PA-10: a pocket run. Still-parked and still-streaming runs are both
        // `isPocketRunAlive`, since a pocket run only leaves the executor's
        // in-flight map when it settles — so reaching here means the turn is
        // genuinely gone (its chat was deleted mid-turn, say) and the row would
        // otherwise hold a concurrency slot until the next restart.
        if (row.planner_chat_id !== null) {
          if (this.executor.isPocketRunAlive(row.id)) continue;
          this.settleDelivery(
            row.id,
            row.webhook_id,
            'failed',
            row.error ?? 'The Pocket Agent chat ended before the delivery completed.',
          );
          continue;
        }
        if (row.session_id === null) continue;
        if (this.executor.isAlive(row.session_id)) continue;
        this.settleDelivery(
          row.id,
          row.webhook_id,
          'failed',
          row.error ?? 'The session ended before the delivery completed.',
        );
      }
      // The backstop for the queue. `onTreeIdle` is the fast path; this catches
      // a tree freed by something that never emitted one — a session evicted by
      // the sweep, a crashed run — so a queue can be late but never stuck.
      this.queue.pump();
      pruneOldWebhookDeliveries(this.db, {
        keepRunsPerWebhook: KEEP_RUNS_PER_WEBHOOK,
        keepNoisePerWebhook: KEEP_NOISE_PER_WEBHOOK,
      });
      pruneOldWebhookIssueSessions(this.db, this.now() - ISSUE_SESSION_TTL_MS);
      pruneOldWebhookHits(this.db, KEEP_WEBHOOK_HITS);
    } catch (err) {
      this.opts.logger?.warn({ err }, 'webhook sweep failed');
    }
  }

  // -------------------------------------------------------------------------
  // Receiving a delivery
  // -------------------------------------------------------------------------

  /**
   * The whole inbound path, from raw bytes to a started run.
   *
   * The order below is load-bearing and is the security design of the feature:
   * authenticate before parsing, claim idempotency before doing any work, and
   * never answer 5xx once the body has been read — Jira Data Center does not
   * retry, so a 5xx loses the event permanently.
   */
  async deliver(input: {
    slug: string;
    rawBody: Buffer;
    signatureHeader: string | null;
    bearerToken: string | null;
    deliveryHeader: string | null;
  }): Promise<DeliveryOutcome> {
    // 1. Find the webhook. A missing one, a disabled one and a bad signature are
    //    deliberately indistinguishable from outside; the dummy HMAC below keeps
    //    the work profile similar so timing does not answer what the status
    //    refuses to.
    const hook = readWebhookBySlug(this.db, input.slug);
    if (hook === null || hook.enabled !== 1) {
      verifyAgainstDummyKey(input.rawBody);
      // Recorded the same way regardless of which sub-case this is: doing
      // anything asymmetric between "no such slug" and "that slug, but off"
      // would reopen exactly the timing question the identical response
      // above already closes.
      this.recordHit(input.slug, hook);
      return notFound();
    }

    // 2. Authenticate over the RAW bytes. Not over a re-serialized parse: key
    //    order survives JSON.stringify but whitespace, unicode escaping and
    //    number formatting do not, so that would validate in a unit test with
    //    canonical JSON and fail on every real Jira payload.
    const signature = this.verify(hook, input);
    if (signature.state !== 'valid') {
      const reason =
        signature.state === 'missing'
          ? 'No signature header was present.'
          : 'The signature did not match this webhook’s secret.';
      const id = this.recordTerminal(hook, {
        status: 'rejected',
        signatureState: signature.state,
        reason,
        // Never store the body of an unauthenticated request: it is unbounded
        // attacker-controlled data on an endpoint anyone can reach.
        payload: null,
        payloadBytes: input.rawBody.byteLength,
        deliveryHeader: input.deliveryHeader,
        bodyHash: null,
      });
      return { status: 'rejected', httpStatus: 401, deliveryId: id, sessionId: null, reason, duplicate: false };
    }

    // 3. Parse. Exactly one deserialization, and it happens after the MAC check.
    let payload: unknown;
    try {
      payload = JSON.parse(input.rawBody.toString('utf8'));
    } catch {
      return this.invalid(hook, input, 'The request body was not valid JSON.');
    }

    const parsed = hook.type === 'bamboo' ? parseBambooEvent(payload) : parseJiraEvent(payload);
    if (!parsed.ok) return this.invalid(hook, input, parsed.reason);
    const facts: AnyEventFacts = parsed.facts;
    const row = deliveryRowFieldsOf(hook.type as WebhookType, facts);

    // 4. Freshness, from the signed body. Skew is logged, because a silent clock
    //    check is indistinguishable from the feature being broken.
    if (row.timestamp !== null) {
      const skew = this.now() - row.timestamp;
      if (Math.abs(skew) > FRESHNESS_WINDOW_MS) {
        this.opts.logger?.warn(
          { webhook: hook.name, skewMs: skew, windowMs: FRESHNESS_WINDOW_MS },
          'rejected a webhook delivery as stale; check the clocks on both hosts',
        );
        return this.invalid(
          hook,
          input,
          `The payload timestamp is ${Math.round(skew / 1000)}s from this server's clock, outside the ${FRESHNESS_WINDOW_MS / 60_000} minute window.`,
        );
      }
    }

    // 5. Claim idempotency. The INSERT *is* the claim: no read-then-write race,
    //    and it survives a restart as an in-memory set would not.
    const bodyHash = sha256(input.rawBody);
    const deliveryId = crypto.randomUUID();
    try {
      insertWebhookDelivery(this.db, {
        ...this.blankRow(hook, deliveryId),
        status: 'starting',
        trigger: 'delivery',
        body_hash: bodyHash,
        delivery_header: input.deliveryHeader,
        signature_state: signature.state,
        event: row.event,
        event_type: row.eventType,
        issue_key: row.issueKey,
        project_key: row.projectKey,
        actor: row.actor,
        payload_json: this.storablePayload(hook, payload),
        payload_bytes: input.rawBody.byteLength,
        payload_truncated: input.rawBody.byteLength > MAX_STORED_PAYLOAD_BYTES ? 1 : 0,
        received_at: this.now(),
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return {
          status: 'duplicate',
          // 200, not 4xx: a duplicate is a success from Jira's point of view,
          // and a 4xx only makes it retry harder.
          httpStatus: 200,
          deliveryId: null,
          sessionId: null,
          reason: 'This exact delivery has already been handled.',
          duplicate: true,
        };
      }
      throw err;
    }

    return this.dispatch(hook, deliveryId, facts, payload);
  }

  /**
   * Filter → concurrency → overlap → run. Shared by real deliveries and tests.
   */
  private async dispatch(
    hook: WebhookRow,
    deliveryId: string,
    facts: AnyEventFacts,
    payload: unknown,
  ): Promise<DeliveryOutcome> {
    const type = hook.type as WebhookType;

    // 6. Filter. A non-match is a success that started nothing.
    const verdict =
      type === 'bamboo'
        ? evaluateBambooFilter(this.filterFor(hook) as BambooWebhookFilter, facts as BambooEventFacts)
        : evaluateJiraFilter(this.filterFor(hook) as JiraWebhookFilter, facts as JiraEventFacts);
    if (!verdict.matched) {
      this.closeDelivery(hook, deliveryId, 'filtered', verdict.reason);
      return accepted('filtered', deliveryId, verdict.reason);
    }

    // 6b. Route by project/plan. An empty map always resolves to `hook.cwd`; a
    // non-empty one filters an unrouted project/plan rather than guessing.
    const route =
      type === 'bamboo'
        ? resolvePlanRoute(this.routeMapFor(hook) as { planKey: string; cwd: string }[], hook.cwd, routeKeyOf(type, facts))
        : resolveProjectRoute(this.routeMapFor(hook) as { projectKey: string; cwd: string }[], hook.cwd, routeKeyOf(type, facts));
    if (!route.matched) {
      this.closeDelivery(hook, deliveryId, 'filtered', route.reason);
      return accepted('filtered', deliveryId, route.reason);
    }

    // 7. Caps. Counted by asking whether sessions are alive, never by a timeout.
    const cap = this.capReason(hook, deliveryId);
    if (cap !== null) {
      this.closeDelivery(hook, deliveryId, 'throttled', cap);
      return accepted('throttled', deliveryId, cap);
    }

    const subjectKey = subjectKeyOf(type, facts);
    const conversationKey = hook.conversation_mode === 'per-issue' ? subjectKey : `hook:${hook.id}`;
    // `skip` drops it here. `allow` and `queue` both fall through to the
    // directory gate below, and that is the whole difference between them: a
    // second delivery that would land in the *same working tree* waits there
    // (which for `per-issue` is always, since the conversation's tree is
    // reused), while two runs that each mint their own directory share nothing
    // and genuinely can proceed at once. There is deliberately no
    // conversation-scoped queue: `RunQueue` orders directories, and ordering a
    // pair of runs that contend for nothing would be ceremony.
    if (hook.overlap_policy === 'skip' && this.hasActiveRunFor(hook, conversationKey, deliveryId)) {
      const reason =
        hook.conversation_mode === 'per-issue'
          ? `A run for ${subjectKey} was still in progress.`
          : 'The previous run for this webhook was still in progress.';
      this.closeDelivery(hook, deliveryId, 'skipped', reason);
      return accepted('skipped', deliveryId, reason);
    }

    // 8. Render the prompt, and resolve the whole run, *before* the directory
    //    gate below. A queued delivery has to freeze both: `storePayloads` may
    //    be false, so the payload that produced this prompt may not exist to
    //    re-render from later, and re-resolving would re-decide the agent,
    //    model and branch from data that has since moved on. What runs in an
    //    hour is what was decided now.
    const prompt = this.renderPrompt(hook, deliveryId, payload, templateRouteKeyOf(type, facts));
    const resolved = this.resolveAgent(hook, facts);
    // A Pocket Agent run has no cwd, no worktree and no branch, so there is no
    // coding spec to build and nothing for the directory gate below to key on.
    const built =
      resolved.plannerWorkspaceId !== null
        ? null
        : this.specFor(hook, facts, route.cwd);
    const frozen: FrozenRun = {
      subjectKey,
      prompt: prompt.text,
      cwd: route.cwd,
      agent: resolved.agent,
      spec:
        built !== null
          ? { kind: 'coding', run: built.spec }
          : {
              kind: 'pocket',
              run: this.pocketSpecFor(
                hook,
                facts,
                resolved.plannerWorkspaceId as string,
                resolved.model,
              ),
            },
    };
    updateWebhookDelivery(this.db, deliveryId, {
      rendered_prompt: prompt.text,
      payload_truncated: prompt.truncated ? 1 : 0,
    });

    // 9. The directory gate. Two agents in one working tree corrupt each
    //    other's work, so unless this run gets a directory of its own, it waits
    //    for whoever is mid-turn in that tree to conclude.
    const queueKey = this.queueKeyFor(hook, frozen, built?.sharedTree ?? null);
    if (queueKey !== null && hook.directory_policy === 'queue') {
      const acquired = this.queue.tryAcquire(queueKey, deliveryId);
      if (!acquired.granted) {
        return this.parkDelivery(hook, deliveryId, queueKey, frozen, acquired.position);
      }
      this.heldKeys.set(deliveryId, queueKey);
    }

    const started = await this.startRun(hook, deliveryId, frozen);
    return {
      // PA-10: keyed on `started`, not on `sessionId !== null` — a Pocket Agent
      // run succeeds with no session at all, and the old test would have
      // reported every one of them as failed.
      status: started.started ? 'running' : 'failed',
      httpStatus: 202,
      deliveryId,
      sessionId: started.sessionId,
      ...(started.plannerChatId !== undefined ? { plannerChatId: started.plannerChatId } : {}),
      reason: started.error,
      duplicate: false,
    };
  }

  /**
   * The working tree this delivery would occupy, or null if it gets its own.
   *
   * `per-issue` is checked first and wins: when an issue already has a
   * conversation in a directory, *that* directory is where the run goes,
   * whatever the worktree mode would otherwise have minted.
   */
  private queueKeyFor(
    hook: WebhookRow,
    frozen: FrozenRun,
    sharedTree: string | null,
  ): string | null {
    // A Pocket Agent run occupies no working tree: its workspace is app-owned
    // planner scratch space, it creates no worktree and no session, and this
    // queue's whole notion of "busy" is a session mid-turn in a checkout. It
    // therefore takes no key — the same rule as a run that mints its own
    // directory. Two pocket runs in one planner workspace can still touch the
    // same scratch files; serializing *that* would need occupancy derived from
    // in-flight pocket runs rather than sessions, which is a separate change.
    if (frozen.spec.kind === 'pocket') return null;
    if (hook.conversation_mode === 'per-issue') {
      const mapped = readWebhookIssueSession(this.db, hook.id, frozen.subjectKey);
      if (mapped !== null && (mapped.cwd === frozen.cwd || isContained(frozen.cwd, mapped.cwd))) {
        return treeRootOf(mapped.cwd);
      }
    }
    return sharedTree;
  }

  /**
   * Park a delivery behind whatever holds its working tree.
   *
   * Answers **2xx**, always. Jira Data Center does not retry and a 4xx only
   * makes it retry harder, so "accepted, and it will run shortly" is the honest
   * answer — the work is persisted and nothing has been lost. A full queue is
   * recorded as `throttled`, matching what a concurrency cap already does.
   */
  private parkDelivery(
    hook: WebhookRow,
    deliveryId: string,
    queueKey: string,
    frozen: FrozenRun,
    position: number,
  ): DeliveryOutcome {
    const queuedAt = this.now();
    // Persisted before the enqueue so the row is never `queued` with no spec to
    // run, which is the one state `pending()` cannot recover from.
    updateWebhookDelivery(this.db, deliveryId, {
      status: 'queued',
      queue_key: queueKey,
      queued_at: queuedAt,
      queued_spec_json: JSON.stringify(frozen),
      reason: `Waiting for another agent to finish in ${queueKey}.`,
    });
    const enqueued = this.queue.enqueue(
      {
        id: deliveryId,
        key: queueKey,
        enqueuedAt: queuedAt,
        run: () => this.runQueued(deliveryId, queueKey),
      },
      this.queueStore,
    );
    if (!enqueued) {
      const reason = 'The queue for this directory is full.';
      this.closeDelivery(hook, deliveryId, 'throttled', reason);
      updateWebhookDelivery(this.db, deliveryId, { queued_at: null, queued_spec_json: null });
      return accepted('throttled', deliveryId, reason);
    }
    updateWebhook(this.db, hook.id, {
      last_delivery_at: queuedAt,
      last_delivery_status: 'queued',
      last_error: null,
    });
    return {
      status: 'queued',
      httpStatus: 202,
      deliveryId,
      sessionId: null,
      reason: `Queued at position ${position}, waiting for ${queueKey}.`,
      duplicate: false,
    };
  }

  /**
   * Run a delivery the queue has just granted its working tree.
   *
   * Never throws: the queue has nobody to report an exception to, and a run
   * that dies here must still release the tree it was handed.
   */
  private async runQueued(deliveryId: string, key: string): Promise<void> {
    // `key` is passed in rather than re-read from the row, because the row may
    // be gone: `DELETE /api/webhooks/:id/deliveries` can remove a waiter, and a
    // grant with nothing left to hand it back would block that tree — for every
    // later delivery *and* every human prompt — until the server restarted.
    const release = (): void => {
      this.queue.release(key, deliveryId);
      this.heldKeys.delete(deliveryId);
    };

    const row = readWebhookDelivery(this.db, deliveryId);
    if (row === null) {
      release();
      return;
    }
    this.heldKeys.set(deliveryId, key);

    const hook = row.webhook_id !== null ? readWebhook(this.db, row.webhook_id) : null;
    // A webhook deleted or switched off while this waited. The delivery is
    // history now, not work: running it would apply a configuration nobody has
    // any more, and `webhook_issue_sessions` has already CASCADEd away.
    if (hook === null || hook.enabled !== 1) {
      this.settleDelivery(
        deliveryId,
        row.webhook_id,
        'failed',
        hook === null
          ? 'The webhook was deleted while this delivery was queued.'
          : 'The webhook was switched off while this delivery was queued.',
        row.received_at,
      );
      release();
      return;
    }

    let frozen: FrozenRun;
    try {
      frozen = JSON.parse(row.queued_spec_json ?? '') as FrozenRun;
    } catch {
      this.settleDelivery(
        deliveryId,
        row.webhook_id,
        'failed',
        'This delivery was queued but its saved run could not be read.',
        row.received_at,
      );
      release();
      return;
    }

    updateWebhookDelivery(this.db, deliveryId, { status: 'starting', reason: null });
    const started = await this.startRun(hook, deliveryId, frozen);
    // `startRun` failing means no session was ever created, so nothing will
    // ever settle it — the tree has to come back now or the queue stalls on a
    // holder that does not exist.
    if (started.sessionId === null) release();
  }

  /**
   * Start (or continue) the run for one delivery.
   *
   * `per-issue` has three cases, and the middle one is the reason the mapping
   * row stores a cwd: the worktree belongs to the *issue*, so a resumed
   * conversation must run in the tree the first delivery made rather than mint a
   * second one per event.
   */
  private async startRun(
    hook: WebhookRow,
    deliveryId: string,
    frozen: FrozenRun,
  ): Promise<{
    started: boolean;
    sessionId: string | null;
    plannerChatId?: string;
    error: string | null;
  }> {
    const { subjectKey, prompt, cwd } = frozen;
    const startedAt = this.now();
    updateWebhookDelivery(this.db, deliveryId, { started_at: startedAt });
    const sink = this.sinkFor(hook, deliveryId, subjectKey, startedAt, cwd);

    // The saved agent may have been a coding agent that a Jira label moved to a
    // Pocket Agent (or the reverse), so the row's own `agent` is corrected to
    // what actually ran rather than left describing something that did not.
    // Read off the frozen run, not re-resolved: a queued delivery must run the
    // agent it was accepted as, not whatever the labels would say now.
    this.recordEffectiveAgent(deliveryId, frozen.agent);

    // PA-10: a Pocket Agent run. Checked before everything below because none
    // of it applies — the three `per-issue` session cases are about resuming a
    // *session*, and a pocket conversation is a chat that `startPocketAgent`
    // resumes itself from the mapping row.
    if (frozen.spec.kind === 'pocket') {
      const pocketSpec = frozen.spec.run;
      const mapped =
        hook.conversation_mode === 'per-issue'
          ? readWebhookIssueSession(this.db, hook.id, subjectKey)
          : null;
      const outcome = await this.executor.startPocketAgent(
        deliveryId,
        {
          ...pocketSpec,
          prompt,
          ...(mapped?.planner_chat_id ? { resumeChatId: mapped.planner_chat_id } : {}),
        },
        sink,
      );
      // `sessionId` stays null for a pocket run — there is no session. The
      // delivery's link is `planner_chat_id`, set through `sink.onPlannerChat`.
      return outcome.ok
        ? { started: true, sessionId: null, plannerChatId: outcome.chatId, error: null }
        : { started: false, sessionId: null, error: outcome.error };
    }

    const codingSpec = frozen.spec.run;

    if (hook.conversation_mode === 'per-issue') {
      const mapped = readWebhookIssueSession(this.db, hook.id, subjectKey);
      const sameProject = mapped !== null && (mapped.cwd === cwd || isContained(cwd, mapped.cwd));

      // Case 1: the conversation is still live in the same project directory.
      // Nothing to create, nothing to resume — just another turn in the session
      // already handling this issue. If the project mapping changed, do NOT
      // follow up in the old project's session.
      if (sameProject && mapped.session_id !== null && this.executor.isAlive(mapped.session_id)) {
        const live = this.opts.sessions.get(mapped.session_id);
        if (live !== undefined && live.transport === 'structured') {
          const ok = this.executor.followUp(
            deliveryId,
            live as StructuredLikeSession,
            prompt,
            sink,
          );
          return { started: ok, sessionId: ok ? mapped.session_id : null, error: null };
        }
      }
      // Case 2: the conversation exists in the same project directory but its
      // session has ended. Resume it in the worktree the first delivery made,
      // rather than minting a second one. If the project mapping changed to a
      // different directory, start fresh in the new cwd.
      if (sameProject && mapped.agent_session_id !== null) {
        const outcome = await this.executor.start(
          deliveryId,
          {
            ...codingSpec,
            reuseCwd: mapped.cwd,
            resume: { agentSessionId: mapped.agent_session_id },
            prompt,
          },
          sink,
        );
        return outcome.ok
          ? { started: true, sessionId: outcome.sessionId, error: null }
          : { started: false, sessionId: null, error: outcome.error };
      }
    }

    const outcome = await this.executor.start(deliveryId, { ...codingSpec, prompt }, sink);
    return outcome.ok
      ? { started: true, sessionId: outcome.sessionId, error: null }
      : { started: false, sessionId: null, error: outcome.error };
  }

  /**
   * Correct the delivery row's `agent` to what is actually about to run.
   *
   * `blankRow` copies the webhook's *configured* agent, because the row has to
   * exist (it is the idempotency claim) long before the filter has matched or
   * the prompt has rendered. With `autoSelectAgentModel` on, a Jira label can
   * then choose a different agent, and before PA-10 the row kept describing the
   * configured one — a latent wrong-history bug that becomes a visible one once
   * the override can cross between a coding agent and a Pocket Agent, since
   * `agentDisplayName` and the row's transcript link both key off it.
   *
   * A no-op when nothing was overridden, which is the overwhelmingly common case.
   */
  private recordEffectiveAgent(deliveryId: string, agent: string): void {
    const row = readWebhookDelivery(this.db, deliveryId);
    if (row === null || row.agent === agent) return;
    updateWebhookDelivery(this.db, deliveryId, { agent });
  }

  private sinkFor(
    hook: WebhookRow,
    deliveryId: string,
    issueKey: string,
    startedAt: number,
    resolvedCwd: string,
  ): RunSink {
    const remember = (patch: {
      sessionId?: string;
      agentSessionId?: string;
      plannerChatId?: string;
      cwd?: string;
    }): void => {
      if (hook.conversation_mode !== 'per-issue') return;
      const existing = readWebhookIssueSession(this.db, hook.id, issueKey);
      // `resolvedCwd`, not `hook.cwd`: the routed directory for *this*
      // delivery's project is the right fallback before `onCwd` has fired.
      const cwd = patch.cwd ?? existing?.cwd ?? resolvedCwd;
      upsertWebhookIssueSession(this.db, {
        webhook_id: hook.id,
        issue_key: issueKey,
        agent_session_id: patch.agentSessionId ?? existing?.agent_session_id ?? null,
        session_id: patch.sessionId ?? existing?.session_id ?? null,
        planner_chat_id: patch.plannerChatId ?? existing?.planner_chat_id ?? null,
        cwd,
        created_at: existing?.created_at ?? startedAt,
        updated_at: startedAt,
      });
    };

    return {
      onCwd: (cwd) => {
        updateWebhookDelivery(this.db, deliveryId, { cwd });
        remember({ cwd });
      },
      onSessionStarted: (sessionId) => {
        // The session is real now, so `busyTreeRoots` can hold the tree and the
        // start-window grant must not: a grant outliving a session that dies
        // unnoticed would block the tree with nothing left to release it.
        const held = this.heldKeys.get(deliveryId);
        if (held !== undefined) this.queue.started(held, deliveryId);
        updateWebhookDelivery(this.db, deliveryId, { status: 'running', session_id: sessionId });
        updateWebhook(this.db, hook.id, {
          last_delivery_at: startedAt,
          last_delivery_status: 'running',
          last_error: null,
        });
        remember({ sessionId });
      },
      onAgentSessionId: (agentSessionId) => {
        updateWebhookDelivery(this.db, deliveryId, { agent_session_id: agentSessionId });
        remember({ agentSessionId });
      },
      /**
       * PA-10: the pocket counterpart of `onSessionStarted` — it stamps the
       * webhook the same way, because for a pocket run this *is* the moment the
       * run became real, and the row's `last_delivery_status` would otherwise
       * never leave `starting`.
       */
      onPlannerChat: (plannerChatId) => {
        updateWebhookDelivery(this.db, deliveryId, {
          status: 'running',
          planner_chat_id: plannerChatId,
        });
        updateWebhook(this.db, hook.id, {
          last_delivery_at: startedAt,
          last_delivery_status: 'running',
          last_error: null,
        });
        remember({ plannerChatId });
      },
      onSettled: (status, error) => {
        this.settleDelivery(deliveryId, hook.id, status, error, startedAt);
      },
    };
  }

  private settleDelivery(
    deliveryId: string,
    webhookId: string | null,
    status: 'succeeded' | 'failed',
    error: string | null,
    startedAt?: number,
  ): void {
    updateWebhookDelivery(this.db, deliveryId, {
      status,
      error,
      finished_at: this.now(),
    });
    // The turn is over, so the working tree is free. Done here rather than only
    // in the sink so *every* way a delivery can end releases it — including the
    // sweep closing out a session that died without a `turn_complete`.
    this.releaseTree(deliveryId);
    if (webhookId !== null) {
      updateWebhook(this.db, webhookId, {
        // A delivery that failed before its session existed never reached
        // `onSessionStarted`, and it still arrived when it arrived.
        last_delivery_at: startedAt ?? this.now(),
        last_delivery_status: status,
        last_error: error,
      });
    }
  }

  /**
   * Hand back the working tree a delivery was holding, if any.
   *
   * Keyed on what was actually granted rather than re-derived from the row: a
   * delivery that ran without ever queueing still holds its tree, and a late
   * release must not evict whatever took its place — `RunQueue.release` checks
   * the holder before clearing.
   */
  private releaseTree(deliveryId: string): void {
    const key = this.heldKeys.get(deliveryId);
    if (key === undefined) return;
    this.heldKeys.delete(deliveryId);
    this.queue.release(key, deliveryId);
  }

  /** Close out a queued delivery by id, when the hook row may be gone. */
  private closeDeliveryById(
    deliveryId: string,
    status: WebhookDeliveryStatus,
    reason: string,
  ): void {
    const now = this.now();
    updateWebhookDelivery(this.db, deliveryId, {
      status,
      reason,
      finished_at: now,
      queued_at: null,
      queued_spec_json: null,
    });
  }

  /**
   * Take a queued delivery out of the queue, or move it to the front of its
   * own line.
   *
   * `front` deliberately cannot jump the *tree* — it only reorders waiters, and
   * still waits for the directory. Bypassing occupancy is the hazard this
   * feature exists to prevent, so there is no route that does it for a webhook;
   * the only override lives on a human's own prompt, where a human is present
   * to own the consequence.
   */
  resolveQueued(deliveryId: string, action: 'cancel' | 'front'): boolean {
    if (action === 'cancel') return this.queue.cancel(deliveryId);
    const reordered = this.queue.moveToFront(deliveryId);
    // `queued_at` *is* the order — it is what `pending()` re-sorts by at boot —
    // so a reorder that only moved the in-memory copy would silently revert on
    // the next restart.
    if (reordered !== null) updateWebhookDelivery(this.db, deliveryId, { queued_at: reordered });
    return reordered !== null;
  }

  /**
   * The shared queue, for the other producers.
   *
   * This service happens to construct it (it was the first caller, exactly as
   * it was for `RunExecutor`), but it does not own the trees — a human's queued
   * prompt has to be ordered against a delivery, so both go through this one
   * instance.
   */
  get runQueue(): RunQueue {
    return this.queue;
  }

  /** 1-based place in line, or null when this delivery is not waiting. */
  queuePositionOf(deliveryId: string): number | null {
    return this.queue.positionOf(deliveryId);
  }

  /**
   * Everything waiting right now, keyed by the working tree it waits on.
   *
   * Read by `ProjectService` to draw the synthetic "Queued" group. Built from
   * the live queue rather than from the rows, because a *position* is a fact
   * about the other waiters and persisting it would mean rewriting every row
   * each time one is granted.
   */
  queuedByTree(): Map<string, QueuedRunSummary[]> {
    const byTree = new Map<string, QueuedRunSummary[]>();
    for (const row of readQueuedWebhookDeliveries(this.db)) {
      if (row.queue_key === null) continue;
      const position = this.queue.positionOf(row.id);
      // Not in the live queue means it is mid-transition (just granted, or
      // adopted-and-failed); the row will settle on its own.
      if (position === null) continue;
      const list = byTree.get(row.queue_key) ?? [];
      list.push({
        id: row.id,
        kind: 'webhook',
        // The issue/plan key is what identifies the waiting work to a human;
        // the webhook's own name is on the row beside it anyway.
        title: row.issue_key ?? row.webhook_name,
        webhookId: row.webhook_id,
        webhookName: row.webhook_name,
        sessionId: null,
        agent: row.agent,
        agentDisplayName: this.opts.agents.get(row.agent)?.displayName ?? row.agent,
        position,
        queuedAt: row.queued_at ?? row.received_at,
        skipPermissionsEnabled: row.skip_permissions_enabled === 1,
      });
      byTree.set(row.queue_key, list);
    }
    for (const [, list] of byTree) list.sort((a, b) => a.position - b.position);
    return byTree;
  }

  /** Close out a delivery that will never run, and stamp the webhook. */
  private closeDelivery(
    hook: WebhookRow,
    deliveryId: string,
    status: WebhookDeliveryStatus,
    reason: string,
  ): void {
    const now = this.now();
    updateWebhookDelivery(this.db, deliveryId, {
      status,
      reason,
      finished_at: now,
    });
    updateWebhook(this.db, hook.id, {
      last_delivery_at: now,
      last_delivery_status: status,
      // A filtered delivery is not an error; recording it as one would make the
      // row read red for doing exactly what it was configured to do.
      last_error: null,
    });
  }

  /**
   * PA-10: which agent this delivery actually runs, and whether it is a Pocket
   * Agent.
   *
   * Split out of `specFor` because the answer is needed *before* a spec can be
   * built — the two kinds of run take different spec types — and because it is
   * needed a second time by `startRun`, which has to choose between
   * `executor.start` and `executor.startPocketAgent`. Computing it once here
   * also means the Jira-label override is applied identically on both paths.
   *
   * `resolveLabelOverrides` can move a delivery *across* the boundary in either
   * direction: `agent:pocket-release-notes` on a webhook configured with
   * `claude` turns that delivery into a pocket run, and `agent:claude` on a
   * pocket-configured webhook turns it back into a coding run. That is the
   * feature the ticket asked for ("The Jira tag should support pocket agent
   * too"), and it is why nothing downstream may assume the run kind from the
   * *saved* `hook.agent`.
   */
  private resolveAgent(
    hook: WebhookRow,
    facts: AnyEventFacts,
  ): { agent: string; model: string | null; plannerWorkspaceId: string | null } {
    const type = hook.type as WebhookType;
    let agent = hook.agent;
    let model = hook.model;

    if (hook.auto_select_agent_model === 1 && type === 'jira') {
      const jFacts = facts as JiraEventFacts;
      if (Array.isArray(jFacts.labels) && jFacts.labels.length > 0) {
        const overrides = resolveLabelOverrides(
          jFacts.labels,
          this.opts.agents.list().map((a) => a.id),
          this.opts.plannerWorkspaces.list().map((w) => ({ id: w.id, name: w.name })),
        );
        if (overrides.agent) agent = overrides.agent;
        if (overrides.model) model = overrides.model;
      }
    }

    return { agent, model, plannerWorkspaceId: parsePocketAgentId(agent) };
  }

  /**
   * The spec for a Pocket Agent run. No worktree, no branch, no cwd: a planner
   * workspace is app-owned scratch space that the planner's own tools write to
   * directly, so `worktreeMode` and `effort` are simply not expressible here
   * and are ignored rather than silently reinterpreted.
   */
  private pocketSpecFor(
    hook: WebhookRow,
    facts: AnyEventFacts,
    plannerWorkspaceId: string,
    model: string | null,
  ): Omit<PocketRunSpec, 'prompt'> {
    return {
      plannerWorkspaceId,
      title: titleOf(hook.name, hook.type as WebhookType, facts),
      skipPermissions: hook.skip_permissions === 1,
      model,
    };
  }

  /**
   * Build the run, and say which working tree two deliveries could collide in.
   *
   * `sharedTree` is the queue's whole input, and it is null far more often than
   * not. A run that mints its *own* directory has nothing to contend for, and
   * keying it would serialize exactly the per-branch parallelism worktrees
   * exist to provide:
   *
   * - `none` — runs directly in the routed project folder, so every delivery
   *   of that route collides. Shared.
   * - `new-branch` with a Jira component — `resolveComponentBranchName` is
   *   deterministic (`feature/<component>`) and `reuseExisting` is on, so two
   *   different issues in one component deliberately land in one worktree.
   *   Shared, and the case the ticket was filed about.
   * - `new-branch` without one — `mintBranchName` carries a timestamp and three
   *   random bytes. Private.
   * - `current-branch` — mints `wt/<base>-<rand>`; git refuses to check one
   *   branch out twice anyway. Private.
   */
  private specFor(
    hook: WebhookRow,
    facts: AnyEventFacts,
    cwd: string,
  ): { spec: Omit<RunSpec, 'prompt'>; sharedTree: string | null } {
    const type = hook.type as WebhookType;
    const subjectKey = subjectKeyOf(type, facts);
    let worktreeBranchName = mintBranchName(`${hook.name}-${subjectKey}`, 'UTC', this.now(), 'webhook');
    let branchIsShared = false;

    if (type === 'jira') {
      const jFacts = facts as JiraEventFacts;
      const componentBranch = resolveComponentBranchName(jFacts.component);
      if (componentBranch !== null) {
        worktreeBranchName = componentBranch;
        branchIsShared = true;
      }
    }

    const worktree: RunSpec['worktree'] =
      hook.worktree_mode === 'new-branch'
        ? {
            mode: 'new-branch',
            branchName: worktreeBranchName,
          }
        : hook.worktree_mode === 'current-branch'
          ? { mode: 'current-branch' }
          : { mode: 'none' };

    const title = titleOf(hook.name, type, facts);

    const { agent: effectiveAgent, model: effectiveModel } = this.resolveAgent(hook, facts);

    const sharedTree =
      hook.worktree_mode === 'none'
        ? treeRootOf(cwd)
        : hook.worktree_mode === 'new-branch' && branchIsShared
          ? treeRootOf(worktreePathFor(cwd, worktreeBranchName))
          : null;

    return {
      spec: {
        cwd,
        agent: effectiveAgent,
        title,
        skipPermissions: hook.skip_permissions === 1,
        model: effectiveModel,
        ...(hook.effort_set === 1 ? { effort: hook.effort } : {}),
        worktree,
        notStructuredMessage:
          'A webhook run needs a structured session, but a terminal one was created.',
      },
      sharedTree,
    };
  }

  private renderPrompt(
    hook: WebhookRow,
    deliveryId: string,
    payload: unknown,
    routeKey?: string | null,
  ): { text: string; truncated: boolean } {
    const type = hook.type as WebhookType;
    const extra = { webhookName: hook.name, deliveryId };
    // A fresh nonce per delivery: a fixed one would eventually appear in an
    // issue description or a commit message, and the fence would then be
    // closable from inside.
    const nonce = crypto.randomBytes(8).toString('hex');

    if (type === 'bamboo') {
      const template = resolvePromptTemplateByBuildState(
        this.promptTemplateMapFor(hook) as BambooPromptTemplateMapEntry[],
        hook.prompt_template,
        routeKey ?? null,
      );
      const result = renderBambooTemplate(template, bambooTemplateVariables(payload, extra), { nonce });
      return { text: result.text, truncated: result.truncated };
    }

    const template = resolvePromptTemplate(
      this.promptTemplateMapFor(hook) as JiraPromptTemplateMapEntry[],
      hook.prompt_template,
      routeKey ?? null,
    );
    const result = renderJiraTemplate(template, jiraTemplateVariables(payload, extra), { nonce });
    return { text: result.text, truncated: result.truncated };
  }

  // -------------------------------------------------------------------------
  // Caps
  // -------------------------------------------------------------------------

  /**
   * Why this delivery cannot start right now, or null if it can.
   *
   * `selfId` is excluded from every count, and that exclusion is load-bearing.
   * Unlike a cron firing, a delivery's own row is inserted *before* the caps are
   * checked — it has to be, because the insert is the idempotency claim — so a
   * row in `starting` with no session yet is this very delivery. Counting it
   * would make every single delivery throttle itself.
   */
  private capReason(hook: WebhookRow, selfId: string): string | null {
    const mine = readActiveWebhookDeliveries(this.db, hook.id).filter(
      (d) => d.id !== selfId && this.isRunActive(d),
    ).length;
    if (mine >= hook.max_concurrent) {
      return `This webhook already has ${mine} run${mine === 1 ? '' : 's'} in progress (limit ${hook.max_concurrent}).`;
    }

    const budget = Math.max(1, this.opts.maxSessions - RESERVED_HUMAN_SESSIONS);
    // Counted across every webhook, minus this delivery's own row.
    const others = Math.max(0, countActiveWebhookDeliveries(this.db) - 1);
    if (others >= budget) {
      return `Webhook runs are capped at ${budget} so ${RESERVED_HUMAN_SESSIONS} session slots stay free for you.`;
    }
    return null;
  }

  /**
   * A row with no session yet counts as active: nothing escapes `startRun` with
   * the row open, so this is a delivery still mid-composite.
   */
  private isRunActive(row: WebhookDeliveryRow): boolean {
    // PA-10: a pocket run has no session, so the "no session yet" shortcut
    // below would make one look active forever — including one parked on an
    // approval that nobody will ever answer after a restart. Liveness for a
    // pocket run is asked of the executor instead, which is still the *session*
    // discipline (ask, never time out), just of the only thing there is to ask.
    if (row.planner_chat_id !== null) return this.executor.isPocketRunAlive(row.id);
    return row.session_id === null || this.executor.isAlive(row.session_id);
  }

  /**
   * As `capReason`, this must exclude the delivery doing the asking.
   *
   * Queued rows count as active here, and deliberately *not* in `capReason`.
   * The two questions differ: a cap asks "how much is running" (a waiter runs
   * nothing and holds no session, so counting it would let a queue throttle
   * itself), while the overlap policy asks "is there already work for this
   * conversation" — and a `skip` webhook whose previous delivery is merely
   * *waiting* must still skip, or a third delivery would jump the line and run
   * ahead of the one already in it.
   */
  private hasActiveRunFor(
    hook: WebhookRow,
    conversationKey: string,
    selfId: string,
  ): boolean {
    const rows = [
      ...readActiveWebhookDeliveries(this.db, hook.id),
      ...readQueuedWebhookDeliveries(this.db, hook.id),
    ].filter((d) => d.id !== selfId && (d.status === 'queued' || this.isRunActive(d)));
    if (hook.conversation_mode !== 'per-issue') return rows.length > 0;
    return rows.some((d) => d.issue_key === conversationKey);
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  private verify(
    hook: WebhookRow,
    input: { rawBody: Buffer; signatureHeader: string | null; bearerToken: string | null },
  ): { state: WebhookSignatureState } {
    if (hook.auth_mode === 'bearer') {
      if (input.bearerToken === null || hook.auth_token_hash === null) return { state: 'missing' };
      return {
        state: safeTokenEqual(hook.auth_token_hash, sha256(Buffer.from(input.bearerToken, 'utf8')))
          ? 'valid'
          : 'invalid',
      };
    }

    if (input.signatureHeader === null) return { state: 'missing' };
    const [algo, presented] = splitSignature(input.signatureHeader);
    if (algo !== 'sha256' || presented === '') return { state: 'invalid' };
    const expected = crypto
      .createHmac('sha256', hook.secret)
      .update(input.rawBody)
      .digest('hex');
    // `safeTokenEqual` sha256s both sides before comparing, which is exactly the
    // trick needed here: `timingSafeEqual` throws on a length mismatch, and
    // hashing first means a truncated or non-hex signature is a mismatch rather
    // than an exception, and leaks no length.
    return { state: safeTokenEqual(expected, presented.toLowerCase()) ? 'valid' : 'invalid' };
  }

  // -------------------------------------------------------------------------
  // Row helpers
  // -------------------------------------------------------------------------

  private blankRow(hook: WebhookRow, id: string): WebhookDeliveryRow {
    return {
      id,
      webhook_id: hook.id,
      webhook_name: hook.name,
      agent: hook.agent,
      status: 'starting',
      trigger: 'delivery',
      body_hash: null,
      delivery_header: null,
      event: null,
      event_type: null,
      issue_key: null,
      project_key: null,
      actor: null,
      signature_state: 'skipped',
      // Copied now, so history records what this delivery actually ran with even
      // after the toggle is changed.
      skip_permissions_enabled: hook.skip_permissions,
      payload_json: null,
      payload_bytes: 0,
      payload_truncated: 0,
      rendered_prompt: null,
      reason: null,
      received_at: this.now(),
      started_at: null,
      finished_at: null,
      session_id: null,
      agent_session_id: null,
      planner_chat_id: null,
      cwd: null,
      error: null,
      queue_key: null,
      queued_at: null,
      queued_spec_json: null,
    };
  }

  /**
   * Record a call that matched no runnable webhook — an unknown slug, or a
   * real one that is disabled. Never allowed to throw: this runs on the one
   * unauthenticated route in the server, right before an identical 404 either
   * way, and a logging failure here must not turn that into a 500 — nothing
   * may answer 5xx once the body has been read.
   *
   * No payload, signature or header is stored, only the slug (truncated —
   * there is no length cap upstream, and the caller controls this string
   * entirely) and, when `hook` is a real-but-disabled webhook, which one.
   */
  private recordHit(rawSlug: string, hook: WebhookRow | null): void {
    try {
      insertWebhookHit(this.db, {
        id: crypto.randomUUID(),
        slug: sanitizeSlugForLog(rawSlug),
        webhook_id: hook?.id ?? null,
        webhook_name: hook?.name ?? null,
        reason: hook === null ? 'unknown_slug' : 'disabled',
        received_at: this.now(),
      });
    } catch (err) {
      this.opts.logger?.warn({ err }, 'failed to record an unmatched webhook hit');
    }
  }

  /** Insert an already-terminal delivery (rejected / invalid). */
  private recordTerminal(
    hook: WebhookRow,
    d: {
      status: WebhookDeliveryStatus;
      signatureState: WebhookSignatureState;
      reason: string;
      payload: string | null;
      payloadBytes: number;
      deliveryHeader: string | null;
      bodyHash: string | null;
    },
  ): string {
    const id = crypto.randomUUID();
    const now = this.now();
    try {
      insertWebhookDelivery(this.db, {
        ...this.blankRow(hook, id),
        status: d.status,
        signature_state: d.signatureState,
        reason: d.reason,
        payload_json: d.payload,
        payload_bytes: d.payloadBytes,
        body_hash: d.bodyHash,
        delivery_header: d.deliveryHeader,
        received_at: now,
        finished_at: now,
      });
    } catch (err) {
      // A duplicate here is not worth failing the response over: the point of
      // the row is the audit trail, and one already exists.
      if (!isUniqueViolation(err)) throw err;
      return id;
    }
    updateWebhook(this.db, hook.id, {
      last_delivery_at: now,
      last_delivery_status: d.status,
      last_error: d.reason,
    });
    return id;
  }

  private invalid(
    hook: WebhookRow,
    input: { rawBody: Buffer; deliveryHeader: string | null },
    reason: string,
  ): DeliveryOutcome {
    const id = this.recordTerminal(hook, {
      status: 'invalid',
      signatureState: 'valid',
      reason,
      payload: this.storablePayloadRaw(hook, input.rawBody),
      payloadBytes: input.rawBody.byteLength,
      deliveryHeader: input.deliveryHeader,
      bodyHash: sha256(input.rawBody),
    });
    return { status: 'invalid', httpStatus: 400, deliveryId: id, sessionId: null, reason, duplicate: false };
  }

  private storablePayload(hook: WebhookRow, payload: unknown): string | null {
    if (hook.store_payloads !== 1) return null;
    const scrubbed = scrubSecrets(payload);
    const json = JSON.stringify(scrubbed, null, 2) ?? '';
    return json.length > MAX_STORED_PAYLOAD_BYTES ? json.slice(0, MAX_STORED_PAYLOAD_BYTES) : json;
  }

  private storablePayloadRaw(hook: WebhookRow, raw: Buffer): string | null {
    if (hook.store_payloads !== 1) return null;
    return raw.toString('utf8').slice(0, MAX_STORED_PAYLOAD_BYTES);
  }

  private filterFor(hook: WebhookRow): JiraWebhookFilter | BambooWebhookFilter {
    try {
      const parsed = JSON.parse(hook.filter_json);
      const schema = hook.type === 'bamboo' ? BambooWebhookFilterSchema : JiraWebhookFilterSchema;
      const result = schema.safeParse(parsed);
      return result.success ? result.data : {};
    } catch {
      // A filter we cannot read must not become "match everything": that would
      // turn a storage bug into an agent storm. An empty object is the same
      // thing, so the safe reading is the *opposite* — but there is no way to
      // express "block" here, so log loudly and treat it as unfiltered, which is
      // what the row literally says.
      this.opts.logger?.warn({ webhook: hook.id }, 'webhook filter JSON is unreadable');
      return {};
    }
  }

  /**
   * `project_map_json` holds `JiraProjectMapEntry[]` (`{ projectKey, cwd }`)
   * for a `type: 'jira'` webhook, or `BambooPlanMapEntry[]` (`{ planKey, cwd }`)
   * for `type: 'bamboo'` — the same column, reused rather than migrated (see
   * `db/index.ts`'s doc comment on the column).
   */
  private routeMapFor(hook: WebhookRow): JiraProjectMapEntry[] | BambooPlanMapEntry[] {
    try {
      const parsed = JSON.parse(hook.project_map_json) as unknown;
      return Array.isArray(parsed)
        ? (parsed as JiraProjectMapEntry[] | BambooPlanMapEntry[])
        : [];
    } catch {
      // Same reasoning as `filterFor`: an unreadable map must not silently
      // become "no routing", which would run every project/plan in `hook.cwd`
      // — but there is no way to express "block everything" here either, so
      // log loudly and treat it as unrouted, which is what the row literally
      // says.
      this.opts.logger?.warn({ webhook: hook.id }, 'webhook route map JSON is unreadable');
      return [];
    }
  }

  private promptTemplateMapFor(
    hook: WebhookRow,
  ): JiraPromptTemplateMapEntry[] | BambooPromptTemplateMapEntry[] {
    try {
      const parsed = JSON.parse(hook.prompt_template_map_json) as unknown;
      return Array.isArray(parsed)
        ? (parsed as JiraPromptTemplateMapEntry[] | BambooPromptTemplateMapEntry[])
        : [];
    } catch {
      this.opts.logger?.warn({ webhook: hook.id }, 'webhook prompt template map JSON is unreadable');
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Public API used by the routes
  // -------------------------------------------------------------------------

  list(): WebhookRow[] {
    return readWebhooks(this.db);
  }

  get(id: string): WebhookRow {
    const row = readWebhook(this.db, id);
    if (row === null) throw new WebhookServiceError('No such webhook.', 'not_found', 404);
    return row;
  }

  create(spec: WebhookSpec): { row: WebhookRow; secret: string; token?: string } {
    const now = this.now();
    const existing = readWebhookBySlug(this.db, spec.slug);
    if (existing !== null) {
      throw new WebhookServiceError('That path is already in use.', 'slug_taken', 409);
    }
    const secret = newSecret();
    const token = spec.authMode === 'bearer' ? newSecret() : undefined;
    const id = crypto.randomUUID();

    insertWebhook(this.db, {
      id,
      name: spec.name,
      slug: spec.slug.toLowerCase(),
      enabled: spec.enabled ? 1 : 0,
      type: spec.type,
      auth_mode: spec.authMode,
      secret,
      auth_token_hash: token !== undefined ? sha256(Buffer.from(token, 'utf8')) : null,
      secret_set_at: now,
      filter_json: JSON.stringify(spec.filter),
      project_map_json: JSON.stringify(spec.type === 'bamboo' ? spec.planMap : spec.projectMap),
      prompt_template_map_json: JSON.stringify(spec.promptTemplateMap ?? []),
      cwd: spec.cwd,
      agent: spec.agent,
      worktree_mode: spec.worktreeMode,
      model: spec.model,
      effort: spec.effort ?? null,
      effort_set: 'effort' in spec ? 1 : 0,
      skip_permissions: spec.skipPermissions ? 1 : 0,
      auto_select_agent_model: spec.autoSelectAgentModel ? 1 : 0,
      prompt_template: spec.promptTemplate,
      conversation_mode: spec.conversationMode,
      overlap_policy: spec.overlapPolicy,
      directory_policy: spec.directoryPolicy,
      max_concurrent: spec.maxConcurrent,
      store_payloads: spec.storePayloads ? 1 : 0,
      created_at: now,
      updated_at: now,
      last_delivery_at: null,
      last_delivery_status: null,
      last_error: null,
    });

    return { row: this.get(id), secret, ...(token !== undefined ? { token } : {}) };
  }

  update(id: string, patch: Partial<WebhookSpecCommon> & WebhookSpecConfigPatch): WebhookRow {
    const existing = this.get(id);
    if (patch.slug !== undefined && patch.slug.toLowerCase() !== existing.slug) {
      const clash = readWebhookBySlug(this.db, patch.slug);
      if (clash !== null && clash.id !== id) {
        throw new WebhookServiceError('That path is already in use.', 'slug_taken', 409);
      }
      this.opts.logger?.info(
        { webhook: id, from: existing.slug, to: patch.slug.toLowerCase() },
        'webhook path changed; upstream must be updated to match',
      );
    }

    // `routeMap` is generic on purpose: it lands in `project_map_json`
    // whichever provider's shape it is (`JiraProjectMapEntry[]` or
    // `BambooPlanMapEntry[]`) — see that column's doc comment in `db/index.ts`.
    updateWebhook(this.db, id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.slug !== undefined ? { slug: patch.slug.toLowerCase() } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled ? 1 : 0 } : {}),
      ...(patch.filter !== undefined ? { filter_json: JSON.stringify(patch.filter) } : {}),
      ...(patch.routeMap !== undefined
        ? { project_map_json: JSON.stringify(patch.routeMap) }
        : {}),
      ...(patch.promptTemplateMap !== undefined
        ? { prompt_template_map_json: JSON.stringify(patch.promptTemplateMap) }
        : {}),
      ...(patch.authMode !== undefined ? { auth_mode: patch.authMode } : {}),
      ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
      ...(patch.agent !== undefined ? { agent: patch.agent } : {}),
      ...(patch.worktreeMode !== undefined ? { worktree_mode: patch.worktreeMode } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...('effort' in patch ? { effort: patch.effort ?? null, effort_set: 1 } : {}),
      ...(patch.skipPermissions !== undefined
        ? { skip_permissions: patch.skipPermissions ? 1 : 0 }
        : {}),
      ...(patch.autoSelectAgentModel !== undefined
        ? { auto_select_agent_model: patch.autoSelectAgentModel ? 1 : 0 }
        : {}),
      ...(patch.promptTemplate !== undefined ? { prompt_template: patch.promptTemplate } : {}),
      ...(patch.conversationMode !== undefined
        ? { conversation_mode: patch.conversationMode }
        : {}),
      ...(patch.overlapPolicy !== undefined ? { overlap_policy: patch.overlapPolicy } : {}),
      ...(patch.directoryPolicy !== undefined ? { directory_policy: patch.directoryPolicy } : {}),
      ...(patch.maxConcurrent !== undefined ? { max_concurrent: patch.maxConcurrent } : {}),
      ...(patch.storePayloads !== undefined
        ? { store_payloads: patch.storePayloads ? 1 : 0 }
        : {}),
      updated_at: this.now(),
    });
    return this.get(id);
  }

  /** Deleting keeps delivery history, the same discipline `cron_runs` records. */
  remove(id: string): { deliveriesKept: number } {
    const kept = readWebhookDeliveries(this.db, { webhookId: id, limit: 1_000_000 }).length;
    this.get(id);
    deleteWebhook(this.db, id);
    return { deliveriesKept: kept };
  }

  clearDeliveries(id: string): { removed: number } {
    this.get(id);
    // Take any waiters out of the queue *before* their rows go, or the queue
    // keeps a grant for work whose row no longer exists, and the tree stays
    // blocked. `cancel` reports through the store, which closes the row out —
    // harmless here, since the row is about to be deleted anyway.
    for (const row of readQueuedWebhookDeliveries(this.db, id)) this.queue.cancel(row.id);
    return { removed: deleteWebhookDeliveriesFor(this.db, id) };
  }

  /** Regenerate the secret. No grace period — see the editor's warning. */
  rotateSecret(id: string): { secret: string; token?: string; secretSetAt: number } {
    const hook = this.get(id);
    const secret = newSecret();
    const token = hook.auth_mode === 'bearer' ? newSecret() : undefined;
    const now = this.now();
    updateWebhook(this.db, id, {
      secret,
      auth_token_hash: token !== undefined ? sha256(Buffer.from(token, 'utf8')) : null,
      secret_set_at: now,
      updated_at: now,
    });
    this.opts.logger?.info({ webhook: id }, 'webhook secret rotated');
    return { secret, ...(token !== undefined ? { token } : {}), secretSetAt: now };
  }

  revealSecret(id: string): { secret: string; secretSetAt: number } {
    const hook = this.get(id);
    this.opts.logger?.info({ webhook: id }, 'webhook secret revealed');
    return { secret: hook.secret, secretSetAt: hook.secret_set_at };
  }

  deliveries(opts: {
    webhookId?: string;
    limit: number;
    includeNoise?: boolean;
  }): WebhookDeliveryRow[] {
    return readWebhookDeliveries(this.db, opts);
  }

  delivery(id: string): WebhookDeliveryRow {
    const row = readWebhookDelivery(this.db, id);
    if (row === null) throw new WebhookServiceError('No such delivery.', 'not_found', 404);
    return row;
  }

  /**
   * Run a payload through the identical pipeline with auth skipped.
   *
   * The `runNow` analogue, and essential: without it the only way to debug a
   * filter or a template is to make Jira send something, which is a slow loop
   * through someone else's admin UI.
   */
  async test(id: string, rawPayload?: string): Promise<DeliveryOutcome> {
    const hook = this.get(id);
    const type = hook.type as WebhookType;
    const text = rawPayload ?? JSON.stringify(type === 'bamboo' ? BAMBOO_SAMPLE_PAYLOAD : JIRA_SAMPLE_PAYLOAD);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new WebhookServiceError('That is not valid JSON.', 'invalid_filter');
    }
    const parsed = type === 'bamboo' ? parseBambooEvent(payload) : parseJiraEvent(payload);
    if (!parsed.ok) throw new WebhookServiceError(parsed.reason, 'invalid_filter');
    const row = deliveryRowFieldsOf(type, parsed.facts);

    const deliveryId = crypto.randomUUID();
    insertWebhookDelivery(this.db, {
      ...this.blankRow(hook, deliveryId),
      status: 'starting',
      trigger: 'test',
      // Null body hash, so a test never collides with a real delivery and two
      // tests of the same payload both run.
      body_hash: null,
      signature_state: 'skipped',
      event: row.event,
      event_type: row.eventType,
      issue_key: row.issueKey,
      project_key: row.projectKey,
      actor: row.actor,
      payload_json: this.storablePayload(hook, payload),
      payload_bytes: Buffer.byteLength(text, 'utf8'),
      received_at: this.now(),
    });
    return this.dispatch(hook, deliveryId, parsed.facts, payload);
  }

  /** Render without running, for the editor's preview. */
  preview(
    id: string,
    opts: { payload?: string; promptTemplate?: string },
  ): { prompt: string; missing: string[]; truncated: boolean; filteredReason: string | null } {
    const hook = this.get(id);
    const type = hook.type as WebhookType;
    const text =
      opts.payload ?? this.lastPayloadFor(id) ?? JSON.stringify(type === 'bamboo' ? BAMBOO_SAMPLE_PAYLOAD : JIRA_SAMPLE_PAYLOAD);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new WebhookServiceError('That is not valid JSON.', 'invalid_filter');
    }

    if (type === 'bamboo') {
      const parsed = parseBambooEvent(payload);
      const template =
        opts.promptTemplate ??
        resolvePromptTemplateByBuildState(
          this.promptTemplateMapFor(hook) as BambooPromptTemplateMapEntry[],
          hook.prompt_template,
          parsed.ok ? parsed.facts.buildState : null,
        );
      const rendered = renderBambooTemplate(
        template,
        bambooTemplateVariables(payload, { webhookName: hook.name, deliveryId: 'preview' }),
        { nonce: crypto.randomBytes(8).toString('hex') },
      );
      const filteredReason = !parsed.ok
        ? parsed.reason
        : (() => {
            const v = evaluateBambooFilter(this.filterFor(hook) as BambooWebhookFilter, parsed.facts);
            if (!v.matched) return v.reason;
            const r = resolvePlanRoute(
              this.routeMapFor(hook) as { planKey: string; cwd: string }[],
              hook.cwd,
              parsed.facts.planKey,
            );
            return r.matched ? null : r.reason;
          })();
      return { prompt: rendered.text, missing: rendered.missing, truncated: rendered.truncated, filteredReason };
    }

    const parsed = parseJiraEvent(payload);
    const template =
      opts.promptTemplate ??
      resolvePromptTemplate(
        this.promptTemplateMapFor(hook) as JiraPromptTemplateMapEntry[],
        hook.prompt_template,
        parsed.ok ? parsed.facts.issueType : null,
      );
    const rendered = renderJiraTemplate(
      template,
      jiraTemplateVariables(payload, { webhookName: hook.name, deliveryId: 'preview' }),
      { nonce: crypto.randomBytes(8).toString('hex') },
    );
    const filteredReason = !parsed.ok
      ? parsed.reason
      : (() => {
          const v = evaluateJiraFilter(this.filterFor(hook) as JiraWebhookFilter, parsed.facts);
          if (!v.matched) return v.reason;
          const r = resolveProjectRoute(
            this.routeMapFor(hook) as { projectKey: string; cwd: string }[],
            hook.cwd,
            parsed.facts.projectKey,
          );
          return r.matched ? null : r.reason;
        })();
    return {
      prompt: rendered.text,
      missing: rendered.missing,
      truncated: rendered.truncated,
      filteredReason,
    };
  }

  private lastPayloadFor(webhookId: string): string | null {
    const rows = readWebhookDeliveries(this.db, { webhookId, limit: 20 });
    return rows.find((r) => r.payload_json !== null)?.payload_json ?? null;
  }

  // -------------------------------------------------------------------------
  // DTO mapping
  // -------------------------------------------------------------------------

  toWebhook(row: WebhookRow): Webhook {
    const type = row.type as WebhookType;
    const filter = this.filterFor(row);
    const routeMap = this.routeMapFor(row);
    const promptTemplateMap = this.promptTemplateMapFor(row);
    const workspaceLabel =
      routeMap.length > 0 ? 'Auto-mapped' : this.opts.workspaces.labelFor(row.cwd);
    const config: Webhook['config'] =
      type === 'bamboo'
        ? {
            type: 'bamboo',
            filter: filter as BambooWebhookFilter,
            planMap: routeMap as BambooPlanMapEntry[],
            promptTemplateMap: promptTemplateMap as BambooPromptTemplateMapEntry[],
          }
        : {
            type: 'jira',
            filter: filter as JiraWebhookFilter,
            projectMap: routeMap as JiraProjectMapEntry[],
            promptTemplateMap: promptTemplateMap as JiraPromptTemplateMapEntry[],
          };
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      enabled: row.enabled === 1,
      type,
      deliveryPath: `/api/hooks/${row.slug}`,
      authMode: row.auth_mode as WebhookAuthMode,
      hasToken: row.auth_token_hash !== null,
      secretSetAt: row.secret_set_at,
      config,
      cwd: row.cwd,
      workspaceLabel,
      agent: row.agent,
      agentDisplayName: this.agentDisplayName(row.agent),
      worktreeMode: row.worktree_mode as 'none' | 'new-branch' | 'current-branch',
      model: row.model,
      ...(row.effort_set === 1 ? { effort: row.effort } : {}),
      skipPermissionsEnabled: row.skip_permissions === 1,
      autoSelectAgentModel: row.auto_select_agent_model === 1,
      promptTemplate: row.prompt_template,
      conversationMode: row.conversation_mode as WebhookConversationMode,
      overlapPolicy: row.overlap_policy as WebhookOverlapPolicy,
      directoryPolicy: row.directory_policy as WebhookDirectoryPolicy,
      maxConcurrent: row.max_concurrent,
      storePayloads: row.store_payloads === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastDeliveryAt: row.last_delivery_at,
      lastDeliveryStatus: (row.last_delivery_status as WebhookDeliveryStatus | null) ?? null,
      lastError: row.last_error,
      deliveryCounts: this.countsFor(row.id),
    };
  }

  toDelivery(row: WebhookDeliveryRow): WebhookDelivery {
    return {
      id: row.id,
      webhookId: row.webhook_id,
      webhookName: row.webhook_name,
      agent: row.agent,
      status: row.status as WebhookDeliveryStatus,
      trigger: row.trigger as WebhookDeliveryTrigger,
      signatureState: row.signature_state as WebhookSignatureState,
      event: row.event,
      eventType: row.event_type,
      issueKey: row.issue_key,
      projectKey: row.project_key,
      actor: row.actor,
      reason: row.reason,
      skipPermissionsEnabled: row.skip_permissions_enabled === 1,
      payloadBytes: row.payload_bytes,
      payloadTruncated: row.payload_truncated === 1,
      receivedAt: row.received_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      sessionId: row.session_id,
      agentSessionId: row.agent_session_id,
      plannerChatId: row.planner_chat_id,
      cwd: row.cwd,
      error: row.error,
      queuedAt: row.queued_at,
      queueKey: row.queue_key,
      queuePosition: row.status === 'queued' ? this.queue.positionOf(row.id) : null,
    };
  }

  /**
   * PA-10: one place that turns a stored `agent` into something readable,
   * whichever value space it came from.
   *
   * A Pocket Agent falls back to its bare id when the planner workspace has
   * since been deleted, exactly as a coding agent falls back to its id when it
   * is no longer registered — an orphaned row still has to describe itself, the
   * same discipline `webhook_name` is copied for.
   */
  private agentDisplayName(agent: string): string {
    const plannerWorkspaceId = parsePocketAgentId(agent);
    if (plannerWorkspaceId !== null) {
      const workspace = this.opts.plannerWorkspaces.get(plannerWorkspaceId);
      return workspace ? `Pocket Agent · ${workspace.name}` : agent;
    }
    return this.opts.agents.get(agent)?.displayName ?? agent;
  }

  toDeliveryDetail(row: WebhookDeliveryRow): WebhookDeliveryDetail {
    return {
      ...this.toDelivery(row),
      payload: row.payload_json,
      renderedPrompt: row.rendered_prompt,
    };
  }

  toHit(row: WebhookHitLogRow): WebhookHit {
    return {
      id: row.id,
      slug: row.slug,
      webhookId: row.webhook_id,
      webhookName: row.webhook_name,
      reason: row.reason as WebhookHit['reason'],
      receivedAt: row.received_at,
    };
  }

  /**
   * One chronological feed across every webhook: real deliveries plus the
   * hits that never became one. `includeNoise: false` drops the hits
   * entirely, since every one of them is noise by the same definition
   * `NOISE_STATUSES` already uses for a delivery.
   *
   * Each side is fetched up to `limit` and then merged, rather than paged
   * together in one query — the two live in different tables with different
   * retention, and this is a UI list, not an API meant to paginate deeply.
   */
  history(opts: { limit: number; includeNoise: boolean }): { entries: WebhookHistoryEntry[] } {
    const deliveries: WebhookHistoryEntry[] = readWebhookDeliveries(this.db, {
      limit: opts.limit,
      includeNoise: opts.includeNoise,
    }).map((row) => ({ kind: 'delivery' as const, ...this.toDelivery(row) }));

    const hits: WebhookHistoryEntry[] = opts.includeNoise
      ? readWebhookHits(this.db, { limit: opts.limit }).map((row) => ({
          kind: 'hit' as const,
          ...this.toHit(row),
        }))
      : [];

    return {
      entries: [...deliveries, ...hits]
        .sort((a, b) => b.receivedAt - a.receivedAt)
        .slice(0, opts.limit),
    };
  }

  countsFor(webhookId: string): WebhookDeliveryCounts {
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM webhook_deliveries
          WHERE webhook_id = ? GROUP BY status`,
      )
      .all(webhookId) as { status: string; n: number }[];
    const by = new Map(rows.map((r) => [r.status, r.n]));
    const sum = (...keys: string[]): number => keys.reduce((n, k) => n + (by.get(k) ?? 0), 0);
    return {
      total: rows.reduce((n, r) => n + r.n, 0),
      ran: sum('starting', 'running', 'succeeded', 'failed'),
      filtered: sum('filtered', 'duplicate', 'throttled', 'skipped'),
      rejected: sum('rejected', 'invalid'),
      // Its own bucket, in neither `ran` nor `filtered`: a waiter has not run
      // and was not turned away.
      queued: sum('queued'),
    };
  }

}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function accepted(
  status: WebhookDeliveryStatus,
  deliveryId: string,
  reason: string,
): DeliveryOutcome {
  // 202, not an error: the webhook did exactly what it was configured to do.
  return { status, httpStatus: 202, deliveryId, sessionId: null, reason, duplicate: false };
}

function notFound(): DeliveryOutcome {
  return {
    status: 'rejected',
    httpStatus: 404,
    deliveryId: null,
    sessionId: null,
    reason: null,
    duplicate: false,
  };
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Bound and clean an attacker-controlled slug before it is persisted. There is
 * no length cap on the `:slug` URL segment upstream, and control characters
 * would render confusingly (or worse, oddly) in a list built to be read by a
 * human — not a security boundary, just the same "don't store more than the
 * point of the row needs" discipline `storablePayload` already applies.
 */
function sanitizeSlugForLog(slug: string): string {
  // Built without a regex escape range, deliberately: a literal control-
  // character range is easy to mistype into something else entirely, and
  // this reads unambiguously as "printable ASCII only, DEL excluded".
  let out = '';
  for (const ch of slug) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out.slice(0, MAX_STORED_SLUG_LENGTH);
}

/** 32 bytes of base64url — long enough that a slug leak is not a secret leak. */
function newSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Do the same amount of work for an unknown slug as for a known one.
 *
 * Without this, an unknown slug returns before any HMAC is computed and the
 * response time answers the question the 404 refuses to.
 */
const DUMMY_KEY = crypto.randomBytes(32);
function verifyAgainstDummyKey(body: Buffer): void {
  crypto.createHmac('sha256', DUMMY_KEY).update(body).digest('hex');
}

function splitSignature(header: string): [string, string] {
  const eq = header.indexOf('=');
  if (eq < 0) return ['', ''];
  return [header.slice(0, eq).trim().toLowerCase(), header.slice(eq + 1).trim()];
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

/**
 * Strip secret-shaped keys before a payload is persisted.
 *
 * Jira payloads carry custom fields, and a marketplace plugin can put anything
 * in one — including a token that then sits in our database because we stored
 * the body verbatim for debugging.
 */
function scrubSecrets(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[too deep]';
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_ISH_KEY.test(k) ? '[scrubbed]' : scrubSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}

export { DEFAULT_JIRA_PROMPT_TEMPLATE, DEFAULT_BAMBOO_PROMPT_TEMPLATE };
