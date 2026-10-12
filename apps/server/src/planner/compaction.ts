import { estimateInlineTokens, withPlannerAttachmentNote, type InlineCaps } from '../attachments/inline.js';
import type { AgentEvent, ContextCompactionEvent } from '@pocketagent/protocol';
import { IMAGE_TOKEN_ESTIMATE } from './context-budget.js';

/**
 * PA-121: context compaction for Pocket Agent chats — the pure half.
 *
 * When a chat's context nears the model's window, the older part of the
 * conversation is summarized by the model and later turns send that summary
 * in its place, keeping the most recent part verbatim. This follows pi's
 * design (`coding-agent/src/core/compaction/`), and three of its decisions
 * matter enough to keep:
 *
 * - **The transcript is never rewritten.** A compaction is one more event
 *   appended to the JSONL (`context_compaction`); `projectContext` is what
 *   turns "the transcript" into "what the model is shown". The UI still
 *   replays everything, and a bad summary costs a worse next turn, never lost
 *   history.
 * - **A cut never separates a tool call from its result.** Providers reject a
 *   `tool` message whose call is not in the request, so a cut lands only on a
 *   user prompt, an assistant text, or the first call of a batch — never on a
 *   result, and the results of a kept call are always kept with it.
 * - **A later summary updates the earlier one rather than starting over.**
 *   The previous summary is handed back with the new span, so what was
 *   learned before the first compaction survives the second.
 *
 * Everything here is a pure function over `AgentEvent[]`; the LLM call, the
 * persisting and the decision of *when* live in `PlannerChatService`.
 */

/** pi's `SUMMARIZATION_SYSTEM_PROMPT`. */
export const SUMMARIZATION_SYSTEM_PROMPT =
  'You are a context summarization assistant. Your task is to read a conversation between a user ' +
  'and an AI assistant, then produce a structured summary following the exact format specified. ' +
  'Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ' +
  'ONLY output the structured summary.';

const SUMMARY_FORMAT = `Use this exact format:

## Goal
What the user is trying to accomplish.

## Constraints & Preferences
- Requirements, preferences and decisions the user stated.

## Progress
### Done
- [x] Completed work, with its outcome.
### In Progress
- [ ] Work that was started and not finished.
### Blocked
- Anything waiting on something, and on what.

## Key Decisions
- **Decision**: why it was made.

## Next Steps
1. What should happen next.

## Critical Context
- Anything else needed to continue: names, ids, paths, commands, error messages, results.

Keep each section concise. Preserve exact file paths, ids, function names, commands and error messages.
Leave out a section that has nothing in it.`;

/** pi's `SUMMARIZATION_PROMPT`. */
export const SUMMARIZATION_PROMPT = `Summarize the conversation above so that it can be continued from this summary alone.

${SUMMARY_FORMAT}`;

/** pi's `UPDATE_SUMMARIZATION_PROMPT`: the second and later compactions. */
export const UPDATE_SUMMARIZATION_PROMPT = `The conversation above continues from an earlier summary, given in <previous-summary>. Write an updated summary that covers both.

- PRESERVE everything in the previous summary that is still relevant.
- ADD what happened in the new part of the conversation.
- UPDATE Progress: move items from In Progress to Done when they were finished.
- Remove something only if it is no longer relevant.

${SUMMARY_FORMAT}`;

/** Added when the cut lands inside a turn: the request being worked on is
    partly in the summary and partly in what is kept. */
const SPLIT_TURN_NOTE =
  '\n\nNote: the conversation is being continued from the middle of the last request above — it is ' +
  'still being worked on. Make sure ## Goal states that request and ## Progress says exactly what has ' +
  'been done toward it so far.';

/** How the summary is presented to the model in place of the history it
    replaces — pi's `compactionSummary` wording. A user message, not system,
    because it is conversation, and several providers accept only one system
    message at the front. */
export function summaryMessageText(summary: string): string {
  return (
    'The conversation history before this point was compacted into the following summary:\n\n' +
    `<summary>\n${summary}\n</summary>`
  );
}

/** Each tool result's share of the text the summarizer reads (pi's
    `TOOL_RESULT_MAX_CHARS`). The summary needs the gist of a result, and a
    40 KB command log would crowd out the conversation it belongs to. */
