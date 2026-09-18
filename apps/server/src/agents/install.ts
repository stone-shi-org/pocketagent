import { spawn } from 'node:child_process';
import path from 'node:path';
import type {
  AgentInstallEvent,
  AgentSetupState,
  InstallableAgent,
  InstallableAgentId,
} from '@pocketagent/protocol';
import { OutputBuffer } from '../terminal/output-buffer.js';
import { buildChildEnv } from '../sessions/env.js';
import { usageProbeCwd } from '../usage/probe-cwd.js';
import { recordAgentAuthProbe, recordAgentInstall, readAgentDefaults, type Db } from '../db/index.js';
import { catalogEntry, installableAgents, npmInstallCommand } from './catalog.js';
import { agentBinSearchDirs, resolveExecutable } from './registry.js';
import type { AgentRegistry } from './registry.js';
import { deriveSetupState, probeAgentAuth } from './auth-probe.js';

/**
 * An install is slow — a 200 MB package over a domestic connection — and a
 * timeout here is legitimate where a timeout on an *approval* never is. The
 * distinction is not stylistic: an unanswered approval is a decision a human
 * has not made yet, and deciding it for them is the thing the standing
 * no-decay rule forbids. A wedged `npm install` is nobody's decision; it is a
 * process holding the single install slot forever. Every other subprocess here
 * is bounded the same way (probes at 15s, `exec_command` at 60s).
 */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** ~256 KB of npm chatter is far more than anyone reads and bounds one job's memory. */
const LOG_BUFFER_BYTES = 256 * 1024;

type InstallState = 'running' | 'succeeded' | 'failed';

interface InstallJob {
  id: InstallableAgentId;
  state: InstallState;
  startedAt: number;
  log: OutputBuffer;
  error: string | null;
  /** Live stream attachments. A job with none still runs to completion. */
  listeners: Set<(event: AgentInstallEvent) => void>;
  done: Promise<void>;
}

/** Injected in tests so no test ever runs a real `npm install`. */
export interface InstallRunner {
  (spec: {
    args: string[];
    env: Record<string, string>;
    cwd: string;
    onOutput: (chunk: string) => void;
  }): Promise<{ code: number | null; timedOut: boolean; startError: string | null }>;
}

export class AgentInstallError extends Error {
  constructor(
    message: string,
    readonly code: 'busy' | 'prefix_undetectable',
    readonly status: number,
  ) {
    super(message);
    this.name = 'AgentInstallError';
  }
}

/**
 * Installs an agent CLI on demand (PA-68).
 *
 * ## An install is a job; the stream is only a view of it
 *
 * The obvious shape — drive the install from the request generator the way
 * `streamPlannerEvents` drives a chat turn — is wrong here, and the difference
 * is duration. A chat turn lasts seconds and the browser is watching it; an
 * install lasts minutes, during which a phone will lock its screen, a reverse
 * proxy will hit its idle timeout, and the operator will quite reasonably
 * navigate away. If the stream owned the work, all three of those would either
 * abort an install halfway through a package tree or, worse, leave it running
 * while writing to a dead socket forever (the existing SSE helper has no
 * disconnect handling at all).
 *
 * So the job is authoritative and the response is a subscriber: closing the
 * stream detaches, re-`POST`ing the same id attaches to the install already in
 * flight rather than starting a second one, and the log lives in the same
 * sequence-numbered `OutputBuffer` a terminal session uses — which already
 * solves bounded retention and reports its own eviction, so a re-attaching
 * client gets a suffix it can trust rather than a silently truncated one. This
 * is the same "the drain is the pump, not the sensor" split
 * `RunExecutor.startPocketAgent` settled on.
 *
 * ## One at a time
 *
 * A second install of a *different* agent is refused (409) rather than queued.
 * These are large downloads and an operator bringing up a fresh host is not
 * served by four of them competing for bandwidth and the same npm cache. It is
 * deliberately not `RunQueue`: that keys on working trees with occupancy
 * derived from live sessions, and an install has no cwd, no worktree and no
 * session for it to observe.
 */
