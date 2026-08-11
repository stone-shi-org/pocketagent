import { z } from 'zod';

/**
 * Normalized agent events.
 *
 * The Claude Agent SDK emits ~40 message types, most of which are internal
 * bookkeeping. Rather than leaking that surface to the browser — and coupling
 * the UI to a specific agent's schema — the server normalizes everything into
 * the small union below. A future Codex or Gemini structured adapter produces
 * the same events, so the UI is written once.
 */

export const ToolStatus = z.enum(['pending', 'running', 'ok', 'error', 'denied']);
export type ToolStatus = z.infer<typeof ToolStatus>;

/** Session-level facts learned when the agent starts. */
export const SessionStartedEvent = z.object({
  kind: z.literal('session_started'),
  /** The agent's own conversation id, used to resume after a restart. */
  agentSessionId: z.string().nullable(),
  model: z.string().nullable(),
  cwd: z.string(),
  tools: z.array(z.string()),
  permissionMode: z.string().nullable(),
});

/** A completed block of assistant prose. Rendered as markdown. */
export const TextEvent = z.object({
  kind: z.literal('text'),
  id: z.string(),
  text: z.string(),
});

/** Incremental text for the block with the same id, when partials are on. */
export const TextDeltaEvent = z.object({
  kind: z.literal('text_delta'),
  id: z.string(),
  text: z.string(),
});

/** Reasoning. Collapsed by default in the UI — never shown inline as prose. */
export const ThinkingEvent = z.object({
  kind: z.literal('thinking'),
  id: z.string(),
  text: z.string(),
});

export const ToolUseEvent = z.object({
  kind: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  /** Raw tool input. The UI special-cases a few known shapes (Edit, Write…). */
  input: z.record(z.unknown()),
  /** Best-effort one-line summary, e.g. `Read hello.txt`. */
  summary: z.string(),
  /** Absolute path this call touches, when there is one. */
  filePath: z.string().nullable(),
});

export const ToolResultEvent = z.object({
  kind: z.literal('tool_result'),
  id: z.string(),
  toolUseId: z.string(),
  /** Truncated for transport; the UI shows a "truncated" marker. */
  content: z.string(),
  truncated: z.boolean(),
  isError: z.boolean(),
});

/**
 * The agent wants to do something that needs a human decision.
 *
 * `title` is the sentence the SDK itself renders (e.g. "Claude wants to edit
 * app.ts"), so the phone shows the same wording the terminal would.
 */
export const PermissionRequestEvent = z.object({
  kind: z.literal('permission_request'),
  id: z.string(),
  toolName: z.string(),
  input: z.record(z.unknown()),
  title: z.string(),
  displayName: z.string().nullable(),
  filePath: z.string().nullable(),
  reason: z.string().nullable(),
  /** True when the SDK offered rules that would stop it asking again. */
  canAllowForSession: z.boolean(),
});

export const PermissionDecision = z.enum(['allow', 'allow_session', 'deny']);
export type PermissionDecision = z.infer<typeof PermissionDecision>;

export const PermissionResolvedEvent = z.object({
  kind: z.literal('permission_resolved'),
  id: z.string(),
  decision: PermissionDecision,
  message: z.string().nullable(),
});

/** End of an agent turn: the session is idle and awaiting the next prompt. */
export const TurnCompleteEvent = z.object({
  kind: z.literal('turn_complete'),
  stopReason: z.string().nullable(),
  isError: z.boolean(),
  numTurns: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  costUsd: z.number().nullable(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
});

/** Anything worth surfacing that is not part of the conversation proper. */
export const NoticeEvent = z.object({
  kind: z.literal('notice'),
  level: z.enum(['info', 'warn', 'error']),
  text: z.string(),
});

/** Echo of what the user sent, so replay reconstructs the whole transcript. */
export const UserPromptEvent = z.object({
  kind: z.literal('user_prompt'),
  id: z.string(),
  text: z.string(),
});


export type SessionStartedEvent = z.infer<typeof SessionStartedEvent>;
export type TextEvent = z.infer<typeof TextEvent>;
export type TextDeltaEvent = z.infer<typeof TextDeltaEvent>;
export type ThinkingEvent = z.infer<typeof ThinkingEvent>;
export type ToolUseEvent = z.infer<typeof ToolUseEvent>;
export type ToolResultEvent = z.infer<typeof ToolResultEvent>;
export type PermissionRequestEvent = z.infer<typeof PermissionRequestEvent>;
export type PermissionResolvedEvent = z.infer<typeof PermissionResolvedEvent>;
export type TurnCompleteEvent = z.infer<typeof TurnCompleteEvent>;
export type NoticeEvent = z.infer<typeof NoticeEvent>;
export type UserPromptEvent = z.infer<typeof UserPromptEvent>;

export const AgentEvent = z.discriminatedUnion('kind', [
  SessionStartedEvent,
  TextEvent,
  TextDeltaEvent,
  ThinkingEvent,
  ToolUseEvent,
  ToolResultEvent,
  PermissionRequestEvent,
  PermissionResolvedEvent,
  TurnCompleteEvent,
  NoticeEvent,
  UserPromptEvent,
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

/** An event plus its position in the session's event stream. */
export const SequencedAgentEvent = z.object({
  seq: z.number().int().positive(),
  event: AgentEvent,
});
export type SequencedAgentEvent = z.infer<typeof SequencedAgentEvent>;

/** Replay payload for structured sessions; mirrors the terminal ReplayPayload. */
export const AgentReplayPayload = z.object({
  events: z.array(SequencedAgentEvent),
  fromSeq: z.number().int().nonnegative(),
  toSeq: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type AgentReplayPayload = z.infer<typeof AgentReplayPayload>;

/** How a session is driven: a raw terminal, or a structured event stream. */
export const SessionTransport = z.enum(['terminal', 'structured']);
export type SessionTransport = z.infer<typeof SessionTransport>;
