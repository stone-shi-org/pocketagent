import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_HOST,
  DEFAULT_HOST_ID,
  hostEndpoint,
  hostUrl,
  listKnownHosts,
  normalizeBasePath,
  publishKnownHosts,
  resetKnownHosts,
  resolveHostEndpoint,
} from './host.js';

describe('normalizeBasePath', () => {
  it('treats empty and root as no prefix at all', () => {
    expect(normalizeBasePath('')).toBe('');
    expect(normalizeBasePath('   ')).toBe('');
    expect(normalizeBasePath('/')).toBe('');
  });

  it('adds the leading slash and drops the trailing one', () => {
    // The point is that every accepted spelling produces one canonical form,
    // since a doubled or missing slash only surfaces as a 404 at runtime.
    for (const raw of ['h/a', '/h/a', '/h/a/', 'h/a/', '//h/a//']) {
      expect(normalizeBasePath(raw)).toBe('/h/a');
    }
  });

  it('collapses interior repeated slashes', () => {
    expect(normalizeBasePath('/h//a///b')).toBe('/h/a/b');
  });
});

describe('hostUrl', () => {
  it('returns an api path untouched for the default host', () => {
    // This is the whole compatibility claim of PA-60: one host, zero change.
    expect(hostUrl(DEFAULT_HOST, '/api/sessions')).toBe('/api/sessions');
    expect(hostUrl(DEFAULT_HOST, '/api/ws?v=7')).toBe('/api/ws?v=7');
  });

  it('prefixes a non-empty base path exactly once, with no doubled slash', () => {
    const endpoint = hostEndpoint('h2', '/h/h2/');
    expect(hostUrl(endpoint, '/api/sessions')).toBe('/h/h2/api/sessions');
  });

  it('keeps a query string intact', () => {
    expect(hostUrl(hostEndpoint('h2', '/h/h2'), '/api/projects?includeHidden=1')).toBe(
      '/h/h2/api/projects?includeHidden=1',
    );
  });
});

describe('resolveHostEndpoint', () => {
  it('maps no host segment to the host that served the bundle', () => {
    expect(resolveHostEndpoint(null)).toEqual(DEFAULT_HOST);
    expect(DEFAULT_HOST.basePath).toBe('');
  });

  it('maps the default id to the default endpoint', () => {
    expect(resolveHostEndpoint(DEFAULT_HOST_ID)).toEqual(DEFAULT_HOST);
  });

  /**
   * A `#/h/<hostId>/...` bookmark normally carries the server's own
   * `HostInfo.id` — a sha256 of hostname plus workspace roots, minted in
   * `ProjectService.host()` and unknowable to this bundle before a response
   * arrives. Falling back is what makes that link shape work at all, and with
   * one host there is no other machine it could wrongly address.
   *
   * Since PA-67 that fallback is only half the answer: it still yields an
   * address, because every caller needs one, but whether the id names anything
   * is `resolveSelection`'s decision and an unknown one renders a "no such
   * host" screen rather than quietly using this endpoint.
   */
  it('falls back to the default host for an id it cannot know', () => {
    expect(resolveHostEndpoint('aGkgdGhlcmUK')).toEqual(DEFAULT_HOST);
  });
});

describe('publishKnownHosts (PA-67)', () => {
  afterEach(() => {
    resetKnownHosts();
  });

  it('resolves a published host to its own prefix', () => {
    const dev02 = hostEndpoint('dev02', '/h/dev02');
    publishKnownHosts([DEFAULT_HOST, dev02]);
    expect(resolveHostEndpoint('dev02')).toBe(dev02);
    expect(listKnownHosts()).toEqual([DEFAULT_HOST, dev02]);
  });

  it('resolves an alias to the host it names', () => {
    publishKnownHosts([DEFAULT_HOST], new Map([['sha-of-hostname', DEFAULT_HOST_ID]]));
    expect(resolveHostEndpoint('sha-of-hostname')).toBe(DEFAULT_HOST);
  });

  it('always keeps the default host addressable', () => {
    // A registry that could omit the host serving this bundle would leave a
    // bare `#/` route with nothing to fetch from.
    publishKnownHosts([hostEndpoint('dev02', '/h/dev02')]);
    expect(listKnownHosts()[0]).toBe(DEFAULT_HOST);
  });

  it('interns endpoints, because their identity is a React dependency', () => {
    // A fresh object per status poll would re-create every host's API client
    // and reopen every live socket every 30 seconds.
    expect(hostEndpoint('dev02', '/h/dev02')).toBe(hostEndpoint('dev02', 'h/dev02/'));
    expect(hostEndpoint(DEFAULT_HOST_ID, '')).toBe(DEFAULT_HOST);
  });
});
