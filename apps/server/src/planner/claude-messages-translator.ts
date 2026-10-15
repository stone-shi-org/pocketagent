/**
 * PA-149: OpenAI Chat Completions <-> Anthropic Messages API translator for the
 * `claude-oauth` Pocket Agent subscription provider.
 *
 * Adapted in part from OmniRoute (https://github.com/diegosouzapw/OmniRoute):
 *   - open-sse/translator/request/openai-to-claude.ts
 *   - open-sse/translator/response/claude-to-openai.ts
 *   - open-sse/config/anthropicHeaders.ts
 *   - open-sse/executors/claudeIdentity.ts
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

import type { PlannerProviderKind } from '@pocketagent/protocol';
import {
  DEEPSEEK_PROVIDER_DEFAULTS,
  OPENCODE_GO_PROVIDER_DEFAULTS,
} from '@pocketagent/protocol';
import type {
  PlannerCacheControl,
  PlannerChatMessage,
  PlannerLlmProvider,
  PlannerLlmRetryPolicy,
  PlannerLlmStreamEvent,
  PlannerLlmStreamOptions,
  PlannerLlmToolCall,
  PlannerLlmUsage,
  PlannerUserContentPart,
} from './llm-client.js';
import {
  DEFAULT_LLM_RETRY_POLICY,
  PlannerLlmError,
  abortableSleep,
  httpError,
  parseUsage,
  streamError,
} from './llm-client.js';

export const DEFAULT_CLAUDE_CODE_VERSION = '2.1.280';
export const ANTHROPIC_API_VERSION = '2023-06-01';
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 16_384;

export const CLAUDE_CODE_SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

export function buildClaudeCodeBillingHeaderBlock(clientVersion = DEFAULT_CLAUDE_CODE_VERSION): AnthropicTextBlock {
  return {
    type: 'text',
    text: `x-anthropic-billing-header: cc_version=${clientVersion}; cc_entrypoint=cli; cch=00000;`,
  };
}

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
  cache_control?: PlannerCacheControl;
}

export interface AnthropicImageBlock {
  type: 'image';
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string };
  cache_control?: PlannerCacheControl;
}

export interface AnthropicDocumentBlock {
  type: 'document';
  source: {
    type: 'base64';
    media_type: 'application/pdf';
    data: string;
  };
  title?: string;
  cache_control?: PlannerCacheControl;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: PlannerCacheControl;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | AnthropicTextBlock[];
  is_error?: boolean;
  cache_control?: PlannerCacheControl;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

export interface AnthropicToolSpec {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  cache_control?: PlannerCacheControl;
}

export interface TranslatedAnthropicRequest {
  body: Record<string, unknown>;
  betas: string[];
  hasPdfDocument: boolean;
  usesEffortBeta: boolean;
}

function sanitizeToolUseId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'toolu_default';
}

function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url.trim());
  if (!match) return null;
  return {
    mediaType: match[1]!.trim() || 'image/png',
    data: match[2]!.trim(),
  };
}

function extractBase64Pdf(fileData: string): string {
  const trimmed = fileData.trim();
  const match = /^data:[^;,]+;base64,(.+)$/s.exec(trimmed);
  return match ? match[1]!.trim() : trimmed;
}

function convertUserPart(
  part: PlannerUserContentPart,
): { block: AnthropicContentBlock | null; isPdf: boolean } {
  if (part.type === 'text') {
    if (!part.text) return { block: null, isPdf: false };
    return {
      block: {
        type: 'text',
        text: part.text,
        ...(part.cache_control ? { cache_control: part.cache_control } : {}),
      },
      isPdf: false,
    };
  }
  if (part.type === 'image_url') {
    const rawUrl = part.image_url?.url ?? '';
    if (!rawUrl) return { block: null, isPdf: false };
    const parsedData = parseDataUrl(rawUrl);
    if (parsedData) {
      return {
        block: {
          type: 'image',
          source: {
            type: 'base64',
            media_type: parsedData.mediaType,
            data: parsedData.data,
          },
          ...(part.cache_control ? { cache_control: part.cache_control } : {}),
        },
        isPdf: false,
      };
    }
    return {
      block: {
        type: 'image',
        source: { type: 'url', url: rawUrl },
        ...(part.cache_control ? { cache_control: part.cache_control } : {}),
      },
      isPdf: false,
    };
  }
  if (part.type === 'file') {
    const data = extractBase64Pdf(part.file?.file_data ?? '');
    if (!data) return { block: null, isPdf: false };
    return {
      block: {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data,
        },
        ...(part.file?.filename ? { title: part.file.filename } : {}),
        ...(part.cache_control ? { cache_control: part.cache_control } : {}),
      },
      isPdf: true,
    };
  }
  return { block: null, isPdf: false };
}

function convertToolResultMessage(msg: Extract<PlannerChatMessage, { role: 'tool' }>): AnthropicToolResultBlock {
  const toolUseId = sanitizeToolUseId(msg.tool_call_id);
  if (typeof msg.content === 'string') {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: msg.content,
    };
  }
  let cacheControl: PlannerCacheControl | undefined;
  const textParts: AnthropicTextBlock[] = [];
  for (const part of msg.content) {
    if (part.cache_control) cacheControl = part.cache_control;
    if (part.text) {
      textParts.push({ type: 'text', text: part.text });
    }
  }
  const combinedText = textParts.map((p) => p.text).join('');
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: combinedText,
    ...(cacheControl ? { cache_control: cacheControl } : {}),
  };
}

function parseToolInput(rawArguments: string): Record<string, unknown> {
  const trimmed = rawArguments.trim();
  if (!trimmed) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return {};
  }
}

function convertOpenAiTools(tools: readonly unknown[] | undefined): AnthropicToolSpec[] {
  if (!tools || tools.length === 0) return [];
  const out: AnthropicToolSpec[] = [];
  for (const raw of tools) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as {
      type?: unknown;
      function?: { name?: unknown; description?: unknown; parameters?: unknown };
      name?: unknown;
      description?: unknown;
      input_schema?: unknown;
      cache_control?: PlannerCacheControl;
    };
    if (item.function && typeof item.function === 'object') {
      const name = typeof item.function.name === 'string' ? item.function.name.trim() : '';
      if (!name) continue;
      const schema =
        item.function.parameters && typeof item.function.parameters === 'object'
          ? (item.function.parameters as Record<string, unknown>)
          : { type: 'object', properties: {} };
      out.push({
        name,
        ...(typeof item.function.description === 'string' && item.function.description.length > 0
          ? { description: item.function.description }
          : {}),
        input_schema: schema,
        ...(item.cache_control ? { cache_control: item.cache_control } : {}),
      });
    } else if (typeof item.name === 'string' && item.name.trim().length > 0) {
      const schema =
        item.input_schema && typeof item.input_schema === 'object'
          ? (item.input_schema as Record<string, unknown>)
          : { type: 'object', properties: {} };
      out.push({
        name: item.name.trim(),
        ...(typeof item.description === 'string' && item.description.length > 0
          ? { description: item.description }
          : {}),
        input_schema: schema,
        ...(item.cache_control ? { cache_control: item.cache_control } : {}),
      });
    }
  }
  return out;
}

/**
 * Enforces Anthropic's strict `tool_use` -> `tool_result` adjacency contract:
 * 1. Every `assistant` message containing `tool_use` blocks must be followed
 *    immediately by a `user` message whose leading content blocks are the
 *    matching `tool_result` blocks (in order, with a synthetic interrupted
 *    `tool_result` inserted for any missing `tool_use.id`).
 * 2. Any orphan `tool_result` block in a `user` message whose `tool_use_id`
 *    does not match the immediately preceding `assistant` message's `tool_use`
 *    blocks is downgraded to a `[Tool result ...]` text block so Anthropic
 *    never rejects the conversation with 400 `unexpected tool_use_id`.
 */
