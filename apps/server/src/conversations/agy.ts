import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AgentEvent } from '@pocketagent/protocol';

/**
 * Reading agy's own on-disk conversation transcripts.
 *
 * Unlike Claude Code, agy streams a live conversation and keeps no transcript
 * PocketAgent can read back mid-session (see `AgySession`'s class doc
 * comment), so PocketAgent's own in-memory `EventBuffer` is the only place a
 * live conversation's history lives — gone the moment the session is evicted
 * or the server restarts. `/history`
 * (`routes/sessions.ts`) fell back to `ConversationStore`, which only ever
 * finds Claude's `.jsonl` transcripts, so a finished agy chat always looked
 * empty when reopened. Confirmed live (v1.1.18) that agy keeps its own
 * mirror: `~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated
 * /logs/transcript.jsonl`, one NDJSON record per step, keyed directly by the
 * conversation id — no cwd-encoding ambiguity to resolve, unlike Claude's
 * directory-name scheme.
 *
 * `transcript_full.jsonl` sits next to it and is deliberately not used here:
 * it is the uncompacted log agy itself references for long-context recall
 * (a `CHECKPOINT` record points models at it — see
 * `agyTranscriptRecordToEvent`'s doc comment), where `transcript.jsonl` is
 * the one that matches what the conversation actually looked like to the
 * user, checkpoints and all.
 */

/** A pathological transcript should not be read into memory whole; none seen live has exceeded a few MB. */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
/** Annotation files are one-line `.pbtxt` records (~50-200 bytes). */
const MAX_ANNOTATION_BYTES = 64 * 1024;

export interface AgyTranscriptStoreOptions {
  /** Overridable for tests. Defaults to `~/.gemini/antigravity-cli/brain`. */
  brainDir?: string;
  /** Overridable for tests. Defaults to `<parent of brainDir>/annotations` (`~/.gemini/antigravity-cli/annotations`). */
  annotationsDir?: string;
  /** Overridable for tests. Defaults to `<parent of brainDir>/conversation_summaries.db` (`~/.gemini/antigravity-cli/conversation_summaries.db`). */
  summariesDbPath?: string;
}

export class AgyTranscriptStore {
  private readonly brainDir: string;
  private readonly annotationsDir: string;
  private readonly summariesDbPath: string;

  constructor(options: AgyTranscriptStoreOptions = {}) {
    const defaultRoot = path.join(os.homedir(), '.gemini', 'antigravity-cli');
    this.brainDir = options.brainDir ?? path.join(defaultRoot, 'brain');
    const rootDir = options.brainDir ? path.dirname(this.brainDir) : defaultRoot;
    this.annotationsDir = options.annotationsDir ?? path.join(rootDir, 'annotations');
    this.summariesDbPath = options.summariesDbPath ?? path.join(rootDir, 'conversation_summaries.db');
  }

  /**
   * Look up agy's own AI-generated title for a conversation (PA-163).
   *
   * Primary source is `annotations/<conversation-id>.pbtxt` (a single-line
   * protobuf text record such as `title:"LLM Java Coding Benchmark Implementation"`),
   * which requires no SQLite access. When the annotation file is missing or
   * carries no `title`, falls back to `conversation_summaries.db` opened
   * read-only (`readonly: true, fileMustExist: true`) because agy writes to it
   * while running. Returns `null` on any error and never throws.
   */
  async titleFor(conversationId: string): Promise<string | null> {
    if (!conversationId || conversationId.includes('/') || conversationId.includes('\\') || conversationId === '..') {
      return null;
    }

    const fromAnnotation = await this.readTitleFromAnnotation(conversationId);
    if (fromAnnotation) return fromAnnotation;

    return this.readTitleFromSummariesDb(conversationId);
  }

