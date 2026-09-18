import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REDACT_PATHS } from '../src/app.js';
import {
  allStoredStrings,
  createTemplate,
  createTestHub,
  instantiate,
  listTemplates,
  registerHost,
  type TestHub,
} from './helpers.js';
import { startFakeBackend, type FakeBackend } from './fake-backend.js';

const PROVIDER_KEY = 'sk-provider-secret-value-9f3a';
const MCP_TOKEN = 'mcp-bearer-secret-value-7c21';
const LLM_KEY = 'llm-api-secret-value-4b88';

/**
 * PA-70 acceptance criterion 4: no secret value is ever stored in a template.
 *
 * Asserted the way `bind.test.ts` asserts its own version of this — by
 * scanning **every column of every row** of the Hub's database rather than the
 * tables someone remembered to check. The template tables have no secret
 * column at all, so this is really a test that no future one gets added
 * quietly, and that nothing incidental (a serialized payload, a ledger row, a
 * log-shaped audit column) picks a secret up on the way past.
 */
describe('secrets never reach the Hub database', () => {
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

  it('stores none of three different kinds of secret, anywhere', async () => {
    const provider = await createTemplate(hub, {
      kind: 'claude-provider',
      name: 'DeepSeek',
      payload: {
        name: 'DeepSeek',
        providerKind: 'deepseek',
        baseUrl: 'https://api.deepseek.com/anthropic',
        models: ['deepseek-chat'],
        defaultModel: 'deepseek-chat',
        smallModel: null,
        allowUnattended: false,
      },
    });
    const registry = await createTemplate(hub, {
      kind: 'mcp-registry',
      name: 'Docs MCP',
      payload: {
        name: 'Docs MCP',
        transport: 'streamable_http',
        url: 'https://mcp.example.com/sse',
        authKind: 'bearer',
        headerName: null,
        description: null,
        enabled: true,
      },
    });
    const endpoint = await createTemplate(hub, {
      kind: 'planner-endpoint',
      name: 'House LLM',
      payload: {
        baseUrl: 'https://llm.example.com/v1',
        models: [{ modelId: 'house-1', label: 'House 1' }],
        embeddingBaseUrl: null,
        embeddingModelId: null,
        webSearchBaseUrl: null,
        urlFetchBaseUrl: null,
      },
    });

    await instantiate(hub, provider, { hostIds: ['dev01'], secrets: { apiKey: PROVIDER_KEY } });
    await instantiate(hub, registry, { hostIds: ['dev01'], secrets: { bearerToken: MCP_TOKEN } });
    await instantiate(hub, endpoint, {
      hostIds: ['dev01'],
      secrets: { apiKey: LLM_KEY },
      overwrite: true,
    });

    // Each one really did arrive at the host — otherwise this suite would pass
    // by never sending anything.
    expect(dev01.providers[0]?.apiKey).toBe(PROVIDER_KEY);
    expect(dev01.registries[0]?.bearerToken).toBe(MCP_TOKEN);
    expect(dev01.settings.apiKey).toBe(LLM_KEY);

    const stored = allStoredStrings(hub).join('\n');
    for (const secret of [PROVIDER_KEY, MCP_TOKEN, LLM_KEY]) {
      expect(stored).not.toContain(secret);
    }
  });

  it('never returns a secret from the template API', async () => {
    const id = await createTemplate(hub, {
      kind: 'claude-provider',
      name: 'DeepSeek',
      payload: {
        name: 'DeepSeek',
        providerKind: 'deepseek',
        baseUrl: 'https://api.deepseek.com/anthropic',
        models: ['deepseek-chat'],
        defaultModel: 'deepseek-chat',
        smallModel: null,
        allowUnattended: false,
      },
    });
    const run = await instantiate(hub, id, {
      hostIds: ['dev01'],
      secrets: { apiKey: PROVIDER_KEY },
    });
    expect(JSON.stringify(run)).not.toContain(PROVIDER_KEY);

    const listed = await listTemplates(hub);
    expect(JSON.stringify(listed)).not.toContain(PROVIDER_KEY);

    // What the API *does* return is the shape of what is missing, so an
    // operator knows which credential to paste on the next host.
    const holes = listed.templates.find((t) => t.id === id)!.secretHoles;
    expect(holes).toEqual([expect.objectContaining({ key: 'apiKey', required: true })]);
  });

  it('keeps the instantiate body off the log by construction', () => {
    // The one place a secret exists in this process is a request body, so the
    // redact list is what stops it reaching a log line. Asserted here rather
    // than left to PA-66's own suite, because this ticket is what makes the
    // entry load-bearing: before it, no request body carried a third-party
    // credential.
    expect(REDACT_PATHS).toContain('req.body');
  });
});
