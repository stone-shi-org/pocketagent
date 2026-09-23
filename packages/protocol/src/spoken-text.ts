/**
 * PA-84: the `<speak>` convention — one reply, two audiences.
 *
 * A reply that reads well on screen (fenced code, paths, URLs, tables) reads
 * terribly aloud, which is the reported bug: with live-listen on, talk-back
 * narrated code samples verbatim. So a voice-enabled turn asks the model for a
 * short spoken paraphrase wrapped in `<speak>…</speak>`, the TTS pipeline
 * speaks only that, and the transcript shows the written reply without it.
 *
 * This module is in `packages/protocol` rather than in the server because
 * **both sides read the same grammar**: the server decides what to *speak*
 * (`voice/spoken-text-extractor.ts`) and the browser decides what to *hide*
 * (`agent/transcript.ts`, `components/Transcript.tsx`). That is the rule
 * `cron-expr.ts` and `webhook-template.ts` already establish — a second copy
 * of the tag syntax would eventually disagree with itself, and the failure
 * would be the tag showing up on screen or the paraphrase being read out twice.
 *
 * The tag is deliberately *not* stripped from the agent's own on-disk
 * transcript: for `claude` that file is `~/.claude/projects/<encoded-cwd>/
 * <id>.jsonl`, written by Claude Code itself, and this app never rewrites it
 * (see CLAUDE.md's "the directory-name encoding is lossy" rule for the
 * neighbouring reason). So "TTS-only and discarded after playback" is not
 * available; hiding it at render is the whole mechanism.
 *
 * Known and accepted (PA-84 open question 4): because the tag is meaningful,
 * text this app did not author can carry it — a webhook prompt built partly
 * from a Jira ticket, or a file the agent reads and echoes back. The worst
 * case is the speaker saying attacker-chosen words rather than anything
 * executing, and the untagged fallback path speaks reply text aloud anyway, so
 * this is documented rather than defended with a per-turn nonce fence (which
 * would roughly double the tag-compliance risk the fallback exists to absorb).
 */

export const SPEAK_OPEN_TAG = '<speak>';
export const SPEAK_CLOSE_TAG = '</speak>';

/**
 * Appended to a voice-enabled turn's prompt text (`ws/index.ts`'s
 * `case 'prompt'`), never to any other turn.
 *
 * The tag is requested **first** on purpose. Talk-back is incremental — each
 * sentence is synthesized as it streams (`SentenceChunker` → `TurnTtsPump`) —
 * so a paraphrase written *after* the full reply could not be spoken until the
 * turn's last token, which on a multi-minute tool-using turn means total
 * silence and then a summary. A spoken lede keeps the immediacy that is the
 * entire point of a hands-free session, and it is also what a person does:
 * say the outcome, then show the work.
 *
 * Deliberately not a system prompt. No coding-agent path here has
 * system-prompt plumbing, an adapter's argv never reaches a structured session
 * (`SessionManager` forwards only `executable`/`env`), and the Claude SDK's own
 * `systemPrompt` option is built once in `StructuredSession.start()` — so a
 * system instruction would be spawn-time and could not follow a mid-session
 * voice toggle. Prompt text is per-turn, needs no new plumbing, and reaches all
 * five structured backends identically. `SUBAGENT_RESULT_TRAILER`
 * (`planner/tools.ts`, PA-76) is the same pattern: append an instruction asking
 * for a tagged section, then extract it, with a defined answer for "absent".
 */
export const SPOKEN_SUMMARY_INSTRUCTION =
  '[Voice mode is on for this turn: your reply will be read aloud.] ' +
  `Begin your reply with a one- or two-sentence spoken summary wrapped in ${SPEAK_OPEN_TAG}…${SPEAK_CLOSE_TAG} ` +
  '— plain conversational prose, the way you would say it out loud, with no code, no file paths, ' +
  'no URLs and no markdown. Then write your normal reply after the closing tag, exactly as you ' +
  'otherwise would. Only the tagged sentence is spoken; everything after it is read on screen.';