function normalizeToolAdjacency(messages: AnthropicMessage[]): AnthropicMessage[] {
  const normalized: AnthropicMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const current = messages[i]!;
    if (current.role === 'assistant') {
      const toolUses = current.content.filter(
        (b): b is AnthropicToolUseBlock => b.type === 'tool_use',
      );
      normalized.push(current);
      if (toolUses.length === 0) continue;

      const expectedIds = new Set(toolUses.map((u) => u.id));
      const next = messages[i + 1];
      if (next && next.role === 'user') {
        const matchedResults = new Map<string, AnthropicToolResultBlock>();
        const otherBlocks: AnthropicContentBlock[] = [];
        for (const block of next.content) {
          if (block.type === 'tool_result' && expectedIds.has(block.tool_use_id)) {
            matchedResults.set(block.tool_use_id, block);
          } else if (block.type === 'tool_result') {
            const textContent =
              typeof block.content === 'string'
                ? block.content
                : block.content.map((p) => p.text).join('');
            otherBlocks.push({
              type: 'text',
              text: `[Tool result (${block.tool_use_id}): ${textContent}]`,
              ...(block.cache_control ? { cache_control: block.cache_control } : {}),
            });
          } else {
            otherBlocks.push(block);
          }
        }
        const orderedToolResults: AnthropicToolResultBlock[] = toolUses.map(
          (u) =>
            matchedResults.get(u.id) ?? {
              type: 'tool_result',
              tool_use_id: u.id,
              content: 'Tool execution was interrupted.',
              is_error: true,
            },
        );
        normalized.push({
          role: 'user',
          content: [...orderedToolResults, ...otherBlocks],
        });
        i++; // Consumed `next`
      } else {
        // No user message immediately following tool_use: synthesize one.
        normalized.push({
          role: 'user',
          content: toolUses.map((u) => ({
            type: 'tool_result',
            tool_use_id: u.id,
            content: 'Tool execution was interrupted.',
            is_error: true,
          })),
        });
      }
      continue;
    }

    // `current.role === 'user'`: any tool_result here was not preceded by an
    // assistant tool_use message (since the assistant branch above consumes
    // its immediately-following user message). Convert orphan tool_results to text.
    const cleanedBlocks: AnthropicContentBlock[] = current.content.map((block) => {
      if (block.type !== 'tool_result') return block;
      const textContent =
        typeof block.content === 'string'
          ? block.content
          : block.content.map((p) => p.text).join('');
      return {
        type: 'text',
        text: `[Tool result (${block.tool_use_id}): ${textContent}]`,
        ...(block.cache_control ? { cache_control: block.cache_control } : {}),
      };
    });
    const prev = normalized[normalized.length - 1];
    if (prev && prev.role === 'user') {
      prev.content.push(...cleanedBlocks);
    } else if (cleanedBlocks.length > 0) {
      normalized.push({ role: 'user', content: cleanedBlocks });
    }
  }

  return normalized;
}

