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

/** Empty (not an error) for a chat that has never had a message sent yet. */
export async function readTranscriptEvents(
  workspacePath: string,
  chatId: string,
): Promise<AgentEvent[]> {
  const file = transcriptPath(workspacePath, chatId);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AgentEvent);
}
