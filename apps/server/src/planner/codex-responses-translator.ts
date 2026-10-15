/**
 * OpenAI Chat Completions <-> OpenAI Responses API (`chatgpt.com/backend-api/codex/responses`)
 * request and SSE stream translator for Pocket Agent's `codex-oauth` provider (PA-150).
 *
 * Ported from OmniRoute (`open-sse/translator/request/openai-responses/toResponses.ts`,
 * `open-sse/translator/response/openai-responses.ts`, `open-sse/executors/codex.ts`,
 * `open-sse/executors/codex/*`):
 *
 * MIT License
 * Copyright (c) 2026 diegosouzapw
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 */

import { isContextOverflowMessage, isQuotaMessage, isRetryableStatus } from './llm-errors.js';
import {
  PlannerLlmError,
  type PlannerChatMessage,
  type PlannerLlmCompletion,
  type PlannerLlmStreamEvent,
  type PlannerLlmStreamOptions,
  type PlannerLlmToolCall,
  type PlannerLlmUsage,
  type PlannerTextContentPart,
  type PlannerUserContentPart,
} from './llm-client.js';

/**
 * Default Codex CLI version reported in `Version` and `User-Agent` headers
 * when the host does not have a newer `codex` binary installed. Kept in one
 * place per PA-150: stale client versions get newer models refused by the
 * ChatGPT Codex backend.
 */
export const DEFAULT_CODEX_CLIENT_VERSION = '0.159.2';

export const CODEX_ORIGINATOR = 'codex_cli_rs';
export const CODEX_OPENAI_BETA_HEADER = 'responses_websockets=2026-02-06';

/**
 * Neutral default `instructions` string used when a request has no system
 * message. The ChatGPT Codex backend rejects empty `instructions`, and no
 * Codex persona is required.
 */
export const DEFAULT_CODEX_INSTRUCTIONS = 'You are a helpful assistant.';

export type CodexReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

const REASONING_SUFFIX_MAP: Readonly<Record<string, CodexReasoningEffort>> = {
  '-none': 'none',
  '-minimal': 'minimal',
  '-low': 'low',
  '-medium': 'medium',
  '-high': 'high',
  '-xhigh': 'xhigh',
  '-max': 'xhigh',
  '-ultra': 'xhigh',
};

const REASONING_SUFFIXES = Object.keys(REASONING_SUFFIX_MAP).sort((a, b) => b.length - a.length);

/**
 * Splits a reasoning effort suffix (e.g. `gpt-5.5-high` -> `gpt-5.5` + `high`)
 * from a Codex model identifier.
 */
export function splitCodexReasoningSuffix(model: string): {
  baseModel: string;
  suffixEffort: CodexReasoningEffort | null;
} {
  const trimmed = model.trim();
  const lower = trimmed.toLowerCase();
  for (const suffix of REASONING_SUFFIXES) {
    if (lower.endsWith(suffix) && trimmed.length > suffix.length) {
      return {
        baseModel: trimmed.slice(0, trimmed.length - suffix.length),
        suffixEffort: REASONING_SUFFIX_MAP[suffix] ?? null,
      };
    }
  }
  return { baseModel: trimmed, suffixEffort: null };
}

function normalizeEffortValue(raw: string | null | undefined): CodexReasoningEffort | null {
  if (!raw) return null;
  const lower = raw.trim().toLowerCase();
  if (lower === 'off' || lower === 'none') return 'none';
  if (lower === 'minimal') return 'minimal';
  if (lower === 'low') return 'low';
  if (lower === 'medium') return 'medium';
  if (lower === 'high') return 'high';
  if (lower === 'xhigh' || lower === 'max' || lower === 'ultra') return 'xhigh';
  return null;
}

