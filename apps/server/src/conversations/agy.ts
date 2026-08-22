import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent } from '@pocketagent/protocol';

/**
 * Reading agy's own on-disk conversation transcripts.
 *
 * Unlike Claude Code, agy's live `stream-json` process is fire-and-forget per
 * turn (see `AgySession`'s class doc comment) and PocketAgent's own in-memory
 * `EventBuffer` is the only place a live conversation's history lives — gone
 * the moment the session is evicted or the server restarts. `/history`
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

export interface AgyTranscriptStoreOptions {
  /** Overridable for tests. Defaults to `~/.gemini/antigravity-cli/brain`. */
  brainDir?: string;
}

export class AgyTranscriptStore {
  private readonly brainDir: string;

  constructor(options: AgyTranscriptStoreOptions = {}) {
    this.brainDir = options.brainDir ?? path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
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
