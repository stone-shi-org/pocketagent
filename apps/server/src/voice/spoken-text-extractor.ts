import { SPEAK_CLOSE_TAG, SPEAK_OPEN_TAG } from '@pocketagent/protocol';

/**
 * PA-84: turns a streamed reply into the text that should actually be spoken.
 *
 * Sits between `text_delta` and `SentenceChunker` (see `SpokenTextPipeline`),
 * and is the whole answer to "talk-back narrated a code block at me". Two
 * modes, chosen once per turn:
 *
 * - **tagged** — the reply opens with `<speak>…</speak>` as instructed
 *   (`SPOKEN_SUMMARY_INSTRUCTION`), so only tagged content is spoken and the
 *   written reply is never read aloud at all.
 * - **fallback** — no tag arrived. Speaking *nothing* is the wrong failure
 *   here: silence is indistinguishable from a dead microphone, the same
 *   reasoning PA-85's harness records for a discarded utterance, and it would
 *   make this feature's own non-compliance look like broken hardware. So the
 *   reply is spoken with the *unspeakable* parts removed instead — fenced
 *   code, inline code, tables, URLs, paths and markdown furniture. That needs
 *   no model cooperation, so it is also what every backend gets whose model
 *   ignores the instruction, and it is strictly better than the verbatim
 *   narration this ticket was filed about.
 *
 * ## The mode decision must be cheap, because talk-back is incremental
 *
 * PA-20 speaks each sentence *as it streams*; holding a reply back to inspect
 * it would trade the feature's whole point for tidiness. But speaking prose
 * and only *then* meeting a `<speak>` block would read the reply aloud and the
 * paraphrase after it — worse than either mode. The resolution is that the
 * instruction asks for the tag **first**, so the question "is this a tagged
 * reply?" is answerable from the first few characters: text is held only while
 * it is still a *prefix* of `<speak>`, which is at most six characters and
 * resolves on the very first delta in practice.
 *
 * A model that emits the tag *late* (a preamble, then `<speak>`) therefore
 * lands in fallback mode and has both its prose and its paraphrase spoken,
 * with the tag markup stripped rather than pronounced. That is a deliberate
 * accepted cost: the alternative is buffering every reply until a tag might
 * still show up, which reintroduces exactly the latency this avoids.
 *
 * ## Why fallback tracks lines, and still streams within one
 *
 * A fence can open in one `text_delta` and close in another, and a delta
 * boundary is streaming timing rather than syntax — the same trap
 * `SentenceChunker`'s own header records for sentence ends. Fences, tables and
 * indented code are *line* constructs, so each line is classified once, after
 * at most `CLASSIFY_CHARS` of it has arrived, and a line that turns out to be
 * code is dropped whole. Within a *speakable* line, text is released at
 * whitespace boundaries so a sentence still reaches the chunker as it is
 * typed — but never while an inline construct is open, because the end of a
 * backtick span, a link or a bare URL is not knowable until it closes.
 *
 * `reset()` clearing this state is load-bearing, not hygiene: a filter left
 * mid-fence by a stopped or interrupted turn would swallow the *next* turn's
 * reply entirely and present as talk-back dying for good. That is the shape of
 * every PA-83 bug, which is why `SpokenTextPipeline` owns this and the chunker
 * together rather than leaving two maps to be reset in step at five sites.
 */

/**
 * How much of a line's content is needed to classify it. Four characters
 * distinguishes every construct dropped below — ` ``` `, `~~~`, `|`, `---` —
 * from prose, and is short enough to be invisible next to synthesis latency.
 */
const CLASSIFY_CHARS = 4;

/** An inline-code span is spoken only when it reads as a word — `null`,
 *  `true`, `useMemo`. Anything with a dot, slash, bracket or space in it is a
 *  path, a call or a snippet, and reading it aloud is the reported bug. */
const WORDLIKE_CODE = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;

type Mode = 'deciding' | 'tagged' | 'fallback';
/** Per-line classification in fallback mode. */
type LineState = 'pending' | 'speaking' | 'skipping';

export class SpokenTextExtractor {
  private mode: Mode = 'deciding';
  /** Held text while `mode === 'deciding'`. At most `<speak>`'s own length. */
  private pending = '';
  /** Held text that might be a partial `<speak>`/`</speak>` in tagged mode. */
  private tagBuffer = '';
  private insideTag = false;
  /** Unreleased text of the current line in fallback mode. */
  private lineBuffer = '';
  private lineState: LineState = 'pending';
  /** Whether part of this line has already been spoken — leading markdown
   *  markers are only stripped from a line's first released segment. */
  private emittedInLine = false;
  private inFence = false;