function clampCodexEffortForModel(baseModel: string, effort: CodexReasoningEffort): CodexReasoningEffort {
  if (effort === 'none') return 'none';
  const lower = baseModel.toLowerCase();
  // Codex models do not support 'minimal'; upgrade to 'low'.
  const normalized = effort === 'minimal' && lower.includes('codex') ? 'low' : effort;
  if (lower === 'gpt-5-pro') return 'high';
  if (lower.startsWith('gpt-5.1-codex-mini')) {
    return normalized === 'high' || normalized === 'xhigh' ? 'high' : 'medium';
  }
  if (lower === 'gpt-5.1' && normalized === 'xhigh') {
    return 'high';
  }
  return normalized;
}

export function resolveCodexReasoningConfig(
  baseModel: string,
  suffixEffort: CodexReasoningEffort | null,
  streamOptions?: PlannerLlmStreamOptions,
): {
  reasoning: { effort: CodexReasoningEffort; summary?: 'auto' };
  includeReasoningEncrypted: boolean;
} {
  if (streamOptions?.thinking === false || streamOptions?.effort === 'off') {
    return {
      reasoning: { effort: 'none' },
      includeReasoningEncrypted: false,
    };
  }
  const explicitEffort = normalizeEffortValue(streamOptions?.effort);
  const rawEffort = explicitEffort ?? suffixEffort ?? 'medium';
  if (rawEffort === 'none') {
    return {
      reasoning: { effort: 'none' },
      includeReasoningEncrypted: false,
    };
  }
  const clamped = clampCodexEffortForModel(baseModel, rawEffort);
  return {
    reasoning: { effort: clamped, summary: 'auto' },
    includeReasoningEncrypted: true,
  };
}

/**
 * Parameters the ChatGPT Codex `/responses` backend rejects with `400 Bad Request`.
 * Ported from OmniRoute's `stripPassthroughRejectedParams.ts` and `executors/codex.ts`.
 */
export const CODEX_REJECTED_PARAMS: ReadonlySet<string> = new Set([
  'max_tokens',
  'max_output_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'user',
  'truncation',
  'prompt_cache_retention',
  'safety_identifier',
  'background',
  'session_id',
  'conversation_id',
  'messages',
  'prompt',
  'stream_options',
  'reasoning_effort',
  'service_tier',
  'metadata',
  'context_management',
]);

export const CODEX_PASSTHROUGH_ALLOWLIST: ReadonlySet<string> = new Set([
  'model',
  'instructions',
  'input',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'reasoning',
  'text',
  'include',
  'store',
  'stream',
  'prompt_cache_key',
]);

/**
 * Strips any parameters not supported by the ChatGPT Codex `/responses` backend.
 */
export function stripCodexUnsupportedParams(body: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (CODEX_REJECTED_PARAMS.has(key)) continue;
    if (!CODEX_PASSTHROUGH_ALLOWLIST.has(key)) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

export type CodexResponsesInputItem =
  | {
      type: 'message';
      role: 'user' | 'developer';
      content: Array<
        | { type: 'input_text'; text: string }
        | { type: 'input_image'; image_url: string }
        | { type: 'input_file'; filename: string; file_data: string }
      >;
    }
  | {
      type: 'message';
      role: 'assistant';
      content: Array<{ type: 'output_text'; text: string }>;
      status: 'completed';
    }
  | {
      type: 'reasoning';
      id?: string;
      encrypted_content: string;
      summary: Array<{ type: 'summary_text'; text: string }>;
    }
  | {
      type: 'function_call';
      call_id: string;
      name: string;
      arguments: string;
      status: 'completed';
    }
  | {
      type: 'function_call_output';
      call_id: string;
      output: string;
      status: 'completed';
    };

export interface CodexResponsesTool {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

function extractTextFromParts(content: string | PlannerTextContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'text' && p.text.length > 0)
    .map((p) => p.text)
    .join('\n\n');
}

function translateUserContent(
  content: string | PlannerUserContentPart[],
): Array<
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'input_file'; filename: string; file_data: string }
> {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'input_text', text: content }] : [{ type: 'input_text', text: '' }];
  }
  const items: Array<
    | { type: 'input_text'; text: string }
    | { type: 'input_image'; image_url: string }
    | { type: 'input_file'; filename: string; file_data: string }
  > = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text.length > 0) {
        items.push({ type: 'input_text', text: part.text });
      }
    } else if (part.type === 'image_url') {
      const url = part.image_url?.url ?? '';
      if (url.length > 0) {
        items.push({ type: 'input_image', image_url: url });
      }
    } else if (part.type === 'file') {
      const fileData = part.file?.file_data ?? '';
      if (fileData.length > 0) {
        items.push({
          type: 'input_file',
          filename: part.file.filename || 'document.pdf',
          file_data: fileData,
        });
      }
    }
  }
  return items.length > 0 ? items : [{ type: 'input_text', text: '' }];
}

