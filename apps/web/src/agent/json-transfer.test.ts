import { describe, expect, it } from 'vitest';
import {
  createExportEnvelope,
  parseExportEnvelope,
  POCKETAGENT_EXPORT_FORMAT,
} from '@pocketagent/protocol';
import {
  exportEnvelopeToHubTemplate,
  exportEnvelopeToHubTemplates,
  formatExportFilename,
  readJsonFile,
} from './json-transfer.js';

describe('json-transfer', () => {
  it('creates valid export envelopes', () => {
    const envelope = createExportEnvelope('pocket-agent', {
      name: 'Agent Zero',
      defaultModelId: 'gpt-4o',
      identityPrompt: 'Hello',
      memoryEnabled: true,
      mcpEnabled: true,
      disabledTools: [],
    }, 'Agent Zero');

    expect(envelope.format).toBe(POCKETAGENT_EXPORT_FORMAT);
    expect(envelope.version).toBe(1);
    expect(envelope.kind).toBe('pocket-agent');
    expect(envelope.name).toBe('Agent Zero');
    expect(envelope.exportedAt).toBeTruthy();
  });

  it('validates matching kind successfully', () => {
    const envelope = createExportEnvelope('cron-job', {
      name: 'Nightly Cleanup',
      agent: 'claude',
      prompt: 'Clean up temp files',
      cronExpr: '0 3 * * *',
    });

    const result = parseExportEnvelope(envelope, 'cron-job');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(expect.objectContaining({
        name: 'Nightly Cleanup',
        agent: 'claude',
        prompt: 'Clean up temp files',
      }));
    }
  });

  it('rejects mismatched kind with descriptive error message (e.g. agent imported to cron)', () => {
    const agentEnvelope = createExportEnvelope('pocket-agent', {
      name: 'Agent Zero',
      defaultModelId: 'gpt-4o',
      identityPrompt: 'Hello',
    });

    const result = parseExportEnvelope(agentEnvelope, 'cron-job');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.actualKind).toBe('pocket-agent');
      expect(result.error).toContain('Cannot import: this file contains a "pocket-agent" export, but this page expects a "cron-job" export.');
    }
  });

  it('rejects objects without pocketagent-export format', () => {
    const invalid = { some: 'random', json: true };
    const result = parseExportEnvelope(invalid, 'server-settings');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('missing format identifier');
    }
  });

  it('formats clean export filenames with timestamps', () => {
    const name = 'Nightly / Weekly Build!';
    const filename = formatExportFilename('cron', name);
    expect(filename).toMatch(/^pocketagent-cron-nightly-weekly-build-\d{8}-\d{6}\.json$/);

    const blankFilename = formatExportFilename('server-settings');
    expect(blankFilename).toMatch(/^pocketagent-server-settings-\d{8}-\d{6}\.json$/);
  });

  it('converts compatible export envelopes into Hub templates', () => {
    const agentEnvelope = createExportEnvelope('pocket-agent', {
      name: 'Code Bot',
      defaultModelId: 'gpt-4o',
      identityPrompt: 'Be concise',
      memoryEnabled: false,
      mcpEnabled: true,
      disabledTools: ['exec_command'],
    });

    const tpl = exportEnvelopeToHubTemplate(agentEnvelope);
    expect(tpl).toEqual({
      kind: 'pocket-agent',
      name: 'Code Bot',
      description: 'Imported from Pocket Agent export',
      payload: {
        name: 'Code Bot',
        defaultModelId: 'gpt-4o',
        identityPrompt: 'Be concise',
        memoryEnabled: false,
        mcpEnabled: true,
        disabledTools: ['exec_command'],
      },
    });
  });

  it('converts planner-provider and legacy planner-endpoint export envelopes into Hub templates', () => {
    const providerEnvelope = createExportEnvelope('planner-provider', {
      label: 'OpenRouter',
      kind: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      allowUnattended: false,
      models: [{ modelId: 'gpt-4o', label: 'GPT-4o' }],
    }, 'OpenRouter');

    expect(exportEnvelopeToHubTemplate(providerEnvelope)).toEqual({
      kind: 'planner-provider',
      name: 'OpenRouter',
      description: 'Imported from Pocket Agent provider export',
      payload: {
        label: 'OpenRouter',
        kind: 'openai-compatible',
        baseUrl: 'https://openrouter.ai/api/v1',
        allowUnattended: false,
        models: [{ modelId: 'gpt-4o', label: 'GPT-4o' }],
      },
    });

    const endpointEnvelope = createExportEnvelope('planner-endpoint', {
      baseUrl: 'https://llm.example.com/v1',
      models: [{ modelId: 'gpt-4o', label: 'GPT-4o' }],
      embeddingBaseUrl: null,
      embeddingModelId: null,
      webSearchBaseUrl: null,
      urlFetchBaseUrl: null,
    }, 'Production Endpoint');

    const tpl = exportEnvelopeToHubTemplate(endpointEnvelope);
    expect(tpl).toEqual({
      kind: 'planner-provider',
      name: 'Production Endpoint',
      description: 'Imported from LLM Endpoint export',
      payload: {
        label: 'Production Endpoint',
        kind: 'openai-compatible',
        baseUrl: 'https://llm.example.com/v1',
        allowUnattended: false,
        models: [{ modelId: 'gpt-4o', label: 'GPT-4o' }],
      },
    });
  });

  it('returns null when trying to convert unsupported exports to Hub templates', () => {
    const cronEnvelope = createExportEnvelope('cron-job', {
      name: 'Nightly',
      agent: 'claude',
      prompt: 'Check logs',
    });
    expect(exportEnvelopeToHubTemplate(cronEnvelope)).toBeNull();

    const settingsEnvelope = createExportEnvelope('server-settings', {
      logLevel: 'info',
    });
    expect(exportEnvelopeToHubTemplate(settingsEnvelope)).toBeNull();
  });

  it('reads and parses valid File objects', async () => {
    const content = JSON.stringify({ hello: 'world' });
    const file = new File([content], 'test.json', { type: 'application/json' });
    const parsed = await readJsonFile(file);
    expect(parsed).toEqual({ hello: 'world' });
  });

  it('rejects unparseable JSON files with clear message', async () => {
    const file = new File(['not valid json {{{'], 'bad.json', { type: 'application/json' });
    await expect(readJsonFile(file)).rejects.toThrow(/Failed to parse "bad\.json" as JSON/);
  });

  it('validates and converts an array of MCP registries into multiple templates', () => {
    const multiMcp = [
      {
        name: 'Jira MCP',
        transport: 'streamable_http' as const,
        url: 'https://jira.internal',
        authKind: 'none' as const,
        headerName: null,
        description: 'Jira server',
        enabled: true,
      },
      {
        name: 'Bamboo MCP',
        transport: 'streamable_http' as const,
        url: 'https://bamboo.internal',
        authKind: 'none' as const,
        headerName: null,
        description: null,
        enabled: false,
      },
    ];
    const envelope = createExportEnvelope('mcp-registry', multiMcp, 'all-mcp');
    const parseRes = parseExportEnvelope(envelope, 'mcp-registry');
    expect(parseRes.ok).toBe(true);

    const templates = exportEnvelopeToHubTemplates(envelope);
    expect(templates).toHaveLength(2);
    expect(templates[0]!.name).toBe('Jira MCP');
    expect(templates[0]!.description).toBe('Jira server');
    expect(templates[1]!.name).toBe('Bamboo MCP');
    expect(templates[1]!.description).toBeUndefined();
  });

  it('validates batch cron-job export envelopes containing an array of jobs', () => {
    const multiJobs = [
      {
        name: 'Nightly Cleanup',
        agent: 'claude',
        prompt: 'Clean up temp files',
        cronExpr: '0 3 * * *',
        enabled: true,
      },
      {
        name: 'Morning Sync',
        agent: 'claude',
        prompt: 'Sync upstream repositories',
        cronExpr: '0 8 * * 1-5',
        enabled: false,
      },
    ];
    const envelope = createExportEnvelope('cron-job', multiJobs, 'all');
    const parseRes = parseExportEnvelope(envelope, 'cron-job');
    expect(parseRes.ok).toBe(true);
    if (parseRes.ok) {
      expect(Array.isArray(parseRes.data)).toBe(true);
      expect(parseRes.data).toHaveLength(2);
      expect((parseRes.data as typeof multiJobs)[0]!.name).toBe('Nightly Cleanup');
      expect((parseRes.data as typeof multiJobs)[1]!.name).toBe('Morning Sync');
    }
  });
});

