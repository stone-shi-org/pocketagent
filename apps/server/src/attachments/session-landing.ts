import {
  attachedFileNote,
  extractedTextNote,
  usesClaudeTranscripts,
  type PromptAttachment,
} from '@pocketagent/protocol';
import { enrichLandedAttachments } from './extract.js';
import type { Db } from '../db/index.js';
import { landStagedAttachments, sessionLandingTarget, type AttachmentStaging, type StagedAttachment } from './index.js';
import { recordAttachmentRoot } from './retention.js';

/**
 * PA-136/137: lands a coding-agent prompt's files in `<cwd>/.pocketagent/attachments/`
 * and returns the note lines its prompt carries. One function for every
 * caller that prompts a session — the WebSocket and MCP — so the two cannot
 * disagree about where a file goes or what the agent is told.
 *
 * PA-137 adds the sidecar for every agent that is not Claude Code: a PDF,
 * docx, xlsx or pptx gets its text extracted beside it, and the note names
 * both paths. Claude Code is left out (the reporter's answer on the ticket)
 * because its own `Read` tool reads a PDF natively, with layout. codex,
 * opencode, pi and agy have no such tool, and an agent with only a shell is
 * one missing `pdftotext` from not reading the file at all.
 *
 * Throws what landing throws (and has then landed nothing); extraction never
 * throws — a failure is simply no sidecar.
 */
export async function landSessionAttachments(
  staging: AttachmentStaging,
  cwd: string,
  agent: string,
  staged: readonly StagedAttachment[],
  logger?: { info?: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void },
  /** PA-137: where the retention sweep learns this cwd holds attachments. */
  db?: Db,
): Promise<{ attachments: PromptAttachment[]; notes: string[] }> {
  if (staged.length === 0) return { attachments: [], notes: [] };
  const target = sessionLandingTarget(cwd);
  const landed = landStagedAttachments(staging, target, staged);
  if (db) recordAttachmentRoot(db, cwd);
  const attachments = usesClaudeTranscripts(agent)
    ? landed
    : await enrichLandedAttachments(target, landed, { extract: true, ...(logger ? { logger } : {}) });
  const notes: string[] = [];
  for (const file of attachments) {
    notes.push(attachedFileNote(file.path));
    if (file.extractedPath) notes.push(extractedTextNote(file.extractedPath, file.truncated === true));
  }
  return { attachments, notes };
}
