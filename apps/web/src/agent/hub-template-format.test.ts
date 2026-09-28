import { describe, expect, it } from 'vitest';
import {
  draftFrom,
  payloadFrom,
  validateDraft,
} from './hub-template-format.js';
import type { HubTemplatePayload } from '@pocketagent/protocol';

describe('hub-template-format MCP bundle support', () => {
  it('converts single MCP registry spec to draft and back', () => {
    const spec: HubTemplatePayload = {
      kind: 'mcp-registry',
      payload: {
        name: 'Single MCP',
        transport: 'streamable_http',
        url: 'https://single.example.com/mcp',
        authKind: 'bearer',
        headerName: null,
        description: 'A single registry',
        enabled: true,
      },
    };

    const draft = draftFrom(spec);
    expect(draft.name).toBe('Single MCP');
    expect(draft.url).toBe('https://single.example.com/mcp');
    expect(draft.isBundle).toBe(false);

    const payload = payloadFrom('mcp-registry', draft);
    expect(payload).toEqual({
      name: 'Single MCP',
      transport: 'streamable_http',
      url: 'https://single.example.com/mcp',
      authKind: 'bearer',
      headerName: null,
      description: 'A single registry',
      enabled: true,
    });

    const validated = validateDraft('mcp-registry', draft);
    expect(validated.ok).toBe(true);
  });

  it('converts bundled MCP registry spec to draft and back', () => {
    const spec: HubTemplatePayload = {
      kind: 'mcp-registry',
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
            description: null,
            enabled: true,
          },
        ],
      },
    };

    const draft = draftFrom(spec);
    expect(draft.isBundle).toBe(true);
    expect(draft.mcpRegistries).toHaveLength(2);
    expect(draft.mcpRegistries![0]!.name).toBe('Jira MCP');
    expect(draft.mcpRegistries![1]!.name).toBe('Confluence MCP');

    const payload = payloadFrom('mcp-registry', draft);
    expect(payload).toEqual({
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
          description: null,
          enabled: true,
        },
      ],
    });

    const validated = validateDraft('mcp-registry', draft);
    expect(validated.ok).toBe(true);
  });
});
