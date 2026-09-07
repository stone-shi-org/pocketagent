import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentEvent, SessionInfo } from '@pocketagent/protocol';
import { isContained, type WorkspaceRegistry } from '../workspaces/index.js';
import type { SessionManager, StructuredLikeSession } from '../sessions/manager.js';
import { readSessionHistory, type SessionHistoryDeps } from '../sessions/history.js';
import { stripAnsi } from '../terminal/classifier.js';
import type { WorktreeService } from '../git/worktree.js';
import { WorktreeError } from '../git/worktree.js';
import { buildChildEnv } from '../sessions/env.js';
import type { PlannerWorkspaceRegistry } from './workspaces.js';
import type { PlannerMemoryService } from './memory.js';

/**
 * PA-6: the planner's tool catalog.
 *
 * Phase 3 added the read-only tools (`readOnly: true`), which skip the
 * approval gate entirely per the reporter's answer to open question 1 ("yes
 * please, let's skip gate for those read tools call"). Phase 4 added the
 * mutating ones — `send_instruction`, `write_file`, `mkdir`, `rmdir`,
 * `delete_worktree` — which `approval.ts` gates before `PlannerChatService`
 * ever calls `execute()` on them. Phase 5 adds `exec_command`, the highest-risk
 * tool here, gated exactly like the others per the reporter's answer to open
 * question 2 — no special-cased narrower "remember" scope for it.
 *
 * Each tool executes against the *existing* PocketAgent subsystems
 * (`WorkspaceRegistry`, `SessionManager`, `WorktreeService`) — per the plan,
 * the planner treats other sessions as sub-agents rather than owning a
 * parallel notion of "workspace" or "session" for them. File tools
 * additionally accept a planner workspace path, since the planner's own
 * scratch space is just as legitimate a target.
 */

export interface PlannerToolDeps {
  workspaces: WorkspaceRegistry;
  plannerWorkspaces: PlannerWorkspaceRegistry;
  sessions: SessionManager;
  worktrees: WorktreeService;
  historyDeps: SessionHistoryDeps;
  /** The configured shell binary, for `exec_command`. */
  shell: string;
  /** PA-29: the memory service, for `memory_save`/`memory_search`. */
  memory: PlannerMemoryService;
  /**
   * PA-29: the workspace the calling chat belongs to right now.
   *
   * Added as its own field rather than widening `execute`'s own arity
   * (`PlannerChatService.executeTool` is the one call site that builds this
   * object, and it already has `chat.workspaceId` in scope) — every
   * existing tool ignores it and keeps compiling unchanged. `null` for an
   * orphaned chat whose workspace was since deleted; the memory tools below
   * refuse in that case rather than guessing which agent's memory to touch,
   * the same refusal `send_instruction`/`delete_worktree` already give for
   * their own "can't resolve what this needs" cases.
   */
  workspaceId: string | null;
}

export interface PlannerToolDefinition {
  name: string;
  description: string;
  /** JSON Schema, sent to the LLM verbatim as the function's `parameters`. */
  parameters: Record<string, unknown>;
  readOnly: boolean;
  execute: (deps: PlannerToolDeps, args: Record<string, unknown>) => Promise<string>;
}

/** Caps how much of a tool's result is fed back to the LLM — a runaway
    transcript or a large file must not blow out the next request's body. */
const MAX_TOOL_RESULT_CHARS = 20_000;
const MAX_FILE_READ_BYTES = 200_000;
const MAX_FILE_WRITE_CHARS = 200_000;
/** A chat turn is a synchronous HTTP request/response — a runaway command
    must not hang it forever. */
