import {
  defaultEndpointsForProviderKind,
  type ClaudeProviderTemplatePayload,
  type CreateCustomClaudeProviderRequest,
  type CreatePlannerModelRequest,
  type CreatePlannerProviderRequest,
  type CustomClaudeProviderSummary,
  type PlannerModel,
  type PlannerProvider,
  type PlannerProviderEndpoint,
  type PlannerProviderTemplateModel,
  type PlannerProviderTemplatePayload,
  type UpdateCustomClaudeProviderRequest,
  type UpdatePlannerModelRequest,
  type UpdatePlannerProviderRequest,
} from '@pocketagent/protocol';

/** The slice of `ApiClient` an import needs, so the merge rules are testable without a server. */
export interface ProvidersImportApi {
  createPlannerProvider(body: CreatePlannerProviderRequest): Promise<PlannerProvider>;
  updatePlannerProvider(id: string, body: UpdatePlannerProviderRequest): Promise<PlannerProvider>;
  createPlannerModel(body: CreatePlannerModelRequest): Promise<PlannerModel>;
  updatePlannerModel(id: string, body: UpdatePlannerModelRequest): Promise<PlannerModel>;
  createCustomClaudeProvider(body: CreateCustomClaudeProviderRequest): Promise<CustomClaudeProviderSummary>;
  updateCustomClaudeProvider(
    id: string,
    body: UpdateCustomClaudeProviderRequest,
  ): Promise<CustomClaudeProviderSummary>;
}

export interface ProvidersImportCounts {
  providersCreated: number;
  providersUpdated: number;
  modelsCreated: number;
  modelsUpdated: number;
  codeAgentsCreated: number;
  codeAgentsUpdated: number;
}

