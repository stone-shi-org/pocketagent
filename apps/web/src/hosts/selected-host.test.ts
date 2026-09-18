import { describe, expect, it } from 'vitest';
import { DEFAULT_HOST, hostEndpoint } from '../api/host.js';
import { hostRecordFor, type HostRecord } from './host-status.js';
import { currentHostId, resolveSelection, visibleHosts } from './selected-host.js';
import { hostSegmentFor } from './HostNav.js';

const local: HostRecord = {
  ...hostRecordFor({ endpoint: DEFAULT_HOST, label: 'local' }),
  aliases: ['sha-of-hostname'],
};
const dev02 = hostRecordFor({ endpoint: hostEndpoint('dev02', '/h/dev02'), label: 'dev02' });
const hosts = [local, dev02];

describe('resolveSelection', () => {
  it('reads a bare list route as all hosts', () => {
    // The aggregated home is the default view, and with one host it renders
    // that host with no heading — so this is also the single-host path.
    expect(resolveSelection(null, { name: 'list' }, hosts)).toEqual({ mode: 'all' });
  });

  it('reads a bare detail route as the default host, exactly as PA-60 promised', () => {
    expect(resolveSelection(null, { name: 'terminal', sessionId: 's1' }, hosts)).toEqual({
      mode: 'one',
      hostId: 'local',
    });
  });

  it('resolves an explicit host segment', () => {
    expect(resolveSelection('dev02', { name: 'list' }, hosts)).toEqual({
      mode: 'one',
      hostId: 'dev02',
    });
  });

  it('resolves an alias to the host it actually names', () => {
    expect(resolveSelection('sha-of-hostname', { name: 'terminal', sessionId: 's1' }, hosts)).toEqual(
      { mode: 'one', hostId: 'local' },
    );
  });

  it('reports an unrecognised host rather than silently using the default one', () => {
    // The deliberate reversal of PA-60's blanket fallback: with several hosts,
    // quietly substituting a different machine means every action on the page
    // lands somewhere the URL did not say.
    expect(resolveSelection('ghost', { name: 'terminal', sessionId: 's1' }, hosts)).toEqual({
      mode: 'unknown',
      hostId: 'ghost',
    });
  });
});

describe('currentHostId', () => {
  it('answers with the default host in the aggregated view', () => {
    // Chrome-level actions (Settings, Cron, a new shell) are per-host and
    // "all hosts" cannot answer them; a host group's own heading is where an
    // unambiguous per-host entry point lives.
    expect(currentHostId({ mode: 'all' }, hosts)).toBe('local');
  });

  it('answers with the selected host otherwise', () => {
    expect(currentHostId({ mode: 'one', hostId: 'dev02' }, hosts)).toBe('dev02');
  });
});

describe('visibleHosts', () => {
  it('shows every host in the aggregated view, registry order', () => {
    expect(visibleHosts({ mode: 'all' }, hosts).map((h) => h.endpoint.id)).toEqual([
      'local',
      'dev02',
    ]);
  });

  it('narrows to one host when the hash names one', () => {
    expect(visibleHosts({ mode: 'one', hostId: 'dev02' }, hosts)).toEqual([dev02]);
  });

  it('shows nothing for an unknown host, so the caller renders the not-found state', () => {
    expect(visibleHosts({ mode: 'unknown', hostId: 'ghost' }, hosts)).toEqual([]);
  });
});

describe('hostSegmentFor', () => {
  it('keeps the default host bare, so single-host URLs do not change', () => {
    // PA-60 went out of its way not to rewrite existing bookmarks into
    // `#/h/local/...`; a multi-host UI that did it anyway would undo that for
    // the overwhelmingly common deployment.
    expect(hostSegmentFor(hosts, 'local', { name: 'terminal', sessionId: 's1' })).toBeNull();
  });

  it('writes a segment for any other host', () => {
    expect(hostSegmentFor(hosts, 'dev02', { name: 'terminal', sessionId: 's1' })).toBe('dev02');
  });

  it('writes a segment for the default host list route, which "all hosts" also owns', () => {
    // `#/` is the aggregate; the default host's own home needs a spelling of
    // its own or the two views would share one URL.
    expect(hostSegmentFor(hosts, 'local', { name: 'list' })).toBe('local');
  });
});
