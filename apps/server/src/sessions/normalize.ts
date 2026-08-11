import path from 'node:path';
import type { AgentEvent } from '@pocketagent/protocol';

/** Tool results can be enormous; the UI only needs a readable preview. */
const MAX_RESULT_CHARS = 8000;
const MAX_TEXT_CHARS = 200_000;

/**
 * Translate one Claude Agent SDK message into zero or more normalized events.
 *
 * Kept as a pure function so the mapping can be tested against recorded SDK
 * payloads without spawning an agent. Unknown message types return `[]` rather
 * than throwing — the SDK adds types regularly and an unrecognized one must
 * never take down a session.
 */
export function normalizeSdkMessage(message: unknown): AgentEvent[] {
  if (!isRecord(message)) return [];
  const type = str(message.type);

  switch (type) {
    case 'system':
      return normalizeSystem(message);
    case 'assistant':
      return normalizeAssistant(message);
    case 'user':
      return normalizeUser(message);
    case 'result':
      return [normalizeResult(message)];
    case 'stream_event':
      return normalizeStreamEvent(message);
    default:
      return [];
  }
}

function normalizeSystem(message: Record<string, unknown>): AgentEvent[] {
  if (str(message.subtype) !== 'init') return [];
  return [
    {
      kind: 'session_started',
      agentSessionId: str(message.session_id) ?? null,
      model: str(message.model) ?? null,
      cwd: str(message.cwd) ?? '',
      tools: Array.isArray(message.tools) ? message.tools.filter(isString) : [],
      permissionMode: str(message.permissionMode) ?? null,
    },
  ];
}

function normalizeAssistant(message: Record<string, unknown>): AgentEvent[] {
  const inner = isRecord(message.message) ? message.message : null;
  const content = inner && Array.isArray(inner.content) ? inner.content : [];
  const events: AgentEvent[] = [];

  for (const raw of content) {
    if (!isRecord(raw)) continue;
    const blockType = str(raw.type);

    if (blockType === 'text') {
      const text = str(raw.text) ?? '';
      if (text.trim().length === 0) continue;
      events.push({ kind: 'text', id: blockId(inner, events.length), text: clamp(text, MAX_TEXT_CHARS) });
      continue;
    }

    if (blockType === 'thinking') {
      const text = str(raw.thinking) ?? '';
      // A thinking block with empty text is a progress signal, not content —
      // the API omits reasoning by default. Nothing to fold open, so skip it.
      if (text.trim().length === 0) continue;
      events.push({ kind: 'thinking', id: blockId(inner, events.length), text: clamp(text, MAX_TEXT_CHARS) });
      continue;
    }

    if (blockType === 'tool_use') {
      const name = str(raw.name) ?? 'tool';
      const input = isRecord(raw.input) ? raw.input : {};
      events.push({
        kind: 'tool_use',
        id: str(raw.id) ?? `tu_${events.length}`,
        name,
        input,
        summary: summarizeToolUse(name, input),
        filePath: extractPath(input),
      });
    }
  }

  return events;
}

function normalizeUser(message: Record<string, unknown>): AgentEvent[] {
  const inner = isRecord(message.message) ? message.message : null;
  const content = inner && Array.isArray(inner.content) ? inner.content : [];
  const events: AgentEvent[] = [];

  for (const raw of content) {
    if (!isRecord(raw)) continue;
    if (str(raw.type) !== 'tool_result') continue;

    const text = stringifyToolResult(raw.content);
    events.push({
      kind: 'tool_result',
      id: `tr_${str(raw.tool_use_id) ?? events.length}`,
      toolUseId: str(raw.tool_use_id) ?? '',
      content: clamp(text, MAX_RESULT_CHARS),
      truncated: text.length > MAX_RESULT_CHARS,
      isError: raw.is_error === true,
    });
  }

  return events;
}

function normalizeResult(message: Record<string, unknown>): AgentEvent {
  const usage = isRecord(message.usage) ? message.usage : {};
  return {
    kind: 'turn_complete',
    stopReason: str(message.stop_reason) ?? null,
    isError: message.is_error === true,
    numTurns: num(message.num_turns),
    durationMs: num(message.duration_ms) ?? num(message.duration_api_ms),
    costUsd: num(message.total_cost_usd),
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
  };
}

/** Partial assistant text, when `includePartialMessages` is enabled. */
function normalizeStreamEvent(message: Record<string, unknown>): AgentEvent[] {
  const event = isRecord(message.event) ? message.event : null;
  if (!event || str(event.type) !== 'content_block_delta') return [];
  const delta = isRecord(event.delta) ? event.delta : null;
  if (!delta || str(delta.type) !== 'text_delta') return [];
  const text = str(delta.text) ?? '';
  if (!text) return [];
  return [{ kind: 'text_delta', id: `sd_${num(event.index) ?? 0}`, text }];
}

// ---------------------------------------------------------------------------

/**
 * A short human sentence for a tool call.
 *
 * Deliberately generic with a few well-known special cases: an unknown tool
 * still renders as `name(arg)` rather than a blank card.
 */
export function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  const file = extractPath(input);
  const base = file ? path.basename(file) : null;

  switch (name) {
    case 'Read':
      return base ? `Read ${base}` : 'Read file';
    case 'Write':
      return base ? `Write ${base}` : 'Write file';
    case 'Edit':
      return base ? `Edit ${base}` : 'Edit file';
    case 'NotebookEdit':
      return base ? `Edit notebook ${base}` : 'Edit notebook';
    case 'Bash': {
      const cmd = str(input.command) ?? '';
      return cmd ? `Run ${clamp(cmd.split('\n')[0] ?? cmd, 80)}` : 'Run command';
    }
    case 'Glob':
      return `Find ${str(input.pattern) ?? 'files'}`;
    case 'Grep':
      return `Search ${str(input.pattern) ?? ''}`.trim();
    case 'WebFetch':
      return `Fetch ${str(input.url) ?? 'URL'}`;
    case 'WebSearch':
      return `Search web: ${clamp(str(input.query) ?? '', 60)}`;
    case 'Task':
      return `Subagent: ${clamp(str(input.description) ?? '', 60)}`;
    case 'TodoWrite':
      return 'Update task list';
    default: {
      if (base) return `${name} ${base}`;
      const first = Object.values(input).find(isString);
      return first ? `${name} ${clamp(first, 60)}` : name;
    }
  }
}

/** The file a tool call touches, if any. Used for diffs and the file list. */
export function extractPath(input: Record<string, unknown>): string | null {
  for (const key of ['file_path', 'filePath', 'path', 'notebook_path']) {
    const value = input[key];
    if (isString(value) && value.length > 0) return value;
  }
  return null;
}

function stringifyToolResult(content: unknown): string {
  if (isString(content)) return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (isString(block)) return block;
        if (isRecord(block) && str(block.type) === 'text') return str(block.text) ?? '';
        if (isRecord(block) && str(block.type) === 'image') return '[image]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content === null || content === undefined) return '';
  return JSON.stringify(content);
}

function blockId(inner: Record<string, unknown> | null, index: number): string {
  const base = (inner && str(inner.id)) || 'msg';
  return `${base}_${index}`;
}

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function str(value: unknown): string | undefined {
  return isString(value) ? value : undefined;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
