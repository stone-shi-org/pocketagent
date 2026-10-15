/**
 * OpenAI Chat Completions <-> Google Cloud Code Assist (`v1internal:streamGenerateContent?alt=sse`)
 * request and SSE stream translator for Pocket Agent's `antigravity-oauth` provider (PA-151).
 *
 * Ported from OmniRoute (`open-sse/executors/antigravity.ts`,
 * `open-sse/translator/request/openai-to-gemini.ts`,
 * `open-sse/translator/response/gemini-to-openai.ts`,
 * `open-sse/translator/helpers/geminiHelper.ts`,
 * `open-sse/services/antigravityHeaders.ts`,
 * `open-sse/config/antigravityUpstream.ts`):
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

import { randomUUID } from 'node:crypto';
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
 * Fallback Antigravity CLI version when `agy --version` cannot be inspected on
 * the host. Kept in one place per PA-151.
 */
export const DEFAULT_ANTIGRAVITY_CLI_VERSION = '1.3.5';

/**
 * Short default Antigravity `systemInstruction` sent in the `v1internal`
 * envelope. Per PA-151 and OmniRoute (`open-sse/executors/antigravity.ts`),
 * large caller system instructions or competing provider identity lines inside
 * `systemInstruction` can trigger upstream 429s or classifier rejections, so
 * Pocket Agent sends this short header in `systemInstruction` and moves the
 * caller's system prompt into user-turn text.
 */
export const ANTIGRAVITY_DEFAULT_SYSTEM =
  'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.\n' +
  'You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.\n' +
  '**Absolute paths only**\n' +
  '**Proactiveness**';

/**
 * Last-resort fallback sentinel when a historical `tool_use` event in the
 * transcript (for example from a turn that ran on another provider before switching
 * models) lacks a recorded Gemini `thoughtSignature`. Normal Antigravity tool turns
 * record and replay the real `thoughtSignature` on `ToolUseEvent.thoughtSignature`.
 */
export const SKIP_THOUGHT_SIGNATURE_SENTINEL = 'skip_thought_signature_validator';

const MAX_THOUGHT_SIGNATURES = 1000;
const thoughtSignatureCache = new Map<string, string>();

export function rememberAntigravityThoughtSignature(toolCallId: string, signature: string): void {
  if (!toolCallId || !signature) return;
  if (thoughtSignatureCache.has(toolCallId)) {
    thoughtSignatureCache.delete(toolCallId);
  } else if (thoughtSignatureCache.size >= MAX_THOUGHT_SIGNATURES) {
    const oldest = thoughtSignatureCache.keys().next().value;
    if (oldest !== undefined) thoughtSignatureCache.delete(oldest);
  }
  thoughtSignatureCache.set(toolCallId, signature);
}

export function lookupAntigravityThoughtSignature(toolCallId: string): string | undefined {
  const sig = thoughtSignatureCache.get(toolCallId);
  if (sig !== undefined) {
    thoughtSignatureCache.delete(toolCallId);
    thoughtSignatureCache.set(toolCallId, sig);
  }
  return sig;
}

export function clearAntigravityThoughtSignatureCacheForTests(): void {
  thoughtSignatureCache.clear();
}

/**
 * Strips competing identity assertions (e.g. "You are Claude, built by Anthropic")
 * that can cause Code Assist's upstream safety/routing filter to reject the prompt.
 */
export function sanitizeCompetingIdentity(text: string): string {
  if (!text) return '';
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (/^you are claude\b/i.test(trimmed)) return false;
      if (/\banthropic'?s official cli\b/i.test(trimmed)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

/**
 * Sanitizes a tool name to satisfy Gemini's `functionDeclarations[].name` grammar:
 * must start with a letter or underscore, contain only `[a-zA-Z0-9_.\-:]`, and be
 * at most 64 characters long.
 */
export function sanitizeToolNameForGemini(name: string): string {
  if (!name) return 'tool_unnamed';
  let clean = name.replace(/[^a-zA-Z0-9_.\-:]/g, '_');
  if (!/^[a-zA-Z_]/.test(clean)) {
    clean = `t_${clean}`;
  }
  if (clean.length > 64) {
    clean = clean.slice(0, 64);
  }
  return clean;
}

const UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
  'const',
  'additionalProperties',
  'propertyNames',
  'patternProperties',
  'pattern',
  'optional',
  'title',
  'examples',
  'default',
  'format',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'contentMediaType',
  'contentEncoding',
  'if',
  'then',
  'else',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'dependencies',
  'dependentSchemas',
  'dependentRequired',
  'unevaluatedProperties',
  'unevaluatedItems',
  'readOnly',
  'writeOnly',
  'deprecated',
]);

/**
 * Cleans an arbitrary JSON Schema for Google Cloud Code Assist / Gemini tool
 * declarations (`cleanJSONSchemaForAntigravity` from OmniRoute's `geminiHelper.ts`):
 * - Inlines local `$ref` pointers against `$defs` / `definitions`
 * - Flattens `anyOf` / `oneOf` into the primary non-null branch (`nullable: true`)
 * - Converts `const` into single-element `enum`
 * - Converts `type: ['string', 'null']` into `type: 'string', nullable: true`
 * - Removes unsupported validation keywords (`additionalProperties`, `format`, `default`, `minLength`, etc.)
 * - Ensures `OBJECT` schemas have at least one property (`_` placeholder when empty)
 * - Ensures `ARRAY` schemas always carry `items`
 *
 * Pocket Agent still validates tool arguments server-side before executing any
 * tool, so relaxing schema constraints for the upstream wire format loses nothing.
 */
