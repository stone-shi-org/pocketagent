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

  /** Feed one `text_delta`'s text; returns zero or more complete sentences. */
  push(delta: string): string[] {
    const speakable = this.extractor.push(delta);
    return speakable.length > 0 ? this.chunker.push(speakable) : [];
  }

  /** Call on `turn_complete`: releases everything still held by either stage. */
  flush(): string[] {
    const out: string[] = [];
    const tail = this.extractor.flush();
    if (tail.length > 0) out.push(...this.chunker.push(tail));
    const rest = this.chunker.flush();
    if (rest) out.push(rest);
    return out;
  }

  /** Discard all buffered-but-unspoken state in both stages. */
  reset(): void {
    this.extractor.reset();
    this.chunker.reset();
  }
}
