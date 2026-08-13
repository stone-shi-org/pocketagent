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
    case 'AskUserQuestion': {
      const questions = Array.isArray(input.questions) ? input.questions : [];
      const first = isRecord(questions[0]) ? str(questions[0].question) : undefined;
      if (questions.length > 1) return `Asking ${questions.length} questions`;
      return first ? clamp(first, 80) : 'Asking a question';
    }
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

// ---------------------------------------------------------------------------
// agy (Google Antigravity CLI) — headless `agy --output-format stream-json`
// ---------------------------------------------------------------------------

/**
 * Translate one line of `agy --output-format stream-json` output into zero or
 * more normalized events.
 *
 * Shapes below were captured against the real CLI (v1.1.12): each line is
 * `{"event": "init" | "step_update" | "result", ...}`. Kept pure and
 * defensive for the same reason as `normalizeSdkMessage` — an unrecognized
 * shape (a future agy version, or a line this parser has not seen) must
 * return `[]`, never throw and never take down `AgySession`'s pump loop.
 */
export function normalizeAgyMessage(message: unknown): AgentEvent[] {
  if (!isRecord(message)) return [];
  const event = str(message.event);

  switch (event) {
    case 'init':
      return normalizeAgyInit(message);
    case 'step_update':
      return normalizeAgyStepUpdate(message);
    case 'result':
      return normalizeAgyResult(message);
    default:
      return [];
  }
}

function normalizeAgyInit(message: Record<string, unknown>): AgentEvent[] {
  const init = isRecord(message.init) ? message.init : {};
  return [
    {
      kind: 'session_started',
      agentSessionId: str(message.conversation_id) ?? null,
      // The `init` line carries no model field — `--model`/`models` live
      // outside the event stream — so this stays null rather than guessing.
      model: null,
      cwd: str(init.cwd) ?? '',
      tools: Array.isArray(init.tools) ? init.tools.filter(isString) : [],
      permissionMode: str(init.permission_mode) ?? null,
    },
  ];
}

function normalizeAgyStepUpdate(message: Record<string, unknown>): AgentEvent[] {
  const update = isRecord(message.step_update) ? message.step_update : null;
  if (!update) return [];

  const stepType = str(update.step_type);
  const conversationId = str(update.conversation_id) ?? '';
  const stepIndex = num(update.step_index) ?? 0;
  const stepId = `agy_${conversationId}_${stepIndex}`;

  if (stepType === 'agent_response') {
    const text = str(update.text_delta) ?? '';
    if (!text) return [];
    return [{ kind: 'text_delta', id: stepId, text }];
  }

  if (stepType === 'tool') {
    const toolInfo = isRecord(update.tool_info) ? update.tool_info : {};
    const name = str(update.tool_name) ?? str(toolInfo.name) ?? 'tool';
    const input = isRecord(toolInfo.parameters) ? toolInfo.parameters : {};

    if (str(update.state) === 'DONE') {
      const error = isRecord(toolInfo.error) ? toolInfo.error : null;
      const output = str(toolInfo.output) ?? (error ? str(error.message) ?? '' : '');
      return [
        {
          kind: 'tool_result',
          id: `agy_tr_${conversationId}_${stepIndex}`,
          toolUseId: stepId,
          content: clamp(output, MAX_RESULT_CHARS),
          truncated: output.length > MAX_RESULT_CHARS,
          isError: error !== null,
        },
      ];
    }

    // Any non-DONE state (only "ACTIVE" observed) is the call starting.
    return [
      {
        kind: 'tool_use',
        id: stepId,
        name,
        input,
        summary: summarizeAgyTool(name, input),
        filePath: extractAgyPath(input),
      },
    ];
  }

  // user_input / checkpoint / unknown step types are internal bookkeeping —
  // we synthesize our own `user_prompt` event in `AgySession.prompt()`, and
  // the rest has nothing worth showing.
  return [];
}

function normalizeAgyResult(message: Record<string, unknown>): AgentEvent[] {
  const result = isRecord(message.result) ? message.result : {};
  const usage = isRecord(result.usage) ? result.usage : {};
  const status = str(result.status);
  const durationSeconds = num(result.duration_seconds);

  return [
    {
      kind: 'turn_complete',
      stopReason: status ?? null,
      isError: status !== undefined && status !== 'SUCCESS',
      numTurns: num(result.num_turns),
      durationMs: durationSeconds !== null ? Math.round(durationSeconds * 1000) : null,
      // Headless agy reports token counts, never a dollar figure.
      costUsd: null,
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
    },
  ];
}