export function cleanJSONSchemaForAntigravity(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return {
      type: 'object',
      properties: {
        _: { type: 'boolean', description: 'Placeholder property (unused)' },
      },
    };
  }

  let cloned: Record<string, unknown>;
  try {
    cloned = structuredClone(schema as Record<string, unknown>);
  } catch {
    cloned = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  }

  const defs: Record<string, unknown> = {
    ...(cloned.$defs && typeof cloned.$defs === 'object' ? (cloned.$defs as Record<string, unknown>) : {}),
    ...(cloned.definitions && typeof cloned.definitions === 'object'
      ? (cloned.definitions as Record<string, unknown>)
      : {}),
  };

  function resolveRef(ref: string): Record<string, unknown> | null {
    const prefixes = ['#/$defs/', '#/definitions/'];
    for (const prefix of prefixes) {
      if (ref.startsWith(prefix)) {
        const name = ref.slice(prefix.length);
        const target = defs[name];
        if (target && typeof target === 'object' && !Array.isArray(target)) {
          return JSON.parse(JSON.stringify(target)) as Record<string, unknown>;
        }
      }
    }
    return null;
  }

  function cleanNode(node: unknown, seenRefs: Set<string>): unknown {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) {
      return node.map((item) => cleanNode(item, seenRefs));
    }

    let obj = { ...(node as Record<string, unknown>) };

    // 1. Inline $ref when possible.
    if (typeof obj.$ref === 'string') {
      const refStr = obj.$ref;
      delete obj.$ref;
      if (!seenRefs.has(refStr)) {
        const resolved = resolveRef(refStr);
        if (resolved) {
          const nextSeen = new Set(seenRefs);
          nextSeen.add(refStr);
          const cleanedResolved = cleanNode(resolved, nextSeen);
          if (cleanedResolved && typeof cleanedResolved === 'object' && !Array.isArray(cleanedResolved)) {
            obj = { ...(cleanedResolved as Record<string, unknown>), ...obj };
          }
        }
      }
      if (!obj.type) {
        obj.type = 'object';
      }
    }

    // 2. Flatten allOf by merging object branches.
    if (Array.isArray(obj.allOf)) {
      const branches = obj.allOf.map((b) => cleanNode(b, seenRefs));
      delete obj.allOf;
      const mergedProps: Record<string, unknown> = {};
      const mergedReq = new Set<string>();
      for (const b of branches) {
        if (b && typeof b === 'object' && !Array.isArray(b)) {
          const branchObj = b as Record<string, unknown>;
          if (branchObj.type && !obj.type) obj.type = branchObj.type;
          if (branchObj.description && !obj.description) obj.description = branchObj.description;
          if (branchObj.properties && typeof branchObj.properties === 'object') {
            Object.assign(mergedProps, branchObj.properties);
          }
          if (Array.isArray(branchObj.required)) {
            for (const r of branchObj.required) {
              if (typeof r === 'string') mergedReq.add(r);
            }
          }
        }
      }
      if (Object.keys(mergedProps).length > 0) {
        obj.properties = {
          ...mergedProps,
          ...(obj.properties && typeof obj.properties === 'object' ? (obj.properties as Record<string, unknown>) : {}),
        };
      }
      if (mergedReq.size > 0) {
        const existingReq = Array.isArray(obj.required) ? (obj.required as string[]) : [];
        obj.required = Array.from(new Set([...mergedReq, ...existingReq]));
      }
    }

    // 3. Flatten anyOf / oneOf into primary non-null branch (or merged enum if all branches are const/enum).
    for (const unionKey of ['anyOf', 'oneOf'] as const) {
      const unionBranches = obj[unionKey];
      if (Array.isArray(unionBranches) && unionBranches.length > 0) {
        const nonNullBranches = unionBranches.filter((b) => {
          if (!b || typeof b !== 'object') return true;
          const bo = b as Record<string, unknown>;
          return bo.type !== 'null' && bo.const !== null;
        });
        const hadNull = nonNullBranches.length < unionBranches.length;
        const collectedEnums: string[] = [];
        let allConstOrEnum = nonNullBranches.length > 0;
        for (const b of nonNullBranches) {
          if (!b || typeof b !== 'object') {
            allConstOrEnum = false;
            break;
          }
          const bo = b as Record<string, unknown>;
          if (bo.const !== undefined && bo.const !== null) {
            collectedEnums.push(String(bo.const));
          } else if (Array.isArray(bo.enum)) {
            for (const ev of bo.enum) {
              if (ev !== null && ev !== undefined) collectedEnums.push(String(ev));
            }
          } else {
            allConstOrEnum = false;
            break;
          }
        }
        delete obj[unionKey];
        if (allConstOrEnum && collectedEnums.length > 0) {
          obj.type = 'string';
          obj.enum = Array.from(new Set(collectedEnums));
        } else {
          const chosen = nonNullBranches[0] ?? unionBranches[0];
          const cleanedChosen = cleanNode(chosen, seenRefs);
          if (cleanedChosen && typeof cleanedChosen === 'object' && !Array.isArray(cleanedChosen)) {
            const parentDesc = obj.description;
            obj = { ...(cleanedChosen as Record<string, unknown>), ...obj };
            if (parentDesc) obj.description = parentDesc;
          }
        }
        if (hadNull) {
          obj.nullable = true;
        }
      }
    }

    // 4. Convert const -> enum.
    if (obj.const !== undefined && obj.const !== null && !obj.enum) {
      obj.enum = [String(obj.const)];
      if (!obj.type) obj.type = 'string';
    }

    // 5. Convert array type e.g. ['string', 'null'] -> 'string' + nullable.
    if (Array.isArray(obj.type)) {
      const types = obj.type.filter((t): t is string => typeof t === 'string');
      const nonNull = types.filter((t) => t !== 'null');
      obj.type = nonNull[0] ?? 'string';
      if (nonNull.length < types.length) {
        obj.nullable = true;
      }
    }

    // 6. Normalize enum values to strings.
    if (Array.isArray(obj.enum)) {
      const nonNullEnums = obj.enum.filter((v) => v !== null && v !== undefined).map((v) => String(v));
      if (nonNullEnums.length > 0) {
        obj.enum = nonNullEnums;
        if (!obj.type) obj.type = 'string';
      } else {
        delete obj.enum;
      }
    }

    // 7. Strip unsupported keywords.
    for (const key of Object.keys(obj)) {
      if (UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
        delete obj[key];
      }
    }

    // 8. Recursively clean properties and items.
    if (obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)) {
      const cleanedProps: Record<string, unknown> = {};
      for (const [propKey, propVal] of Object.entries(obj.properties as Record<string, unknown>)) {
        cleanedProps[propKey] = cleanNode(propVal, seenRefs);
      }
      obj.properties = cleanedProps;
      if (!obj.type) {
        obj.type = 'object';
      }
    }

    if (obj.items !== undefined) {
      if (Array.isArray(obj.items)) {
        // Tuple validation is unsupported by Gemini; take the first item schema or string.
        obj.items = obj.items.length > 0 ? cleanNode(obj.items[0], seenRefs) : { type: 'string' };
      } else if (obj.items && typeof obj.items === 'object') {
        obj.items = cleanNode(obj.items, seenRefs);
      } else {
        obj.items = { type: 'string' };
      }
    }

    if (typeof obj.type === 'string') {
      obj.type = obj.type.toLowerCase();
    }

    // 9. Ensure array schemas have items.
    if (obj.type === 'array') {
      if (!obj.items || typeof obj.items !== 'object' || Object.keys(obj.items as Record<string, unknown>).length === 0) {
        obj.items = { type: 'string' };
      }
    }

    // 10. Ensure object schemas have non-empty properties and valid required list.
    if (obj.type === 'object' || obj.properties !== undefined) {
      obj.type = 'object';
      const props =
        obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)
          ? (obj.properties as Record<string, unknown>)
          : {};
      if (Object.keys(props).length === 0) {
        obj.properties = {
          _: {
            type: 'boolean',
            description: 'Placeholder property (unused)',
          },
        };
        delete obj.required;
      } else {
        obj.properties = props;
        if (Array.isArray(obj.required)) {
          const validReq = obj.required.filter(
            (k): k is string => typeof k === 'string' && Object.prototype.hasOwnProperty.call(props, k),
          );
          if (validReq.length > 0) {
            obj.required = validReq;
          } else {
            delete obj.required;
          }
        } else {
          delete obj.required;
        }
      }
    } else {
      delete obj.required;
    }

    if (!obj.type) {
      obj.type = 'string';
    }

    return obj;
  }

  const result = cleanNode(cloned, new Set()) as Record<string, unknown>;
  if (result.type !== 'object') {
    return {
      type: 'object',
      properties: {
        _: { type: 'boolean', description: 'Placeholder property (unused)' },
      },
    };
  }
  return result;
}

