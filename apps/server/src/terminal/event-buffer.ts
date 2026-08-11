import type { AgentEvent, AgentReplayPayload, SequencedAgentEvent } from '@pocketagent/protocol';

/**
 * Bounded, sequence-numbered ring of normalized agent events.
 *
 * The structured analogue of OutputBuffer. Replay is cleaner here than in the
 * terminal case: events are self-contained, so a truncated replay loses old
 * messages but can never corrupt the rendering of the ones that remain — there
 * is no mid-escape-sequence hazard.
 */
export class EventBuffer {
  private events: SequencedAgentEvent[] = [];
  private bytes: number[] = [];
  private totalBytes = 0;
  private lastSeq = 0;
  private dropped = 0;

  constructor(private readonly maxBytes: number) {
    if (maxBytes <= 0) throw new Error('maxBytes must be positive');
  }

  append(event: AgentEvent): SequencedAgentEvent {
    const seq = ++this.lastSeq;
    const entry: SequencedAgentEvent = { seq, event };
    const size = Buffer.byteLength(JSON.stringify(entry), 'utf8');

    this.events.push(entry);
    this.bytes.push(size);
    this.totalBytes += size;
    this.evict();
    return entry;
  }

  private evict(): void {
    // Keep at least one event so the most recent state is never lost outright.
    while (this.totalBytes > this.maxBytes && this.events.length > 1) {
      this.events.shift();
      this.totalBytes -= this.bytes.shift() ?? 0;
      this.dropped++;
    }
  }

  getLastSeq(): number {
    return this.lastSeq;
  }

  getFirstSeq(): number {
    return this.events[0]?.seq ?? this.lastSeq + 1;
  }

  getDropped(): number {
    return this.dropped;
  }

  getByteLength(): number {
    return this.totalBytes;
  }

  /** Every event after `afterSeq`, with a flag when older ones were evicted. */
  replayAfter(afterSeq: number): AgentReplayPayload {
    const from = Math.max(0, afterSeq);
    const truncated = this.events.length > 0 && from + 1 < this.getFirstSeq();

    if (from >= this.lastSeq) {
      return { events: [], fromSeq: this.lastSeq, toSeq: this.lastSeq, truncated: false };
    }

    const selected = this.events.filter((e) => e.seq > from);
    if (selected.length === 0) {
      return { events: [], fromSeq: this.lastSeq, toSeq: this.lastSeq, truncated };
    }

    return {
      events: selected,
      fromSeq: selected[0]!.seq - 1,
      toSeq: selected[selected.length - 1]!.seq,
      truncated,
    };
  }

  /** Most recent events of a given kind — used to re-surface open approvals. */
  findByKind<K extends AgentEvent['kind']>(kind: K): Extract<AgentEvent, { kind: K }>[] {
    return this.events
      .map((e) => e.event)
      .filter((e): e is Extract<AgentEvent, { kind: K }> => e.kind === kind);
  }

  clear(): void {
    this.events = [];
    this.bytes = [];
    this.totalBytes = 0;
  }
}
