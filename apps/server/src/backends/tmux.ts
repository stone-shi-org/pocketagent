import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { ExitListener, ProcessBackend, ProcessHandle, ProcessSpec } from './types.js';

const execFileAsync = promisify(execFile);

/** Prefix for tmux session names we own. Anything else is left alone. */
const SESSION_PREFIX = 'pocketagent-';

/** How often we look for panes whose process has exited. One call covers all. */
const POLL_INTERVAL_MS = 1000;

/** Lines of tmux scrollback replayed into the buffer when re-adopting. */
const RECOVER_SCROLLBACK_LINES = 2000;

export interface TmuxBackendOptions {
  /** tmux executable. */
  bin?: string;
  /** Private socket name, so we never touch the user's own tmux server. */
  socket?: string;
  /** Base environment for the tmux server. Must already be sanitized. */
  serverEnv?: Record<string, string>;
  logger?: { warn: (o: object, m?: string) => void; info: (o: object, m?: string) => void };
}

interface PaneState {
  dead: boolean;
  deadStatus: number | null;
  panePid: number | null;
}

export function tmuxSessionName(sessionId: string): string {
  return `${SESSION_PREFIX}${sessionId}`;
}

export function sessionIdFromTmuxName(name: string): string | null {
  return name.startsWith(SESSION_PREFIX) ? name.slice(SESSION_PREFIX.length) : null;
}

class TmuxProcessHandle implements ProcessHandle {
  private client: IPty | null = null;
  private dataListeners: ((data: string) => void)[] = [];
  private exitListeners: ExitListener[] = [];
  /** Output produced before a listener attached (recovered scrollback). */
  private pending: string[] = [];
  private finished = false;
  private detached = false;
  private reattachBudget = 3;

  panePid: number | null = null;

  constructor(
    private readonly backend: TmuxBackend,
    readonly externalId: string,
  ) {}

  get pid(): number | null {
    return this.panePid;
  }

  /** Push output as if it had come from the pane. Used to seed scrollback. */
  emitData(data: string): void {
    if (data.length === 0) return;
    if (this.dataListeners.length === 0) this.pending.push(data);
    else for (const listener of this.dataListeners) listener(data);
  }

  attachClient(client: IPty): void {
    this.client = client;
    client.onData((data) => this.emitData(data));
    client.onExit(() => {
      this.client = null;
      if (this.finished || this.detached) return;
      // The tmux client died but the pane may well be fine (someone ran
      // `tmux kill-client`, or the client crashed). Reattach so output keeps
      // flowing; the poller is what decides the process is actually gone.
      void this.tryReattach();
    });
  }

  private async tryReattach(): Promise<void> {
    if (this.reattachBudget <= 0 || this.finished || this.detached) return;
    this.reattachBudget--;
    await new Promise((r) => setTimeout(r, 250));
    if (this.finished || this.detached) return;
    if (!(await this.backend.hasSession(this.externalId))) return;
    try {
      this.attachClient(this.backend.spawnAttachClient(this.externalId));
    } catch {
      // The poller will report the exit if the session is really gone.
    }
  }

  write(data: string): void {
    this.client?.write(data);
  }

  resize(cols: number, rows: number): void {
    try {
      // Resizing our tmux client resizes the window, because the server runs
      // with `window-size latest`.
      this.client?.resize(cols, rows);
    } catch {
      /* client went away */
    }
  }

  kill(signal: NodeJS.Signals): void {
    if (this.panePid === null) {
      void this.backend.killSession(this.externalId);
      return;
    }
    try {
      // Signal the pane's process, not our local tmux client.
      process.kill(this.panePid, signal);
    } catch {
      /* already gone */
    }
  }

  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener);
    if (this.pending.length > 0) {
      const queued = this.pending.join('');
      this.pending = [];
      listener(queued);
    }
  }

  onExit(listener: ExitListener): void {
    this.exitListeners.push(listener);
  }

  /** Called by the backend poller. */
  reportExit(exitCode: number | null, signal: number | null): void {
    if (this.finished) return;
    this.finished = true;
    this.closeClient();
    for (const listener of this.exitListeners) listener(exitCode, signal);
    void this.backend.killSession(this.externalId);
  }

  private closeClient(): void {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    try {
      client.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }

  /**
   * Drop our local tmux client. The tmux server keeps the pane running, which
   * is the entire reason this backend exists.
   */
  detach(): void {
    this.detached = true;
    this.closeClient();
  }

  isFinished(): boolean {
    return this.finished;
  }
}

/**
 * Runs each agent inside its own tmux session on a private socket.
 *
 * The tmux server is a separate, long-lived process, so restarting or crashing
 * PocketAgent leaves the agents running; on the next boot we re-attach and
 * carry on.
 *
 * The socket is private (`-L`) and the config is skipped (`-f /dev/null`) so we
 * neither depend on nor disturb the user's own tmux setup, and so a stray
 * `.tmux.conf` cannot rebind keys out from under an agent.
 */
