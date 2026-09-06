import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueStore, QueuedItem } from '../src/runs/queue.js';
import { RunQueue } from '../src/runs/queue.js';

/**
 * The directory queue in isolation (PA-11).
 *
 * `webhooks.test.ts` covers the delivery path end to end; this file pins the
 * primitive's own rules, and most of them are rules about what must *not*
 * happen: no two grants for one tree, no timeout, no stranded lock, no lost
 * work across a restart.
 */

let busy: string[];
let started: string[];

function makeQueue(over: { maxPerKey?: number; maxTotal?: number } = {}): RunQueue {
  return new RunQueue({
    busyTreeRoots: () => busy,
    ...over,
  });
}

/** A producer that records what it was told, and never blocks. */
function makeStore(pending: QueuedItem[] = []): QueueStore & {
  queued: string[];
  dequeued: [string, string][];
} {
  const queued: string[] = [];
  const dequeued: [string, string][] = [];
  return {
    queued,
    dequeued,
    pending: () => pending,
    onQueued: (item) => queued.push(item.id),
    onDequeued: (item, reason) => dequeued.push([item.id, reason]),
  };
}

const item = (id: string, key: string, enqueuedAt = 0): QueuedItem => ({
  id,
  key,
  enqueuedAt,
  run: () => {
    started.push(id);
    return Promise.resolve();
  },
});

beforeEach(() => {
  busy = [];
  started = [];
});

describe('RunQueue: granting a working tree', () => {
  it('grants a free tree and refuses a second claim on it', () => {
    const q = makeQueue();
    expect(q.tryAcquire('/repo', 'a').granted).toBe(true);
    // The grant covers the window before a session exists — nothing is busy
    // yet, so without it the tree would read as free and both runs would start.
    const second = q.tryAcquire('/repo', 'b');
    expect(second.granted).toBe(false);
    expect(second).toMatchObject({ position: 1, holder: 'a' });
  });

  it('treats a tree with a mid-turn session as occupied, without any grant', () => {
    const q = makeQueue();
    busy = ['/repo'];
    expect(q.tryAcquire('/repo', 'a').granted).toBe(false);
  });

  it('keys on the working tree, so a subdirectory of it counts as the same tree', () => {
    const q = makeQueue();
    busy = ['/repo/.worktrees/feature-auth/apps/server'];
    // A session started deep inside a worktree still occupies that worktree.
    expect(q.tryAcquire('/repo/.worktrees/feature-auth', 'a').granted).toBe(false);
    // ...but not the main checkout it was linked from: those are two separate
    // checkouts, and blocking across them would serialize the very parallelism
    // worktrees exist to provide.
    expect(q.tryAcquire('/repo', 'b').granted).toBe(true);
  });

  it('hands occupancy from the grant to the session, so a dead session frees the tree', () => {
    const q = makeQueue();
    expect(q.tryAcquire('/repo', 'a').granted).toBe(true);
    busy = ['/repo'];
    q.started('/repo', 'a');
    // Still held — but by the session now, not by the claim.
    expect(q.tryAcquire('/repo', 'b').granted).toBe(false);
    // The session dies without anyone releasing anything. A stated lock would
    // strand here forever; a derived one simply frees.
    busy = [];
    expect(q.tryAcquire('/repo', 'c').granted).toBe(true);
  });

  it('ignores a release from work that no longer holds the tree', () => {
    const q = makeQueue();
    q.tryAcquire('/repo', 'a');
    q.release('/repo', 'a');
    expect(q.tryAcquire('/repo', 'b').granted).toBe(true);
    // `a` settling late must not evict `b`, which took its place.
    q.release('/repo', 'a');
    expect(q.tryAcquire('/repo', 'c').granted).toBe(false);
  });
});

describe('RunQueue: order and independence', () => {
  it('runs waiters in FIFO order, one at a time per tree', () => {
    const q = makeQueue();
    const store = makeStore();
    q.tryAcquire('/repo', 'holder');

    expect(q.enqueue(item('a', '/repo', 1), store)).toBe(true);
    expect(q.enqueue(item('b', '/repo', 2), store)).toBe(true);
    expect(q.depth('/repo')).toBe(2);
    expect(q.positionOf('a')).toBe(1);
    expect(q.positionOf('b')).toBe(2);

    q.release('/repo', 'holder');
    // Only the head starts: it now holds the tree.
    expect(started).toEqual(['a']);
    expect(q.depth('/repo')).toBe(1);

    q.release('/repo', 'a');
    expect(started).toEqual(['a', 'b']);
  });

  it('sorts by enqueue time rather than arrival, so an adopted row keeps its place', () => {
    const q = makeQueue();
    const store = makeStore();
    q.tryAcquire('/repo', 'holder');
    q.enqueue(item('late', '/repo', 200), store);
    q.enqueue(item('early', '/repo', 100), store);
    expect(q.positionOf('early')).toBe(1);
    q.release('/repo', 'holder');
    expect(started).toEqual(['early']);
  });

  it('keeps separate trees independent', () => {
    const q = makeQueue();
    const store = makeStore();
    q.tryAcquire('/a', 'holder-a');
    q.enqueue(item('wait-a', '/a', 1), store);
    // A different tree is free, so its work starts immediately rather than
    // waiting behind an unrelated directory.
    expect(q.tryAcquire('/b', 'run-b').granted).toBe(true);
    expect(q.depth('/b')).toBe(0);
    expect(started).toEqual([]);
  });

  it('moves work to the front of its own line without jumping the tree', () => {
    const q = makeQueue();
    const store = makeStore();
    q.tryAcquire('/repo', 'holder');
    q.enqueue(item('a', '/repo', 1), store);
    q.enqueue(item('b', '/repo', 2), store);

    expect(q.moveToFront('b')).toBe(true);
    expect(q.positionOf('b')).toBe(1);
    // Still waiting: reordering waiters must never start one while the tree is
    // held, which is the corruption the queue exists to prevent.
    expect(started).toEqual([]);
    q.release('/repo', 'holder');
    expect(started).toEqual(['b']);
  });
});