function isAdaptiveThinkingModel(model: string): boolean {
  const bare = model.toLowerCase().replace(/^.*\//, '');
  return /^claude-(opus|sonnet)-4-6/.test(bare);
}

function effortBudgetTokens(effort: string): number {
  switch (effort) {
    case 'minimal':
    case 'low':
      return 2_048;
    case 'medium':
      return 8_192;
    case 'high':
      return 16_384;
    case 'xhigh':
    case 'max':
      return 32_768;
    default:
      return 8_192;
  }
}

function mapAdaptiveEffort(model: string, effort: string): 'low' | 'medium' | 'high' | 'max' {
  const bare = model.toLowerCase().replace(/^.*\//, '');
  switch (effort) {
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'xhigh':
    case 'max':
      return /^claude-opus-4-6/.test(bare) ? 'max' : 'high';
    case 'high':
    default:
      return 'high';
  }
}

/**
 * Translates an OpenAI-shaped Pocket Agent chat completion request into an
 * Anthropic `/v1/messages?beta=true` request body and its required beta flags.
 */
export function buildAnthropicMessagesRequest(opts: {
  model: string;
  messages: readonly PlannerChatMessage[];
  tools?: readonly unknown[];
  streamOptions?: PlannerLlmStreamOptions;
  clientVersion?: string;
  /**
   * PA-154: `true` (default) prepends Claude Code billing/identity system blocks
   * and OAuth beta flags for `claude-oauth` subscription providers. `false`
   * omits them for general Anthropic API / DeepSeek / OpenCode endpoints.
   */
  includeClaudeCodeIdentity?: boolean;
}): TranslatedAnthropicRequest {
  const clientVersion = opts.clientVersion ?? DEFAULT_CLAUDE_CODE_VERSION;
  const includeIdentity = opts.includeClaudeCodeIdentity ?? true;

  // 1. Top-level system blocks: for `claude-oauth`, prepend the two required
  //    Claude Code blocks (with no `cache_control` on those two blocks), followed
  //    by Pocket Agent's own system blocks. For general Anthropic API endpoints,
  //    send only Pocket Agent's own system blocks.
  const systemBlocks: AnthropicTextBlock[] = includeIdentity
    ? [
        buildClaudeCodeBillingHeaderBlock(clientVersion),
        { type: 'text', text: CLAUDE_CODE_SYSTEM_IDENTITY },
      ]
    : [];

  const rawConversation: AnthropicMessage[] = [];
  let hasPdfDocument = false;

  const pushToRole = (role: 'user' | 'assistant', blocks: AnthropicContentBlock[]): void => {
    if (blocks.length === 0) return;
    const last = rawConversation[rawConversation.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
    } else {
      rawConversation.push({ role, content: [...blocks] });
    }
  };

  for (const msg of opts.messages) {
    if (msg.role === 'system') {
      if (typeof msg.content === 'string') {
        if (msg.content.length > 0) {
          systemBlocks.push({ type: 'text', text: msg.content });
        }
      } else {
        for (const part of msg.content) {
          if (!part.text) continue;
          systemBlocks.push({
            type: 'text',
            text: part.text,
            ...(part.cache_control ? { cache_control: part.cache_control } : {}),
          });
        }
      }
      continue;
    }

    if (msg.role === 'user') {
      const blocks: AnthropicContentBlock[] = [];
      if (typeof msg.content === 'string') {
        if (msg.content.length > 0) {
          blocks.push({ type: 'text', text: msg.content });
        }
      } else {
        for (const part of msg.content) {
          const converted = convertUserPart(part);
          if (converted.isPdf) hasPdfDocument = true;
          if (converted.block) blocks.push(converted.block);
        }
      }
      pushToRole('user', blocks);
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      if (typeof msg.content === 'string' && msg.content.length > 0) {
        blocks.push({ type: 'text', text: msg.content });
      }
      for (const call of msg.tool_calls ?? []) {
        if (!call.function?.name) continue;
        blocks.push({
          type: 'tool_use',
          id: sanitizeToolUseId(call.id),
          name: call.function.name,
          input: parseToolInput(call.function.arguments ?? ''),
        });
      }
      pushToRole('assistant', blocks);
      continue;
    }

    if (msg.role === 'tool') {
      const toolResultBlock = convertToolResultMessage(msg);
      // Keep tool_result blocks at the front when merging with an existing user turn,
      // or append after any previous tool_result blocks in the same user turn.
      const last = rawConversation[rawConversation.length - 1];
      if (last && last.role === 'user') {
        last.content.push(toolResultBlock);
      } else {
        rawConversation.push({ role: 'user', content: [toolResultBlock] });
      }
    }
  }

  let anthropicMessages = normalizeToolAdjacency(rawConversation);
  if (anthropicMessages.length === 0 || anthropicMessages[0]!.role !== 'user') {
    anthropicMessages = [
      { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
      ...anthropicMessages,
    ];
  }

  const anthropicTools = convertOpenAiTools(opts.tools);
  let maxTokens =
    opts.streamOptions?.maxTokens !== undefined && opts.streamOptions.maxTokens > 0
      ? opts.streamOptions.maxTokens
      : DEFAULT_ANTHROPIC_MAX_TOKENS;

  const effort = opts.streamOptions?.effort ?? null;
  const thinkingExplicitlyOff =
    opts.streamOptions?.thinking === false || effort === 'off' || effort === 'none';

  let thinkingConfig: Record<string, unknown> | undefined;
  let outputConfig: Record<string, unknown> | undefined;
  let usesEffortBeta = false;

  if (!thinkingExplicitlyOff && effort) {
    if (isAdaptiveThinkingModel(opts.model)) {
      thinkingConfig = { type: 'adaptive' };
      outputConfig = { effort: mapAdaptiveEffort(opts.model, effort) };
      usesEffortBeta = true;
    } else {
      const budgetTokens = effortBudgetTokens(effort);
      if (maxTokens <= budgetTokens) {
        maxTokens = budgetTokens + 4_096;
      }
      thinkingConfig = {
        type: 'enabled',
        budget_tokens: budgetTokens,
      };
    }
  }

  const betas = includeIdentity
    ? [
        'claude-code-20250219',
        'oauth-2025-04-20',
        'interleaved-thinking-2025-05-14',
        'fine-grained-tool-streaming-2025-05-14',
        'prompt-caching-scope-2026-01-05',
      ]
    : [
        'interleaved-thinking-2025-05-14',
        'fine-grained-tool-streaming-2025-05-14',
      ];
  if (usesEffortBeta) {
    betas.push('effort-2025-11-24');
  }
  if (hasPdfDocument) {
    betas.push('pdfs-2024-09-25');
  }

  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: maxTokens,
    ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
    messages: anthropicMessages,
    stream: true,
    ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
    ...(anthropicTools.length > 0 && opts.streamOptions?.forbidToolCalls
      ? { tool_choice: { type: 'none' } }
      : {}),
    ...(thinkingConfig ? { thinking: thinkingConfig } : {}),
    ...(outputConfig ? { output_config: outputConfig } : {}),
  };

  return {
    body,
    betas,
    hasPdfDocument,
    usesEffortBeta,
  };
}

export function mapAnthropicStopReason(stopReason: string | null | undefined): string | null {
  if (!stopReason) return null;
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'refusal':
      return 'content_filter';
    default:
      return stopReason;
  }
}

/**
 * Stateful parser for one Anthropic Messages SSE response stream.
 * Yields `text_delta` and `thinking_delta` events as they arrive and finishes
 * with a single `done` event carrying the assembled content, tool calls,
 * usage (including cache read/creation tokens), reasoning, and mapped
 * `finishReason`.
 */
export class AnthropicMessagesSseParser {
  private readonly toolCallsByIndex = new Map<number, { id: string; name: string; args: string }>();
  private contentSoFar = '';
  private reasoningSoFar = '';
  private sawAnyChunk = false;
  private finishReason: string | null = null;
  private readonly rawUsage: Record<string, number> = {};

  feedLine(line: string): PlannerLlmStreamEvent[] {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return [];
    const payload = trimmed.slice(5).trim();
    if (payload.length === 0 || payload === '[DONE]') return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return [];
    }
    if (!parsed || typeof parsed !== 'object') return [];
    this.sawAnyChunk = true;

    const frame = parsed as Record<string, unknown>;
    if (frame.type === 'error' || (frame.error !== undefined && frame.error !== null)) {
      throw streamError(frame.error ?? frame);
    }

    if (frame.type === 'message_start') {
      const msg = frame.message as { usage?: Record<string, unknown> } | undefined;
      this.mergeUsage(msg?.usage);
      return [];
    }

    if (frame.type === 'content_block_start') {
      const index = typeof frame.index === 'number' ? frame.index : 0;
      const block = frame.content_block as Record<string, unknown> | undefined;
      if (!block) return [];
      if (block.type === 'tool_use') {
        const id = typeof block.id === 'string' && block.id ? block.id : `toolu_${index}`;
        const name = typeof block.name === 'string' ? block.name : '';
        const initialInput =
          block.input && typeof block.input === 'object' && Object.keys(block.input).length > 0
            ? JSON.stringify(block.input)
            : '';
        this.toolCallsByIndex.set(index, { id, name, args: initialInput });
        return [];
      }
      if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) {
        this.reasoningSoFar += block.thinking;
        return [{ type: 'thinking_delta', text: block.thinking }];
      }
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        this.contentSoFar += block.text;
        return [{ type: 'text_delta', text: block.text }];
      }
      return [];
    }

    if (frame.type === 'content_block_delta') {
      const index = typeof frame.index === 'number' ? frame.index : 0;
      const delta = frame.delta as Record<string, unknown> | undefined;
      if (!delta) return [];
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
        this.contentSoFar += delta.text;
        return [{ type: 'text_delta', text: delta.text }];
      }
      if (
        delta.type === 'thinking_delta' &&
        typeof delta.thinking === 'string' &&
        delta.thinking.length > 0
      ) {
        this.reasoningSoFar += delta.thinking;
        return [{ type: 'thinking_delta', text: delta.thinking }];
      }
      if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const existing = this.toolCallsByIndex.get(index);
        if (existing) {
          existing.args += delta.partial_json;
        }
        return [];
      }
      return [];
    }

    if (frame.type === 'message_delta') {
      const delta = frame.delta as { stop_reason?: string | null } | undefined;
      if (delta?.stop_reason) {
        this.finishReason = mapAnthropicStopReason(delta.stop_reason);
      }
      this.mergeUsage(frame.usage as Record<string, unknown> | undefined);
      return [];
    }

    return [];
  }

  private mergeUsage(usage: Record<string, unknown> | undefined): void {
    if (!usage || typeof usage !== 'object') return;
    for (const key of [
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
      'prompt_tokens',
      'completion_tokens',
    ]) {
      const val = usage[key];
      if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
        this.rawUsage[key] = val;
      }
    }
  }

  get hasSeenChunk(): boolean {
    return this.sawAnyChunk;
  }

  finish(): Extract<PlannerLlmStreamEvent, { type: 'done' }> {
    const toolCalls: PlannerLlmToolCall[] = Array.from(this.toolCallsByIndex.values())
      .filter((call) => call.name.length > 0)
      .map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: {
          name: call.name,
          arguments: call.args.trim().length > 0 ? call.args : '{}',
        },
      }));
    const content = this.contentSoFar.length > 0 ? this.contentSoFar : null;
    const reasoning = this.reasoningSoFar.length > 0 ? this.reasoningSoFar : null;
    const usage: PlannerLlmUsage | null =
      Object.keys(this.rawUsage).length > 0 ? parseUsage(this.rawUsage) : null;
    return {
      type: 'done',
      content,
      toolCalls,
      usage,
      reasoning,
      finishReason: this.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
    };
  }
}