function enforceFunctionCallPairing(input: CodexResponsesInputItem[]): CodexResponsesInputItem[] {
  const callIds = new Set<string>();
  const outputIds = new Set<string>();
  for (const item of input) {
    if (item.type === 'function_call' && item.call_id) {
      callIds.add(item.call_id);
    } else if (item.type === 'function_call_output' && item.call_id) {
      outputIds.add(item.call_id);
    }
  }

  // Drop orphaned function_call_output items that have no matching function_call.
  const filtered = input.filter(
    (item) => item.type !== 'function_call_output' || (item.call_id && callIds.has(item.call_id)),
  );

  // Inject synthetic empty function_call_output for any unpaired function_call.
  const result: CodexResponsesInputItem[] = [];
  for (const item of filtered) {
    result.push(item);
    if (item.type === 'function_call' && item.call_id && !outputIds.has(item.call_id)) {
      result.push({
        type: 'function_call_output',
        call_id: item.call_id,
        output: '',
        status: 'completed',
      });
    }
  }
  return result;
}

function convertTools(tools: unknown[] | undefined): CodexResponsesTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const converted: CodexResponsesTool[] = [];
  for (const raw of tools) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as Record<string, unknown>;
    const fn =
      t.type === 'function' && t.function && typeof t.function === 'object'
        ? (t.function as Record<string, unknown>)
        : t;
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!name) continue;
    const description = typeof fn.description === 'string' ? fn.description : undefined;
    const parameters =
      fn.parameters && typeof fn.parameters === 'object'
        ? (fn.parameters as Record<string, unknown>)
        : { type: 'object', properties: {} };
    converted.push({
      type: 'function',
      name,
      ...(description ? { description } : {}),
      parameters,
    });
  }
  return converted.length > 0 ? converted : undefined;
}

export interface BuildCodexResponsesRequestOptions {
  model: string;
  messages: readonly PlannerChatMessage[];
  tools?: unknown[] | undefined;
  streamOptions?: PlannerLlmStreamOptions | undefined;
  /** Optional extra raw fields to verify parameter stripping. */
  extraBody?: Record<string, unknown> | undefined;
}

/**
 * Translates an OpenAI-style `PlannerChatMessage[]` + tools + options into a
 * ChatGPT Codex Responses API request body (`POST /backend-api/codex/responses`).
 */
