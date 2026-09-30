import {
  parseTemplatePayload,
  type ClaudeProviderTemplatePayload,
  type CustomClaudeProviderSummary,
  type HubTemplateKind,
  type HubTemplatePayload,
  type McpRegistrySummary,
  type McpRegistryTemplatePayload,
  type PlannerAgentToolInfo,
  type PlannerEndpointTemplatePayload,
  type PlannerModel,
  type PlannerSettingsDto,
  type PlannerWorkspace,
  type PocketAgentTemplatePayload,
  type SkillTemplatePayload,
} from '@pocketagent/protocol';
import type { ApiClient } from '../api/client.js';

/**
 * PA-109: helpers to export host-side configurations into Hub template payloads.
 *
 * Each function below transforms a backend DTO into the clean, secret-free
 * template payload schema defined in `@pocketagent/protocol` (PA-70).
 */

export function exportPocketAgentPayload(
  workspace: PlannerWorkspace,
  tools: PlannerAgentToolInfo[],
): PocketAgentTemplatePayload {
  return {
    name: workspace.name,
    defaultModelId: workspace.defaultModelId ?? null,
    identityPrompt: workspace.identityPrompt ?? null,
    memoryEnabled: workspace.memoryEnabled,
    mcpEnabled: workspace.mcpEnabled,
    disabledTools: tools.filter((t) => !t.enabled).map((t) => t.name),
  };
}

export function exportMcpRegistryPayload(
  registry: McpRegistrySummary,
): McpRegistryTemplatePayload {
  return {
    name: registry.name,
    transport: registry.transport,
    url: registry.url,
    authKind: registry.authKind,
    headerName: registry.headerName ?? null,
    description: registry.description ?? null,
    enabled: registry.enabled,
  };
}

export function exportClaudeProviderPayload(
  provider: CustomClaudeProviderSummary,
): ClaudeProviderTemplatePayload {
  return {
    name: provider.name,
    providerKind: provider.providerKind,
    baseUrl: provider.baseUrl,
    models: provider.models,
    defaultModel: provider.defaultModel,
    smallModel: provider.smallModel ?? null,
    allowUnattended: provider.allowUnattended,
    supportsEffort: provider.supportsEffort,
  };
}

export function exportSkillPayload(
  skill: { slug: string; name: string; description: string; body: string },
): SkillTemplatePayload {
  return {
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    body: skill.body,
  };
}

export function exportPlannerEndpointPayload(
  settings: PlannerSettingsDto,
  models: PlannerModel[],
): PlannerEndpointTemplatePayload {
  if (!settings.baseUrl) {
    throw new Error('Host has no planner LLM endpoint baseUrl configured.');
  }
  return {
    baseUrl: settings.baseUrl,
    models: models.map((m) => ({
      modelId: m.modelId,
      label: m.label,
      ...(m.supportsEffort !== undefined ? { supportsEffort: m.supportsEffort } : {}),
      ...(m.defaultEffort !== undefined ? { defaultEffort: m.defaultEffort } : {}),
    })),
    embeddingBaseUrl: settings.embeddingBaseUrl ?? null,
    embeddingModelId: settings.embeddingModelId ?? null,
    webSearchBaseUrl: settings.webSearchBaseUrl ?? null,
    urlFetchBaseUrl: settings.urlFetchBaseUrl ?? null,
  };
}

export interface ExportableItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

/**
 * Discovers what candidates exist on a host for a given template kind.
 */
export async function listHostExportableItems(
  client: ApiClient,
  kind: HubTemplateKind,
): Promise<ExportableItem[]> {
  switch (kind) {
    case 'pocket-agent': {
      const res = await client.listPlannerWorkspaces();
      return (res.workspaces ?? []).map((w) => ({
        id: w.id,
        label: w.name,
      }));
    }
    case 'mcp-registry': {
      const res = await client.listMcpRegistries();
      return (res.registries ?? []).map((r) => ({
        id: r.id,
        label: r.name,
        description: r.description ?? undefined,
      }));
    }
    case 'claude-provider': {
      const res = await client.listCustomClaudeProviders();
      return (res.providers ?? []).map((p) => ({
        id: p.id,
        label: p.name,
        description: p.baseUrl,
      }));
    }
    case 'skill': {
      const res = await client.listPlannerSkills();
      const globals = (res.skills ?? []).filter(
        (s) => s.source === 'global' || s.id.startsWith('global:'),
      );
      return globals.map((s) => ({
        id: s.id,
        label: s.name,
        description: s.description,
      }));
    }
    case 'planner-endpoint': {
      // Singleton: always exactly one endpoint per host.
      return [
        {
          id: 'planner-endpoint',
          label: 'Pocket Agent LLM Endpoint',
        },
      ];
    }
  }
}

