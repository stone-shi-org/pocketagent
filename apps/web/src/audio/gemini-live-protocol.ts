import type {
  GeminiLiveSeedTurn,
  GeminiLiveToolCall,
  GeminiLiveToolCallResult,
  GeminiLiveTranscriptRequest,
} from '@pocketagent/protocol';

/**
 * PA-96: the Gemini Live wire format, as pure functions — kept apart from
 * `gemini-live.ts` (which owns the WebSocket, the microphone and the speaker,
 * none of which exist under vitest's `node` environment) so the mapping
 * between Gemini's messages and this app's transcript has real unit tests.
 *
 * Every shape here was checked against the live service while building this,
 * on `gemini-3.8-live` — `realtimeInput.audio`/`.text` rather than the older
 * `mediaChunks`, `usageMetadata` at the top level of a message, and a
 * `turnComplete` that arrives immediately after a `toolCall`, before the tool
 * has been answered.
 */

/** Mic audio must be exactly this — Gemini's documented input format. */
export const GEMINI_INPUT_SAMPLE_RATE = 16000;
/** What Gemini sends back, unless a message says otherwise. */
export const GEMINI_OUTPUT_SAMPLE_RATE = 24000;

export type GeminiServerEvent =
  | { type: 'setupComplete' }
  | { type: 'audio'; data: string; sampleRateHz: number }
  | { type: 'inputTranscript'; text: string }
  | { type: 'outputTranscript'; text: string }
  | { type: 'interrupted' }
  | { type: 'turnComplete' }
  | { type: 'toolCall'; calls: GeminiLiveToolCall[] }
  | { type: 'toolCallCancellation'; ids: string[] }
  | { type: 'goAway'; timeLeftMs: number | null }
  | { type: 'resumptionHandle'; handle: string }
  | { type: 'usage'; inputTokens: number | null; outputTokens: number | null }
  | { type: 'error'; message: string };

// ---- client → server --------------------------------------------------------

/**
 * Only the model: under a constrained token every setup field is locked to
 * what the server minted, and anything else sent here is overridden anyway.
 * Sending less is simply more honest about who decides.
 */
export function setupMessage(model: string): unknown {
  return { setup: { model } };
}

export function audioMessage(base64Pcm16: string): unknown {
  return { realtimeInput: { audio: { data: base64Pcm16, mimeType: `audio/pcm;rate=${GEMINI_INPUT_SAMPLE_RATE}` } } };
}

/** A typed message while live mode is on — Gemini, not the planner LLM,
    answers it, so only one model drives the chat at a time. */
export function textMessage(text: string): unknown {
  return { realtimeInput: { text } };
}

/** The chat's history, replayed once after `setupComplete`. `turnComplete:
    false` so the model takes it as context rather than answering it. */
export function seedMessage(turns: readonly GeminiLiveSeedTurn[]): unknown | null {
  if (turns.length === 0) return null;
  return {
    clientContent: {
      turns: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
      turnComplete: false,
    },
  };
}

/**
 * The bridge's verdicts, as Gemini's `toolResponse`. A parked call is answered
 * too — with the holding message — so no synchronous response is left open
 * across Gemini's ~10-minute socket while a human decides.
 */
export function toolResponseMessage(results: readonly GeminiLiveToolCallResult[]): unknown {
  return {
    toolResponse: {
      functionResponses: results.map((r) => ({
        id: r.callId,
        name: r.name,
        response:
          r.status === 'completed'
            ? { output: r.output }
            : r.status === 'refused'
              ? { error: r.output }
              : { status: 'awaiting_user_approval', message: r.output },
      })),
    },
  };
}

/**
 * The real outcome of a call that was parked on approval, sent as ordinary
 * conversation once a human has decided — the original tool call was answered
 * long ago, so this is the only channel left, and `turnComplete: true` makes
 * Gemini say what happened.
 */
export function approvalOutcomeMessage(toolName: string, content: string, isError: boolean): unknown {
  const text = isError
    ? `[Update on the ${toolName} action that was waiting for approval: it did not run. ${content}]`
    : `[Update on the ${toolName} action that was waiting for approval: the user approved it and it ran. Result: ${content}]`;
  return { clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } };
}

// ---- server → client --------------------------------------------------------

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `audio/pcm;rate=24000` → 24000; anything unparsable → the documented default. */
export function sampleRateFromMime(mime: unknown): number {
  if (typeof mime !== 'string') return GEMINI_OUTPUT_SAMPLE_RATE;
  const match = /rate=(\d+)/.exec(mime);
  const rate = match ? Number(match[1]) : NaN;
  return Number.isInteger(rate) && rate >= 8000 && rate <= 96000 ? rate : GEMINI_OUTPUT_SAMPLE_RATE;
}

