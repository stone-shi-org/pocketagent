import { z } from 'zod';
import { EffortLevel } from './agent-events.js';
import { CronOverlapPolicy, CronSchedulePreset, CronWorktreeMode } from './cron.js';
import { UpdateSettingsRequest } from './http.js';
import {
  ClaudeProviderTemplatePayload,
  HubTemplateKind,
  LegacyHubTemplateKind,
  McpRegistryTemplatePayload,
  PlannerEndpointTemplatePayload,
  PlannerProviderTemplatePayload,
  SkillTemplatePayload,
  parseTemplatePayload,
} from './hub-templates.js';
import {
  WebhookAuthMode,
  WebhookConfig,
  WebhookConversationMode,
  WebhookDirectoryPolicy,
  WebhookOverlapPolicy,
} from './webhooks.js';

export const POCKETAGENT_EXPORT_FORMAT = 'pocketagent-export';

export const PocketAgentExportKind = z.enum([
  'server-settings',
  'pocket-agent',
  'planner-provider',
  'planner-endpoint',
  'cron-job',
  'webhook',
  'hub-template',
  'mcp-registry',
  'claude-provider',
  'skill',
]);
export type PocketAgentExportKind = z.infer<typeof PocketAgentExportKind>;

export const PocketAgentExportEnvelope = z.object({
  format: z.literal(POCKETAGENT_EXPORT_FORMAT),
  version: z.number().int().min(1),
  kind: PocketAgentExportKind,
  exportedAt: z.string(),
  name: z.string().optional(),
  data: z.unknown(),
});
export type PocketAgentExportEnvelope = z.infer<typeof PocketAgentExportEnvelope>;

export const PocketAgentExportData = z.object({
  name: z.string().min(1).max(128),
  defaultModelId: z.string().max(200).nullable().optional(),
  identityPrompt: z.string().max(4000).nullable().optional(),
  memoryEnabled: z.boolean().optional(),
  mcpEnabled: z.boolean().optional(),
  disabledTools: z.array(z.string().min(1).max(200)).optional(),
});
export type PocketAgentExportData = z.infer<typeof PocketAgentExportData>;

export const CronJobExportData = z.object({
  name: z.string().min(1).max(128),
  enabled: z.boolean().optional(),
  preset: CronSchedulePreset.optional(),
  cronExpr: z.string().min(1).max(200).optional(),
  timeZone: z.string().max(64).optional(),
  cwd: z.string().max(4096).optional(),
  agent: z.string().min(1).max(64),
  worktreeMode: CronWorktreeMode.optional(),
  model: z.string().min(1).max(200).nullable().optional(),
  effort: EffortLevel.nullable().optional(),
  skipPermissions: z.boolean().optional(),
  prompt: z.string().min(1),
  overlapPolicy: CronOverlapPolicy.optional(),
  retentionDays: z.number().int().min(0).max(3650).optional(),
});
export type CronJobExportData = z.infer<typeof CronJobExportData>;

export const WebhookExportData = z.object({
  name: z.string().min(1).max(128),
  slug: z.string().max(64).optional(),
  enabled: z.boolean().optional(),
  config: WebhookConfig,
  authMode: WebhookAuthMode.optional(),
  cwd: z.string().max(4096).optional(),
  agent: z.string().min(1).max(64),
  worktreeMode: CronWorktreeMode.optional(),
  model: z.string().min(1).max(200).nullable().optional(),
  effort: EffortLevel.nullable().optional(),
  skipPermissions: z.boolean().optional(),
  autoSelectAgentModel: z.boolean().optional(),
  promptTemplate: z.string().optional(),
  conversationMode: WebhookConversationMode.optional(),
  overlapPolicy: WebhookOverlapPolicy.optional(),
  directoryPolicy: WebhookDirectoryPolicy.optional(),
  skipQueueLabelEnabled: z.boolean().optional(),
  agentIdentity: z.string().max(200).optional(),
  maxConcurrent: z.number().int().min(1).max(10).optional(),
  storePayloads: z.boolean().optional(),
});
export type WebhookExportData = z.infer<typeof WebhookExportData>;

