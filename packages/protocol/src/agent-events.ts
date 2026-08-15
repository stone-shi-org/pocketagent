import { z } from 'zod';
import { PromptImage } from './prompt-image.js';

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
 * One question and its choices, as the SDK's built-in `AskUserQuestion` tool
 * asks it. Mirrors that tool's own input schema (`sdk-tools.d.ts`) rather than
 * inventing a shape, since the answer has to be handed straight back as that
 * tool's `updatedInput` — see `AskUserQuestionAnswer` below.
 */
export const AskUserQuestionOption = z.object({
  label: z.string(),
  description: z.string(),
  preview: z.string().optional(),
});
export type AskUserQuestionOption = z.infer<typeof AskUserQuestionOption>;

export const AskUserQuestionItem = z.object({
  question: z.string(),
  header: z.string(),
  options: z.array(AskUserQuestionOption),
  multiSelect: z.boolean(),
});
export type AskUserQuestionItem = z.infer<typeof AskUserQuestionItem>;

/**
 * A human's answer to an `AskUserQuestion` call.
 *
 * `answers` is keyed by each question's own `question` text — the same
 * convention the SDK's `AskUserQuestionOutput` uses — with multi-select
 * values comma-joined. `response` is free text used instead of, or alongside,
 * picking an option ("Other").
 */
export const AskUserQuestionAnswer = z.object({
  answers: z.record(z.string()),
  response: z.string().max(4000).optional(),
});
export type AskUserQuestionAnswer = z.infer<typeof AskUserQuestionAnswer>;

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
  /**
   * Parsed `AskUserQuestion` input, when `toolName` is that tool and the
   * input actually matches its schema. Null for every other tool call, and
   * also null (rather than throwing) if the SDK ever changes that shape out
   * from under us — the UI falls back to a generic approval in that case
   * instead of crashing on an unrecognized payload.
   */
  questions: z.array(AskUserQuestionItem).nullable(),
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
  /** Present when the turn attached a screenshot — see `PromptImage`. */
  image: PromptImage.optional(),
});

/**
 * One slash command an agent currently supports, as the Claude Agent SDK's own
 * `SlashCommand` type shapes it (built-ins, `.claude/commands/`, skills,
 * plugin commands) — mirrored rather than invented so a picker can show
 * exactly what typing `/` at a real prompt would offer.
 */
export const SlashCommandInfo = z.object({
  name: z.string(),
  description: z.string(),
  /** e.g. "<file>". Empty string when the command takes no argument. */
  argumentHint: z.string(),
  /** Other names that resolve to this same command (e.g. `/cost` for `/usage`). */
  aliases: z.array(z.string()),
});
export type SlashCommandInfo = z.infer<typeof SlashCommandInfo>;

/**
 * The full set of commands usable right now. REPLACE semantics, not a merge —
 * mirrors the SDK's own `commands_changed` push, which resends the whole list
 * rather than a delta (skills can be discovered *and* retracted mid-session).
 */
export const CommandsAvailableEvent = z.object({
  kind: z.literal('commands_available'),
  commands: z.array(SlashCommandInfo),
});

/**
 * Output from a command that resolved locally, without a model turn (e.g.
 * Claude's `/usage`, `/voice`). There is no reliable `commandName` to attach —
 * the SDK's own `local_command_output` message does not carry one — so this
 * renders as its own transcript item rather than guessing which command it
 * came from.
 */
export const CommandOutputEvent = z.object({
  kind: z.literal('command_output'),
  id: z.string(),
  text: z.string(),
});

/**
 * How much thinking/reasoning a model applies.
 *
 * Deliberately a free-form non-empty string, not a fixed enum: five
 * structured backends now report effort levels, and their vocabularies do
 * not agree — Claude's Agent SDK uses `'low'|'medium'|'high'|'xhigh'|'max'`,
 * codex's app-server adds `'ultra'`, agy's `--effort` flag only recognizes
 * three of those, and pi adds `'off'`/`'minimal'` on top (confirmed live
 * against each installed CLI). A fixed union would reject a real value from
 * whichever backend defined it last; a per-model `ModelInfo.supportedEffortLevels`
 * (below) is what actually constrains the picker, not this type.
 */
