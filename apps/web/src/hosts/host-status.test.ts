import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type HostInfo } from '@pocketagent/protocol';
import { hostEndpoint } from '../api/host.js';
import { DEFAULT_HOST } from '../api/host.js';
import {
  findHost,
  hostDotClass,
  hostDriftMessage,
  hostRecordFor,
  hostStatusFor,
  hostStatusSummary,
  withVersionDrift,
  type HostProbe,
  type HostRecord,
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

describe('version drift (PA-69)', () => {
  /** Two hosts, each reporting the version given. */
  function fleet(...versions: (string | null)[]): HostRecord[] {
    return withVersionDrift(
      versions.map((version, i) =>
        hostRecordFor({
          endpoint: hostEndpoint(`dev0${i}`, `/h/dev0${i}`),
          label: `dev0${i}`,
          probe:
            version === null
              ? { info: null, error: 'down', checkedAt: 1 }
              : probeOk({ name: `dev0${i}`, version }),
        }),
      ),
    );
  }

  it('flags the host that is behind, and only that one', () => {
    const [behind, ahead] = fleet('1.4.2', '1.5.0');
    expect(behind!.drift.state).toBe('behind');
    expect(hostDriftMessage(behind!)).toBe('dev00 is on 1.4.2, 1.5.0 available.');
    // The newest host is not "drifting" and must say nothing, or a healthy
    // fleet becomes a wall of notices.
    expect(ahead!.drift.state).toBe('current');
    expect(hostDriftMessage(ahead!)).toBeNull();
  });

  it('reports no drift when every host is equally stale', () => {
    // Honest rather than wrong: nothing here has seen a newer build. The
    // alternative is this app phoning a release feed, which it does not do.
    for (const record of fleet('1.4.2', '1.4.2')) {
      expect(record.drift.state).toBe('current');
      expect(hostDriftMessage(record)).toBeNull();
    }
  });

  it('reports no drift for a standalone install', () => {
    const [only] = fleet('1.4.2');
    expect(only!.drift.state).toBe('current');
    expect(hostDriftMessage(only!)).toBeNull();
  });

  it('prefers a Hub-reported release over what the hosts happen to show', () => {
    // A Hub that tracks releases knows about one nothing has installed yet,
    // which is exactly the case the inference cannot see.
    const records = withVersionDrift(
      [
        hostRecordFor({
          endpoint: DEFAULT_HOST,
          label: 'local',
          probe: probeOk({ name: 'stone-dev01', version: '1.4.2' }),
        }),
      ],
      '1.6.0',
    );
    expect(records[0]!.drift.state).toBe('behind');
    expect(hostDriftMessage(records[0]!)).toBe('stone-dev01 is on 1.4.2, 1.6.0 available.');
  });

  it('keeps an offline host in the comparison basis', () => {
    // The last version a host reported is still evidence that version exists.
    // Dropping it would make a fleet's drift flicker as hosts come and go —
    // and an offline host reports no version at all, so it cannot itself
    // claim to be up to date.
    const [live, dead] = fleet('1.4.2', null);
    expect(live!.drift.state).toBe('current');
    expect(dead!.drift.state).toBe('unknown');
    expect(hostDriftMessage(dead!)).toBeNull();
  });

  it('says incompatible rather than out of date, never both', () => {
    // The acceptance criterion: "behind" and "protocol-incompatible" stay
    // distinguishable. An unusable host has a blocking problem, and an
    // advisory version badge on the same row would bury it.
    const records = withVersionDrift(
      [
        hostRecordFor({
          endpoint: hostEndpoint('old', '/h/old'),
          label: 'old',
          probe: probeOk({ name: 'old', version: '1.0.0', protocol: { min: 1, max: 1 } }),
        }),
        hostRecordFor({
          endpoint: DEFAULT_HOST,
          label: 'local',
          probe: probeOk({ name: 'local', version: '1.5.0' }),
        }),
      ],
    );
    const stale = records[0]!;
    expect(stale.status).toBe('incompatible');
    // It genuinely *is* behind, and that is still not what the row says.
    expect(stale.drift.state).toBe('behind');
    expect(hostDriftMessage(stale)).toBeNull();
    expect(stale.message).toContain('Upgrade');
  });

  it('ignores build metadata, which CI stamps with a git sha', () => {
    for (const record of fleet('1.4.2+abc1234', '1.4.2+def5678')) {
      expect(record.drift.state).toBe('current');
    }
  });

  it('treats the source-checkout placeholder as older than any release', () => {
    // `resolveServerVersion` falls back to `0.0.0-dev`, chosen to be valid
    // semver that sorts below every real release so drift never special-cases
    // it. This is that promise, from the other side.
    const [dev] = fleet('0.0.0-dev', '0.1.0');
    expect(dev!.drift.state).toBe('behind');
  });
});
