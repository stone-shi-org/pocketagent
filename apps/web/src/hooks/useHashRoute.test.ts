import { describe, expect, it, vi } from 'vitest';
import { hashForCurrentHost, locationToHash, parseLocation, type Route } from './useHashRoute.js';
import { DEFAULT_HOST, resolveHostEndpoint } from '../api/host.js';

/**
 * Every route shape, with the hash `toHash` emits for it. The table drives both
 * directions so a new `Route` variant that forgets one of them shows up here.
 */
const ROUTES: { hash: string; route: Route }[] = [
  { hash: '#/', route: { name: 'list' } },
  { hash: '#/s/abc', route: { name: 'terminal', sessionId: 'abc' } },
  { hash: '#/c/conv-1', route: { name: 'chat', conversationId: 'conv-1' } },
  { hash: '#/new', route: { name: 'compose' } },
  { hash: '#/new/%2Fhome%2Fme%2Fsrc', route: { name: 'compose', cwd: '/home/me/src' } },
  { hash: '#/agents', route: { name: 'agents' } },
  { hash: '#/settings', route: { name: 'settings' } },
  { hash: '#/cron', route: { name: 'cron' } },
  { hash: '#/cron/job-1', route: { name: 'cron-job', jobId: 'job-1' } },
  { hash: '#/hooks', route: { name: 'webhooks' } },
  { hash: '#/hooks/hook-1', route: { name: 'webhook', webhookId: 'hook-1' } },
  { hash: '#/planner', route: { name: 'planner' } },
  { hash: '#/planner/chat-1', route: { name: 'planner-chat', chatId: 'chat-1' } },
  { hash: '#/planner/agent/agent-1', route: { name: 'planner-agent', agentId: 'agent-1' } },
];

// The acceptance criterion that matters most: PA-60 is a pure refactor, so a
// URL with no host segment has to behave exactly as it did before it landed.
describe('parseLocation: a bare hash is unchanged', () => {
  it.each(ROUTES)('parses $hash with no host', ({ hash, route }) => {
    expect(parseLocation(hash)).toEqual({ hostId: null, route });
  });

  it.each(ROUTES)('renders $hash back byte-identically', ({ hash, route }) => {
    expect(locationToHash(route, null)).toBe(hash);
  });

  it('falls back to the list for an unrecognised hash, as before', () => {
    expect(parseLocation('#/nonsense')).toEqual({ hostId: null, route: { name: 'list' } });
    expect(parseLocation('')).toEqual({ hostId: null, route: { name: 'list' } });
  });

  it('resolves a missing host segment to the host that served the bundle', () => {
    expect(resolveHostEndpoint(parseLocation('#/s/abc').hostId)).toEqual(DEFAULT_HOST);
  });
});

describe('parseLocation: an explicit host segment', () => {
  it.each(ROUTES)('reaches the same view as the bare $hash', ({ hash, route }) => {
    const prefixed = hash === '#/' ? '#/h/local' : `#/h/local${hash.slice(1)}`;
    const parsed = parseLocation(prefixed);
    expect(parsed.route).toEqual(route);
    expect(parsed.hostId).toBe('local');
  });

  it('resolves the default host id to the default endpoint', () => {
    const parsed = parseLocation('#/h/local/s/abc');
    expect(resolveHostEndpoint(parsed.hostId)).toEqual(DEFAULT_HOST);
    expect(parsed.route).toEqual({ name: 'terminal', sessionId: 'abc' });
  });

  /**
   * A bookmark normally carries the server's own `HostInfo.id` — a sha256 this
   * bundle cannot predict — so an unknown id has to land on the default host
   * rather than erroring, or the one link shape the ticket asks for breaks.
   */
  it('resolves an id it has never seen to the default host rather than failing', () => {
    const parsed = parseLocation('#/h/Zm9vYmFyYmF6cXV4/planner/chat-1');
    expect(parsed.hostId).toBe('Zm9vYmFyYmF6cXV4');
    expect(resolveHostEndpoint(parsed.hostId)).toEqual(DEFAULT_HOST);
    expect(parsed.route).toEqual({ name: 'planner-chat', chatId: 'chat-1' });
  });

  it('treats a bare host segment, with or without a trailing slash, as the list', () => {
    expect(parseLocation('#/h/local')).toEqual({ hostId: 'local', route: { name: 'list' } });
    expect(parseLocation('#/h/local/')).toEqual({ hostId: 'local', route: { name: 'list' } });
  });

  it('round-trips a host id that needs encoding', () => {
    const hash = locationToHash({ name: 'terminal', sessionId: 'abc' }, 'host with/slash');
    expect(hash).toBe('#/h/host%20with%2Fslash/s/abc');
    expect(parseLocation(hash)).toEqual({
      hostId: 'host with/slash',
      route: { name: 'terminal', sessionId: 'abc' },
    });
  });

  it.each(ROUTES)('round-trips $hash through a host prefix', ({ route }) => {
    expect(parseLocation(locationToHash(route, 'h2'))).toEqual({ hostId: 'h2', route });
  });
});

/**
 * Scope item 4 on the ticket: the existing cascade relies on "detail route
 * before the generic one". The host prefix is stripped before that cascade
 * runs, so it cannot reorder anything — these pin that it stays true.
 */
describe('parseLocation: the host prefix does not disturb route ordering', () => {
  it('still prefers planner-agent over planner-chat under a host', () => {
    expect(parseLocation('#/h/local/planner/agent/a1').route).toEqual({
      name: 'planner-agent',
      agentId: 'a1',
    });
  });

  it('still prefers a cron job over the cron list under a host', () => {
    expect(parseLocation('#/h/local/cron/j1').route).toEqual({ name: 'cron-job', jobId: 'j1' });
    expect(parseLocation('#/h/local/cron').route).toEqual({ name: 'cron' });
  });

  it('still redirects the retired webhook history path under a host', () => {
    expect(parseLocation('#/h/local/hooks/history').route).toEqual({ name: 'webhooks' });
  });

  it('does not mistake a route that merely starts with h for a host segment', () => {
    // `#/hooks` is not `#/h/...`; without the separator the prefix pattern
    // would happily eat the first four characters of it.
    expect(parseLocation('#/hooks')).toEqual({ hostId: null, route: { name: 'webhooks' } });
    expect(parseLocation('#/hooks/hook-1')).toEqual({
      hostId: null,
      route: { name: 'webhook', webhookId: 'hook-1' },
    });
  });

  it('does not treat a nested h segment as a host', () => {
    // Only a *leading* `#/h/` is a host; `h` as a session id is still a session.
    expect(parseLocation('#/s/h/x')).toEqual({ hostId: null, route: { name: 'terminal', sessionId: 'h' } });
  });
});

describe('hashForCurrentHost', () => {
  it('preserves the host the page is already on', () => {
    // The raw-assignment call site in `CronJobEditorPage` goes through this;
    // building the hash by hand there silently dropped the host segment.
    vi.stubGlobal('window', { location: { hash: '#/h/h2/cron/j1' } });
    expect(hashForCurrentHost({ name: 'planner-chat', chatId: 'chat-1' })).toBe(
      '#/h/h2/planner/chat-1',
    );
    vi.unstubAllGlobals();
  });

  it('emits a bare hash when the page carries no host segment', () => {
    vi.stubGlobal('window', { location: { hash: '#/cron/j1' } });
    expect(hashForCurrentHost({ name: 'planner-chat', chatId: 'chat-1' })).toBe('#/planner/chat-1');
    vi.unstubAllGlobals();
  });
});
