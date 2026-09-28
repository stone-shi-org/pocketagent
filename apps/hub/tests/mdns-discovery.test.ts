import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MDNS_PORT,
  MdnsAdvertiser,
  MdnsBrowser,
  RR_TYPE,
  decodePacket,
  encodePacket,
  type MdnsRemote,
  type MdnsTransport,
} from '@pocketagent/node-kit';
import { HubDiscoveryResponse } from '@pocketagent/protocol';
import { createTestHub, type TestHub } from './helpers.js';
import { preferredAddress, usableAddresses } from '../src/discovery/service.js';

/**
 * PA-110: a backend's advertiser and a Hub's browser, talking over an
 * in-memory multicast bus.
 *
 * In-memory on purpose. CI has no guaranteed multicast, and a suite over the
 * real socket that "passed" because nothing was ever delivered would prove
 * nothing — while one that *did* deliver would also hear, and answer, every
 * other mDNS responder on whatever LAN the runner sits on. Real interop
 * (avahi-browse seeing our advertiser, our browser seeing avahi-publish) is
 * the manual acceptance evidence recorded on the ticket.
 */

interface Member {
  readonly address: string;
  readonly port: number;
  deliver(packet: Buffer, from: MdnsRemote): void;
}

function createBus() {
  const members = new Set<Member>();
  const sent: { from: string; to: MdnsRemote | 'multicast'; packet: Buffer }[] = [];
  return {
    sent,
    /** A transport bound as `address:port`. Port 5353 joins the group; any other port is a legacy resolver. */
    member(address: string, port = MDNS_PORT): () => Promise<MdnsTransport> {
      return async () => {
        const listeners: ((packet: Buffer, from: MdnsRemote) => void)[] = [];
        const self: Member = {
          address,
          port,
          deliver: (packet, from) => {
            for (const listener of listeners) listener(packet, from);
          },
        };
        members.add(self);
        return {
          send(payload, to) {
            // The bus has one "interface" per member: its own address.
            const packet = typeof payload === 'function' ? payload(to ? null : address) : payload;
            sent.push({ from: address, to: to ?? 'multicast', packet });
            for (const member of [...members]) {
              const reached = to
                ? member.address === to.address && member.port === to.port
                : member.port === MDNS_PORT; // multicast loopback includes the sender, as on a real socket
              if (reached) member.deliver(packet, { address, port });
            }
          },
          onMessage(listener) {
            listeners.push(listener);
          },
          async close() {
            members.delete(self);
          },
        };
      };
    },
  };
}

/** Runs scheduled work immediately; the tests drive re-queries by hand. */
const immediate = (fn: () => void): { cancel: () => void } => {
  let cancelled = false;
  queueMicrotask(() => {
    if (!cancelled) fn();
  });
  return { cancel: () => (cancelled = true) };
};
/** Never runs — for a component whose schedule the test wants to own. */
const never = (): { cancel: () => void } => ({ cancel: () => undefined });
/**
 * The startup burst only. The browser's steady re-query reschedules itself,
 * so running *that* immediately is an endless microtask loop.
 */
const startupOnly = (fn: () => void, ms: number): { cancel: () => void } =>
  ms < 10_000 ? immediate(fn) : never();