/**
 * PA-154: On OpenCode Zen (`opencode-zen`) and OpenCode Go (`opencode-go`),
 * Claude models and MiniMax / Qwen3.7 / Qwen3.8 models are served via the
 * Anthropic Messages endpoint (`/v1/messages`) rather than `/v1/chat/completions`.
 */
export function isOpencodeAnthropicOnlyModel(model: string): boolean {
  const bare = model.trim().toLowerCase().replace(/^.*\//, '');
  return /^claude-/.test(bare) || /^minimax-/.test(bare) || /^qwen3\.[78]/.test(bare);
}

export interface AnthropicApiPlannerProviderOptions {
  baseUrl: string;
  anthropicBaseUrl?: string;
  apiKey: string | null;
  providerKind?: PlannerProviderKind;
  fetchImpl?: typeof fetch;
  retry?: Partial<PlannerLlmRetryPolicy>;
}

/**
 * PA-154: General Anthropic Messages API (`/v1/messages`) provider for API-key
 * endpoints (`https://api.anthropic.com`, DeepSeek `/anthropic`, OpenCode Zen/Go,
 * OmniRoute, LiteLLM, etc.). Reuses the Anthropic Messages request translator
 * and SSE parser without injecting Claude Code OAuth identity blocks.
 */
export class AnthropicApiPlannerProvider implements PlannerLlmProvider {
  constructor(private readonly opts: AnthropicApiPlannerProviderOptions) {}

  private messagesUrl(): string {
    let base = (this.opts.anthropicBaseUrl ?? this.opts.baseUrl).trim().replace(/\/+$/, '');
    if (base.endsWith('/v1/messages')) {
      return base;
    }
    if (base.endsWith('/v1')) {
      base = base.slice(0, -'/v1'.length);
    }
    if (this.opts.providerKind === 'deepseek' && !base.endsWith('/anthropic')) {
      base = `${base || 'https://api.deepseek.com'}/anthropic`;
    }
    return `${base}/v1/messages`;
  }

  private modelsCandidateUrls(): string[] {
    const raw = this.opts.baseUrl.trim().replace(/\/+$/, '');
    if (!raw) return [];
    if (raw.endsWith('/v1')) {
      return [`${raw}/models`, `${raw.slice(0, -'/v1'.length)}/models`];
    }
    return [`${raw}/v1/models`, `${raw}/models`];
  }

  private authHeaders(chatId?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'anthropic-version': ANTHROPIC_API_VERSION,
      'user-agent': 'pocketagent/1.0',
    };
    if (this.opts.apiKey) {
      headers['x-api-key'] = this.opts.apiKey;
      headers.authorization = `Bearer ${this.opts.apiKey}`;
    }
    if (
      chatId &&
      (this.opts.providerKind === 'opencode-zen' || this.opts.providerKind === 'opencode-go')
    ) {
      headers['x-opencode-session'] = chatId;
    }
    return headers;
  }

  async listModels(): Promise<string[]> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const urls = this.modelsCandidateUrls();
    let lastError: Error | null = null;

    for (const url of urls) {
      try {
        const res = await fetchImpl(url, {
          method: 'GET',
          headers: this.authHeaders(),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          lastError = new PlannerLlmError(
            `Anthropic LLM endpoint returned ${res.status}: ${body.slice(0, 500)}`,
            res.status,
          );
          continue;
        }
        const parsed = (await res.json()) as { data?: unknown };
        if (Array.isArray(parsed?.data)) {
          const ids = parsed.data
            .map((entry) =>
              entry && typeof entry === 'object' ? String((entry as { id?: unknown }).id ?? '') : '',
            )
            .filter((id) => id.length > 0);
          if (ids.length > 0) return ids;
        }
      } catch (err) {
        lastError =
          err instanceof PlannerLlmError
            ? err
            : new PlannerLlmError(
                `Could not reach the Anthropic LLM endpoint: ${(err as Error).message}`,
              );
      }
    }

    if (this.opts.providerKind === 'opencode-go') {
      return OPENCODE_GO_PROVIDER_DEFAULTS.models.map((m) => m.id);
    }
    if (this.opts.providerKind === 'deepseek') {
      return DEEPSEEK_PROVIDER_DEFAULTS.models.map((m) => m.id);
    }
    throw (
      lastError ??
      new PlannerLlmError("Anthropic LLM endpoint's /models response returned no models.")
    );
  }

  async test(model: string): Promise<{ ok: boolean; message: string; latencyMs: number }> {
    const startedAt = Date.now();
    try {
      let content: string | null = null;
      for await (const chunk of this.streamComplete(
        model,
        [{ role: 'user', content: 'Reply with exactly one word: ok' }],
        undefined,
        undefined,
        { maxTokens: 64, thinking: false },
      )) {
        if (chunk.type === 'done') content = chunk.content;
      }
      return {
        ok: true,
        message: content ? content.trim().slice(0, 200) : '(empty reply)',
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      const message = err instanceof PlannerLlmError ? err.message : (err as Error).message;
      return { ok: false, message, latencyMs: Date.now() - startedAt };
    }
  }

  async *streamComplete(
    model: string,
    messages: PlannerChatMessage[],
    tools?: unknown[],
    signal?: AbortSignal,
    options?: PlannerLlmStreamOptions,
  ): AsyncGenerator<PlannerLlmStreamEvent> {
    const policy = { ...DEFAULT_LLM_RETRY_POLICY, ...this.opts.retry };
    for (let attempt = 0; ; attempt++) {
      let streamedAnything = false;
      try {
        for await (const event of this.streamOnce(model, messages, tools, signal, options)) {
          if (event.type !== 'done') streamedAnything = true;
          yield event;
        }
        return;
      } catch (err) {
        if (signal?.aborted) throw err;
        const error =
          err instanceof PlannerLlmError ? err : new PlannerLlmError((err as Error).message);
        if (streamedAnything || !error.retryable || attempt >= policy.maxRetries) throw error;
        let delayMs: number;
        if (error.retryAfterMs !== null) {
          if (error.retryAfterMs > policy.maxDelayMs) throw error;
          delayMs = error.retryAfterMs;
        } else {
          delayMs =
            Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs) *
            (1 - Math.random() * 0.25);
        }
        delayMs = Math.round(delayMs);
        yield {
          type: 'retry',
          attempt: attempt + 1,
          maxRetries: policy.maxRetries,
          delayMs,
          reason: error.message,
        };
        await abortableSleep(delayMs, signal);
      }
    }
  }

  private async *streamOnce(
    model: string,
    messages: PlannerChatMessage[],
    tools: unknown[] | undefined,
    externalSignal: AbortSignal | undefined,
    options: PlannerLlmStreamOptions | undefined,
  ): AsyncGenerator<PlannerLlmStreamEvent> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const url = this.messagesUrl();

    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    const idleMs = options?.idleTimeoutMs ?? 0;
    let idledOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdle = (): void => {
      if (idleMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idledOut = true;
        controller.abort();
      }, idleMs);
    };
    const idleError = (): PlannerLlmError =>
      new PlannerLlmError(
        `The Anthropic LLM endpoint sent nothing for ${Math.round(idleMs / 1000)}s.`,
        undefined,
        { retryable: true },
      );

    const signal = controller.signal;
    try {
      armIdle();
      const translated = buildAnthropicMessagesRequest({
        model,
        messages,
        tools,
        streamOptions: options,
        includeClaudeCodeIdentity: false,
      });

      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            ...this.authHeaders(options?.chatId),
            ...(translated.betas.length > 0
              ? { 'anthropic-beta': translated.betas.join(',') }
              : {}),
          },
          body: JSON.stringify(translated.body),
          signal,
        });
      } catch (err) {
        const idle = idledOut ? idleError() : null;
        if (idle) throw idle;
        throw new PlannerLlmError(
          `Could not reach the Anthropic LLM endpoint: ${(err as Error).message}`,
          undefined,
          { retryable: !signal.aborted },
        );
      }
      armIdle();

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw httpError('Anthropic LLM endpoint', res.status, body, res.headers);
      }

      const reader = res.body?.getReader();
      if (!reader) {
        throw new PlannerLlmError('Anthropic LLM endpoint returned no readable stream body.');
      }

      const decoder = new TextDecoder();
      const parser = new AnthropicMessagesSseParser();
      let buffer = '';

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          armIdle();
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n');
          while (boundary >= 0) {
            const line = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 1);
            for (const event of parser.feedLine(line)) {
              yield event;
            }
            boundary = buffer.indexOf('\n');
          }
        }
        if (buffer.length > 0) {
          for (const event of parser.feedLine(buffer)) {
            yield event;
          }
        }
      } catch (err) {
        if (err instanceof PlannerLlmError) throw err;
        const idle = idledOut ? idleError() : null;
        if (idle) throw idle;
        throw new PlannerLlmError(
          `Lost connection to the Anthropic LLM endpoint: ${(err as Error).message}`,
          undefined,
          { retryable: !signal.aborted },
        );
      }

      if (!parser.hasSeenChunk) {
        throw new PlannerLlmError('Anthropic LLM endpoint returned an empty stream.', undefined, {
          retryable: true,
        });
      }

      const finalEvent = parser.finish();
      if (
        finalEvent.content === null &&
        finalEvent.toolCalls.length === 0 &&
        finalEvent.reasoning === null
      ) {
        throw new PlannerLlmError(
          'Anthropic LLM response had no message content or tool calls.',
        );
      }

      yield finalEvent;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

