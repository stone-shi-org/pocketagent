import { treeRootOf } from '../git/worktree-paths.js';

/**
 * Serializes agent work that would otherwise share one working tree.
 *
 * Two agents editing one checkout at the same time corrupt each other — a
 * hazard `CronOverlapPolicy`'s own doc comment already recorded, and which the
 * webhook path could hit for real: a Jira component maps to a *fixed* branch
 * (`feature/<component>`), so two different issues in one component
 * deliberately resolve to the same worktree, and a webhook configured with
 * `worktreeMode: 'none'` runs every delivery straight in the project folder.
 *
 * This lives in `runs/` rather than inside `WebhookService` for the same reason
 * `RunExecutor` does: the directory does not belong to the webhook. A cron job,
 * the planner's `send_instruction` tool and a human typing in a chat all start
 * work in the same trees, so a queue owned by one trigger could not see the
 * others — and *observing* every session is the whole point. Producers register
 * a `QueueStore`; this file never touches a table, exactly as the executor
 * never does.
 *
 * Two rules make the rest of the design fall out:
 *
 * 1. **Occupancy is derived, never leased.** A tree is busy because some live
 *    session rooted in it is mid-turn, not because a row says so. A crash
 *    therefore cannot strand a lock: after a restart nothing is mid-turn, so
 *    every tree is free.
 * 2. **There is no timeout, anywhere.** A run parked on an unanswered approval
 *    is genuinely still working, so it keeps its tree and the queue keeps
 *    waiting. Cancelling is a human decision, which is why every queued item is
 *    visible in the project tree and individually cancellable.
 */

/** One unit of deferred work. Reconstructed from a row at boot, never a live closure. */
export interface QueuedItem {
  /** The producer's own id for this work (a delivery id, a prompt id). */
  id: string;
  /** The working tree this work will occupy, from `treeRootOf`. */
  key: string;
  /** FIFO order within a key. */
  enqueuedAt: number;
  /**
   * Start the work. Must never throw: a producer reports its own failures
   * through its own sink, and there is nobody to show an exception to.
   */
  run: () => Promise<void>;
}

/**
 * Where a producer records queue state.
 *
 * Mirrors `RunSink`: one implementation writes `webhook_deliveries`, another
 * writes `session_prompt_queue`, and this file knows about neither.
 */
export interface QueueStore {
  /**
   * Work persisted by a previous server, oldest first.
   *
   * A `run` closure cannot survive a restart, so the producer rebuilds it from
   * whatever it froze at enqueue time. Called once from `init()`.
   */
  pending(): QueuedItem[];
  /** `position` is 1-based and counts only items ahead of this one in its key. */
  onQueued(item: QueuedItem, position: number): void;
  onDequeued(item: QueuedItem, reason: DequeueReason): void;
}

export type DequeueReason = 'granted' | 'cancelled';

export interface RunQueueOptions {
  /**
   * Working trees occupied right now, because a session rooted in one is
   * mid-turn. Asked fresh on every decision — never cached, for the same
   * reason `SessionManager.setGlobalSkipPermissions` is read live.
   */
  busyTreeRoots: () => Iterable<string>;
  logger?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
  /** Queued items per working tree. Beyond this a producer must refuse the work. */
  maxPerKey?: number;
  /** Queued items across every key. */
  maxTotal?: number;
}

/**
 * A burst of legitimate deliveries — one Jira bulk edit — must not turn into an
 * unbounded backlog. These bound the queue itself; the session concurrency caps
 * are unchanged and still bound what actually runs.
 */
export const DEFAULT_MAX_QUEUED_PER_KEY = 20;
export const DEFAULT_MAX_QUEUED_TOTAL = 100;

export type AcquireOutcome =
  /** Nothing else holds this tree. The caller must start the work now. */
  | { granted: true }
  /** Someone else holds it. `position` is 1-based among the waiters. */
  | { granted: false; position: number; holder: string | null };

export class RunQueue {
  /** Waiters per working tree, oldest first. */
  private readonly waiting = new Map<string, QueuedItem[]>();
  /** Which store owns each queued item, so a dequeue reports to the right producer. */
  private readonly owner = new Map<string, QueueStore>();
  /**
   * Trees granted to work that has not settled yet.
   *
   * This covers the window `busyTreeRoots()` cannot see: between the grant and
   * the session's first prompt there is a worktree to create and a process to
   * spawn, during which nothing is mid-turn and the tree would read as free.
   * Keyed by tree, valued by the item id holding it.
   */
  private readonly granted = new Map<string, string>();
  private readonly stores = new Set<QueueStore>();
  private pumping = false;
  /**
   * A `release` that arrived while a pump was already running.
   *
   * Work can settle synchronously inside `pump` — a webhook deleted while it
   * waited fails immediately — and that release re-enters here, where the
   * `pumping` guard drops it. Without this flag the tree it freed would wait
   * for the next 30s sweep even though a waiter was ready to go.
   */
  private pumpAgain = false;

