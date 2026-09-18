import { describe, expect, it } from 'vitest';
import {
  activeHostIds,
  backoffMs,
  BACKGROUND_MS,
  FOREGROUND_MS,
  isDue,
  MAX_BACKOFF_MS,
  pollIntervalFor,
  type PollInputs,
} from './poll-policy.js';

const base: PollInputs = {
  selectedHostId: null,
  collapsedHostIds: [],
  tabHostIds: [],
  singleHost: false,
};

describe('pollIntervalFor', () => {
  it('keeps the single-host cadence exactly as it was before PA-67', () => {
    // The property the whole ticket is shaped around: a standalone install
    // must issue the same requests, on the same 5s schedule, as it did when
    // there was no concept of a host list at all.
    expect(pollIntervalFor('local', { ...base, singleHost: true })).toBe(FOREGROUND_MS);
    expect(
      pollIntervalFor('local', { ...base, singleHost: true, collapsedHostIds: ['local'] }),
    ).toBe(FOREGROUND_MS);
  });

  it('polls the selected host in the foreground and nothing else', () => {
    const inputs = { ...base, selectedHostId: 'dev02' };
    expect(pollIntervalFor('dev02', inputs)).toBe(FOREGROUND_MS);
    expect(pollIntervalFor('local', inputs)).toBeNull();
  });

  it('keeps a host with an open tab on the foreground tier while you browse elsewhere', () => {
    // This is what makes "a live session on host A keeps streaming while the
    // user browses host B" true of the *data* as well as the socket: the tab
    // is on screen, so its chat list must not lag behind it.
    const inputs = { ...base, selectedHostId: 'local', tabHostIds: ['dev02'] };
    expect(pollIntervalFor('dev02', inputs)).toBe(FOREGROUND_MS);
  });

  it('polls an expanded, unselected group in the background', () => {
    expect(pollIntervalFor('dev02', base)).toBe(BACKGROUND_MS);
  });

  it('does not poll a collapsed group at all', () => {
    // Its heading still shows a dot and a running count — those come from the
    // status tier, one cheap request per host, not from this.
    expect(pollIntervalFor('dev02', { ...base, collapsedHostIds: ['dev02'] })).toBeNull();
  });

  it('still polls a collapsed host that has a tab open', () => {
    expect(
      pollIntervalFor('dev02', { ...base, collapsedHostIds: ['dev02'], tabHostIds: ['dev02'] }),
    ).toBe(FOREGROUND_MS);
  });

  it('lists exactly the hosts worth fetching, in order', () => {
    const inputs = { ...base, collapsedHostIds: ['dev03'] };
    expect(activeHostIds(['local', 'dev02', 'dev03'], inputs)).toEqual(['local', 'dev02']);
  });
});

describe('backoffMs', () => {
  it('leaves a healthy host on its own tier cadence', () => {
    expect(backoffMs(FOREGROUND_MS, 0)).toBe(FOREGROUND_MS);
  });

  it('doubles per consecutive failure and caps', () => {
    // One switched-off machine in the registry must not cost a request every
    // five seconds forever — on a phone that is battery and data spent on a
    // host that is not there.
    expect(backoffMs(FOREGROUND_MS, 1)).toBe(10_000);
    expect(backoffMs(FOREGROUND_MS, 2)).toBe(20_000);
    expect(backoffMs(FOREGROUND_MS, 99)).toBe(MAX_BACKOFF_MS);
  });
});

describe('isDue', () => {
  it('is due when never attempted', () => {
    expect(isDue(1_000, undefined, 5_000)).toBe(true);
  });

  it('waits out the interval', () => {
    expect(isDue(5_999, 1_000, 5_000)).toBe(false);
    expect(isDue(6_000, 1_000, 5_000)).toBe(true);
  });
});