export const EffortLevel = z.string().min(1);
export type EffortLevel = z.infer<typeof EffortLevel>;

/**
 * One model an agent can be switched to.
 *
 * Modeled on the Claude Agent SDK's own `ModelInfo` — mirrored rather than
 * invented so a picker offers exactly what a backend's own catalog reports,
 * the same discipline as `SlashCommandInfo` above — and reused verbatim by
 * every other structured backend that has since gained a model-picker
 * feature: `value` is whatever *that* backend's own switch call expects back
 * (codex's `id`, agy's model id, pi's composite `provider/id`), not a shape
 * shared across backends.
 */
export const ModelInfo = z.object({
  value: z.string(),
  /**
   * The canonical wire model id `value` resolves to (e.g. `'sonnet'` →
   * `'claude-sonnet-5'`). Claude's `session_started.model` reports the
   * *resolved* id, not the alias, so matching it back to a row in this list —
   * to show that row's curated `displayName` instead of the raw wire id — has
   * to check this field too, not just `value`. Other backends leave it unset.
   */
  resolvedModel: z.string().optional(),
  displayName: z.string(),
  description: z.string(),
  /** Whether this model accepts an explicit effort level at all. */
  supportsEffort: z.boolean(),
  /** The effort levels this specific model accepts, when `supportsEffort` is true. */
  supportedEffortLevels: z.array(EffortLevel),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

/**
 * The full set of models usable right now. REPLACE semantics, matching
 * `CommandsAvailableEvent` — fetched once at startup today, but nothing rules
 * out a future push if a backend ever reports a mid-session change.
 */
export const ModelsAvailableEvent = z.object({
  kind: z.literal('models_available'),
  models: z.array(ModelInfo),
});
export type ModelsAvailableEvent = z.infer<typeof ModelsAvailableEvent>;

/**
 * The active model changed because the user switched it from the composer.
 * Effective on the *next* prompt: the SDK's `setModel` only changes what a
 * subsequent turn requests, never one already streaming, so this must not be
 * read as "the current turn is now running on this model."
 */
export const ModelChangedEvent = z.object({
  kind: z.literal('model_changed'),
  model: z.string(),
});
export type ModelChangedEvent = z.infer<typeof ModelChangedEvent>;

/**
 * The effort level changed because the user picked one from the composer.
 * `null` means "cleared back to the model's own default" — same effective-on-
 * next-prompt caveat as `ModelChangedEvent`, since it rides the same
 * mid-session settings call.
 */
export const EffortChangedEvent = z.object({
  kind: z.literal('effort_changed'),
  effort: EffortLevel.nullable(),
});
export type EffortChangedEvent = z.infer<typeof EffortChangedEvent>;

/**
 * The agent's own context was reset — most commonly `/clear`, but the SDK's
 * own doc comment on `SDKConversationResetMessage` also lists plan-mode exit
 * and other fresh-session flows as triggers. `newConversationId` is the id a
 * resume must use going forward: the SDK starts a new conversation at the
 * same moment this fires, so `SessionStartedEvent.agentSessionId` from the
 * original start is no longer the right id to resume against.
 */
export const ConversationResetEvent = z.object({
  kind: z.literal('conversation_reset'),
  newConversationId: z.string(),
});
export type ConversationResetEvent = z.infer<typeof ConversationResetEvent>;

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
export type CommandsAvailableEvent = z.infer<typeof CommandsAvailableEvent>;
export type CommandOutputEvent = z.infer<typeof CommandOutputEvent>;

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
  CommandsAvailableEvent,
  CommandOutputEvent,
  ModelsAvailableEvent,
  ModelChangedEvent,
  EffortChangedEvent,
  ConversationResetEvent,
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