export const HubTemplateExportData = z.object({
  kind: HubTemplateKind,
  name: z.string().min(1).max(128),
  description: z.string().max(2000).optional(),
  payload: z.unknown(),
});
export type HubTemplateExportData = z.infer<typeof HubTemplateExportData>;

const LegacyHubTemplateExportData = z.object({
  kind: LegacyHubTemplateKind,
  name: z.string().min(1).max(128),
  description: z.string().max(2000).optional(),
  payload: z.unknown(),
});

/** Create a standard export envelope. */
export function createExportEnvelope<T>(
  kind: PocketAgentExportKind,
  data: T,
  name?: string,
): PocketAgentExportEnvelope {
  return {
    format: POCKETAGENT_EXPORT_FORMAT,
    version: 1,
    kind,
    exportedAt: new Date().toISOString(),
    ...(name !== undefined && name !== '' ? { name } : {}),
    data,
  };
}

export type ExportParseResult<T = unknown> =
  | { ok: true; envelope: PocketAgentExportEnvelope; data: T }
  | { ok: false; error: string; actualKind?: string };

/**
 * Validates that an unknown JSON value matches the PocketAgent export format envelope,
 * optionally checking that its kind matches the expected kind, and validates its data.
 */
export function parseExportEnvelope<T = unknown>(
  raw: unknown,
  expectedKind?: PocketAgentExportKind,
): ExportParseResult<T> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'The file is not a valid JSON object.' };
  }

  const obj = raw as Record<string, unknown>;

  if (obj.format !== POCKETAGENT_EXPORT_FORMAT) {
    return {
      ok: false,
      error: 'Not a valid PocketAgent export file: missing format identifier ("format": "pocketagent-export").',
    };
  }

  const kindParsed = PocketAgentExportKind.safeParse(obj.kind);
  if (!kindParsed.success) {
    return {
      ok: false,
      error: `Unrecognized export kind: "${String(obj.kind)}".`,
      actualKind: typeof obj.kind === 'string' ? obj.kind : undefined,
    };
  }

  const actualKind = kindParsed.data;
  const compatibleLegacyPlanner =
    expectedKind === 'planner-provider' && actualKind === 'planner-endpoint';
  if (expectedKind && actualKind !== expectedKind && !compatibleLegacyPlanner) {
    return {
      ok: false,
      error: `Cannot import: this file contains a "${actualKind}" export, but this page expects a "${expectedKind}" export.`,
      actualKind,
    };
  }

  // Validate the inner payload against the schema for this kind
  const validation = validateExportPayload(actualKind, obj.data);
  if (!validation.ok) {
    return { ok: false, error: validation.error, actualKind };
  }

  const envelope: PocketAgentExportEnvelope = {
    format: POCKETAGENT_EXPORT_FORMAT,
    version: typeof obj.version === 'number' ? obj.version : 1,
    kind: actualKind,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    ...(typeof obj.name === 'string' ? { name: obj.name } : {}),
    data: validation.data,
  };

  return { ok: true, envelope, data: validation.data as T };
}

