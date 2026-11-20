import { describe, expect, it } from 'vitest';
import type {
  CustomClaudeProviderSummary,
  PlannerModel,
  PlannerProvider,
  PlannerProviderTemplatePayload,
} from '@pocketagent/protocol';
import { ProvidersImporter, anthropicBaseUrlOf, describeImportReport, type ProvidersImportApi } from './providers-import.js';

function fakeApi(opts: { failModel?: string; failProvider?: string } = {}) {
  const calls: string[] = [];
  let n = 0;
  const api: ProvidersImportApi = {
    async createPlannerProvider(body) {
      calls.push(`createProvider:${body.label}`);
      if (body.label === opts.failProvider) throw new Error('boom');
      return {
        id: `p${++n}`,
        label: body.label,
        kind: body.kind ?? 'openai-compatible',
        baseUrl: body.baseUrl ?? '',
        endpoints: body.endpoints ?? (body.kind === 'deepseek' ? ['openai', 'anthropic'] : ['openai']),
        hasApiKey: false,
        keyUnreadable: false,
        allowUnattended: body.allowUnattended ?? false,
      } as PlannerProvider;
    },
    async updatePlannerProvider(id, body) {
      calls.push(`updateProvider:${id}:${JSON.stringify(body)}`);
      return { id, label: body.label ?? 'x', kind: 'openai-compatible', baseUrl: body.baseUrl ?? '', endpoints: body.endpoints, hasApiKey: false, keyUnreadable: false, allowUnattended: false } as PlannerProvider;
    },
    async createPlannerModel(body) {
      calls.push(`createModel:${body.providerId}:${body.modelId}`);
      if (body.modelId === opts.failModel) throw new Error('model boom');
      return { id: `m${++n}`, providerId: body.providerId!, modelId: body.modelId, label: body.label } as PlannerModel;
    },
    async updatePlannerModel(id, body) {
      calls.push(`updateModel:${id}:${body.label}`);
      return { id, label: body.label } as PlannerModel;
    },
    async createCustomClaudeProvider(body) {
      calls.push(`createAgent:${body.name}:${body.providerId}`);
      return { id: `c${++n}`, name: body.name, providerId: body.providerId ?? null, models: body.models ?? [], baseUrl: 'x', providerKind: body.providerKind ?? 'claude-compatible' } as CustomClaudeProviderSummary;
    },
    async updateCustomClaudeProvider(id, body) {
      calls.push(`updateAgent:${id}:${JSON.stringify(body)}`);
      return { id, name: body.name ?? '' } as CustomClaudeProviderSummary;
    },
  };
  return { api, calls };
}

const payload = (over: Partial<PlannerProviderTemplatePayload> = {}): PlannerProviderTemplatePayload => ({
  label: 'Acme',
  kind: 'openai-compatible',
  baseUrl: 'https://acme.test/v1',
  allowUnattended: false,
  models: [{ modelId: 'a-1', label: 'A One' }],
  ...over,
});

