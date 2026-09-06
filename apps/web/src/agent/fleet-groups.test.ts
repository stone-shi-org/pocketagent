import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '@pocketagent/protocol';
import { fleetSummary, groupFleet, stopAffordance, terminalKindTag } from './fleet-groups.js';

const session = (over: Partial<SessionInfo> = {}): SessionInfo =>
  ({
    id: 's1',
    title: 'A chat',
    agent: 'claude',
    agentDisplayName: 'Claude Code',
    cwd: '/w/p',
    workspaceLabel: 'p',
    status: 'running',
    cols: 0,
    rows: 0,
    pid: null,
    exitCode: null,
    exitSignal: null,
    createdAt: 1,
    startedAt: 1,
    endedAt: null,
    lastActivityAt: null,
    attachedClients: 0,
    epoch: 'e1',
    backend: 'direct',
    transport: 'structured',
    agentSessionId: null,
    durable: false,
    adopted: false,
    adoptTargetId: null,
    skipPermissionsEnabled: false,
    busy: false,
    busySince: null,
    rateLimit: null,
    ...over,
  }) as SessionInfo;

describe('groupFleet', () => {
  it('splits by transport, agents first', () => {
    const groups = groupFleet([
      session({ id: 't1', transport: 'terminal' }),
      session({ id: 'a1', transport: 'structured' }),
      session({ id: 't2', transport: 'terminal' }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['agents', 'terminals']);
    expect(groups.map((g) => g.sessions.map((s) => s.id))).toEqual([['a1'], ['t1', 't2']]);
  });

  it('preserves the caller’s ordering within a group', () => {
    const groups = groupFleet([
      session({ id: 'a2', transport: 'structured' }),
      session({ id: 'a1', transport: 'structured' }),
    ]);
    expect(groups.flatMap((g) => g.sessions.map((s) => s.id))).toEqual(['a2', 'a1']);
  });

  // The page's own single empty state covers "nothing running"; two empty
  // panels would be worse than one.
  it('drops an empty group entirely', () => {
    expect(groupFleet([session({ transport: 'terminal' })]).map((g) => g.key)).toEqual(['terminals']);
    expect(groupFleet([])).toEqual([]);
  });
});

describe('fleetSummary', () => {
  it('names both kinds so a total cannot hide the split', () => {
    expect(
      fleetSummary([
        session({ id: 'a1', transport: 'structured' }),
        session({ id: 't1', transport: 'terminal' }),
        session({ id: 't2', transport: 'terminal' }),
      ]),
    ).toBe('1 agent · 2 terminals');
  });

  it('omits a kind that has nothing running', () => {
    expect(fleetSummary([session({ transport: 'structured' })])).toBe('1 agent');
    expect(fleetSummary([session({ transport: 'terminal' })])).toBe('1 terminal');
  });

  it('says nothing is running when nothing is', () => {
    expect(fleetSummary([])).toBe('Nothing running');
  });
});

describe('terminalKindTag', () => {
  it('names the backend holding the PTY', () => {
    expect(terminalKindTag(session({ transport: 'terminal', backend: 'tmux' }))).toBe('tmux');
    expect(terminalKindTag(session({ transport: 'terminal', backend: 'direct' }))).toBe('direct');
  });

  // The stronger fact: this pane is someone else's and must not be resized.
  it('prefers "adopted pane" over the backend name', () => {
    expect(terminalKindTag(session({ transport: 'terminal', backend: 'direct', adopted: true }))).toBe('adopted pane');
  });

  it('is null for a structured session', () => {
    expect(terminalKindTag(session({ transport: 'structured', backend: 'tmux' }))).toBeNull();
  });
});

describe('stopAffordance', () => {
  it('calls a structured session an agent', () => {
    const words = stopAffordance(session({ transport: 'structured', title: 'Fix the bug' }));
    expect(words.confirmTitle).toBe('Stop this agent?');
    expect(words.confirmBody).toBe('Fix the bug will be stopped.');
    expect(words.ariaLabel).toBe('Stop Fix the bug');
  });

  it('calls a terminal session a session, not an agent', () => {
    const words = stopAffordance(session({ transport: 'terminal' }));
    expect(words.confirmTitle).toBe('Terminate this session?');
    expect(words.confirmLabel).toBe('Terminate');
  });

  // Killing our tmux client must never read as terminating someone else's
  // work — the card has to say the same thing `TerminalPage` does.
  it('says an adopted pane only detaches', () => {
    const words = stopAffordance(session({ transport: 'terminal', adopted: true }));
    expect(words.confirmTitle).toBe('Detach from tmux session?');
    expect(words.confirmBody).toBe('The terminal client will detach. Your tmux session will remain running.');
    expect(words.confirmLabel).toBe('Detach');
    expect(words.busyLabel).toBe('Detaching…');
  });
});