export class TmuxBackend implements ProcessBackend {
  readonly id = 'tmux' as const;
  readonly displayName = 'tmux';
  readonly survivesServerRestart = true;

  private readonly bin: string;
  private readonly socket: string;
  private readonly serverEnv: Record<string, string>;
  private readonly logger: TmuxBackendOptions['logger'];

  private readonly handles = new Map<string, TmuxProcessHandle>();
  private poller: NodeJS.Timeout | null = null;
  private serverReady = false;

  constructor(options: TmuxBackendOptions = {}) {
    this.bin = options.bin ?? 'tmux';
    this.socket = options.socket ?? 'pocketagent';
    this.serverEnv = options.serverEnv ?? {};
    this.logger = options.logger;
  }

  private socketArgs(): string[] {
    return ['-L', this.socket, '-f', '/dev/null'];
  }

  /** Run a tmux command. Arguments are passed as argv — never through a shell. */
  private async tmux(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(this.bin, [...this.socketArgs(), ...args], {
      env: this.serverEnv,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  }

  private async tmuxOk(args: string[]): Promise<boolean> {
    try {
      await this.tmux(args);
      return true;
    } catch {
      return false;
    }
  }

  async checkAvailable(): Promise<{ available: boolean; reason?: string }> {
    try {
      const { stdout } = await execFileAsync(this.bin, ['-V'], { env: this.serverEnv });
      return { available: true, reason: stdout.trim() };
    } catch {
      return {
        available: false,
        reason: `"${this.bin}" was not found on PATH. Install tmux or set POCKETAGENT_BACKEND=direct.`,
      };
    }
  }

  /**
   * Start the tmux server (if needed) and apply our options.
   *
   * These are set in a single chained command on a possibly-empty server so
   * there is no window in which a session could be created without them —
   * `prefix None` in particular, because a tmux server with the default prefix
   * would swallow every Ctrl-B the agent should have received.
   */
  private async ensureServer(): Promise<void> {
    if (this.serverReady) return;
    await this.tmux([
      'start-server',
      ';',
      'set-option', '-g', 'exit-empty', 'off',
      ';',
      // No prefix key: every keystroke belongs to the agent, not to tmux.
      'set-option', '-g', 'prefix', 'None',
      ';',
      'set-option', '-g', 'prefix2', 'None',
      ';',
      'set-option', '-g', 'status', 'off',
      ';',
      // Do not let an attaching client's environment bleed into new panes.
      'set-option', '-g', 'update-environment', '',
      ';',
      'set-option', '-g', 'default-terminal', 'screen-256color',
      ';',
      // xterm.js does truecolor; tell tmux the outer terminal can take it.
      'set-option', '-ga', 'terminal-features', ',*:RGB',
      ';',
      // Size the window to the most recent client instead of the smallest, so a
      // phone attaching does not shrink a desktop's view permanently.
      'set-option', '-wg', 'window-size', 'latest',
      ';',
      // Keep the pane after its process exits, just long enough for the poller
      // to read the real exit status.
      'set-option', '-wg', 'remain-on-exit', 'on',
      ';',
      'set-option', '-wg', 'history-limit', String(RECOVER_SCROLLBACK_LINES * 2),
    ]);
    this.serverReady = true;
  }

  async hasSession(name: string): Promise<boolean> {
    return this.tmuxOk(['has-session', '-t', `=${name}`]);
  }

  async killSession(name: string): Promise<void> {
    await this.tmuxOk(['kill-session', '-t', `=${name}`]);
  }

  /** Spawn a local tmux client attached to `name`, inside a PTY we control. */
  spawnAttachClient(name: string): IPty {
    return pty.spawn(this.bin, [...this.socketArgs(), 'attach-session', '-t', `=${name}`], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: { ...this.serverEnv, TERM: 'xterm-256color' },
    });
  }

  async start(spec: ProcessSpec): Promise<ProcessHandle> {
    await this.ensureServer();
    const name = tmuxSessionName(spec.sessionId);

    // A leftover session with this name would be silently reused; refuse.
    if (await this.hasSession(name)) {
      await this.killSession(name);
    }

    // `-e` sets the session environment explicitly rather than inheriting
    // whatever the tmux server happened to start with.
    const envArgs = Object.entries(spec.env).flatMap(([key, value]) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? ['-e', `${key}=${value}`] : [],
    );

    await this.tmux([
      'new-session',
      '-d',
      '-s', name,
      '-x', String(spec.cols),
      '-y', String(spec.rows),
      '-c', spec.cwd,
      ...envArgs,
      '--',
      spec.command,
      ...spec.args,
    ]);

    const handle = new TmuxProcessHandle(this, name);
    handle.panePid = await this.readPanePid(name);
    handle.attachClient(this.spawnAttachClient(name));
    handle.resize(spec.cols, spec.rows);

    this.track(name, handle);
    return handle;
  }

  async recover(externalId: string, spec: ProcessSpec): Promise<ProcessHandle | null> {
    await this.ensureServer();
    if (!(await this.hasSession(externalId))) return null;

    const handle = new TmuxProcessHandle(this, externalId);
    handle.panePid = await this.readPanePid(externalId);

    // Seed the ring buffer with what the pane already holds, so a reconnecting
    // browser sees history rather than a blank screen followed by a redraw.
    const scrollback = await this.captureScrollback(externalId);
    if (scrollback) handle.emitData(scrollback);

    handle.attachClient(this.spawnAttachClient(externalId));
    handle.resize(spec.cols, spec.rows);

    this.track(externalId, handle);
    this.logger?.info({ tmuxSession: externalId, pid: handle.panePid }, 'recovered tmux session');
    return handle;
  }

  async listRecoverable(): Promise<string[]> {
    if (!(await this.checkAvailable()).available) return [];
    try {
      const stdout = await this.tmux(['list-sessions', '-F', '#{session_name}']);
      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((name) => name.startsWith(SESSION_PREFIX));
    } catch {
      // No server running means nothing to recover.
      return [];
    }
  }

  private async captureScrollback(name: string): Promise<string> {
    try {
      // -e keeps colour; -J unwraps; -S starts N lines back.
      const stdout = await this.tmux([
        'capture-pane',
        '-p',
        '-e',
        '-S',
        `-${RECOVER_SCROLLBACK_LINES}`,
        '-t',
        `=${name}`,
      ]);
      const trimmed = stdout.replace(/\n+$/, '');
      if (!trimmed) return '';
      return `${trimmed.replace(/\n/g, '\r\n')}\r\n`;
    } catch {
      return '';
    }
  }

  private async readPanePid(name: string): Promise<number | null> {
    try {
      const stdout = await this.tmux(['list-panes', '-t', `=${name}`, '-F', '#{pane_pid}']);
      const pid = Number.parseInt(stdout.trim().split('\n')[0] ?? '', 10);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  private track(name: string, handle: TmuxProcessHandle): void {
    this.handles.set(name, handle);
    this.startPolling();
  }

  private startPolling(): void {
    if (this.poller !== null) return;
    this.poller = setInterval(() => {
      void this.poll();
    }, POLL_INTERVAL_MS);
    this.poller.unref?.();
  }

  private stopPollingIfIdle(): void {
    if (this.handles.size > 0 || this.poller === null) return;
    clearInterval(this.poller);
    this.poller = null;
  }

  /**
   * One `list-panes -a` covers every session, so exit detection costs a single
   * subprocess per second no matter how many agents are running.
   */
  private async poll(): Promise<void> {
    if (this.handles.size === 0) {
      this.stopPollingIfIdle();
      return;
    }

    let states: Map<string, PaneState>;
    try {
      const stdout = await this.tmux([
        'list-panes',
        '-a',
        '-F',
        `#{session_name}${PANE_FIELD_SEP}#{pane_dead}${PANE_FIELD_SEP}#{pane_dead_status}${PANE_FIELD_SEP}#{pane_pid}`,
      ]);
      states = parsePaneStates(stdout);
    } catch {
      // The tmux server is gone entirely: every tracked pane is finished.
      states = new Map();
    }

    for (const [name, handle] of [...this.handles]) {
      if (handle.isFinished()) {
        this.handles.delete(name);
        continue;
      }

      const state = states.get(name);
      if (!state) {
        // Session vanished without us seeing the exit status.
        handle.reportExit(null, null);
        this.handles.delete(name);
        continue;
      }

      if (state.panePid !== null) handle.panePid = state.panePid;

      if (state.dead) {
        handle.reportExit(state.deadStatus, null);
        this.handles.delete(name);
      }
    }

    this.stopPollingIfIdle();
  }

  /** Stop watching. Does not stop any agent — that is the point of tmux. */
  dispose(): void {
    if (this.poller !== null) clearInterval(this.poller);
    this.poller = null;
    for (const handle of this.handles.values()) handle.detach();
    this.handles.clear();
  }
}

/**
 * Field separator for `list-panes -F`.
 *
 * Not a tab: tmux does not pass a literal tab through a format string
 * unchanged, which silently collapses every line into a single field and makes
 * the poller think each session has vanished.
 */
export const PANE_FIELD_SEP = '|';

export function parsePaneStates(stdout: string): Map<string, PaneState> {
  const states = new Map<string, PaneState>();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(PANE_FIELD_SEP);
    if (parts.length < 4) continue;
    // Parse from the right: the last three fields are ours, and anything before
    // them is the session name — which, for a session we did not create, may
    // itself contain the separator.
    const [panePid, deadStatus, dead] = [parts.pop()!, parts.pop()!, parts.pop()!];
    const name = parts.join(PANE_FIELD_SEP);
    if (!name) continue;

    const status = Number.parseInt(deadStatus, 10);
    const pid = Number.parseInt(panePid, 10);
    states.set(name, {
      dead: dead === '1',
      deadStatus: Number.isFinite(status) ? status : null,
      panePid: Number.isFinite(pid) ? pid : null,
    });
  }
  return states;
}