const ANTIGRAVITY_MODEL_ALIASES: Readonly<Record<string, string>> = {
  'gemini-3-pro-preview': 'gemini-3.1-pro-high',
  'gemini-3-pro-high': 'gemini-3.1-pro-high',
  'gemini-3-pro-low': 'gemini-3.1-pro-low',
  'gemini-3-flash-preview': 'gemini-3-flash',
  'claude-sonnet-4-6-thinking': 'claude-sonnet-4-6',
  'claude-opus-4-6': 'claude-opus-4-6-thinking',
  'claude-opus-4-5': 'claude-opus-4-6-thinking',
  'claude-opus-4-5-thinking': 'claude-opus-4-6-thinking',
  'claude-sonnet-4-5': 'claude-sonnet-4-6',
  'claude-sonnet-4-5-thinking': 'claude-sonnet-4-6',
  'gpt-oss-120b': 'gpt-oss-120b-medium',
};

export type AntigravityEffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high';

const EFFORT_SUFFIXES: Readonly<Record<string, AntigravityEffortLevel>> = {
  '-none': 'none',
  '-minimal': 'minimal',
  '-low': 'low',
  '-medium': 'medium',
  '-high': 'high',
  '-xhigh': 'high',
  '-max': 'high',
};

/**
 * Models where `-high` / `-low` / `-medium` is part of the actual upstream Code Assist
 * model ID rather than a client-side synthetic suffix to strip.
 */
