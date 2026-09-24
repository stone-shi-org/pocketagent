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
 * One piece of a reply as the tag grammar sees it: prose, or a real tag.
 */
export type SpeakToken =
  | { kind: 'text'; text: string }
  | { kind: 'open' }
  | { kind: 'close' };

/**
 * Finds `<speak>`/`</speak>` in streamed text, **ignoring any that sit inside
 * markdown code** — an inline span or a fenced block.
 *
 * This exists because a tag found by `indexOf` is also a tag the model merely
 * *mentioned*. Prod session `Axd2XlzNSf5d` explained this very feature and
 * wrote "with the `` `<speak>` `` instruction added in `ws/index.ts`" with no
 * closing tag anywhere, so the browser read it as an opened, still-streaming
 * summary and hid the other 94% of the reply, cutting it off on screen at the
 * backtick. The server's extractor had the same flaw the other way round: a
 * mention switched talk-back into tagged mode and read the rest of the reply
 * aloud as though it were the summary. A mention of the tag is nearly always
 * in code, because a bare `<speak>` in markdown would be eaten by the HTML
 * sanitizer and the model knows to quote it; a real tag, per
 * `SPOKEN_SUMMARY_INSTRUCTION`, is never in code. So "outside code" is the
 * whole rule, and a mention in plain prose is still read as a tag.
 *
 * Incremental because the server feeds it one `text_delta` at a time and a
 * tag, a fence or a backtick run can straddle any delta boundary. The browser
 * feeds it the whole text at once; both get the same answer, which is the
 * point of it living here. Text is released as soon as it cannot be part of a
 * tag. The only thing ever held back is a trailing partial tag such as `<spe`,
 * which `pendingTag` exposes so each caller decides what a turn that ended on
 * one means.
 *
 * The markdown is approximated, not parsed, and the approximations err toward
 * "this is code", which means "show the text / do not switch mode":
 * - A fence is a line of 3+ backticks or tildes after at most three spaces of
 *   indentation, closed by a line of the same character at least as long.
 *   Indented code blocks are not tracked, because they cannot be told apart
 *   from list continuations without a real parser.
 * - An inline span opens on a run of N backticks and closes on the next run of
 *   exactly N. A blank line ends it, as a paragraph break does in CommonMark.
 *   An unclosed span counts as code to the end of its paragraph, since
 *   mid-stream its closing backtick may simply not have arrived yet.
 */
export class SpeakTagScanner {
  /** The open fence's character and length, or null outside a fence. */
  private fence: { char: string; len: number } | null = null;
  /** Leading spaces and fence characters of the current line, until a
   *  different character settles whether the line is a fence line. `null`
   *  once the line's head has been settled. */
  private lineHead: string | null = '';
  /** The current line has only whitespace so far (paragraph-break detection). */
  private lineBlank = true;
  /** Length of the backtick run being read, not yet settled. */
  private tickRun = 0;
  /** Length of the run that opened the current inline span, or 0. */
  private spanLen = 0;
  /** A possible partial tag, only ever held outside code. */
  private tagBuf = '';
  private tokens: SpeakToken[] = [];
  private text = '';

  push(chunk: string): SpeakToken[] {
    for (const ch of chunk) this.step(ch);
    return this.drain();
  }

  /** The partial tag held at the end of the input, if any, e.g. `<spe`. */
  get pendingTag(): string {
    return this.tagBuf;
  }

  /** Ends the input. Returns the held partial tag and discards it, so the
   *  caller decides whether a turn that ended on `<spe` shows it or not. */
  finish(): string {
    const held = this.tagBuf;
    this.tagBuf = '';
    return held;
  }

  reset(): void {
    this.fence = null;
    this.lineHead = '';
    this.lineBlank = true;
    this.tickRun = 0;
    this.spanLen = 0;
    this.tagBuf = '';
    this.tokens = [];
    this.text = '';
  }

  private drain(): SpeakToken[] {
    this.flushText();
    const out = this.tokens;
    this.tokens = [];
    return out;
  }