function advertiser(bus: ReturnType<typeof createBus>, overrides: { name?: string; port?: number; address?: string } = {}) {
  const address = overrides.address ?? '10.0.0.5';
  return new MdnsAdvertiser({
    name: overrides.name ?? 'stone-dev01',
    port: overrides.port ?? 8787,
    txt: { txtvers: '1', role: 'server', version: '1.2.3', proto: '14-14', scheme: 'http' },
    transport: bus.member(address),
    addresses: () => [
      { interfaceName: 'eth0', address },
      { interfaceName: 'docker0', address: '172.17.0.1' },
    ],
    schedule: immediate,
  });
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('mDNS advertiser and browser', () => {
  it('hears an announcement with no query at all', async () => {
    const bus = createBus();
    const browser = new MdnsBrowser({ transport: bus.member('10.0.0.9'), schedule: never });
    await browser.start();
    const ad = advertiser(bus);
    await ad.start();
    await flush();

    const [service, ...rest] = browser.services();
    expect(rest).toEqual([]);
    expect(service).toMatchObject({
      instance: 'stone-dev01 (8787)._pocketagent._tcp.local',
      name: 'stone-dev01 (8787)',
      target: 'pocketagent-stone-dev01-8787.local',
      port: 8787,
      // Only the address the copy left from: a LAN peer must not be told to
      // dial the Docker bridge (found against real avahi — see `MdnsPayload`).
      addresses: ['10.0.0.5'],
      sourceAddresses: ['10.0.0.5'],
      txt: { txtvers: '1', role: 'server', version: '1.2.3', proto: '14-14', scheme: 'http' },
    });
    await Promise.all([ad.stop(), browser.stop()]);
  });

  it('finds a backend that was already running, by querying', async () => {
    const bus = createBus();
    const ad = advertiser(bus);
    await ad.start();
    await flush();
    // The browser joins after every announcement has gone out.
    const browser = new MdnsBrowser({ transport: bus.member('10.0.0.9'), schedule: startupOnly });
    await browser.start();
    await flush();
    expect(browser.services().map((s) => s.port)).toEqual([8787]);
    await Promise.all([ad.stop(), browser.stop()]);
  });

  it('removes a backend the moment it says goodbye', async () => {
    const bus = createBus();
    const browser = new MdnsBrowser({ transport: bus.member('10.0.0.9'), schedule: never });
    await browser.start();
    const ad = advertiser(bus);
    await ad.start();
    await flush();
    expect(browser.services()).toHaveLength(1);

    await ad.stop();
    expect(browser.services()).toEqual([]);
    await browser.stop();
  });

  it('forgets a backend whose records expire without a goodbye', async () => {
    const bus = createBus();
    let now = 1_000_000;
    const browser = new MdnsBrowser({ transport: bus.member('10.0.0.9'), schedule: never, now: () => now });
    await browser.start();
    const ad = advertiser(bus);
    await ad.start();
    await flush();
    expect(browser.services()).toHaveLength(1);

    // SRV is published at 120 s; a crashed backend sends no goodbye.
    now += 121_000;
    expect(browser.services()).toEqual([]);
    await Promise.all([ad.stop(), browser.stop()]);
  });

  it('keeps two backends on one machine apart by port', async () => {
    const bus = createBus();
    const browser = new MdnsBrowser({ transport: bus.member('10.0.0.9'), schedule: never });
    await browser.start();
    const a = advertiser(bus, { port: 8787 });
    const b = advertiser(bus, { port: 8790 });
    await Promise.all([a.start(), b.start()]);
    await flush();
    expect(browser.services().map((s) => s.name).sort()).toEqual(['stone-dev01 (8787)', 'stone-dev01 (8790)']);
    await Promise.all([a.stop(), b.stop(), browser.stop()]);
  });

  it('answers a legacy unicast resolver directly, echoing its id and question', async () => {
    const bus = createBus();
    const ad = advertiser(bus);
    await ad.start();
    await flush();

    const replies: Buffer[] = [];
    const dig = await bus.member('10.0.0.20', 40000)();
    dig.onMessage((packet) => replies.push(packet));
    dig.send(
      encodePacket({
        id: 4242,
        response: false,
        questions: [{ name: '_pocketagent._tcp.local', type: RR_TYPE.PTR }],
        answers: [],
        additionals: [],
      }),
    );
    // A port-5353 query goes to the group; this one goes out multicast from a
    // non-5353 port, so only the advertiser (a group member) hears it and
    // answers straight back.
    expect(replies).toHaveLength(1);
    const reply = decodePacket(replies[0]!);
    expect(reply.id).toBe(4242);
    expect(reply.questions).toEqual([{ name: '_pocketagent._tcp.local', type: RR_TYPE.PTR, unicastResponse: false }]);
    expect(reply.answers[0]).toMatchObject({ type: 'PTR', data: 'stone-dev01 (8787)._pocketagent._tcp.local' });
    // A unicast reply has no single outgoing interface, so it lists every
    // address — physical first, the bridge last.
    expect(reply.additionals.filter((r) => r.type === 'A').map((r) => (r.type === 'A' ? r.data : ''))).toEqual([
      '10.0.0.5',
      '172.17.0.1',
    ]);
    await Promise.all([ad.stop(), dig.close()]);
  });

  it('ignores queries for other services, and garbage', async () => {
    const bus = createBus();
    const ad = advertiser(bus);
    await ad.start();
    await flush();
    const before = bus.sent.length;
    const probe = await bus.member('10.0.0.30')();
    probe.send(
      encodePacket({
        id: 0,
        response: false,
        questions: [{ name: '_http._tcp.local', type: RR_TYPE.PTR }],
        answers: [],
        additionals: [],
      }),
    );
    probe.send(Buffer.from([1, 2, 3]));
    // Only the probe's own two sends — the advertiser said nothing.
    expect(bus.sent.length - before).toBe(2);
    await Promise.all([ad.stop(), probe.close()]);
  });

  it('never advertises more than the TXT it was given', async () => {
    const bus = createBus();
    const ad = advertiser(bus);
    await ad.start();
    await flush();
    const txt = bus.sent
      .map(({ packet }) => decodePacket(packet))
      .flatMap((packet) => [...packet.answers, ...packet.additionals])
      .filter((record) => record.type === 'TXT');
    expect(txt.length).toBeGreaterThan(0);
    for (const record of txt) {
      expect(record).toMatchObject({
        data: ['txtvers=1', 'role=server', 'version=1.2.3', 'proto=14-14', 'scheme=http'],
      });
    }
    await ad.stop();
  });
});

describe('GET /api/hub/discovery', () => {
  let hub: TestHub | null = null;
  afterEach(async () => {
    await hub?.cleanup();
    hub = null;
  });

  async function read(path = '/api/hub/discovery', init?: RequestInit): Promise<HubDiscoveryResponse> {
    const response = await fetch(`${hub!.baseUrl}${path}`, {
      ...init,
      headers: { cookie: hub!.cookie, ...(init?.headers ?? {}) },
    });
    expect(response.status).toBe(200);
    return HubDiscoveryResponse.parse(await response.json());
  }

  it('says discovery is off when the operator turned it off', async () => {
    hub = await createTestHub();
    const body = await read();
    expect(body.state).toBe('disabled');
    expect(body.message).toMatch(/POCKETAGENT_HUB_MDNS=false/);
    expect(body.hosts).toEqual([]);
  });

  it('reports a socket it could not open as a state, and keeps serving', async () => {
    hub = await createTestHub({
      config: { mdnsDiscovery: true },
      mdnsTransport: async () => {
        throw new Error('bind EADDRINUSE 0.0.0.0:5353');
      },
    });
    const body = await read();
    expect(body.state).toBe('failed');
    expect(body.message).toMatch(/EADDRINUSE/);
    expect(body.message).toMatch(/added by address/);
  });

  it('requires a Hub session', async () => {
    hub = await createTestHub();
    const response = await fetch(`${hub.baseUrl}/api/hub/discovery`);
    expect(response.status).toBe(401);
  });

  it('lists an advertising backend, then marks it added once it is registered', async () => {
    const bus = createBus();
    hub = await createTestHub({
      config: { mdnsDiscovery: true },
      mdnsTransport: bus.member('10.0.0.9'),
      discoveryRefreshWaitMs: 10,
    });
    const ad = advertiser(bus);
    await ad.start();

    await vi.waitFor(async () => expect((await read()).hosts).toHaveLength(1));
    const [found] = (await read()).hosts;
    expect(found).toMatchObject({
      name: 'stone-dev01 (8787)',
      hostname: 'stone-dev01',
      port: 8787,
      baseUrl: 'http://10.0.0.5:8787',
      version: '1.2.3',
      protocol: { min: 14, max: 14 },
      registeredHostId: null,
    });

    // Registered by *hostname*, not by the address it advertised — still the same machine.
    const created = await fetch(`${hub.baseUrl}/api/hub/hosts`, {
      method: 'POST',
      headers: { cookie: hub.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'dev01', label: 'Dev 01', baseUrl: 'http://stone-dev01.local:8787' }),
    });
    expect(created.status).toBe(200);
    expect((await read()).hosts[0]?.registeredHostId).toBe('dev01');

    // A refresh is a POST (Origin-checked) and answers with the fresh list.
    const refreshed = await read('/api/hub/discovery/refresh', { method: 'POST' });
    expect(refreshed.state).toBe('listening');
    expect(refreshed.hosts).toHaveLength(1);

    await ad.stop();
    expect((await read()).hosts).toEqual([]);
  });

  it('does not match a registered host on a different port', async () => {
    const bus = createBus();
    hub = await createTestHub({ config: { mdnsDiscovery: true }, mdnsTransport: bus.member('10.0.0.9') });
    await fetch(`${hub.baseUrl}/api/hub/hosts`, {
      method: 'POST',
      headers: { cookie: hub.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'other', label: 'Other', baseUrl: 'http://10.0.0.5:9999' }),
    });
    const ad = advertiser(bus);
    await ad.start();
    await vi.waitFor(async () => expect((await read()).hosts).toHaveLength(1));
    expect((await read()).hosts[0]?.registeredHostId).toBeNull();
    await ad.stop();
  });
});

describe('choosing the address to dial', () => {
  // The address set a real avahi-publish advertised on stone-dev01, verbatim.
  const avahi = {
    addresses: [
      '::1',
      '127.0.0.1',
      '2601:600:827f:d663::1:61',
      '10.100.1.61',
      'fe80::a8d8:ceff:fee2:a7c6',
      '172.17.0.1',
      '172.22.0.1',
    ],
    sourceAddresses: ['10.100.1.61', '172.17.0.1', '172.22.0.1', '127.0.0.1'],
  };

  it('prefers a LAN IPv4 a packet came from over loopback', () => {
    expect(preferredAddress(avahi)).toBe('10.100.1.61');
  });

  it('never offers a link-local IPv6 address, which no URL can carry', () => {
    expect(usableAddresses(avahi.addresses)).toEqual([
      '10.100.1.61',
      '172.17.0.1',
      '172.22.0.1',
      '2601:600:827f:d663::1:61',
      '::1',
      '127.0.0.1',
    ]);
  });

  it('falls back to the packet source when nothing advertised is usable', () => {
    expect(preferredAddress({ addresses: ['fe80::1'], sourceAddresses: ['192.168.1.4'] })).toBe('192.168.1.4');
  });
});