export class AgentInstallService {
  private readonly jobs = new Map<InstallableAgentId, InstallJob>();

  constructor(
    private readonly deps: {
      db: Db;
      agents: AgentRegistry;
      /** Read per install, so a settings change applies without a restart. */
      installPrefix: () => string;
      npmBin?: string;
      runner?: InstallRunner;
      logger?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
    },
  ) {}

  catalog(): InstallableAgent[] {
    return installableAgents();
  }

  /**
   * Whether an install into the configured prefix would actually be found.
   *
   * `resolveExecutable` searches `PATH` plus a fixed set of home directories,
   * so a prefix outside both produces an install that succeeds and stays
   * invisible — the single most confusing way this feature could fail. The
   * route reports this rather than letting the UI offer such an install.
   */
  prefixDetectable(): boolean {
    const prefix = this.deps.installPrefix();
    const binDir = `${prefix.replace(/\/+$/, '')}/bin`;
    if (agentBinSearchDirs().some((dir) => dir === binDir)) return true;
    const pathDirs = (process.env.PATH ?? '').split(':').filter(Boolean);
    return pathDirs.includes(binDir);
  }

  /** The live job for an id, if any — used by the route to decide attach vs start. */
  jobFor(id: InstallableAgentId): { state: InstallState; lastSeq: number } | null {
    const job = this.jobs.get(id);
    return job ? { state: job.state, lastSeq: job.log.getLastSeq() } : null;
  }

  /**
   * Start an install, or attach to one already running for the same id.
   *
   * Synchronous from the busy check to the claim (`this.jobs.set`) with no
   * `await` in between, for the same reason `RunQueue.tryAcquire` must be: an
   * `await` there hands one install slot to two requests.
   */
  start(id: InstallableAgentId): { attached: boolean; subscribe: InstallSubscribe } {
    const existing = this.jobs.get(id);
    if (existing !== undefined && existing.state === 'running') {
      return { attached: true, subscribe: this.subscriber(existing, true) };
    }
    const busy = [...this.jobs.values()].find((j) => j.state === 'running');
    if (busy !== undefined) {
      throw new AgentInstallError(
        `An install of ${catalogEntry(busy.id).displayName} is already running. Wait for it to finish, then try again.`,
        'busy',
        409,
      );
    }
    if (!this.prefixDetectable()) {
      throw new AgentInstallError(
        `The agent install prefix (${this.deps.installPrefix()}) is not a directory this server searches for agent binaries, so an install there would not be found. Change it in Settings.`,
        'prefix_undetectable',
        409,
      );
    }

    const job: InstallJob = {
      id,
      state: 'running',
      startedAt: Date.now(),
      log: new OutputBuffer(LOG_BUFFER_BYTES),
      error: null,
      listeners: new Set(),
      done: Promise.resolve(),
    };
    this.jobs.set(id, job);
    job.done = this.run(job);
    return { attached: false, subscribe: this.subscriber(job, false) };
  }