const NATIVE_TIERED_MODEL_PREFIXES = [
  'gemini-3.7-flash-',
  'gemini-3.1-pro-',
  'gemini-3-pro-',
  'fable-5.1-',
  'gpt-oss-120b-',
];

export function resolveAntigravityUpstreamModel(
  rawModel: string,
  explicitEffort?: string | null,
): {
  upstreamModel: string;
  effort: AntigravityEffortLevel | null;
} {
  const trimmed = rawModel.trim().replace(/^antigravity\//i, '');
  const lower = trimmed.toLowerCase();

  if (ANTIGRAVITY_MODEL_ALIASES[lower]) {
    const mapped = ANTIGRAVITY_MODEL_ALIASES[lower]!;
    return {
      upstreamModel: mapped,
      effort: normalizeAntigravityEffort(explicitEffort),
    };
  }

  const isNativeTiered = NATIVE_TIERED_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
  if (!isNativeTiered) {
    for (const [suffix, effort] of Object.entries(EFFORT_SUFFIXES)) {
      if (lower.endsWith(suffix) && trimmed.length > suffix.length) {
        const base = trimmed.slice(0, trimmed.length - suffix.length);
        const baseAlias = ANTIGRAVITY_MODEL_ALIASES[base.toLowerCase()] ?? base;
        return {
          upstreamModel: baseAlias,
          effort: normalizeAntigravityEffort(explicitEffort) ?? effort,
        };
      }
    }
  }

  return {
    upstreamModel: trimmed,
    effort: normalizeAntigravityEffort(explicitEffort),
  };
}

export function normalizeAntigravityEffort(raw: string | null | undefined): AntigravityEffortLevel | null {
  if (!raw) return null;
  const lower = raw.trim().toLowerCase();
  if (lower === 'off' || lower === 'none') return 'none';
  if (lower === 'minimal') return 'minimal';
  if (lower === 'low') return 'low';
  if (lower === 'medium') return 'medium';
  if (lower === 'high' || lower === 'xhigh' || lower === 'max' || lower === 'ultra') return 'high';
  return null;
}

export function isAntigravityThinkingModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower === 'auto' ||
    lower.includes('thinking') ||
    lower.startsWith('gemini-2.5-') ||
    lower.startsWith('gemini-3') ||
    lower.startsWith('fable-') ||
    lower.startsWith('opus-') ||
    lower.startsWith('claude-sonnet-4-6') ||
    lower.startsWith('claude-opus-')
  );
}

const THINKING_BUDGETS: Readonly<Record<AntigravityEffortLevel, number>> = {
  none: 0,
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 24576,
};

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: {
    id?: string;
    name: string;
    args: Record<string, unknown>;
  };
  functionResponse?: {
    id?: string;
    name: string;
    response: Record<string, unknown>;
  };
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface AntigravityGeminiEnvelope {
  project: string;
  model: string;
  userAgent: 'antigravity';
  requestType: 'agent';
  requestId: string;
  request: {
    contents: GeminiContent[];
    systemInstruction: {
      role: 'user';
      parts: Array<{ text: string }>;
    };
    tools?: Array<{
      functionDeclarations: Array<{
        name: string;
        description: string;
        parameters: Record<string, unknown>;
      }>;
    }>;
    toolConfig?: {
      functionCallingConfig: {
        mode: 'AUTO' | 'NONE';
      };
    };
    generationConfig?: Record<string, unknown>;
    sessionId?: string;
  };
}

export interface BuiltAntigravityRequest {
  envelope: AntigravityGeminiEnvelope;
  /** Maps sanitized Gemini tool names back to Pocket Agent's original tool names. */
  toolNameMap: ReadonlyMap<string, string>;
}

function extractTextFromMessageContent(
  content: string | PlannerTextContentPart[] | PlannerUserContentPart[] | null | undefined,
): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  const chunks: string[] = [];
  for (const part of content) {
    if (part.type === 'text' && part.text) {
      chunks.push(part.text);
    }
  }
  return chunks.join('\n');
}

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url.trim());
  if (!match) return null;
  return {
    mimeType: match[1]!.trim() || 'image/png',
    data: match[2]!.trim(),
  };
}

