import { describe, expect, it } from 'vitest';
import {
  compareSemver,
  detectVersionDrift,
  hostVersionStatus,
  latestKnownVersion,
  negotiateProtocol,
} from '@pocketagent/protocol';

/**
 * PA-69's semver arithmetic, tested where its main consumer lives — the same
 * placement `api/negotiate.test.ts` uses for the protocol package's other
 * pure host helper.
 *
 * `host-status.test.ts` covers the fleet-level behaviour through `HostRecord`.
 * This file covers the comparison rules underneath it, which that one cannot
 * reach cleanly and which are the part with real edge cases: this repo ships
 * `0.0.0-dev` as a fallback and `1.2.3-rc.1` as a real release tag, so
 * prerelease precedence is not hypothetical here.
 */

describe('compareSemver', () => {
  it('orders the numeric core before anything else', () => {
    expect(compareSemver('1.4.2', '1.5.0')).toBeLessThan(0);
    expect(compareSemver('1.5.0', '1.4.2')).toBeGreaterThan(0);
    expect(compareSemver('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareSemver('1.4.2', '1.4.2')).toBe(0);
  });

  it('does not compare version parts as strings', () => {
    // The bug every hand-rolled version check ships first: '10' < '9'
    // lexically. A fleet crossing x.10 would report every upgraded host as
    // behind and every stale one as current.
    expect(compareSemver('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareSemver('1.0.10', '1.0.9')).toBeGreaterThan(0);
    expect(compareSemver('10.0.0', '9.0.0')).toBeGreaterThan(0);
  });

  it('sorts a prerelease below the release it precedes', () => {
    expect(compareSemver('1.5.0-rc.1', '1.5.0')).toBeLessThan(0);
    // And so `0.0.0-dev`, the source-checkout fallback, sorts below every
    // real release — which is exactly why that string was chosen.
    expect(compareSemver('0.0.0-dev', '0.0.0')).toBeLessThan(0);
    expect(compareSemver('0.0.0-dev', '0.1.0')).toBeLessThan(0);
  });

  it('compares numeric prerelease identifiers numerically', () => {
    expect(compareSemver('1.5.0-rc.10', '1.5.0-rc.9')).toBeGreaterThan(0);
    expect(compareSemver('1.5.0-rc.2', '1.5.0-rc.10')).toBeLessThan(0);
  });

  it('ranks a numeric identifier below an alphanumeric one, and a longer list above a prefix', () => {
    // Semver §11 to the letter. Both rules exist to make `-alpha` / `-alpha.1`
    // and `-1` / `-one` order deterministically.
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
    expect(compareSemver('1.0.0-alpha.beta', '1.0.0-alpha.1')).toBeGreaterThan(0);
  });

  it('ignores build metadata entirely', () => {
    // CI stamps a git sha there (`1.4.2+abc1234`), so two hosts on the same
    // release must not read as drifting apart.
    expect(compareSemver('1.4.2+abc1234', '1.4.2+def5678')).toBe(0);
    expect(compareSemver('1.4.2+abc1234', '1.4.2')).toBe(0);
    expect(compareSemver('1.4.2-rc.1+abc', '1.4.2-rc.1+def')).toBe(0);
  });

  it('answers null for anything that is not a semver, rather than guessing', () => {
    // Distinct from 0, and it has to stay distinct: collapsing "unparseable"
    // to "equal" would report a host running a garbage version as current.
    expect(compareSemver('not-a-version', '1.0.0')).toBeNull();
    expect(compareSemver('1.0', '1.0.0')).toBeNull();
    expect(compareSemver('v1.0.0', '1.0.0')).toBeNull();
    expect(compareSemver('', '1.0.0')).toBeNull();
  });
});

describe('latestKnownVersion', () => {
  it('picks the newest and skips what it cannot read', () => {
    expect(latestKnownVersion(['1.4.2', '1.5.0', '1.4.9'])).toBe('1.5.0');
    expect(latestKnownVersion(['1.4.2', null, undefined, '', 'garbage'])).toBe('1.4.2');
    expect(latestKnownVersion([])).toBeNull();
    expect(latestKnownVersion([null, 'nope'])).toBeNull();
  });

  it('prefers a release over its own prerelease', () => {
    expect(latestKnownVersion(['1.5.0-rc.1', '1.5.0'])).toBe('1.5.0');
    // A fleet where the only newer thing is a release candidate still reports
    // it: it is the newest build that demonstrably exists.
    expect(latestKnownVersion(['1.4.2', '1.5.0-rc.1'])).toBe('1.5.0-rc.1');
  });
});

describe('detectVersionDrift', () => {
  it('names the four states', () => {
    expect(detectVersionDrift('1.4.2', '1.5.0').state).toBe('behind');
    expect(detectVersionDrift('1.5.0', '1.5.0').state).toBe('current');
    // Not folded into `current`: it means our idea of "latest" is stale, not
    // that this host is fine, and a reader of the badge could not otherwise
    // tell a canary host from an up-to-date one.
    expect(detectVersionDrift('1.6.0', '1.5.0').state).toBe('ahead');
    expect(detectVersionDrift(null, '1.5.0').state).toBe('unknown');
    expect(detectVersionDrift('1.4.2', null).state).toBe('unknown');
    expect(detectVersionDrift('whatever', '1.5.0').state).toBe('unknown');
  });

  it('is total, so one bad host cannot blank a list render', () => {
    for (const host of [null, undefined, '', 'x', '1.2.3']) {
      for (const latest of [null, undefined, '', 'y', '1.2.3']) {
        expect(() => detectVersionDrift(host, latest)).not.toThrow();
      }
    }
  });
});

describe('hostVersionStatus', () => {
  const compatible = negotiateProtocol(15, { min: 15, max: 15 });
  const tooOld = negotiateProtocol(15, { min: 1, max: 14 });
  const unreachable = negotiateProtocol(15, null);

  it('lets incompatibility win over drift', () => {
    const behind = detectVersionDrift('1.0.0', '1.5.0');
    expect(hostVersionStatus(compatible, behind)).toBe('behind');
    // Both true at once is the normal case for a host too old to talk to, and
    // the blocking problem is the one worth reporting.
    expect(hostVersionStatus(tooOld, behind)).toBe('incompatible');
    expect(hostVersionStatus(unreachable, detectVersionDrift(null, '1.5.0'))).toBe('incompatible');
  });

  it('says nothing for a host that is current or merely ahead', () => {
    expect(hostVersionStatus(compatible, detectVersionDrift('1.5.0', '1.5.0'))).toBe('ok');
    expect(hostVersionStatus(compatible, detectVersionDrift('1.6.0', '1.5.0'))).toBe('ok');
    expect(hostVersionStatus(compatible, detectVersionDrift(null, null))).toBe('ok');
  });
});
