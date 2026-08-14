import {
  PROTOCOL_VERSION,
  ServerMessage,
  WsCloseCode,
  type AgentEvent,
  type AskUserQuestionAnswer,
  type ClientMessage,
  type EffortLevel,
  type PermissionDecision,
  type PermissionRequestEvent,
  type SessionInfo,
  type SessionStatus,
  type TerminalHintKind,
} from '@pocketagent/protocol';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface TerminalConnectionHandlers {
  /** Live output. `seq` has already been de-duplicated and ordered. */
  onOutput?: (data: string, seq: number) => void;
  /**
   * Buffered output delivered on attach. When `truncated` is true the data is
   * NOT contiguous with what was previously rendered, so the caller must clear
   * the screen before writing it.
   */
  onReplay?: (data: string, truncated: boolean) => void;
  onAttached?: (session: SessionInfo) => void;
  onStatus?: (status: SessionStatus, session?: SessionInfo) => void;
  onExit?: (exitCode: number | null, exitSignal: number | null) => void;
  onConnectionState?: (state: ConnectionState) => void;
  onHint?: (hints: TerminalHintKind[]) => void;
  onError?: (code: string, message: string) => void;
  /**
   * The server closed the socket for a reason retrying cannot fix (a
   * protocol version skew after this tab's bundle went stale, so far). Distinct
   * from `onError`, which is for a recoverable, server-sent `error` frame —
   * this fires on the close itself and reconnecting stops, since the server
   * would just say the same thing again.
   */
  onFatal?: (message: string) => void;

  // ---- Structured sessions ----
  /** One live agent event, already de-duplicated on `seq`. */
  onAgentEvent?: (event: AgentEvent, seq: number) => void;
  /**
   * Buffered agent events delivered on attach. `truncated` means older events
   * were evicted, so the caller should reset its transcript before applying.
   */
  onAgentReplay?: (events: AgentEvent[], truncated: boolean) => void;
  /** Approvals still awaiting an answer at attach time. */
  onPendingPermissions?: (requests: PermissionRequestEvent[]) => void;
}

export interface TerminalConnectionOptions {
  handlers: TerminalConnectionHandlers;
  /** Injectable for tests. */
  createSocket?: (url: string) => WebSocket;
  /** Injectable for tests; must return a value in ms. */
  now?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Deterministic jitter in tests. */
  random?: () => number;
}

const DEFAULT_BASE_DELAY = 500;
const DEFAULT_MAX_DELAY = 15_000;

function wsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/ws?v=${PROTOCOL_VERSION}`;
}

/**
 * A reconnecting WebSocket bound to one PTY session.
 *
 * The invariant that makes reconnects safe is `lastSeq`: every output frame the
 * client renders advances it, and every attach sends it back as `afterSeq`, so
 * the server replays exactly the gap. Frames at or below `lastSeq` are dropped,
 * which covers the small overlap window between the server snapshotting its
 * buffer and subscribing us to live output.
 */
export class TerminalConnection {
  private socket: WebSocket | null = null;
  private sessionId: string | null = null;
  private lastSeq = 0;
  /**
   * Epoch the current `lastSeq` belongs to. Sent back on attach so the server
   * can tell us to resynchronise if the stream restarted while we were away.
   */
  private epoch: string | null = null;
  private attempt = 0;
  private state: ConnectionState = 'disconnected';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private pendingSize: { cols: number; rows: number } | null = null;

  private readonly handlers: TerminalConnectionHandlers;
  private readonly createSocket: (url: string) => WebSocket;
  private readonly baseDelay: number;
  private readonly maxDelay: number;
  private readonly random: () => number;

  constructor(options: TerminalConnectionOptions) {
    this.handlers = options.handlers;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.baseDelay = options.baseDelayMs ?? DEFAULT_BASE_DELAY;
    this.maxDelay = options.maxDelayMs ?? DEFAULT_MAX_DELAY;
    this.random = options.random ?? Math.random;
  }

  getState(): ConnectionState {
    return this.state;
  }

  getLastSeq(): number {
    return this.lastSeq;
  }

  /** Attach to a session, connecting if necessary. */
  open(sessionId: string, size?: { cols: number; rows: number }): void {
    if (this.sessionId !== sessionId) {
      // A different session means a different output stream; start from zero.
      this.lastSeq = 0;
      this.epoch = null;
    }
    this.sessionId = sessionId;
    if (size) this.pendingSize = size;
    this.closedByUser = false;
    this.connect();
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onConnectionState?.(state);
  }

  private connect(): void {
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) return;

    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let socket: WebSocket;
    try {
      socket = this.createSocket(wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.setState('connected');
      this.sendAttach();
    };

    socket.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };

    socket.onerror = () => {
      // `onclose` always follows; reconnect scheduling lives there.
    };

    socket.onclose = (event: CloseEvent) => {
      this.socket = null;
      if (this.closedByUser) {
        this.setState('disconnected');
        return;
      }
      // A version skew is permanent until this tab reloads — the server will
      // reject the next attempt with the exact same close code, so retrying
      // is just "Reconnecting…" forever with no way out. Stop and say so,
      // rather than let this look identical to a transient drop.
      if (event.code === WsCloseCode.PROTOCOL_MISMATCH) {
        this.setState('disconnected');
        this.handlers.onFatal?.('This app was updated. Reload the page to reconnect.');
        return;
      }
      this.scheduleReconnect();
    };
  }

  private sendAttach(): void {
    if (!this.sessionId) return;
    const message: ClientMessage = {
      type: 'attach',
      sessionId: this.sessionId,
      afterSeq: this.lastSeq,
      ...(this.epoch !== null ? { epoch: this.epoch } : {}),
      ...(this.pendingSize ?? {}),
    };
    this.send(message);
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }

    // The server is trusted, but validating anyway means a protocol skew shows
    // up as a dropped frame rather than a crashed terminal.
    const parsed = ServerMessage.safeParse(json);
    if (!parsed.success) return;
    const message = parsed.data;

    switch (message.type) {
      case 'attached': {
        const { replay, agentReplay } = message;
        const epochChanged = message.session.epoch !== null && message.session.epoch !== this.epoch;
        if (epochChanged) {
          // New stream: sequence numbers from the old one are meaningless.
          this.epoch = message.session.epoch;
          this.lastSeq = 0;
        }
        if (agentReplay) {
          if (agentReplay.events.length > 0 || agentReplay.truncated) {
            this.handlers.onAgentReplay?.(
              agentReplay.events.map((e) => e.event),
              agentReplay.truncated,
            );
          }
          this.lastSeq = Math.max(this.lastSeq, agentReplay.toSeq);
        } else {
          if (replay.data.length > 0 || replay.truncated) {
            this.handlers.onReplay?.(replay.data, replay.truncated);
          }
          this.lastSeq = Math.max(this.lastSeq, replay.toSeq);
        }
        if (message.pendingPermissions) {
          this.handlers.onPendingPermissions?.(
            message.pendingPermissions.filter(
              (e): e is PermissionRequestEvent => e.kind === 'permission_request',
            ),
          );
        }
        this.handlers.onAttached?.(message.session);
        break;
      }
      case 'output': {
        if (message.seq <= this.lastSeq) return; // duplicate from the attach overlap
        this.lastSeq = message.seq;
        this.handlers.onOutput?.(message.data, message.seq);
        break;
      }
      case 'agent_event': {
        if (message.seq <= this.lastSeq) return; // duplicate from the attach overlap
        this.lastSeq = message.seq;
        this.handlers.onAgentEvent?.(message.event, message.seq);
        break;
      }
      case 'status':
        this.handlers.onStatus?.(message.status, message.session);
        break;
      case 'exit':
        this.handlers.onExit?.(message.exitCode, message.exitSignal);
        break;
      case 'hint':
        this.handlers.onHint?.(message.hints);
        break;
      case 'error':
        this.handlers.onError?.(message.code, message.message);
        break;
      case 'pong':
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;

    // Exponential backoff with full jitter, so a server restart does not get a
    // synchronised stampede from every open tab.
    const exponential = Math.min(this.maxDelay, this.baseDelay * 2 ** this.attempt);
    const delay = Math.round(exponential / 2 + this.random() * (exponential / 2));
    this.attempt++;
    this.setState('reconnecting');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private send(message: ClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  /**
   * Send raw keystrokes. Returns false when offline — keystrokes are dropped
   * rather than queued, because replaying stale input into a live terminal
   * minutes later is dangerous.
   */
  sendInput(data: string): boolean {
    if (!this.sessionId) return false;
    return this.send({ type: 'input', sessionId: this.sessionId, data });
  }

  sendResize(cols: number, rows: number): boolean {
    if (!this.sessionId) return false;
    this.pendingSize = { cols, rows };
    return this.send({ type: 'resize', sessionId: this.sessionId, cols, rows });
  }

  sendSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGQUIT' | 'SIGKILL'): boolean {
    if (!this.sessionId) return false;
    return this.send({ type: 'signal', sessionId: this.sessionId, signal });
  }

  /** Send a conversational turn to a structured session. */
  sendPrompt(text: string): boolean {
    if (!this.sessionId) return false;
    return this.send({ type: 'prompt', sessionId: this.sessionId, text });
  }

  /** Answer a pending approval. `answer` carries the choice for a question-shaped tool. */
  sendPermission(
    requestId: string,
    decision: PermissionDecision,
    message?: string,
    answer?: AskUserQuestionAnswer,
  ): boolean {
    if (!this.sessionId) return false;
    return this.send({
      type: 'permission',
      sessionId: this.sessionId,
      requestId,
      decision,
      ...(message ? { message } : {}),
      ...(answer ? { answer } : {}),
    });
  }

  /** Stop the current turn at the next safe point. */
  sendInterrupt(): boolean {
    if (!this.sessionId) return false;
    return this.send({ type: 'interrupt', sessionId: this.sessionId });
  }

  /** Switch a structured session's model. Takes effect on its next prompt. */
  sendModel(model: string): boolean {
    if (!this.sessionId) return false;
    return this.send({ type: 'model', sessionId: this.sessionId, model });
  }

  /**
   * Switch the effort level the current model applies. Takes effect on its
   * next prompt. `null` resets to the model's own default.
   */
  sendEffort(effort: EffortLevel | null): boolean {
    if (!this.sessionId) return false;
    return this.send({ type: 'effort', sessionId: this.sessionId, effort });
  }

  /** Detach and stop reconnecting. The server-side PTY keeps running. */
  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      if (this.sessionId && this.socket.readyState === 1) {
        this.send({ type: 'detach', sessionId: this.sessionId });
      }
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
    this.setState('disconnected');
  }
}
