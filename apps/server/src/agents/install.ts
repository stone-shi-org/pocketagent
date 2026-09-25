import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentBinaryCopy,
  AgentInstallEvent,
  AgentSetupState,
  InstallAgentAction,
  InstallableAgent,
  InstallableAgentId,
} from '@pocketagent/protocol';
import { INSTALLABLE_AGENT_IDS } from '@pocketagent/protocol';
import { OutputBuffer } from '../terminal/output-buffer.js';
import { buildChildEnv } from '../sessions/env.js';
import { usageProbeCwd } from '../usage/probe-cwd.js';
import { recordAgentAuthProbe, recordAgentInstall, readAgentDefaults, type Db } from '../db/index.js';
import {
  catalogEntry,
  installableAgents,
  isOfficialInstallPath,
  npmInstallCommand,
  npmUninstallCommand,
  type CatalogEntry,
} from './catalog.js';
import {
  agentBinSearchDirs,
  executableSearchDirs,
  findExecutableCandidates,
  installPrefixBinDirs,
} from './registry.js';
import type { AgentRegistry } from './registry.js';
import { deriveSetupState, probeAgentAuth } from './auth-probe.js';
import { probeAndRecordAgentVersion } from './version-probe.js';

/**
 * An install is slow — a 200 MB download over a domestic connection — and a
 * timeout here is legitimate where a timeout on an *approval* never is. The
 * distinction is not stylistic: an unanswered approval is a decision a human
 * has not made yet, and deciding it for them is the thing the standing
 * no-decay rule forbids. A wedged installer is nobody's decision; it is a
 * process holding the single install slot forever. Every other subprocess here
 * is bounded the same way (probes at 15s, `exec_command` at 60s).
 */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** ~256 KB of installer chatter is far more than anyone reads and bounds one job's memory. */
const LOG_BUFFER_BYTES = 256 * 1024;

/**
 * The largest installer script accepted. The biggest one today (pi's) is
 * ~60 KB; a response far past that is not an installer script.
 */
const MAX_SCRIPT_BYTES = 1024 * 1024;
const SCRIPT_FETCH_TIMEOUT_MS = 60_000;

/**
 * Removed from an installer's environment. The container image sets
 * `NPM_CONFIG_PREFIX=$HOME/.npm-global`, and npm reads env config
 * case-insensitively — so anything an official installer or update command
 * does with `npm -g` (pi's legacy mode, `pi update` on a legacy install) would
 * otherwise land in exactly the prefix PA-104 moves installs *out* of.
 */
const UNSET_FOR_OFFICIAL = ['NPM_CONFIG_PREFIX', 'npm_config_prefix'] as const;

type InstallState = 'running' | 'succeeded' | 'failed';

/**
 * What one job will run, decided synchronously in `start` so the stream's
 * first frame can say exactly what the operator is watching.
 */
type InstallPlan =
  | {
      kind: 'script';
      scriptUrl: string;
      interpreter: 'bash' | 'sh';
      args: string[];
      env: Record<string, string>;
      source: string;
    }
  | {
      kind: 'exec';
      command: string;
      args: string[];
      env: Record<string, string>;
      unsetEnv: string[];
      source: string;
      /** For a removal: the prefix whose copy is being uninstalled. */
      removePrefix?: string;
    };

interface InstallJob {
  id: InstallableAgentId;
  action: InstallAgentAction;
  plan: InstallPlan;
  state: InstallState;
  startedAt: number;
  log: OutputBuffer;
  error: string | null;
  /** Live stream attachments. A job with none still runs to completion. */
  listeners: Set<(event: AgentInstallEvent) => void>;
  done: Promise<void>;
}

export interface RunOutcome {
  code: number | null;
  timedOut: boolean;
  startError: string | null;
}

/** Injected in tests so no test ever runs a real installer. */
export interface InstallRunner {
  (spec: {
    command: string;
    args: string[];
    env: Record<string, string>;
    unsetEnv: string[];
    cwd: string;
    onOutput: (chunk: string) => void;
  }): Promise<RunOutcome>;
}

/**
 * Fetches an installer script. Injected in tests so no test ever touches the
 * network. Returns the URL the body finally came from, because a redirect is
 * followed and the scheme check applies to where the bytes came from, not to
 * where the request started.
 */
