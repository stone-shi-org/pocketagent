import type { FastifyBaseLogger } from 'fastify';
import {
  MdnsBrowser,
  openMdnsSocket,
  type DiscoveredService,
  type MdnsTransport,
} from '@pocketagent/node-kit';
import {
  MDNS_TXT_KEYS,
  parseProtocolTxt,
  type DiscoveredHubHost,
  type HubDiscoveryResponse,
  type HubDiscoveryState,
  type HubHostEntry,
} from '@pocketagent/protocol';

export interface DiscoveryServiceOptions {
  readonly enabled: boolean;
  /** The registry's current rows, for "this one is already added". Read fresh per call. */
  readonly registeredHosts: () => readonly HubHostEntry[];
  /** Injected so tests run over an in-memory bus instead of real multicast. */
  readonly transport?: () => Promise<MdnsTransport>;
  readonly log?: FastifyBaseLogger;
  readonly now?: () => number;
}

const DISABLED_MESSAGE =
  'Network discovery is turned off on this Hub (POCKETAGENT_HUB_MDNS=false). Hosts can still be added by address.';

/**
 * The Hub's view of backends advertising themselves over mDNS (PA-110).
 *
 * Owns an `MdnsBrowser` and turns what it hears into rows the Hub page can
 * offer as one-click "Add". Two properties carry the design:
 *
 * - **A failure here is never the Hub's failure.** Port 5353 can be
 *   unavailable (a container without host networking, a locked-down box), and
 *   the Hub is fully usable without discovery — so `start()` records `failed`
 *   and a sentence rather than throwing, and the page says so instead of
 *   showing an empty list that reads as "no backends exist".
 * - **Nothing here reaches the registry.** Rows are computed on read and
 *   never stored; adding one is the same `POST /api/hub/hosts` a typed
 *   address goes through, with the same URL validation, and binding still
 *   needs that backend's master token. An advertisement is unauthenticated by
 *   nature, so the worst a spoofed one can do is put a wrong suggestion in
 *   front of a human.
 */
export class DiscoveryService {
  private state: HubDiscoveryState;
  private message: string | null;
  private readonly browser: MdnsBrowser | null;

  constructor(private readonly options: DiscoveryServiceOptions) {
    this.state = options.enabled ? 'starting' : 'disabled';
    this.message = options.enabled ? null : DISABLED_MESSAGE;
    this.browser = options.enabled
      ? new MdnsBrowser({
          transport: options.transport ?? (() => openMdnsSocket()),
          ...(options.now ? { now: options.now } : {}),
        })
      : null;
  }

  async start(): Promise<void> {
    if (!this.browser) return;
    try {
      await this.browser.start();
      this.state = 'listening';
      this.message = null;
      this.options.log?.info('listening for PocketAgent backends on mDNS');
    } catch (error) {
      this.state = 'failed';
      const reason = error instanceof Error ? error.message : String(error);
      this.message =
        `Could not listen for mDNS on UDP 5353 (${reason}). A Hub in a container needs host ` +
        'networking for this; hosts can still be added by address.';
      // `warn`, not `error`: the Hub is working, it just cannot hear
      // advertisements, and a deployment that never wanted discovery should
      // not page anyone for it.
      this.options.log?.warn({ reason }, 'mDNS discovery unavailable');
    }
  }

  async stop(): Promise<void> {
    await this.browser?.stop();
  }

  /** Sends a fresh query. Answers arrive asynchronously, within a second or so on a LAN. */
  refresh(): void {
    if (this.state === 'listening') this.browser?.query();
  }

  snapshot(): HubDiscoveryResponse {
    const services = this.state === 'listening' ? (this.browser?.services() ?? []) : [];
    const registered = this.options.registeredHosts();
    return {
      state: this.state,
      message: this.message,
      hosts: services
        .filter((service) => {
          // An absent role is a pre-`role` advertiser and still a backend; a
          // *different* role is something this list is not for.
          const role = service.txt[MDNS_TXT_KEYS.role];
          return role === undefined || role === 'server';
        })
        .map((service) => toDiscoveredHost(service, registered)),
    };
  }
}

