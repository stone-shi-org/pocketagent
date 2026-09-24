import { z } from 'zod';
import { LIMITS } from './limits.js';

/**
 * PA-96: Gemini Live as a per-agent live-stream provider for Pocket Agent
 * chats.
 *
 * While live mode is on in a chat whose agent is set to `gemini-live`, Gemini
 * Live *is* that chat's model: it hears the user directly, speaks its own
 * replies, and calls the agent's existing planner tools through a server-side
 * bridge. None of the PA-84/85/89 talk-back machinery (`<speak>` summaries,
 * held untagged text, the TTS drain budget, the utterance harness, live-stt)
 * is involved on that path.
 *
 * The browser talks to Google directly over a WebSocket authenticated by a
 * short-lived *ephemeral token* this server mints. The API key never leaves
 * the server; the token is single-use, must be spent within a minute, dies
 * within 30, and is constraint-locked to the model, modality, system
 * instruction and tool declarations the server chose — so a token lifted out
 * of the page cannot be repurposed into an unconstrained session on the
 * operator's bill. Verified against the real service while building this: a
 * client `setup` naming a different model or system instruction is silently
 * overridden by the token's.
 *
 * No WebSocket frame changes here, so no `PROTOCOL_VERSION` bump: everything
 * below is plain HTTP.
 */

/**
 * Which live-stream implementation a Pocket Agent uses. `pipeline` is the
 * existing browser VAD → live-stt → planner LLM → live-stt TTS path and is
 * the default for every agent, including every agent that existed before
 * this field did.
 */
export const PlannerLiveProvider = z.enum(['pipeline', 'gemini-live']);
export type PlannerLiveProvider = z.infer<typeof PlannerLiveProvider>;

/**
 * A default rather than a hardcoded value: Live model names move fast, and
 * which one supports async function calling well changes between releases.
 * `gemini-3.8-live` is the one this feature was built and verified against.
 */
export const DEFAULT_GEMINI_LIVE_MODEL = 'gemini-3.8-live';

/**
 * Gemini bills audio tokens for the whole time the socket is open — its own
 * VAD still ingests silence — so an idle open mic costs money in a way the
 * live-stt pipeline never did. This many minutes without speech in either
 * direction turns live mode off; `0` disables the auto-off.
 */
export const DEFAULT_GEMINI_LIVE_IDLE_MINUTES = 5;

/**
 * `GET /api/planner/gemini-live`. The key itself is never returned by any
 * route, in plaintext or ciphertext — there is no reveal endpoint, the same
 * posture a custom Claude provider's key and a Telegram bot token have.
 */
export const GeminiLiveSettingsDto = z.object({
  /** `POCKETAGENT_SETTINGS_ENC_KEY` is set, so a key can be stored at all. */
  encryptionAvailable: z.boolean(),
  hasApiKey: z.boolean(),
  /**
   * A key is stored but cannot be decrypted with the configured encryption
   * key (rotated, or a different machine's database). Listed rather than
   * hidden, the same way an undecryptable provider is greyed out rather than
   * dropped, so a rotated key reads as "re-enter it" instead of "the feature
   * vanished".
   */
  keyUnreadable: z.boolean(),
  /** A usable key is stored and decrypts — the token route will work. */
  available: z.boolean(),
  /** Without the `models/` prefix, e.g. `gemini-3.8-live`. */
  model: z.string(),
  /** A prebuilt voice name, or `null` for the model's own default. */
  voice: z.string().nullable(),
  /** See `DEFAULT_GEMINI_LIVE_IDLE_MINUTES`. */
  idleMinutes: z.number().int().min(0).max(120),
});
export type GeminiLiveSettingsDto = z.infer<typeof GeminiLiveSettingsDto>;

/**
 * `PATCH /api/planner/gemini-live`: only what is sent is touched. `apiKey`
 * omitted **or blank keeps the stored key**, because there is no reveal route
 * and the editor's field therefore always starts empty — a save that read
 * blank as "clear" would silently break the feature. Removing the key is its
 * own explicit act (`clearApiKey`).
 */
export const UpdateGeminiLiveSettingsRequest = z.object({
  apiKey: z.string().max(512).optional(),
  clearApiKey: z.boolean().optional(),
  model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^(models\/)?[a-zA-Z0-9._-]+$/, 'Model must be a Gemini model id, e.g. gemini-3.8-live.')
    .optional(),
  voice: z
    .string()
    .trim()
    .max(64)
    .regex(/^[a-zA-Z0-9_-]*$/, 'Voice must be a prebuilt voice name, e.g. Puck.')
    .nullable()
    .optional(),
  idleMinutes: z.number().int().min(0).max(120).optional(),
});
export type UpdateGeminiLiveSettingsRequest = z.infer<typeof UpdateGeminiLiveSettingsRequest>;

/**
 * `POST /api/planner/chats/:id/live/token`.
 *
 * `resumeHandle` continues an existing Gemini session (after a `goAway` or a
 * dropped socket). It has to travel through the server rather than being put
 * in the browser's own `setup` message, and that was found empirically rather
 * than read anywhere: under a constrained token, `sessionResumption` is one
 * of the locked fields, so a handle supplied client-side is silently ignored
 * and the session restarts with no memory. It is also why every reconnect
 * mints a fresh token — resuming consumes a use, and a token is single-use.
 */