export type ScriptFetcher = (url: string) => Promise<{ body: Buffer; finalUrl: string }>;

export class AgentInstallError extends Error {
  constructor(
    message: string,
    readonly code: 'busy' | 'prefix_undetectable' | 'nothing_to_remove' | 'home_not_writable',
    readonly status: number,
  ) {
    super(message);
    this.name = 'AgentInstallError';
  }
}

/**
 * Installs, updates and cleans up agent CLIs on demand (PA-68, PA-104).
 *
 * ## An install is a job; the stream is only a view of it
 *
 * An install lasts minutes, during which a phone will lock its screen, a
 * reverse proxy will hit its idle timeout, and the operator will reasonably
 * navigate away. If the stream owned the work, all three would either abort an
 * install halfway or leave it writing to a dead socket forever. So the job is
 * authoritative and the response is a subscriber: closing the stream detaches,
 * re-`POST`ing the same id attaches to the job already in flight, and the log
 * lives in the same sequence-numbered `OutputBuffer` a terminal session uses.
 * This is the "the drain is the pump, not the sensor" split
 * `RunExecutor.startPocketAgent` settled on.
 *
 * ## One at a time
 *
 * A second job for a *different* agent is refused (409) rather than queued:
 * these are large downloads, and `RunQueue` keys on working trees with
 * occupancy derived from live sessions, none of which an install has.
 *
 * ## Official location, or the job fails (PA-104)
 *
 * Every job for an official-script agent ends by resolving the binary through
 * the same `resolveExecutable` order sessions use and requiring that the copy
 * that runs is the official install (`isOfficialInstallPath`). PA-68 only
 * logged a warning when the copy that ran was not the one just installed; that
 * warning fired for pi on 2026-09-23 and nobody saw it, which is how an
 * "upgrade" came to change nothing. It is now the rule, and the error names
 * the copy that runs instead.
 */
export class AgentInstallService {
  private readonly jobs = new Map<InstallableAgentId, InstallJob>();

  constructor(
    private readonly deps: {
      db: Db;
      agents: AgentRegistry;
      /** Read per job, so a settings change applies without a restart. */
      installPrefix: () => string;
      npmBin?: string;
      runner?: InstallRunner;
      fetchScript?: ScriptFetcher;
      logger?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
    },
  ) {}

  catalog(): InstallableAgent[] {
    return installableAgents();
  }

  /**
   * Whether an npm-method install into the configured prefix would be found.
   * Official-script installs never write there, so this gates only the npm
   * fallback.
   */
  prefixDetectable(): boolean {
    const binDir = `${this.deps.installPrefix().replace(/\/+$/, '')}/bin`;
    if (agentBinSearchDirs().some((dir) => dir === binDir)) return true;
    return executableSearchDirs().includes(binDir);
  }

  /** The live job for an id, if any — used by the route to decide attach vs start. */
  jobFor(id: InstallableAgentId): { state: InstallState; lastSeq: number } | null {
    const job = this.jobs.get(id);
    return job ? { state: job.state, lastSeq: job.log.getLastSeq() } : null;
  }

  /**
   * Start a job, or attach to one already running for the same id.
   *
   * Synchronous from the busy check to the claim (`this.jobs.set`) with no
   * `await` in between, for the same reason `RunQueue.tryAcquire` must be: an
   * `await` there hands one install slot to two requests.
   */
  start(
    id: InstallableAgentId,
    action: InstallAgentAction = 'install',
  ): { attached: boolean; subscribe: InstallSubscribe } {
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
    const entry = catalogEntry(id);
    if (entry.method === 'npm' && action !== 'remove-prefix-copy' && !this.prefixDetectable()) {
      throw new AgentInstallError(
        `The agent install prefix (${this.deps.installPrefix()}) is not a directory this server searches for agent binaries, so an install there would not be found. Change it in Settings.`,
        'prefix_undetectable',
        409,
      );
    }
    if (entry.method === 'official-script' && action !== 'remove-prefix-copy') {
      const problem = homeWritabilityProblem(entry.homeDirs);
      if (problem !== null) {
        // Persisted as well as answered, so the Settings row still says why
        // after the dialog is closed — this is not a transient condition.
        recordAgentInstall(this.deps.db, id, { ok: false, error: problem });
        this.deps.logger?.warn({ agent: id, action, error: problem }, 'agent CLI job refused');
        throw new AgentInstallError(problem, 'home_not_writable', 409);
      }
    }
    const plan = this.planFor(id, entry, action);

    const job: InstallJob = {
      id,
      action,
      plan,
      state: 'running',
      startedAt: Date.now(),
      log: new OutputBuffer(LOG_BUFFER_BYTES),
      error: null,
      listeners: new Set(),
      done: Promise.resolve(),
    };
    this.jobs.set(id, job);
    job.done = this.run(job, entry);
    return { attached: false, subscribe: this.subscriber(job, false) };
  }

