import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent } from '@pocketagent/protocol';
import { piHistoryEvents } from '../sessions/normalize.js';

/**
 * Reading pi's own on-disk session transcripts.
 *
 * Confirmed live against the real, installed `@earendil-works/pi-coding-agent`
 * (its own `docs/session-format.md`, and cross-checked against several real
 * session files this machine already had): by default (no `--session-dir`
 * override) pi persists each session as append-only JSONL under
 * `~/.pi/agent/sessions/--<cwd, "/" -> "-">--/<timestamp>_<sessionId>.jsonl`
 * — one project-scoped directory per cwd, one file per session, named with
 * pi's own session id (the same id `PiSession.agentSessionId` and
 * `resumeAgentSessionId` carry, and the same one `get_state.sessionFile`
 * reports live).
 *
 * `PiSession.fetchHistory`'s own `get_messages` RPC backfill only helps a
 * session that is actively *being resumed* right now — it has a live process
 * to ask. A session that is merely being reopened for a look, with no
 * `EventBuffer` left (evicted after the idle grace window, or lost across a
 * server restart), has no process either — `routes/sessions.ts`'s `/history`
 * route falls back to this store the same way it already does for agy's own
 * disk mirror (`AgyTranscriptStore`).
 *
 * The directory-name encoding (`/` -> `-`) is lossy — a literal `-` inside a
 * path segment is indistinguishable from an encoded `/` — so this never
 * tries to invert it, the same discipline `ConversationStore` uses for
 * Claude's identical scheme. It only ever forward-encodes a cwd this server
 * already recorded for the session (the `sessions` table's own `cwd`
 * column), then double-checks the resulting file's own header before
 * trusting it.
 */

/** A pathological transcript should not be read into memory whole; matches AgyTranscriptStore's cap. */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

export interface PiTranscriptStoreOptions {
  /** Overridable for tests. Defaults to `~/.pi/agent/sessions`. */
  sessionsDir?: string;
}

export class PiTranscriptStore {
  private readonly sessionsDir: string;

  constructor(options: PiTranscriptStoreOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? path.join(os.homedir(), '.pi', 'agent', 'sessions');
  }

  /**
   * The messages of a pi session, as the events the UI already renders.
   * Mirrors `AgyTranscriptStore.history()`'s contract exactly: same default
   * cap, same "tail is what matters" trim, `[]` rather than a throw for
   * anything missing, malformed, or recorded under a different cwd than
   * expected.
   */
  async history(conversationId: string, cwd: string, maxEvents = 400): Promise<AgentEvent[]> {
    const dir = path.join(this.sessionsDir, encodePiProjectDir(cwd));
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      // No project directory for this cwd — nothing to show.
      return [];
    }

    const suffix = `_${conversationId}.jsonl`;
    const match = names.find((name) => name.endsWith(suffix));
    if (!match) return [];

    let text: string;
    try {
      const file = path.join(dir, match);
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_TRANSCRIPT_BYTES) return [];
      text = await fs.readFile(file, 'utf8');
    } catch {
      return [];
    }

    const lines = text.split('\n');
    // The first line is pi's own `SessionHeader` (`{type: 'session', id,
    // cwd, ...}`). Re-checking both fields here — not just the filename
    // match above — is the "verify inside" half of the encode-forward
    // discipline this module's doc comment describes.
    const header = parseJsonLine(lines[0]);
    if (!isRecord(header) || header.type !== 'session' || header.id !== conversationId || header.cwd !== cwd) {
      return [];
    }

    const messages: unknown[] = [];
    for (const line of lines.slice(1)) {
      const record = parseJsonLine(line);
      // Every other entry type (`model_change`, `thinking_level_change`, ...)
      // is session-level bookkeeping, not conversation content — `message`
      // entries wrap exactly the `AgentMessage` shape `piHistoryEvents`
      // already knows how to read from `get_messages`.
      if (isRecord(record) && record.type === 'message') messages.push(record.message);
    }

    const events = piHistoryEvents(messages);
    return events.length > maxEvents ? events.slice(-maxEvents) : events;
  }
}

/**
 * `/` -> `-`, wrapped in `--...--` — confirmed against several real,
 * installed sessions' own directory names (e.g. cwd
 * `/data/homes/stoneshi/src/gwsmcp` -> `--data-homes-stoneshi-src-gwsmcp--`).
 * Forward-only; see this module's own doc comment for why nothing here ever
 * tries to invert it.
 */
function encodePiProjectDir(cwd: string): string {
  return `--${cwd.replace(/^\//, '').replace(/\//g, '-')}--`;
}

function parseJsonLine(line: string | undefined): unknown {
  if (!line) return null;
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