  /** Feed one `text_delta`'s text. Returns the text to speak, possibly ''. */
  push(delta: string): string {
    if (delta.length === 0) return '';

    if (this.mode === 'deciding') {
      this.pending += delta;
      const trimmed = this.pending.trimStart();

      if (trimmed.includes(SPEAK_OPEN_TAG)) {
        this.mode = 'tagged';
        return this.pushTagged(this.takePending());
      }
      // Still possibly the opening tag, one character at a time.
      if (SPEAK_OPEN_TAG.startsWith(trimmed)) return '';

      this.mode = 'fallback';
      return this.pushFallback(this.takePending());
    }

    return this.mode === 'tagged' ? this.pushTagged(delta) : this.pushFallback(delta);
  }

  /** Call once the turn's text is fully known (`turn_complete`). Releases
   *  whatever is still held: a trailing clause with no newline, or a reply so
   *  short it never left the decision phase. */
  flush(): string {
    if (this.mode === 'deciding') {
      this.mode = 'fallback';
      const held = this.takePending();
      return `${this.pushFallback(held)}${this.flushFallback()}`.trimEnd();
    }
    if (this.mode === 'tagged') {
      // Text inside an unclosed tag is genuinely spoken text; a partial tag
      // left in the buffer is markup and is dropped.
      const tail = this.insideTag ? this.tagBuffer : '';
      this.tagBuffer = '';
      return tail.trim();
    }
    return this.flushFallback().trimEnd();
  }

  /** Discard all state — a new turn, a stop, or an interrupt. Must clear the
   *  fence and tag flags, or the next turn inherits them and goes silent. */
  reset(): void {
    this.mode = 'deciding';
    this.pending = '';
    this.tagBuffer = '';
    this.insideTag = false;
    this.lineBuffer = '';
    this.lineState = 'pending';
    this.emittedInLine = false;
    this.inFence = false;
  }

  private takePending(): string {
    const held = this.pending;
    this.pending = '';
    return held;
  }

  /**
   * Emits only the text between `<speak>` and `</speak>`. Tags may be split
   * across deltas, so a tail that could still become a tag is held rather than
   * emitted — otherwise a `<spea` would be spoken as letters. Several blocks
   * in one reply are all spoken, in order.
   */
  private pushTagged(chunk: string): string {
    this.tagBuffer += chunk;
    let out = '';

    for (;;) {
      if (!this.insideTag) {
        const open = this.tagBuffer.indexOf(SPEAK_OPEN_TAG);
        if (open === -1) {
          // Untagged text is never spoken in this mode; keep only what might
          // still become an opening tag.
          const keep = partialTailLength(this.tagBuffer, SPEAK_OPEN_TAG);
          this.tagBuffer = this.tagBuffer.slice(this.tagBuffer.length - keep);
          break;
        }
        this.tagBuffer = this.tagBuffer.slice(open + SPEAK_OPEN_TAG.length);
        this.insideTag = true;
        continue;
      }

      const close = this.tagBuffer.indexOf(SPEAK_CLOSE_TAG);
      if (close === -1) {
        const keep = partialTailLength(this.tagBuffer, SPEAK_CLOSE_TAG);
        out += this.tagBuffer.slice(0, this.tagBuffer.length - keep);
        this.tagBuffer = this.tagBuffer.slice(this.tagBuffer.length - keep);
        break;
      }
      const content = this.tagBuffer.slice(0, close);
      out += content;
      // A closing tag ends a sentence as far as the chunker is concerned: its
      // splitter needs literal whitespace *after* the punctuation, so two
      // adjacent blocks would otherwise fuse into one utterance and be spoken
      // as "done.Second".
      if (content.length > 0 && !/\s$/.test(content)) out += ' ';
      this.tagBuffer = this.tagBuffer.slice(close + SPEAK_CLOSE_TAG.length);
      this.insideTag = false;
    }

    return out;
  }

  private pushFallback(chunk: string): string {
    this.lineBuffer += chunk;
    let out = '';

    for (;;) {
      const nl = this.lineBuffer.indexOf('\n');
      if (nl !== -1) {
        const line = this.lineBuffer.slice(0, nl);
        this.lineBuffer = this.lineBuffer.slice(nl + 1);
        out += this.finishLine(line);
        continue;
      }
      out += this.releaseWithinLine();
      break;
    }

    return out;
  }

  private flushFallback(): string {
    const line = this.lineBuffer;
    this.lineBuffer = '';
    return this.finishLine(line);
  }

  /** Completes the current line: classify if still pending, emit the rest. */
  private finishLine(rest: string): string {
    if (this.lineState === 'pending') this.classifyLine(rest, true);
    const out =
      this.lineState === 'speaking' ? this.cleanSegment(rest, !this.emittedInLine) : '';
    this.lineState = 'pending';
    this.emittedInLine = false;
    // A line end is a sentence boundary as far as the chunker is concerned —
    // its splitter needs literal whitespace after the punctuation, and a
    // reply's last clause is not required to end in any.
    return out.length > 0 ? `${out} ` : '';
  }

