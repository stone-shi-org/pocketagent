import crypto from 'node:crypto';
import type { QueuedRunSummary } from '@pocketagent/protocol';
import type { Db, SessionPromptQueueRow } from '../db/index.js';
import {
  deleteQueuedPrompt,
  insertQueuedPrompt,
  readQueuedPrompt,
  readQueuedPrompts,
} from '../db/index.js';
import { treeRootOf } from '../git/worktree-paths.js';
import type { QueueStore, QueuedItem, RunQueue } from '../runs/queue.js';
import type { SessionManager, StructuredLikeSession } from './manager.js';

/**
 * The third paragraph of PA-11: a human's own follow-up prompt waits too.
 *
 * A webhook delivery and a scheduled run are unattended, so making them wait
 * costs nobody anything. A message a person just typed is different, and this
 * is the riskiest part of the feature — so the rules here are deliberately
 * stricter than for a delivery:
 *
 * - **Never silent.** The client is told immediately (`prompt_queued`), and
 *   again when the prompt is finally sent or cancelled. A typed message that
 *   simply appears to vanish is the one outcome this must never produce.
 * - **Never lost.** The row outlives the process, so a restart re-queues it
 *   rather than eating it.
 * - **Always escapable.** `force` sends it anyway. The queue exists to stop two
 *   agents sharing a tree, but a human who knows the other run is harmless must
 *   be able to say so, and an override they can see beats one they cannot.
 *
 * A session's *own* mid-turn state is not what blocks it: a session that is
 * already working is handled by the agent itself (a second prompt queues inside
 * the SDK). What blocks a prompt here is a *different* session working in the
 * same tree.
 */

export interface PromptQueueOptions {
  db: Db;
  sessions: SessionManager;
  queue: RunQueue;
  logger?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
  now?: () => number;
}

/** How a queued prompt reports back to whoever is attached. */
export interface PromptQueueListener {
  onQueued(sessionId: string, promptId: string, position: number, treeRoot: string): void;
  onReleased(sessionId: string, promptId: string, reason: 'sent' | 'cancelled'): void;
}

export type SubmitOutcome =
  | { queued: false }
  | { queued: true; promptId: string; position: number; treeRoot: string };

export class PromptQueueService {
  private readonly db: Db;
  private readonly listeners = new Set<PromptQueueListener>();