export interface HostExportDraft {
  readonly defaultName: string;
  readonly defaultDescription: string;
  readonly payload: HubTemplatePayload['payload'];
}

/**
 * Fetches the full resource from the host and returns a verified template payload
 * and default template name/description.
 */
export async function fetchHostExportDraft(
  client: ApiClient,
  kind: HubTemplateKind,
  itemId: string | null,
  hostLabel: string,
): Promise<HostExportDraft> {
  switch (kind) {
    case 'pocket-agent': {
      const workspacesRes = await client.listPlannerWorkspaces();
      const workspace = (workspacesRes.workspaces ?? []).find((w) => w.id === itemId);
      if (!workspace) {
        throw new Error(`Pocket Agent workspace not found: ${itemId}`);
      }
      const toolsRes = await client.listPlannerAgentTools(workspace.id);
      const payload = exportPocketAgentPayload(workspace, toolsRes.tools ?? []);
      const parsed = parseTemplatePayload(kind, payload);
      if (!parsed.ok) throw new Error(parsed.message);
      return {
        defaultName: workspace.name,
        defaultDescription: `Exported from ${hostLabel}`,
        payload: parsed.value.payload,
      };
    }
    case 'mcp-registry': {
      const registriesRes = await client.listMcpRegistries();
      const registry = (registriesRes.registries ?? []).find(
        (r) => r.id === itemId || r.name === itemId,
      );
      if (!registry) {
        throw new Error(`MCP registry not found: ${itemId}`);
      }
      const payload = exportMcpRegistryPayload(registry);
      const parsed = parseTemplatePayload(kind, payload);
      if (!parsed.ok) throw new Error(parsed.message);
      return {
        defaultName: registry.name,
        defaultDescription: registry.description || `Exported from ${hostLabel}`,
        payload: parsed.value.payload,
      };
    }
    case 'claude-provider': {
      const providersRes = await client.listCustomClaudeProviders();
      const provider = (providersRes.providers ?? []).find(
        (p) => p.id === itemId || p.name === itemId,
      );
      if (!provider) {
        throw new Error(`Claude provider not found: ${itemId}`);
      }
      const payload = exportClaudeProviderPayload(provider);
      const parsed = parseTemplatePayload(kind, payload);
      if (!parsed.ok) throw new Error(parsed.message);
      return {
        defaultName: provider.name,
        defaultDescription: `Exported from ${hostLabel}`,
        payload: parsed.value.payload,
      };
    }
    case 'skill': {
      if (!itemId) throw new Error('A skill id is required');
      const skill = await client.getPlannerSkill(itemId);
      const payload = exportSkillPayload(skill);
      const parsed = parseTemplatePayload(kind, payload);
      if (!parsed.ok) throw new Error(parsed.message);
      return {
        defaultName: skill.name,
        defaultDescription: skill.description || `Exported from ${hostLabel}`,
        payload: parsed.value.payload,
      };
    }
    case 'planner-endpoint': {
      const settings = await client.getPlannerSettings();
      const modelsRes = await client.listPlannerModels();
      const payload = exportPlannerEndpointPayload(settings, modelsRes.models ?? []);
      const parsed = parseTemplatePayload(kind, payload);
      if (!parsed.ok) throw new Error(parsed.message);
      return {
        defaultName: `${hostLabel} Planner Endpoint`,
        defaultDescription: `Exported from ${hostLabel}`,
        payload: parsed.value.payload,
      };
    }
  }
}

/**
 * Fetches export drafts for all items of a given template kind on a host.
 */
export async function fetchAllHostExportDrafts(
  client: ApiClient,
  kind: HubTemplateKind,
  hostLabel: string,
): Promise<HostExportDraft[]> {
  const items = await listHostExportableItems(client, kind);
  const drafts: HostExportDraft[] = [];
  for (const item of items) {
    const draft = await fetchHostExportDraft(
      client,
      kind,
      kind === 'planner-endpoint' ? null : item.id,
      hostLabel,
    );
    drafts.push(draft);
  }
  return drafts;
}

