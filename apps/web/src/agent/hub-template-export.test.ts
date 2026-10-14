import { describe, expect, it, vi } from 'vitest';
import type {
  CustomClaudeProviderSummary,
  McpRegistrySummary,
  PlannerAgentToolInfo,
  PlannerModel,
  PlannerProvider,
  PlannerSkillDetailResponse,
  PlannerSkillInfo,
  PlannerWorkspace,
} from '@pocketagent/protocol';
import type { ApiClient } from '../api/client.js';
import {
  exportClaudeProviderPayload,
  exportMcpRegistryPayload,
  exportPlannerProviderPayload,
  exportPocketAgentPayload,
  exportSkillPayload,
  fetchAllHostExportDrafts,
  fetchHostExportDraft,
  listHostExportableItems,
} from './hub-template-export.js';

describe('hub-template-export payloads', () => {
  it('exportPocketAgentPayload extracts disabled tools and options', () => {
    const ws: PlannerWorkspace = {
      id: 'ws-1',
      name: 'Code Bot',
      path: '/data/ws-1',
      defaultModelId: 'gpt-4o',
      identityPrompt: 'You are helpful.',
      memoryEnabled: true,
      mcpEnabled: false,
      createdAt: 1000,
      lastConsolidatedAt: null,
      liveProvider: 'pipeline',
      isDefault: false,
    };
    const tools: PlannerAgentToolInfo[] = [
      { name: 'read_file', description: '', readOnly: true, enabled: true, disabledGlobally: false },
      { name: 'write_file', description: '', readOnly: false, enabled: false, disabledGlobally: false },
      { name: 'exec_command', description: '', readOnly: false, enabled: false, disabledGlobally: false },
    ];
    const payload = exportPocketAgentPayload(ws, tools);
    expect(payload).toEqual({
      name: 'Code Bot',
      defaultModelId: 'gpt-4o',
      identityPrompt: 'You are helpful.',
      memoryEnabled: true,
      mcpEnabled: false,
      disabledTools: ['write_file', 'exec_command'],
    });
  });

  it('exportMcpRegistryPayload extracts transport and auth config', () => {
    const reg: McpRegistrySummary = {
      id: 'reg-1',
      name: 'FS MCP',
      transport: 'streamable_http',
      url: 'https://mcp.example.com',
      authKind: 'header',
      headerName: 'X-Api-Key',
      description: 'Filesystem MCP',
      enabled: true,
      createdAt: 1000,
      updatedAt: 2000,
      lastError: null,
      reportedInstructions: null,
      toolCount: 0,
      lastConnectedAt: null,
      cooldownUntil: null,
    };
    const payload = exportMcpRegistryPayload(reg);
    expect(payload).toEqual({
      name: 'FS MCP',
      transport: 'streamable_http',
      url: 'https://mcp.example.com',
      authKind: 'header',
      headerName: 'X-Api-Key',
      description: 'Filesystem MCP',
      enabled: true,
    });
  });

  it('exportClaudeProviderPayload extracts model catalog and provider kind', () => {
    const prov: CustomClaudeProviderSummary = {
      id: 'prov-1',
      name: 'My Claude',
      providerKind: 'claude-compatible',
      baseUrl: 'https://anthropic.proxy.com',
      models: ['claude-3-5-sonnet', 'claude-3-5-haiku'],
      defaultModel: 'claude-3-5-sonnet',
      smallModel: 'claude-3-5-haiku',
      allowUnattended: true,
      supportsEffort: true,
      createdAt: 1000,
      updatedAt: 2000,
    };
    const payload = exportClaudeProviderPayload(prov);
    expect(payload).toEqual({
      name: 'My Claude',
      providerKind: 'claude-compatible',
      baseUrl: 'https://anthropic.proxy.com',
      models: ['claude-3-5-sonnet', 'claude-3-5-haiku'],
      defaultModel: 'claude-3-5-sonnet',
      smallModel: 'claude-3-5-haiku',
      allowUnattended: true,
      supportsEffort: true,
    });
  });

  it('exportSkillPayload extracts slug, name, description, and body', () => {
    const skill = {
      slug: 'code-review',
      name: 'Code Review',
      description: 'Checks PRs for bugs.',
      body: '# Code Review Guidelines\nCheck formatting.',
    };
    const payload = exportSkillPayload(skill);
    expect(payload).toEqual({
      slug: 'code-review',
      name: 'Code Review',
      description: 'Checks PRs for bugs.',
      body: '# Code Review Guidelines\nCheck formatting.',
    });
  });

  it('exportPlannerProviderPayload extracts provider fields and models', () => {
    const provider: PlannerProvider = {
      id: 'pp-1',
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
    };
    const models: PlannerModel[] = [
      { id: 'm-1', providerId: 'pp-1', modelId: 'gpt-4o', label: 'GPT-4o', createdAt: 1000, sortOrder: 0, supportsEffort: true },
      { id: 'm-2', providerId: 'pp-1', modelId: 'o1-mini', label: 'o1 Mini', createdAt: 1000, sortOrder: 1, supportsEffort: true },
    ];
    const payload = exportPlannerProviderPayload(provider, models);
    expect(payload).toEqual({
      label: 'OpenRouter',
      kind: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      allowUnattended: false,
      models: [
        {
          modelId: 'gpt-4o',
          label: 'GPT-4o',
          supportsEffort: true,
        },
        {
          modelId: 'o1-mini',
          label: 'o1 Mini',
          supportsEffort: true,
        },
      ],
    });
  });
});

