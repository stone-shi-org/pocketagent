import path from 'node:path';
import type { AgentEvent, ModelInfo, SlashCommandInfo } from '@pocketagent/protocol';

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
    case 'conversation_reset':
      return [{ kind: 'conversation_reset', newConversationId: str(message.new_conversation_id) ?? '' }];
    default:
      return [];
  }
}

/**
 * Tracks the SDK's own background-task lifecycle across the whole session,
 * so `reconcileBackgroundTasks` (below) can tell a premature acknowledgment
 * apart from a real completion. Keyed by `tool_use_id` — one background task
 * always traces back to exactly one `Agent`/`Task` tool call.
 */
export interface BackgroundTaskState {
  /** tool_use_id -> task_id, for a task whose real completion is still pending. */
  pending: Map<string, string>;
}

export function createBackgroundTaskState(): BackgroundTaskState {
  return { pending: new Map() };
}

/**
 * Corrects a mismatch in how the SDK reports a background/async sub-agent
 * (confirmed live against the real `@anthropic-ai/claude-agent-sdk`, since
 * neither this message shape nor the tool's actual name — `Agent`, not the
 * `Task` this file originally assumed — is documented anywhere): launching
 * one via the `Agent`/`Task` tool gets a `tool_result` almost immediately
 * ("Async agent launched successfully") — that is an acknowledgment that the
 * task was *scheduled*, not that it finished. Read literally, a tool card (or
 * a fleet-view sub-agent chip, which disappears on `tool_result`) would
 * resolve within under a second — long before the real work, sometimes
 * minutes of it, is actually done.
 *
 * `task_started`/`task_notification` are the SDK's own background-task
 * lifecycle messages — not part of the documented message types
 * `normalizeSdkMessage` otherwise switches on, so they otherwise vanish into
 * its `default: []` for an unhandled `system` subtype. `task_started` records
 * which tool call a background task belongs to; `task_notification` is its
 * real completion, carrying a human-readable `summary` worth showing as the
 * (corrected) tool result. Everything in between (`task_progress`,
 * `background_tasks_changed`, `task_updated`) is redundant with those two for
 * this purpose and is left alone.
 *
 * Takes `events` (this message's own output from `normalizeSdkMessage`)
 * rather than recomputing anything, so the one thing this adds is exactly
 * the correction described above — suppressing the premature `tool_result`
 * for a tool_use_id currently pending, and appending the real one once
 * `task_notification` arrives for it.
 */
export function reconcileBackgroundTasks(
  message: unknown,
  events: AgentEvent[],
  state: BackgroundTaskState,
): AgentEvent[] {
  if (!isRecord(message)) return events;

  if (str(message.type) !== 'system') {
    return events.filter((e) => !(e.kind === 'tool_result' && state.pending.has(e.toolUseId)));
  }

  const subtype = str(message.subtype);

  if (subtype === 'task_started') {
    const taskId = str(message.task_id);
    const toolUseId = str(message.tool_use_id);
    if (taskId && toolUseId) state.pending.set(toolUseId, taskId);
    return events;
  }

  if (subtype === 'task_notification') {
    const toolUseId = str(message.tool_use_id);
    if (!toolUseId || !state.pending.has(toolUseId)) return events;
    const taskId = state.pending.get(toolUseId);
    state.pending.delete(toolUseId);
    const status = str(message.status);
    return [
      ...events,
      {
        kind: 'tool_result',
        id: `bgtask_${taskId ?? toolUseId}`,
        toolUseId,
        content: str(message.summary) ?? 'The background sub-agent finished.',
        truncated: false,
        isError: status !== undefined && status !== 'completed',
      },
    ];
  }

  return events;
}