const EXEC_TIMEOUT_MS = 60_000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncated, ${text.length - max} more characters)`;
}

/** Exported for direct unit testing — see `tests/planner-tools.test.ts`. */
export function summarizeEvents(events: readonly AgentEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    switch (event.kind) {
      case 'user_prompt':
        lines.push(`[user] ${event.text}`);
        break;
      case 'text':
        lines.push(`[assistant] ${event.text}`);
        break;
      case 'tool_use':
        lines.push(`[tool call] ${event.summary}`);
        break;
      case 'tool_result':
        if (event.content.trim().length > 0) {
          lines.push(`[tool result${event.isError ? ' (error)' : ''}] ${event.content}`);
        }
        break;
      case 'notice':
        lines.push(`[${event.level}] ${event.text}`);
        break;
      default:
        // Every other kind (deltas, lifecycle/meta events) carries nothing a
        // one-shot summary needs — see this file's doc comment.
        break;
    }
  }
  return lines.length > 0 ? lines.join('\n') : '(no transcript content yet)';
}

function isWithinTrustedRoot(deps: PlannerToolDeps, real: string): boolean {
  return deps.workspaces.getRoots().some((root) => isContained(root, real)) || deps.plannerWorkspaces.contains(real);
}

/**
 * Resolves a path that must already exist against either boundary this
 * server already trusts: an added project workspace (`WorkspaceRegistry`) or
 * a planner workspace (`PlannerWorkspaceRegistry`). Realpath first, then
 * check containment with the shared `isContained` primitive — never a
 * string-prefix check, and deliberately **not**
 * `WorkspaceRegistry.resolveWorkspacePath`, which requires its target to be a
 * *directory* (it exists to validate a session's cwd); a file needs the same
 * containment check applied to something `resolveWorkspacePath` would itself
 * reject.
 */
async function resolveExistingPathWithin(deps: PlannerToolDeps, requested: string): Promise<string> {
  const absolute = path.resolve(requested);
  let real: string;
  try {
    real = await fs.realpath(absolute);
  } catch {
    throw new Error(`Cannot resolve path: ${requested}`);
  }
  if (!isWithinTrustedRoot(deps, real)) {
    throw new Error(`${requested} is outside every project workspace and every planner workspace.`);
  }
  return real;
}

/**
 * Resolves a path that may not exist yet (for a file/directory about to be
 * created), by walking up to the nearest ancestor that *does* exist,
 * containment-checking that ancestor's realpath, and rebuilding the full
 * target from it. The rebuilt suffix cannot itself be a symlink — none of it
 * exists yet — so checking only the existing ancestor is sound, the same
 * reasoning `WorktreeService.create()` relies on for a freshly-minted
 * worktree path.
 */
async function resolveCreatablePath(deps: PlannerToolDeps, requested: string): Promise<string> {
  const absolute = path.resolve(requested);
  let probe = absolute;
  let real: string | null = null;
  while (real === null) {
    try {
      real = await fs.realpath(probe);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) throw new Error(`Cannot resolve any existing ancestor of ${requested}.`);
      probe = parent;
    }
  }
  if (!isWithinTrustedRoot(deps, real)) {
    throw new Error(`${requested} is outside every project workspace and every planner workspace.`);
  }
  const suffix = path.relative(probe, absolute);
  return suffix ? path.join(real, suffix) : real;
}

export const PLANNER_TOOLS: readonly PlannerToolDefinition[] = [
  // ---- Read-only (PA-6 phase 3) ---------------------------------------------
  {
    name: 'list_workspaces',
    description: "List the project folders (workspaces) PocketAgent's coding agents can run in.",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
    async execute(deps) {
      const entries = await deps.workspaces.list();
      return JSON.stringify(
        entries.map((e) => ({ path: e.path, name: e.name, isGitRepo: e.isGitRepo })),
      );
    },
  },
  {
    name: 'list_sessions',
    description:
      'List PocketAgent coding-agent sessions (running or finished), each a potential sub-agent to inspect or instruct.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of sessions to return (default 50).' },
      },
      additionalProperties: false,
    },
    readOnly: true,
    async execute(deps, args) {
      const limit = typeof args.limit === 'number' ? args.limit : 50;
      const list: SessionInfo[] = deps.sessions.list(limit);
      return JSON.stringify(
        list.map((s) => ({
          id: s.id,
          title: s.title,
          agent: s.agent,
          status: s.status,
          cwd: s.cwd,
          transport: s.transport,
          lastActivityAt: s.lastActivityAt,
        })),
      );
    },
  },
  {
    name: 'read_session_output',
    description: "Read a session's transcript so far, to judge what its agent has done.",
    parameters: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: 'A session id from list_sessions.' } },
      required: ['sessionId'],
      additionalProperties: false,
    },
    readOnly: true,
    async execute(deps, args) {
      const sessionId = String(args.sessionId ?? '');
      if (!deps.sessions.find(sessionId)) return `No session found with id ${sessionId}.`;
      const live = deps.sessions.get(sessionId);
      if (live) {
        if (live.transport === 'terminal') {
          const raw = live.buffer.replayAfter(0).data;
          const text = stripAnsi(raw).trim();
          if (text.length === 0) return '(no terminal output yet)';
          return truncate(text, MAX_TOOL_RESULT_CHARS);
        }
        const buffered = live.buffer.replayAfter(0).events.map((e) => e.event);
        const { events: priorEvents } = await readSessionHistory(deps.historyDeps, sessionId);
        const allEvents = [...priorEvents, ...buffered];
        if (allEvents.length === 0) {
          return 'This session has no readable transcript yet (it has not resumed or produced a conversation).';
        }
        return truncate(summarizeEvents(allEvents), MAX_TOOL_RESULT_CHARS);
      }
      const { conversationId, events } = await readSessionHistory(deps.historyDeps, sessionId);
      if (!conversationId || events.length === 0) {
        return 'This session has no readable transcript yet (it has not resumed or produced a conversation).';
      }
      return truncate(summarizeEvents(events), MAX_TOOL_RESULT_CHARS);
    },
  },
  {
    name: 'read_file',
    description:
      'Read a text file. The path must be inside an added project workspace or a planner workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    readOnly: true,
    async execute(deps, args) {
      const requested = String(args.path ?? '');
      const real = await resolveExistingPathWithin(deps, requested);
      const stat = await fs.stat(real);
      if (!stat.isFile()) return `${requested} is not a file.`;
      if (stat.size > MAX_FILE_READ_BYTES) {
        return `${requested} is ${stat.size} bytes, over this tool's ${MAX_FILE_READ_BYTES}-byte limit.`;
      }
      const content = await fs.readFile(real, 'utf8');
      return truncate(content, MAX_TOOL_RESULT_CHARS);
    },
  },
  {
    name: 'memory_search',
    description:
      "Search this agent's saved memories (short- and long-term) by relevance to a query, so past " +
      'facts, decisions, or preferences can be recalled instead of asked for again.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for.' },
        limit: { type: 'number', description: 'Maximum number of results to return (default 5).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    readOnly: true,
    async execute(deps, args) {
      if (deps.workspaceId === null) {
        return 'This chat has no agent to search memories for (its workspace was removed).';
      }
      const query = String(args.query ?? '').trim();
      if (!query) return 'No search query provided.';
      const limit = typeof args.limit === 'number' ? args.limit : 5;
      const results = await deps.memory.search(deps.workspaceId, query, { limit });
      return truncate(
        JSON.stringify(
          results.map((r) => ({
            id: r.memory.id,
            content: r.memory.content,
            importance: r.memory.importance,
            tier: r.memory.tier,
            createdAt: r.memory.createdAt,
            score: r.score,
          })),
        ),
        MAX_TOOL_RESULT_CHARS,
      );
    },
  },

  // ---- Mutating (PA-6 phase 4) — each goes through the approval gate --------
  {
    name: 'send_instruction',
    description:
      'Send an instruction (prompt) to an existing PocketAgent session, treating it as a sub-agent. ' +
      'If the session is not currently running, resumes its conversation into a new session first.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'A session id from list_sessions.' },
        prompt: { type: 'string', description: 'The instruction to send.' },
      },
      required: ['sessionId', 'prompt'],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(deps, args) {
      const sessionId = String(args.sessionId ?? '');
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) return 'No instruction text provided.';

      const info = deps.sessions.find(sessionId);
      if (!info) return `No session found with id ${sessionId}.`;
      if (info.transport !== 'structured') {
        return `Session ${sessionId} is a terminal session; the planner can only instruct structured sessions.`;
      }

      if (info.status === 'running' || info.status === 'starting') {
        const live = deps.sessions.get(sessionId);
        if (!live || !('prompt' in live)) {
          return `Session ${sessionId} cannot receive prompts right now.`;
        }
        const sent = (live as StructuredLikeSession).prompt(prompt);
        return sent
          ? `Instruction sent to running session ${sessionId}.`
          : `Session ${sessionId} ended before the instruction could be sent.`;
      }

      // Not live: resume into a fresh session. Re-validate `cwd` at call
      // time rather than trusting the value cached on the old session row —
      // the same discipline `RunExecutor.run()` applies before every
      // unattended session start, for the same reason: a folder can be
      // removed from the workspace list, or deleted, long after that row
      // was written.
      if (!info.agentSessionId) return `Session ${sessionId} has no conversation to resume.`;
      let cwd: string;
      try {
        cwd = await deps.workspaces.resolveWorkspacePath(info.cwd);
      } catch (err) {
        return `Cannot resume session ${sessionId}: ${(err as Error).message}`;
      }
      try {
        const resumed = await deps.sessions.create({
          agent: info.agent,
          cwd,
          cols: 0,
          rows: 0,
          transport: 'structured',
          resumeAgentSessionId: info.agentSessionId,
          forkSession: false,
        });
        if (resumed.transport !== 'structured') {
          return `Resuming session ${sessionId} unexpectedly produced a terminal session.`;
        }
        const sent = (resumed as StructuredLikeSession).prompt(prompt);
        return sent
          ? `Resumed session ${sessionId} as ${resumed.id} and sent the instruction.`
          : `Resumed session ${sessionId} as ${resumed.id}, but it ended before the instruction could be sent.`;
      } catch (err) {
        return `Could not resume session ${sessionId}: ${(err as Error).message}`;
      }
    },
  },
  {
    name: 'write_file',
    description:
      'Write (create or overwrite) a text file. The parent directory must already exist, inside an ' +
      'added project workspace or a planner workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(deps, args) {
      const requested = String(args.path ?? '');
      const content = String(args.content ?? '');
      if (content.length > MAX_FILE_WRITE_CHARS) {
        return `Refusing: ${content.length} characters is over this tool's ${MAX_FILE_WRITE_CHARS}-character limit.`;
      }
      const absolute = path.resolve(requested);
      const parent = path.dirname(absolute);
      let realParent: string;
      try {
        realParent = await fs.realpath(parent);
      } catch {
        return `${requested}'s parent directory does not exist. Create it first with mkdir.`;
      }
      if (!isWithinTrustedRoot(deps, realParent)) {
        return `${requested} is outside every project workspace and every planner workspace.`;
      }
      const target = path.join(realParent, path.basename(absolute));
      try {
        const existing = await fs.stat(target).catch(() => null);
        if (existing?.isDirectory()) return `${requested} is a directory, not a file.`;
        await fs.writeFile(target, content, 'utf8');
        return `Wrote ${content.length} characters to ${requested}.`;
      } catch (err) {
        return `Could not write ${requested}: ${(err as Error).message}`;
      }
    },
  },
  {
    name: 'memory_save',
    description:
      "Save a fact, decision, or preference to this agent's long-lived memory, so it survives past " +
      'this conversation. Mutating (it changes what future turns recall), so it goes through the same ' +
      'approval gate as any other write.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The memory to save, in a few sentences.' },
        importance: {
          type: 'number',
          description: 'How important this is to remember, 1 (trivial) to 5 (critical). Default 3.',
        },
      },
      required: ['content'],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(deps, args) {
      if (deps.workspaceId === null) {
        return 'This chat has no agent to save a memory for (its workspace was removed).';
      }
      const content = String(args.content ?? '').trim();
      if (!content) return 'No memory content provided.';
      const rawImportance = typeof args.importance === 'number' ? Math.round(args.importance) : 3;
      const importance = Math.min(5, Math.max(1, rawImportance));
      const memory = await deps.memory.save(deps.workspaceId, content, importance, null);
      return `Saved memory ${memory.id} (importance ${memory.importance}).`;
    },
  },
  {
    name: 'mkdir',
    description: 'Create a directory (and any missing parent directories), inside a project or planner workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(deps, args) {
      const requested = String(args.path ?? '');
      let target: string;
      try {
        target = await resolveCreatablePath(deps, requested);
      } catch (err) {
        return (err as Error).message;
      }
      try {
        await fs.mkdir(target, { recursive: true });
        return `Created ${requested}.`;
      } catch (err) {
        return `Could not create ${requested}: ${(err as Error).message}`;
      }
    },
  },
  {
    name: 'rmdir',
    description:
      'Remove a directory inside a project or planner workspace. Refuses a non-empty directory unless ' +
      '`recursive` is true.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean', description: 'Remove the directory and everything inside it.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(deps, args) {
      const requested = String(args.path ?? '');
      const recursive = args.recursive === true;
      let real: string;
      try {
        real = await resolveExistingPathWithin(deps, requested);
      } catch (err) {
        return (err as Error).message;
      }
      const stat = await fs.stat(real);
      if (!stat.isDirectory()) return `${requested} is not a directory.`;
      try {
        if (recursive) {
          await fs.rm(real, { recursive: true, force: false });
        } else {
          await fs.rmdir(real);
        }
        return `Removed ${requested}.`;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOTEMPTY') {
          return `${requested} is not empty. Pass recursive: true to remove it and everything inside.`;
        }
        return `Could not remove ${requested}: ${(err as Error).message}`;
      }
    },
  },
  {
    name: 'delete_worktree',
    description:
      'Delete a git worktree and its local branch. Refuses if a session is still running in it, if it ' +
      'has uncommitted changes, or if the branch is unmerged.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path to the worktree directory.' } },
      required: ['path'],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(deps, args) {
      const requested = String(args.path ?? '');
      let worktreeCwd: string;
      try {
        worktreeCwd = await deps.workspaces.resolveWorkspacePath(requested);
      } catch (err) {
        return `Cannot resolve ${requested}: ${(err as Error).message}`;
      }
      if (deps.sessions.hasAliveSessionIn(worktreeCwd)) {
        return `Refusing: a session is still running in ${requested}. Stop it first.`;
      }
      try {
        const result = await deps.worktrees.remove({ worktreeCwd });
        return `Removed worktree ${requested} and branch ${result.branch}.`;
      } catch (err) {
        if (err instanceof WorktreeError) return `Could not remove worktree: ${err.message}`;
        throw err;
      }
    },
  },
  {
    name: 'exec_command',
    description:
      'Run a shell command inside a project or planner workspace. Output is captured and size-capped, ' +
      `and the command is killed after ${EXEC_TIMEOUT_MS / 1000}s if it has not finished.`,
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Directory to run the command in.' },
        command: { type: 'string', description: 'The shell command line to run.' },
      },
      required: ['cwd', 'command'],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(deps, args) {
      const requestedCwd = String(args.cwd ?? '');
      const command = String(args.command ?? '').trim();
      if (!command) return 'No command provided.';

      let cwd: string;
      try {
        cwd = await resolveExistingPathWithin(deps, requestedCwd);
      } catch (err) {
        return (err as Error).message;
      }
      const stat = await fs.stat(cwd);
      if (!stat.isDirectory()) return `${requestedCwd} is not a directory.`;

      return runShellCommand(deps.shell, command, cwd);
    },
  },
];