  /**
   * Decide what a job runs. Every argv here comes from the frozen catalog or
   * from a path this server resolved itself — never from the request, which
   * carried only an id and an action.
   */
  private planFor(id: InstallableAgentId, entry: CatalogEntry, action: InstallAgentAction): InstallPlan {
    if (action === 'remove-prefix-copy') {
      const copy = prefixCopyOf(entry.binName);
      if (copy === null || entry.legacyNpmPackage === null) {
        throw new AgentInstallError(
          `There is no ${entry.displayName} copy in an install prefix (${installPrefixBinDirs().join(', ')}) to remove.`,
          'nothing_to_remove',
          409,
        );
      }
      const prefix = path.dirname(path.dirname(copy.path));
      const { args, env } = npmUninstallCommand(entry.legacyNpmPackage, prefix);
      return {
        kind: 'exec',
        command: this.deps.npmBin ?? 'npm',
        args,
        env,
        unsetEnv: [],
        source: `npm uninstall ${entry.legacyNpmPackage} (${prefix})`,
        removePrefix: prefix,
      };
    }

    if (entry.method === 'npm') {
      const { args, env } = npmInstallCommand(entry, this.deps.installPrefix(), action === 'update' ? 'latest' : 'pinned');
      return {
        kind: 'exec',
        command: this.deps.npmBin ?? 'npm',
        args,
        env,
        unsetEnv: [],
        source: `${entry.packageName}@${action === 'update' ? 'latest' : entry.version}`,
      };
    }

    const officialEnv = { ...entry.env, PATH: officialInstallerPath() };
    if (action === 'update' && entry.update.kind === 'binary') {
      // The copy that runs, and only if it is the official one: updating a
      // stray copy in place would "succeed" and leave the official install —
      // the one a human's shell runs — exactly as stale as before. With no
      // official copy yet, an update is a fresh official install.
      const running = findExecutableCandidates(entry.binName)[0];
      if (running !== undefined && isOfficialInstallPath(id, running.realPath)) {
        return {
          kind: 'exec',
          command: running.path,
          args: [...entry.update.args],
          env: officialEnv,
          unsetEnv: [...UNSET_FOR_OFFICIAL],
          source: `${running.path} ${entry.update.args.join(' ')}`,
        };
      }
    }
    return {
      kind: 'script',
      scriptUrl: entry.scriptUrl,
      interpreter: entry.interpreter,
      args: [...entry.installArgs],
      env: officialEnv,
      source: entry.scriptUrl,
    };
  }

