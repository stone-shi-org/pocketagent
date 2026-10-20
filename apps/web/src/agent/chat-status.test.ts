import { describe, expect, it } from 'vitest';
import { CHAT_DOT_LABELS, chatDotState, plannerChatDotState } from '@pocketagent/protocol';

/** PA-165: which dot a row draws. Approval beats running beats unread. */
describe('chatDotState', () => {
  const base = { live: true, busySince: null, awaitingApproval: false, unread: false };

  it('draws nothing for a finished chat, whatever else is set', () => {
    expect(chatDotState({ ...base, live: false, unread: true, awaitingApproval: true })).toBeNull();
  });

  it('puts a parked approval above a running turn, and a running turn above unread', () => {
    expect(chatDotState({ ...base, busySince: 1, awaitingApproval: true, unread: true })).toBe('approval');
    expect(chatDotState({ ...base, busySince: 1, unread: true })).toBe('running');
    expect(chatDotState({ ...base, unread: true })).toBe('unread');
    expect(chatDotState(base)).toBe('idle');
  });

  it('reads an older backend (no attention fields) as idle or running, as before', () => {
    expect(chatDotState({ live: true, busySince: null })).toBe('idle');
    expect(chatDotState({ live: true, busySince: 5 })).toBe('running');
  });
});

describe('plannerChatDotState', () => {
  it('has no idle state: an idle Pocket Agent chat draws nothing', () => {
    expect(plannerChatDotState({ busy: false })).toBeNull();
    expect(plannerChatDotState({ busy: false, unread: true })).toBe('unread');
    expect(plannerChatDotState({ busy: true })).toBe('running');
    expect(plannerChatDotState({ busy: true, awaitingApproval: true })).toBe('approval');
  });

  it('labels every state, so colour is never the only signal', () => {
    for (const state of ['approval', 'running', 'unread', 'idle'] as const) {
      expect(CHAT_DOT_LABELS[state].length).toBeGreaterThan(0);
    }
  });
});
