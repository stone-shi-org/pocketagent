import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTemplate,
  createTestHub,
  instantiate,
  listTemplates,
  registerHost,
  type TestHub,
} from './helpers.js';
import { startFakeBackend, writes, type FakeBackend } from './fake-backend.js';

const payload = {
  label: 'House LLM',
  kind: 'openai-compatible' as const,
  baseUrl: 'https://llm.example.com/v1',
  allowUnattended: false,
  models: [
    { modelId: 'house-1', label: 'House 1' },
    { modelId: 'house-2', label: 'House 2' },
  ],
};

/**
 * PA-148: `planner-provider` replaced the singleton `planner-endpoint` kind with
 * a non-singleton provider + models kind, while keeping backward compatibility
 * for stored `planner-endpoint` rows in `hub_templates`.
 */
describe('provisioning a planner provider (PA-148)', () => {
  let hub: TestHub;
  let dev01: FakeBackend;

  beforeEach(async () => {
    hub = await createTestHub();
    dev01 = await startFakeBackend();
    registerHost(hub, { id: 'dev01', baseUrl: dev01.baseUrl });
  });

  afterEach(async () => {
    await hub.cleanup();
    await dev01.close();
  });

  it('creates a new provider and its models on a host, then skips on repeat without overwrite', async () => {
    const id = await createTemplate(hub, { kind: 'planner-provider', name: 'House LLM', payload });

    const first = await instantiate(hub, id, { hostIds: ['dev01'], secrets: { apiKey: 'llm-key' } });
    expect(first.results[0]!.outcome).toBe('provisioned');
    expect(dev01.plannerProviders).toHaveLength(1);
    expect(dev01.plannerProviders[0]).toMatchObject({
      label: 'House LLM',
      baseUrl: 'https://llm.example.com/v1',
      apiKey: 'llm-key',
    });
    expect(dev01.models.map((m) => m.modelId)).toEqual(['house-1', 'house-2']);

    dev01.requests.length = 0;
    const second = await instantiate(hub, id, { hostIds: ['dev01'], secrets: { apiKey: 'llm-key' } });
    expect(second.results[0]!.outcome).toBe('skipped');
    expect(writes(dev01)).toEqual([]);
  });

  it('replaces the provider and only that provider’s model catalog when overwrite is confirmed', async () => {
    dev01.plannerProviders.push(
      { id: 'pp-house', label: 'House LLM', kind: 'openai-compatible', baseUrl: 'https://old.example.com/v1' },
      { id: 'pp-other', label: 'Other LLM', kind: 'openai-compatible', baseUrl: 'https://other.example.com/v1' },
    );
    dev01.models.push(
      { id: 'old-house', providerId: 'pp-house', modelId: 'stale-model', label: 'Stale' },
      { id: 'keep-other', providerId: 'pp-other', modelId: 'other-model', label: 'Other' },
    );
    const id = await createTemplate(hub, { kind: 'planner-provider', name: 'House LLM', payload });
    hub.context.templates.recordProvisioning({
      templateId: id,
      hostId: 'dev01',
      remoteId: 'pp-house',
      revision: 1,
      outcome: 'provisioned',
    });

    const { results } = await instantiate(hub, id, {
      hostIds: ['dev01'],
      secrets: { apiKey: 'llm-key' },
      overwrite: true,
    });

    expect(results[0]!.outcome).toBe('overwritten');
    expect(dev01.plannerProviders.find((p) => p.id === 'pp-house')).toMatchObject({
      baseUrl: 'https://llm.example.com/v1',
      apiKey: 'llm-key',
    });
    // Replaced only `pp-house`'s models; `pp-other`'s model is untouched.
    expect(dev01.models.filter((m) => m.providerId === 'pp-house').map((m) => m.modelId)).toEqual([
      'house-1',
      'house-2',
    ]);
    expect(dev01.models.filter((m) => m.providerId === 'pp-other').map((m) => m.modelId)).toEqual([
      'other-model',
    ]);
  });

  it('leaves an existing catalog alone when the template carries no models', async () => {
    dev01.plannerProviders.push({
      id: 'pp-house',
      label: 'Endpoint only',
      kind: 'openai-compatible',
      baseUrl: 'https://old.example.com/v1',
    });
    dev01.models.push({ id: 'keep', providerId: 'pp-house', modelId: 'curated', label: 'Curated' });
    const id = await createTemplate(hub, {
      kind: 'planner-provider',
      name: 'Endpoint only',
      payload: { ...payload, label: 'Endpoint only', models: [] },
    });
    hub.context.templates.recordProvisioning({
      templateId: id,
      hostId: 'dev01',
      remoteId: 'pp-house',
      revision: 1,
      outcome: 'provisioned',
    });

    await instantiate(hub, id, {
      hostIds: ['dev01'],
      secrets: { apiKey: 'llm-key' },
      overwrite: true,
    });

    expect(dev01.models.map((m) => m.modelId)).toEqual(['curated']);
    expect(writes(dev01).some((w) => w.method === 'DELETE')).toBe(false);
  });

  it('omits a blank optional apiKey rather than clearing the stored one', async () => {
    dev01.plannerProviders.push({
      id: 'pp-house',
      label: 'House LLM',
      kind: 'openai-compatible',
      baseUrl: 'https://old.example.com/v1',
      apiKey: 'existing-secret',
    });
    const id = await createTemplate(hub, {
      kind: 'planner-provider',
      name: 'House LLM',
      payload,
    });
    hub.context.templates.recordProvisioning({
      templateId: id,
      hostId: 'dev01',
      remoteId: 'pp-house',
      revision: 1,
      outcome: 'provisioned',
    });

    await instantiate(hub, id, {
      hostIds: ['dev01'],
      secrets: { apiKey: '   ' },
      overwrite: true,
    });

    const patch = dev01.requests.find(
      (r) => r.method === 'PATCH' && r.path === '/api/planner/providers/pp-house',
    )!.body as Record<string, unknown>;
    expect('apiKey' in patch).toBe(false);
    expect(patch.baseUrl).toBe('https://llm.example.com/v1');
  });

  it('reads legacy planner-endpoint rows from hub_templates and maps them to a planner-provider named after the template', async () => {
    const legacyId = 'tpl-legacy-endpoint';
    const now = Date.now();
    hub.context.db
      .prepare(
        `INSERT INTO hub_templates (id, kind, name, description, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        legacyId,
        'planner-endpoint',
        'Legacy OpenRouter',
        'Old singleton template',
        JSON.stringify({
          baseUrl: 'https://openrouter.ai/api/v1',
          models: [{ modelId: 'gpt-4o', label: 'GPT-4o' }],
          embeddingBaseUrl: null,
          embeddingModelId: null,
          webSearchBaseUrl: null,
          urlFetchBaseUrl: null,
        }),
        now,
        now,
      );

    const listed = await listTemplates(hub);
    const tpl = listed.templates.find((t) => t.id === legacyId)!;
    expect(tpl.kind).toBe('planner-provider');
    expect(tpl.payload).toMatchObject({
      label: 'Legacy OpenRouter',
      kind: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
    });

    const run = await instantiate(hub, legacyId, {
      hostIds: ['dev01'],
      secrets: { apiKey: 'or-key' },
    });
    expect(run.results[0]!.outcome).toBe('provisioned');
    expect(dev01.plannerProviders[0]).toMatchObject({
      label: 'Legacy OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'or-key',
    });
    expect(dev01.models.map((m) => m.modelId)).toEqual(['gpt-4o']);
  });
});