/**
 * A short human sentence for one of agy's own tool names.
 *
 * Kept separate from `summarizeToolUse`: agy's tool surface (`run_command`,
 * `write_to_file`, `view_file`, ...) does not overlap with Claude Code's, and
 * conflating the two switch statements would make either one harder to read.
 */
export function summarizeAgyTool(name: string, input: Record<string, unknown>): string {
  const file = extractAgyPath(input);
  const base = file ? path.basename(file) : null;

  switch (name) {
    case 'run_command': {
      const cmd = str(input.CommandLine) ?? '';
      return cmd ? `Run ${clamp(cmd.split('\n')[0] ?? cmd, 80)}` : 'Run command';
    }
    case 'view_file':
      return base ? `Read ${base}` : 'Read file';
    case 'write_to_file':
      return base ? `Write ${base}` : 'Write file';
    case 'replace_file_content':
    case 'multi_replace_file_content':
    case 'sed_file':
      return base ? `Edit ${base}` : 'Edit file';
    case 'list_dir':
      return base ? `List ${base}` : 'List directory';
    case 'grep_search':
      return `Search ${str(input.Query) ?? str(input.pattern) ?? ''}`.trim() || 'Search';
    case 'find_by_name':
      return `Find ${str(input.Pattern) ?? 'files'}`;
    case 'read_url_content':
    case 'open_browser_url':
      return `Fetch ${str(input.Url) ?? str(input.url) ?? 'URL'}`;
    case 'search_web':
      return `Search web: ${clamp(str(input.query) ?? '', 60)}`;
    case 'ask_permission':
    case 'ask_question':
      return 'Asking a question';
    default: {
      if (base) return `${name} ${base}`;
      const first = Object.values(input).find(isString);
      return first ? `${name} ${clamp(first, 60)}` : name;
    }
  }
}

/**
 * The file an agy tool call touches, if any.
 *
 * agy's parameter names vary tool-to-tool and were not fully enumerable from
 * a single probe run, so this checks every key name observed or plausible
 * rather than committing to one fixed shape — same defensive spirit as
 * `extractPath` above.
 */