  private async run(job: InstallJob, entry: CatalogEntry): Promise<void> {
    // Never a workspace directory, and never the server's own cwd — see
    // `npmInstallCommand`'s doc comment for the corepack failure that makes
    // this load-bearing rather than merely tidy.
    const cwd = usageProbeCwd();

    const emitLog = (chunk: string): void => {
      const seq = job.log.append(chunk);
      this.emit(job, {
        kind: 'install_log',
        seq,
        text: chunk,
        truncated: job.log.getFirstSeq() > 1,
      });
    };

    const runner = this.deps.runner ?? defaultRunner;
    let scriptDir: string | null = null;
    try {
      let command: string;
      let args: string[];
      let env: Record<string, string>;
      let unsetEnv: string[];
      if (job.plan.kind === 'script') {
        const fetched = await this.fetchInstaller(job.plan.scriptUrl);
        if ('error' in fetched) {
          job.error = fetched.error;
        } else {
          scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketagent-installer-'));
          const file = path.join(scriptDir, 'install.sh');
          fs.writeFileSync(file, fetched.body, { mode: 0o600 });
          const sha256 = createHash('sha256').update(fetched.body).digest('hex');
          emitLog(`Downloaded ${fetched.finalUrl} (${fetched.body.length} bytes, sha256 ${sha256})\n`);
          this.deps.logger?.info(
            { agent: job.id, action: job.action, script: fetched.finalUrl, bytes: fetched.body.length, sha256 },
            'running official agent installer',
          );
        }
        command = job.plan.interpreter;
        args = scriptDir === null ? [] : [path.join(scriptDir, 'install.sh'), ...job.plan.args];
        env = job.plan.env;
        unsetEnv = [...UNSET_FOR_OFFICIAL];
      } else {
        command = job.plan.command;
        args = job.plan.args;
        env = job.plan.env;
        unsetEnv = job.plan.unsetEnv;
        this.deps.logger?.info({ agent: job.id, action: job.action, source: job.plan.source }, 'running agent CLI job');
      }

      if (job.error === null) {
        let outcome: RunOutcome;
        try {
          outcome = await runner({ command, args, env, unsetEnv, cwd, onOutput: emitLog });
        } catch (err) {
          outcome = { code: null, timedOut: false, startError: (err as Error).message };
        }
        const what =
          command === (this.deps.npmBin ?? 'npm')
            ? 'npm'
            : job.plan.kind === 'script'
              ? `${command} (running the official installer)`
              : describeCommand(job);
        job.error = installFailure(outcome, what);
        if (job.error !== null && outcome.startError === null) {
          // The one-line summary alone ("exited with code 1") is useless once
          // the dialog is closed — test01's failure read exactly that, with
          // the real cause only in a log nobody could see any more. The
          // command's own last words are the diagnosis, so they are kept.
          const tail = outputTail(job.log.replayAfter(0).data);
          if (tail !== '') job.error = `${job.error} Last output: ${tail}`;
        }
        if (job.error === null) job.error = this.verify(job, entry, emitLog);
      }
    } finally {
      if (scriptDir !== null) fs.rmSync(scriptDir, { recursive: true, force: true });
    }

    job.state = job.error === null ? 'succeeded' : 'failed';
    if (job.action !== 'remove-prefix-copy') {
      recordAgentInstall(this.deps.db, job.id, job.error === null ? { ok: true } : { ok: false, error: job.error });
    }

    // Probe the CLI immediately: "installed" is not "ready", and the operator
    // is right here, watching, at the one moment that distinction is most
    // useful. Best-effort — neither probe rejects.
    if (job.state === 'succeeded' && job.action !== 'remove-prefix-copy') {
      const adapter = this.deps.agents.get(job.id);
      if (adapter !== undefined) {
        const result = await probeAgentAuth(adapter);
        recordAgentAuthProbe(this.deps.db, job.id, result);
        await probeAndRecordAgentVersion(this.deps.db, adapter);
      }
    }

    if (job.error !== null) {
      this.deps.logger?.warn({ agent: job.id, action: job.action, error: job.error }, 'agent CLI job failed');
    }

    this.emit(job, {
      kind: 'install_finished',
      ok: job.state === 'succeeded',
      error: job.error,
      setupState: this.setupStateFor(job.id),
    });
    job.listeners.clear();
  }

  /**
   * Did the job leave the host in the state it claimed? Returns the error, or
   * null. See the class comment: for an official-script agent the copy that
   * runs *must* be the official install.
   */
  private verify(job: InstallJob, entry: CatalogEntry, log: (chunk: string) => void): string | null {
    if (job.action === 'remove-prefix-copy') {
      const prefix = job.plan.kind === 'exec' ? job.plan.removePrefix : undefined;
      const left = findExecutableCandidates(entry.binName).find(
        (c) => prefix !== undefined && path.dirname(c.path) === path.join(prefix, 'bin'),
      );
      return left === undefined
        ? null
        : `npm uninstall finished, but ${left.path} is still there. Remove it by hand.`;
    }
    const candidates = findExecutableCandidates(entry.binName);
    const running = candidates[0];
    if (running === undefined) {
      return `${describeCommand(job)} finished, but "${entry.binName}" is not in any directory this server searches (${executableSearchDirs().join(':')}).`;
    }
    log(`${entry.binName} now resolves to ${running.path}${running.realPath !== running.path ? ` → ${running.realPath}` : ''}\n`);
    if (entry.method === 'npm') {
      const prefixBin = path.join(this.deps.installPrefix().replace(/\/+$/, ''), 'bin');
      if (path.dirname(running.path) !== prefixBin) {
        return `${entry.packageName} installed into ${prefixBin}, but the copy that runs is ${running.path}. Remove that copy, or it will keep running instead.`;
      }
      return null;
    }
    if (!isOfficialInstallPath(job.id, running.realPath)) {
      return (
        `${describeCommand(job)} finished, but the copy of ${entry.binName} that runs is ${running.path}` +
        `${running.realPath !== running.path ? ` (→ ${running.realPath})` : ''}, not the official install. ` +
        `A human's login shell and this server would run different binaries. Remove that copy (Settings lists every copy it found) and install again.`
      );
    }
    return null;
  }