/** Protobuf JSON duration (`"10s"`, `"1.5s"`) → milliseconds. */
export function parseDurationMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  return match ? Math.round(Number(match[1]) * 1000) : null;
}

/**
 * One server message → the events in it, in the order they should be applied.
 * A single message can carry several (audio plus a transcription fragment plus
 * `turnComplete`), and unknown fields are ignored rather than thrown on: the
 * service sends empty `{}` keep-alives, and new message kinds must not break a
 * session that does not use them.
 */
export function parseServerMessage(raw: unknown): GeminiServerEvent[] {
  if (!raw || typeof raw !== 'object') return [];
  const msg = raw as Record<string, unknown>;
  const events: GeminiServerEvent[] = [];

  if (msg.setupComplete !== undefined) events.push({ type: 'setupComplete' });

  const usage = msg.usageMetadata as Record<string, unknown> | undefined;
  if (usage && typeof usage === 'object') {
    events.push({
      type: 'usage',
      inputTokens: num(usage.promptTokenCount),
      // Thinking tokens are billed output; the footer's "out" means "what the
      // model produced", so they count.
      outputTokens:
        num(usage.responseTokenCount) === null && num(usage.thoughtsTokenCount) === null
          ? null
          : (num(usage.responseTokenCount) ?? 0) + (num(usage.thoughtsTokenCount) ?? 0),
    });
  }

  const content = msg.serverContent as Record<string, unknown> | undefined;
  if (content && typeof content === 'object') {
    const modelTurn = content.modelTurn as { parts?: unknown } | undefined;
    if (modelTurn && Array.isArray(modelTurn.parts)) {
      for (const part of modelTurn.parts as Array<Record<string, unknown>>) {
        const inline = part?.inlineData as { data?: unknown; mimeType?: unknown } | undefined;
        // Text parts on a native-audio model are its thinking summary, not
        // what it said — the output transcription is what it said.
        if (inline && typeof inline.data === 'string' && inline.data.length > 0) {
          events.push({ type: 'audio', data: inline.data, sampleRateHz: sampleRateFromMime(inline.mimeType) });
        }
      }
    }
    const input = content.inputTranscription as { text?: unknown } | undefined;
    if (input && typeof input.text === 'string' && input.text.length > 0) {
      events.push({ type: 'inputTranscript', text: input.text });
    }
    const output = content.outputTranscription as { text?: unknown } | undefined;
    if (output && typeof output.text === 'string' && output.text.length > 0) {
      events.push({ type: 'outputTranscript', text: output.text });
    }
    if (content.interrupted === true) events.push({ type: 'interrupted' });
    if (content.turnComplete === true) events.push({ type: 'turnComplete' });
  }

  const toolCall = msg.toolCall as { functionCalls?: unknown } | undefined;
  if (toolCall && Array.isArray(toolCall.functionCalls)) {
    const calls: GeminiLiveToolCall[] = [];
    for (const fc of toolCall.functionCalls as Array<Record<string, unknown>>) {
      if (typeof fc?.id !== 'string' || typeof fc.name !== 'string') continue;
      const args = fc.args && typeof fc.args === 'object' && !Array.isArray(fc.args) ? (fc.args as Record<string, unknown>) : {};
      calls.push({ id: fc.id, name: fc.name, args });
    }
    if (calls.length > 0) events.push({ type: 'toolCall', calls });
  }

  const cancellation = msg.toolCallCancellation as { ids?: unknown } | undefined;
  if (cancellation && Array.isArray(cancellation.ids)) {
    events.push({ type: 'toolCallCancellation', ids: cancellation.ids.filter((id): id is string => typeof id === 'string') });
  }

  const goAway = msg.goAway as { timeLeft?: unknown } | undefined;
  if (goAway && typeof goAway === 'object') events.push({ type: 'goAway', timeLeftMs: parseDurationMs(goAway.timeLeft) });

  const resumption = msg.sessionResumptionUpdate as { newHandle?: unknown; resumable?: unknown } | undefined;
  if (resumption && typeof resumption.newHandle === 'string' && resumption.newHandle && resumption.resumable !== false) {
    events.push({ type: 'resumptionHandle', handle: resumption.newHandle });
  }

  const error = msg.error as { message?: unknown } | undefined;
  if (error && typeof error === 'object') {
    events.push({ type: 'error', message: typeof error.message === 'string' ? error.message : 'Gemini reported an error.' });
  }
  return events;
}