function convertUserContentToParts(content: string | PlannerUserContentPart[]): GeminiPart[] {
  if (typeof content === 'string') {
    return content ? [{ text: content }] : [];
  }
  const parts: GeminiPart[] = [];
  for (const item of content) {
    if (item.type === 'text') {
      if (item.text) {
        parts.push({ text: item.text });
      }
    } else if (item.type === 'image_url' && item.image_url?.url) {
      const parsed = parseDataUrl(item.image_url.url);
      if (parsed) {
        parts.push({
          inlineData: {
            mimeType: parsed.mimeType,
            data: parsed.data,
          },
        });
      }
    } else if (item.type === 'file' && item.file?.file_data) {
      const parsed = parseDataUrl(item.file.file_data);
      if (parsed) {
        parts.push({
          inlineData: {
            mimeType: parsed.mimeType || 'application/pdf',
            data: parsed.data,
          },
        });
      } else {
        parts.push({
          inlineData: {
            mimeType: 'application/pdf',
            data: item.file.file_data,
          },
        });
      }
    }
  }
  return parts;
}

/**
 * Converts Pocket Agent's OpenAI-shaped `PlannerChatMessage[]` and tool schemas
 * into Google Cloud Code Assist's `v1internal:streamGenerateContent` request envelope.
 */
export function buildAntigravityGeminiRequest(params: {
  project: string;
  model: string;
  messages: PlannerChatMessage[];
  tools?: unknown[];
  options?: PlannerLlmStreamOptions;
}): BuiltAntigravityRequest {
  const { upstreamModel, effort } = resolveAntigravityUpstreamModel(params.model, params.options?.effort);

  const toolNameMap = new Map<string, string>();
  const reverseToolNameMap = new Map<string, string>();
  const functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }> = [];

  if (Array.isArray(params.tools)) {
    for (const rawTool of params.tools) {
      if (!rawTool || typeof rawTool !== 'object') continue;
      const t = rawTool as Record<string, unknown>;
      const fn = (t.type === 'function' && t.function && typeof t.function === 'object'
        ? t.function
        : t) as Record<string, unknown>;
      const originalName = typeof fn.name === 'string' ? fn.name.trim() : '';
      if (!originalName) continue;
      const sanitizedName = sanitizeToolNameForGemini(originalName);
      toolNameMap.set(sanitizedName, originalName);
      reverseToolNameMap.set(originalName, sanitizedName);
      const description = typeof fn.description === 'string' ? fn.description : '';
      const rawSchema = fn.parameters ?? fn.input_schema ?? { type: 'object', properties: {} };
      functionDeclarations.push({
        name: sanitizedName,
        description,
        parameters: cleanJSONSchemaForAntigravity(rawSchema),
      });
    }
  }

  // Map tool_call_id -> sanitized tool name so `role: 'tool'` results can populate `functionResponse.name`.
  const toolCallIdToName = new Map<string, string>();
  for (const msg of params.messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.id && tc.function?.name) {
          const sanitized = reverseToolNameMap.get(tc.function.name) ?? sanitizeToolNameForGemini(tc.function.name);
          toolCallIdToName.set(tc.id, sanitized);
        }
      }
    }
  }

  // Collect any `role: 'system'` messages still present in `messages` (e.g. from
  // `test()`, `compactChat()`, or direct callers) so they can be prepended to the
  // first `user` turn. `PlannerChatService.buildTurnContext` already places the
  // stable system prefix into the first user message for `antigravity-oauth` turns.
  const residualSystemChunks: string[] = [];
  const rawContents: GeminiContent[] = [];

  for (const msg of params.messages) {
    if (msg.role === 'system') {
      const text = sanitizeCompetingIdentity(extractTextFromMessageContent(msg.content));
      if (text) residualSystemChunks.push(text);
      continue;
    }

    if (msg.role === 'user') {
      const parts = convertUserContentToParts(msg.content);
      if (parts.length === 0) {
        parts.push({ text: '' });
      }
      rawContents.push({ role: 'user', parts });
      continue;
    }

    if (msg.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (typeof msg.content === 'string' && msg.content) {
        parts.push({ text: msg.content });
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let parsedArgs: Record<string, unknown> = {};
          if (typeof tc.function?.arguments === 'string' && tc.function.arguments.trim()) {
            try {
              const parsed = JSON.parse(tc.function.arguments) as unknown;
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                parsedArgs = parsed as Record<string, unknown>;
              }
            } catch {
              parsedArgs = {};
            }
          }
          const sanitizedName =
            reverseToolNameMap.get(tc.function.name) ?? sanitizeToolNameForGemini(tc.function.name);
          const signature =
            tc.thoughtSignature ||
            lookupAntigravityThoughtSignature(tc.id) ||
            SKIP_THOUGHT_SIGNATURE_SENTINEL;
          if (tc.thoughtSignature) {
            rememberAntigravityThoughtSignature(tc.id, tc.thoughtSignature);
          }
          parts.push({
            thoughtSignature: signature,
            functionCall: {
              id: tc.id,
              name: sanitizedName,
              args: parsedArgs,
            },
          });
        }
      }
      if (parts.length > 0) {
        rawContents.push({ role: 'model', parts });
      }
      continue;
    }

    if (msg.role === 'tool') {
      const resultText = extractTextFromMessageContent(msg.content);
      const toolName = toolCallIdToName.get(msg.tool_call_id) ?? 'tool_response';
      rawContents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: msg.tool_call_id,
              name: toolName,
              response: {
                result: resultText || '(empty output)',
              },
            },
          },
        ],
      });
    }
  }

  // Merge consecutive same-role turns (`user` + `user`, `model` + `model`) as required by Gemini.
  const contents: GeminiContent[] = [];
  for (const turn of rawContents) {
    const prev = contents[contents.length - 1];
    if (prev && prev.role === turn.role) {
      prev.parts.push(...turn.parts);
    } else {
      contents.push({
        role: turn.role,
        parts: [...turn.parts],
      });
    }
  }

  // Ensure the conversation starts with a `user` turn.
  if (contents.length === 0 || contents[0]!.role !== 'user') {
    contents.unshift({
      role: 'user',
      parts: [{ text: residualSystemChunks.length > 0 ? residualSystemChunks.join('\n\n') : '.' }],
    });
    residualSystemChunks.length = 0;
  }

  // Prepend any residual system messages to the first user message's first text part.
  if (residualSystemChunks.length > 0) {
    const systemPrefix = residualSystemChunks.join('\n\n');
    const firstTurn = contents[0]!;
    const firstPart = firstTurn.parts[0];
    if (firstPart && typeof firstPart.text === 'string' && !firstPart.functionResponse) {
      firstPart.text = firstPart.text ? `${systemPrefix}\n\n${firstPart.text}` : systemPrefix;
    } else {
      firstTurn.parts.unshift({ text: systemPrefix });
    }
  }

  // Ensure every turn has at least one non-empty part.
  for (const turn of contents) {
    if (turn.parts.length === 0) {
      turn.parts.push({ text: '.' });
    }
  }

  // Thinking models reject a conversation ending on a `model` turn when no thought block is attached.
  if (
    contents.length > 1 &&
    contents[contents.length - 1]!.role === 'model' &&
    isAntigravityThinkingModel(upstreamModel)
  ) {
    contents.pop();
  }

  const generationConfig: Record<string, unknown> = {};
  const maxOutputTokens =
    typeof params.options?.maxTokens === 'number' && params.options.maxTokens > 0
      ? params.options.maxTokens
      : 32000;
  generationConfig.maxOutputTokens = maxOutputTokens;

  if (effort !== null && isAntigravityThinkingModel(upstreamModel)) {
    const lowerModel = upstreamModel.toLowerCase();
    const isGemini3 = lowerModel.startsWith('gemini-3');
    if (effort === 'none') {
      if (!lowerModel.includes('thinking') && !lowerModel.startsWith('opus-')) {
        generationConfig.thinkingConfig = {
          includeThoughts: false,
          thinkingBudget: 0,
        };
      }
    } else if (isGemini3) {
      generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingLevel: effort === 'minimal' ? 'LOW' : effort.toUpperCase(),
      };
    } else {
      const budget = Math.min(THINKING_BUDGETS[effort] ?? 8192, Math.max(1024, maxOutputTokens - 1024));
      generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: budget,
      };
    }
  } else if (params.options?.thinking === true && isAntigravityThinkingModel(upstreamModel)) {
    const lowerModel = upstreamModel.toLowerCase();
    if (!lowerModel.startsWith('gemini-3')) {
      generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: 8192,
      };
    }
  }

  const sessionId = params.options?.chatId || `session-${randomUUID()}`;

  const envelope: AntigravityGeminiEnvelope = {
    project: params.project,
    model: upstreamModel,
    userAgent: 'antigravity',
    requestType: 'agent',
    requestId: `agent-${randomUUID()}`,
    request: {
      contents,
      systemInstruction: {
        role: 'user',
        parts: [{ text: ANTIGRAVITY_DEFAULT_SYSTEM }],
      },
      ...(functionDeclarations.length > 0
        ? {
            tools: [{ functionDeclarations }],
            toolConfig: {
              functionCallingConfig: {
                mode: params.options?.forbidToolCalls ? 'NONE' : 'AUTO',
              },
            },
          }
        : {}),
      generationConfig,
      sessionId,
    },
  };

  return { envelope, toolNameMap };
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/**
 * Incremental SSE parser for Google Cloud Code Assist `v1internal:streamGenerateContent?alt=sse`.
 * Each `data: ...` line carries `{ response: { candidates, usageMetadata, ... } }`.
 */
