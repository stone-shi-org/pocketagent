import type { AgentEvent, PermissionRequestEvent, SlashCommandInfo } from '@pocketagent/protocol';

/**
 * A renderable conversation, folded down from the raw event stream.
 *
 * The event stream is append-only and fine-grained (a tool call and its result
 * arrive as two separate events, possibly far apart). The UI wants the opposite:
 * one card per tool call that fills in when the result lands. This reducer owns
 * that join so the components stay dumb.
 */

export interface ToolItem {
  type: 'tool';
  key: string;
  toolUseId: string;
  name: string;
  summary: string;
  filePath: string | null;
  input: Record<string, unknown>;
  /** Filled in when the matching tool_result arrives. */
  result: string | null;
  resultTruncated: boolean;
  isError: boolean;
  /** Set while an approval for this call is outstanding. */
  awaitingApproval: boolean;
  denied: boolean;
}

export interface TextItem {
  type: 'text';
  key: string;
  role: 'assistant' | 'user';
  text: string;
  /** True while deltas are still arriving for this block. */
  streaming: boolean;
}

export interface ThinkingItem {
  type: 'thinking';
  key: string;
  text: string;
}

export interface NoticeItem {
  type: 'notice';
  key: string;
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface TurnItem {
  type: 'turn';
  key: string;
  stopReason: string | null;
  isError: boolean;
  costUsd: number | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** Output from a slash command that resolved locally, without a model turn. */
export interface CommandOutputItem {
  type: 'command_output';
  key: string;
  text: string;
}

export type TranscriptItem =
  | TextItem
  | ThinkingItem
  | ToolItem
  | NoticeItem
  | TurnItem
  | CommandOutputItem;

export interface TranscriptState {
  items: TranscriptItem[];
  /** Approvals still awaiting an answer, oldest first. */
  pending: PermissionRequestEvent[];
  /** Distinct files this session has touched, in first-seen order. */
  files: string[];
  model: string | null;
  agentSessionId: string | null;
  /** True between a user prompt and the matching turn_complete. */
  busy: boolean;
  totalCostUsd: number;
  /** Slash commands this agent currently supports, for the `/` picker. Empty
      for an agent that never reports any — the composer just has no picker. */
  commands: SlashCommandInfo[];
}

export function emptyTranscript(): TranscriptState {
  return {
    items: [],
    pending: [],
    files: [],
    model: null,
    agentSessionId: null,
    busy: false,
    totalCostUsd: 0,
    commands: [],
  };
}

/**
 * Fold one event into the transcript, returning a new state.
 *
 * Pure and total: an event that does not apply returns the state unchanged, so
 * replaying the whole buffer reproduces exactly the same view as having been
 * connected the entire time.
 */
export function applyEvent(state: TranscriptState, event: AgentEvent): TranscriptState {
  switch (event.kind) {
    case 'session_started':
      return {
        ...state,
        model: event.model,
        agentSessionId: event.agentSessionId,
      };

    case 'user_prompt':
      return {
        ...state,
        busy: true,
        items: [
          ...state.items,
          { type: 'text', key: `u_${event.id}`, role: 'user', text: event.text, streaming: false },
        ],
      };

    case 'text': {
      // A completed block supersedes the streaming preview that preceded it.
      //
      // The two cannot be matched by id: partial deltas are keyed by content
      // block *index*, which restarts at 0 for every assistant message, while
      // the completed block carries the message id. Dropping any outstanding
      // preview is both simpler and correct — a completed block always ends
      // whatever was streaming.
      const item: TextItem = {
        type: 'text',
        key: `t_${event.id}`,
        role: 'assistant',
        text: event.text,
        streaming: false,
      };
      return { ...state, items: [...dropStreaming(state.items), item] };
    }

    case 'text_delta': {
      const key = `stream_${event.id}`;
      const index = state.items.findIndex((i) => i.key === key);
      if (index >= 0) {
        const prev = state.items[index] as TextItem;
        const items = [...state.items];
        items[index] = { ...prev, text: prev.text + event.text };
        return { ...state, items };
      }
      return {
        ...state,
        items: [
          ...state.items,
          { type: 'text', key, role: 'assistant', text: event.text, streaming: true },
        ],
      };
    }

    case 'thinking':
      return {
        ...state,
        items: [...state.items, { type: 'thinking', key: `k_${event.id}`, text: event.text }],
      };

    case 'tool_use': {
      const files = event.filePath && !state.files.includes(event.filePath)
        ? [...state.files, event.filePath]
        : state.files;
      return {
        ...state,
        files,
        items: [
          ...state.items,
          {
            type: 'tool',
            key: `x_${event.id}`,
            toolUseId: event.id,
            name: event.name,
            summary: event.summary,
            filePath: event.filePath,
            input: event.input,
            result: null,
            resultTruncated: false,
            isError: false,
            awaitingApproval: false,
            denied: false,
          },
        ],
      };
    }

    case 'tool_result': {
      const index = state.items.findIndex(
        (i) => i.type === 'tool' && i.toolUseId === event.toolUseId,
      );
      if (index < 0) return state;
      const prev = state.items[index] as ToolItem;
      const items = [...state.items];
      items[index] = {
        ...prev,
        result: event.content,
        resultTruncated: event.truncated,
        isError: event.isError,
        awaitingApproval: false,
      };
      return { ...state, items };
    }

    case 'permission_request': {
      // Mark the tool card so it visibly blocks, rather than looking hung.
      const items = state.items.map((i) =>
        i.type === 'tool' && i.result === null && i.name === event.toolName
          ? { ...i, awaitingApproval: true }
          : i,
      );
      return { ...state, items, pending: [...state.pending, event] };
    }

    case 'permission_resolved': {
      const pending = state.pending.filter((p) => p.id !== event.id);
      const items = state.items.map((i) =>
        i.type === 'tool' && i.awaitingApproval
          ? { ...i, awaitingApproval: false, denied: event.decision === 'deny' }
          : i,
      );
      return { ...state, pending, items };
    }

    case 'turn_complete':
      return {
        ...state,
        busy: false,
        totalCostUsd: state.totalCostUsd + (event.costUsd ?? 0),
        items: [
          // A turn that ends without a completed text block (interrupted, or
          // error) must not leave a half-written preview behind.
          ...dropStreaming(state.items),
          {
            type: 'turn',
            key: `r_${state.items.length}`,
            stopReason: event.stopReason,
            isError: event.isError,
            costUsd: event.costUsd,
            durationMs: event.durationMs,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
          },
        ],
      };

    case 'notice':
      return {
        ...state,
        items: [
          ...state.items,
          { type: 'notice', key: `n_${state.items.length}`, level: event.level, text: event.text },
        ],
      };

    // REPLACE semantics, per the SDK's own `commands_changed` doc comment —
    // this is the full current list, not a delta, whether it arrived from
    // that push or from the initial `supportedCommands()` fetch.
    case 'commands_available':
      return { ...state, commands: event.commands };

    case 'command_output':
      return {
        ...state,
        items: [...state.items, { type: 'command_output', key: `co_${event.id}`, text: event.text }],
      };

    default:
      return state;
  }
}

export function applyEvents(state: TranscriptState, events: AgentEvent[]): TranscriptState {
  return events.reduce(applyEvent, state);
}

/**
 * A turn: a user prompt (the node) and everything the agent produced in
 * response, up to the next prompt (the leaves). Purely a rendering grouping —
 * `TranscriptState.items` stays the flat, order-preserving source of truth so
 * the streaming/mutate-by-id logic in `applyEvent` above never has to think
 * about turn boundaries.
 */
export interface TurnNode {
  key: string;
  /** Null only for the leading turn: items that arrived before any prompt
      (e.g. a `notice` from session_started). Nothing sticky renders for it. */
  prompt: TextItem | null;
  leaves: TranscriptItem[];
}

/** Group a flat item list into turns. One `O(n)` pass; see Transcript.tsx for
    why re-running this on every render is cheap enough not to warrant
    maintaining it incrementally inside the reducer instead. */
export function groupIntoTurns(items: TranscriptItem[]): TurnNode[] {
  const turns: TurnNode[] = [];
  let current: TurnNode = { key: 'leading', prompt: null, leaves: [] };
  for (const item of items) {
    if (item.type === 'text' && item.role === 'user') {
      turns.push(current);
      current = { key: item.key, prompt: item, leaves: [] };
    } else {
      current.leaves.push(item);
    }
  }
  turns.push(current);
  return turns.filter((turn) => turn.prompt !== null || turn.leaves.length > 0);
}

/** Remove any in-progress streaming preview. */
function dropStreaming(items: TranscriptItem[]): TranscriptItem[] {
  return items.filter((i) => !(i.type === 'text' && i.streaming));
}
