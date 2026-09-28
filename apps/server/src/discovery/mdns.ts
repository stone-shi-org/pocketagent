import os from 'node:os';
import type { FastifyBaseLogger } from 'fastify';
import {
  MdnsAdvertiser,
  localIpv4Addresses,
  openMdnsSocket,
  type MdnsInterfaceAddress,
  type MdnsTransport,
} from '@pocketagent/node-kit';
import { MDNS_TXT_KEYS, SERVER_PROTOCOL_RANGE, formatProtocolTxt } from '@pocketagent/protocol';
import type { Config } from '../config/index.js';

/**
 * Advertising this backend on the LAN over mDNS, so a Hub can offer it as a
 * one-click "Add" (PA-110).
 *
 * **Off by default, and refused on a loopback bind**, because an
 * advertisement is the opposite of this server's default posture: the bind is
 * `127.0.0.1` so that exposing terminal access is a deliberate act, and
 * announcing "a PocketAgent is here" to every machine on the network is a
 * second, independent disclosure that must be just as deliberate. It grants
 * nothing — a Hub still needs this server's master token to bind it — but it
 * does tell anyone listening which machines to try.
 *
 * Started from `server.ts` rather than `buildApp`, for the same reason the
 * restart hook is: every test builds an app, and a test must never put a
 * packet on whatever LAN the runner is on.
 */

/**
 * The TXT record, and the whole of what is advertised beyond the port.
 *
 * Its budget is `/health`'s — a version and a protocol range, both already
 * public to anyone who can reach the port — and never more, because an
 * advertisement reaches every machine on the LAN whether or not it can
 * connect. `mdns-advertise.test.ts` asserts the exact key set, as
 * `health.test.ts` does for `/health`.
 */
export function advertisedTxt(version: string): Record<string, string> {
  return {
    [MDNS_TXT_KEYS.txtVersion]: '1',
    [MDNS_TXT_KEYS.role]: 'server',
    [MDNS_TXT_KEYS.version]: version,
    [MDNS_TXT_KEYS.protocol]: formatProtocolTxt(SERVER_PROTOCOL_RANGE),
    // This process never terminates TLS itself; an HTTPS deployment is a
    // reverse proxy in front of it, which is a different address anyway.
    [MDNS_TXT_KEYS.scheme]: 'http',
  };
}

/** Why an enabled advertisement will not run, or null when it will. */
export function mdnsAdvertiseProblem(config: Pick<Config, 'mdnsAdvertise' | 'isNetworkExposed' | 'host'>): string | null {
  if (!config.mdnsAdvertise) return null;
  if (!config.isNetworkExposed) {
    return (
      `POCKETAGENT_MDNS_ADVERTISE is on, but HOST is ${config.host}: nothing else on the network ` +
      'could reach this server, so advertising it would only put a dead row in every Hub. ' +
      'Not advertising.'
    );
  }
  return null;
}

/**
 * The addresses to advertise for a bind. A wildcard bind is reachable on
 * every interface; a specific one only on its own, and advertising the rest
 * would send a Hub to an address that refuses the connection.
 */
export function advertisedAddresses(
  host: string,
  all: readonly MdnsInterfaceAddress[],
): MdnsInterfaceAddress[] {
  if (host === '0.0.0.0' || host === '::' || host === '') return [...all];
  const bound = all.filter((entry) => entry.address === host);
  // A hostname bind (`HOST=stone-dev01`) cannot be matched to an interface
  // here; listing every address is the honest fallback.
  return bound.length > 0 || /^[\d.]+$/.test(host) ? bound : [...all];
}

/** The instance name: the machine's short hostname. The advertiser appends the port. */
export function advertisedName(hostname: string = os.hostname()): string {
  return hostname.split('.')[0] || 'pocketagent';
}

/**
 * Starts the advertiser when configured to. Never throws: a backend that
 * cannot advertise is a backend that works exactly as it did before, so a
 * failure here is a warning, not a boot error.
 */
export async function startMdnsAdvertiser(
  config: Pick<Config, 'mdnsAdvertise' | 'isNetworkExposed' | 'host' | 'port'>,
  version: string,
  log: FastifyBaseLogger,
  transport: () => Promise<MdnsTransport> = () => openMdnsSocket(),
): Promise<MdnsAdvertiser | null> {
  if (!config.mdnsAdvertise) return null;
  const problem = mdnsAdvertiseProblem(config);
  if (problem !== null) {
    log.warn(problem);
    return null;
  }
  const advertiser = new MdnsAdvertiser({
    name: advertisedName(),
    port: config.port,
    txt: advertisedTxt(version),
    transport,
    addresses: () => advertisedAddresses(config.host, localIpv4Addresses()),
    log: {
      info: (obj, msg) => log.info(obj, msg),
      debug: (obj, msg) => log.debug(obj, msg),
    },
  });
  try {
    await advertiser.start();
    return advertiser;
  } catch (error) {
    log.warn(
      { reason: error instanceof Error ? error.message : String(error) },
      'could not advertise on mDNS (UDP 5353); Hubs can still add this server by address',
    );
    return null;
  }
}