  /**
   * Releases as much of the in-progress line as is safe: up to the last
   * whitespace, and nothing at all while an inline construct is still open.
   */
  private releaseWithinLine(): string {
    if (this.lineState === 'pending') {
      this.classifyLine(this.lineBuffer, false);
      if (this.lineState === 'pending') return '';
    }
    if (this.lineState === 'skipping') {
      this.lineBuffer = '';
      return '';
    }

    const lastSpace = this.lineBuffer.lastIndexOf(' ');
    if (lastSpace === -1) return '';
    const candidate = this.lineBuffer.slice(0, lastSpace + 1);
    if (hasOpenInlineConstruct(candidate)) return '';

    const out = this.cleanSegment(candidate, !this.emittedInLine);
    this.lineBuffer = this.lineBuffer.slice(lastSpace + 1);
    if (out.length === 0) return '';
    this.emittedInLine = true;
    return `${out} `;
  }

  /**
   * Decides whether the current line is prose or machine-readable furniture.
   * `complete` is true when the whole line is available; otherwise the verdict
   * is deferred until `CLASSIFY_CHARS` of content have arrived, so a `` ``` ``
   * split across deltas is never mistaken for prose.
   */
  private classifyLine(lineSoFar: string, complete: boolean): void {
    const content = lineSoFar.trimStart();
    if (!complete && content.length < CLASSIFY_CHARS) return;

    const indent = lineSoFar.length - content.length;

    // A fence delimiter toggles and is never spoken; inside a fence, nothing
    // is, so the *only* thing that matters is finding the closing delimiter.
    if (/^(?:```|~~~)/.test(content)) {
      this.inFence = !this.inFence;
      this.lineState = 'skipping';
      return;
    }
    if (this.inFence) {
      this.lineState = 'skipping';
      return;
    }

    if (content.length === 0) {
      this.lineState = 'skipping';
      return;
    }
    // A table row or separator, or a horizontal rule.
    if (content.startsWith('|') || /^[-=:|]{3}/.test(content)) {
      this.lineState = 'skipping';
      return;
    }
    // An indented code block — but not a nested list item, which is prose.
    if (indent >= 4 && !/^(?:[-*+]|\d+[.)])\s/.test(content)) {
      this.lineState = 'skipping';
      return;
    }

    this.lineState = 'speaking';
  }

  /** One segment of a speakable line → the prose a person would say. */
  private cleanSegment(segment: string, isLineStart: boolean): string {
    let text = segment;

    if (isLineStart) {
      text = text
        .trimStart()
        .replace(/^#{1,6}\s+/, '')
        .replace(/^>\s?/, '')
        .replace(/^[-*+]\s+/, '')
        .replace(/^\d+[.)]\s+/, '');
    }

    // A link reads as its text, never its URL.
    text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');

    // Inline code: kept only when it is a bare word (see WORDLIKE_CODE).
    text = text.replace(/`([^`]*)`/g, (_m, code: string) =>
      WORDLIKE_CODE.test(code) ? code : '',
    );

    return (
      text
        // A bare URL is unspeakable in any form.
        .replace(/\b(?:https?|ws|wss|file):\/\/\S+/gi, '')
        // A path: two or more slash-separated segments, or a leading ./ ~/ ../
        .replace(/(?:^|\s)(?:~|\.{1,2})?\/\S*\/\S*/g, ' ')
        // A model that emitted the tag late (see the header): strip the markup
        // rather than pronounce it.
        .split(SPEAK_OPEN_TAG)
        .join('')
        .split(SPEAK_CLOSE_TAG)
        .join('')
        // Stray fence/emphasis markers, which are silent punctuation on screen.
        .replace(/```|~~~/g, '')
        .replace(/\*\*|__|(?<![A-Za-z0-9])[*_](?![*_])/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim()
    );
  }
}

/**
 * Whether a released prefix would cut an inline construct in half — an odd
 * number of backticks, or a link whose `](url)` has not closed yet. Holding in
 * that case is what stops half a path being spoken as words.
 */
function hasOpenInlineConstruct(text: string): boolean {
  const backticks = text.split('`').length - 1;
  if (backticks % 2 === 1) return true;
  return text.lastIndexOf('[') > text.lastIndexOf(')');
}

/**
 * Length of the longest proper prefix of `tag` that `buf` ends with — how much
 * of the buffer has to be held back because it might still become a tag.
 */
function partialTailLength(buf: string, tag: string): number {
  const max = Math.min(buf.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (buf.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}
