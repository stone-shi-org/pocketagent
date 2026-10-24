import type { WebhookRemoteState } from '@pocketagent/protocol';
import { HubDispatchError, type HubDispatchClient } from './hub-dispatch.js';

/**
 * PA-171: `RunExecutor`'s remote variant — a run that lives on *another* agent
 * server, started and watched through the Hub's `/mcp`.
 *
 * What stays the same is the contract with the caller: it reports through a
 * sink, never touches a table, and settles each run exactly once. What differs
 * is everything below that line, because the work is not here:
 *
 * - **Liveness is asked of the target, through the Hub, never inferred from a
 *   clock.** A run parked on an approval on that host is genuinely still
 *   running, so `awaiting_approval` keeps the delivery open with no timeout —
 *   the standing no-decay rule, enforced on a machine this process cannot see.
 * - **A wait is a short poll, not a long hold.** The Hub's `DispatchLimiter`
 *   counts wait calls in flight (three per host), and a 60-second held wait
 *   per remote run would lock the Fleet coordinator out of a busy host. So
 *   each `wait` asks with a one-second timeout and the loop sleeps between
 *   asks; a run settles at most one interval late, which a webhook can afford.
 * - **A transport failure is not the work failing.** The Hub restarting or a
 *   network blip says nothing about the session on the target, so the loop
 *   backs off and asks again; only an answer *from* the target (`ended`, a
 *   session that no longer exists) or routing being switched off settles it.
 * - **Waiting survives a restart.** The caller persists the ref before the
 *   loop starts, and `watch` is how a restarted server, or the 30 s sweep,
 *   picks an open run back up.
 */

export type RemoteStartSpec =
  | {
      kind: 'coding';
      hostId: string;
      cwd: string;
      agent: string;
      title: string;
      model: string | null;
      worktree: 'none' | 'new-branch';
      /** A readable base only; the target mints the branch name itself. */
      branchBase: string | null;
      prompt: string;
    }
  | {
      kind: 'pocket';
      hostId: string;
      pocketAgentId: string;
      title: string;
      modelId: string | null;
      prompt: string;
    }
  /** PA-26 on a remote host: another turn in a conversation already running there. */
  | { kind: 'follow-up'; hostId: string; ref: string; prompt: string };

export interface RemoteRunSink {
  /** The run exists on the target: its ref, and what the target said about it. */
  onRemoteRef(details: {
    ref: string;
    sessionId: string | null;
    chatId: string | null;
    cwd: string | null;
    state: WebhookRemoteState;
    /** What the target actually started it with — its own decision, not ours. */
    skipPermissionsEnabled: boolean | null;
  }): void;
  /** What the last wait reported, while the run is open. */
  onRemoteState(state: WebhookRemoteState): void;
  onSettled(status: 'succeeded' | 'failed', error: string | null): void;
}

export type RemoteStartOutcome =
  | { ok: true; ref: string }
  | {
      ok: false;
      error: string;
      /** A cap refused it (the target's, or the Hub's limiter): retryable as `throttled`. */
      throttled: boolean;
      /** The ref named a session or chat the target no longer has. */
      gone: boolean;
    };

export interface RemoteRunExecutorOptions {
  client: HubDispatchClient;
  /** How often to ask about a running or queued run. */
  pollMs?: number;
  /** How often to ask about a run parked on an approval — a human is the bottleneck. */
  approvalPollMs?: number;
  /** Cap on the transport-failure backoff. */
  maxBackoffMs?: number;
  /** Consecutive 401s from the Hub before the run is given up on. */
  maxRejections?: number;
  logger?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
}

const DEFAULT_POLL_MS = 10_000;
const DEFAULT_APPROVAL_POLL_MS = 30_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const DEFAULT_MAX_REJECTIONS = 10;

/**
 * The refusals that mean "a cap said not now", not "this cannot work". Matched
 * on the sentence each cap writes — the target's `McpWorkService` caps and the
 * Hub's `DispatchLimiter` — because that is all an MCP error carries back.
 */
