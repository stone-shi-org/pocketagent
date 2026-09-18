import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type HostInfo } from '@pocketagent/protocol';
import { hostEndpoint } from '../api/host.js';
import { DEFAULT_HOST } from '../api/host.js';
import {
  findHost,
  hostDotClass,
  hostRecordFor,
  hostStatusFor,
  hostStatusSummary,
  type HostProbe,
} from './host-status.js';

function info(overrides: Partial<HostInfo> = {}): HostInfo {
  return {
    id: 'sha-of-hostname',
    name: 'stone-dev01',
    version: '1.2.3',
    protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
    online: true,
    codeServerBaseUrl: null,
    ...overrides,
  };
}

const probeOk = (overrides: Partial<HostInfo> = {}): HostProbe => ({
  info: info(overrides),
  error: null,
  checkedAt: 1,
});

describe('hostStatusFor', () => {
  it('is unknown before any probe has completed', () => {
    // Not `offline`: the first seconds of a cold load must not accuse a
    // healthy machine, and not `online` either — nothing has been asked yet.
    expect(hostStatusFor(undefined)).toEqual({ status: 'unknown', compatibility: null });
  });

  it('is offline when the probe brought back nothing readable', () => {
    expect(hostStatusFor({ info: null, error: null, checkedAt: 1 }).status).toBe('offline');
  });

  it('is online when the host speaks this bundle protocol', () => {
    const { status, compatibility } = hostStatusFor(probeOk());
    expect(status).toBe('online');
    expect(compatibility?.compatible).toBe(true);
  });

  it('is incompatible when the host protocol range excludes this bundle', () => {
    const { status, compatibility } = hostStatusFor(
      probeOk({ protocol: { min: PROTOCOL_VERSION + 5, max: PROTOCOL_VERSION + 6 } }),
    );
    expect(status).toBe('incompatible');
    expect(compatibility?.compatible).toBe(false);
  });
});

describe('hostRecordFor', () => {
  it('prefers the host own reported name over the registered label', () => {
    const record = hostRecordFor({
      endpoint: hostEndpoint('dev02', '/h/dev02'),
      label: 'dev02',
      probe: probeOk({ name: 'stone-dev02' }),
    });
    expect(record.label).toBe('stone-dev02');
  });

  it('records the backend own id as an alias, so a sha-spelled bookmark resolves', () => {
    // PA-60 shipped "unknown id falls back to the default host" precisely so
    // `#/h/<HostInfo.id>/...` kept working. PA-67 replaces that blanket
    // fallback with this alias, so the link still resolves — but only because
    // it genuinely names this host.
    const record = hostRecordFor({
      endpoint: DEFAULT_HOST,
      label: 'local',
      probe: probeOk({ id: 'sha-of-hostname' }),
    });
    expect(record.aliases).toEqual(['sha-of-hostname']);
    expect(findHost([record], 'sha-of-hostname')).toBe(record);
    expect(findHost([record], 'someone-else')).toBeNull();
  });

  it('does not alias a host whose reported id already matches its routing id', () => {
    const record = hostRecordFor({
      endpoint: hostEndpoint('dev02', '/h/dev02'),
      label: 'dev02',
      probe: probeOk({ id: 'dev02' }),
    });
    expect(record.aliases).toEqual([]);
  });

  it('says where it looked when a host did not answer', () => {
    // The standalone deployment overwhelmingly fails this way — nothing is
    // proxying that prefix yet — and a message with no path in it sends the
    // reader to check the wrong machine.
    const record = hostRecordFor({
      endpoint: hostEndpoint('dev02', '/h/dev02'),
      label: 'dev02',
      probe: { info: null, error: null, checkedAt: 1 },
    });
    expect(record.status).toBe('offline');
    expect(record.message).toContain('/h/dev02/');
  });

  it('names both versions when a host is protocol-incompatible', () => {
    const record = hostRecordFor({
      endpoint: hostEndpoint('dev02', '/h/dev02'),
      label: 'dev02',
      probe: probeOk({ name: 'old-box', protocol: { min: 1, max: 2 } }),
    });
    expect(record.status).toBe('incompatible');
    expect(record.message).toContain('old-box');
    expect(record.message).toContain(`v${PROTOCOL_VERSION}`);
  });

  it('never offers to remove the host serving this bundle', () => {
    expect(hostRecordFor({ endpoint: DEFAULT_HOST, label: 'local' }).canRemove).toBe(false);
    expect(
      hostRecordFor({ endpoint: hostEndpoint('dev02', '/h/dev02'), label: 'dev02' }).canRemove,
    ).toBe(true);
  });

  it('honours a forced state, for a host the Hub reports as disabled', () => {
    const record = hostRecordFor({
      endpoint: hostEndpoint('dev02', '/h/dev02'),
      label: 'dev02',
      probe: probeOk(),
      forced: { status: 'offline', message: 'dev02 is disabled in the Hub.' },
    });
    expect(record.status).toBe('offline');
    expect(record.message).toBe('dev02 is disabled in the Hub.');
  });
});

describe('hostStatusSummary and hostDotClass', () => {
  it('summarises a running count only when the host reports one', () => {
    const base = { endpoint: DEFAULT_HOST, label: 'local' };
    expect(hostStatusSummary(hostRecordFor({ ...base, probe: probeOk() }))).toBe('online');
    expect(
      hostStatusSummary(hostRecordFor({ ...base, probe: probeOk({ runningSessions: 0 }) })),
    ).toBe('idle');
    expect(
      hostStatusSummary(hostRecordFor({ ...base, probe: probeOk({ runningSessions: 3 }) })),
    ).toBe('3 running');
  });

  it('maps each status onto the dot class the palette already defines', () => {
    expect(hostDotClass('online')).toBe('host-dot');
    expect(hostDotClass('offline')).toBe('host-dot offline');
    expect(hostDotClass('incompatible')).toBe('host-dot incompatible');
    expect(hostDotClass('unknown')).toBe('host-dot unknown');
  });
});