function validateExportPayload(
  kind: PocketAgentExportKind,
  data: unknown,
): { ok: true; data: unknown } | { ok: false; error: string } {
  switch (kind) {
    case 'server-settings': {
      const parsed = UpdateSettingsRequest.safeParse(data);
      if (!parsed.success) {
        return { ok: false, error: `Invalid server settings data: ${parsed.error.issues[0]?.message ?? 'validation error'}` };
      }
      return { ok: true, data: parsed.data };
    }
    case 'pocket-agent': {
      const parsed = PocketAgentExportData.safeParse(data);
      if (!parsed.success) {
        return { ok: false, error: `Invalid pocket agent data: ${parsed.error.issues[0]?.message ?? 'validation error'}` };
      }
      return { ok: true, data: parsed.data };
    }
    case 'planner-provider': {
      if (Array.isArray(data)) {
        const parsed = z.array(PlannerProviderTemplatePayload).safeParse(data);
        if (!parsed.success) {
          return { ok: false, error: `Invalid planner provider data in array: ${parsed.error.issues[0]?.message ?? 'validation error'}` };
        }
        return { ok: true, data: parsed.data };
      }
      const parsed = PlannerProviderTemplatePayload.safeParse(data);
      if (!parsed.success) {
        return { ok: false, error: `Invalid planner provider data: ${parsed.error.issues[0]?.message ?? 'validation error'}` };
      }
      return { ok: true, data: parsed.data };
    }
    case 'planner-endpoint': {
      const parsed = PlannerEndpointTemplatePayload.safeParse(data);
      if (!parsed.success) {
        return { ok: false, error: `Invalid planner endpoint data: ${parsed.error.issues[0]?.message ?? 'validation error'}` };
      }
      return { ok: true, data: parsed.data };
    }
    case 'cron-job': {
      if (Array.isArray(data)) {
        const parsed = z.array(CronJobExportData).safeParse(data);
        if (!parsed.success) {
          return { ok: false, error: `Invalid cron job data in array: ${parsed.error.issues[0]?.message ?? 'validation error'}` };
        }
        return { ok: true, data: parsed.data };
      }
      const parsed = CronJobExportData.safeParse(data);
      if (!parsed.success) {
        return { ok: false, error: `Invalid cron job data: ${parsed.error.issues[0]?.message ?? 'validation error'}` };
      }
      return { ok: true, data: parsed.data };
    }
    case 'webhook': {
      const parsed = WebhookExportData.safeParse(data);
      if (!parsed.success) {
        return { ok: false, error: `Invalid webhook data: ${parsed.error.issues[0]?.message ?? 'validation error'}` };
      }
      return { ok: true, data: parsed.data };
    }
    case 'hub-template': {
      const parsed = LegacyHubTemplateExportData.safeParse(data);
      if (!parsed.success) {
        return { ok: false, error: `Invalid hub template data: ${parsed.error.issues[0]?.message ?? 'validation error'}` };
      }
      const payloadCheck = parseTemplatePayload(
        parsed.data.kind,
        parsed.data.payload,
        parsed.data.name,
      );
      if (!payloadCheck.ok) {
        return { ok: false, error: `Invalid hub template payload: ${payloadCheck.message}` };
      }
      const normalized: HubTemplateExportData = {
        kind: payloadCheck.value.kind,
        name: parsed.data.name,
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        payload: payloadCheck.value.payload,
      };
      return { ok: true, data: normalized };
    }
    case 'mcp-registry': {
      if (Array.isArray(data)) {
        const parsed = z.array(McpRegistryTemplatePayload).safeParse(data);
        if (!parsed.success) {
          return { ok: false, error: `Invalid MCP registry data in array: ${parsed.error.issues[0]?.message ?? 'validation error'}` };
        }
        return { ok: true, data: parsed.data };
      }
      const parsed = McpRegistryTemplatePayload.safeParse(data);
      if (!parsed.success) {
        return { ok: false, error: `Invalid MCP registry data: ${parsed.error.issues[0]?.message ?? 'validation error'}` };
      }
      return { ok: true, data: parsed.data };
    }
    case 'claude-provider': {
      const parsed = ClaudeProviderTemplatePayload.safeParse(data);
      if (!parsed.success) {
        return { ok: false, error: `Invalid Claude provider data: ${parsed.error.issues[0]?.message ?? 'validation error'}` };
      }
      return { ok: true, data: parsed.data };
    }
    case 'skill': {
      const parsed = SkillTemplatePayload.safeParse(data);
      if (!parsed.success) {
        return { ok: false, error: `Invalid skill data: ${parsed.error.issues[0]?.message ?? 'validation error'}` };
      }
      return { ok: true, data: parsed.data };
    }
  }
}