  private async fetchInstaller(url: string): Promise<{ body: Buffer; finalUrl: string } | { error: string }> {
    if (!url.startsWith('https://')) return { error: `Refusing to fetch an installer over a non-HTTPS URL: ${url}` };
    let fetched: { body: Buffer; finalUrl: string };
    try {
      fetched = await (this.deps.fetchScript ?? defaultFetchScript)(url);
    } catch (err) {
      return { error: `Could not download the official installer from ${url}: ${(err as Error).message}` };
    }
    if (!fetched.finalUrl.startsWith('https://')) {
      return { error: `The installer at ${url} redirected to a non-HTTPS URL (${fetched.finalUrl}); refusing to run it.` };
    }
    if (fetched.body.length === 0 || fetched.body.length > MAX_SCRIPT_BYTES) {
      return { error: `The installer at ${url} is ${fetched.body.length} bytes, which is not a plausible installer script; refusing to run it.` };
    }
    // An HTML error page (a captive portal, a region block) would otherwise be
    // handed to bash, which fails with a baffling syntax error.
    if (!fetched.body.subarray(0, 2).equals(Buffer.from('#!'))) {
      return { error: `The response from ${url} is not a shell script (no #! line); refusing to run it.` };
    }
    return fetched;
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
        packageName: job.plan.source,
        source: job.plan.source,
        action: job.action,
        version: entry.method === 'npm' ? entry.version : null,
        attached,
      });
      // Replay before subscribing, so nothing arriving between the two is lost
      // or duplicated — the ordering rule the terminal replay path follows.
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

  /** Awaits every in-flight job. Tests only; production lets them finish. */
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

function describeCommand(job: InstallJob): string {
  if (job.action === 'remove-prefix-copy') return 'npm uninstall';
  if (job.plan.kind === 'script') return 'The official installer';
  return job.plan.source;
}

/**
 * `PATH` for an official installer or update command: what a human's login
 * shell would have, as nearly as the server can say without running one.
 *
 * Three rules, each learned from running the real installers:
 *
 * - **The install-prefix directories are removed.** opencode's installer exits
 *   early when *any* `opencode` on PATH already has the requested version, and
 *   pi's managed mode refuses to proceed past a pi it does not manage — so a
 *   leftover `~/.npm-global/bin` copy on the installer's PATH makes it do
 *   nothing or fail.
 * - **`~/.local/bin` is added**, because a stock Debian/Ubuntu `~/.profile`
 *   puts it on every login PATH once it exists, and pi's managed mode links its
 *   launcher from the first of its candidate directories that is *on PATH* —
 *   without it pi lands in `~/.pi/agent/bin`, where no login shell looks.
 * - **The vendor-specific directories (`~/.opencode/bin`, `~/.pi/agent/bin`)
 *   are not added.** An installer decides whether to write its "add me to your
 *   PATH" line to the shell profile by checking whether its directory is
 *   already on PATH; listing it here made opencode's installer skip that step,
 *   and a human's shell then could not find the opencode the server runs.
 *   (They are still searched first by `resolveExecutable`; this is only the
 *   installer's view.)
 *
 * The server's own Node directory is appended because pi's installer needs
 * `node`/`npm` and a systemd unit's PATH often does not name the Node running
 * this process.
 */
export function officialInstallerPath(): string {
  const demoted = new Set(installPrefixBinDirs().map((d) => path.resolve(d)));
  const dirs = [
    path.join(os.homedir(), '.local', 'bin'),
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
    path.dirname(process.execPath),
  ].filter((d) => !demoted.has(path.resolve(d)));
  return [...new Set(dirs)].join(path.delimiter);
}