  private flushText(): void {
    if (this.text.length === 0) return;
    this.tokens.push({ kind: 'text', text: this.text });
    this.text = '';
  }

  private emitTag(kind: 'open' | 'close'): void {
    this.flushText();
    this.tokens.push({ kind });
  }

  /** Releases a held partial tag as ordinary text. */
  private releaseTagBuf(): void {
    this.text += this.tagBuf;
    this.tagBuf = '';
  }

  private step(ch: string): void {
    if (ch === '\n') {
      this.releaseTagBuf();
      this.settleLineHead();
      this.settleTickRun();
      if (this.lineBlank && this.fence === null) this.spanLen = 0;
      this.text += ch;
      this.lineHead = '';
      this.lineBlank = true;
      return;
    }
    if (!/\s/.test(ch)) this.lineBlank = false;

    if (this.lineHead !== null) {
      if (this.extendsLineHead(ch)) {
        this.lineHead += ch;
        this.text += ch;
        return;
      }
      this.settleLineHead();
    }

    if (this.fence !== null) {
      this.text += ch;
      return;
    }

    if (ch === '`') {
      this.releaseTagBuf();
      this.tickRun++;
      this.text += ch;
      return;
    }
    this.settleTickRun();

    if (this.spanLen > 0) {
      this.text += ch;
      return;
    }

    if (this.tagBuf.length === 0 && ch !== '<') {
      this.text += ch;
      return;
    }
    this.tagBuf += ch;
    if (this.tagBuf === SPEAK_OPEN_TAG) {
      this.tagBuf = '';
      this.emitTag('open');
      return;
    }
    if (this.tagBuf === SPEAK_CLOSE_TAG) {
      this.tagBuf = '';
      this.emitTag('close');
      return;
    }
    // Keep the longest suffix that could still become a tag; everything before
    // it is text. (`<<speak>` releases the first `<`.)
    let start = 0;
    while (start < this.tagBuf.length && !isTagPrefix(this.tagBuf.slice(start))) start++;
    this.text += this.tagBuf.slice(0, start);
    this.tagBuf = this.tagBuf.slice(start);
  }

  /** Whether `ch` can still belong to a fence marker at the start of a line. */
  private extendsLineHead(ch: string): boolean {
    const head = this.lineHead ?? '';
    const marker = head.trimStart();
    if (marker.length === 0) {
      if (ch === ' ') return head.length < 3;
      return ch === '`' || ch === '~';
    }
    return ch === marker[0];
  }

  /**
   * The line's head is complete: decide whether it was a fence line. A head
   * that was not one is ordinary text, and its backticks, if any, are an
   * inline run to be read as such.
   */
  private settleLineHead(): void {
    const head = this.lineHead;
    this.lineHead = null;
    if (head === null) return;
    const marker = head.trimStart();
    const char = marker[0];
    if (marker.length >= 3 && (char === '`' || char === '~')) {
      if (this.fence === null) {
        this.fence = { char, len: marker.length };
        this.spanLen = 0;
        this.tickRun = 0;
        return;
      }
      if (this.fence.char === char && marker.length >= this.fence.len) {
        this.fence = null;
        return;
      }
    }
    if (this.fence === null && char === '`') this.tickRun += marker.length;
  }

  /** A backtick run has ended: it opens a span, closes one, or is inert. */
  private settleTickRun(): void {
    const run = this.tickRun;
    if (run === 0) return;
    this.tickRun = 0;
    if (this.spanLen === 0) this.spanLen = run;
    else if (this.spanLen === run) this.spanLen = 0;
  }
}

function isTagPrefix(s: string): boolean {
  return SPEAK_OPEN_TAG.startsWith(s) || SPEAK_CLOSE_TAG.startsWith(s);
}

/**
 * One pass over a reply, splitting it into what is spoken and what is shown.
 *
 * Both `stripSpokenSummary` (the browser hiding the tag) and
 * `extractSpokenSummary` (the browser *showing* it on request) read this, so
 * the two can never disagree about where a block starts and ends — the same
 * single-source rule that put this whole module in `packages/protocol`.
 */
