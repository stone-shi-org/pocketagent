import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  BROWSER_ID_PATTERN,
  type BrowserInfo,
  type BrowserListResponse,
  type BrowserScopeKind,
  type BrowserState,
  type BrowserTab,
} from '@pocketagent/protocol';
import type { PlannerWorkspaceRegistry } from '../planner/workspaces.js';
import { isContained, type WorkspaceRegistry } from '../workspaces/index.js';
import { CdpConnection } from './cdp.js';
import {
  buildChromiumArgs,
  chromiumMajorVersion,
  findChromiumExecutable,
  killGroup,
  launchChromium,
  probeSandbox,
  type LaunchedChromium,
} from './chromium.js';

/**
 * PA-178: the server owns the browsers agents log in with.
 *
 * A login only helps if it lands in the browser the agent then uses, so the
 * browser is the server's, not the agent's: one instance and one persistent
 * profile per *scope* — a project folder or a Pocket Agent — started on first
 * use (a viewer opening it, or an agent asking for its endpoint), reached by
 * agents with `playwright-cli attach --cdp=<cdpUrl>`, and stopped once nobody
 * has used it for `idleMs`.
 *
 * Scopes are keyed off the two registries that already exist rather than a
 * table of their own: a project browser is `project-<sha256(root)>` for an
 * *added* folder, a Pocket Agent's is `pocket-<workspaceId>`. Removing either
 * leaves the profile on disk until someone clears it — nothing here deletes a
 * login silently.
 *
 * Profiles hold live cookies and session tokens, so they live under the data
 * root beside the database (never in a workspace), are created 0700, and are
 * refused to the planner's file tools (`isInternalStorePath`).
 */

export class BrowserError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'unavailable' | 'running' | 'invalid' | 'failed',
  ) {
    super(message);
  }
}

export interface BrowserLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface BrowserServiceOptions {
  dataDir: string;
  workspaces: WorkspaceRegistry;
  plannerWorkspaces: PlannerWorkspaceRegistry;
  logger?: BrowserLogger;
  /** Stop an unused browser after this long; 0 = never. Default 15 minutes. */
  idleMs?: number;
  /** Injected by tests; default `findChromiumExecutable()`. */
  findExecutable?: () => string | null;
  /** Injected by tests; default `launchChromium`. */
  launch?: (executable: string, args: string[]) => Promise<LaunchedChromium>;
  probeSandbox?: (executable: string, majorVersion: string) => Promise<boolean>;
  majorVersion?: (executable: string) => string;
  connect?: (url: string) => Promise<CdpConnection>;
  now?: () => number;
}

export type BrowserInstanceEvent =
  | { type: 'targets' }
  | { type: 'focus'; targetId: string }
  | { type: 'navigated'; targetId: string; url: string }
  | { type: 'closed'; reason: string };

interface PageTarget {
  url: string;
  title: string;
}

/** One running browser. The viewer reads `cdp` and `targets`; nothing else does. */
export interface BrowserInstance {
  readonly id: string;
  state: Exclude<BrowserState, 'stopped'>;
  readonly launched: LaunchedChromium;
  readonly cdp: CdpConnection;
  readonly targets: Map<string, PageTarget>;
  viewers: number;
  lastActivityAt: number;
  /** The tab a handoff opened; a viewer starts there rather than on the first tab. */
  focusTargetId: string | null;
  readonly listeners: Set<(event: BrowserInstanceEvent) => void>;
  exited: Promise<void>;
}

export const DEFAULT_BROWSER_IDLE_MS = 15 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const CLOSE_GRACE_MS = 5_000;

export function projectBrowserId(canonicalRoot: string): string {
  return `project-${crypto.createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16)}`;
}

