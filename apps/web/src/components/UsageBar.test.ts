import { describe, expect, it } from 'vitest';
import type { AgentUsageInfo, UsageWindowInfo } from '@pocketagent/protocol';
import { agentAbbreviation, collapsedWindows, gaugeRings, ringWindows } from './UsageBar.js';

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

describe('ringWindows (PA-131)', () => {
  it('puts the 5-hour window outside and the weekly one inside', () => {
    const five = window('5-hour', 40);
    const weekly = window('Weekly', 10);
    expect(ringWindows(usage('claude'), [weekly, five])).toEqual({ outer: five, inner: weekly });
  });

  it('recognises Codex-style "7-day" as the weekly window', () => {
    const five = window('5h');
    const week = window('7-day');
    expect(ringWindows(usage('codex'), [five, week]).inner).toBe(week);
  });

  it('pairs agy rings within one model group', () => {
    const windows = [window('Claude/GPT 5h'), window('Claude/GPT weekly'), window('Gemini 5h'), window('Gemini weekly')];
    const rings = ringWindows(usage('agy'), windows);
    expect(rings.outer).toBe(windows[2]);
    expect(rings.inner).toBe(windows[3]);
  });

  it('draws one ring when only one window is reported', () => {
    const only = window('5-hour');
    expect(ringWindows(usage('claude'), [only])).toEqual({ outer: only, inner: null });
  });

  it('draws nothing for no windows', () => {
    expect(ringWindows(usage('claude'), [])).toEqual({ outer: null, inner: null });
  });
});

describe('agentAbbreviation (PA-131)', () => {
  it('uses CC / CX / AG for the three known agents', () => {
    expect(agentAbbreviation({ agent: 'claude', agentDisplayName: 'Claude' })).toBe('CC');
    expect(agentAbbreviation({ agent: 'codex', agentDisplayName: 'Codex' })).toBe('CX');
    expect(agentAbbreviation({ agent: 'agy', agentDisplayName: 'Antigravity CLI' })).toBe('AG');
  });

  it('falls back to initials, then to the first two letters', () => {
    expect(agentAbbreviation({ agent: 'x', agentDisplayName: 'Open Code' })).toBe('OC');
    expect(agentAbbreviation({ agent: 'pi', agentDisplayName: 'pi' })).toBe('PI');
  });
});

describe('gaugeRings (PA-156)', () => {
  it('draws 4 thinner concentric rings for agy model tiers in the exact order of the expanded panel', () => {
    const windows = [
      window('Pro 20h', 15),
      window('Flash 20h', 40),
      window('Flash Lite 20h', 10),
      window('Third-Party 20h', 25),
    ];
    expect(gaugeRings(usage('agy'), windows)).toEqual([
      { window: windows[0], r: 20.2, width: 1.8 },
      { window: windows[1], r: 16.8, width: 1.8 },
      { window: windows[2], r: 13.4, width: 1.8 },
      { window: windows[3], r: 10.0, width: 1.8 },
    ]);
  });

  it('keeps the 2-ring gauge for 2-window agents (Claude, Codex) and legacy 5h+weekly agy', () => {
    const claudeWindows = [window('5-hour', 40), window('Weekly', 10)];
    expect(gaugeRings(usage('claude'), claudeWindows)).toEqual([
      { window: claudeWindows[0], r: 19, width: 3.5 },
      { window: claudeWindows[1], r: 13.5, width: 3 },
    ]);

    const legacyAgy = [
      window('Gemini Models 5h', 20),
      window('Gemini Models weekly', 8),
      window('Claude and GPT models 5h', 0),
      window('Claude and GPT models weekly', 0),
    ];
    expect(gaugeRings(usage('agy'), legacyAgy)).toEqual([
      { window: legacyAgy[0], r: 19, width: 3.5 },
      { window: legacyAgy[1], r: 13.5, width: 3 },
    ]);
  });
});