  constructor(private readonly opts: RunQueueOptions) {}

  private get maxPerKey(): number {
    return this.opts.maxPerKey ?? DEFAULT_MAX_QUEUED_PER_KEY;
  }

  private get maxTotal(): number {
    return this.opts.maxTotal ?? DEFAULT_MAX_QUEUED_TOTAL;
  }

  register(store: QueueStore): void {
    this.stores.add(store);
  }

  /**
   * Adopt work persisted by a previous server, then pump.
   *
   * Called after each producer has reconciled its own rows, for the same reason
   * `WebhookService.init` runs after `SessionManager.init`: this decides what to
   * start based on what is alive, so the liveness picture has to be true first.
   */
  init(): void {
    const adopted: QueuedItem[] = [];
    for (const store of this.stores) {
      for (const item of store.pending()) {
        this.owner.set(item.id, store);
        const list = this.waiting.get(item.key) ?? [];
        list.push(item);
        this.waiting.set(item.key, list);
        adopted.push(item);
      }
    }
    for (const [, list] of this.waiting) list.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    if (adopted.length > 0) {
      this.opts.logger?.info({ adopted: adopted.length }, 'adopted queued runs from a previous server');
    }
    this.pump();
  }

  /**
   * Claim `key` for immediate work, or report where the caller landed in line.
   *
   * **Synchronous from check to claim, and it must stay that way.** Node runs
   * one thing at a time, so nothing can interleave between reading occupancy
   * and recording the grant — but only while no `await` sits between them.
   * Inserting one would hand the same tree to two runs, which is the exact
   * failure this class exists to prevent.
   */
  tryAcquire(key: string, itemId: string): AcquireOutcome {
    const holder = this.holderOf(key);
    if (holder === null) {
      this.granted.set(key, itemId);
      return { granted: true };
    }
    return { granted: false, position: (this.waiting.get(key)?.length ?? 0) + 1, holder };
  }

  /**
   * Put work in line behind whatever holds its tree.
   *
   * Returns false when a depth cap is hit; the producer records that as its own
   * "did not run" outcome rather than the queue inventing one.
   */
  enqueue(item: QueuedItem, store: QueueStore): boolean {
    const list = this.waiting.get(item.key) ?? [];
    if (list.length >= this.maxPerKey || this.depth() >= this.maxTotal) return false;
    list.push(item);
    list.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    this.waiting.set(item.key, list);
    this.owner.set(item.id, store);
    store.onQueued(item, list.indexOf(item) + 1);
    return true;
  }

  /**
   * Hand occupancy of a tree over from the grant to the session now running in
   * it.
   *
   * The grant exists only to cover the window `busyTreeRoots()` cannot see:
   * between the claim and the session's first prompt there is a worktree to
   * create and a process to spawn, during which nothing is mid-turn and the
   * tree would read as free. Once a session exists, keeping the grant would
   * make occupancy *stated* rather than derived — and a stated lock strands:
   * a session killed without its producer noticing would hold the tree
   * forever, with nothing to release it.
   *
   * After this, the tree is busy exactly as long as the session is mid-turn,
   * which is the definition the whole design rests on.
   */
  started(key: string, itemId: string): void {
    if (this.granted.get(key) === itemId) this.granted.delete(key);
  }

  /**
   * Release a tree claimed by `tryAcquire` and start whoever is next.
   *
   * Called when the work settles. Idempotent, and it only clears the claim when
   * the caller is the one holding it — a late release from a run that already
   * settled must not evict the run that took its place.
   */
  release(key: string, itemId: string): void {
    if (this.granted.get(key) === itemId) this.granted.delete(key);
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pump();
  }

  /** Take work out of line without running it. */
  cancel(itemId: string): boolean {
    for (const [key, list] of this.waiting) {
      const idx = list.findIndex((i) => i.id === itemId);
      if (idx === -1) continue;
      const [item] = list.splice(idx, 1);
      if (list.length === 0) this.waiting.delete(key);
      if (item !== undefined) {
        this.owner.get(itemId)?.onDequeued(item, 'cancelled');
        this.owner.delete(itemId);
      }
      return true;
    }
    return false;
  }