  private async readTitleFromAnnotation(conversationId: string): Promise<string | null> {
    const file = path.join(this.annotationsDir, `${conversationId}.pbtxt`);
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ANNOTATION_BYTES) return null;
      const raw = await fs.readFile(file, 'utf8');
      return parsePbtxtTitle(raw);
    } catch {
      return null;
    }
  }

  private readTitleFromSummariesDb(conversationId: string): string | null {
    let db: Database.Database | null = null;
    try {
      db = new Database(this.summariesDbPath, { readonly: true, fileMustExist: true });
      const row = db
        .prepare('SELECT title FROM conversation_summaries WHERE conversation_id = ?')
        .get(conversationId) as { title?: unknown } | undefined;
      if (!row || typeof row.title !== 'string') return null;
      const trimmed = row.title.trim();
      return trimmed || null;
    } catch {
      return null;
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close errors on corrupt/locked db.
      }
    }
  }

  /**
   * The messages of an agy conversation, as the events the UI already
   * renders. Mirrors `ConversationStore.history()`'s contract exactly (same
   * default cap, same "tail is what matters" trim, `[]` rather than a throw
   * for anything missing or malformed) so `routes/sessions.ts` can pick
   * between the two purely on which agent a session belongs to.
   */
  async history(conversationId: string, maxEvents = 400): Promise<AgentEvent[]> {
    const file = path.join(this.brainDir, conversationId, '.system_generated', 'logs', 'transcript.jsonl');

    let text: string;
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_TRANSCRIPT_BYTES) return [];
      text = await fs.readFile(file, 'utf8');
    } catch {
      // No local mirror for this conversation id — nothing to show.
      return [];
    }

    const events: AgentEvent[] = [];
    let index = 0;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      let record: unknown;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue; // Never let one malformed line take down the whole read.
      }
      const event = agyTranscriptRecordToEvent(record, conversationId, index++);
      if (event) events.push(event);
    }

    return events.length > maxEvents ? events.slice(-maxEvents) : events;
  }
}

/**
 * `<USER_REQUEST>...</USER_REQUEST>` is agy's own wrapper around what the
 * user actually typed — confirmed live across dozens of real transcripts,
 * always present verbatim on a `USER_INPUT` record, followed by whichever of
 * `<ADDITIONAL_METADATA>`/`<USER_SETTINGS_CHANGE>` happened to apply that
 * turn. Capturing just the inner text is what makes history read like the
 * chat it was, instead of the prompt-engineering scaffolding around it.
 */
const USER_REQUEST_RE = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/;

/**
 * One transcript line to zero or one event — never more, since (unlike
 * Claude's transcript, which mirrors the live SDK message shape closely
 * enough to reuse `normalizeSdkMessage`) agy's disk format has no equivalent
 * to replay tool calls step by step; this is a readable "what was said",
 * not a full re-render of a turn's work.
 *
 * A `PLANNER_RESPONSE` record can carry the model's `content` *and* pending
 * `tool_calls` in the same line, both mid-turn — confirmed live via a
 * `CHECKPOINT` record (agy's own context-compaction marker) sitting right
 * next to a `USER_INPUT`, and a mid-turn `PLANNER_RESPONSE` that had a
 * `tool_calls` array with essentially no `content` of its own. Only a
 * `PLANNER_RESPONSE` with no `tool_calls` left — the turn's genuine final
 * answer — is shown, the same one thing `AgySession.runTurn` keeps from a
 * *live* turn (`result.response`, per its own doc comment) once it ends;
 * everything in between is the same "the agent is working" narration the
 * live UI does not keep around after the fact either. `GENERIC` records
 * (tool output) and `SYSTEM`-sourced records (`CHECKPOINT`, `SYSTEM_MESSAGE`)
 * are deliberately dropped for the same reason.
 */