  private async run(job: InstallJob): Promise<void> {
    const entry = catalogEntry(job.id);
    const prefix = this.deps.installPrefix();
    const { args, env } = npmInstallCommand(job.id, prefix);
    // Never a workspace directory, and never the server's own cwd — see
    // `npmInstallCommand`'s doc comment for the corepack failure that makes
    // this load-bearing rather than merely tidy.
    const cwd = usageProbeCwd();

    this.deps.logger?.info(
      { agent: job.id, package: entry.packageName, version: entry.version, prefix },
      'installing agent CLI',
    );

    const emitLog = (chunk: string): void => {
      const seq = job.log.append(chunk);
      this.emit(job, {
        kind: 'install_log',
        seq,
        text: chunk,
        truncated: job.log.getFirstSeq() > 1,
      });
    };

    const runner = this.deps.runner ?? defaultRunner(this.deps.npmBin ?? 'npm');
    let outcome: { code: number | null; timedOut: boolean; startError: string | null };
    try {
      outcome = await runner({ args, env, cwd, onOutput: emitLog });
    } catch (err) {
      outcome = { code: null, timedOut: false, startError: (err as Error).message };
    }

    const error = installFailure(outcome, entry.packageName);
    if (error === null) {
      // npm's exit code is necessary but not sufficient: the Dockerfile keeps
      // a `test -x` for this exact case, having once shipped an install that
      // reported success into a prefix nothing read.
      const verified = verifyInstalled(entry.binName, prefix);
      if (verified.resolved === null) {
        job.error = `${entry.packageName}@${entry.version} installed, but "${entry.binName}" is still not on PATH or in ${prefix}/bin. The install prefix may not be a directory this server searches.`;
      } else if (!verified.fromPrefix) {
        // Not a failure: the agent is usable, which is the only thing that
        // decides whether a session can start. But it is worth saying, because
        // it means the copy that will actually run is *not* the one just
        // installed — an earlier copy earlier on PATH is shadowing it, so the
        // operator's upgrade silently did nothing. This is the diagnostic that
        // would have caught the Dockerfile's own version of this bug.
        this.deps.logger?.warn(
          { agent: job.id, resolved: verified.resolved, prefix },
          'installed agent resolves from outside the install prefix; an existing copy earlier on PATH will run instead',
        );
      }
    } else {
      job.error = error;
    }

    job.state = job.error === null ? 'succeeded' : 'failed';
    recordAgentInstall(
      this.deps.db,
      job.id,
      job.error === null ? { ok: true } : { ok: false, error: job.error },
    );

    // Probe the freshly installed CLI's sign-in state immediately: the whole
    // point of the three-state model is that "installed" is not "ready", and
    // the operator is right here, watching, at the one moment that distinction
    // is most useful. Best-effort — `probeAgentAuth` never rejects.
    if (job.state === 'succeeded') {
      const adapter = this.deps.agents.get(job.id);
      if (adapter !== undefined) {
        const result = await probeAgentAuth(adapter);
        recordAgentAuthProbe(this.deps.db, job.id, result);
      }
    }

    if (job.error !== null) {
      this.deps.logger?.warn({ agent: job.id, error: job.error }, 'agent CLI install failed');
    }

    this.emit(job, {
      kind: 'install_finished',
      ok: job.state === 'succeeded',
      error: job.error,
      setupState: this.setupStateFor(job.id),
    });
    job.listeners.clear();
  }

  private setupStateFor(id: InstallableAgentId): AgentSetupState {
    const adapter = this.deps.agents.get(id);
    const available = adapter?.isAvailable?.() ?? false;
    const cached = readAgentDefaults(this.deps.db, id);
    return deriveSetupState(available, {
      state: cached?.last_auth_state ?? null,
      detail: cached?.last_auth_detail ?? null,
    }).setupState;
  }

  private emit(job: InstallJob, event: AgentInstallEvent): void {
    for (const listener of job.listeners) {
      try {
        listener(event);
      } catch {
        // A dead socket must not stop the install or the other subscribers.
      }
    }
  }

  private subscriber(job: InstallJob, attached: boolean): InstallSubscribe {
    return (afterSeq, onEvent) => {
      const entry = catalogEntry(job.id);
      onEvent({
        kind: 'install_started',
        id: job.id,
        packageName: entry.packageName,
        version: entry.version,
        attached,
      });
      // Replay before subscribing, so nothing arriving between the two is lost
      // or duplicated — the ordering rule the terminal replay path follows.
      // `replayAfter` reports its own eviction, which is what lets a
      // re-attaching client know its view has a hole rather than guessing.
      const replay = job.log.replayAfter(afterSeq);
      if (replay.data !== '') {
        onEvent({
          kind: 'install_log',
          seq: replay.toSeq,
          text: replay.data,
          truncated: replay.truncated,
        });
      }
      if (job.state !== 'running') {
        onEvent({
          kind: 'install_finished',
          ok: job.state === 'succeeded',
          error: job.error,
          setupState: this.setupStateFor(job.id),
        });
        return () => undefined;
      }
      job.listeners.add(onEvent);
      return () => job.listeners.delete(onEvent);
    };
  }