export function buildCodexResponsesRequest(
  opts: BuildCodexResponsesRequestOptions,
): Record<string, unknown> {
  const { baseModel, suffixEffort } = splitCodexReasoningSuffix(opts.model);
  const { reasoning, includeReasoningEncrypted } = resolveCodexReasoningConfig(
    baseModel,
    suffixEffort,
    opts.streamOptions,
  );

  let instructions: string | null = null;
  const rawInput: CodexResponsesInputItem[] = [];

  for (const msg of opts.messages) {
    if (msg.role === 'system') {
      const text = extractTextFromParts(msg.content).trim();
      if (!text) continue;
      if (instructions === null) {
        instructions = text;
      } else {
        rawInput.push({
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text }],
        });
      }
      continue;
    }

    if (msg.role === 'user') {
      rawInput.push({
        type: 'message',
        role: 'user',
        content: translateUserContent(msg.content),
      });
      continue;
    }

    if (msg.role === 'assistant') {
      if (msg.reasoningItems && msg.reasoningItems.length > 0) {
        for (const r of msg.reasoningItems) {
          if (!r.encryptedContent) continue;
          rawInput.push({
            type: 'reasoning',
            ...(r.id ? { id: r.id } : {}),
            encrypted_content: r.encryptedContent,
            summary: r.summary ? [{ type: 'summary_text', text: r.summary }] : [],
          });
        }
      }
      if (typeof msg.content === 'string' && msg.content.length > 0) {
        rawInput.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: msg.content }],
          status: 'completed',
        });
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const callId = tc.id || `call_${ Date.now() }`;
          const args =
            typeof tc.function.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments ?? {});
          rawInput.push({
            type: 'function_call',
            call_id: callId,
            name: tc.function.name,
            arguments: args || '{}',
            status: 'completed',
          });
        }
      }
      continue;
    }

    if (msg.role === 'tool') {
      const output = extractTextFromParts(msg.content);
      rawInput.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output,
        status: 'completed',
      });
    }
  }

  const input = enforceFunctionCallPairing(rawInput);
  const convertedTools = convertTools(opts.tools);

  const candidate: Record<string, unknown> = {
    ...(opts.extraBody ?? {}),
    model: baseModel,
    instructions: instructions && instructions.trim().length > 0 ? instructions : DEFAULT_CODEX_INSTRUCTIONS,
    input,
    stream: true,
    store: false,
    reasoning,
    ...(includeReasoningEncrypted ? { include: ['reasoning.encrypted_content'] } : {}),
    ...(convertedTools ? { tools: convertedTools } : {}),
    ...(convertedTools && opts.streamOptions?.forbidToolCalls ? { tool_choice: 'none' } : {}),
    ...(opts.streamOptions?.chatId ? { prompt_cache_key: opts.streamOptions.chatId } : {}),
  };

  return stripCodexUnsupportedParams(candidate);
}

interface BufferedFunctionCall {
  callId: string;
  itemId: string;
  outputIndex: number | null;
  name: string;
  arguments: string;
  hadDeltas: boolean;
  emitted: boolean;
}

/**
 * Stateful parser for a single OpenAI Responses SSE stream
 * (`response.output_text.delta`, `response.reasoning_summary_text.delta`,
 * `response.output_item.added`, `response.function_call_arguments.delta`,
 * `response.output_item.done`, `response.completed`, `response.failed`).
 */
export class CodexResponsesSseParser {
  private content = '';
  private reasoning = '';
  private reasoningEncryptedContent: string | null = null;
  private reasoningItemId: string | null = null;
  private streamedTextItems = new Set<string>();
  private streamedReasoningItems = new Set<string>();
  private lastSummaryIndexByItem = new Map<string, number>();

  private readonly callsByCallId = new Map<string, BufferedFunctionCall>();
  private readonly callsByItemId = new Map<string, BufferedFunctionCall>();
  private readonly callsByOutputIndex = new Map<number, BufferedFunctionCall>();
  private readonly finalizedToolCalls: PlannerLlmToolCall[] = [];
  private readonly finalizedCallIds = new Set<string>();

  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens: number | null = null;
  private finishReason: string | null = null;
  private sawResponseEvent = false;

