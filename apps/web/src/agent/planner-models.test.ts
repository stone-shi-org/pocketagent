import { describe, expect, it } from 'vitest';
import type { PlannerModel, PlannerProvider } from '@pocketagent/protocol';
import {
  buildPlannerModelSelectOptions,
  groupPlannerModelsByProvider,
  resolvePlannerModelSelection,
  toPlannerModelInfos,
} from './planner-models.js';

const PROVIDERS: PlannerProvider[] = [
  {
    id: 'pp-openrouter',
    label: 'OpenRouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    hasApiKey: true,
    keyUnreadable: false,
    allowUnattended: false,
    sortOrder: 0,
    createdAt: 1000,
    lastTestedAt: null,
    lastError: null,
  },
  {
    id: 'pp-local',
    label: 'Local vLLM',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8000/v1',
    hasApiKey: false,
    keyUnreadable: false,
    allowUnattended: false,
    sortOrder: 1,
    createdAt: 1001,
    lastTestedAt: null,
    lastError: null,
  },
];

const MODELS: PlannerModel[] = [
  {
    id: 'pm-1',
    providerId: 'pp-openrouter',
    modelId: 'gpt-4o',
    label: 'GPT-4o (OR)',
    supportsEffort: true,
    createdAt: 1000,
    sortOrder: 0,
  },
  {
    id: 'pm-2',
    providerId: 'pp-local',
    modelId: 'gpt-4o',
    label: 'GPT-4o (Local)',
    supportsEffort: false,
    createdAt: 1001,
    sortOrder: 1,
  },
];

describe('planner-models (PA-148)', () => {
  it('groups models by provider in provider order', () => {
    const groups = groupPlannerModelsByProvider(MODELS, PROVIDERS);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.providerLabel).toBe('OpenRouter');
    expect(groups[0]!.models.map((m) => m.id)).toEqual(['pm-1']);
    expect(groups[1]!.providerLabel).toBe('Local vLLM');
    expect(groups[1]!.models.map((m) => m.id)).toEqual(['pm-2']);
  });

  it('respects provider sortOrder and model sortOrder within provider (PA-158)', () => {
    const reorderedProviders: PlannerProvider[] = [
      { ...PROVIDERS[0]!, sortOrder: 1 },
      { ...PROVIDERS[1]!, sortOrder: 0 },
    ];
    const multipleModels: PlannerModel[] = [
      {
        id: 'pm-a',
        providerId: 'pp-local',
        modelId: 'model-a',
        label: 'Model A',
        supportsEffort: false,
        createdAt: 1000,
        sortOrder: 1,
      },
      {
        id: 'pm-b',
        providerId: 'pp-local',
        modelId: 'model-b',
        label: 'Model B',
        supportsEffort: false,
        createdAt: 1001,
        sortOrder: 0,
      },
    ];
    const groups = groupPlannerModelsByProvider(multipleModels, reorderedProviders);
    expect(groups[0]!.providerLabel).toBe('Local vLLM');
    expect(groups[0]!.models.map((m) => m.id)).toEqual(['pm-b', 'pm-a']);
  });

  it('resolves model selection by row id first, then by bare modelId, and preserves unmatched refs', () => {
    expect(resolvePlannerModelSelection(MODELS, 'pm-2')).toBe('pm-2');
    expect(resolvePlannerModelSelection(MODELS, 'gpt-4o')).toBe('pm-1');
    expect(resolvePlannerModelSelection(MODELS, 'custom-unlisted')).toBe('custom-unlisted');
    expect(resolvePlannerModelSelection(MODELS, null)).toBe('');
  });

  it('converts models into ModelInfo entries with row id value, resolvedModel, and provider group', () => {
    const infos = toPlannerModelInfos(MODELS, PROVIDERS);
    expect(infos).toEqual([
      {
        value: 'pm-1',
        resolvedModel: 'gpt-4o',
        displayName: 'GPT-4o (OR)',
        description: 'OpenRouter · gpt-4o',
        group: 'OpenRouter',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'],
      },
      {
        value: 'pm-2',
        resolvedModel: 'gpt-4o',
        displayName: 'GPT-4o (Local)',
        description: 'Local vLLM · gpt-4o',
        group: 'Local vLLM',
        supportsEffort: false,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'],
      },
    ]);
  });

  it('builds grouped select options with provider labels and preserves unmatched current values', () => {
    const opts = buildPlannerModelSelectOptions(MODELS, PROVIDERS, 'Default model', 'legacy-model');
    expect(opts).toEqual([
      { value: '', label: 'Default model' },
      { value: 'pm-1', label: 'OpenRouter · GPT-4o (OR) (gpt-4o)', group: 'OpenRouter' },
      { value: 'pm-2', label: 'Local vLLM · GPT-4o (Local) (gpt-4o)', group: 'Local vLLM' },
      { value: 'legacy-model', label: 'legacy-model' },
    ]);
  });
});