describe('RunQueue: bounds and cancellation', () => {
  it('refuses work past the per-tree cap, and reports it rather than dropping silently', () => {
    const q = makeQueue({ maxPerKey: 2 });
    const store = makeStore();
    q.tryAcquire('/repo', 'holder');
    expect(q.enqueue(item('a', '/repo', 1), store)).toBe(true);
    expect(q.enqueue(item('b', '/repo', 2), store)).toBe(true);
    // The producer records its own "did not run" outcome; the queue does not
    // invent one.
    expect(q.enqueue(item('c', '/repo', 3), store)).toBe(false);
    expect(store.queued).toEqual(['a', 'b']);
  });

  it('refuses work past the global cap', () => {
    const q = makeQueue({ maxTotal: 1 });
    const store = makeStore();
    q.tryAcquire('/a', 'ha');
    q.tryAcquire('/b', 'hb');
    expect(q.enqueue(item('a', '/a', 1), store)).toBe(true);
    expect(q.enqueue(item('b', '/b', 2), store)).toBe(false);
  });

  it('cancels a waiter, telling its producer so the row can be closed out', () => {
    const q = makeQueue();
    const store = makeStore();
    q.tryAcquire('/repo', 'holder');
    q.enqueue(item('a', '/repo', 1), store);
    q.enqueue(item('b', '/repo', 2), store);

    expect(q.cancel('a')).toBe(true);
    expect(store.dequeued).toEqual([['a', 'cancelled']]);
    expect(q.positionOf('a')).toBeNull();
    expect(q.positionOf('b')).toBe(1);

    q.release('/repo', 'holder');
    expect(started).toEqual(['b']);
  });

  it('forgets a waiter without reporting a cancellation, for a caller taking it over', () => {
    const q = makeQueue();
    const store = makeStore();
    q.tryAcquire('/repo', 'holder');
    q.enqueue(item('a', '/repo', 1), store);
    // `forget` is for a human forcing their own queued prompt through: telling
    // the producer to discard it would be the opposite of what is happening.
    expect(q.forget('a')).toBe(true);
    expect(store.dequeued).toEqual([]);
    q.release('/repo', 'holder');
    expect(started).toEqual([]);
  });

  it('never expires a waiter, however long the holder takes', () => {
    // A run parked on an unanswered approval is genuinely still working, so it
    // keeps its tree. There is no timeout anywhere in this class, and nothing
    // may decay into "start it anyway" — the assertion is the absence of any
    // time-based progress.
    vi.useFakeTimers();
    try {
      const q = makeQueue();
      const store = makeStore();
      q.tryAcquire('/repo', 'holder');
      q.enqueue(item('a', '/repo', 1), store);
      vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000);
      q.pump();
      expect(started).toEqual([]);
      expect(q.positionOf('a')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RunQueue: surviving a restart', () => {
  it('adopts persisted work oldest-first and starts what it can', () => {
    const q = makeQueue();
    // A closure cannot survive a restart, so a producer rebuilds `run` from its
    // own rows. Deliberately handed over out of order.
    const store = makeStore([item('second', '/repo', 200), item('first', '/repo', 100)]);
    q.register(store);
    q.init();

    expect(started).toEqual(['first']);
    expect(q.positionOf('second')).toBe(1);
  });

  it('does not start adopted work whose tree is still busy', () => {
    const q = makeQueue();
    busy = ['/repo'];
    const store = makeStore([item('a', '/repo', 1)]);
    q.register(store);
    q.init();
    expect(started).toEqual([]);

    busy = [];
    q.pump();
    expect(started).toEqual(['a']);
  });

  it('drops only its own memory on clear, leaving the producer\'s rows to be re-adopted', () => {
    const q = makeQueue();
    const store = makeStore();
    q.tryAcquire('/repo', 'holder');
    q.enqueue(item('a', '/repo', 1), store);
    q.clear();
    // No cancellation was reported: the row is still `queued` on disk, and the
    // next boot adopts it. Reporting one here would close out work nobody
    // decided to abandon.
    expect(store.dequeued).toEqual([]);
    expect(q.depth()).toBe(0);
    expect(q.tryAcquire('/repo', 'fresh').granted).toBe(true);
  });

  it('releases the tree when adopted work throws instead of reporting', () => {
    const q = makeQueue();
    const store = makeStore([
      { id: 'bad', key: '/repo', enqueuedAt: 1, run: () => Promise.reject(new Error('boom')) },
      item('next', '/repo', 2),
    ]);
    q.register(store);
    q.init();

    // The rejection is asynchronous, so the recovery is too.
    return Promise.resolve().then(() => {
      q.pump();
      expect(started).toEqual(['next']);
    });
  });
});
