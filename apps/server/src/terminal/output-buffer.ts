import type { ReplayPayload } from '@pocketagent/protocol';

interface Chunk {
  seq: number;
  data: string;
  bytes: number;
}

/**
 * Bounded, sequence-numbered ring of terminal output.
 *
 * We store raw chunks rather than running a terminal emulator server-side. That
 * keeps the server simple and means a reconnecting client gets a byte-exact
 * suffix of the stream, which xterm.js renders identically to a live feed.
 *
 * The cost is that eviction can slice an ANSI escape sequence in half. That is
 * why eviction is reported: a replay whose starting point was evicted is marked
 * `truncated`, and the client clears its screen before writing it.
 */
export class OutputBuffer {
  private chunks: Chunk[] = [];
  private totalBytes = 0;
  private lastSeq = 0;
  /** Number of chunks dropped, for observability. */
  private droppedChunks = 0;

  constructor(private readonly maxBytes: number) {
    if (maxBytes <= 0) throw new Error('maxBytes must be positive');
  }

  /** Append output and return its assigned sequence number. */
  append(data: string): number {
    const seq = ++this.lastSeq;
    const bytes = Buffer.byteLength(data, 'utf8');
    this.chunks.push({ seq, data, bytes });
    this.totalBytes += bytes;
    this.evict();
    return seq;
  }

  private evict(): void {
    // Always retain at least one chunk, even if a single write exceeds maxBytes;
    // dropping it entirely would silently lose the most recent screen.
    while (this.totalBytes > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      if (!dropped) break;
      this.totalBytes -= dropped.bytes;
      this.droppedChunks++;
    }
  }

  getLastSeq(): number {
    return this.lastSeq;
  }

  /** Sequence number of the oldest chunk still retained. */
  getFirstSeq(): number {
    return this.chunks[0]?.seq ?? this.lastSeq + 1;
  }

  getByteLength(): number {
    return this.totalBytes;
  }

  getDroppedChunks(): number {
    return this.droppedChunks;
  }

  /**
   * Everything strictly after `afterSeq`, concatenated.
   *
   * `truncated` is true when the client's next expected chunk (`afterSeq + 1`)
   * has already been evicted, so the returned data does not continue from what
   * the client last rendered.
   */
  replayAfter(afterSeq: number): ReplayPayload {
    const from = Math.max(0, afterSeq);
    const firstRetained = this.getFirstSeq();
    const truncated = this.chunks.length > 0 && from + 1 < firstRetained;

    if (from >= this.lastSeq) {
      return { data: '', fromSeq: this.lastSeq, toSeq: this.lastSeq, truncated: false };
    }

    let startIndex = this.chunks.length;
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      if (chunk && chunk.seq > from) {
        startIndex = i;
        break;
      }
    }

    const selected = this.chunks.slice(startIndex);
    if (selected.length === 0) {
      return { data: '', fromSeq: this.lastSeq, toSeq: this.lastSeq, truncated };
    }

    const first = selected[0]!;
    const last = selected[selected.length - 1]!;
    return {
      data: selected.map((c) => c.data).join(''),
      fromSeq: first.seq - 1,
      toSeq: last.seq,
      truncated,
    };
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }
}