export function pocketBrowserId(plannerWorkspaceId: string): string | null {
  const id = `pocket-${plannerWorkspaceId}`;
  return BROWSER_ID_PATTERN.test(id) ? id : null;
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export class BrowserService {
  private readonly instances = new Map<string, BrowserInstance>();
  private readonly starting = new Map<string, Promise<BrowserInstance>>();
  /**
   * Parked `request_browser_help` calls per browser id. Kept apart from the
   * instance on purpose: a browser that crashes and is reopened while a
   * person is still being asked must not lose the hold that keeps the idle
   * sweep away from it.
   */
  private readonly helpCounts = new Map<string, number>();
  private readonly profileRoot: string;
  private sandbox: boolean | null = null;
  private executable: string | null | undefined;
  private major: string | null = null;
  private readonly sweepTimer: NodeJS.Timeout;
  private readonly idleMs: number;
  private readonly now: () => number;
  private stopped = false;

  constructor(private readonly opts: BrowserServiceOptions) {
    this.profileRoot = path.join(opts.dataDir, 'browser-profiles');
    this.idleMs = opts.idleMs ?? DEFAULT_BROWSER_IDLE_MS;
    this.now = opts.now ?? Date.now;
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  // ---- availability ----------------------------------------------------------

  private resolveExecutable(): string | null {
    if (this.executable === undefined) {
      this.executable = (this.opts.findExecutable ?? findChromiumExecutable)();
    }
    return this.executable;
  }

  available(): { available: boolean; reason: string | null } {
    if (this.resolveExecutable() === null) {
      return {
        available: false,
        reason:
          'No Chromium is installed for Playwright on this host (PLAYWRIGHT_BROWSERS_PATH). The `all` image ships one.',
      };
    }
    return { available: true, reason: null };
  }

  /** Null until the first launch has probed it. */
  sandboxAvailable(): boolean | null {
    return this.sandbox;
  }

  // ---- scopes ------------------------------------------------------------------

  /** The project browser for a session's cwd: the deepest added folder containing it. */
  scopeForCwd(cwd: string): string | null {
    const real = realpathOrSelf(cwd);
    let best: string | null = null;
    for (const root of this.opts.workspaces.getRoots()) {
      const canonical = realpathOrSelf(root);
      if (isContained(canonical, real) && (best === null || canonical.length > best.length)) best = canonical;
    }
    return best === null ? null : projectBrowserId(best);
  }

  scopeForPlannerWorkspace(workspaceId: string | null): string | null {
    if (!workspaceId || !this.opts.plannerWorkspaces.get(workspaceId)) return null;
    return pocketBrowserId(workspaceId);
  }

  /** What a browser id names, or null when it names nothing that exists. */
  describe(id: string): { kind: BrowserScopeKind; label: string } | null {
    if (!BROWSER_ID_PATTERN.test(id)) return null;
    if (id.startsWith('pocket-')) {
      const row = this.opts.plannerWorkspaces.get(id.slice('pocket-'.length));
      return row ? { kind: 'pocket', label: row.name } : null;
    }
    for (const root of this.opts.workspaces.getRoots()) {
      const canonical = realpathOrSelf(root);
      if (projectBrowserId(canonical) === id) {
        return { kind: 'project', label: this.opts.workspaces.labelFor(canonical) };
      }
    }
    return null;
  }

  private allScopeIds(): string[] {
    const ids = new Set<string>();
    for (const root of this.opts.workspaces.getRoots()) ids.add(projectBrowserId(realpathOrSelf(root)));
    for (const row of this.opts.plannerWorkspaces.list()) {
      const id = pocketBrowserId(row.id);
      if (id) ids.add(id);
    }
    for (const id of this.instances.keys()) ids.add(id);
    return [...ids];
  }

  // ---- profiles ----------------------------------------------------------------

  /**
   * The profile root, created 0700 and refused if it resolves inside a
   * workspace root. Checked on every launch rather than once at boot, because
   * a folder added from the UI later can come to contain the data root.
   */
  private ensureProfileRoot(): string {
    fs.mkdirSync(this.profileRoot, { recursive: true, mode: 0o700 });
    const real = fs.realpathSync(this.profileRoot);
    for (const root of this.opts.workspaces.getRoots()) {
      if (isContained(realpathOrSelf(root), real)) {
        throw new BrowserError(
          `Browser profiles (${real}) would sit inside the project folder ${root}, where an agent could read live logins. Move POCKETAGENT_DATA_DIR outside every project folder.`,
          'unavailable',
        );
      }
    }
    return real;
  }

  private profileDirFor(id: string): string {
    if (!BROWSER_ID_PATTERN.test(id)) throw new BrowserError('Invalid browser id.', 'invalid');
    return path.join(this.profileRoot, id);
  }

  /** True for any path inside the profile store — the planner's file tools refuse those. */
  isInternalStorePath(targetPath: string): boolean {
    return isContained(realpathOrSelf(this.profileRoot), realpathOrSelf(targetPath));
  }

  /** The profile root itself, for tests and the docs. */
  get profilesRoot(): string {
    return this.profileRoot;
  }

  private hasProfile(id: string): boolean {
    try {
      return fs.statSync(this.profileDirFor(id)).isDirectory();
    } catch {
      return false;
    }
  }

  // ---- lifecycle ---------------------------------------------------------------

  get(id: string): BrowserInstance | undefined {
    const inst = this.instances.get(id);
    return inst && inst.state === 'running' ? inst : undefined;
  }

  /** The CDP endpoint of a *running* browser, for a session's environment. */
  cdpUrlIfRunning(id: string | null): string | null {
    if (!id) return null;
    return this.get(id)?.launched.cdpUrl ?? null;
  }

  async ensure(id: string): Promise<BrowserInstance> {
    if (this.stopped) throw new BrowserError('The server is shutting down.', 'unavailable');
    if (!this.describe(id)) throw new BrowserError('No project folder or Pocket Agent has that browser.', 'not_found');
    const running = this.get(id);
    if (running) {
      running.lastActivityAt = this.now();
      return running;
    }
    const inflight = this.starting.get(id);
    if (inflight) return inflight;
    const existing = this.instances.get(id);
    if (existing?.state === 'stopping') await existing.exited;
    const promise = this.start(id).finally(() => this.starting.delete(id));
    this.starting.set(id, promise);
    return promise;
  }

  private async start(id: string): Promise<BrowserInstance> {
    const executable = this.resolveExecutable();
    if (!executable) throw new BrowserError(this.available().reason ?? 'No browser.', 'unavailable');
    this.ensureProfileRoot();
    const profileDir = this.profileDirFor(id);
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    this.major ??= (this.opts.majorVersion ?? chromiumMajorVersion)(executable);
    this.sandbox ??= await (this.opts.probeSandbox ?? probeSandbox)(executable, this.major);
    if (!this.sandbox) {
      this.opts.logger?.warn(
        { id },
        'Chromium renderer sandbox is unavailable on this host (no unprivileged user namespaces); running with --no-sandbox, as Playwright does',
      );
    }
    const args = buildChromiumArgs({ profileDir, sandbox: this.sandbox, majorVersion: this.major });
    let launched: LaunchedChromium;
    try {
      launched = await (this.opts.launch ?? ((exe, a) => launchChromium(exe, a)))(executable, args);
    } catch (err) {
      throw new BrowserError(`The browser could not start: ${(err as Error).message}`, 'failed');
    }
    let cdp: CdpConnection;
    try {
      cdp = await (this.opts.connect ?? ((url) => CdpConnection.connect(url)))(launched.browserWsUrl);
    } catch (err) {
      killGroup(launched.child, 'SIGKILL');
      throw new BrowserError(`The browser started but could not be reached: ${(err as Error).message}`, 'failed');
    }
    let resolveExited!: () => void;
    const exited = new Promise<void>((r) => (resolveExited = r));
    const inst: BrowserInstance = {
      id,
      state: 'running',
      launched,
      cdp,
      targets: new Map(),
      viewers: 0,
      lastActivityAt: this.now(),
      focusTargetId: null,
      listeners: new Set(),
      exited,
    };
    const emit = (event: BrowserInstanceEvent): void => {
      for (const l of inst.listeners) {
        try {
          l(event);
        } catch {
          // one viewer's failure must not stop the others
        }
      }
    };
    cdp.on((event) => {
      if (event.sessionId) return; // a per-page session's event, not the browser's
      const info = event.params.targetInfo as { targetId?: string; type?: string; url?: string; title?: string } | undefined;
      if (event.method === 'Target.targetCreated' || event.method === 'Target.targetInfoChanged') {
        if (!info?.targetId || info.type !== 'page') return;
        const before = inst.targets.get(info.targetId);
        inst.targets.set(info.targetId, { url: info.url ?? '', title: info.title ?? '' });
        inst.lastActivityAt = this.now();
        if (before && before.url !== (info.url ?? '')) emit({ type: 'navigated', targetId: info.targetId, url: info.url ?? '' });
        emit({ type: 'targets' });
      } else if (event.method === 'Target.targetDestroyed') {
        const targetId = event.params.targetId as string | undefined;
        if (targetId && inst.targets.delete(targetId)) {
          inst.lastActivityAt = this.now();
          emit({ type: 'targets' });
        }
      }
    });
    const onGone = (reason: string): void => {
      if (this.instances.get(id) !== inst) return;
      this.instances.delete(id);
      inst.cdp.close();
      emit({ type: 'closed', reason });
      inst.listeners.clear();
      resolveExited();
    };
    launched.child.once('exit', () => {
      this.opts.logger?.info({ id }, 'shared browser exited');
      onGone('The browser stopped.');
    });
    cdp.onClose(() => {
      // Our control connection dying with the process still up would leave a
      // browser nobody can see or stop — so the process goes with it.
      if (inst.state !== 'stopping') killGroup(launched.child, 'SIGKILL');
    });
    this.instances.set(id, inst);
    try {
      await cdp.send('Target.setDiscoverTargets', { discover: true });
      const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string; title: string }[] }>(
        'Target.getTargets',
      );
      for (const t of targetInfos) if (t.type === 'page') inst.targets.set(t.targetId, { url: t.url, title: t.title });
    } catch (err) {
      await this.stop(id, 'startup failed');
      throw new BrowserError(`The browser started but did not answer: ${(err as Error).message}`, 'failed');
    }
    this.opts.logger?.info({ id, pid: launched.pid, sandbox: this.sandbox }, 'shared browser started');
    return inst;
  }

  /**
   * Stop gracefully. `Browser.close` first: the spike found a SIGTERM loses a
   * login made in the last ~30 s (Chromium flushes cookies to disk on its own
   * schedule, and SIGTERM does not wait for it), while `Browser.close` keeps
   * it. SIGKILL only if the browser does not exit in time.
   */
  async stop(id: string, reason = 'stopped'): Promise<boolean> {
    const inst = this.instances.get(id);
    if (!inst) return false;
    if (inst.state === 'stopping') {
      await inst.exited;
      return true;
    }
    inst.state = 'stopping';
    try {
      await Promise.race([inst.cdp.send('Browser.close'), new Promise((r) => setTimeout(r, CLOSE_GRACE_MS))]);
    } catch {
      // connection already gone; the exit wait below decides
    }
    const exitedInTime = await Promise.race([
      inst.exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), CLOSE_GRACE_MS)),
    ]);
    if (!exitedInTime) {
      killGroup(inst.launched.child, 'SIGKILL');
      await Promise.race([inst.exited, new Promise((r) => setTimeout(r, 2000))]);
      // An exit event that never comes still must not strand the slot.
      if (this.instances.get(id) === inst) {
        this.instances.delete(id);
        for (const l of inst.listeners) l({ type: 'closed', reason });
      }
    }
    this.opts.logger?.info({ id, reason }, 'shared browser stopped');
    return true;
  }

  /** Delete a scope's profile — every login in it. Refused while it runs. */
  async clearData(id: string): Promise<void> {
    if (!BROWSER_ID_PATTERN.test(id)) throw new BrowserError('Invalid browser id.', 'invalid');
    if (this.instances.has(id) || this.starting.has(id)) {
      throw new BrowserError('Stop the browser before clearing its data.', 'running');
    }
    const dir = this.profileDirFor(id);
    if (!fs.existsSync(dir)) return;
    const real = fs.realpathSync(dir);
    if (!isContained(fs.realpathSync(this.profileRoot), real) || real === fs.realpathSync(this.profileRoot)) {
      throw new BrowserError('Refusing to delete outside the profile store.', 'invalid');
    }
    await fs.promises.rm(real, { recursive: true, force: true });
    this.opts.logger?.info({ id }, 'shared browser data cleared');
  }

  /** A viewer holds a running browser open; released when it disconnects. */
  holdViewer(id: string): () => void {
    const inst = this.instances.get(id);
    if (!inst) return () => undefined;
    inst.viewers++;
    inst.lastActivityAt = this.now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inst.viewers = Math.max(0, inst.viewers - 1);
      inst.lastActivityAt = this.now();
    };
  }

  /** A parked help request holds the *scope* — whichever instance serves it. */
  holdForHelp(id: string): () => void {
    this.helpCounts.set(id, (this.helpCounts.get(id) ?? 0) + 1);
    this.touch(id);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.helpCounts.get(id) ?? 1) - 1;
      if (n <= 0) this.helpCounts.delete(id);
      else this.helpCounts.set(id, n);
      this.touch(id);
    };
  }

  pendingHelpCount(id: string): number {
    return this.helpCounts.get(id) ?? 0;
  }

  /**
   * Open `url` in a new tab and make it the one viewers show — what a handoff
   * does with the page the agent was stuck on. The URL is the caller's to
   * have checked (http(s) only).
   */
  async openForHandoff(id: string, url: string): Promise<void> {
    const inst = this.get(id);
    if (!inst) return;
    const { targetId } = await inst.cdp.send<{ targetId: string }>('Target.createTarget', { url });
    if (!inst.targets.has(targetId)) inst.targets.set(targetId, { url, title: '' });
    inst.focusTargetId = targetId;
    for (const l of inst.listeners) {
      try {
        l({ type: 'focus', targetId });
      } catch {
        // one viewer's failure must not stop the others
      }
    }
  }

  touch(id: string): void {
    const inst = this.instances.get(id);
    if (inst) inst.lastActivityAt = this.now();
  }

  subscribe(id: string, listener: (event: BrowserInstanceEvent) => void): () => void {
    const inst = this.instances.get(id);
    if (!inst) return () => undefined;
    inst.listeners.add(listener);
    return () => inst.listeners.delete(listener);
  }

  private async sweep(): Promise<void> {
    if (this.idleMs <= 0) return;
    const now = this.now();
    for (const inst of [...this.instances.values()]) {
      if (inst.state !== 'running' || inst.viewers > 0 || this.pendingHelpCount(inst.id) > 0) continue;
      if (now - inst.lastActivityAt >= this.idleMs) await this.stop(inst.id, 'idle');
    }
  }

  /** Exposed for tests: run the idle sweep now. */
  runIdleSweep(): Promise<void> {
    return this.sweep();
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.sweepTimer);
    await Promise.all([...this.instances.keys()].map((id) => this.stop(id, 'server shutdown')));
  }

  // ---- views -------------------------------------------------------------------

  tabsOf(id: string, selected: string | null = null): BrowserTab[] {
    const inst = this.instances.get(id);
    if (!inst) return [];
    return [...inst.targets].map(([tabId, t]) => ({ id: tabId, url: t.url, title: t.title, selected: tabId === selected }));
  }

  info(id: string): BrowserInfo | null {
    const scope = this.describe(id);
    const inst = this.instances.get(id);
    if (!scope && !inst) return null;
    return {
      id,
      kind: scope?.kind ?? (id.startsWith('pocket-') ? 'pocket' : 'project'),
      label: scope?.label ?? id,
      state: inst ? inst.state : this.starting.has(id) ? 'starting' : 'stopped',
      cdpUrl: inst?.state === 'running' ? inst.launched.cdpUrl : null,
      tabs: this.tabsOf(id),
      viewers: inst?.viewers ?? 0,
      pendingHelp: this.pendingHelpCount(id),
      hasProfile: this.hasProfile(id),
    };
  }

  list(): BrowserListResponse {
    const { available, reason } = this.available();
    const browsers = this.allScopeIds()
      .map((id) => this.info(id))
      .filter((b): b is BrowserInfo => b !== null);
    return { available, unavailableReason: reason, sandbox: this.sandbox, browsers };
  }
}
