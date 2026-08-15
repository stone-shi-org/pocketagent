import { describe, expect, it } from 'vitest';
import type { AgentUsageInfo, UsageWindowInfo } from '@pocketagent/protocol';
import { collapsedWindows } from './UsageBar.js';

function usage(agent: string, overrides: Partial<AgentUsageInfo> = {}): AgentUsageInfo {
  return {
    agent,
    agentDisplayName: agent,
    available: true,
    percentUsed: 0,
    windowLabel: null,
    resetsAtLabel: null,
    timezone: null,
    windows: [],
    error: null,
    updatedAt: '2026-08-15T00:00:00.000Z',
    ...overrides,
  };
}

function window(label: string, percentUsed = 0): UsageWindowInfo {
  return { label, percentUsed, resetsAtLabel: null, timezone: null };
}

describe('collapsedWindows', () => {
  it('keeps only the 5-hour window for Claude', () => {
    const windows = [window('5-hour', 40), window('Weekly', 10)];
    expect(collapsedWindows(usage('claude'), windows)).toEqual([window('5-hour', 40)]);
  });

  it('keeps only the 5-hour window for Codex', () => {
    const windows = [window('5-hour', 40), window('7-day', 10)];
    expect(collapsedWindows(usage('codex'), windows)).toEqual([window('5-hour', 40)]);
  });

  it('narrows agy down to the Gemini 5-hour window specifically, not every group', () => {
    const windows = [
      window('Gemini Models 5h', 20),
      window('Gemini Models weekly', 8),
      window('Claude and GPT models 5h', 0),
      window('Claude and GPT models weekly', 0),
    ];
    expect(collapsedWindows(usage('agy'), windows)).toEqual([window('Gemini Models 5h', 20)]);
  });

  it('falls back to every 5-hour window for agy when none is labelled Gemini', () => {
    const windows = [window('Claude and GPT models 5h', 0), window('Claude and GPT models weekly', 0)];
    expect(collapsedWindows(usage('agy'), windows)).toEqual([window('Claude and GPT models 5h', 0)]);
  });

  it('falls back to every window when nothing matches a 5-hour label at all', () => {
    const windows = [window('Limit', 50)];
    expect(collapsedWindows(usage('claude'), windows)).toEqual(windows);
    expect(collapsedWindows(usage('agy'), windows)).toEqual(windows);
  });

  it('returns an empty list unchanged', () => {
    expect(collapsedWindows(usage('claude'), [])).toEqual([]);
  });
});
