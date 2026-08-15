import type { AgentEvent } from '@pocketagent/protocol';

/**
 * A rolling preview for one structured session's fleet card: the last few
 * lines worth showing, plus whichever sub-agent calls are currently in
 * flight.
 *
 * Deliberately not `agent/transcript.ts`'s reducer — that one keeps the whole
 * conversation (every tool card, every turn) for a single open session. A
 * fleet card only has room for a handful of lines across potentially many
 * cards at once, so this only ever keeps the tail.
 *
 * Sub-agent depth is best-effort by design (see the "Agents" fleet-view
 * plan): a sub-agent-launching tool call is the Claude Agent SDK's only
 * visible trace of a sub-agent today, so a chip appears on `tool_use` and
 * disappears on the matching `tool_result` — there is no deeper transcript
 * to show for it.
 */

/**
 * Tool names observed to launch a sub-agent, per backend — confirmed live,
 * not documented anywhere:
 *  - Claude Agent SDK: `Agent` (not `Task`, which in current SDK builds is an
 *    unrelated task-tracking tool). `Task` is kept for older CLI builds that
 *    may still use that name.
 *  - opencode: `task`, lower-case — and unlike Claude's, opencode's blocks
 *    synchronously until the sub-agent finishes, so its `tool_result` is
 *    already the real one (no async/background reconciliation needed, the
 *    way `structured-session.ts` has to do for Claude's).
 *  - agy: `invoke_subagent` — but only reaches this as a `tool_use` at all
 *    because `apps/server/src/sessions/normalize.ts`'s `normalizeAgyStepUpdate`
 *    synthesizes one from a completely different raw event shape
 *    (`step_type: 'subagent'`, not the ordinary `'tool'`); see that
 *    function's doc comment for how thoroughly agy hides this one.
 * Mirrors the same match in `apps/server/src/sessions/normalize.ts`'s
 * `summarizeToolUse`/`summarizeOpencodeTool`/`summarizeAgyTool`, duplicated
 * rather than shared across the server/web boundary, same reasoning as
 * `strip-ansi.ts`.
 */
const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['Agent', 'Task', 'task', 'invoke_subagent']);

const MAX_LINES = 5;
const MAX_LINE_CHARS = 100;

export interface SubagentInfo {
  toolUseId: string;
  summary: string;
}

export interface FleetPreviewState {
  /** Newest last. */
  lines: string[];
  subagents: SubagentInfo[];
  /**
   * True while a `permission_request` is outstanding. `SessionInfo.busy`
   * stays true through this (the SDK's own `_busy` only clears on
   * `turn_complete`), but the agent is blocked on a human, not generating —
   * the fleet card's dot should read idle/yellow here, same bucket as a
   * terminal session's `waiting_for_input` hint. This is the one field
   * `AgentCard` reads to override the server-reported `busy`.
   */
  awaitingApproval: boolean;
}

export function emptyFleetPreview(): FleetPreviewState {
  return { lines: [], subagents: [], awaitingApproval: false };
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The last non-empty line of a (possibly multi-line) block, truncated. */
function lastLine(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  return clamp(lines.at(-1)?.trim() ?? '', MAX_LINE_CHARS);
}

function pushLine(state: FleetPreviewState, line: string): FleetPreviewState {
  if (!line) return state;
  // Collapse an immediate repeat rather than burning a line slot on it — the
  // clearest case being opencode's SSE stream re-emitting the same tool_use
  // verbatim while a part is still "running" (see the dedup comment on
  // `subagents` below for the fuller story on why that happens).
  if (state.lines.at(-1) === line) return state;
  return { ...state, lines: [...state.lines, line].slice(-MAX_LINES) };
}

/**
 * Fold one event into the preview. Pure and total, same discipline as
 * `transcript.ts`'s `applyEvent`: an event that does not apply returns the
 * state unchanged, so replaying a buffered `agentReplay` on first attach
 * produces the same view as having watched live the whole time.
 */
export function applyFleetEvent(state: FleetPreviewState, event: AgentEvent): FleetPreviewState {
  switch (event.kind) {
    case 'user_prompt':
      return pushLine(state, `> ${lastLine(event.text) || clamp(event.text, MAX_LINE_CHARS)}`);

    case 'tool_use': {
      const next = pushLine(state, clamp(event.summary, MAX_LINE_CHARS));
      if (!SUBAGENT_TOOL_NAMES.has(event.name)) return next;
      // opencode's SSE stream re-emits `tool_use` for the same id every time
      // the part's status is still "running" (confirmed live: a single
      // sub-agent call produced two identical events before its
      // `tool_result`) — without this guard, that becomes two chips for one
      // call rather than one that just updates in place.
      if (next.subagents.some((s) => s.toolUseId === event.id)) return next;
      return {
        ...next,
        subagents: [...next.subagents, { toolUseId: event.id, summary: event.summary }],
      };
    }

    case 'tool_result': {
      if (!state.subagents.some((s) => s.toolUseId === event.toolUseId)) return state;
      return { ...state, subagents: state.subagents.filter((s) => s.toolUseId !== event.toolUseId) };
    }

    case 'permission_request':
      return { ...pushLine(state, clamp(`Waiting for approval: ${event.title}`, MAX_LINE_CHARS)), awaitingApproval: true };

    case 'permission_resolved':
      return { ...state, awaitingApproval: false };

    // Not `text_delta`: partial streaming fragments would flood a 5-line
    // buffer with mid-word noise. The completed `text` block is one push.
    case 'text':
      return pushLine(state, lastLine(event.text));

    case 'thinking':
      return pushLine(state, 'Thinking…');

    case 'notice':
      return pushLine(state, clamp(event.text, MAX_LINE_CHARS));

    case 'command_output':
      return pushLine(state, lastLine(event.text));

    case 'turn_complete':
      return pushLine(state, event.isError ? 'Turn ended with an error' : 'Idle — waiting for a prompt');

    case 'conversation_reset':
      return pushLine(state, 'Conversation cleared');

    default:
      return state;
  }
}

export function applyFleetEvents(state: FleetPreviewState, events: AgentEvent[]): FleetPreviewState {
  return events.reduce(applyFleetEvent, state);
}
