import { z } from 'zod';
import { SessionInfo, SessionStatus } from './session.js';
import {
  AgentEvent,
  AgentReplayPayload,
  AskUserQuestionAnswer,
  EffortLevel,
  PermissionDecision,
} from './agent-events.js';

/**
 * Wire protocol version. The client sends it as a query parameter on the
 * WebSocket URL; the server rejects a mismatch with a close code rather than
 * trying to negotiate. Bump on any breaking frame change.
 *
 * v2 added `epoch` to attach/session so a client cannot resume a sequence
 * number that belonged to a previous run of the output stream.
 * v3 added structured sessions: agent events, prompts, permission decisions
 * and interrupt, alongside the existing raw-terminal frames.
 * v4 added the `session_ended` error code, for attaching to a session this
 * process no longer holds. An older client would drop the frame as invalid and
 * sit on "connecting" forever, so it has to renegotiate rather than guess.
 * v5 added `commands_available`/`command_output` agent events, for a slash-
 * command picker on structured sessions.
 * v6 added the `model` client message and `models_available`/`model_changed`
 * agent events, for a model picker on structured sessions.
 * v7 added the `effort` client message and `effort_changed` agent event, plus
 * `ModelInfo.resolvedModel`/`supportsEffort`/`supportedEffortLevels`, for an
 * effort-level picker alongside the model picker.
 */
export const PROTOCOL_VERSION = 7;

/**
 * WebSocket close codes the server uses for conditions the client must not
 * just retry through. Shared here (rather than kept private to the server)
 * so `TerminalConnection`'s `onclose` can tell "the server will say this
 * again forever" (a version skew after a redeploy) apart from an ordinary
 * transient drop, which *is* worth retrying — without duplicating the numbers
 * on both sides where they could quietly drift apart.
 */
export const WsCloseCode = {
  PROTOCOL_MISMATCH: 4001,
  UNAUTHORIZED: 4003,
  FLOOD: 4008,
  BACKPRESSURE: 4009,
} as const;

/** Hard caps, enforced on the server before any frame is acted on. */
export const LIMITS = {
  /** Max bytes of a single raw WebSocket message. */
  maxMessageBytes: 256 * 1024,
  /** Max characters of a single `input` payload. */
  maxInputChars: 128 * 1024,
  minCols: 2,
  maxCols: 1000,
  minRows: 2,
  maxRows: 500,
} as const;

const SessionId = z.string().min(1).max(64);

