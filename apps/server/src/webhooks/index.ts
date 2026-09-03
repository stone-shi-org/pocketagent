import crypto from 'node:crypto';
import type {
  JiraProjectMapEntry,
  JiraWebhookFilter,
  Webhook,
  WebhookAuthMode,
  WebhookConversationMode,
  WebhookDelivery,
  WebhookDeliveryCounts,
  WebhookDeliveryDetail,
  WebhookDeliveryStatus,
  WebhookDeliveryTrigger,
  WebhookHistoryEntry,
  WebhookHit,
  WebhookSignatureState,
  WebhookSummary,
} from '@pocketagent/protocol';
import {
  DEFAULT_JIRA_PROMPT_TEMPLATE,
  JIRA_SAMPLE_PAYLOAD,
  JiraWebhookFilter as JiraWebhookFilterSchema,
  jiraTemplateVariables,
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
import type { RunSink, RunSpec } from '../runs/executor.js';
import { RunExecutor, mintBranchName } from '../runs/executor.js';
import type { JiraEventFacts } from './jira.js';
import {
  describeJiraFilter,
  evaluateJiraFilter,
  parseJiraEvent,
  resolveProjectRoute,
} from './jira.js';

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
  /** Ceiling shared with interactive sessions; the reservation is carved from it. */
  maxSessions: number;
  logger?: {
    info: (o: object, m?: string) => void;
    warn: (o: object, m?: string) => void;
  };
  /** Injectable for tests, so delivery behaviour is checkable without waiting. */
  now?: () => number;
}

/** The fields a create/update accepts, already normalized by the route. */
export interface WebhookSpec {
  name: string;
  slug: string;
  enabled: boolean;
  type: 'jira';
  filter: JiraWebhookFilter;
  projectMap: JiraProjectMapEntry[];
  authMode: WebhookAuthMode;
  cwd: string;
  agent: string;
  worktreeMode: 'none' | 'new-branch' | 'current-branch';
  model: string | null;
  effort?: string | null;
  skipPermissions: boolean;
  promptTemplate: string;
  conversationMode: WebhookConversationMode;
  overlapPolicy: 'skip' | 'allow';
  maxConcurrent: number;
  debounceSeconds: number;
  storePayloads: boolean;
}

/** What the delivery route needs back to answer the request. */
export interface DeliveryOutcome {
  status: WebhookDeliveryStatus;
  httpStatus: number;
  deliveryId: string | null;
  sessionId: string | null;
  reason: string | null;
  duplicate: boolean;
}

export class WebhookService {
  private timer: NodeJS.Timeout | null = null;
  private readonly db: Db;
  private readonly executor: RunExecutor;
  /**
   * Pending debounce timers, keyed by `webhookId:issueKey`.
   *
   * In memory rather than in the database because a debounce is a *delay*, not a
   * commitment: if the server restarts inside the window the right answer is to
   * drop it, not to fire a burst of stale runs at boot for the same reason the
   * cron scheduler refuses to catch up on a backlog.
   */
  private readonly debounced = new Map<string, NodeJS.Timeout>();

  constructor(private readonly opts: WebhookServiceOptions) {
    this.db = opts.db;
    this.executor = new RunExecutor({
      sessions: opts.sessions,
      workspaces: opts.workspaces,
      worktrees: opts.worktrees,
      label: 'webhook delivery',
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
  }

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
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Stop sweeping and close out anything in flight. Called before session shutdown. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const timer of this.debounced.values()) clearTimeout(timer);
    this.debounced.clear();
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
        if (row.session_id === null) continue;
        if (this.executor.isAlive(row.session_id)) continue;
        this.settleDelivery(
          row.id,
          row.webhook_id,
          'failed',
          row.error ?? 'The session ended before the delivery completed.',
        );
      }
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

    const parsed = parseJiraEvent(payload);
    if (!parsed.ok) return this.invalid(hook, input, parsed.reason);
    const facts = parsed.facts;

