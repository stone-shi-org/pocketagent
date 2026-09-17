import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_MIN_SUPPORTED,
  PROTOCOL_VERSION,
  SERVER_PROTOCOL_RANGE,
  describeIncompatibility,
  negotiateProtocol,
} from '@pocketagent/protocol';
import { compatibilityState, probeHost } from './negotiate.js';
import { DEFAULT_HOST, hostEndpoint } from './host.js';

/** A `/health` body, minus whatever the test wants to break. */
function healthBody(protocol: { min: number; max: number }): unknown {
  return { status: 'ok', version: '1.2.3', protocol, uptimeSeconds: 42 };
}

/** Stands in for `fetch`, answering one canned response. */
function fakeFetch(response: { ok?: boolean; body?: unknown; throws?: boolean }): typeof fetch {
  return (async () => {
    if (response.throws) throw new Error('network down');
    return {
      ok: response.ok ?? true,
      json: async () => response.body,
    } as Response;
  }) as unknown as typeof fetch;
}

describe('negotiateProtocol', () => {
  it('accepts a version inside the host range', () => {
    const result = negotiateProtocol(15, { min: 12, max: 16 });
    expect(result.compatible).toBe(true);
    expect(result.hostRange).toEqual({ min: 12, max: 16 });
  });

  it('accepts both inclusive bounds', () => {
    // Off-by-one here would reject a client on the exact floor or ceiling,
    // which is the single most likely version for it to be on right after a
    // coordinated upgrade.
    expect(negotiateProtocol(12, { min: 12, max: 16 }).compatible).toBe(true);
    expect(negotiateProtocol(16, { min: 12, max: 16 }).compatible).toBe(true);
  });

  it('reports below_min for a bundle older than the host accepts', () => {
    const result = negotiateProtocol(11, { min: 12, max: 16 });
    expect(result).toEqual({
      compatible: false,
      reason: 'below_min',
      clientVersion: 11,
      hostRange: { min: 12, max: 16 },
    });
  });

  it('reports above_max for a host lagging behind the bundle', () => {
    const result = negotiateProtocol(17, { min: 12, max: 16 });
    expect(result).toEqual({
      compatible: false,
      reason: 'above_max',
      clientVersion: 17,
      hostRange: { min: 12, max: 16 },
    });
  });

  it('reports unreachable, distinctly, when there is no range at all', () => {
    // Must not collapse into a version complaint: "cannot be asked" and
    // "asked and incompatible" need different advice.
    const result = negotiateProtocol(15, null);
    expect(result).toMatchObject({ compatible: false, reason: 'unreachable', hostRange: null });
  });

  it('matches this build against its own server range', () => {
    // Guards the single-host, matched-version case the ticket asks to keep
    // intact: whatever the constants are, a bundle must accept its own server.
    expect(negotiateProtocol(PROTOCOL_VERSION, SERVER_PROTOCOL_RANGE).compatible).toBe(true);
    expect(PROTOCOL_MIN_SUPPORTED).toBeLessThanOrEqual(PROTOCOL_VERSION);
  });
});

describe('describeIncompatibility', () => {
  it('says nothing for a compatible host', () => {
    expect(describeIncompatibility('workbench-01', negotiateProtocol(15, { min: 15, max: 15 }))).toBeNull();
  });

  it('names the host and both versions', () => {
    // The acceptance criterion verbatim: which host, which version it has,
    // which it needs.
    const message = describeIncompatibility('workbench-02', negotiateProtocol(17, { min: 12, max: 16 }));
    expect(message).toContain('workbench-02');
    expect(message).toContain('v17');
    expect(message).toContain('v16');
  });

  it('tells you to upgrade the host when the host is behind', () => {
    const message = describeIncompatibility('old-box', negotiateProtocol(17, { min: 12, max: 16 }));
    expect(message).toMatch(/upgrade old-box/i);
    expect(message).not.toMatch(/reload/i);
  });

  it('tells you to reload when the bundle is behind', () => {
    // The opposite remedy, and the reason the two reasons stay separate.
    const message = describeIncompatibility('new-box', negotiateProtocol(11, { min: 12, max: 16 }));
    expect(message).toMatch(/reload/i);
    expect(message).not.toMatch(/upgrade/i);
  });

  it('collapses a single-version range to one number', () => {
    const message = describeIncompatibility('host', negotiateProtocol(9, { min: 15, max: 15 }));
    expect(message).toContain('protocol v15');
    expect(message).not.toContain('v15–v15');
  });
});

describe('probeHost', () => {
  it('reads the range off /health and finds this bundle compatible', async () => {
    const result = await probeHost(
      DEFAULT_HOST,
      fakeFetch({ body: healthBody({ min: 1, max: PROTOCOL_VERSION }) }),
    );
    expect(result.compatible).toBe(true);
  });

  it('finds a host whose range is entirely below this bundle incompatible', async () => {
    const result = await probeHost(DEFAULT_HOST, fakeFetch({ body: healthBody({ min: 1, max: 2 }) }));
    expect(result).toMatchObject({ compatible: false, reason: 'above_max' });
  });

  it('finds a host demanding a newer bundle incompatible', async () => {
    const result = await probeHost(
      DEFAULT_HOST,
      fakeFetch({ body: healthBody({ min: PROTOCOL_VERSION + 1, max: PROTOCOL_VERSION + 5 }) }),
    );
    expect(result).toMatchObject({ compatible: false, reason: 'below_min' });
  });

  it('reports unreachable when /health never answers', async () => {
    // The fourth case the acceptance criteria name. A rejected fetch must
    // become a verdict, not an exception — otherwise one dead host takes out
    // whatever loop is probing the others.
    const result = await probeHost(DEFAULT_HOST, fakeFetch({ throws: true }));
    expect(result).toMatchObject({ compatible: false, reason: 'unreachable' });
  });

  it('reports unreachable for a non-2xx /health', async () => {
    const result = await probeHost(DEFAULT_HOST, fakeFetch({ ok: false }));
    expect(result).toMatchObject({ compatible: false, reason: 'unreachable' });
  });

  it('reports unreachable for a /health too old to carry a protocol range', async () => {
    // A server from before PA-61 answers `{status, version, uptimeSeconds}`.
    // "I could not negotiate with it" is the honest verdict — inventing a
    // range for it would be guessing, and defaulting to compatible would let
    // the socket fail later instead of here.
    const result = await probeHost(
      DEFAULT_HOST,
      fakeFetch({ body: { status: 'ok', version: '0.1.0', uptimeSeconds: 1 } }),
    );
    expect(result).toMatchObject({ compatible: false, reason: 'unreachable' });
  });

  it('asks the host it was given, not the serving origin', async () => {
    const seen: string[] = [];
    const spy = (async (url: string) => {
      seen.push(url);
      return { ok: true, json: async () => healthBody({ min: 1, max: PROTOCOL_VERSION }) } as Response;
    }) as unknown as typeof fetch;
    await probeHost(hostEndpoint('workbench-02', '/h/workbench-02'), spy);
    expect(seen[0]).toBe('/h/workbench-02/health');
  });
});

describe('compatibilityState', () => {
  it('carries a null message for a healthy host', () => {
    const state = compatibilityState('host', negotiateProtocol(15, { min: 15, max: 15 }));
    expect(state.message).toBeNull();
  });

  it('carries the sentence for an unhealthy one', () => {
    const state = compatibilityState('host', negotiateProtocol(15, null));
    expect(state.message).toMatch(/version check/i);
  });
});
