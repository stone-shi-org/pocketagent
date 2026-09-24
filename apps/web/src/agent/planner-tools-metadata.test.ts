import { describe, expect, it } from 'vitest';
import {
  TOOL_CATEGORIES,
  TOOL_METADATA,
  getToolCategory,
  getToolShortDescription,
  groupToolsByCategory,
} from './planner-tools-metadata.js';

describe('planner-tools-metadata', () => {
  it('defines short descriptions for all standard tools', () => {
    expect(TOOL_METADATA.read_file?.shortDescription).toBe('Read file contents from a workspace');
    expect(TOOL_METADATA.bash?.shortDescription).toBe('Execute shell commands inside the workspace');
    expect(TOOL_METADATA.web_search?.shortDescription).toBe('Search the web using DuckDuckGo');
  });

  it('falls back gracefully for unknown tools', () => {
    expect(getToolShortDescription('unknown_tool', 'This is a long description of a tool that does things.'))
      .toBe('This is a long description of a tool that does things.');
    expect(getToolShortDescription('unknown_tool', '')).toBe('');
    expect(getToolCategory('unknown_tool')).toBe('Settings & Administration');
  });

  it('groups tools into ordered categories without dropping any', () => {
    const tools = [
      { name: 'read_file', description: 'desc1' },
      { name: 'bash', description: 'desc2' },
      { name: 'web_search', description: 'desc3' },
      { name: 'write_file', description: 'desc4' },
    ];
    const grouped = groupToolsByCategory(tools);
    expect(grouped.length).toBe(3); // Files, Terminal, Web
    expect(grouped[0]!.category).toBe('Files & Workspaces');
    expect(grouped[0]!.tools.map((t) => t.name)).toEqual(['read_file', 'write_file']);
    expect(grouped[1]!.category).toBe('Terminal & Execution');
    expect(grouped[1]!.tools.map((t) => t.name)).toEqual(['bash']);
    expect(grouped[2]!.category).toBe('Web & Search');
    expect(grouped[2]!.tools.map((t) => t.name)).toEqual(['web_search']);
  });

  it('covers all defined categories', () => {
    expect(TOOL_CATEGORIES).toContain('Files & Workspaces');
    expect(TOOL_CATEGORIES).toContain('Sessions & Subagents');
    expect(TOOL_CATEGORIES).toContain('Terminal & Execution');
    expect(TOOL_CATEGORIES).toContain('Web & Search');
    expect(TOOL_CATEGORIES).toContain('Memory');
    expect(TOOL_CATEGORIES).toContain('Integrations');
    expect(TOOL_CATEGORIES).toContain('Settings & Administration');
  });
});