  constructor(private readonly opts: PromptQueueOptions) {
    this.db = opts.db;
    opts.queue.register(this.store);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  subscribe(listener: PromptQueueListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private readonly store: QueueStore = {
    pending: (): QueuedItem[] =>
      readQueuedPrompts(this.db).map((row) => ({
        id: row.id,
        key: row.tree_root,
        enqueuedAt: row.created_at,
        run: () => this.deliver(row.id),
      })),
    onQueued: (item, position): void => {
      const row = readQueuedPrompt(this.db, item.id);
      if (row === null) return;
      for (const l of this.listeners) l.onQueued(row.session_id, row.id, position, row.tree_root);
    },
    onDequeued: (item, reason): void => {
      if (reason !== 'cancelled') return;
      const row = readQueuedPrompt(this.db, item.id);
      deleteQueuedPrompt(this.db, item.id);
      if (row === null) return;
      for (const l of this.listeners) l.onReleased(row.session_id, row.id, 'cancelled');
    },
  };

  /**
   * Send `text` into `session` now, or park it until the tree is free.
   *
   * Returns `{ queued: false }` when the caller should prompt as usual, so the
   * existing code path is untouched in the common case — this only ever adds a
   * branch, it never rewrites how a prompt is delivered.
   */
  submit(session: StructuredLikeSession, text: string): SubmitOutcome {
    const key = treeRootOf(session.spec.cwd);
    // Whoever holds the tree might be this very session — a second prompt into
    // a session already mid-turn is the agent's business, not ours, and making
    // it wait here would break interrupt-and-redirect for no benefit.
    if (!this.isBlockedByOther(key, session.id)) return { queued: false };

    const id = crypto.randomUUID();
    const createdAt = this.now();
    const row: SessionPromptQueueRow = {
      id,
      session_id: session.id,
      tree_root: key,
      text,
      created_at: createdAt,
    };
    // Persisted before the enqueue, so a row is never queued with nothing to
    // send — the same ordering `parkDelivery` uses.
    insertQueuedPrompt(this.db, row);
    const ok = this.opts.queue.enqueue(
      { id, key, enqueuedAt: createdAt, run: () => this.deliver(id) },
      this.store,
    );
    if (!ok) {
      // A full queue must not swallow a human's message. Send it rather than
      // drop it: the depth cap exists to bound a machine-generated burst, and a
      // person pressing send is not that.
      deleteQueuedPrompt(this.db, id);
      this.opts.logger?.warn(
        { sessionId: session.id, treeRoot: key },
        'prompt queue is full; sending the prompt immediately rather than dropping it',
      );
      return { queued: false };
    }
    return { queued: true, promptId: id, position: this.opts.queue.positionOf(id) ?? 1, treeRoot: key };
  }

  /**
   * Is some *other* session mid-turn in this tree?
   *
   * Not `RunQueue.holderOf`, which answers "is anything holding it" — and this
   * session's own turn is a holder. Excluding it is the whole point.
   */
  private isBlockedByOther(key: string, sessionId: string): boolean {
    for (const busy of this.opts.sessions.busyTreeRoots(sessionId)) {
      if (busy === key) return true;
    }
    // A tree granted to a run that has not started its turn yet reads as free
    // above, so ask the queue too. `grantedTo`, not `holderOf`: the latter
    // returns a directory path when a session holds the tree, and comparing
    // that to a session id would make every prompt look blocked — including by
    // its own session's turn.
    const granted = this.opts.queue.grantedTo(key);
    return granted !== null && granted !== sessionId;
  }

  /** Hand a queued prompt to its session. Never throws. */
  private async deliver(promptId: string): Promise<void> {
    const row = readQueuedPrompt(this.db, promptId);
    if (row === null) return;
    deleteQueuedPrompt(this.db, promptId);

    const release = (): void => this.opts.queue.release(row.tree_root, promptId);
    const session = this.opts.sessions.get(row.session_id);
    if (session === undefined || session.transport === 'terminal') {
      // The chat is gone, or is no longer a structured session. Nothing to
      // deliver into, and the tree must not stay claimed by it.
      this.opts.logger?.warn(
        { sessionId: row.session_id, promptId },
        'a queued prompt outlived its session',
      );
      for (const l of this.listeners) l.onReleased(row.session_id, promptId, 'cancelled');
      release();
      return;
    }

    const ok = (session as StructuredLikeSession).prompt(row.text);
    for (const l of this.listeners) {
      l.onReleased(row.session_id, promptId, ok ? 'sent' : 'cancelled');
    }
    // On success the session is now mid-turn, so `busyTreeRoots` holds the tree
    // from here and the grant is redundant; releasing it is what lets the *next*
    // waiter be considered as soon as this turn ends rather than never.
    release();
    return Promise.resolve();
  }

  /**
   * A human's decision about their own waiting prompt.
   *
   * `force` is the only thing anywhere that bypasses tree occupancy, and it is
   * deliberately only available here — where a person is present to own the
   * consequence. A webhook's "run next" merely reorders waiters.
   */
  resolve(promptId: string, action: 'cancel' | 'force'): boolean {
    const row = readQueuedPrompt(this.db, promptId);
    if (row === null) return false;
    if (action === 'cancel') return this.opts.queue.cancel(promptId);

    // Take it out of the queue first so the pump cannot also grant it, then
    // send it regardless of who holds the tree.
    this.opts.queue.forget(promptId);
    deleteQueuedPrompt(this.db, promptId);
    const session = this.opts.sessions.get(row.session_id);
    if (session === undefined || session.transport === 'terminal') {
      for (const l of this.listeners) l.onReleased(row.session_id, promptId, 'cancelled');
      return false;
    }
    const ok = (session as StructuredLikeSession).prompt(row.text);
    this.opts.logger?.info(
      { sessionId: row.session_id, promptId, treeRoot: row.tree_root },
      'a queued prompt was sent by explicit request while another agent held the working tree',
    );
    for (const l of this.listeners) {
      l.onReleased(row.session_id, promptId, ok ? 'sent' : 'cancelled');
    }
    return ok;
  }

  /** Everything waiting, keyed by working tree, for the project tree's "Queued" group. */
  queuedByTree(): Map<string, QueuedRunSummary[]> {
    const byTree = new Map<string, QueuedRunSummary[]>();
    for (const row of readQueuedPrompts(this.db)) {
      const position = this.opts.queue.positionOf(row.id);
      if (position === null) continue;
      const info = this.opts.sessions.find(row.session_id);
      const list = byTree.get(row.tree_root) ?? [];
      list.push({
        id: row.id,
        kind: 'prompt',
        title: info?.title ?? 'Your message',
        webhookId: null,
        webhookName: null,
        sessionId: row.session_id,
        agent: info?.agent ?? null,
        agentDisplayName: info?.agentDisplayName ?? 'Agent',
        position,
        queuedAt: row.created_at,
        skipPermissionsEnabled: info?.skipPermissionsEnabled ?? false,
        // A queued human prompt already names its own session via `sessionId`;
        // `resumesConversationId` is the webhook-only field for a `per-issue`
        // waiter that duplicates a chat already listed elsewhere.
        resumesConversationId: null,
      });
      byTree.set(row.tree_root, list);
    }
    for (const [, list] of byTree) list.sort((a, b) => a.position - b.position);
    return byTree;
  }

  /** Queued prompts for one session, so a reattaching client can show them. */
  forSession(sessionId: string): { promptId: string; position: number; treeRoot: string }[] {
    const out: { promptId: string; position: number; treeRoot: string }[] = [];
    for (const row of readQueuedPrompts(this.db)) {
      if (row.session_id !== sessionId) continue;
      const position = this.opts.queue.positionOf(row.id);
      if (position === null) continue;
      out.push({ promptId: row.id, position, treeRoot: row.tree_root });
    }
    return out;
  }
}