const CAP_REFUSALS = [
  /already has \d+ live sessions/i,
  /MCP-started sessions are capped at/i,
  /already has \d+ dispatch or wait calls in flight/i,
];

const GONE = [/\bNo session\b/i, /\bNo Pocket Agent chat\b/i, /has finished and has no conversation to resume/i];

export function remoteCapRefusal(message: string): boolean {
  return CAP_REFUSALS.some((re) => re.test(message));
}

export class RemoteRunExecutor {
  private readonly waiting = new Map<string, AbortController>();
  private stopped = false;

  constructor(private readonly opts: RemoteRunExecutorOptions) {}

  /**
   * Start one run on its host and begin watching it. Resolves once the target
   * has answered the dispatch: `ok` with the ref (the sink has already had
   * `onRemoteRef`), or the refusal in words. Never settles the sink on
   * failure — the caller decides between `failed` and `throttled`.
   */
  async start(deliveryId: string, spec: RemoteStartSpec, sink: RemoteRunSink): Promise<RemoteStartOutcome> {
    let result: Record<string, unknown>;
    try {
      result = await this.opts.client.call(toolFor(spec), argsFor(spec), { timeoutMs: 90_000 });
    } catch (err) {
      const message = describe(spec.hostId, err);
      return {
        ok: false,
        error: message,
        throttled: err instanceof HubDispatchError && err.code === 'tool_error' && remoteCapRefusal(message),
        gone: err instanceof HubDispatchError && err.code === 'tool_error' && GONE.some((re) => re.test(message)),
      };
    }
    const ref = typeof result.ref === 'string' ? result.ref : null;
    if (ref === null || !/^(session|chat):.{1,200}$/.test(ref)) {
      return { ok: false, error: `${spec.hostId}: the Hub accepted the dispatch but returned no ref.`, throttled: false, gone: false };
    }
    sink.onRemoteRef({
      ref,
      sessionId: typeof result.sessionId === 'string' ? result.sessionId : null,
      chatId: typeof result.chatId === 'string' ? result.chatId : null,
      cwd: typeof result.cwd === 'string' ? result.cwd : null,
      state: result.state === 'queued' ? 'queued' : 'running',
      skipPermissionsEnabled: typeof result.skipPermissionsEnabled === 'boolean' ? result.skipPermissionsEnabled : null,
    });
    this.watch(deliveryId, spec.hostId, ref, sink);
    return { ok: true, ref };
  }

  /** Watch a run already dispatched. A second call for the same delivery is a no-op. */
  watch(deliveryId: string, hostId: string, ref: string, sink: RemoteRunSink): void {
    if (this.stopped || this.waiting.has(deliveryId)) return;
    const controller = new AbortController();
    this.waiting.set(deliveryId, controller);
    void this.loop(deliveryId, hostId, ref, sink, controller.signal).finally(() => {
      if (this.waiting.get(deliveryId) === controller) this.waiting.delete(deliveryId);
    });
  }

  isWaiting(deliveryId: string): boolean {
    return this.waiting.has(deliveryId);
  }

  /** Stop watching one run without settling it (its delivery was closed elsewhere). */
  forget(deliveryId: string): void {
    this.waiting.get(deliveryId)?.abort();
    this.waiting.delete(deliveryId);
  }

  /**
   * Stop every loop **without settling anything**: the work is on other
   * machines and outlives this process, and the next boot resumes waiting from
   * each row's stored ref.
   */
  stopAll(): void {
    this.stopped = true;
    for (const controller of this.waiting.values()) controller.abort();
    this.waiting.clear();
  }