/** The npm-prefix copy of a binary, if the search order finds one. */
function prefixCopyOf(binName: string): { path: string; realPath: string } | null {
  const prefixBins = new Set(installPrefixBinDirs().map((d) => path.resolve(d)));
  return findExecutableCandidates(binName).find((c) => prefixBins.has(path.dirname(c.path))) ?? null;
}

/**
 * Which executable runs for an agent, whether it is the official install, and
 * every other copy found (PA-104). Pure filesystem reads — no subprocess — so
 * `GET /api/agents` can call it on every request, the same budget
 * `available` already spends.
 *
 * Only for agents in the install catalog. The agent list has never exposed a
 * command line (`sessions.test.ts` asserts the shell's path stays out of it),
 * and the path is worth disclosing only where there is an official location
 * to compare it with and an install an operator can act on.
 */
export function agentBinaryReport(
  agentId: string,
  bin: string | undefined,
): { resolvedPath: string | null; officialInstall: boolean | null; otherCopies: AgentBinaryCopy[] } {
  const none = { resolvedPath: null, officialInstall: null, otherCopies: [] };
  if (bin === undefined || !(INSTALLABLE_AGENT_IDS as readonly string[]).includes(agentId)) return none;
  const installable = agentId as InstallableAgentId;
  const candidates = findExecutableCandidates(bin);
  const running = candidates[0];
  if (running === undefined) return none;
  const prefixBins = new Set(installPrefixBinDirs().map((d) => path.resolve(d)));
  const imageHome = agentImageHome();
  const seen = new Set([running.realPath]);
  const otherCopies: AgentBinaryCopy[] = [];
  for (const copy of candidates.slice(1)) {
    if (seen.has(copy.realPath)) continue;
    seen.add(copy.realPath);
    otherCopies.push({
      path: copy.path,
      realPath: copy.realPath,
      kind: prefixBins.has(path.dirname(copy.path))
        ? 'install-prefix'
        : imageHome !== null && copy.realPath.startsWith(`${imageHome}${path.sep}`)
          ? 'image'
          : 'other',
    });
  }
  return {
    resolvedPath: running.path,
    officialInstall: isOfficialInstallPath(installable, running.realPath),
    otherCopies,
  };
}

/**
 * Where the container image keeps its baked-in agent installs, or null outside
 * the image. Read from raw `process.env` rather than `Config`, like
 * `POCKETAGENT_BUILD_VERSION`: it is the image's own identity (`ENV` in
 * `docker/Dockerfile`), not something an operator chooses.
 *
 * It exists so an image copy can be told apart from a stray one. After the
 * first "Update" in a container the running copy moves into the mounted
 * `$HOME` (the image layer is read-only, so it cannot be updated in place),
 * and the baked-in copy is simply superseded; reporting it as "another copy,
 * remove it on the host" — as the first cut did on test01 — was advice that
 * cannot be followed.
 */
function agentImageHome(): string | null {
  const raw = process.env.AGENT_IMAGE_HOME?.trim();
  return raw ? path.resolve(raw) : null;
}

/**
 * The last few non-empty lines of a job's output, ANSI-stripped and capped —
 * enough to name the cause, short enough to live in one settings row.
 */
export function outputTail(output: string, maxLines = 3, maxChars = 400): string {
  const lines = output
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const tail = lines.slice(-maxLines).join(' / ');
  return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail;
}

/**
 * Whether the directories an official installer writes under `$HOME` are
 * writable by this process, and if not, the sentence that says how to fix it
 * (PA-104). Null when everything is writable.
 *
 * Checked *before* running anything because the installer's own failure is
 * opaque and, worse, partial: on test01 `claude update` downloaded 2.1.283 and
 * then exited 1 unable to create `~/.local/bin`, because the image had shipped
 * root-owned `~/.local`, `~/.config`, `~/.codex` and `~/.cache` into
 * `/home/pocketagent` and Docker copied them into the empty home volume. The
 * container entrypoint deliberately never chowns a mounted volume, so the fix
 * has to be named rather than applied — and a root `docker exec` without
 * `--user` leaves exactly the same state, so this is not only that one bug.
 *
 * A path that does not exist yet is judged by its nearest existing parent,
 * which is what the installer will actually have to write into.
 */