export function agyTranscriptRecordToEvent(
  record: unknown,
  conversationId: string,
  index: number,
): AgentEvent | null {
  if (typeof record !== 'object' || record === null) return null;
  const r = record as Record<string, unknown>;
  const type = typeof r.type === 'string' ? r.type : '';
  const content = typeof r.content === 'string' ? r.content : '';
  const id = `hist_agy_${conversationId}_${index}`;

  if (type === 'USER_INPUT') {
    const match = USER_REQUEST_RE.exec(content);
    const text = (match?.[1] ?? content).trim();
    return text ? { kind: 'user_prompt', id, text } : null;
  }

  if (type === 'PLANNER_RESPONSE') {
    if (Array.isArray(r.tool_calls) && r.tool_calls.length > 0) return null;
    const text = content.trim();
    return text ? { kind: 'text', id, text } : null;
  }

  return null;
}

const PBTXT_TITLE_RE = /(?:^|[\s;])title\s*:\s*"((?:[^"\\]|\\.)*)"/;

/**
 * Parse the `title` field from a protobuf text-format `.pbtxt` annotation
 * file, unescaping standard C/textproto escapes (`\"`, `\\`, `\n`, `\r`, `\t`,
 * octal `\000`–`\377` and hex `\xHH` UTF-8 byte sequences, and `\uXXXX` /
 * `\UXXXXXXXX` Unicode escapes).
 */
export function parsePbtxtTitle(raw: string): string | null {
  const match = PBTXT_TITLE_RE.exec(raw);
  if (!match) return null;
  const body = match[1]!;
  const bytes: number[] = [];

  let i = 0;
  while (i < body.length) {
    const nextSlash = body.indexOf('\\', i);
    if (nextSlash === -1) {
      bytes.push(...Buffer.from(body.slice(i), 'utf8'));
      break;
    }
    if (nextSlash > i) {
      bytes.push(...Buffer.from(body.slice(i, nextSlash), 'utf8'));
    }
    i = nextSlash + 1;
    if (i >= body.length) {
      bytes.push(0x5c);
      break;
    }
    const ch = body[i]!;
    if (ch >= '0' && ch <= '7') {
      let oct = ch;
      while (oct.length < 3 && i + oct.length < body.length) {
        const d = body[i + oct.length]!;
        if (d < '0' || d > '7') break;
        oct += d;
      }
      bytes.push(parseInt(oct, 8) & 0xff);
      i += oct.length;
      continue;
    }
    if (ch === 'x' || ch === 'X') {
      const hex = /^[0-9a-fA-F]{1,2}/.exec(body.slice(i + 1))?.[0];
      if (hex) {
        bytes.push(parseInt(hex, 16) & 0xff);
        i += 1 + hex.length;
        continue;
      }
    }
    if (ch === 'u') {
      const hex = /^[0-9a-fA-F]{4}/.exec(body.slice(i + 1))?.[0];
      if (hex) {
        bytes.push(...Buffer.from(String.fromCodePoint(parseInt(hex, 16)), 'utf8'));
        i += 5;
        continue;
      }
    }
    if (ch === 'U') {
      const hex = /^[0-9a-fA-F]{8}/.exec(body.slice(i + 1))?.[0];
      if (hex) {
        const cp = parseInt(hex, 16);
        if (cp <= 0x10ffff) {
          bytes.push(...Buffer.from(String.fromCodePoint(cp), 'utf8'));
          i += 9;
          continue;
        }
      }
    }
    switch (ch) {
      case 'n':
        bytes.push(0x0a);
        break;
      case 'r':
        bytes.push(0x0d);
        break;
      case 't':
        bytes.push(0x09);
        break;
      case 'b':
        bytes.push(0x08);
        break;
      case 'f':
        bytes.push(0x0c);
        break;
      case 'v':
        bytes.push(0x0b);
        break;
      case 'a':
        bytes.push(0x07);
        break;
      case '\\':
        bytes.push(0x5c);
        break;
      case '"':
        bytes.push(0x22);
        break;
      case "'":
        bytes.push(0x27);
        break;
      case '?':
        bytes.push(0x3f);
        break;
      default:
        bytes.push(...Buffer.from(ch, 'utf8'));
        break;
    }
    i += 1;
  }

  const decoded = Buffer.from(bytes).toString('utf8').trim();
  return decoded || null;
}