  private async loop(
    deliveryId: string,
    hostId: string,
    ref: string,
    sink: RemoteRunSink,
    signal: AbortSignal,
  ): Promise<void> {
    const pollMs = this.opts.pollMs ?? DEFAULT_POLL_MS;
    const approvalPollMs = this.opts.approvalPollMs ?? DEFAULT_APPROVAL_POLL_MS;
    const maxBackoffMs = this.opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    const maxRejections = this.opts.maxRejections ?? DEFAULT_MAX_REJECTIONS;
    let failures = 0;
    let rejections = 0;
    let lastState: WebhookRemoteState | null = null;
    const settle = (status: 'succeeded' | 'failed', error: string | null): void => {
      if (signal.aborted) return;
      sink.onSettled(status, error);
    };
    while (!signal.aborted) {
      let result: Record<string, unknown>;
      try {
        result = await this.opts.client.call('wait', { host: hostId, ref, timeoutSeconds: 1 }, { signal, timeoutMs: 60_000 });
      } catch (err) {
        if (signal.aborted) return;
        const message = describe(hostId, err);
        if (err instanceof HubDispatchError && err.code === 'not_configured') {
          return settle('failed', `Webhook routing was switched off on this server while the run on ${hostId} was in progress. ${message}`);
        }
        if (err instanceof HubDispatchError && err.code === 'tool_error' && GONE.some((re) => re.test(message))) {
          return settle('failed', `The run on ${hostId} no longer exists there: ${message}`);
        }
        if (err instanceof HubDispatchError && err.code === 'rejected') {
          rejections += 1;
          if (rejections >= maxRejections) return settle('failed', message);
        } else {
          rejections = 0;
        }
        failures += 1;
        if (failures === 1 || failures % 10 === 0) {
          // The work may well still be running; this is about reaching it.
          this.opts.logger?.warn({ deliveryId, hostId, failures, reason: message }, 'remote webhook run: wait failed, retrying');
        }
        await sleep(Math.min(maxBackoffMs, 5_000 * 2 ** Math.min(failures - 1, 6)), signal);
        continue;
      }
      failures = 0;
      rejections = 0;
      const state = typeof result.state === 'string' ? result.state : 'still_running';
      if (state === 'complete') {
        return settle(
          result.isError === true ? 'failed' : 'succeeded',
          result.isError === true ? `The run on ${hostId} ended its turn with an error.` : null,
        );
      }
      if (state === 'ended') return settle('failed', `The session on ${hostId} ended before its turn completed.`);
      const next: WebhookRemoteState =
        state === 'awaiting_approval' ? 'awaiting_approval' : state === 'queued' ? 'queued' : 'running';
      if (next !== lastState) {
        lastState = next;
        sink.onRemoteState(next);
      }
      await sleep(next === 'awaiting_approval' ? approvalPollMs : pollMs, signal);
    }
  }
}

function toolFor(spec: RemoteStartSpec): string {
  switch (spec.kind) {
    case 'coding':
      return 'dispatch_coding_task';
    case 'pocket':
      return 'dispatch_pocket_task';
    case 'follow-up':
      return 'dispatch_prompt';
  }
}

/**
 * The structured fields the Hub's tools take. Jira text crosses only inside
 * `prompt` (already fenced by the renderer); the title is the webhook's own
 * name and the validated subject key, and the branch base is minted from the
 * same — never from Jira text.
 */
function argsFor(spec: RemoteStartSpec): Record<string, unknown> {
  switch (spec.kind) {
    case 'coding':
      return {
        host: spec.hostId,
        cwd: spec.cwd,
        agent: spec.agent,
        prompt: spec.prompt,
        title: spec.title,
        worktree: spec.worktree,
        ...(spec.model ? { model: spec.model } : {}),
        ...(spec.worktree === 'new-branch' && spec.branchBase ? { branchBase: spec.branchBase } : {}),
      };
    case 'pocket':
      return {
        host: spec.hostId,
        pocketAgentId: spec.pocketAgentId,
        prompt: spec.prompt,
        title: spec.title,
        ...(spec.modelId ? { modelId: spec.modelId } : {}),
      };
    case 'follow-up':
      return { host: spec.hostId, ref: spec.ref, prompt: spec.prompt };
  }
}

function describe(hostId: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof HubDispatchError && err.code === 'tool_error') return `${hostId}: ${message}`;
  return message;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done(): void {
      signal.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}