export function extractAgyPath(input: Record<string, unknown>): string | null {
  for (const key of ['AbsolutePath', 'TargetFile', 'Path', 'file_path', 'path']) {
    const value = input[key];
    if (isString(value) && value.length > 0) return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// opencode — `opencode serve`'s shared `GET /event` SSE stream
// ---------------------------------------------------------------------------

/**
 * Translate one event from opencode's `GET /event` SSE stream into zero or
 * more normalized events.
 *
 * Shapes below come from the real, installed `@opencode-ai/sdk` v1.17.18
 * generated types (`dist/gen/types.gen.d.ts`) cross-checked against a live
 * `opencode serve` instance's own `/doc` OpenAPI output. The two disagreed on
 * naming more than once during development — the OpenAPI catalog still lists
 * schemas like `EventPermissionAsked` that no longer correspond to anything
 * actually emitted on the wire in this version, where the live discriminant
 * is `permission.updated` — so this only trusts shapes that were confirmed in
 * the shipped `.d.ts`, and returns `[]` for anything else rather than
 * guessing. As with `normalizeSdkMessage`/`normalizeAgyMessage`, an
 * unrecognized event must never throw.
 */
export function normalizeOpencodeEvent(message: unknown): AgentEvent[] {
  if (!isRecord(message)) return [];
  const type = str(message.type);
  const properties = isRecord(message.properties) ? message.properties : {};

  switch (type) {
    case 'message.part.updated':
      return normalizeOpencodePart(properties);
    case 'message.updated':
      return normalizeOpencodeMessage(properties);
    case 'session.idle':
      // Cost/token totals are not on this event (see `properties` in the
      // `.d.ts`: just `{sessionID}`) — they arrive separately via
      // `message.updated` for the assistant message. `OpencodeSession`
      // caches the latest one and patches it into this event's fields
      // itself; this function has no cross-event memory to do that with.
      return [
        {
          kind: 'turn_complete',
          stopReason: null,
          isError: false,
          numTurns: null,
          durationMs: null,
          costUsd: null,
          inputTokens: null,
          outputTokens: null,
        },
      ];
    case 'session.error':
      return [
        {
          kind: 'notice',
          level: 'error',
          text: extractOpencodeErrorMessage(properties.error),
        },
      ];
    case 'permission.updated':
      return [normalizeOpencodePermission(properties)];
    case 'permission.replied': {
      const decision = opencodeReplyToDecision(str(properties.response));
      const id = str(properties.id) ?? str(properties.permissionID);
      if (!id) return [];
      return [{ kind: 'permission_resolved', id, decision, message: null }];
    }
    default:
      return [];
  }
}

function normalizeOpencodePart(properties: Record<string, unknown>): AgentEvent[] {
  const part = isRecord(properties.part) ? properties.part : null;
  if (!part) return [];
  const partType = str(part.type);
  const id = str(part.id) ?? str(part.callID) ?? 'oc_part';

  if (partType === 'text') {
    const events: AgentEvent[] = [];
    const delta = str(properties.delta);
    if (delta) events.push({ kind: 'text_delta', id, text: delta });

    // opencode has no separate "block finished" signal; `time.end` on the
    // part itself is it. A plain user-submitted part (echoed back over the
    // same event type) carries no `time` at all, so this naturally never
    // fires for the user's own prompt — no role check needed to keep from
    // re-showing it.
    const time = isRecord(part.time) ? part.time : null;
    if (time && num(time.end) !== null) {
      const text = str(part.text) ?? '';
      if (text.trim().length > 0) events.push({ kind: 'text', id, text: clamp(text, MAX_TEXT_CHARS) });
    }
    return events;
  }

  if (partType === 'reasoning') {
    const time = isRecord(part.time) ? part.time : null;
    if (!time || num(time.end) === null) return [];
    const text = str(part.text) ?? '';
    if (text.trim().length === 0) return [];
    return [{ kind: 'thinking', id, text: clamp(text, MAX_TEXT_CHARS) }];
  }

  if (partType === 'tool') {
    const state = isRecord(part.state) ? part.state : null;
    const status = state ? str(state.status) : null;
    const name = str(part.tool) ?? 'tool';
    const input = state && isRecord(state.input) ? state.input : {};

    if (status === 'running') {
      return [
        {
          kind: 'tool_use',
          id,
          name,
          input,
          summary: summarizeOpencodeTool(name, input),
          filePath: extractOpencodePath(input),
        },
      ];
    }
    if (status === 'completed' || status === 'error') {
      const isError = status === 'error';
      const content = state ? str(isError ? state.error : state.output) ?? '' : '';
      return [
        {
          kind: 'tool_result',
          id: `oc_tr_${id}`,
          toolUseId: id,
          content: clamp(content, MAX_RESULT_CHARS),
          truncated: content.length > MAX_RESULT_CHARS,
          isError,
        },
      ];
    }
    // "pending": arguments are still streaming in, nothing to show yet.
    return [];
  }

  // file / step-start / step-finish / snapshot / patch / agent / retry /
  // compaction / subtask parts have no rendering in this union yet.
  return [];
}

function normalizeOpencodeMessage(properties: Record<string, unknown>): AgentEvent[] {
  const info = isRecord(properties.info) ? properties.info : null;
  if (!info || str(info.role) !== 'assistant') return [];
  if (!isRecord(info.error)) return [];
  return [{ kind: 'notice', level: 'error', text: extractOpencodeErrorMessage(info.error) }];
}

function normalizeOpencodePermission(properties: Record<string, unknown>): AgentEvent {
  const id = str(properties.id) ?? '';
  // `type` here is the permission/tool kind (e.g. "bash", "edit"), not the
  // literal string "permission" — same field opencode's own title sentence
  // (below) describes.
  const toolName = str(properties.type) ?? 'tool';
  const metadata = isRecord(properties.metadata) ? properties.metadata : {};

  return {
    kind: 'permission_request',
    id,
    toolName,
    input: metadata,
    // opencode renders its own sentence for this, same reasoning as the SDK's
    // `opts.title` in structured-session.ts: show what the CLI would show.
    title: str(properties.title) ?? `Allow: ${toolName}?`,
    displayName: null,
    filePath: extractOpencodePath(metadata),
    reason: null,
    // The reply endpoint always accepts "always", so a session-wide allow is
    // always on the table — there is no per-request flag saying otherwise.
    canAllowForSession: true,
    // opencode's question flow (a separate `/question` resource) is not
    // mapped in this version; every permission is a generic approval.
    questions: null,
  };
}

function opencodeReplyToDecision(
  reply: string | undefined,
): 'allow' | 'allow_session' | 'deny' {
  if (reply === 'always') return 'allow_session';
  if (reply === 'reject') return 'deny';
  return 'allow';
}

function extractOpencodeErrorMessage(error: unknown): string {
  if (!isRecord(error)) return 'Unknown error.';
  const data = isRecord(error.data) ? error.data : {};
  const message = str(data.message);
  if (message) return message;
  const name = str(error.name);
  return name ? `${name}.` : 'Unknown error.';
}

/**
 * A short human sentence for one of opencode's own tool names.
 *
 * Unverified against a live tool call — the sandbox this was built in could
 * not reach a working model provider (see the PR/commit notes) — so this
 * leans on the generic fallback rather than guessing parameter key names for
 * tools this was never able to observe firing.
 */
export function summarizeOpencodeTool(name: string, input: Record<string, unknown>): string {
  const file = extractOpencodePath(input);
  const base = file ? path.basename(file) : null;

  switch (name) {
    case 'bash': {
      const cmd = str(input.command) ?? '';
      return cmd ? `Run ${clamp(cmd.split('\n')[0] ?? cmd, 80)}` : 'Run command';
    }
    case 'read':
      return base ? `Read ${base}` : 'Read file';
    case 'write':
      return base ? `Write ${base}` : 'Write file';
    case 'edit':
      return base ? `Edit ${base}` : 'Edit file';
    case 'glob':
      return `Find ${str(input.pattern) ?? 'files'}`;
    case 'grep':
      return `Search ${str(input.pattern) ?? ''}`.trim() || 'Search';
    case 'webfetch':
      return `Fetch ${str(input.url) ?? 'URL'}`;
    default: {
      if (base) return `${name} ${base}`;
      const first = Object.values(input).find(isString);
      return first ? `${name} ${clamp(first, 60)}` : name;
    }
  }
}

/** The file an opencode tool call touches, if any. Best-effort, same caveat as `summarizeOpencodeTool`. */
export function extractOpencodePath(input: Record<string, unknown>): string | null {
  for (const key of ['filePath', 'file_path', 'path']) {
    const value = input[key];
    if (isString(value) && value.length > 0) return value;
  }
  return null;
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

// ---------------------------------------------------------------------------
// codex — `codex app-server`'s JSON-RPC notifications and requests
// ---------------------------------------------------------------------------

/**
 * One incoming line from `codex app-server`, already parsed enough to know
 * whether it is a notification (`id` undefined) or a server request awaiting
 * a reply (`id` set) — see `CodexServerManager`. This mirrors that file's own
 * `JsonRpcIncoming` shape rather than importing it, to keep this module's
 * only dependency on session internals at zero, same as the other two
 * normalizers.
 */
export interface CodexIncoming {
  method: string;
  params: Record<string, unknown>;
  id?: number;
}

/**
 * Translate one JSON-RPC message from `codex app-server` into zero or more
 * normalized events.
 *
 * Shapes below were captured live against the real, installed CLI (v0.147.0,
 * with a working ChatGPT login) — including a genuine approval round trip
 * that blocked a command until replied to — with two exceptions called out
 * where they occur: the exact field names for a *successful* command's
 * output were never confirmed (the account's rate limit was too close to its
 * cap, mid-development, to safely re-run for it), and `fileChange`/`reasoning`
 * items were inferred from the approval-request params and the protocol's own
 * JSON Schema rather than observed directly. Both fall back to `''`/`null`
 * rather than guessing wrong, per the same defensive discipline as
 * `normalizeAgyMessage`/`normalizeOpencodeEvent`.
 */
export function normalizeCodexEvent(message: CodexIncoming): AgentEvent[] {
  const { method, params, id } = message;

  switch (method) {
    case 'item/started':
      return normalizeCodexItem(params.item, 'started');
    case 'item/completed':
      return normalizeCodexItem(params.item, 'completed');
    case 'item/agentMessage/delta': {
      const delta = str(params.delta);
      const itemId = str(params.itemId);
      if (!delta || !itemId) return [];
      return [{ kind: 'text_delta', id: itemId, text: delta }];
    }
    case 'turn/completed': {
      const turn = isRecord(params.turn) ? params.turn : {};
      const hasError = turn.error !== null && turn.error !== undefined;
      return [
        {
          kind: 'turn_complete',
          stopReason: hasError ? 'error' : null,
          isError: hasError,
          numTurns: null,
          durationMs: num(turn.durationMs),
          // Token/cost usage is not on this notification — it arrives
          // separately via `thread/tokenUsage/updated`. `CodexSession`
          // caches the latest one and patches it in itself, the same
          // enrichment `OpencodeSession` does for `session.idle`.
          costUsd: null,
          inputTokens: null,
          outputTokens: null,
        },
      ];
    }
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      if (id === undefined) return [];
      return [normalizeCodexPermission(method, params, id)];
    case 'error':
      return [{ kind: 'notice', level: 'error', text: extractCodexErrorMessage(params) }];
    default:
      // Every other item type (todoList, webSearch, mcpToolCall, ...) and
      // every other notification (rate limits, mcp startup, thread renames,
      // ...) has nothing to render in this union yet.
      return [];
  }
}

function normalizeCodexItem(itemRaw: unknown, phase: 'started' | 'completed'): AgentEvent[] {
  if (!isRecord(itemRaw)) return [];
  const type = str(itemRaw.type);
  const id = str(itemRaw.id) ?? 'cx_item';

  // The user's own prompt is echoed back as a `userMessage` item; we already
  // emit our own `user_prompt` locally in `CodexSession.prompt()`.
  if (type === 'userMessage') return [];

  if (type === 'agentMessage') {
    if (phase !== 'completed') return [];
    const text = str(itemRaw.text) ?? '';
    if (text.trim().length === 0) return [];
    return [{ kind: 'text', id, text: clamp(text, MAX_TEXT_CHARS) }];
  }

  if (type === 'reasoning') {
    if (phase !== 'completed') return [];
    const text = extractCodexReasoningText(itemRaw);
    if (!text) return [];
    return [{ kind: 'thinking', id, text: clamp(text, MAX_TEXT_CHARS) }];
  }

  if (type === 'commandExecution') {
    if (phase === 'started') {
      const command = str(itemRaw.command) ?? '';
      return [
        {
          kind: 'tool_use',
          id,
          name: 'commandExecution',
          input: { command, cwd: str(itemRaw.cwd) ?? '' },
          summary: command ? `Run ${clamp(command.split('\n')[0] ?? command, 80)}` : 'Run command',
          filePath: null,
        },
      ];
    }
    const output = extractCodexCommandOutput(itemRaw);
    return [
      {
        kind: 'tool_result',
        id: `cx_tr_${id}`,
        toolUseId: id,
        content: clamp(output, MAX_RESULT_CHARS),
        truncated: output.length > MAX_RESULT_CHARS,
        isError: str(itemRaw.status) === 'failed',
      },
    ];
  }

  if (type === 'fileChange') {
    // Never observed live (see this section's own doc comment) — the
    // approval-request params only carry an `itemId` back-reference, not the
    // file/diff itself, so there is nothing more specific to show yet.
    if (phase === 'started') {
      return [{ kind: 'tool_use', id, name: 'fileChange', input: {}, summary: 'Edit file', filePath: null }];
    }
    return [
      {
        kind: 'tool_result',
        id: `cx_tr_${id}`,
        toolUseId: id,
        content: '',
        truncated: false,
        isError: str(itemRaw.status) === 'failed',
      },
    ];
  }

  return [];
}

/** Best-effort: never confirmed live (reasoning summaries were empty in the one run tested). */
function extractCodexReasoningText(item: Record<string, unknown>): string | null {
  for (const key of ['content', 'summary']) {
    const arr = item[key];
    if (!Array.isArray(arr)) continue;
    const text = arr
      .map((block) => (isString(block) ? block : isRecord(block) ? str(block.text) : undefined))
      .filter((t): t is string => t !== undefined && t.trim().length > 0)
      .join('\n');
    if (text) return text;
  }
  return null;
}

/**
 * Best-effort: a *failed* command's shape was observed live (the run this was
 * built against deliberately triggered a rejection to confirm the approval
 * gate itself), but a clean successful completion's output field was not —
 * the account's rate limit was too close to its cap to safely re-run for it.
 * Checks every plausible key name rather than committing to one.
 */
function extractCodexCommandOutput(item: Record<string, unknown>): string {
  for (const key of ['aggregatedOutput', 'output', 'stdout']) {
    const value = item[key];
    if (isString(value)) return value;
  }
  const error = item.error;
  if (isString(error)) return error;
  if (isRecord(error) && isString(error.message)) return error.message;
  return '';
}

function normalizeCodexPermission(
  method: string,
  params: Record<string, unknown>,
  id: number,
): AgentEvent {
  const toolName = method === 'item/commandExecution/requestApproval' ? 'commandExecution' : 'fileChange';
  const command = str(params.command);
  const reason = str(params.reason);

  return {
    kind: 'permission_request',
    // The JSON-RPC request id this reply must echo back — see
    // `CodexSession.resolvePermission`. Stringified only because
    // `PermissionRequestEvent.id` is a string everywhere else in the union;
    // `CodexSession` converts it back to a number before replying.
    id: String(id),
    toolName,
    input: command ? { command, cwd: str(params.cwd) ?? '' } : { itemId: str(params.itemId) ?? '' },
    title:
      reason ??
      (command ? `Allow: ${clamp(command.split('\n')[0] ?? command, 80)}?` : `Allow: ${toolName}?`),
    displayName: null,
    filePath: null,
    reason: null,
    // Both approval types accept "acceptForSession" per the real response
    // schema, so a session-wide allow is always on the table.
    canAllowForSession: true,
    questions: null,
  };
}

function extractCodexErrorMessage(params: Record<string, unknown>): string {
  const error = params.error;
  if (isString(error)) return error;
  if (isRecord(error) && isString(error.message)) return error.message;
  const message = params.message;
  if (isString(message)) return message;
  return 'Codex reported an error.';
}

// ---------------------------------------------------------------------------
// pi — `pi --mode rpc`'s JSON event stream
// ---------------------------------------------------------------------------

/**
 * Translate one event from `pi --mode rpc`'s stdout into zero or more
 * normalized events.
 *
 * Shapes below come from the installed CLI's own shipped TypeScript
 * declarations (`AssistantMessageEvent`, `Usage`, `AgentEvent` in
 * `@earendil-works/pi-ai`/`pi-agent-core`) and its `docs/rpc.md`, read
 * directly rather than observed live — no provider in this environment had
 * working credentials for `pi` to run a real session against. `pi` has no
 * approval concept in any mode (see `agents/pi.ts`), so unlike the other
 * three normalizers there is no `permission_request` case here at all — it
 * would have nothing to map from.
 *
 * `messageSeq` disambiguates delta ids across separate assistant messages in
 * the same turn: pi's own `contentIndex` restarts at 0 per message, so
 * `PiSession` increments this counter on every `message_start` and threads it
 * through, the same role `OpencodeSession`/`CodexSession` play caching cross-
 * event state their own normalizers can't see in one call.
 */
export function normalizePiEvent(message: unknown, messageSeq = 0): AgentEvent[] {
  if (!isRecord(message)) return [];
  const type = str(message.type);

  switch (type) {
    case 'message_update':
      return normalizePiMessageUpdate(message, messageSeq);
    case 'tool_execution_start':
      return normalizePiToolExecution(message, 'start');
    case 'tool_execution_end':
      return normalizePiToolExecution(message, 'end');
    case 'agent_settled':
      // Usage/cost/stopReason are not on this event — they came earlier, on
      // the last assistant `message_end`. `PiSession` caches that and
      // patches it in itself; this function has no cross-event memory to do
      // that with.
      return [
        {
          kind: 'turn_complete',
          stopReason: null,
          isError: false,
          numTurns: null,
          durationMs: null,
          costUsd: null,
          inputTokens: null,
          outputTokens: null,
        },
      ];
    case 'auto_retry_end':
      if (message.success === false) {
        return [
          {
            kind: 'notice',
            level: 'error',
            text: str(message.finalError) ?? 'Retry failed after multiple attempts.',
          },
        ];
      }
      return [];
    case 'extension_error':
      return [
        {
          kind: 'notice',
          level: 'warn',
          text: `Extension error: ${str(message.error) ?? 'unknown error'}`,
        },
      ];
    default:
      // agent_start/agent_end/turn_start/turn_end/message_start/message_end/
      // bash_execution_update/tool_execution_update/queue_update/compaction_*/
      // extension_ui_request and everything else have no rendering in this
      // union yet — `agent_settled` and `tool_execution_*` already cover the
      // moments PocketAgent needs (turn done, tool ran).
      return [];
  }
}

function normalizePiMessageUpdate(message: Record<string, unknown>, messageSeq: number): AgentEvent[] {
  const ame = isRecord(message.assistantMessageEvent) ? message.assistantMessageEvent : null;
  if (!ame) return [];
  const ameType = str(ame.type);
  const contentIndex = num(ame.contentIndex) ?? 0;
  const id = `pi_${messageSeq}_${contentIndex}`;

  if (ameType === 'text_delta') {
    const delta = str(ame.delta);
    if (!delta) return [];
    return [{ kind: 'text_delta', id, text: delta }];
  }

  if (ameType === 'text_end') {
    const content = str(ame.content) ?? '';
    if (content.trim().length === 0) return [];
    return [{ kind: 'text', id, text: clamp(content, MAX_TEXT_CHARS) }];
  }

  if (ameType === 'thinking_end') {
    const content = str(ame.content) ?? '';
    if (content.trim().length === 0) return [];
    return [{ kind: 'thinking', id, text: clamp(content, MAX_TEXT_CHARS) }];
  }

  // text_start/thinking_start/thinking_delta/toolcall_* — nothing to show
  // yet; `tool_execution_start`/`tool_execution_end` carry the real
  // execution lifecycle pi's own docs recommend using for that.
  return [];
}

function normalizePiToolExecution(message: Record<string, unknown>, phase: 'start' | 'end'): AgentEvent[] {
  const toolCallId = str(message.toolCallId);
  if (!toolCallId) return [];
  const toolName = str(message.toolName) ?? 'tool';

  if (phase === 'start') {
    const input = isRecord(message.args) ? message.args : {};
    return [
      {
        kind: 'tool_use',
        id: toolCallId,
        name: toolName,
        input,
        summary: summarizePiTool(toolName, input),
        filePath: extractPiPath(input),
      },
    ];
  }

  const result = isRecord(message.result) ? message.result : {};
  const content = stringifyToolResult(result.content);
  return [
    {
      kind: 'tool_result',
      id: `pi_tr_${toolCallId}`,
      toolUseId: toolCallId,
      content: clamp(content, MAX_RESULT_CHARS),
      truncated: content.length > MAX_RESULT_CHARS,
      isError: message.isError === true,
    },
  ];
}

/**
 * A short human sentence for one of pi's own tool names.
 *
 * Unverified against a live tool call — no provider in this environment had
 * working credentials for `pi` — so this leans on the generic fallback
 * rather than guessing argument key names this was never able to observe.
 */
export function summarizePiTool(name: string, input: Record<string, unknown>): string {
  const file = extractPiPath(input);
  const base = file ? path.basename(file) : null;

  switch (name) {
    case 'bash': {
      const cmd = str(input.command) ?? '';
      return cmd ? `Run ${clamp(cmd.split('\n')[0] ?? cmd, 80)}` : 'Run command';
    }
    case 'read':
      return base ? `Read ${base}` : 'Read file';
    case 'write':
      return base ? `Write ${base}` : 'Write file';
    case 'edit':
      return base ? `Edit ${base}` : 'Edit file';
    default: {
      if (base) return `${name} ${base}`;
      const first = Object.values(input).find(isString);
      return first ? `${name} ${clamp(first, 60)}` : name;
    }
  }
}

/** The file a pi tool call touches, if any. Best-effort, same caveat as `summarizePiTool`. */
export function extractPiPath(input: Record<string, unknown>): string | null {
  for (const key of ['path', 'file_path', 'filePath']) {
    const value = input[key];
    if (isString(value) && value.length > 0) return value;
  }
  return null;
}