const SUMMARY_TOOL_RESULT_CHARS = 2_000;
const SUMMARY_TOOL_ARGS_CHARS = 500;

// ---- projection ------------------------------------------------------------

export interface ContextProjection {
  /** The latest compaction's summary, or `null` before the first one. */
  summary: string | null;
  /** The events to send after the summary (or all of them, with none). */
  events: AgentEvent[];
  latest: ContextCompactionEvent | null;
}

/**
 * What the model is shown from a transcript: the latest compaction's summary
 * plus the events from its `firstKeptEventId` on, compaction events removed.
 * A `firstKeptEventId` that no longer resolves (the transcript was edited by
 * hand, or a line was skipped as corrupt) keeps only what came after the
 * compaction — the summary still covers what came before.
 */
export function projectContext(events: readonly AgentEvent[]): ContextProjection {
  let latestIndex = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind === 'context_compaction') {
      latestIndex = i;
      break;
    }
  }
  if (latestIndex < 0) {
    return { summary: null, events: [...events], latest: null };
  }
  const latest = events[latestIndex] as ContextCompactionEvent;
  let from = latestIndex + 1;
  if (latest.firstKeptEventId) {
    const kept = events.findIndex((e) => eventId(e) === latest.firstKeptEventId);
    if (kept >= 0 && kept < latestIndex) from = kept;
  }
  return {
    summary: latest.summary,
    events: events.slice(from).filter((e) => e.kind !== 'context_compaction'),
    latest,
  };
}

function eventId(event: AgentEvent): string | null {
  return 'id' in event && typeof event.id === 'string' ? event.id : null;
}

// ---- choosing what to summarize ---------------------------------------------

/** Rough tokens one event contributes to a request, for choosing a cut
    point. Same chars ÷ 4 rule as `context-budget.ts`. */
export function estimateEventTokens(event: AgentEvent, inlineCaps?: InlineCaps): number {
  switch (event.kind) {
    case 'user_prompt':
      return (
        Math.ceil(withPlannerAttachmentNote(event.text, event.attachments).length / 4) +
        // PA-137: an inlined file is part of what the message sends, so it is
        // part of what compaction weighs.
        estimateInlineTokens(event.attachments, inlineCaps) +
        (event.image ? IMAGE_TOKEN_ESTIMATE : 0)
      );
    case 'text':
      return Math.ceil(event.text.length / 4);
    case 'tool_use':
      return Math.ceil((event.name.length + JSON.stringify(event.input).length) / 4) + 8;
    case 'tool_result':
      return Math.ceil(event.content.length / 4) + 8;
    default:
      return 0;
  }
}

/** Whether the kept part of the conversation may start at `events[i]`. */
function isValidCut(events: readonly AgentEvent[], i: number): boolean {
  const event = events[i]!;
  if (eventId(event) === null) return false;
  if (event.kind === 'user_prompt' || event.kind === 'text') return true;
  if (event.kind === 'tool_use') {
    // Only the first call of a batch, and only when no narration precedes it
    // (the cut then belongs on that narration, which is part of the same
    // assistant message).
    const prev = events[i - 1];
    return !prev || (prev.kind !== 'tool_use' && !(prev.kind === 'text' && prev.interim));
  }
  return false;
}

export interface CompactionPlan {
  /** The span the summary must cover (after any previous summary). */
  toSummarize: AgentEvent[];
  /** Where the verbatim part starts; `null` when nothing is kept. */
  firstKeptEventId: string | null;
  /** The previous summary, to be updated rather than replaced. */
  previousSummary: string | null;
  /** The cut lands inside a turn rather than on a user prompt. */
  splitTurn: boolean;
}

/**
 * Chooses the cut: walk back from the newest event until `keepRecentTokens`
 * worth has been passed, then move forward to the nearest event a cut may
 * land on. When nothing after that point qualifies — the tail is one huge
 * tool batch — the last valid cut in the conversation is used instead, which
 * keeps more than the budget rather than cutting a call from its result.
 *
 * `null` when there is nothing to summarize: no events past the previous
 * compaction, or the only valid cut is the very first of them.
 *
 * `keepRecentTokens: 0` (manual `/compact` keeps nothing it does not have to)
 * cuts at the last valid point.
 */
