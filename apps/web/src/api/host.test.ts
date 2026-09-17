import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOST,
  DEFAULT_HOST_ID,
  hostEndpoint,
  hostUrl,
  normalizeBasePath,
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
   */
  it('falls back to the default host for an id it cannot know', () => {
    expect(resolveHostEndpoint('aGkgdGhlcmUK')).toEqual(DEFAULT_HOST);
  });
});