export class AntigravityGeminiSseParser {
  private buffer = '';
  private textChunks: string[] = [];
  private reasoningChunks: string[] = [];
  private toolCalls: PlannerLlmToolCall[] = [];
  private usage: PlannerLlmUsage | null = null;
  private upstreamFinishReason: string | null = null;
  private seenChunk = false;
  private readonly toolNameMap: ReadonlyMap<string, string>;

  constructor(toolNameMap?: ReadonlyMap<string, string>) {
    this.toolNameMap = toolNameMap ?? new Map();
  }

  get hasSeenChunk(): boolean {
    return this.seenChunk;
  }

  feed(chunk: string): PlannerLlmStreamEvent[] {
    this.buffer += chunk;
    const events: PlannerLlmStreamEvent[] = [];
    let newlineIdx = this.buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const rawLine = this.buffer.slice(0, newlineIdx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newlineIdx + 1);
      this.processLine(rawLine, events);
      newlineIdx = this.buffer.indexOf('\n');
    }
    return events;
  }

  finish(): PlannerLlmCompletion {
    if (this.buffer.trim().length > 0) {
      const remaining = this.buffer.replace(/\r$/, '');
      this.buffer = '';
      const ignored: PlannerLlmStreamEvent[] = [];
      for (const line of remaining.split('\n')) {
        this.processLine(line.replace(/\r$/, ''), ignored);
      }
    }

    let finishReason: string | null = 'stop';
    if (this.toolCalls.length > 0) {
      finishReason = 'tool_calls';
    } else if (this.upstreamFinishReason) {
      const upper = this.upstreamFinishReason.toUpperCase();
      if (upper === 'MAX_TOKENS') {
        finishReason = 'length';
      } else if (upper === 'STOP') {
        finishReason = 'stop';
      } else {
        finishReason = this.upstreamFinishReason.toLowerCase();
      }
    }

    return {
      content: this.textChunks.length > 0 ? this.textChunks.join('') : null,
      toolCalls: this.toolCalls,
      usage: this.usage,
      reasoning: this.reasoningChunks.length > 0 ? this.reasoningChunks.join('') : null,
      finishReason,
    };
  }

  private processLine(line: string, out: PlannerLlmStreamEvent[]): void {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) return;
    const payloadStr = trimmed.slice(5).trim();
    if (!payloadStr || payloadStr === '[DONE]') return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payloadStr) as Record<string, unknown>;
    } catch {
      return;
    }

    this.seenChunk = true;

    if (parsed.error && typeof parsed.error === 'object') {
      const errObj = parsed.error as Record<string, unknown>;
      const status = typeof errObj.code === 'number' ? errObj.code : 500;
      const msg = formatAntigravityErrorMessage(status, JSON.stringify(parsed));
      const { retryAfterMs } = parseAntigravityRetryResetInfo(JSON.stringify(parsed));
      throw new PlannerLlmError(msg, status, {
        retryable: isRetryableStatus(status) && !isQuotaMessage(msg),
        contextOverflow: isContextOverflowMessage(msg),
        retryAfterMs,
      });
    }

    const inner =
      parsed.response && typeof parsed.response === 'object'
        ? (parsed.response as Record<string, unknown>)
        : parsed;

    if (inner.usageMetadata && typeof inner.usageMetadata === 'object') {
      const u = inner.usageMetadata as Record<string, unknown>;
      const promptTokens = nonNegativeInt(u.promptTokenCount) ?? 0;
      const candidatesTokens = nonNegativeInt(u.candidatesTokenCount) ?? 0;
      const thoughtsTokens = nonNegativeInt(u.thoughtsTokenCount) ?? 0;
      const cachedTokens = nonNegativeInt(u.cachedContentTokenCount);
      this.usage = {
        promptTokens,
        completionTokens: candidatesTokens + thoughtsTokens,
        cacheReadTokens: cachedTokens,
        cacheWriteTokens: null,
      };
    }

    const candidates = Array.isArray(inner.candidates) ? inner.candidates : [];
    const candidate = candidates[0] as Record<string, unknown> | undefined;
    if (!candidate || typeof candidate !== 'object') return;

    if (typeof candidate.finishReason === 'string' && candidate.finishReason) {
      this.upstreamFinishReason = candidate.finishReason;
    }

    const content = candidate.content as Record<string, unknown> | undefined;
    const parts = content && Array.isArray(content.parts) ? content.parts : [];

    let pendingThoughtSignature: string | undefined;

    for (const rawPart of parts) {
      if (!rawPart || typeof rawPart !== 'object') continue;
      const part = rawPart as Record<string, unknown>;

      const partSignature =
        typeof part.thoughtSignature === 'string' && part.thoughtSignature
          ? part.thoughtSignature
          : typeof part.thought_signature === 'string' && part.thought_signature
            ? part.thought_signature
            : undefined;
      if (partSignature) {
        pendingThoughtSignature = partSignature;
      }

      if (part.thought === true) {
        const thoughtText = typeof part.text === 'string' ? part.text : '';
        if (thoughtText) {
          this.reasoningChunks.push(thoughtText);
          out.push({ type: 'thinking_delta', text: thoughtText });
        }
        continue;
      }

      if (typeof part.text === 'string' && part.text.length > 0) {
        this.textChunks.push(part.text);
        out.push({ type: 'text_delta', text: part.text });
        continue;
      }

      if (part.functionCall && typeof part.functionCall === 'object') {
        const fc = part.functionCall as Record<string, unknown>;
        const rawName = typeof fc.name === 'string' ? fc.name : 'unknown_tool';
        const restoredName = this.toolNameMap.get(rawName) ?? rawName;
        const callId =
          typeof fc.id === 'string' && fc.id.trim()
            ? fc.id.trim()
            : `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        const argsObj = fc.args && typeof fc.args === 'object' ? { ...(fc.args as Record<string, unknown>) } : {};
        // Strip the synthetic placeholder property if the model echoed it on a parameterless tool.
        if (Object.keys(argsObj).length === 1 && argsObj._ !== undefined) {
          delete argsObj._;
        }
        const signature = partSignature ?? pendingThoughtSignature;
        if (signature) {
          rememberAntigravityThoughtSignature(callId, signature);
        }
        this.toolCalls.push({
          id: callId,
          type: 'function',
          function: {
            name: restoredName,
            arguments: JSON.stringify(argsObj),
          },
          ...(signature ? { thoughtSignature: signature } : {}),
        });
      }
    }
  }
}

function parseDurationStringMs(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Support compound durations like "2h15m30s", "45m", "12.5s", "500ms".
  const msOnly = /^(\d+(?:\.\d+)?)ms$/i.exec(trimmed);
  if (msOnly) {
    return Math.ceil( Number(msOnly[1]));
  }
  const regex = /(\d+(?:\.\d+)?)(h|m|s)/gi;
  let totalMs = 0;
  let matched = false;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(trimmed)) !== null) {
    matched = true;
    const val = Number(match[1]);
    const unit = match[2]!.toLowerCase();
    if (unit === 'h') totalMs += val * 3_600_000;
    else if (unit === 'm') totalMs += val * 60_000;
    else if (unit === 's') totalMs += val * 1_000;
  }
  return matched && totalMs > 0 ? Math.ceil(totalMs) : null;
}

/**
 * Extracts a quota reset delay (in ms) or reset timestamp from an Antigravity
 * Code Assist 429 error body or `Retry-After` header.
 */
export function parseAntigravityRetryResetInfo(
  bodyText: string,
  headers?: Headers,
): {
  retryAfterMs: number | null;
  resetLabel: string | null;
} {
  let retryMs: number | null = null;
  let resetLabel: string | null = null;

  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const err = (parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed) as Record<
      string,
      unknown
    >;
    const details = Array.isArray(err.details) ? err.details : [];
    for (const detail of details) {
      if (!detail || typeof detail !== 'object') continue;
      const d = detail as Record<string, unknown>;
      if (typeof d.retryDelay === 'string') {
        const ms = parseDurationStringMs(d.retryDelay);
        if (ms !== null) retryMs = ms;
        resetLabel = resetLabel ?? d.retryDelay;
      }
      if (d.metadata && typeof d.metadata === 'object') {
        const meta = d.metadata as Record<string, unknown>;
        if (typeof meta.quotaResetDelay === 'string') {
          const ms = parseDurationStringMs(meta.quotaResetDelay);
          if (ms !== null) retryMs = ms;
          resetLabel = meta.quotaResetDelay;
        }
        if (typeof meta.quotaResetTimeStamp === 'string' && meta.quotaResetTimeStamp) {
          const ts = Date.parse(meta.quotaResetTimeStamp);
          if (Number.isFinite(ts)) {
            const delta = Math.max(0, ts - Date.now());
            retryMs = retryMs ?? delta;
            resetLabel = resetLabel ?? meta.quotaResetTimeStamp;
          }
        }
      }
    }
    if (typeof err.message === 'string') {
      const m = /reset after ([\dhms.]+)/i.exec(err.message);
      if (m?.[1]) {
        const ms = parseDurationStringMs(m[1]);
        if (ms !== null) retryMs = retryMs ?? ms;
        resetLabel = resetLabel ?? m[1];
      }
    }
  } catch {
    const m = /reset after ([\dhms.]+)/i.exec(bodyText);
    if (m?.[1]) {
      retryMs = parseDurationStringMs(m[1]);
      resetLabel = m[1];
    }
  }

  if (retryMs === null && headers) {
    const headerVal = headers.get('retry-after');
    if (headerVal) {
      const secs = Number(headerVal);
      if (Number.isFinite(secs) && secs >= 0) {
        retryMs = Math.ceil(secs * 1000);
        resetLabel = resetLabel ?? `${Math.ceil(secs)}s`;
      }
    }
  }

  return { retryAfterMs: retryMs, resetLabel };
}

/**
 * Formats an upstream Antigravity error response into a clear operator-facing
 * error message, surfacing region restrictions and quota reset windows explicitly.
 */
export function formatAntigravityErrorMessage(
  status: number,
  bodyText: string,
  headers?: Headers,
): string {
  let rawMessage = bodyText.trim();
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const err = (parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed) as Record<
      string,
      unknown
    >;
    if (typeof err.message === 'string' && err.message.trim()) {
      rawMessage = err.message.trim();
    }
  } catch {
    // Keep raw text.
  }

  if (
    /user location is not supported for the api use/i.test(rawMessage) ||
    /location_not_supported/i.test(bodyText)
  ) {
    return `Antigravity Code Assist API error (${status}): User location is not supported for the API use (region restriction).`;
  }

  if (status === 429) {
    const { resetLabel } = parseAntigravityRetryResetInfo(bodyText, headers);
    if (resetLabel) {
      if (rawMessage.toLowerCase().includes('reset')) {
        return `Antigravity quota exhausted (429): ${rawMessage}`;
      }
      return `Antigravity quota exhausted (429): ${rawMessage} (quota resets in ${resetLabel}).`;
    }
    return `Antigravity rate limit / quota exhausted (429): ${rawMessage || 'Too Many Requests'}`;
  }

  return `Antigravity Code Assist API error (${status}): ${rawMessage.slice(0, 500) || `HTTP ${status}`}`;
}