/** `stone-dev01 (8787)` → `stone-dev01`: the advertiser appends the port for uniqueness. */
function hostnameOf(service: DiscoveredService): string {
  return service.name.replace(/\s*\(\d+\)$/, '');
}

/**
 * How good an address is to put in a base URL, lower first; `null` for
 * unusable.
 *
 * Real responders advertise more than the one address a peer should dial —
 * avahi publishes `127.0.0.1`, `::1` and every link-local address beside the
 * LAN one (seen against a real avahi-publish, which is how this ranking was
 * arrived at). A link-local IPv6 address needs a zone id no URL can carry, so
 * it is not offered at all; loopback only works for a Hub on the same
 * machine, so it is the last resort rather than excluded.
 */
function addressRank(address: string): number | null {
  const lower = address.toLowerCase();
  if (lower.includes(':')) {
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      return null;
    }
    return lower === '::1' ? 3 : 1;
  }
  if (lower.startsWith('127.')) return 3;
  if (lower.startsWith('169.254.')) return 2;
  return 0;
}

/** The advertised addresses worth showing, best first; order is otherwise the advertiser's. */
export function usableAddresses(addresses: readonly string[]): string[] {
  return addresses
    .map((address, index) => ({ address, index, rank: addressRank(address) }))
    .filter((entry): entry is { address: string; index: number; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.address);
}

/**
 * The address to dial: the best-ranked advertised address a packet actually
 * came from, when there is one — the advertiser lists physical interfaces
 * before container bridges, and a packet arriving from an address is evidence
 * of a route where an A record is only a claim. Falls back to the best
 * advertised address, then to a packet source.
 */
export function preferredAddress(service: Pick<DiscoveredService, 'addresses' | 'sourceAddresses'>): string | null {
  const advertised = usableAddresses(service.addresses);
  return (
    advertised.find((address) => service.sourceAddresses.includes(address)) ??
    advertised[0] ??
    usableAddresses(service.sourceAddresses)[0] ??
    null
  );
}

function urlHost(address: string): string {
  return address.includes(':') ? `[${address}]` : address;
}

function toDiscoveredHost(
  service: DiscoveredService,
  registered: readonly HubHostEntry[],
): DiscoveredHubHost {
  const scheme = service.txt[MDNS_TXT_KEYS.scheme] === 'https' ? 'https' : 'http';
  const hostname = hostnameOf(service);
  const address = preferredAddress(service) ?? service.target.replace(/\.$/, '');
  const version = service.txt[MDNS_TXT_KEYS.version]?.trim();
  return {
    instance: service.instance,
    name: service.name,
    hostname,
    port: service.port,
    addresses: usableAddresses(service.addresses),
    baseUrl: `${scheme}://${urlHost(address)}:${service.port}`,
    version: version ? version : null,
    protocol: parseProtocolTxt(service.txt[MDNS_TXT_KEYS.protocol]),
    registeredHostId: matchRegistered(service, hostname, scheme, registered),
    firstSeenAt: service.firstSeenAt,
    lastSeenAt: service.lastSeenAt,
  };
}

/**
 * Whether a registry row already points at this backend.
 *
 * Matched on *port plus any name the backend is known by* — an advertised
 * address, a packet source, its hostname with or without `.local`, or the SRV
 * target — because the operator may have typed any of those, and a row added
 * as `http://stone-dev01:8787` is the same machine as the advertisement from
 * `10.100.1.61`. The two failure directions are not equal: a false negative
 * offers "Add" for a machine that is already registered (a duplicate an
 * operator can see and remove), while a false positive hides a real backend
 * behind "Added" — so the match stays exact on port and scheme.
 */
function matchRegistered(
  service: DiscoveredService,
  hostname: string,
  scheme: 'http' | 'https',
  registered: readonly HubHostEntry[],
): string | null {
  const names = new Set(
    [
      ...service.addresses,
      ...service.sourceAddresses,
      hostname,
      `${hostname}.local`,
      service.target.replace(/\.$/, ''),
    ].map((name) => name.toLowerCase()),
  );
  for (const row of registered) {
    let url: URL;
    try {
      url = new URL(row.baseUrl);
    } catch {
      continue;
    }
    const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (port === service.port && names.has(host) && url.protocol === `${scheme}:`) return row.id;
  }
  return null;
}
