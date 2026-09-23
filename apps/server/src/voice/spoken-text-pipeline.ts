import { SentenceChunker } from './sentence-chunker.js';
import { SpokenTextExtractor } from './spoken-text-extractor.js';

/**
 * PA-84: the two stages a streamed reply passes through before it is spoken —
 * "what of this should be spoken at all" (`SpokenTextExtractor`) and then
 * "where do the sentences end" (`SentenceChunker`) — owned as one object.
 *
 * Deliberately one class rather than two maps in `VoiceTtsService`. The
 * extractor carries per-turn state that *must* be discarded whenever the
 * chunker's is (a turn boundary, a stop, an interrupt, a session exit), and
 * every PA-83 bug was a piece of voice state that one of those five paths
 * forgot. Holding both behind a single `reset()` makes "reset one but not the
 * other" unrepresentable instead of merely tested — and the failure it
 * prevents is the bad one: an extractor left mid-fence swallows the next
 * turn's whole reply, which presents as talk-back dying for good.
 *
 * `flush()` returns an array rather than the chunker's own `string | null`
 * because the extractor can release held text at turn end (a short untagged
 * reply is held in its entirety until then), and that text can itself contain
 * several sentences.
 */
export class SpokenTextPipeline {
  private readonly extractor = new SpokenTextExtractor();
  private readonly chunker = new SentenceChunker();
  /**
   * PA-89: complete sentences produced in *fallback* mode, withheld from the
   * caller until the turn's outcome is known — see `push()`.
   */
  private held: string[] = [];

  /**
   * Feed one `text_delta`'s text; returns zero or more sentences to speak
   * **now**.
   *
   * Tagged content is returned immediately, which is what preserves PA-84's
   * spoken lede: the model is asked for the summary first precisely so a
   * multi-minute tool-using turn is not silent, and holding it back would
   * trade that away.
   *
   * Untagged content is *held* instead, because mid-turn there is no way to
   * tell the reply apart from a model thinking out loud before a tool call.
   * PA-89 was exactly that: "I need to fetch the URL…" was streamed as
   * `text_delta`, never persisted as a `text` event (`driveLoop` drops the
   * content of a round trip that ends in tool calls), and spoken anyway —
   * which also latched the extractor into fallback for the rest of the turn
   * and so narrated the whole written reply instead of the `<speak>` summary.
   * A `reset()` on `tool_use` discards the held text; `flush()` releases it
   * once `turn_complete` proves it really was the reply.
   *
   * The cost is that a model which ignores the instruction entirely has its
   * reply spoken starting at turn end rather than sentence-by-sentence. That
   * is the accepted trade for never speaking a scratchpad: the alternative —
   * speak untagged text immediately and retract it on `tool_use` — cannot be
   * retracted from the browser's playback queue without a second, racy signal
   * telling it which audio to drop, and it cuts a legitimate lede off
   * mid-word when it guesses wrong.
   */
  push(delta: string): string[] {
    const wasTagged = this.extractor.isTagged();
    const speakable = this.extractor.push(delta);

    // A late `<speak>` supersedes the prose that preceded it: that text was
    // the model's preamble, and the tag is its considered summary of the same
    // thing. The chunker goes too — it may be holding an unterminated clause
    // of that prose, which would otherwise be prepended to the summary.
    if (!wasTagged && this.extractor.isTagged()) {
      this.held = [];
      this.chunker.reset();
    }

    if (speakable.length === 0) return [];
    const sentences = this.chunker.push(speakable);
    if (this.extractor.isTagged()) return sentences;
    this.held.push(...sentences);
    return [];
  }

  /** Call on `turn_complete`: releases everything still held by either stage,
   *  including the fallback text `push()` withheld pending this moment. */
  flush(): string[] {
    const out: string[] = [];
    const tail = this.extractor.flush();
    if (tail.length > 0) out.push(...this.chunker.push(tail));
    const rest = this.chunker.flush();
    if (rest) out.push(rest);

    // `extractor.flush()` can itself settle the mode (a reply short enough to
    // never leave `deciding` resolves to fallback there), so this is asked
    // after it rather than before.
    if (this.extractor.isTagged()) {
      this.held = [];
      return out;
    }
    const all = [...this.held, ...out];
    this.held = [];
    return all;
  }

  /** Discard all buffered-but-unspoken state in every stage. */
  reset(): void {
    this.extractor.reset();
    this.chunker.reset();
    this.held = [];
  }
}