// ---- turns → transcript -------------------------------------------------------

/**
 * Folds Gemini's streamed transcription fragments into the reports
 * `POST .../live/transcript` persists, so the chat's JSONL ends up holding the
 * same `user_prompt` → (tool calls) → `text` → `turn_complete` shape a typed
 * turn produces.
 *
 * Two things about Gemini's framing drive the logic, both observed rather than
 * documented. A `turnComplete` arrives right after a `toolCall`, before the
 * tool is answered, and the model's actual reply comes in a *second*
 * generation once it is — so a generation that called a tool flushes its text
 * (to keep the order right around the tool events) but does not close the
 * turn, and its token usage keeps accumulating into the one footer the whole
 * exchange gets. And a user who barges in is heard while the old reply is
 * still being transcribed, so input text that arrived after the model started
 * speaking belongs to the *next* turn and is carried over rather than
 * attributed to this one.
 */
export class LiveTurnTracker {
  private userText = '';
  private modelText = '';
  /** Length of `userText` when the model started answering, if it has. */
  private userMark: number | null = null;
  private modelStartedAt: number | null = null;
  private inputTokens: number | null = null;
  private outputTokens: number | null = null;
  private toolCallThisGeneration = false;
  private interrupted = false;

  heard(text: string): void {
    this.userText += text;
  }

  /** A typed message sent while live — persisted exactly as if heard. */
  typed(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.userText = this.userText.trim() ? `${this.userText.trim()}\n${trimmed}` : trimmed;
  }

  said(text: string, now: number): void {
    this.markModelStart(now);
    this.modelText += text;
  }

  /** Audio can precede its transcription; either one starts the model's turn. */
  modelAudio(now: number): void {
    this.markModelStart(now);
  }

  usage(inputTokens: number | null, outputTokens: number | null): void {
    if (inputTokens !== null) this.inputTokens = (this.inputTokens ?? 0) + inputTokens;
    if (outputTokens !== null) this.outputTokens = (this.outputTokens ?? 0) + outputTokens;
  }

  markInterrupted(): void {
    this.interrupted = true;
  }

  /** Called before the tool bridge: what was said so far must be persisted
      *before* the tool events, or a reopened chat reads out of order. */
  flushForToolCall(now: number): GeminiLiveTranscriptRequest | null {
    this.markModelStart(now);
    this.toolCallThisGeneration = true;
    return this.takeText(false, now);
  }

  turnComplete(now: number): GeminiLiveTranscriptRequest | null {
    const closes = !this.toolCallThisGeneration;
    this.toolCallThisGeneration = false;
    return this.takeText(closes, now);
  }

  /** Persist what has been said so far without closing the turn — used just
      before a human resolves a parked approval, so the "it's waiting for
      you" line Gemini spoke lands *before* the tool result it preceded. */
  flushText(now: number): GeminiLiveTranscriptRequest | null {
    return this.takeText(false, now);
  }

  /** Whatever is still buffered when live mode ends, so nothing heard is lost. */
  drain(now: number): GeminiLiveTranscriptRequest | null {
    return this.takeText(this.modelStartedAt !== null || this.inputTokens !== null, now);
  }

  /** Text heard this turn so far — the strip's "you said" line. */
  pendingUserText(): string {
    return this.userText.trim();
  }

  pendingModelText(): string {
    return this.modelText.trim();
  }

  private markModelStart(now: number): void {
    if (this.userMark === null) this.userMark = this.userText.length;
    if (this.modelStartedAt === null) this.modelStartedAt = now;
  }

  private takeText(closeTurn: boolean, now: number): GeminiLiveTranscriptRequest | null {
    const mark = this.userMark ?? this.userText.length;
    const userText = this.userText.slice(0, mark).trim();
    const carried = this.userText.slice(mark);
    const modelText = this.modelText.trim();
    const report: GeminiLiveTranscriptRequest = {};
    if (userText) report.userText = userText;
    if (modelText) report.modelText = modelText;
    if (closeTurn) {
      report.turnComplete = {
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        durationMs: this.modelStartedAt === null ? 0 : Math.max(0, Math.round(now - this.modelStartedAt)),
        ...(this.interrupted ? { interrupted: true } : {}),
      };
      this.inputTokens = null;
      this.outputTokens = null;
      this.modelStartedAt = null;
      this.interrupted = false;
    }
    this.userText = carried;
    this.modelText = '';
    this.userMark = null;
    if (!report.userText && !report.modelText && !report.turnComplete) return null;
    return report;
  }
}