/** Signals a browser is permitted to deliver. Deliberately not the full set. */
export const AllowedSignal = z.enum(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGKILL']);
export type AllowedSignal = z.infer<typeof AllowedSignal>;

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export const AttachMessage = z.object({
  type: z.literal('attach'),
  sessionId: SessionId,
  /**
   * Last sequence number the client already rendered. The server replays
   * everything strictly after it. Omit (or use 0) for a fresh attach.
   */
  afterSeq: z.number().int().nonnegative().optional(),
  /**
   * Epoch the `afterSeq` belongs to, as reported by a previous `attached`.
   * A mismatch means the stream restarted underneath the client (the server
   * was restarted and re-adopted the session), so the server resynchronises
   * from scratch instead of splicing onto a screen from the old stream.
   */
  epoch: z.string().max(64).optional(),
  cols: z.number().int().min(LIMITS.minCols).max(LIMITS.maxCols).optional(),
  rows: z.number().int().min(LIMITS.minRows).max(LIMITS.maxRows).optional(),
  /**
   * True for a background "just watching" attach (e.g. a fleet-overview
   * card) that should still receive replay and live frames but must not
   * count as a real viewer — omitting this, or `false`, keeps today's
   * behaviour. Without it, every open fleet card would inflate
   * `SessionInfo.attachedClients` and the "N viewer(s)" count an adopted
   * pane's own owner sees, for a client that never actually looked at the
   * session in any way a human would call "attached".
   */
  peek: z.boolean().optional(),
});

export const DetachMessage = z.object({
  type: z.literal('detach'),
  sessionId: SessionId,
});

export const InputMessage = z.object({
  type: z.literal('input'),
  sessionId: SessionId,
  data: z.string().max(LIMITS.maxInputChars),
});

export const ResizeMessage = z.object({
  type: z.literal('resize'),
  sessionId: SessionId,
  cols: z.number().int().min(LIMITS.minCols).max(LIMITS.maxCols),
  rows: z.number().int().min(LIMITS.minRows).max(LIMITS.maxRows),
});

export const SignalMessage = z.object({
  type: z.literal('signal'),
  sessionId: SessionId,
  signal: AllowedSignal,
});

export const PingMessage = z.object({
  type: z.literal('ping'),
});

// ---- Structured sessions --------------------------------------------------

/**
 * Send a user turn to a structured session.
 *
 * Distinct from `input`: `input` is raw bytes for a PTY, whereas this is a
 * complete conversational turn. A structured session has no keyboard.
 */
export const PromptMessage = z.object({
  type: z.literal('prompt'),
  sessionId: SessionId,
  text: z.string().min(1).max(LIMITS.maxInputChars),
});

/** Answer a pending `permission_request`. */
export const PermissionMessage = z.object({
  type: z.literal('permission'),
  sessionId: SessionId,
  requestId: z.string().min(1).max(128),
  decision: PermissionDecision,
  /** Shown to the agent when denying, so it can adjust rather than guess. */
  message: z.string().max(2000).optional(),
  /**
   * The chosen answer, for an `AskUserQuestion` call. Required in practice for
   * that tool's `allow` to mean anything — a bare allow with no answer leaves
   * the SDK executing the tool with nothing to report back, which reads to the
   * agent as a failed call rather than a real answer.
   */
  answer: AskUserQuestionAnswer.optional(),
});

/** Stop the current turn at the next safe point. */
export const InterruptMessage = z.object({
  type: z.literal('interrupt'),
  sessionId: SessionId,
});

/**
 * Switch the model a structured session uses, effective on its next prompt —
 * see `ModelChangedEvent`'s doc comment for why "effective" is not "now".
 */
export const SetModelMessage = z.object({
  type: z.literal('model'),
  sessionId: SessionId,
  model: z.string().min(1).max(200),
});

/**
 * Switch the effort level a structured session's model uses, effective on its
 * next prompt — same caveat as `SetModelMessage`. `null` resets to the
 * model's own default rather than pinning a specific level.
 */
export const SetEffortMessage = z.object({
  type: z.literal('effort'),
  sessionId: SessionId,
  effort: EffortLevel.nullable(),
});

export const ClientMessage = z.discriminatedUnion('type', [
  AttachMessage,
  DetachMessage,
  InputMessage,
  ResizeMessage,
  SignalMessage,
  PingMessage,
  PromptMessage,
  PermissionMessage,
  InterruptMessage,
  SetModelMessage,
  SetEffortMessage,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

/**
 * Buffered output delivered in response to `attach`.
 *
 * `truncated` means the requested `afterSeq` had already been evicted from the
 * ring buffer, so `data` is not contiguous with what the client last rendered.
 * The client MUST clear its terminal before writing `data` in that case,
 * otherwise a partial ANSI stream corrupts the screen.
 */
export const ReplayPayload = z.object({
  data: z.string(),
  fromSeq: z.number().int().nonnegative(),
  toSeq: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type ReplayPayload = z.infer<typeof ReplayPayload>;

export const AttachedMessage = z.object({
  type: z.literal('attached'),
  session: SessionInfo,
  /** Terminal transport replay. Empty for structured sessions. */
  replay: ReplayPayload,
  /** Structured transport replay. Absent for terminal sessions. */
  agentReplay: AgentReplayPayload.optional(),
  /** Approvals still awaiting an answer, so a reconnecting phone sees them. */
  pendingPermissions: z.array(AgentEvent).optional(),
});

/** One normalized agent event, live. */
export const AgentEventMessage = z.object({
  type: z.literal('agent_event'),
  sessionId: SessionId,
  seq: z.number().int().positive(),
  event: AgentEvent,
});

export const OutputMessage = z.object({
  type: z.literal('output'),
  sessionId: SessionId,
  seq: z.number().int().nonnegative(),
  data: z.string(),
});

export const StatusMessage = z.object({
  type: z.literal('status'),
  sessionId: SessionId,
  status: SessionStatus,
  session: SessionInfo.optional(),
});

export const ExitMessage = z.object({
  type: z.literal('exit'),
  sessionId: SessionId,
  exitCode: z.number().int().nullable(),
  exitSignal: z.number().int().nullable(),
});

export const ErrorCode = z.enum([
  'bad_message',
  'unauthorized',
  'not_found',
  /** Known to the database, but its process belonged to a previous server. */
  'session_ended',
  'not_attached',
  'session_not_running',
  'rate_limited',
  'too_large',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorMessage = z.object({
  type: z.literal('error'),
  code: ErrorCode,
  message: z.string(),
  sessionId: SessionId.optional(),
});

/** Optional, advisory-only terminal state hints. Never used to auto-approve. */
export const TerminalHintKind = z.enum([
  'working',
  'waiting_for_input',
  'possible_approval_prompt',
  'idle',
]);
export type TerminalHintKind = z.infer<typeof TerminalHintKind>;

export const HintMessage = z.object({
  type: z.literal('hint'),
  sessionId: SessionId,
  hints: z.array(TerminalHintKind),
});

export const PongMessage = z.object({
  type: z.literal('pong'),
});

export const ServerMessage = z.discriminatedUnion('type', [
  AttachedMessage,
  OutputMessage,
  AgentEventMessage,
  StatusMessage,
  ExitMessage,
  ErrorMessage,
  HintMessage,
  PongMessage,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** Parse an untrusted client frame. Returns null instead of throwing. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  const result = ClientMessage.safeParse(raw);
  return result.success ? result.data : null;
}
