import { describe, expect, it } from 'vitest';
import type { WebhookRoutingState } from '@pocketagent/protocol';
import { DEFAULT_HOST, hostEndpoint } from '../api/host.js';
import type { HostRecord } from './host-status.js';
import {
  isRemoteHost,
  remoteCwdProblem,
  remoteDeliveryRoute,
  remoteDeliveryStateText,
  remoteDisclosure,
  remoteRoutingIdFor,
  remoteTargetHosts,
  routingHostOptions,
  serializeMapRow,
} from './webhook-remote.js';

const routing: WebhookRoutingState = {
  configured: true,
  url: 'https://hub.example',
  tokenPrefix: 'phm_abc',
  unreadable: false,
  selfHostId: 'dev01',
  hosts: [
    { id: 'dev01', label: 'Dev 01' },
    { id: 'mac01', label: 'Mac 01' },
  ],
  updatedAt: 1,
};

const record = (over: Partial<HostRecord>): HostRecord => ({ ...({} as HostRecord), aliases: [], ...over });

const delivery = (over: Partial<Parameters<typeof remoteDeliveryRoute>[0]> = {}) => ({
  remoteHostId: 'mac01',
  remoteRef: null,
  remoteState: null,
  sessionId: null,
  plannerChatId: null,
  ...over,
});

describe('remoteRoutingIdFor', () => {
  const hosts = [
    record({ endpoint: DEFAULT_HOST, hubHostId: 'dev01', label: 'Dev 01' }),
    record({ endpoint: hostEndpoint('mac01', '/h/mac01'), hubHostId: 'mac01', label: 'Mac 01' }),
  ];

  it('routes the Hub default host by its routing id, not its registry id', () => {
    expect(remoteRoutingIdFor('hub', hosts, 'dev01')).toBe(DEFAULT_HOST.id);
    expect(remoteRoutingIdFor('hub', hosts, 'mac01')).toBe('mac01');
  });

  it('cannot reach anything without a Hub, or a host the directory does not know', () => {
    expect(remoteRoutingIdFor('local', hosts, 'mac01')).toBeNull();
    expect(remoteRoutingIdFor('hub', hosts, 'gone')).toBeNull();
  });
});

describe('remoteDeliveryRoute', () => {
  it('is null for a local delivery, even one with a session', () => {
    expect(remoteDeliveryRoute(delivery({ remoteHostId: null, sessionId: 's1' }))).toBeNull();
  });

  it('prefers the delivery ids, then the Hub ref', () => {
    expect(remoteDeliveryRoute(delivery({ sessionId: 's1', remoteRef: 'session:other' }))).toEqual({
      name: 'terminal',
      sessionId: 's1',
    });
    expect(remoteDeliveryRoute(delivery({ plannerChatId: 'c1' }))).toEqual({ name: 'planner-chat', chatId: 'c1' });
    expect(remoteDeliveryRoute(delivery({ remoteRef: 'session:s2' }))).toEqual({ name: 'terminal', sessionId: 's2' });
    expect(remoteDeliveryRoute(delivery({ remoteRef: 'chat:c2' }))).toEqual({ name: 'planner-chat', chatId: 'c2' });
    expect(remoteDeliveryRoute(delivery({ remoteRef: 'session:' }))).toBeNull();
  });
});

describe('remoteDeliveryStateText', () => {
  it('names the host where a person has to act', () => {
    expect(remoteDeliveryStateText(delivery({ remoteState: 'queued' }), 'Mac 01')).toBe('queued (remote)');
    expect(remoteDeliveryStateText(delivery({ remoteState: 'awaiting_approval' }), 'Mac 01')).toBe(
      'awaiting approval on Mac 01',
    );
    expect(remoteDeliveryStateText(delivery(), 'Mac 01')).toBeNull();
    expect(remoteDeliveryStateText(delivery({ remoteHostId: null, remoteState: 'queued' }), 'x')).toBeNull();
  });
});

describe('routingHostOptions', () => {
  it('is empty on a standalone install, so the editor shows no host picker', () => {
    expect(routingHostOptions(null, [undefined, null])).toEqual([]);
    expect(routingHostOptions({ ...routing, configured: false }, [])).toEqual([]);
  });

  it('leaves out this server, which "This server" already means', () => {
    expect(routingHostOptions(routing, [])).toEqual([{ value: 'mac01', label: 'Mac 01' }]);
  });

  it('keeps a saved host that is no longer allowed, rather than silently moving the row', () => {
    expect(routingHostOptions(null, ['mac01'])).toEqual([{ value: 'mac01', label: 'mac01 (not allowed)' }]);
    expect(routingHostOptions(routing, ['old02', 'dev01'])).toEqual([
      { value: 'mac01', label: 'Mac 01' },
      { value: 'old02', label: 'old02 (not allowed)' },
    ]);
  });
});

describe('serializeMapRow', () => {
  it('omits hostId for this server and for its own id, keeping old rows byte-identical', () => {
    expect(serializeMapRow(routing, 'projectKey', 'ENG', '/src/a', undefined)).toEqual({ projectKey: 'ENG', cwd: '/src/a' });
    expect(serializeMapRow(routing, 'projectKey', 'ENG', '/src/a', 'dev01')).toEqual({ projectKey: 'ENG', cwd: '/src/a' });
    expect('hostId' in serializeMapRow(routing, 'planKey', 'EM-EM', '/src/a', '')).toBe(false);
  });

  it('keeps a remote host', () => {
    expect(serializeMapRow(routing, 'planKey', 'EM-EM', '/src/b', 'mac01')).toEqual({
      planKey: 'EM-EM',
      cwd: '/src/b',
      hostId: 'mac01',
    });
  });
});

describe('remoteTargetHosts and remoteDisclosure', () => {
  const rows = [{ hostId: 'mac01' }, { hostId: undefined }, { hostId: 'mac01' }, { hostId: 'dev01' }];

  it('ignores map rows in workspace mode, because the map is sent empty', () => {
    expect(remoteTargetHosts(routing, 'workspace', null, rows)).toEqual([]);
    expect(remoteTargetHosts(routing, 'workspace', 'mac01', [])).toEqual(['mac01']);
  });

  it('counts each remote host once in auto-map mode', () => {
    expect(remoteTargetHosts(routing, 'auto-map', null, rows)).toEqual(['mac01']);
  });

  it('owes nothing when every target is local', () => {
    expect(remoteDisclosure([], 'new-branch')).toEqual([]);
  });

  it('says who answers approvals, and what happens to branches', () => {
    const lines = remoteDisclosure(['Mac 01'], 'new-branch');
    expect(lines[0]).toContain('answered on Mac 01');
    expect(lines[0]).toContain("Skip permissions does not apply there");
    expect(lines[1]).toBe('On another host a fresh branch is minted for every run.');
    expect(remoteDisclosure(['Mac 01'], 'none')).toHaveLength(1);
    expect(remoteDisclosure(['Mac 01'], 'current-branch')[1]).toContain('cannot run on another host');
  });
});

describe('isRemoteHost and remoteCwdProblem', () => {
  it('treats null, empty and this server as local', () => {
    expect(isRemoteHost(routing, null)).toBe(false);
    expect(isRemoteHost(routing, '')).toBe(false);
    expect(isRemoteHost(routing, 'dev01')).toBe(false);
    expect(isRemoteHost(routing, 'mac01')).toBe(true);
  });

  it('wants an absolute path', () => {
    expect(remoteCwdProblem('')).toBeNull();
    expect(remoteCwdProblem('/src/a')).toBeNull();
    expect(remoteCwdProblem('src/a')).not.toBeNull();
  });
});