describe('ProvidersImporter', () => {
  it('creates a missing provider together with its models', async () => {
    const { api, calls } = fakeApi();
    const imp = new ProvidersImporter(api, [], [], []);
    await imp.importProvider(payload());
    expect(calls).toEqual(['createProvider:Acme', 'createModel:p1:a-1']);
    expect(imp.report).toMatchObject({ providersCreated: 1, modelsCreated: 1, warnings: [] });
  });

  it('updates an existing provider and existing models, keeping local-only models', async () => {
    const { api, calls } = fakeApi();
    const local = { id: 'p9', label: 'Acme', kind: 'openai-compatible', baseUrl: 'https://acme.test/v1/', endpoints: ['openai'] } as PlannerProvider;
    const models = [
      { id: 'm1', providerId: 'p9', modelId: 'a-1', label: 'old' },
      { id: 'm2', providerId: 'p9', modelId: 'local-only', label: 'keep' },
    ] as PlannerModel[];
    const imp = new ProvidersImporter(api, [local], models, []);
    await imp.importProvider(payload({ models: [{ modelId: 'a-1', label: 'A One' }, { modelId: 'b-2', label: 'B' }] }));
    expect(calls.some((c) => c.startsWith('createProvider'))).toBe(false);
    expect(calls).toContain('updateModel:m1:A One');
    expect(calls).toContain('createModel:p9:b-2');
    expect(calls.some((c) => c.includes('local-only'))).toBe(false);
    expect(imp.report).toMatchObject({ providersUpdated: 1, modelsUpdated: 1, modelsCreated: 1 });
  });

  it('does not send a blank baseUrl on update (subscription providers export none)', async () => {
    const { api, calls } = fakeApi();
    const local = { id: 'p9', label: 'Claude', kind: 'claude-oauth', baseUrl: 'https://api.anthropic.com' } as PlannerProvider;
    const imp = new ProvidersImporter(api, [local], [], []);
    await imp.importProvider(payload({ label: 'Claude', kind: 'claude-oauth', baseUrl: ' ', models: [] }));
    expect(calls[0]).not.toContain('baseUrl');
    expect(imp.report.warnings).toEqual([]);
  });

  it('keeps going after a model or provider fails, and says which', async () => {
    const { api } = fakeApi({ failModel: 'a-1', failProvider: 'Bad' });
    const imp = new ProvidersImporter(api, [], [], []);
    await imp.importProvider(payload({ label: 'Bad' }));
    await imp.importProvider(payload({ models: [{ modelId: 'a-1', label: 'x' }, { modelId: 'ok', label: 'ok' }] }));
    expect(imp.report.modelsCreated).toBe(1);
    expect(imp.report.warnings).toHaveLength(2);
    expect(imp.report.warnings[0]).toContain('Bad');
    expect(imp.report.warnings[1]).toContain('a-1');
  });

  it('creates the provider and its models for a code agent when none exists', async () => {
    const { api, calls } = fakeApi();
    const imp = new ProvidersImporter(api, [], [], []);
    await imp.importCodeAgent({
      name: 'Claude (DeepSeek)',
      providerKind: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      models: ['ds-pro', 'ds-flash'],
      defaultModel: 'ds-pro',
      smallModel: 'ds-flash',
      allowUnattended: false,
    });
    expect(calls).toEqual([
      'createProvider:Claude (DeepSeek)',
      'createModel:p1:ds-pro',
      'createModel:p1:ds-flash',
      expect.stringMatching(/^createAgent:Claude \(DeepSeek\):p1$/),
    ]);
    expect(imp.report).toMatchObject({ providersCreated: 1, codeAgentsCreated: 1, warnings: [] });
  });

  it('links a code agent to the matching Anthropic provider instead of any other', async () => {
    const { api, calls } = fakeApi();
    const other = { id: 'p1', label: 'Other', kind: 'openai-compatible', baseUrl: 'https://other.test', endpoints: ['anthropic'] } as PlannerProvider;
    const ds = { id: 'p2', label: 'DeepSeek', kind: 'deepseek', baseUrl: 'https://api.deepseek.com', endpoints: ['openai', 'anthropic'] } as PlannerProvider;
    const models = [{ id: 'm1', providerId: 'p2', modelId: 'ds-pro', label: 'x' }] as PlannerModel[];
    const imp = new ProvidersImporter(api, [other, ds], models, []);
    await imp.importCodeAgent({
      name: 'CC', providerKind: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic',
      models: ['ds-pro'], defaultModel: 'ds-pro', smallModel: null, allowUnattended: false,
    });
    expect(calls).toEqual(['createAgent:CC:p2']);
  });

  it('updates an existing code agent, merging models, and leaves a standalone one standalone', async () => {
    const { api, calls } = fakeApi();
    const existing = { id: 'c1', name: 'CC', providerId: null, models: ['local'], baseUrl: 'https://x.test', providerKind: 'claude-compatible' } as CustomClaudeProviderSummary;
    const imp = new ProvidersImporter(api, [], [], [existing]);
    await imp.importCodeAgent({
      name: 'CC', providerKind: 'claude-compatible', baseUrl: 'https://x.test',
      models: ['remote'], defaultModel: 'remote', smallModel: null, allowUnattended: false,
    });
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.replace(/^updateAgent:c1:/, ''));
    expect(body.models).toEqual(['local', 'remote']);
    expect(body.providerId).toBeUndefined();
    expect(imp.report).toMatchObject({ codeAgentsUpdated: 1, providersCreated: 0 });
  });
});

describe('helpers', () => {
  it('derives the Anthropic base URL like the server', () => {
    expect(anthropicBaseUrlOf({ kind: 'deepseek', baseUrl: 'https://api.deepseek.com/' })).toBe('https://api.deepseek.com/anthropic');
    expect(anthropicBaseUrlOf({ kind: 'openai-compatible', baseUrl: 'https://x.test/v1' })).toBe('https://x.test');
  });
  it('describes the report', () => {
    expect(describeImportReport({ providersCreated: 1, providersUpdated: 0, modelsCreated: 2, modelsUpdated: 3, codeAgentsCreated: 0, codeAgentsUpdated: 0 })).toBe(
      'Imported — providers: 1 new; models: 2 new, 3 updated.',
    );
  });
});
