import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTemplate,
  createTestHub,
  instantiate,
  listTemplates,
  pocketAgentPayload,
  registerHost,
  type TestHub,
} from './helpers.js';
import { startFakeBackend, type FakeBackend } from './fake-backend.js';

/**
 * PA-70 acceptance criterion 1: define a Pocket Agent template once,
 * instantiate it on two hosts, both work, with per-host secrets entered
 * separately.
 *
 * Two hosts rather than one is the whole point of the criterion, and the
 * assertions that matter are about *identity*: each host minted its own
 * resource id, the ledger recorded both, and neither host's row points at the
 * other's. A single-host test would pass with a provisioner that cached the
 * first id it saw.
 */
describe('instantiating a template on two hosts', () => {
  let hub: TestHub;
  let dev01: FakeBackend;
  let dev02: FakeBackend;

  beforeEach(async () => {
    hub = await createTestHub();
    dev01 = await startFakeBackend();
    dev02 = await startFakeBackend();
    registerHost(hub, { id: 'dev01', baseUrl: dev01.baseUrl });
    registerHost(hub, { id: 'dev02', baseUrl: dev02.baseUrl });
  });

  afterEach(async () => {
    await hub.cleanup();
    await dev01.close();
    await dev02.close();
  });

  it('creates the agent on both hosts and records both in the ledger', async () => {
    const id = await createTemplate(hub, {
      kind: 'pocket-agent',
      name: 'Release Notes',
      payload: pocketAgentPayload({ disabledTools: ['exec_command'] }),
    });

    const { results } = await instantiate(hub, id, { hostIds: ['dev01', 'dev02'] });

    expect(results.map((r) => r.outcome)).toEqual(['provisioned', 'provisioned']);
    expect(dev01.workspaces).toHaveLength(1);
    expect(dev02.workspaces).toHaveLength(1);

    // The agent is not merely created, it is *configured*: the create route
    // takes a name and nothing else, so everything else arrives in the
    // follow-up PATCH. A test that only counted workspaces would pass with
    // that patch missing entirely.
    expect(dev01.workspaces[0]).toMatchObject({
      name: 'Release Notes',
      defaultModelId: 'deepseek-chat',
      memoryEnabled: true,
      disabledTools: ['exec_command'],
    });

    // No absolute path was ever sent. A template cannot carry one, so each
    // host minted its own directory under its own data root — the property
    // that makes one template usable on machines with different layouts.
    const createBody = dev01.requests.find(
      (r) => r.method === 'POST' && r.path === '/api/planner/workspaces',
    )?.body as Record<string, unknown>;
    expect(Object.keys(createBody)).toEqual(['name']);

    const { templates } = await listTemplates(hub);
    const ledger = templates.find((t) => t.id === id)!.provisionings;
    expect(ledger.map((p) => p.hostId).sort()).toEqual(['dev01', 'dev02']);
    // Each host's row names that host's own resource, never the other's.
    const byHost = new Map(ledger.map((p) => [p.hostId, p.remoteId]));
    expect(byHost.get('dev01')).toBe(dev01.workspaces[0]!.id);
    expect(byHost.get('dev02')).toBe(dev02.workspaces[0]!.id);
    expect(ledger.every((p) => p.stale === false)).toBe(true);
  });

  it('carries a per-host secret to each host without storing it', async () => {
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

    // "Per-host secrets entered separately" is two runs, one per host — which
    // is also the only way to give two machines different keys.
    await instantiate(hub, id, { hostIds: ['dev01'], secrets: { apiKey: 'key-for-dev01' } });
    await instantiate(hub, id, { hostIds: ['dev02'], secrets: { apiKey: 'key-for-dev02' } });

    expect(dev01.providers[0]?.apiKey).toBe('key-for-dev01');
    expect(dev02.providers[0]?.apiKey).toBe('key-for-dev02');
  });

  it('reports a required secret before dialing the host at all', async () => {
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

    const { results } = await instantiate(hub, id, { hostIds: ['dev01'] });
    expect(results[0]!.outcome).toBe('failed');
    expect(results[0]!.message).toContain('API key is required');
    // Not one request, not even the preflight: a missing precondition is the
    // run's own failure, not something to discover from someone else's 400.
    expect(dev01.requests).toHaveLength(0);
  });

  it('provisions a multi-registry MCP bundle template and handles overwrites', async () => {
    const id = await createTemplate(hub, {
      kind: 'mcp-registry',
      name: 'Dev Tools MCP Bundle',
      payload: {
        registries: [
          {
            name: 'Jira MCP',
            transport: 'streamable_http',
            url: 'https://jira.example.com/mcp',
            authKind: 'bearer',
            headerName: null,
            description: 'Jira integration',
            enabled: true,
          },
          {
            name: 'Confluence MCP',
            transport: 'sse',
            url: 'https://confluence.example.com/mcp',
            authKind: 'header',
            headerName: 'X-Confluence-Key',
            description: 'Confluence integration',
            enabled: true,
          },
        ],
      },
    });

    const { templates } = await listTemplates(hub);
    const tpl = templates.find((t) => t.id === id)!;
    expect(tpl.secretHoles).toEqual([
      expect.objectContaining({
        key: 'bearerToken_0',
        label: 'Bearer token for "Jira MCP"',
        required: true,
      }),
      expect.objectContaining({
        key: 'headerValue_1',
        label: 'Value for X-Confluence-Key (Confluence MCP)',
        required: true,
      }),
    ]);

    // Missing credential fails preflight
    const failedRun = await instantiate(hub, id, {
      hostIds: ['dev01'],
      secrets: { bearerToken_0: 'jira-secret' },
    });
    expect(failedRun.results[0]!.outcome).toBe('failed');
    expect(failedRun.results[0]!.message).toContain('Value for X-Confluence-Key (Confluence MCP) is required');

    // Successful provisioning of bundle
    const run1 = await instantiate(hub, id, {
      hostIds: ['dev01'],
      secrets: {
        bearerToken_0: 'jira-secret',
        headerValue_1: 'confluence-secret',
      },
    });
    expect(run1.results[0]!.outcome).toBe('provisioned');
    expect(dev01.registries).toHaveLength(2);
    expect(dev01.registries[0]!.name).toBe('Jira MCP');
    expect(dev01.registries[0]!.bearerToken).toBe('jira-secret');
    expect(dev01.registries[1]!.name).toBe('Confluence MCP');
    expect(dev01.registries[1]!.headerName).toBe('X-Confluence-Key');
    expect(dev01.registries[1]!.headerValue).toBe('confluence-secret');

    // Second instantiate without overwrite is skipped
    const run2 = await instantiate(hub, id, {
      hostIds: ['dev01'],
      secrets: {
        bearerToken_0: 'jira-secret',
        headerValue_1: 'confluence-secret',
      },
    });
    expect(run2.results[0]!.outcome).toBe('skipped');

    // Overwrite updates existing registries
    const run3 = await instantiate(hub, id, {
      hostIds: ['dev01'],
      secrets: {
        bearerToken_0: 'jira-new-secret',
        headerValue_1: 'confluence-new-secret',
      },
      overwrite: true,
    });
    expect(run3.results[0]!.outcome).toBe('overwritten');
    expect(dev01.registries).toHaveLength(2);
    expect(dev01.registries[0]!.bearerToken).toBe('jira-new-secret');
    expect(dev01.registries[1]!.headerValue).toBe('confluence-new-secret');
  });
});