export function homeWritabilityProblem(relDirs: readonly string[]): string | null {
  const home = os.homedir();
  const blocked = new Map<string, number | null>();
  for (const rel of ['', ...relDirs]) {
    let dir = path.join(home, rel);
    while (!fs.existsSync(dir) && dir !== path.dirname(dir)) dir = path.dirname(dir);
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      let owner: number | null = null;
      try {
        owner = fs.statSync(dir).uid;
      } catch {
        // Unreadable too; the owner is simply unknown.
      }
      blocked.set(dir, owner);
    }
  }
  if (blocked.size === 0) return null;
  // Report only the outermost offenders: a chown of `~/.local` covers
  // `~/.local/share` beneath it.
  const roots = [...blocked.keys()].filter(
    (d) => ![...blocked.keys()].some((o) => o !== d && d.startsWith(`${o}${path.sep}`)),
  );
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const gid = typeof process.getgid === 'function' ? process.getgid() : null;
  const who = uid !== null ? `uid ${uid}` : 'this server’s user';
  const owners = roots.map((d) => {
    const o = blocked.get(d);
    return `${d}${o === null || o === undefined ? '' : ` (owned by uid ${o}${o === 0 ? ', root' : ''})`}`;
  });
  const ids = uid !== null && gid !== null ? `${uid}:${gid}` : '<uid>:<gid>';
  return (
    `The installer cannot write its official location: ${owners.join(', ')} is not writable by ${who}. ` +
    `This is usually left by a \`docker exec\` without \`--user\` (it runs as root), or by a pocketagent-server ` +
    `image from before PA-104's fix. Fix the ownership, as root: \`chown -R ${ids} ${roots.join(' ')}\` — in a ` +
    `container, run it through \`docker exec -u 0 <container> …\`. Nothing was installed.`
  );
}

/**
 * Turn a runner outcome into the *real* error, or null on success.
 *
 * Deliberately specific rather than "install failed": the three ways this goes
 * wrong — the command missing entirely, the command refusing, and a run that
 * went on too long — are different problems with different fixes. The
 * command's own output is already in the log; this is the one-line summary
 * that gets persisted.
 */
export function installFailure(outcome: RunOutcome, what: string): string | null {
  if (outcome.startError !== null) {
    return what === 'npm'
      ? `Could not run npm: ${outcome.startError}. Node's npm must be on the server's PATH for this.`
      : `Could not run ${what}: ${outcome.startError}.`;
  }
  if (outcome.timedOut) {
    return `${what} took longer than ${Math.round(INSTALL_TIMEOUT_MS / 60000)} minutes and was stopped.`;
  }
  if (outcome.code !== 0) {
    return `${what === 'npm' ? 'npm' : what} exited with code ${outcome.code ?? 'unknown'}. See the log above for its own error.`;
  }
  return null;
}

/**
 * The real runner: argv, never through a shell.
 *
 * `detached: true` puts the child in its own session, which takes away its
 * controlling terminal. That is load-bearing: codex's and pi's installers
 * prompt on `/dev/tty` when they can open it, and a server started from a
 * terminal would otherwise hand them one — the prompt would wait, unseen,
 * until the 10-minute timeout. With no terminal both proceed non-interactively
 * by their own documented rules. It also makes the whole process group
 * killable on timeout, since an installer's children (curl, npm, tar) are what
 * actually hang.
 *
 * stdout and stderr are merged on purpose — progress goes to one and results to
 * the other, and an operator wants them interleaved in the order they happened.
 */
const defaultRunner: InstallRunner = ({ command, args, env, unsetEnv, cwd, onOutput }) =>
  new Promise((resolve) => {
    const childEnv = buildChildEnv({ cwd, overrides: env });
    for (const key of unsetEnv) delete childEnv[key];
    let child;
    try {
      child = spawn(command, args, { cwd, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, timedOut: false, startError: (err as Error).message });
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      resolve({ code: null, timedOut: true, startError: null });
    }, INSTALL_TIMEOUT_MS);
    timer.unref?.();

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

const defaultFetchScript: ScriptFetcher = async (url) => {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(SCRIPT_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_SCRIPT_BYTES) throw new Error(`response is ${declared} bytes`);
  const body = Buffer.from(await res.arrayBuffer());
  return { body, finalUrl: res.url || url };
};
