import type { ChatReadKind } from '@pocketagent/protocol';
import { CHAT_READ_MARKS_EPOCH_KEY, readSetting, type Db } from '../db/index.js';

/**
 * PA-165: read marks for the chat status dot's "unread" state.
 *
 * A chat is unread when its last turn finished after the latest read mark —
 * or, with no mark at all, after read tracking was switched on
 * (`CHAT_READ_MARKS_EPOCH_KEY`), so an upgrade does not light up every chat
 * that finished a turn before the feature existed. The server stamps the mark
 * with its own clock: the comparison is between two server timestamps, so a
 * phone whose clock is off cannot make a finished turn read as already seen.
 */

/** Records that `id` was looked at now. */
export function markChatRead(db: Db, kind: ChatReadKind, id: string, at = Date.now()): void {
  db.prepare(
    `INSERT INTO chat_read_marks (kind, id, read_at) VALUES (?, ?, ?)
       ON CONFLICT(kind, id) DO UPDATE SET read_at = MAX(read_at, excluded.read_at)`,
  ).run(kind, id, at);
}

export function deleteChatReadMark(db: Db, kind: ChatReadKind, id: string): void {
  db.prepare('DELETE FROM chat_read_marks WHERE kind = ? AND id = ?').run(kind, id);
}

/**
 * Every mark of one kind, plus the fallback for a chat with none — one query
 * per list request rather than one per row.
 */
export function readChatReadMarks(db: Db, kind: ChatReadKind): ReadMarks {
  const rows = db.prepare('SELECT id, read_at FROM chat_read_marks WHERE kind = ?').all(kind) as {
    id: string;
    read_at: number;
  }[];
  const marks = new Map(rows.map((row) => [row.id, row.read_at]));
  const epoch = Number(readSetting(db, CHAT_READ_MARKS_EPOCH_KEY) ?? '0') || 0;
  return { readAt: (id: string) => marks.get(id) ?? epoch };
}

/** One chat's mark (or the epoch), for a caller decorating a single row. */
export function readChatReadAt(db: Db, kind: ChatReadKind, id: string): number {
  const row = db.prepare('SELECT read_at FROM chat_read_marks WHERE kind = ? AND id = ?').get(kind, id) as
    | { read_at: number }
    | undefined;
  return row?.read_at ?? (Number(readSetting(db, CHAT_READ_MARKS_EPOCH_KEY) ?? '0') || 0);
}

export interface ReadMarks {
  /** When `id` was last read, or the epoch if never. */
  readAt(id: string): number;
}

/** Strictly after: a mark stamped in the same millisecond the turn ended
    was stamped by someone watching it end. */
export function isUnread(lastTurnEndedAt: number | null | undefined, readAt: number): boolean {
  return lastTurnEndedAt != null && lastTurnEndedAt > readAt;
}