export function planCompaction(events: readonly AgentEvent[], keepRecentTokens: number): CompactionPlan | null {
  const projection = projectContext(events);
  const span = projection.events;
  if (span.length === 0) return null;

  let start = span.length;
  let accumulated = 0;
  for (let i = span.length - 1; i >= 0; i--) {
    accumulated += estimateEventTokens(span[i]!);
    start = i;
    if (accumulated >= keepRecentTokens && keepRecentTokens > 0) break;
  }
  if (keepRecentTokens <= 0) start = span.length - 1;

  let cut = -1;
  for (let i = start; i < span.length; i++) {
    if (isValidCut(span, i)) {
      cut = i;
      break;
    }
  }
  if (cut < 0) {
    for (let i = span.length - 1; i >= 0; i--) {
      if (isValidCut(span, i)) {
        cut = i;
        break;
      }
    }
  }
  // A cut at the very first event would keep everything: nothing to do.
  if (cut === 0) return null;
  if (cut < 0) {
    // No event in the span can start the kept part at all, so the only way
    // to shrink the context is to summarize all of it.
    return { toSummarize: span, firstKeptEventId: null, previousSummary: projection.summary, splitTurn: false };
  }

  return {
    toSummarize: span.slice(0, cut),
    firstKeptEventId: eventId(span[cut]!),
    previousSummary: projection.summary,
    splitTurn: span[cut]!.kind !== 'user_prompt',
  };
}

// ---- the summarizer's input -----------------------------------------------

/**
 * The span as plain text for the summarizer — not as chat messages, so the
 * model reads it as a document to summarize rather than a conversation to
 * continue (pi's `serializeConversation`).
 *
 * `maxChars` bounds the result for a span too large to fit the summarizing
 * request itself; the *oldest* part goes first, since the previous summary
 * already stands in for the beginning and the recent part is what the next
 * turn depends on.
 */
export function serializeForSummary(events: readonly AgentEvent[], maxChars: number): string {
  const lines: string[] = [];
  const toolNames = new Map<string, string>();
  for (const event of events) {
    switch (event.kind) {
      case 'user_prompt':
        lines.push(
          `[User]: ${event.text}${event.image ? '\n[The user attached an image.]' : ''}` +
            (event.attachments?.length
              ? `\n[The user attached: ${event.attachments.map((a) => a.path).join(', ')}]`
              : ''),
        );
        break;
      case 'text':
        lines.push(`[Assistant]: ${event.text}`);
        break;
      case 'tool_use': {
        toolNames.set(event.id, event.name);
        const args = clip(JSON.stringify(event.input), SUMMARY_TOOL_ARGS_CHARS);
        lines.push(`[Assistant tool call]: ${event.name}(${args})`);
        break;
      }
      case 'tool_result': {
        const name = toolNames.get(event.toolUseId);
        const label = `[Tool result${name ? ` from ${name}` : ''}${event.isError ? ', error' : ''}]`;
        lines.push(`${label}: ${clip(event.content, SUMMARY_TOOL_RESULT_CHARS)}`);
        break;
      }
      default:
        break;
    }
  }
  let text = lines.join('\n\n');
  if (text.length > maxChars) {
    text = `[… the oldest part of this conversation is omitted …]\n\n${text.slice(text.length - maxChars)}`;
  }
  return text;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[… ${text.length - max} more characters truncated]` : text;
}

/** The user message of the summarizing request. */
export function buildSummaryRequest(
  conversation: string,
  previousSummary: string | null,
  splitTurn: boolean,
  focus: string | null,
): string {
  const parts = [`<conversation>\n${conversation}\n</conversation>`];
  if (previousSummary) parts.push(`<previous-summary>\n${previousSummary}\n</previous-summary>`);
  parts.push(previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT);
  let text = parts.join('\n\n');
  if (splitTurn) text += SPLIT_TURN_NOTE;
  if (focus) text += `\n\nAdditional focus: ${focus}`;
  return text;
}