/**
 * Runs one command through the configured shell, with the same env-stripping
 * every other child process this server spawns already gets
 * (`sessions/env.ts` — `POCKETAGENT_*` must never reach a spawned process,
 * including one started by the planner). No PTY: this is one-shot output
 * capture, not an interactive terminal.
 */
function runShellCommand(shell: string, command: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(shell, ['-lc', command], { cwd, env: buildChildEnv({ cwd }) });
    } catch (err) {
      resolve(`Could not start the shell: ${(err as Error).message}`);
      return;
    }

    let output = '';
    let truncated = false;
    const onChunk = (chunk: Buffer): void => {
      if (output.length >= MAX_TOOL_RESULT_CHARS) {
        truncated = true;
        return;
      }
      output += chunk.toString('utf8');
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, EXEC_TIMEOUT_MS);
    let timedOut = false;

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(`Could not run command: ${err.message}`);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const status = timedOut
        ? `timed out after ${EXEC_TIMEOUT_MS / 1000}s and was killed`
        : signal
          ? `killed by ${signal}`
          : `exit code ${code}`;
      const body = truncate(output, MAX_TOOL_RESULT_CHARS) + (truncated ? '\n…(output truncated)' : '');
      resolve(`$ ${command}\n(${status})\n${body}`);
    });
  });
}

export function findPlannerTool(name: string): PlannerToolDefinition | undefined {
  return PLANNER_TOOLS.find((t) => t.name === name);
}

/** The JSON-schema-as-function shape an OpenAI-compatible `tools` param expects. */
export function toOpenAiToolSpecs(tools: readonly PlannerToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