    // 4. Freshness, from the signed body. Skew is logged, because a silent clock
    //    check is indistinguishable from the feature being broken.
    if (facts.timestamp !== null) {
      const skew = this.now() - facts.timestamp;
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
        event: facts.event,
        event_type: facts.eventType,
        issue_key: facts.issueKey,
        project_key: facts.projectKey,
        actor: facts.actor,
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
    facts: JiraEventFacts,
    payload: unknown,
  ): Promise<DeliveryOutcome> {
    // 6. Filter. A non-match is a success that started nothing.
    const verdict = evaluateJiraFilter(this.filterFor(hook), facts);
    if (!verdict.matched) {
      this.closeDelivery(hook, deliveryId, 'filtered', verdict.reason);
      return accepted('filtered', deliveryId, verdict.reason);
    }

    // 6b. Route by project. An empty map always resolves to `hook.cwd`; a
    // non-empty one filters a project nobody mapped rather than guessing.
    const route = resolveProjectRoute(this.projectMapFor(hook), hook.cwd, facts.projectKey);
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

    const conversationKey =
      hook.conversation_mode === 'per-issue' ? facts.issueKey : `hook:${hook.id}`;
    if (hook.overlap_policy === 'skip' && this.hasActiveRunFor(hook, conversationKey, deliveryId)) {
      const reason =
        hook.conversation_mode === 'per-issue'
          ? `A run for ${facts.issueKey} was still in progress.`
          : 'The previous run for this webhook was still in progress.';
      this.closeDelivery(hook, deliveryId, 'skipped', reason);
      return accepted('skipped', deliveryId, reason);
    }

    // 8. Render, then run.
    const prompt = this.renderPrompt(hook, deliveryId, payload);
    updateWebhookDelivery(this.db, deliveryId, {
      rendered_prompt: prompt.text,
      payload_truncated: prompt.truncated ? 1 : 0,
    });

    const started = await this.startRun(hook, deliveryId, facts, prompt.text, route.cwd);
    return {
      status: started.sessionId !== null ? 'running' : 'failed',
      httpStatus: 202,
      deliveryId,
      sessionId: started.sessionId,
      reason: started.error,
      duplicate: false,
    };
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
    facts: JiraEventFacts,
    prompt: string,
    cwd: string,
  ): Promise<{ sessionId: string | null; error: string | null }> {
    const startedAt = this.now();
    updateWebhookDelivery(this.db, deliveryId, { started_at: startedAt });
    const sink = this.sinkFor(hook, deliveryId, facts.issueKey, startedAt, cwd);

    if (hook.conversation_mode === 'per-issue') {
      const mapped = readWebhookIssueSession(this.db, hook.id, facts.issueKey);
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
          return { sessionId: ok ? mapped.session_id : null, error: null };
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
            ...this.specFor(hook, facts.issueKey, cwd),
            reuseCwd: mapped.cwd,
            resume: { agentSessionId: mapped.agent_session_id },
            prompt,
          },
          sink,
        );
        return outcome.ok
          ? { sessionId: outcome.sessionId, error: null }
          : { sessionId: null, error: outcome.error };
      }
    }

    const outcome = await this.executor.start(
      deliveryId,
      { ...this.specFor(hook, facts.issueKey, cwd), prompt },
      sink,
    );
    return outcome.ok
      ? { sessionId: outcome.sessionId, error: null }
      : { sessionId: null, error: outcome.error };
  }

  private sinkFor(
    hook: WebhookRow,
    deliveryId: string,
    issueKey: string,
    startedAt: number,
    resolvedCwd: string,
  ): RunSink {
    const remember = (patch: { sessionId?: string; agentSessionId?: string; cwd?: string }): void => {
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

  private specFor(hook: WebhookRow, issueKey: string, cwd: string): Omit<RunSpec, 'prompt'> {
    const worktree: RunSpec['worktree'] =
      hook.worktree_mode === 'new-branch'
        ? {
            mode: 'new-branch',
            // Minted from the *issue key*, not from untrusted text: a branch
            // name reaches git and the filesystem, and the key is the one
            // untrusted value validated against a pattern rather than escaped.
            branchName: mintBranchName(`${hook.name}-${issueKey}`, 'UTC', this.now(), 'webhook'),
          }
        : hook.worktree_mode === 'current-branch'
          ? { mode: 'current-branch' }
          : { mode: 'none' };

    return {
      cwd,
      agent: hook.agent,
      title: `${hook.name} · ${issueKey}`,
      skipPermissions: hook.skip_permissions === 1,
      model: hook.model,
      ...(hook.effort_set === 1 ? { effort: hook.effort } : {}),
      worktree,
      notStructuredMessage:
        'A webhook run needs a structured session, but a terminal one was created.',
    };
  }

  private renderPrompt(
    hook: WebhookRow,
    deliveryId: string,
    payload: unknown,
  ): { text: string; truncated: boolean } {
    const vars = jiraTemplateVariables(payload, {
      webhookName: hook.name,
      deliveryId,
    });
    // A fresh nonce per delivery: a fixed one would eventually appear in a Jira
    // description, and the fence would then be closable from inside.
    const result = renderJiraTemplate(hook.prompt_template, vars, {
      nonce: crypto.randomBytes(8).toString('hex'),
    });
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
    return row.session_id === null || this.executor.isAlive(row.session_id);
  }

  /** As `capReason`, this must exclude the delivery doing the asking. */
  private hasActiveRunFor(
    hook: WebhookRow,
    conversationKey: string,
    selfId: string,
  ): boolean {
    const rows = readActiveWebhookDeliveries(this.db, hook.id).filter(
      (d) => d.id !== selfId && this.isRunActive(d),
    );
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
      cwd: null,
      error: null,
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

  private filterFor(hook: WebhookRow): JiraWebhookFilter {
    try {
      const parsed = JiraWebhookFilterSchema.safeParse(JSON.parse(hook.filter_json));
      return parsed.success ? parsed.data : {};
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

  private projectMapFor(hook: WebhookRow): JiraProjectMapEntry[] {
    try {
      const parsed = JSON.parse(hook.project_map_json) as unknown;
      return Array.isArray(parsed) ? (parsed as JiraProjectMapEntry[]) : [];
    } catch {
      // Same reasoning as `filterFor`: an unreadable map must not silently
      // become "no routing", which would run every project in `hook.cwd` —
      // but there is no way to express "block everything" here either, so log
      // loudly and treat it as unrouted, which is what the row literally says.
      this.opts.logger?.warn({ webhook: hook.id }, 'webhook project map JSON is unreadable');
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
      project_map_json: JSON.stringify(spec.projectMap),
      cwd: spec.cwd,
      agent: spec.agent,
      worktree_mode: spec.worktreeMode,
      model: spec.model,
      effort: spec.effort ?? null,
      effort_set: 'effort' in spec ? 1 : 0,
      skip_permissions: spec.skipPermissions ? 1 : 0,
      prompt_template: spec.promptTemplate,
      conversation_mode: spec.conversationMode,
      overlap_policy: spec.overlapPolicy,
      max_concurrent: spec.maxConcurrent,
      debounce_seconds: spec.debounceSeconds,
      store_payloads: spec.storePayloads ? 1 : 0,
      created_at: now,
      updated_at: now,
      last_delivery_at: null,
      last_delivery_status: null,
      last_error: null,
    });

    return { row: this.get(id), secret, ...(token !== undefined ? { token } : {}) };
  }

  update(id: string, patch: Partial<WebhookSpec>): WebhookRow {
    const existing = this.get(id);
    if (patch.slug !== undefined && patch.slug.toLowerCase() !== existing.slug) {
      const clash = readWebhookBySlug(this.db, patch.slug);
      if (clash !== null && clash.id !== id) {
        throw new WebhookServiceError('That path is already in use.', 'slug_taken', 409);
      }
      this.opts.logger?.info(
        { webhook: id, from: existing.slug, to: patch.slug.toLowerCase() },
        'webhook path changed; Jira must be updated to match',
      );
    }

    updateWebhook(this.db, id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.slug !== undefined ? { slug: patch.slug.toLowerCase() } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled ? 1 : 0 } : {}),
      ...(patch.filter !== undefined ? { filter_json: JSON.stringify(patch.filter) } : {}),
      ...(patch.projectMap !== undefined
        ? { project_map_json: JSON.stringify(patch.projectMap) }
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
      ...(patch.promptTemplate !== undefined ? { prompt_template: patch.promptTemplate } : {}),
      ...(patch.conversationMode !== undefined
        ? { conversation_mode: patch.conversationMode }
        : {}),
      ...(patch.overlapPolicy !== undefined ? { overlap_policy: patch.overlapPolicy } : {}),
      ...(patch.maxConcurrent !== undefined ? { max_concurrent: patch.maxConcurrent } : {}),
      ...(patch.debounceSeconds !== undefined ? { debounce_seconds: patch.debounceSeconds } : {}),
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
    const text = rawPayload ?? JSON.stringify(JIRA_SAMPLE_PAYLOAD);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new WebhookServiceError('That is not valid JSON.', 'invalid_filter');
    }
    const parsed = parseJiraEvent(payload);
    if (!parsed.ok) throw new WebhookServiceError(parsed.reason, 'invalid_filter');

    const deliveryId = crypto.randomUUID();
    insertWebhookDelivery(this.db, {
      ...this.blankRow(hook, deliveryId),
      status: 'starting',
      trigger: 'test',
      // Null body hash, so a test never collides with a real delivery and two
      // tests of the same payload both run.
      body_hash: null,
      signature_state: 'skipped',
      event: parsed.facts.event,
      event_type: parsed.facts.eventType,
      issue_key: parsed.facts.issueKey,
      project_key: parsed.facts.projectKey,
      actor: parsed.facts.actor,
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
    const text = opts.payload ?? this.lastPayloadFor(id) ?? JSON.stringify(JIRA_SAMPLE_PAYLOAD);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new WebhookServiceError('That is not valid JSON.', 'invalid_filter');
    }
    const parsed = parseJiraEvent(payload);
    const rendered = renderJiraTemplate(
      opts.promptTemplate ?? hook.prompt_template,
      jiraTemplateVariables(payload, { webhookName: hook.name, deliveryId: 'preview' }),
      { nonce: crypto.randomBytes(8).toString('hex') },
    );
    const filteredReason = !parsed.ok
      ? parsed.reason
      : (() => {
          const v = evaluateJiraFilter(this.filterFor(hook), parsed.facts);
          if (!v.matched) return v.reason;
          const r = resolveProjectRoute(this.projectMapFor(hook), hook.cwd, parsed.facts.projectKey);
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
    const filter = this.filterFor(row);
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      enabled: row.enabled === 1,
      type: 'jira',
      deliveryPath: `/api/hooks/${row.slug}`,
      authMode: row.auth_mode as WebhookAuthMode,
      hasToken: row.auth_token_hash !== null,
      secretSetAt: row.secret_set_at,
      config: { type: 'jira', filter, projectMap: this.projectMapFor(row) },
      cwd: row.cwd,
      workspaceLabel: this.opts.workspaces.labelFor(row.cwd),
      agent: row.agent,
      agentDisplayName: this.opts.agents.get(row.agent)?.displayName ?? row.agent,
      worktreeMode: row.worktree_mode as 'none' | 'new-branch' | 'current-branch',
      model: row.model,
      ...(row.effort_set === 1 ? { effort: row.effort } : {}),
      skipPermissionsEnabled: row.skip_permissions === 1,
      promptTemplate: row.prompt_template,
      conversationMode: row.conversation_mode as WebhookConversationMode,
      overlapPolicy: row.overlap_policy as 'skip' | 'allow',
      maxConcurrent: row.max_concurrent,
      debounceSeconds: row.debounce_seconds,
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
      cwd: row.cwd,
      error: row.error,
    };
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
    };
  }

  /**
   * For the home screen's project tree, keyed by cwd like `CronService`'s.
   *
   * A webhook can route to more than one directory now, so it is listed under
   * every one of them — `row.cwd` plus every mapped `cwd`, deduplicated — not
   * just its own. A directory that is only ever reached through the project
   * map is exactly the "configured but maybe never fired" case CLAUDE.md
   * already argues a webhook row must not hide.
   */
  summariesByCwd(): Map<string, WebhookSummary[]> {
    const out = new Map<string, WebhookSummary[]>();
    for (const row of readWebhooks(this.db)) {
      const summary: WebhookSummary = {
        id: row.id,
        name: row.name,
        enabled: row.enabled === 1,
        type: 'jira',
        triggerLabel: describeJiraFilter(this.filterFor(row)),
        lastDeliveryAt: row.last_delivery_at,
        lastDeliveryStatus: (row.last_delivery_status as WebhookDeliveryStatus | null) ?? null,
        skipPermissionsEnabled: row.skip_permissions === 1,
      };
      const cwds = new Set([row.cwd, ...this.projectMapFor(row).map((e) => e.cwd)]);
      for (const cwd of cwds) {
        const list = out.get(cwd) ?? [];
        list.push(summary);
        out.set(cwd, list);
      }
    }
    return out;
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

export { DEFAULT_JIRA_PROMPT_TEMPLATE };