  /** Awaits every in-flight install. Tests only; production lets them finish. */
  async settle(): Promise<void> {
    await Promise.all([...this.jobs.values()].map((j) => j.done));
  }
}

/**
 * Subscribe to a job: replay everything after `afterSeq`, then stream. Returns
 * an unsubscribe the route calls when the client goes away.
 */
export type InstallSubscribe = (
  afterSeq: number,
  onEvent: (event: AgentInstallEvent) => void,
) => () => void;

/**
 * Turn a runner outcome into the *real* error, or null on success.
 *
 * Deliberately specific rather than "install failed": the acceptance criterion
 * is that a failure surfaces the real cause, and the three ways this goes
 * wrong are genuinely different problems with genuinely different fixes — npm
 * missing entirely, npm refusing (permissions, registry, no such version), and
 * an install that ran too long. The npm output itself is already in the log;
 * this is the one-line summary that gets persisted.
 */
/**
 * Did the install actually produce a runnable binary, and is it the one that
 * will run?
 *
 * Two separate questions, deliberately answered separately. `resolved` decides
 * success: it goes through the same `resolveExecutable` that `available` and
 * session start use, so "installed" here means exactly what it means
 * everywhere else in the app rather than "npm exited 0". `fromPrefix` is the
 * diagnostic — a binary that resolves from somewhere *earlier* on PATH than
 * the prefix means an older copy shadows the one just installed, so the
 * install appeared to work and changed nothing. That is not a failure (the
 * agent is usable) but it is the single most confusing outcome available here,
 * and it is what the Dockerfile's `test -x` exists to catch.
 */
export function verifyInstalled(
  binName: string,
  prefix: string,
): { resolved: string | null; fromPrefix: boolean } {
  const resolved = resolveExecutable(binName);
  if (resolved === null) return { resolved: null, fromPrefix: false };
  const prefixBin = path.join(prefix.replace(/\/+$/, ''), 'bin');
  return { resolved, fromPrefix: path.dirname(resolved) === prefixBin };
}

export function installFailure(
  outcome: { code: number | null; timedOut: boolean; startError: string | null },
  packageName: string,
): string | null {
  if (outcome.startError !== null) {
    return `Could not run npm: ${outcome.startError}. Node's npm must be on the server's PATH to install an agent.`;
  }
  if (outcome.timedOut) {
    return `Installing ${packageName} took longer than ${Math.round(INSTALL_TIMEOUT_MS / 60000)} minutes and was stopped.`;
  }
  if (outcome.code !== 0) {
    return `npm install exited with code ${outcome.code ?? 'unknown'}. See the log above for npm's own error.`;
  }
  return null;
}

/**
 * The real installer: `npm` as argv, never through a shell.
 *
 * stdout and stderr are merged into one stream on purpose — npm writes
 * progress to stderr and results to stdout, and an operator watching an
 * install wants them interleaved in the order they happened, exactly as a
 * terminal would show them.
 */
function defaultRunner(npmBin: string): InstallRunner {
  return ({ args, env, cwd, onOutput }) =>
    new Promise((resolve) => {
      let child;
      try {
        child = spawn(npmBin, args, { cwd, env: buildChildEnv({ cwd, overrides: env }) });
      } catch (err) {
        resolve({ code: null, timedOut: false, startError: (err as Error).message });
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
        resolve({ code: null, timedOut: true, startError: null });
      }, INSTALL_TIMEOUT_MS);
      timer.unref?.();

      child.stdin?.end();
      const onChunk = (chunk: Buffer): void => onOutput(chunk.toString('utf8'));
      child.stdout?.on('data', onChunk);
      child.stderr?.on('data', onChunk);
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: null, timedOut: false, startError: err.message });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, timedOut: false, startError: null });
      });
    });
}