/** What separates the user's own text from the instruction, kept here so the
 *  appender and the stripper below cannot disagree about it. */
const INSTRUCTION_SEPARATOR = '\n\n';

/** Appends the instruction to a prompt. The only place it is composed. */
export function appendSpokenSummaryInstruction(promptText: string): string {
  if (promptText.length === 0) return SPOKEN_SUMMARY_INSTRUCTION;
  if (promptText.includes(SPOKEN_SUMMARY_INSTRUCTION)) return promptText;
  return `${promptText}${INSTRUCTION_SEPARATOR}${SPOKEN_SUMMARY_INSTRUCTION}`;
}

/**
 * Removes the instruction from a prompt for *display*.
 *
 * The instruction genuinely is part of the prompt that ran — it is in the
 * `user_prompt` event, in the agent's own transcript, and in a queued prompt's
 * persisted row (`sessions/prompt-queue.ts` re-sends the stored text verbatim,
 * which is why injection happens before `promptQueue.submit`). Only the
 * rendering hides it, so the chat shows what the human typed rather than
 * plumbing they did not write.
 */
export function stripSpokenSummaryInstruction(text: string): string {
  if (!text.includes(SPOKEN_SUMMARY_INSTRUCTION)) return text;
  return text
    .split(`${INSTRUCTION_SEPARATOR}${SPOKEN_SUMMARY_INSTRUCTION}`)
    .join('')
    .split(SPOKEN_SUMMARY_INSTRUCTION)
    .join('')
    .trim();
}

/**
 * Matches a *partial* tag left at the end of a still-streaming buffer, so a
 * half-arrived `<spea` never flashes on screen before its next delta lands.
 * Anchored to the end and allows nothing after the prefix.
 */
const TRAILING_PARTIAL_TAG = /<\/?(?:s(?:p(?:e(?:a(?:k)?)?)?)?)?$/;

/**
 * Removes `<speak>` blocks (tags *and* their content) from a reply for display.
 *
 * Safe to call on a partially-streamed reply, which is the normal case: an
 * unclosed `<speak>` means the spoken lede is still arriving, so everything
 * from the opening tag onward is dropped until the closing tag shows up.
 *
 * The guard at the end matters. A model that wraps its *whole* reply in the tag
 * would otherwise render an empty message bubble — a blank turn reads as a
 * failed one — so in that case the tags alone are removed and the content is
 * shown. Tag compliance costs the user nothing on screen either way.
 */
export function stripSpokenSummary(text: string): string {
  if (!text.includes(SPEAK_OPEN_TAG)) {
    return text.replace(TRAILING_PARTIAL_TAG, '');
  }

  let out = '';
  let cursor = 0;
  // Whether the reply is currently *inside* a block whose closing tag has not
  // arrived — which is the difference between "the summary is still being
  // written" and "the summary was the whole reply", and the two want opposite
  // answers from the guard below.
  let unclosed = false;
  for (;;) {
    const open = text.indexOf(SPEAK_OPEN_TAG, cursor);
    if (open === -1) {
      out += text.slice(cursor);
      break;
    }
    out += text.slice(cursor, open);
    const close = text.indexOf(SPEAK_CLOSE_TAG, open + SPEAK_OPEN_TAG.length);
    if (close === -1) {
      unclosed = true;
      break;
    }
    cursor = close + SPEAK_CLOSE_TAG.length;
  }

  const cleaned = out.replace(TRAILING_PARTIAL_TAG, '').replace(/\n{3,}/g, '\n\n').trim();
  if (cleaned.length > 0) return cleaned;

  // Nothing outside the tag. Either the spoken summary is still streaming and
  // the written reply has not started (show nothing yet — it is one keystroke
  // away), or the model wrapped its entire reply and hiding it would leave a
  // blank turn, which reads as a failed one.
  if (unclosed) return '';
  return text.split(SPEAK_OPEN_TAG).join('').split(SPEAK_CLOSE_TAG).join('').trim();
}
