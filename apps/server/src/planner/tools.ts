import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentEvent, SessionInfo } from '@pocketagent/protocol';
import { isContained, type WorkspaceRegistry } from '../workspaces/index.js';
import type { SessionManager } from '../sessions/manager.js';
import { readSessionHistory, type SessionHistoryDeps } from '../sessions/history.js';
import type { PlannerWorkspaceRegistry } from './workspaces.js';

/**
 * PA-6, phase 3: the planner's read-only tool catalog.
 *
 * Every tool here is `readOnly: true` per the reporter's answer to open
 * question 1 on PA-6 ("yes please, let's skip gate for those read tools
 * call") — `approval.ts` (a later phase) will special-case exactly this flag
 * rather than these tools individually. Mutating tools (`send_instruction`,
 * `write_file`, `mkdir`, `rmdir`, `delete_worktree`, `exec_command`) are a
 * later phase and do go through the approval gate.
 *
 * Each tool executes against the *existing* PocketAgent subsystems
 * (`WorkspaceRegistry`, `SessionManager`, the per-agent transcript stores) —
 * per the plan, the planner treats other sessions as sub-agents rather than
 * owning a parallel notion of "workspace" or "session" for them. `list_file`/
 * `read_file` additionally accept a planner workspace path, since the
 * planner's own scratch space is just as legitimate a read target.
 */

export interface PlannerToolDeps {
  workspaces: WorkspaceRegistry;
  plannerWorkspaces: PlannerWorkspaceRegistry;
  sessions: SessionManager;
  historyDeps: SessionHistoryDeps;
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

/**
 * Resolves a path the model asked to read against either boundary this
 * server already trusts: an added project workspace (`WorkspaceRegistry`) or
 * a planner workspace (`PlannerWorkspaceRegistry`). Realpath first, then
 * check containment against both root lists with the shared `isContained`
 * primitive — never a string-prefix check, and deliberately **not**
 * `WorkspaceRegistry.resolveWorkspacePath`, which requires its target to be a
 * *directory* (it exists to validate a session's cwd); a file read needs the
 * same containment check applied to something `resolveWorkspacePath` would
 * itself reject.
 */
async function resolveReadablePath(deps: PlannerToolDeps, requested: string): Promise<string> {
  const absolute = path.resolve(requested);
  let real: string;
  try {
    real = await fs.realpath(absolute);
  } catch {
    throw new Error(`Cannot resolve path: ${requested}`);
  }
  const insideProjectWorkspace = deps.workspaces.getRoots().some((root) => isContained(root, real));
  if (!insideProjectWorkspace && !deps.plannerWorkspaces.contains(real)) {
    throw new Error(`${requested} is outside every project workspace and every planner workspace.`);
  }
  return real;
}

export const PLANNER_TOOLS: readonly PlannerToolDefinition[] = [
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
      const { conversationId, events } = await readSessionHistory(deps.historyDeps, sessionId);
      if (!conversationId) {
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
      const real = await resolveReadablePath(deps, requested);
      const stat = await fs.stat(real);
      if (!stat.isFile()) return `${requested} is not a file.`;
      if (stat.size > MAX_FILE_READ_BYTES) {
        return `${requested} is ${stat.size} bytes, over this tool's ${MAX_FILE_READ_BYTES}-byte limit.`;
      }
      const content = await fs.readFile(real, 'utf8');
      return truncate(content, MAX_TOOL_RESULT_CHARS);
    },
  },
];

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