export const GeminiLiveTokenRequest = z.object({
  resumeHandle: z.string().min(1).max(512).optional(),
});
export type GeminiLiveTokenRequest = z.infer<typeof GeminiLiveTokenRequest>;

/** One turn of prior conversation, replayed to Gemini as initial context. */
export const GeminiLiveSeedTurn = z.object({
  role: z.enum(['user', 'model']),
  text: z.string(),
});
export type GeminiLiveSeedTurn = z.infer<typeof GeminiLiveSeedTurn>;

export const GeminiLiveTokenResponse = z.object({
  /** `auth_tokens/…` — passed as `access_token` on the WebSocket URL. */
  token: z.string(),
  /** The constrained endpoint, token not included. */
  wsUrl: z.string(),
  /** With the `models/` prefix, exactly as the `setup` message must name it. */
  model: z.string(),
  /** When the token stops working for messages (epoch ms). */
  expiresAt: z.number().int(),
  /** The token must open its session before this (epoch ms). */
  newSessionExpiresAt: z.number().int(),
  /**
   * The chat's rolling-window history, to send as `clientContent` right after
   * `setupComplete`. Empty on a resume, because the resumed session already
   * holds it — replaying it again would make the model see the conversation
   * twice.
   */
  seedTurns: z.array(GeminiLiveSeedTurn),
  resumed: z.boolean(),
  idleMinutes: z.number().int(),
});
export type GeminiLiveTokenResponse = z.infer<typeof GeminiLiveTokenResponse>;

/** One Gemini `functionCall`, forwarded verbatim by the browser. */
export const GeminiLiveToolCall = z.object({
  /** Gemini's own call id; becomes the persisted `tool_use.id`. */
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  args: z.record(z.unknown()).default({}),
});
export type GeminiLiveToolCall = z.infer<typeof GeminiLiveToolCall>;

/**
 * `POST /api/planner/chats/:id/live/tool-calls`. The browser can never claim
 * an approval: this request carries calls only, and whether each one runs is
 * decided server-side by the same gate `processToolCalls` uses.
 */
export const GeminiLiveToolCallsRequest = z.object({
  calls: z.array(GeminiLiveToolCall).min(1).max(32),
});
export type GeminiLiveToolCallsRequest = z.infer<typeof GeminiLiveToolCallsRequest>;

/**
 * - `completed` — the tool ran; `output` is its result.
 * - `refused` — unknown, disabled (globally or for this agent) or denied by a
 *   remembered decision; `output` says which, in the same words the
 *   transcript uses.
 * - `awaiting_approval` — parked on the on-screen approval card. `output` is
 *   the holding message Gemini is answered with at once, so no synchronous
 *   tool response is held open across Gemini's ~10-minute socket; the real
 *   result follows as ordinary conversation once a human decides.
 */
export const GeminiLiveToolCallStatus = z.enum(['completed', 'refused', 'awaiting_approval']);
export type GeminiLiveToolCallStatus = z.infer<typeof GeminiLiveToolCallStatus>;

export const GeminiLiveToolCallResult = z.object({
  /** Gemini's id, for the `toolResponse` the browser sends back. */
  callId: z.string(),
  /** The persisted `tool_use.id` — how the browser recognises this call's
      `tool_result` arriving later, after an approval. */
  toolUseId: z.string(),
  name: z.string(),
  status: GeminiLiveToolCallStatus,
  output: z.string(),
  approvalId: z.string().nullable(),
});
export type GeminiLiveToolCallResult = z.infer<typeof GeminiLiveToolCallResult>;

export const GeminiLiveToolCallsResponse = z.object({
  results: z.array(GeminiLiveToolCallResult),
});
export type GeminiLiveToolCallsResponse = z.infer<typeof GeminiLiveToolCallsResponse>;

/**
 * `POST /api/planner/chats/:id/live/transcript`: what Gemini heard and said,
 * persisted as the ordinary `user_prompt` / `text` / `turn_complete` events a
 * typed turn produces, so a reopened chat replays through `applyEvents` and
 * turning live mode off hands the very same history to the planner LLM.
 *
 * Deliberately a narrow shape rather than an `AgentEvent[]`: the browser may
 * report what was *said*, never a tool call, a tool result or an approval —
 * those are persisted by the tool bridge, server-side, from the gate's own
 * decisions.
 */
export const GeminiLiveTranscriptRequest = z
  .object({
    userText: z.string().max(LIMITS.maxInputChars).optional(),
    modelText: z.string().max(LIMITS.maxInputChars).optional(),
    /** Present when a Gemini turn finished; closes the turn in the transcript. */
    turnComplete: z
      .object({
        inputTokens: z.number().int().min(0).nullable(),
        outputTokens: z.number().int().min(0).nullable(),
        durationMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
        interrupted: z.boolean().optional(),
      })
      .optional(),
  })
  .refine((d) => !!d.userText?.trim() || !!d.modelText?.trim() || !!d.turnComplete, {
    message: 'Nothing to record.',
  });
export type GeminiLiveTranscriptRequest = z.infer<typeof GeminiLiveTranscriptRequest>;
