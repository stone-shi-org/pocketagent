import os from 'node:os';

/**
 * Directory the CLI usage probes are invoked from.
 *
 * `claude -p "/usage"` and `agy -p "/usage"` are ordinary CLI invocations, so
 * each poll leaves a real transcript behind in the agent's own history,
 * filed under the directory it ran in. This used to be
 * `config.workspaceRoots[0] ?? process.cwd()`, which filed 288 one-line
 * "/usage" transcripts a day — one per poll, forever — *inside a workspace*,
 * where `ConversationStore` then listed every one of them as a chat: a
 * phantom project named after the poll's cwd, full of chats titled "/usage".
 * The temp directory is outside every workspace root by construction, so
 * nothing a probe leaves behind is ever discovered as a conversation.
 *
 * The cwd is otherwise meaningless here: `/usage` reports rate limits from
 * local telemetry and never looks at the working tree. It is passed only
 * because `execFile` needs one, and inheriting the server's own cwd is what
 * made a *production* deploy under `/opt` quietly accumulate 6,703 of these.
 */
export function usageProbeCwd(): string {
  return os.tmpdir();
}
