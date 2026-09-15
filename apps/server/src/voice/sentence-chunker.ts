/**
 * Splits a structured session's streamed `text_delta` text into sentences,
 * ready to hand one at a time to `LiveSttClient.synthesize` — the PA-20
 * Phase 3 "speak each sentence as soon as it's ready, don't wait for the
 * full reply" behavior. Pure and stateful-but-isolated (no I/O), so it is
 * unit tested directly rather than only exercised through the real event
 * pipeline in `tts-service.ts`.
 *
 * Sentence boundary is `[.!?]+` followed by *literal* whitespace — never
 * end-of-buffer, which would conflate "no more text has streamed in yet"
 * with "the sentence is actually over": a delta boundary landing right
 * after a genuine mid-sentence period (an abbreviation, a decimal) would
 * otherwise flush a false split purely because of streaming timing, not
 * punctuation. `flush()` is the one place end-of-text is treated as a real
 * boundary, since only the caller (on `turn_complete`) actually knows the
 * reply is finished.
 *
 * This still has a known, accepted false-positive within a single push:
 * an abbreviation like "e.g. " genuinely followed by whitespace reads as a
 * sentence end. That is an acceptable heuristic error (an extra, slightly
 * early TTS call, not a dropped or garbled one) for the same reason
 * `webhook-template.ts`'s own heuristics are — a wrong split is a minor
 * prosody blip, not silence.
 *
 * `MAX_CHUNK_CHARS` is the fallback for a long run of text with no
 * punctuation at all — the plan's own "sentence-chunk... plus a max-length
 * fallback" requirement — so a single very long unpunctuated clause is not
 * held back from being spoken until the whole turn finishes.
 */

const SENTENCE_END = /[.!?]+\s+/;
const MAX_CHUNK_CHARS = 200;

export class SentenceChunker {
  private buffer = '';

  /** Feed one `text_delta`'s text. Returns zero or more complete sentences. */
  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];

    for (;;) {
      const match = SENTENCE_END.exec(this.buffer);
      if (match) {
        const end = match.index + match[0].length;
        const sentence = this.buffer.slice(0, end).trim();
        this.buffer = this.buffer.slice(end);
        if (sentence) out.push(sentence);
        continue;
      }

      if (this.buffer.length < MAX_CHUNK_CHARS) break;

      // No sentence-ending punctuation yet, but the clause is already long —
      // cut at the last whitespace boundary so a word is never split in the
      // middle; only fall back to a hard cut when there is no whitespace at
      // all within the limit (one absurdly long "word").
      const lastSpace = this.buffer.lastIndexOf(' ', MAX_CHUNK_CHARS);
      const cut = lastSpace > 0 ? lastSpace : MAX_CHUNK_CHARS;
      const sentence = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (sentence) out.push(sentence);
    }

    return out;
  }

  /** Call once the turn's text is fully known (on `turn_complete`) to flush
   *  whatever trailing text never hit a sentence boundary — the last clause
   *  of a reply is not required to end in punctuation. */
  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest.length > 0 ? rest : null;
  }

  /** Discard any buffered-but-unspoken text — used when a turn is
   *  interrupted or a new one starts before this one flushed. */
  reset(): void {
    this.buffer = '';
  }
}
