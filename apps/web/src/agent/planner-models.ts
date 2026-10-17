import type { ModelInfo, PlannerModel, PlannerProvider } from '@pocketagent/protocol';

export interface PlannerModelProviderGroup {
  provider: PlannerProvider | null;
  providerLabel: string;
  models: PlannerModel[];
}

/**
 * PA-148: Group Pocket Agent models by their owning provider in provider sort order.
 * Models whose provider is not in `providers` (or when `providers` is empty) are
 * placed in a trailing group so nothing is dropped.
 */
export function groupPlannerModelsByProvider(
  models: readonly PlannerModel[],
  providers: readonly PlannerProvider[] = [],
): PlannerModelProviderGroup[] {
  const groups: PlannerModelProviderGroup[] = [];
  const assigned = new Set<string>();

  const sortedProviders = [...providers].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.createdAt - b.createdAt,
  );

  for (const provider of sortedProviders) {
    const providerModels = models
      .filter((m) => m.providerId === provider.id)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.createdAt - b.createdAt);
    if (providerModels.length === 0) continue;
    for (const m of providerModels) assigned.add(m.id);
    groups.push({
      provider,
      providerLabel: provider.label,
      models: providerModels,
    });
  }

  const remaining = models
    .filter((m) => !assigned.has(m.id))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.createdAt - b.createdAt);
  if (remaining.length > 0) {
    groups.push({
      provider: null,
      providerLabel: 'Default',
      models: remaining,
    });
  }

  return groups;
}

/**
 * PA-148: Resolve a stored model reference (`planner_models.id` row id or legacy
 * bare `modelId` string) to the canonical `planner_models.id` row id when matched,
 * or preserve the unmatched string unchanged.
 */
export function resolvePlannerModelSelection(
  models: readonly PlannerModel[],
  ref: string | null | undefined,
): string {
  if (!ref) return '';
  const byId = models.find((m) => m.id === ref);
  if (byId) return byId.id;
  const byModelId = models.find((m) => m.modelId === ref);
  if (byModelId) return byModelId.id;
  return ref;
}

/**
 * PA-148: Convert `PlannerModel` catalog rows into `ModelInfo` entries for
 * `PromptBox`, grouped by provider and carrying `m.id` (the row id) as the wire
 * `value` and `m.modelId` as `resolvedModel` for backward-compatible matching.
 */
export function toPlannerModelInfos(
  models: readonly PlannerModel[],
  providers: readonly PlannerProvider[] = [],
): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const group of groupPlannerModelsByProvider(models, providers)) {
    for (const m of group.models) {
      out.push({
        value: m.id,
        resolvedModel: m.modelId,
        displayName: m.label,
        description: group.provider ? `${group.provider.label} · ${m.modelId}` : m.modelId,
        ...(group.provider ? { group: group.provider.label } : {}),
        supportsEffort: m.supportsEffort !== false,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'],
      });
    }
  }
  return out;
}

/**
 * PA-148: Build `<select>` options (with `group` for `<optgroup>`) for Pocket Agent
 * model pickers in `CronJobEditorPage` and `WebhookEditorPage`.
 */
export function buildPlannerModelSelectOptions(
  models: readonly PlannerModel[],
  providers: readonly PlannerProvider[],
  emptyLabel: string,
  currentValue?: string | null,
): { value: string; label: string; group?: string }[] {
  const options: { value: string; label: string; group?: string }[] = [
    { value: '', label: emptyLabel },
  ];
  for (const group of groupPlannerModelsByProvider(models, providers)) {
    for (const m of group.models) {
      options.push({
        value: m.id,
        label: group.provider
          ? `${group.provider.label} · ${m.label} (${m.modelId})`
          : `${m.label} (${m.modelId})`,
        ...(group.provider ? { group: group.provider.label } : {}),
      });
    }
  }
  const resolved = resolvePlannerModelSelection(models, currentValue);
  if (resolved && !options.some((o) => o.value === resolved)) {
    options.push({ value: resolved, label: resolved });
  }
  return options;
}
