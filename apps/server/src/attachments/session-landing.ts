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
 * PA-136/137/139: lands a coding-agent prompt's files in `<cwd>/.pocketagent/attachments/`
 * and returns the note lines its prompt carries. One function for every
 * caller that prompts a session — the WebSocket and MCP — so the two cannot
 * disagree about where a file goes or what the agent is told.
 *
 * PA-137 adds extracted-text sidecars for PDF, docx, xlsx and pptx; PA-139
 * extends that to `claude` sessions for Office documents (`docx`, `xlsx`,
 * `pptx`) while continuing to skip `pdf` for `claude`, because Claude Code's
 * own `Read` tool reads PDFs natively with layout, whereas an Office file
 * would otherwise require the agent to write its own Python to inspect it.
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
  const attachments = await enrichLandedAttachments(target, landed, {
    extract: true,
    ...(usesClaudeTranscripts(agent) ? { skipKinds: ['pdf'] } : {}),
    ...(logger ? { logger } : {}),
  });
  const notes: string[] = [];
  for (const file of attachments) {
    notes.push(attachedFileNote(file.path));
    if (file.extractedPath) {
      notes.push(
        extractedTextNote(file.extractedPath, {
          truncated: file.truncated === true,
          truncatedReason: file.truncatedReason,
          stoppedAt: file.stoppedAt,
        }),
      );
    }
    for (const extra of file.extractedFiles ?? []) {
      if (extra.path !== file.extractedPath) {
        notes.push(extractedTextNote(extra.path, false));
      }
    }
  }
  return { attachments, notes };
}