interface ScannedReply {
  /** Text outside every `<speak>` block, in order. */
  outside: string;
  /** The content of each *closed* block, in order. */
  spoken: string[];
  /** Text of a block that was opened and never closed, or `null`. */
  unclosed: string | null;
  /** A trailing partial tag (`<spe`) the scanner held back. */
  pendingTag: string;
}

function scanReply(text: string): ScannedReply {
  const scanner = new SpeakTagScanner();
  const tokens = scanner.push(text);
  const pendingTag = scanner.finish();

  let outside = '';
  const spoken: string[] = [];
  let inside: string | null = null;
  for (const token of tokens) {
    if (token.kind === 'text') {
      if (inside === null) outside += token.text;
      else inside += token.text;
    } else if (token.kind === 'open') {
      // A nested open inside a block is just more of the block.
      if (inside === null) inside = '';
    } else if (inside !== null) {
      spoken.push(inside.trim());
      inside = null;
    }
    // A stray `</speak>` outside a block is markup, and is dropped.
  }

  return { outside, spoken, unclosed: inside, pendingTag };
}

/**
 * The spoken paraphrase a reply carried, or `null` if it carried none.
 *
 * This is what the transcript's "spoken summary" disclosure shows. The text is
 * otherwise invisible — `stripSpokenSummary` removes it and the speaker is the
 * only place it ever surfaced — so without this there is no way to check what
 * was actually read aloud, which is the one question a mis-tuned paraphrase
 * makes someone ask.
 *
 * Only *closed* blocks count: a half-written summary is not yet a summary, and
 * revealing it mid-stream would show text that is still changing.
 */
export function extractSpokenSummary(text: string): string | null {
  if (!text.includes(SPEAK_OPEN_TAG)) return null;
  const joined = scanReply(text)
    .spoken.filter((part) => part.length > 0)
    .join(' ');
  return joined.length > 0 ? joined : null;
}

export interface StripSpokenSummaryOptions {
  /**
   * Whether more text may still arrive. Defaults to `true`, which is the
   * cautious reading for a caller that does not know.
   *
   * While streaming, an unclosed block is a lede still being written, so it
   * is hidden, and so is a trailing partial tag. Once the reply is finished
   * neither can be completed any more, so both are *shown*. A block the model
   * never closed is still a reply the user is owed; hiding it would cut the
   * message off with no sign anything was cut.
   */
  streaming?: boolean;
}

/**
 * Removes `<speak>` blocks (tags *and* their content) from a reply for display.
 * A tag inside markdown code is ordinary text (see `SpeakTagScanner`).
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
export function stripSpokenSummary(text: string, opts: StripSpokenSummaryOptions = {}): string {
  const streaming = opts.streaming ?? true;
  // Fast path, and it has to stay exact: a reply with no tag in it is shown
  // byte-for-byte as written.
  if (!text.includes('<')) return text;

  const { outside, spoken, unclosed, pendingTag } = scanReply(text);
  if (spoken.length === 0 && unclosed === null) {
    // No real tag. Only a half-arrived one at the very end is hidden.
    return streaming ? text.slice(0, text.length - pendingTag.length) : text;
  }

  let shown = outside;
  if (!streaming) {
    // A partial tag *inside* an unclosed block can only have been the start
    // of its `</speak>`, which is markup; outside one, it is the reply's text.
    if (unclosed !== null) shown += unclosed;
    else shown += pendingTag;
  }
  const cleaned = shown.replace(/\n{3,}/g, '\n\n').trim();
  if (cleaned.length > 0) return cleaned;

  // Nothing outside the tag. Either the spoken summary is still streaming and
  // the written reply has not started (show nothing yet — it is one keystroke
  // away), or the model wrapped its entire reply and hiding it would leave a
  // blank turn, which reads as a failed one.
  if (streaming && unclosed !== null) return '';
  return spoken.join('\n\n').trim();
}
