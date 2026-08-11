/**
 * A process backend decides *where* an agent's process lives.
 *
 * `direct` forks the process from this server, which is simple but means the
 * process dies when the server does. `tmux` hands ownership to a tmux server,
 * which outlives us. Everything above this interface — routes, the WebSocket
 * transport, the replay buffer, persistence — is written against the handle and
 * does not care which one is in use.
 */

export interface ProcessSpec {
  /** PocketAgent session id; backends may derive an external name from it. */
  sessionId: string;
  command: string;
  args: string[];
  cwd: string;
  /** Already sanitized: the POCKETAGENT_* namespace has been removed. */
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export type ExitListener = (exitCode: number | null, signal: number | null) => void;

export interface ProcessHandle {
  /**
   * Pid of the process that receives signals. For `direct` this is the PTY
   * leader; for `tmux` it is the pane's process, not the local tmux client.
   */
  readonly pid: number | null;

  /**
   * Backend-specific identifier that survives a server restart (a tmux session
   * name). `null` for backends whose processes cannot be re-adopted.
   */
  readonly externalId: string | null;

  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Deliver a signal to the process group leader. */
  kill(signal: NodeJS.Signals): void;

  onData(listener: (data: string) => void): void;
  onExit(listener: ExitListener): void;

  /**
   * Stop watching this process and release local resources *without* stopping
   * it. For `direct` this is effectively a kill, because the process cannot
   * outlive us; for `tmux` it detaches the client and leaves the agent running.
   */
  detach(): void;
}

export interface ProcessBackend {
  readonly id: BackendId;
  readonly displayName: string;

  /**
   * Whether a process started by this backend can outlive the PocketAgent
   * server. Drives whether shutdown detaches or terminates, and whether startup
   * tries to recover.
   */
  readonly survivesServerRestart: boolean;

  /** Preflight check, e.g. that the tmux binary exists. */
  checkAvailable(): Promise<{ available: boolean; reason?: string }>;

  start(spec: ProcessSpec): Promise<ProcessHandle>;

  /**
   * Re-adopt a process left behind by a previous server. Returns null when the
   * process is genuinely gone. Only meaningful when `survivesServerRestart`.
   */
  recover?(externalId: string, spec: ProcessSpec): Promise<ProcessHandle | null>;

  /** External ids this backend can currently see. Used to reconcile the DB. */
  listRecoverable?(): Promise<string[]>;

  /** Release backend-wide resources (timers, sockets). Does not stop processes. */
  dispose?(): void;
}

export const BACKEND_IDS = ['direct', 'tmux'] as const;
export type BackendId = (typeof BACKEND_IDS)[number];
