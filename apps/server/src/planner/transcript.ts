import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentEvent } from '@pocketagent/protocol';

/**
 * A chat's transcript lives on disk inside its own workspace, not in the
 * database — the same "transcript is a file, the database only indexes it"
 * split `conversations/index.ts` already uses for Claude Code's own
 * transcripts. `.transcripts/` is hidden (dot-prefixed) so it does not read
 * as one of the planner's own "skills" files if the workspace is ever
 * browsed by a file tool.
 *
 * Stores the same `AgentEvent` union a structured session's own transcript
 * would (see `PlannerChatHistoryResponse`'s doc comment for why) — one JSON
 * object per line, appended as each event happens, so the file itself is the
 * append-only log a live turn streams from.
 */
function transcriptPath(workspacePath: string, chatId: string): string {
  return path.join(workspacePath, '.transcripts', `${chatId}.jsonl`);
}

export async function appendTranscriptEvent(
  workspacePath: string,
  chatId: string,
  event: AgentEvent,
): Promise<void> {
  const file = transcriptPath(workspacePath, chatId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
}

/**
 * Empty (not an error) for a chat that has never had a message sent yet.
 *
 * A line that is not valid JSON is skipped, not thrown (PA-121). Before, one
 * bad line — most plausibly a write cut short by a crash or a full disk,
 * after which the next append lands on the same line — made every later read
 * throw, so the chat could neither be opened nor sent another message, and
 * nothing short of deleting the file by hand recovered it. Losing one event
 * is the better failure. `onSkippedLine` lets a caller log it.
 */
export async function readTranscriptEvents(
  workspacePath: string,
  chatId: string,
  onSkippedLine?: (lineNumber: number) => void,
): Promise<AgentEvent[]> {
  const file = transcriptPath(workspacePath, chatId);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const events: AgentEvent[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && typeof (parsed as { kind?: unknown }).kind === 'string') {
        events.push(parsed as AgentEvent);
        continue;
      }
    } catch {
      /* reported below */
    }
    onSkippedLine?.(i + 1);
  }
  return events;
}

/** Removes the transcript file for a cleared or deleted chat. */
export async function clearTranscriptEvents(
  workspacePath: string,
  chatId: string,
): Promise<void> {
  const file = transcriptPath(workspacePath, chatId);
  try {
    await fs.unlink(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}