function normalizeSystem(message: Record<string, unknown>): AgentEvent[] {
  const subtype = str(message.subtype);

  if (subtype === 'init') {
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

  // Fire-and-forget push of the full slash-command list after a mid-session
  // change (a skill discovered in a subdirectory, say). REPLACE semantics —
  // `StructuredSession`'s initial `supportedCommands()` call uses the same
  // shape via `normalizeSlashCommands` below, so both paths land on one event.
  if (subtype === 'commands_changed') {
    return [{ kind: 'commands_available', commands: normalizeSlashCommands(message.commands) }];
  }

  // Output from a command that resolved locally, without a model turn (e.g.
  // /usage, /voice). The SDK's own message carries no back-reference to which
  // command produced it, so there is nothing to attach beyond the text.
  if (subtype === 'local_command_output') {
    const content = str(message.content) ?? '';
    if (content.trim().length === 0) return [];
    return [
      { kind: 'command_output', id: str(message.uuid) ?? `lco_${clamp(content, 32)}`, text: clamp(content, MAX_TEXT_CHARS) },
    ];
  }

  return [];
}

/**
 * Defensive re-validation of the SDK's own `SlashCommand[]` shape — same
 * discipline as every other field in this file: trust it once it has actually
 * been checked, and drop anything that does not look right rather than throw.
 * Used both for `system`/`commands_changed` messages and for the plain
 * `SlashCommand[]` `StructuredSession` gets back from `supportedCommands()`.
 */
export function normalizeSlashCommands(value: unknown): SlashCommandInfo[] {
  if (!Array.isArray(value)) return [];
  const commands: SlashCommandInfo[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const name = str(raw.name);
    if (!name) continue;
    commands.push({
      name,
      description: str(raw.description) ?? '',
      argumentHint: str(raw.argumentHint) ?? '',
      aliases: Array.isArray(raw.aliases) ? raw.aliases.filter(isString) : [],
    });
  }
  return commands;
}

/**
 * Defensive re-validation of the SDK's own `ModelInfo[]` shape — same
 * discipline as `normalizeSlashCommands` above: trust it once it has actually
 * been checked, and drop anything that does not look right rather than throw.
 */
export function normalizeModels(value: unknown): ModelInfo[] {
  if (!Array.isArray(value)) return [];
  const models: ModelInfo[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const modelValue = str(raw.value);
    if (!modelValue) continue;
    const resolvedModel = str(raw.resolvedModel);
    // `EffortLevel` is a free-form string (see its protocol doc comment) —
    // this only rejects non-strings and empty ones, not "unrecognized"
    // values, since the SDK's own vocabulary is the only thing that decides
    // what a real effort level is here.
    const supportedEffortLevels = Array.isArray(raw.supportedEffortLevels)
      ? raw.supportedEffortLevels.filter(isString).filter((l) => l.length > 0)
      : [];
    models.push({
      value: modelValue,
      ...(resolvedModel ? { resolvedModel } : {}),
      displayName: str(raw.displayName) ?? modelValue,
      description: str(raw.description) ?? '',
      supportsEffort: raw.supportsEffort === true,
      supportedEffortLevels,
    });
  }
  return models;
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
    // The SDK's sub-agent-launching tool. Confirmed live (probing the real
    // `@anthropic-ai/claude-agent-sdk` query stream) to be named `Agent`, with
    // `AgentInput`'s own `description`/`prompt`/`subagent_type` fields — not
    // `Task`, which in this SDK version is the harness's unrelated
    // TaskCreate/TaskGet/... task-tracking tool. Kept as a second case rather
    // than replaced outright: `Task` was presumably the real name in an
    // older CLI build this file was written against, and matching both costs
    // nothing against whichever a given install actually reports.
    case 'Agent':
    case 'Task':
      return `Subagent: ${clamp(str(input.description) ?? '', 60)}`;
    case 'TodoWrite':
      return 'Update task list';
    case 'ExitPlanMode':
      return 'Review plan';
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
    case 'command_result':
      return normalizeAgyCommandResult(message);
    default:
      return [];
  }
}