describe('listHostExportableItems', () => {
  it('lists workspaces for pocket-agent', async () => {
    const client = {
      listPlannerWorkspaces: vi.fn().mockResolvedValue({
        workspaces: [{ id: 'w1', name: 'Agent 1' }, { id: 'w2', name: 'Agent 2' }],
      }),
    } as unknown as ApiClient;

    const items = await listHostExportableItems(client, 'pocket-agent');
    expect(items).toEqual([
      { id: 'w1', label: 'Agent 1' },
      { id: 'w2', label: 'Agent 2' },
    ]);
  });

  it('lists registries for mcp-registry', async () => {
    const client = {
      listMcpRegistries: vi.fn().mockResolvedValue({
        registries: [{ id: 'r1', name: 'Reg 1', description: 'Desc 1' }],
      }),
    } as unknown as ApiClient;

    const items = await listHostExportableItems(client, 'mcp-registry');
    expect(items).toEqual([
      { id: 'r1', label: 'Reg 1', description: 'Desc 1' },
    ]);
  });

  it('filters to global skills for skill kind', async () => {
    const client = {
      listPlannerSkills: vi.fn().mockResolvedValue({
        skills: [
          { id: 'global:sk1', slug: 'sk1', name: 'Skill 1', description: 'Global skill', source: 'global' },
          { id: 'ws1:sk2', slug: 'sk2', name: 'Skill 2', description: 'Local skill', source: 'ws1' },
        ] as PlannerSkillInfo[],
      }),
    } as unknown as ApiClient;

    const items = await listHostExportableItems(client, 'skill');
    expect(items).toEqual([
      { id: 'global:sk1', label: 'Skill 1', description: 'Global skill' },
    ]);
  });

  it('lists providers for planner-provider', async () => {
    const client = {
      listPlannerProviders: vi.fn().mockResolvedValue({
        providers: [{ id: 'pp-1', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' }],
      }),
    } as unknown as ApiClient;
    const items = await listHostExportableItems(client, 'planner-provider');
    expect(items).toEqual([
      { id: 'pp-1', label: 'OpenRouter', description: 'https://openrouter.ai/api/v1' },
    ]);
  });
});

describe('fetchHostExportDraft', () => {
  it('fetches and formats a pocket-agent draft', async () => {
    const client = {
      listPlannerWorkspaces: vi.fn().mockResolvedValue({
        workspaces: [
          {
            id: 'ws-1',
            name: 'Coder',
            defaultModelId: 'gpt-4o',
            identityPrompt: 'Coder identity',
            memoryEnabled: true,
            mcpEnabled: true,
          },
        ],
      }),
      listPlannerAgentTools: vi.fn().mockResolvedValue({
        tools: [{ name: 'exec_command', enabled: false }],
      }),
    } as unknown as ApiClient;

    const draft = await fetchHostExportDraft(client, 'pocket-agent', 'ws-1', 'Server-1');
    expect(draft.defaultName).toBe('Coder');
    expect(draft.defaultDescription).toBe('Exported from Server-1');
    expect(draft.payload).toEqual({
      name: 'Coder',
      defaultModelId: 'gpt-4o',
      identityPrompt: 'Coder identity',
      memoryEnabled: true,
      mcpEnabled: true,
      disabledTools: ['exec_command'],
    });
  });

  it('fetches and formats a skill draft', async () => {
    const skillDetail: PlannerSkillDetailResponse = {
      id: 'global:formatter',
      slug: 'formatter',
      name: 'Formatter',
      description: 'Formats files',
      source: 'global',
      sourceLabel: 'Global',
      enabled: true,
      body: 'Do format',
    };
    const client = {
      getPlannerSkill: vi.fn().mockResolvedValue(skillDetail),
    } as unknown as ApiClient;

    const draft = await fetchHostExportDraft(client, 'skill', 'global:formatter', 'Server-1');
    expect(draft.defaultName).toBe('Formatter');
    expect(draft.defaultDescription).toBe('Formats files');
    expect(draft.payload).toEqual({
      slug: 'formatter',
      name: 'Formatter',
      description: 'Formats files',
      body: 'Do format',
    });
  });

  it('fetches and formats a planner-provider draft', async () => {
    const client = {
      listPlannerProviders: vi.fn().mockResolvedValue({
        providers: [
          {
            id: 'pp-1',
            label: 'OpenRouter',
            kind: 'openai-compatible',
            baseUrl: 'https://openrouter.ai/api/v1',
            allowUnattended: false,
          },
        ],
      }),
      listPlannerModels: vi.fn().mockResolvedValue({
        models: [
          { id: 'm-1', providerId: 'pp-1', modelId: 'gpt-4o', label: 'GPT-4o', supportsEffort: true },
        ],
      }),
    } as unknown as ApiClient;

    const draft = await fetchHostExportDraft(client, 'planner-provider', 'pp-1', 'Server-1');
    expect(draft.defaultName).toBe('OpenRouter');
    expect(draft.payload).toEqual({
      label: 'OpenRouter',
      kind: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      allowUnattended: false,
      models: [
        {
          modelId: 'gpt-4o',
          label: 'GPT-4o',
          supportsEffort: true,
        },
      ],
    });
  });

  it('fetches all drafts for mcp-registry', async () => {
    const client = {
      listMcpRegistries: vi.fn().mockResolvedValue({
        registries: [
          {
            id: 'r1',
            name: 'Jira MCP',
            transport: 'streamable_http',
            url: 'https://jira.internal',
            authKind: 'none',
            enabled: true,
            description: 'Jira server',
          },
          {
            id: 'r2',
            name: 'Bamboo MCP',
            transport: 'streamable_http',
            url: 'https://bamboo.internal',
            authKind: 'none',
            enabled: false,
            description: null,
          },
        ],
      }),
    } as unknown as ApiClient;

    const drafts = await fetchAllHostExportDrafts(client, 'mcp-registry', 'HostA');
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.defaultName).toBe('Jira MCP');
    expect(drafts[0]!.defaultDescription).toBe('Jira server');
    expect(drafts[1]!.defaultName).toBe('Bamboo MCP');
    expect(drafts[1]!.defaultDescription).toBe('Exported from HostA');
  });
});