export interface ProvidersImportReport extends ProvidersImportCounts {
  /** One sentence per item that failed. A failure never stops the rest of the file. */
  warnings: string[];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function trimSlashes(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function endpointsOf(p: Pick<PlannerProvider, 'kind' | 'endpoints'>): PlannerProviderEndpoint[] {
  return p.endpoints?.length ? p.endpoints : defaultEndpointsForProviderKind(p.kind);
}

/**
 * The base URL Claude Code is pointed at for a provider — the same rule as the
 * server's `resolveAnthropicBaseUrlForProvider`. A code agent's exported
 * `baseUrl` is this value, so it is what an agent is matched to a provider by.
 */
export function anthropicBaseUrlOf(provider: Pick<PlannerProvider, 'kind' | 'baseUrl'>): string {
  let url = trimSlashes(provider.baseUrl);
  if (url.endsWith('/v1/messages')) url = url.slice(0, -'/v1/messages'.length);
  else if (url.endsWith('/v1')) url = url.slice(0, -'/v1'.length);
  if (provider.kind === 'deepseek' && !url.endsWith('/anthropic')) {
    url = `${url || 'https://api.deepseek.com'}/anthropic`;
  }
  return url;
}

/** Keeps first-seen order; blanks and repeats dropped. */
function union(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list) {
      const v = raw.trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Merges an exported providers/models/code-agents file into this host.
 *
 * - A provider the file names that does not exist here is **created**, models
 *   and all; one that does is **updated** in place.
 * - A model that already exists on its provider is **updated**, otherwise
 *   created. Local models the file does not mention are left alone.
 * - A code agent needs a provider to hang off; when none matches, one is
 *   created from the agent itself, so an import never depends on the operator
 *   having pre-created it.
 * - Each item stands alone: one failure is a warning and the rest continue.
 *
 * API keys are never in an export, so a created provider has none; the caller
 * says so.
 */
export class ProvidersImporter {
  readonly report: ProvidersImportReport = {
    providersCreated: 0,
    providersUpdated: 0,
    modelsCreated: 0,
    modelsUpdated: 0,
    codeAgentsCreated: 0,
    codeAgentsUpdated: 0,
    warnings: [],
  };

  constructor(
    private readonly api: ProvidersImportApi,
    private providers: PlannerProvider[],
    private models: PlannerModel[],
    private customProviders: CustomClaudeProviderSummary[],
  ) {}

  private warn(message: string): void {
    this.report.warnings.push(message);
  }

  private matchProvider(imported: PlannerProviderTemplatePayload): PlannerProvider | undefined {
    const url = trimSlashes(imported.baseUrl);
    const kind = imported.kind ?? 'openai-compatible';
    return (
      this.providers.find((p) => p.label === imported.label && trimSlashes(p.baseUrl) === url) ??
      // Same name and kind at another address: the same provider, moved.
      this.providers.find((p) => p.label === imported.label && p.kind === kind) ??
      (imported.label === 'Default'
        ? this.providers.find((p) => p.label === 'Default' && !p.baseUrl)
        : undefined)
    );
  }

  /** Create-or-update one provider and merge its models. Returns it, or null when it could not be saved. */
  async importProvider(imported: PlannerProviderTemplatePayload): Promise<PlannerProvider | null> {
    const kind = imported.kind ?? 'openai-compatible';
    const existing = this.matchProvider(imported);
    let target: PlannerProvider;
    try {
      if (existing) {
        const endpoints = imported.endpoints
          ? union(endpointsOf(existing), imported.endpoints)
          : undefined;
        target = await this.api.updatePlannerProvider(existing.id, {
          label: imported.label,
          // A subscription provider exports an empty address; the update schema rejects blank.
          ...(imported.baseUrl.trim() ? { baseUrl: imported.baseUrl } : {}),
          allowUnattended: imported.allowUnattended,
          ...(endpoints ? { endpoints: endpoints as PlannerProviderEndpoint[] } : {}),
        });
        this.report.providersUpdated++;
      } else {
        target = await this.api.createPlannerProvider({
          label: imported.label,
          kind,
          ...(imported.baseUrl.trim() ? { baseUrl: imported.baseUrl } : {}),
          allowUnattended: imported.allowUnattended,
          ...(imported.endpoints !== undefined ? { endpoints: imported.endpoints } : {}),
        });
        this.report.providersCreated++;
      }
    } catch (err) {
      this.warn(`Provider "${imported.label}": ${errorText(err)}`);
      return null;
    }
    this.providers = [...this.providers.filter((p) => p.id !== target.id), target];
    for (const m of imported.models) await this.importModel(target, m);
    return target;
  }

  private async importModel(
    provider: PlannerProvider,
    imported: PlannerProviderTemplateModel,
  ): Promise<void> {
    const existing = this.models.find(
      (m) => m.providerId === provider.id && m.modelId === imported.modelId,
    );
    try {
      if (existing) {
        const { modelId: _modelId, ...fields } = imported;
        const updated = await this.api.updatePlannerModel(existing.id, fields);
        this.models = this.models.map((m) => (m.id === existing.id ? updated : m));
        this.report.modelsUpdated++;
      } else {
        const created = await this.api.createPlannerModel({ ...imported, providerId: provider.id });
        this.models = [...this.models, created];
        this.report.modelsCreated++;
      }
    } catch (err) {
      this.warn(`Model "${imported.modelId}" on "${provider.label}": ${errorText(err)}`);
    }
  }

  /** Make sure `provider` lists every id, creating the missing ones (label = id). */
  private async ensureModels(provider: PlannerProvider, modelIds: readonly string[]): Promise<void> {
    for (const modelId of union(modelIds)) {
      if (this.models.some((m) => m.providerId === provider.id && m.modelId === modelId)) continue;
      await this.importModel(provider, { modelId, label: modelId });
    }
  }

  private matchAnthropicProvider(agent: ClaudeProviderTemplatePayload): PlannerProvider | undefined {
    const url = trimSlashes(agent.baseUrl);
    const anthropic = this.providers.filter((p) => endpointsOf(p).includes('anthropic'));
    return (
      anthropic.find((p) => anthropicBaseUrlOf(p) === url) ??
      // The id is only meaningful on the host that exported it, but there it is exact.
      (agent.providerId ? anthropic.find((p) => p.id === agent.providerId) : undefined)
    );
  }

  /** A provider to hang a code agent off, made from the agent's own address and models. */
  private async createProviderFor(agent: ClaudeProviderTemplatePayload): Promise<PlannerProvider> {
    const isDeepseek = agent.providerKind === 'deepseek';
    const baseUrl = isDeepseek
      ? trimSlashes(agent.baseUrl).replace(/\/anthropic$/, '')
      : trimSlashes(agent.baseUrl);
    const created = await this.api.createPlannerProvider({
      label: agent.name,
      kind: isDeepseek ? 'deepseek' : 'openai-compatible',
      baseUrl,
      // A generic provider created for a code agent speaks the Anthropic wire only;
      // claiming OpenAI chat on top would put it in Pocket Agent's model list untested.
      ...(isDeepseek ? {} : { endpoints: ['anthropic'] as PlannerProviderEndpoint[] }),
      allowUnattended: agent.allowUnattended,
    });
    this.report.providersCreated++;
    this.providers = [...this.providers, created];
    return created;
  }

  async importCodeAgent(agent: ClaudeProviderTemplatePayload): Promise<void> {
    const existing = this.customProviders.find(
      (c) => c.name === agent.name || (c.baseUrl === agent.baseUrl && c.providerKind === agent.providerKind),
    );
    try {
      if (existing) {
        // A local agent with its own key and no provider stays standalone: linking it
        // would swap its key for the provider's, which an export cannot supply.
        const linked =
          this.matchAnthropicProvider(agent) ??
          (existing.providerId ? this.providers.find((p) => p.id === existing.providerId) : undefined);
        const models = union(existing.models, agent.models);
        if (linked) await this.ensureModels(linked, models);
        const saved = await this.api.updateCustomClaudeProvider(existing.id, {
          name: agent.name,
          providerKind: agent.providerKind,
          ...(linked
            ? { providerId: linked.id }
            : { baseUrl: agent.baseUrl, models }),
          defaultModel: agent.defaultModel,
          smallModel: agent.smallModel,
          allowUnattended: agent.allowUnattended,
          ...(agent.supportsEffort !== undefined ? { supportsEffort: agent.supportsEffort } : {}),
        });
        this.customProviders = this.customProviders.map((c) => (c.id === saved.id ? saved : c));
        this.report.codeAgentsUpdated++;
        return;
      }

      const provider = this.matchAnthropicProvider(agent) ?? (await this.createProviderFor(agent));
      await this.ensureModels(provider, agent.models);
      const created = await this.api.createCustomClaudeProvider({
        name: agent.name,
        providerId: provider.id,
        providerKind: agent.providerKind,
        models: agent.models,
        defaultModel: agent.defaultModel,
        smallModel: agent.smallModel,
        allowUnattended: agent.allowUnattended,
        ...(agent.supportsEffort !== undefined ? { supportsEffort: agent.supportsEffort } : {}),
      });
      this.customProviders = [...this.customProviders, created];
      this.report.codeAgentsCreated++;
    } catch (err) {
      this.warn(`Code agent "${agent.name}": ${errorText(err)}`);
    }
  }
}

/** One-line summary for the success banner. */
export function describeImportReport(r: ProvidersImportCounts, extras: string[] = []): string {
  const parts: string[] = [];
  const pair = (created: number, updated: number, noun: string): void => {
    const bits: string[] = [];
    if (created > 0) bits.push(`${created} new`);
    if (updated > 0) bits.push(`${updated} updated`);
    if (bits.length > 0) parts.push(`${noun}: ${bits.join(', ')}`);
  };
  pair(r.providersCreated, r.providersUpdated, 'providers');
  pair(r.modelsCreated, r.modelsUpdated, 'models');
  pair(r.codeAgentsCreated, r.codeAgentsUpdated, 'code agents');
  parts.push(...extras);
  return parts.length > 0 ? `Imported — ${parts.join('; ')}.` : 'Nothing to import.';
}