/**
 * agy resolves `/help` (and other built-ins) locally — confirmed live
 * (v1.1.12): zero tokens, zero duration, no model turn — and reports it as
 * `{"event":"command_result","command":{"name":"help","data":{"commands":[...]}}}`.
 * Only `/help`'s own `data.commands` matches `SlashCommandInfo[]`; every other
 * command name's `data` means something else entirely (`/agents` lists
 * subagents, `/model` lists models, ...) and must not be misread as one.
 * `AgySession.fetchInitialCommands()` runs `/help` once, silently, at start
 * for exactly this event; this same case also fires if a user types `/help`
 * themselves mid-conversation, keeping the picker's list fresh for free.
 */
function normalizeAgyCommandResult(message: Record<string, unknown>): AgentEvent[] {
  const command = isRecord(message.command) ? message.command : null;
  if (!command || str(command.name) !== 'help') return [];
  const data = isRecord(command.data) ? command.data : null;
  if (!data) return [];
  return [{ kind: 'commands_available', commands: normalizeSlashCommands(data.commands) }];
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

  /**
   * agy's real sub-agent launcher (`invoke_subagent`) — confirmed live by
   * running `agy --output-format stream-json` directly, bypassing this
   * normalizer entirely: it does NOT arrive as `step_type: 'tool'` the way
   * every other tool call does. It gets its own step type, with a payload
   * shaped nothing like `tool_info` — `subagent_info.subagents[]`, each
   * `{role, initial_prompt, conversation_id, log_uri}`. Before this, that
   * shape fell straight through to the catch-all below and vanished: no
   * `tool_use`, so no fleet-view sub-agent chip and no tool card in the
   * normal transcript either, even though the sub-agent genuinely ran
   * (confirmed by checking the file it was asked to write).
   *
   * Only the `ACTIVE` half is handled here, deliberately — this step's own
   * `DONE` (same `step_index`, moments later) is a second trap layered on
   * the first: confirmed live with a real ~15s background task that it is
   * *not* the subagent actually finishing, only the `invoke_subagent` call
   * itself returning (fire-and-forget, same shape as Claude's `Agent` tool's
   * premature "launched" acknowledgment). agy pushes no equivalent of
   * Claude's `task_notification` for the real completion — the model can
   * poll `manage_subagents` for status, but nothing says so unprompted — so
   * `AgySession` resolves these itself against the one boundary that *is*
   * reliable: the turn's own `result` line, since a turn observed live did
   * not end until the background subagent genuinely finished. See
   * `AgySession`'s `pendingSubagents`.
   */
  if (stepType === 'subagent') {
    if (str(update.state) === 'DONE') return [];

    const info = isRecord(update.subagent_info) ? update.subagent_info : {};
    const subagents = Array.isArray(info.subagents) ? info.subagents : [];

    return subagents
      .map((raw, i): AgentEvent | null => {
        if (!isRecord(raw)) return null;
        const subConversationId = str(raw.conversation_id) ?? `${stepId}_${i}`;
        const input = { role: str(raw.role) ?? '', prompt: str(raw.initial_prompt) ?? '' };
        return {
          kind: 'tool_use',
          id: `agy_sub_${subConversationId}`,
          name: 'invoke_subagent',
          input,
          summary: summarizeAgyTool('invoke_subagent', input),
          filePath: null,
        };
      })
      .filter((e): e is AgentEvent => e !== null);
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
  const isError = status !== undefined && status !== 'SUCCESS';
  const errorText = str(result.error);

  const events: AgentEvent[] = [];
  // agy's own reason for a failed turn (e.g. a quota-exhausted
  // "Eligibility check failed: RESOURCE_EXHAUSTED..." from the Antigravity
  // backend) lives in this JSON field, not on stderr — confirmed live via
  // the `/usage` poller hitting the same shape. Without surfacing it here,
  // the process exiting non-zero moments later falls back to the opaque
  // `agy exited with code 1` in `AgySession.runTurn`, discarding the one
  // piece of text that actually explains what happened.
  if (isError && errorText) {
    events.push({ kind: 'notice', level: 'error', text: errorText });
  }
  events.push({
    kind: 'turn_complete',
    stopReason: status ?? null,
    isError,
    numTurns: num(result.num_turns),
    durationMs: durationSeconds !== null ? Math.round(durationSeconds * 1000) : null,
    // Headless agy reports token counts, never a dollar figure.
    costUsd: null,
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
  });
  return events;
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
    // agy's real sub-agent launcher — confirmed live via `agy --output-format
    // stream-json` directly (bypassing normalization entirely): it does NOT
    // appear as an ordinary tool step at all, see `normalizeAgyStepUpdate`'s
    // `step_type === 'subagent'` branch, which is what actually calls this
    // with `{role, prompt}` synthesized from that different event shape.
    case 'invoke_subagent': {
      const role = str(input.role);
      const prompt = str(input.prompt);
      return `Subagent: ${clamp(role || prompt || '', 60)}`;
    }
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

/**
 * Parse agy's own `agy models` subcommand output — plain text, not JSON: a
 * "Fetching available models..." status line followed by one `<id>\t<label>`
 * pair per line (confirmed live, v1.1.12). Unlike every other agy shape in
 * this file, `models` is a genuine top-level subcommand spawned on its own
 * (`AgySession.fetchInitialModels`), not a `-p` conversational turn, so there
 * is no `command_result`/`event` envelope to unwrap — just lines to split.
 *
 * agy has no live in-conversation model-switch call (its own `/model` slash
 * command reports the current model but "takes no arguments" — confirmed
 * live); `AgySession.setModel` instead respawns the *next* turn with
 * `--model <value>`, so `supportsEffort`/`supportedEffortLevels` are left
 * false/empty here rather than guessed — agy's separate `--effort` flag
 * conflicts with the models here that already bake an effort tier into their
 * id (e.g. `gemini-3.7-flash-high`), so there is no clean per-model effort
 * axis to report.
 */
export function normalizeAgyModelList(stdout: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const value = line.slice(0, tab).trim();
    const displayName = line.slice(tab + 1).trim();
    if (!value || !displayName) continue;
    models.push({ value, displayName, description: '', supportsEffort: false, supportedEffortLevels: [] });
  }
  return models;
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
    // opencode's own sub-agent launcher — confirmed live, `{description,
    // prompt, subagent_type}`, the same field names Claude's `Agent` tool
    // uses. Unlike Claude's, this one blocks until the sub-agent actually
    // finishes (its `tool_result` is real, not a premature "launched"
    // acknowledgment), so it needs no equivalent of `reconcileBackgroundTasks`.
    case 'task':
      return `Subagent: ${clamp(str(input.description) ?? '', 60)}`;
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

/**
 * opencode's own `GET /command` response — confirmed live (v1.17.18) — not an
 * SSE event, so unlike everything above this is consumed directly by
 * `OpencodeSession.fetchInitialCommands()`, never through `normalizeOpencodeEvent`.
 * Deliberately not reusing `normalizeSlashCommands`: opencode has no `aliases`
 * field, and its `hints` (e.g. `["$ARGUMENTS"]`) are internal template
 * placeholders, not a human-readable argument hint like the SDK's — showing
 * one verbatim in a picker would look like a rendering bug, so this leaves
 * `argumentHint` empty rather than surface it. A `template` field also exists
 * (the full prompt the command expands to) and is deliberately dropped: it is
 * often thousands of characters and has no use in a picker.
 */
export function normalizeOpencodeCommands(value: unknown): SlashCommandInfo[] {
  if (!Array.isArray(value)) return [];
  const commands: SlashCommandInfo[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const name = str(raw.name);
    if (!name) continue;
    commands.push({ name, description: str(raw.description) ?? '', argumentHint: '', aliases: [] });
  }
  return commands;
}

/**
 * opencode's own `GET /api/model` response (`ModelV2Info[]`) — confirmed live
 * (v1.18.18) against a real `opencode serve` instance. `value` is a composite
 * `providerID/id` (there is no single field that already carries both, and
 * `POST /api/session/{id}/model`'s body wants them split back out again — see
 * `OpencodeSession.setModel`). `ModelCapabilities` has no reasoning/effort
 * field at all (only `tools`/`input`/`output`), so unlike codex or pi there is
 * no per-model effort axis this can report — `supportsEffort` stays false.
 */
export function normalizeOpencodeModels(value: unknown): ModelInfo[] {
  if (!Array.isArray(value)) return [];
  const models: ModelInfo[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const id = str(raw.id);
    const providerID = str(raw.providerID);
    if (!id || !providerID) continue;
    models.push({
      value: `${providerID}/${id}`,
      displayName: str(raw.name) ?? id,
      description: str(raw.family) ?? '',
      supportsEffort: false,
      supportedEffortLevels: [],
    });
  }
  return models;
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

/**
 * A synthesized turn boundary for a reconstructed history (`*HistoryEvents`
 * below), all-null/false the same way `CodexSession.runSlashCommand`'s own
 * local-command completion is: there is no real usage/duration to report for
 * a turn that already happened, but the browser's busy indicator is armed by
 * `user_prompt` and disarmed only by `turn_complete` (see that method's doc
 * comment for the same contract), so a replayed conversation must still close
 * out every turn it opens or the composer looks stuck "thinking" forever.
 */
function historyTurnComplete(): AgentEvent {
  return {
    kind: 'turn_complete',
    stopReason: null,
    isError: false,
    numTurns: null,
    durationMs: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
  };
}

/**
 * Reconstruct a resumed opencode session's prior conversation from `GET
 * /session/{id}/message` (confirmed live against a real, installed `opencode
 * serve`: an array of `{info, parts}`, the same `Message`/`Part` shapes
 * `normalizeOpencodeEvent` already parses live via `message.updated`/
 * `message.part.updated`) — see `OpencodeSession.fetchHistory`'s doc comment
 * for why this exists.
 *
 * Unlike the live event stream, there is no separate "tool started" snapshot
 * to reconstruct here: a completed or errored tool part is the only record of
 * that call this endpoint gives, so it is expanded into both its `tool_use`
 * and `tool_result` at once, in that order, rather than only the `tool_result`
 * half `normalizeOpencodePart` emits for an already-finished live call.
 * `subtask`/`file`/`stepStart`/`stepFinish`/`snapshot`/`patch`/`agent`/`retry`/
 * `compaction` parts are dropped, same discipline as `AgyTranscriptStore`'s
 * "readable what-was-said, not a full re-render" for agy's own disk history.
 */
export function opencodeHistoryEvents(messagesRaw: unknown): AgentEvent[] {
  if (!Array.isArray(messagesRaw)) return [];
  const events: AgentEvent[] = [];
  let openTurn = false;

  for (const entry of messagesRaw) {
    if (!isRecord(entry)) continue;
    const info = isRecord(entry.info) ? entry.info : null;
    const parts = Array.isArray(entry.parts) ? entry.parts.filter(isRecord) : [];
    if (!info) continue;
    const role = str(info.role);

    if (role === 'user') {
      const text = parts
        .filter((p) => str(p.type) === 'text')
        .map((p) => str(p.text) ?? '')
        .filter((t) => t.trim().length > 0)
        .join('\n');
      if (text) {
        if (openTurn) {
          events.push(historyTurnComplete());
          openTurn = false;
        }
        events.push({ kind: 'user_prompt', id: str(info.id) ?? `oc_hist_${events.length}`, text });
      }
      continue;
    }

    if (role !== 'assistant') continue;

    for (const partRaw of parts) {
      const partType = str(partRaw.type);
      const id = str(partRaw.id) ?? str(partRaw.callID) ?? `oc_hist_part_${events.length}`;

      if (partType === 'text') {
        const text = str(partRaw.text) ?? '';
        if (text.trim().length === 0) continue;
        events.push({ kind: 'text', id, text: clamp(text, MAX_TEXT_CHARS) });
        openTurn = true;
        continue;
      }

      if (partType === 'reasoning') {
        const text = str(partRaw.text) ?? '';
        if (text.trim().length === 0) continue;
        events.push({ kind: 'thinking', id, text: clamp(text, MAX_TEXT_CHARS) });
        openTurn = true;
        continue;
      }

      if (partType === 'tool') {
        const state = isRecord(partRaw.state) ? partRaw.state : null;
        const status = state ? str(state.status) : null;
        if (status !== 'completed' && status !== 'error') continue;
        const name = str(partRaw.tool) ?? 'tool';
        const input = state && isRecord(state.input) ? state.input : {};
        events.push({
          kind: 'tool_use',
          id,
          name,
          input,
          summary: summarizeOpencodeTool(name, input),
          filePath: extractOpencodePath(input),
        });
        const isError = status === 'error';
        const content = state ? str(isError ? state.error : state.output) ?? '' : '';
        events.push({
          kind: 'tool_result',
          id: `oc_hist_tr_${id}`,
          toolUseId: id,
          content: clamp(content, MAX_RESULT_CHARS),
          truncated: content.length > MAX_RESULT_CHARS,
          isError,
        });
        openTurn = true;
      }
    }
  }

  if (openTurn) events.push(historyTurnComplete());
  return events;
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

/**
 * `model/list`'s own `Model` shape — confirmed live against the real,
 * installed app-server (v0.147.0): `{data: Model[], nextCursor}`, each with
 * `id`, `displayName`, `description`, `supportedReasoningEfforts:
 * [{reasoningEffort, description}]`. Used both by `CodexSession.
 * fetchInitialModels()` and (as plain text, not `ModelInfo[]`) by the
 * existing `/model` slash command's `dispatchSlashCommand` case above.
 */
export function normalizeCodexModels(value: unknown): ModelInfo[] {
  if (!Array.isArray(value)) return [];
  const models: ModelInfo[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const id = str(raw.id);
    if (!id) continue;
    const supportedEffortLevels = Array.isArray(raw.supportedReasoningEfforts)
      ? raw.supportedReasoningEfforts
          .filter(isRecord)
          .map((o) => str(o.reasoningEffort))
          .filter((s): s is string => Boolean(s))
      : [];
    models.push({
      value: id,
      displayName: str(raw.displayName) ?? id,
      description: str(raw.description) ?? '',
      supportsEffort: supportedEffortLevels.length > 0,
      supportedEffortLevels,
    });
  }
  return models;
}

/**
 * Reconstruct a resumed codex thread's prior conversation from `thread/resume`
 * (or `thread/read` with `includeTurns: true`)'s own `thread.turns` — each a
 * `Turn` with `items: ThreadItem[]`, confirmed against the real, installed
 * app-server's own generated JSON schema (`codex app-server
 * generate-json-schema --experimental`, v0.147.0): `Thread.turns`'s own doc
 * string says it is "Only populated on `thread/resume`, `thread/rollback`,
 * `thread/fork`, and `thread/read` (when `includeTurns` is true) responses" —
 * i.e. already present on the very `thread/resume` call `CodexSession.start()`
 * makes to attach to an existing thread, no second round trip needed.
 *
 * Each item is the same `ThreadItem` shape `normalizeCodexItem` already
 * parses live via `item/started`/`item/completed`, reused here as-is for
 * every type except `userMessage`: the live path never maps that one (
 * `CodexSession.prompt()` already echoes its own `user_prompt` locally for a
 * turn just sent), but history has no other source for what the user typed,
 * so it is the one case handled here instead. Every item is treated as
 * `'completed'` — a resumed turn is by definition done. `turn_complete` is
 * synthesized once per turn, not once per item, for the busy-indicator reason
 * `historyTurnComplete`'s own doc comment explains.
 */
export function codexHistoryEvents(turnsRaw: unknown): AgentEvent[] {
  if (!Array.isArray(turnsRaw)) return [];
  const events: AgentEvent[] = [];
  let openTurn = false;

  for (const turnRaw of turnsRaw) {
    if (!isRecord(turnRaw)) continue;
    const items = Array.isArray(turnRaw.items) ? turnRaw.items.filter(isRecord) : [];
    for (const itemRaw of items) {
      if (str(itemRaw.type) === 'userMessage') {
        if (openTurn) {
          events.push(historyTurnComplete());
          openTurn = false;
        }
        const text = codexUserInputText(itemRaw.content);
        if (text) events.push({ kind: 'user_prompt', id: str(itemRaw.id) ?? `cx_hist_${events.length}`, text });
        continue;
      }
      const before = events.length;
      events.push(...normalizeCodexItem(itemRaw, 'completed'));
      if (events.length > before) openTurn = true;
    }
  }
  if (openTurn) events.push(historyTurnComplete());
  return events;
}

/**
 * `UserMessageThreadItem.content`'s own `UserInput[]` — only the `text`
 * variant renders; `image`/`localImage`/`audio` inputs have no text to show
 * and are dropped, same discipline as everywhere else history is
 * reconstructed in this file.
 */
function codexUserInputText(contentRaw: unknown): string {
  if (!Array.isArray(contentRaw)) return '';
  return contentRaw
    .filter(isRecord)
    .filter((c) => str(c.type) === 'text')
    .map((c) => str(c.text) ?? '')
    .filter((t) => t.trim().length > 0)
    .join('\n');
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

/**
 * pi's own `Model` object (docs/rpc.md's `#model` type, confirmed live
 * v0.84.1 via `get_available_models`/`get_state`/`set_model`): `{id, name,
 * api, provider, baseUrl, reasoning, input, contextWindow, maxTokens, cost,
 * compat?: {thinkingLevelMap}}`. `value` is a composite `provider/id` — the
 * same format pi's own `--model <pattern>` flag documents ("supports
 * provider/id") and the only thing `set_model`'s `{provider, modelId}` params
 * round-trip against, since no single field carries both. Returns null for
 * anything that does not even have the two fields a value needs, so a caller
 * can filter rather than push a broken entry.
 */
function normalizePiModel(raw: unknown): ModelInfo | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const provider = str(raw.provider);
  if (!id || !provider) return null;
  const compat = isRecord(raw.compat) ? raw.compat : null;
  const thinkingLevelMap = compat && isRecord(compat.thinkingLevelMap) ? compat.thinkingLevelMap : null;
  // Only the levels actually enabled for *this* model (a non-null mapped
  // value) — `thinkingLevelMap` lists every level pi knows about, most mapped
  // to `null` for a model that does not support them (confirmed live: a
  // DeepSeek model's map had `medium: null` right next to `high: "high"`).
  const supportedEffortLevels = thinkingLevelMap
    ? Object.entries(thinkingLevelMap)
        .filter(([, v]) => v !== null)
        .map(([k]) => k)
    : [];
  return {
    value: `${provider}/${id}`,
    displayName: str(raw.name) ?? id,
    description: '',
    supportsEffort: raw.reasoning === true,
    supportedEffortLevels,
  };
}

/** `get_available_models`'s own `{models: Model[]}` payload, for the picker. */
export function normalizePiModels(value: unknown): ModelInfo[] {
  if (!Array.isArray(value)) return [];
  const models: ModelInfo[] = [];
  for (const raw of value) {
    const model = normalizePiModel(raw);
    if (model) models.push(model);
  }
  return models;
}

/**
 * The composite `provider/id` value for a single already-known `Model`
 * object, e.g. `get_state().model` — same key `normalizePiModels` gives each
 * list entry, so the two agree on what "the current model" matches against.
 */
export function normalizePiModelValue(raw: unknown): string | null {
  return normalizePiModel(raw)?.value ?? null;
}

/**
 * Reconstruct a resumed pi session's prior conversation from `get_messages`
 * (docs/rpc.md: `{messages: AgentMessage[]}`) — see `PiSession.fetchHistory`'s
 * doc comment for why this exists. `AgentMessage` shapes are the same
 * `UserMessage`/`AssistantMessage`/`ToolResultMessage`/`BashExecutionMessage`
 * ones `docs/rpc.md` documents; unverified against a live conversation (no
 * provider in this environment had working credentials for `pi` — same
 * caveat as `normalizePiEvent`'s own doc comment), so this reads defensively
 * off the documented shape rather than an observed one. `turn_complete` is
 * synthesized once per user message, same reasoning as `codexHistoryEvents`/
 * `opencodeHistoryEvents`.
 */
export function piHistoryEvents(messagesRaw: unknown): AgentEvent[] {
  if (!Array.isArray(messagesRaw)) return [];
  const events: AgentEvent[] = [];
  let openTurn = false;

  const flushTurn = (): void => {
    if (openTurn) {
      events.push(historyTurnComplete());
      openTurn = false;
    }
  };

  messagesRaw.forEach((messageRaw, index) => {
    if (!isRecord(messageRaw)) return;
    const role = str(messageRaw.role);

    if (role === 'user') {
      flushTurn();
      const text = piMessageContentText(messageRaw.content);
      if (text) events.push({ kind: 'user_prompt', id: `pi_hist_${index}`, text });
      return;
    }

    if (role === 'assistant') {
      const content = Array.isArray(messageRaw.content) ? messageRaw.content.filter(isRecord) : [];
      content.forEach((block, blockIndex) => {
        const type = str(block.type);
        const id = `pi_hist_${index}_${blockIndex}`;
        if (type === 'text') {
          const text = str(block.text) ?? '';
          if (text.trim().length === 0) return;
          events.push({ kind: 'text', id, text: clamp(text, MAX_TEXT_CHARS) });
          openTurn = true;
        } else if (type === 'thinking') {
          const text = str(block.thinking) ?? '';
          if (text.trim().length === 0) return;
          events.push({ kind: 'thinking', id, text: clamp(text, MAX_TEXT_CHARS) });
          openTurn = true;
        } else if (type === 'toolCall') {
          const toolCallId = str(block.id) ?? id;
          const name = str(block.name) ?? 'tool';
          const input = isRecord(block.arguments) ? block.arguments : {};
          events.push({
            kind: 'tool_use',
            id: toolCallId,
            name,
            input,
            summary: summarizePiTool(name, input),
            filePath: extractPiPath(input),
          });
          openTurn = true;
        }
      });
      return;
    }

    if (role === 'toolResult') {
      const toolCallId = str(messageRaw.toolCallId);
      if (!toolCallId) return;
      const content = stringifyToolResult(messageRaw.content);
      events.push({
        kind: 'tool_result',
        id: `pi_hist_tr_${toolCallId}`,
        toolUseId: toolCallId,
        content: clamp(content, MAX_RESULT_CHARS),
        truncated: content.length > MAX_RESULT_CHARS,
        isError: messageRaw.isError === true,
      });
      openTurn = true;
      return;
    }

    if (role === 'bashExecution') {
      const command = str(messageRaw.command) ?? '';
      const id = `pi_hist_bash_${index}`;
      events.push({
        kind: 'tool_use',
        id,
        name: 'bash',
        input: { command },
        summary: summarizePiTool('bash', { command }),
        filePath: null,
      });
      const output = str(messageRaw.output) ?? '';
      events.push({
        kind: 'tool_result',
        id: `pi_hist_tr_${id}`,
        toolUseId: id,
        content: clamp(output, MAX_RESULT_CHARS),
        truncated: output.length > MAX_RESULT_CHARS,
        isError: typeof messageRaw.exitCode === 'number' && messageRaw.exitCode !== 0,
      });
      openTurn = true;
    }
  });

  flushTurn();
  return events;
}

/** `UserMessage.content`: a plain string, or an array of `TextContent`/`ImageContent` blocks (docs/rpc.md) — only the text ones render. */
function piMessageContentText(contentRaw: unknown): string {
  if (isString(contentRaw)) return contentRaw;
  if (Array.isArray(contentRaw)) {
    return contentRaw
      .filter(isRecord)
      .filter((c) => str(c.type) === 'text')
      .map((c) => str(c.text) ?? '')
      .filter((t) => t.trim().length > 0)
      .join('\n');
  }
  return '';
}
