import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTemplate, createTestHub, instantiate, registerHost, type TestHub } from './helpers.js';
import { startFakeBackend, writes, type FakeBackend } from './fake-backend.js';

const payload = {
  baseUrl: 'https://llm.example.com/v1',
  models: [
    { modelId: 'house-1', label: 'House 1' },
    { modelId: 'house-2', label: 'House 2' },
  ],
  embeddingBaseUrl: null,
  embeddingModelId: null,
  webSearchBaseUrl: null,
  urlFetchBaseUrl: null,
};

/**
 * The planner endpoint is the one *singleton* kind, and so the one that is
 * never a create.
 *
 * Every host already has exactly one planner endpoint, and repointing it
 * changes what every existing Pocket Agent chat on that machine talks to — so
 * unlike the four additive kinds, this one needs the overwrite confirmation
 * even the first time. Treating it like the others would make a first-time
 * provisioning silently replace host-wide configuration.
 */
describe('provisioning a planner endpoint', () => {
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

  it('refuses without a confirmation, even on a host it has never touched', async () => {
    const id = await createTemplate(hub, { kind: 'planner-endpoint', name: 'House LLM', payload });

    const { results } = await instantiate(hub, id, { hostIds: ['dev01'], secrets: { apiKey: 'k' } });

    expect(results[0]!.outcome).toBe('skipped');
    expect(results[0]!.message).toContain('replaces');
    expect(writes(dev01)).toEqual([]);
  });

  it('replaces the endpoint and the model catalog when confirmed', async () => {
    dev01.models.push({ id: 'old', modelId: 'stale-model', label: 'Stale' });
    const id = await createTemplate(hub, { kind: 'planner-endpoint', name: 'House LLM', payload });

    const { results } = await instantiate(hub, id, {
      hostIds: ['dev01'],
      secrets: { apiKey: 'llm-key' },
      overwrite: true,
    });

    expect(results[0]!.outcome).toBe('overwritten');
    expect(dev01.settings).toMatchObject({ baseUrl: 'https://llm.example.com/v1', apiKey: 'llm-key' });
    // Replaced wholesale, not appended to: the catalog a template describes is
    // the catalog the host should have.
    expect(dev01.models.map((m) => m.modelId)).toEqual(['house-1', 'house-2']);
  });

  it('leaves an existing catalog alone when the template carries no models', async () => {
    dev01.models.push({ id: 'keep', modelId: 'curated', label: 'Curated' });
    const id = await createTemplate(hub, {
      kind: 'planner-endpoint',
      name: 'Endpoint only',
      payload: { ...payload, models: [] },
    });

    await instantiate(hub, id, {
      hostIds: ['dev01'],
      secrets: { apiKey: 'llm-key' },
      overwrite: true,
    });

    // `models: []` means "do not touch the catalog", not "empty it" — a
    // template that only sets an endpoint must not discard models an operator
    // curated on that machine.
    expect(dev01.models.map((m) => m.modelId)).toEqual(['curated']);
    expect(writes(dev01).some((w) => w.method === 'DELETE')).toBe(false);
  });

  it('omits a blank optional key rather than clearing the stored one', async () => {
    const id = await createTemplate(hub, {
      kind: 'planner-endpoint',
      name: 'With embeddings',
      payload: { ...payload, embeddingBaseUrl: 'https://emb.example.com/v1', embeddingModelId: 'e-1' },
    });

    await instantiate(hub, id, {
      hostIds: ['dev01'],
      secrets: { apiKey: 'llm-key' },
      overwrite: true,
    });

    const patch = dev01.requests.find(
      (r) => r.method === 'PATCH' && r.path === '/api/planner/settings',
    )!.body as Record<string, unknown>;
    // The backend reads `''` as "clear the stored key"; a hole the operator
    // left blank means "leave whatever is there", so the field is absent.
    expect('embeddingApiKey' in patch).toBe(false);
    expect(patch.embeddingBaseUrl).toBe('https://emb.example.com/v1');
  });
});