  /**
   * Feeds one SSE frame (`event:` + `data:`) into the parser and returns any
   * `PlannerLlmStreamEvent` deltas to yield immediately. Throws `PlannerLlmError`
   * on `response.failed`, `error`, or `usage_limit_reached`.
   */
  feedFrame(rawFrame: string): PlannerLlmStreamEvent[] {
    let eventName = '';
    const dataLines: string[] = [];
    for (const rawLine of rawFrame.split('\n')) {
      const line = rawLine.trimEnd();
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    const dataStr = dataLines.join('\n').trim();
    if (!dataStr || dataStr === '[DONE]') return [];

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      return [];
    }

    const type = (typeof parsed.type === 'string' && parsed.type ? parsed.type : eventName).trim();
    if (!type) return [];

    // Ignore non-standard Codex metadata events (e.g. `codex.rate_limits`).
    if (type.startsWith('codex.')) {
      return [];
    }

    if (type === 'error' || type === 'response.failed' || type === 'response.error') {
      throw this.toStreamError(parsed);
    }

    this.sawResponseEvent = true;
    const out: PlannerLlmStreamEvent[] = [];

    if (type === 'response.output_text.delta') {
      const delta = typeof parsed.delta === 'string' ? parsed.delta : '';
      if (delta.length > 0) {
        const itemId = typeof parsed.item_id === 'string' ? parsed.item_id : 'default';
        this.streamedTextItems.add(itemId);
        this.content += delta;
        out.push({ type: 'text_delta', text: delta });
      }
      return out;
    }

    if (type === 'response.output_text.done') {
      const itemId = typeof parsed.item_id === 'string' ? parsed.item_id : 'default';
      const text = typeof parsed.text === 'string' ? parsed.text : '';
      if (text.length > 0 && !this.streamedTextItems.has(itemId) && this.content.length === 0) {
        this.streamedTextItems.add(itemId);
        this.content += text;
        out.push({ type: 'text_delta', text });
      }
      return out;
    }

    if (
      type === 'response.reasoning_summary_text.delta' ||
      type === 'response.reasoning_text.delta' ||
      type === 'response.reasoning_content_text.delta'
    ) {
      const delta = typeof parsed.delta === 'string' ? parsed.delta : '';
      if (delta.length > 0) {
        const itemId = typeof parsed.item_id === 'string' ? parsed.item_id : 'default';
        const summaryIdx = typeof parsed.summary_index === 'number' ? parsed.summary_index : 0;
        const prevIdx = this.lastSummaryIndexByItem.get(itemId);
        const prefix = prevIdx !== undefined && summaryIdx > prevIdx && this.reasoning.length > 0 ? '\n\n' : '';
        this.lastSummaryIndexByItem.set(itemId, summaryIdx);
        this.streamedReasoningItems.add(itemId);
        const piece = `${prefix}${delta}`;
        this.reasoning += piece;
        out.push({ type: 'thinking_delta', text: piece });
      }
      return out;
    }

    if (type === 'response.output_item.added') {
      const item =
        parsed.item && typeof parsed.item === 'object' ? (parsed.item as Record<string, unknown>) : null;
      if (item && item.type === 'function_call') {
        this.registerFunctionCallItem(item, typeof parsed.output_index === 'number' ? parsed.output_index : null);
      }
      return out;
    }

    if (type === 'response.function_call_arguments.delta') {
      const delta = typeof parsed.delta === 'string' ? parsed.delta : '';
      if (delta.length > 0) {
        const entry = this.findFunctionCallBuffer(parsed);
        if (entry) {
          if (!entry.hadDeltas) {
            entry.arguments = '';
            entry.hadDeltas = true;
          }
          entry.arguments += delta;
        }
      }
      return out;
    }

    if (type === 'response.output_item.done') {
      const item =
        parsed.item && typeof parsed.item === 'object' ? (parsed.item as Record<string, unknown>) : null;
      if (!item) return out;

      if (item.type === 'function_call') {
        this.finalizeFunctionCallItem(item, typeof parsed.output_index === 'number' ? parsed.output_index : null);
        return out;
      }

      if (item.type === 'reasoning') {
        const itemId = typeof item.id === 'string' && item.id ? item.id : null;
        const encrypted =
          typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0
            ? item.encrypted_content
            : null;
        if (encrypted) {
          this.reasoningEncryptedContent = encrypted;
        }
        if (itemId) {
          this.reasoningItemId = itemId;
        }
        const summaryText = this.extractReasoningSummaryText(item);
        const alreadyStreamed = itemId ? this.streamedReasoningItems.has(itemId) : this.reasoning.length > 0;
        if (!alreadyStreamed && summaryText.length > 0) {
          if (itemId) this.streamedReasoningItems.add(itemId);
          const sep = this.reasoning.length > 0 ? '\n\n' : '';
          const piece = `${sep}${summaryText}`;
          this.reasoning += piece;
          out.push({
            type: 'thinking_delta',
            text: piece,
            ...(encrypted ? { encryptedContent: encrypted } : {}),
            ...(itemId ? { reasoningItemId: itemId } : {}),
          });
        } else if (encrypted) {
          out.push({
            type: 'thinking_delta',
            text: '',
            encryptedContent: encrypted,
            ...(itemId ? { reasoningItemId: itemId } : {}),
          });
        }
        return out;
      }

      if (item.type === 'message' && this.content.length === 0) {
        const msgText = this.extractMessageOutputText(item);
        if (msgText.length > 0) {
          const itemId = typeof item.id === 'string' ? item.id : 'default';
          this.streamedTextItems.add(itemId);
          this.content += msgText;
          out.push({ type: 'text_delta', text: msgText });
        }
      }
      return out;
    }

    if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.done') {
      const response =
        parsed.response && typeof parsed.response === 'object'
          ? (parsed.response as Record<string, unknown>)
          : parsed;
      if (response.status === 'failed' || response.error) {
        throw this.toStreamError({ response });
      }
      const outputs = Array.isArray(response.output) ? response.output : [];
      for (let idx = 0; idx < outputs.length; idx++) {
        const rawItem = outputs[idx];
        if (!rawItem || typeof rawItem !== 'object') continue;
        const item = rawItem as Record<string, unknown>;
        if (item.type === 'function_call') {
          this.finalizeFunctionCallItem(item, idx);
        } else if (item.type === 'reasoning') {
          if (
            !this.reasoningEncryptedContent &&
            typeof item.encrypted_content === 'string' &&
            item.encrypted_content.length > 0
          ) {
            this.reasoningEncryptedContent = item.encrypted_content;
          }
          if (!this.reasoningItemId && typeof item.id === 'string' && item.id) {
            this.reasoningItemId = item.id;
          }
          const summaryText = this.extractReasoningSummaryText(item);
          if (this.reasoning.length === 0 && summaryText.length > 0) {
            this.reasoning = summaryText;
            out.push({
              type: 'thinking_delta',
              text: summaryText,
              ...(this.reasoningEncryptedContent ? { encryptedContent: this.reasoningEncryptedContent } : {}),
              ...(this.reasoningItemId ? { reasoningItemId: this.reasoningItemId } : {}),
            });
          }
        } else if (item.type === 'message' && this.content.length === 0) {
          const msgText = this.extractMessageOutputText(item);
          if (msgText.length > 0) {
            this.content += msgText;
            out.push({ type: 'text_delta', text: msgText });
          }
        }
      }

      const usage =
        response.usage && typeof response.usage === 'object'
          ? (response.usage as Record<string, unknown>)
          : null;
      if (usage) {
        if (typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens)) {
          this.inputTokens = usage.input_tokens;
        }
        if (typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens)) {
          this.outputTokens = usage.output_tokens;
        }
        const inputDetails =
          usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
            ? (usage.input_tokens_details as Record<string, unknown>)
            : null;
        if (
          inputDetails &&
          typeof inputDetails.cached_tokens === 'number' &&
          Number.isFinite(inputDetails.cached_tokens)
        ) {
          this.cacheReadTokens = inputDetails.cached_tokens;
        }
      }

      const incompleteDetails =
        response.incomplete_details && typeof response.incomplete_details === 'object'
          ? (response.incomplete_details as Record<string, unknown>)
          : null;
      const incompleteReason =
        typeof incompleteDetails?.reason === 'string' ? incompleteDetails.reason : null;
      if (this.finalizedToolCalls.length > 0) {
        this.finishReason = 'tool_calls';
      } else if (response.status === 'incomplete' && incompleteReason === 'max_output_tokens') {
        this.finishReason = 'length';
      } else if (incompleteReason === 'content_filter') {
        this.finishReason = 'content_filter';
      } else {
        this.finishReason = 'stop';
      }
      return out;
    }

    return out;
  }

  finish(): PlannerLlmCompletion {
    // Flush any registered function calls that arrived via deltas without an explicit output_item.done.
    for (const buf of this.callsByCallId.values()) {
      if (!buf.emitted && buf.name) {
        buf.emitted = true;
        this.finalizedCallIds.add(buf.callId);
        this.finalizedToolCalls.push({
          id: buf.callId,
          type: 'function',
          function: {
            name: buf.name,
            arguments: buf.arguments.trim() || '{}',
          },
        });
      }
    }

    const hasUsage = this.sawResponseEvent && (this.inputTokens > 0 || this.outputTokens > 0);
    const usage: PlannerLlmUsage | null = hasUsage
      ? {
          promptTokens: this.inputTokens,
          completionTokens: this.outputTokens,
          cacheReadTokens: this.cacheReadTokens,
          cacheWriteTokens: null,
          costUsd: null,
        }
      : null;

    const finishReason =
      this.finishReason ?? (this.finalizedToolCalls.length > 0 ? 'tool_calls' : this.sawResponseEvent ? 'stop' : null);

    return {
      content: this.content.length > 0 ? this.content : null,
      toolCalls: this.finalizedToolCalls,
      usage,
      reasoning: this.reasoning.length > 0 ? this.reasoning : null,
      reasoningEncryptedContent: this.reasoningEncryptedContent,
      reasoningItemId: this.reasoningItemId,
      finishReason,
    };
  }

  private registerFunctionCallItem(item: Record<string, unknown>, outputIndex: number | null): BufferedFunctionCall {
    const callId =
      typeof item.call_id === 'string' && item.call_id
        ? item.call_id
        : typeof item.id === 'string' && item.id
          ? item.id
          : `call_${Date.now()}_${this.callsByCallId.size}`;
    const itemId = typeof item.id === 'string' && item.id ? item.id : callId;
    const existing = this.callsByCallId.get(callId) ?? this.callsByItemId.get(itemId);
    if (existing) {
      if (typeof item.name === 'string' && item.name) existing.name = item.name;
      if (!existing.hadDeltas && typeof item.arguments === 'string' && item.arguments) {
        existing.arguments = item.arguments;
      }
      if (outputIndex !== null) this.callsByOutputIndex.set(outputIndex, existing);
      return existing;
    }
    const buf: BufferedFunctionCall = {
      callId,
      itemId,
      outputIndex,
      name: typeof item.name === 'string' ? item.name : '',
      arguments: typeof item.arguments === 'string' ? item.arguments : '',
      hadDeltas: false,
      emitted: false,
    };
    this.callsByCallId.set(callId, buf);
    this.callsByItemId.set(itemId, buf);
    if (outputIndex !== null) {
      this.callsByOutputIndex.set(outputIndex, buf);
    }
    return buf;
  }

  private findFunctionCallBuffer(parsed: Record<string, unknown>): BufferedFunctionCall | null {
    if (typeof parsed.call_id === 'string' && this.callsByCallId.has(parsed.call_id)) {
      return this.callsByCallId.get(parsed.call_id)!;
    }
    if (typeof parsed.item_id === 'string' && this.callsByItemId.has(parsed.item_id)) {
      return this.callsByItemId.get(parsed.item_id)!;
    }
    if (typeof parsed.output_index === 'number' && this.callsByOutputIndex.has(parsed.output_index)) {
      return this.callsByOutputIndex.get(parsed.output_index)!;
    }
    return null;
  }

  private finalizeFunctionCallItem(item: Record<string, unknown>, outputIndex: number | null): void {
    const buf = this.registerFunctionCallItem(item, outputIndex);
    if (buf.emitted || this.finalizedCallIds.has(buf.callId)) return;
    const itemArgs = typeof item.arguments === 'string' ? item.arguments : '';
    const finalArgs = buf.hadDeltas && buf.arguments.length > 0 ? buf.arguments : itemArgs || buf.arguments || '{}';
    buf.arguments = finalArgs;
    buf.emitted = true;
    this.finalizedCallIds.add(buf.callId);
    this.finalizedToolCalls.push({
      id: buf.callId,
      type: 'function',
      function: {
        name: buf.name || (typeof item.name === 'string' ? item.name : 'unknown'),
        arguments: finalArgs,
      },
    });
  }

  private extractReasoningSummaryText(item: Record<string, unknown>): string {
    const summary = Array.isArray(item.summary) ? item.summary : [];
    const parts: string[] = [];
    for (const entry of summary) {
      if (entry && typeof entry === 'object' && typeof (entry as { text?: unknown }).text === 'string') {
        const text = (entry as { text: string }).text;
        if (text.length > 0) parts.push(text);
      }
    }
    return parts.join('\n\n');
  }

  private extractMessageOutputText(item: Record<string, unknown>): string {
    const content = Array.isArray(item.content) ? item.content : [];
    const parts: string[] = [];
    for (const entry of content) {
      if (!entry || typeof entry !== 'object') continue;
      const part = entry as { type?: unknown; text?: unknown };
      if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string' && part.text) {
        parts.push(part.text);
      }
    }
    return parts.join('');
  }

  private toStreamError(parsed: Record<string, unknown>): PlannerLlmError {
    const response =
      parsed.response && typeof parsed.response === 'object'
        ? (parsed.response as Record<string, unknown>)
        : null;
    const errObj =
      (response?.error && typeof response.error === 'object'
        ? (response.error as Record<string, unknown>)
        : null) ??
      (parsed.error && typeof parsed.error === 'object'
        ? (parsed.error as Record<string, unknown>)
        : parsed);

    const code = typeof errObj.code === 'string' ? errObj.code : '';
    const errType = typeof errObj.type === 'string' ? errObj.type : '';
    const rawMsg =
      typeof errObj.message === 'string' && errObj.message
        ? errObj.message
        : JSON.stringify(errObj);

    const isUsageLimit =
      code === 'usage_limit_reached' ||
      errType === 'usage_limit_reached' ||
      rawMsg.toLowerCase().includes('usage_limit_reached') ||
      isQuotaMessage(rawMsg);

    const numericStatus = [errObj.status, errObj.status_code, parsed.status].find(
      (v) => typeof v === 'number' && v >= 400 && v < 600,
    ) as number | undefined;
    const status = isUsageLimit ? 429 : numericStatus;
    const message = `Codex Responses API reported an error${code ? ` (${code})` : ''}: ${rawMsg.slice(0, 500)}`;

    if (isUsageLimit) {
      return new PlannerLlmError(message, 429, { retryable: false });
    }
    if (isContextOverflowMessage(rawMsg)) {
      return new PlannerLlmError(message, status ?? 400, { contextOverflow: true });
    }
    const retryable =
      (status !== undefined && isRetryableStatus(status)) ||
      errType === 'server_error' ||
      code === 'server_error' ||
      /overloaded|at capacity|selected model is at capacity/i.test(rawMsg);
    return new PlannerLlmError(message, status, { retryable });
  }
}