  /**
   * Drop work from the queue without reporting it as cancelled.
   *
   * For the one caller that is taking the work over itself — a human forcing
   * their own queued prompt through. `cancel` would tell the producer to
   * discard it, which is the opposite of what is happening.
   */
  forget(itemId: string): boolean {
    for (const [key, list] of this.waiting) {
      const idx = list.findIndex((i) => i.id === itemId);
      if (idx === -1) continue;
      list.splice(idx, 1);
      if (list.length === 0) this.waiting.delete(key);
      this.owner.delete(itemId);
      return true;
    }
    return false;
  }

  /**
   * Move work to the front of its own line.
   *
   * Deliberately not "run it now": jumping the *tree* is the hazard this class
   * exists to prevent, so this only reorders waiters and still waits for the
   * directory to come free.
   */
  moveToFront(itemId: string): number | null {
    for (const [, list] of this.waiting) {
      const idx = list.findIndex((i) => i.id === itemId);
      if (idx === -1) continue;
      const [item] = list.splice(idx, 1);
      if (item === undefined) return null;
      // `enqueuedAt` is the sort key everywhere else, so reordering has to move
      // the stamp too or the next `enqueue`'s sort would undo this. Returned so
      // the producer can persist it: the in-memory queue does not survive a
      // restart, and a reorder that lived only here would silently revert.
      const head = list[0];
      item.enqueuedAt = head !== undefined ? head.enqueuedAt - 1 : item.enqueuedAt;
      list.unshift(item);
      return item.enqueuedAt;
    }
    return null;
  }

  /** Start whatever can start. Safe to call at any time, from anywhere. */
  pump(): void {
    // A `run()` that settles synchronously would re-enter through `release`,
    // and a nested pump could hand out the same tree twice. Such a release sets
    // `pumpAgain` instead, and the loop below runs again rather than leaving a
    // freed tree for the sweep to notice.
    if (this.pumping) return;
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        this.pumpOnce();
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  /** One pass over every key. At most one item per tree starts per pass. */
  private pumpOnce(): void {
    for (const [key, list] of [...this.waiting]) {
      if (list.length === 0) continue;
      if (this.holderOf(key) !== null) continue;
      const item = list[0];
      if (item === undefined) continue;
      list.shift();
      if (list.length === 0) this.waiting.delete(key);
      this.granted.set(key, item.id);
      const store = this.owner.get(item.id);
      this.owner.delete(item.id);
      store?.onDequeued(item, 'granted');
      void item.run().catch((err) => {
        // A producer reports its own failures; reaching here means one threw
        // anyway, and the tree must not stay claimed by it.
        this.opts.logger?.warn({ err, itemId: item.id }, 'queued run threw');
        this.release(key, item.id);
      });
    }
  }

  /**
   * Whether anything holds `key`, and a description of what.
   *
   * The returned string is **diagnostic only** — it is a working-tree path when
   * a mid-turn session holds the tree and an item id when an unstarted grant
   * does, so it must never be compared against an id. Ask `grantedTo` for that.
   *
   * `busyTreeRoots()` is asked fresh every time; a cached answer is how a
   * released tree stays blocked forever.
   */
  holderOf(key: string): string | null {
    for (const busy of this.opts.busyTreeRoots()) {
      if (treeRootOf(busy) === key) return busy;
    }
    const claimed = this.granted.get(key);
    return claimed !== undefined ? claimed : null;
  }

  /**
   * The item id holding an unstarted grant on `key`, if any.
   *
   * Separate from `holderOf` because the two answer different questions and
   * conflating them is a real bug: a caller asking "is something *other than
   * me* holding this" against `holderOf` compares a session id to a directory
   * path and concludes yes every time.
   */
  grantedTo(key: string): string | null {
    return this.granted.get(key) ?? null;
  }

  /** Waiters in one key, or across every key when omitted. */
  depth(key?: string): number {
    if (key !== undefined) return this.waiting.get(key)?.length ?? 0;
    let total = 0;
    for (const [, list] of this.waiting) total += list.length;
    return total;
  }

  /** 1-based place in line, or null when not queued. */
  positionOf(itemId: string): number | null {
    for (const [, list] of this.waiting) {
      const idx = list.findIndex((i) => i.id === itemId);
      if (idx !== -1) return idx + 1;
    }
    return null;
  }

  /**
   * Drop every waiter on shutdown, reporting each one.
   *
   * The rows stay `queued` on disk — `pending()` picks them up next boot. This
   * only clears memory, so nothing is lost and nothing is started twice.
   */
  clear(): void {
    this.waiting.clear();
    this.granted.clear();
    this.owner.clear();
  }
}
