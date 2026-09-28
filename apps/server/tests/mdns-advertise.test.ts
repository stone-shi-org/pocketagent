import { describe, expect, it } from 'vitest';
import { MDNS_TXT_KEYS, SERVER_PROTOCOL_RANGE, parseProtocolTxt } from '@pocketagent/protocol';
import {
  advertisedAddresses,
  advertisedName,
  advertisedTxt,
  mdnsAdvertiseProblem,
} from '../src/discovery/mdns.js';
import { makeConfig } from './helpers.js';

/**
 * PA-110: what a backend puts on the LAN when it advertises itself.
 *
 * The advertiser itself — packets, goodbyes, legacy unicast — is covered
 * against a Hub's browser in `apps/hub/tests/mdns-discovery.test.ts`; this
 * file is the backend's own half of the decision: whether to advertise at all,
 * and what may be said.
 */
describe('mDNS advertisement', () => {
  it('carries exactly /health’s budget and nothing more', () => {
    const txt = advertisedTxt('1.2.3');
    // A new key here is a new disclosure to every machine on the LAN, and has
    // to be a decision someone makes on purpose — the same rule
    // `health.test.ts` enforces for `/health`'s four keys.
    expect(Object.keys(txt).sort()).toEqual(Object.values(MDNS_TXT_KEYS).sort());
    expect(txt[MDNS_TXT_KEYS.version]).toBe('1.2.3');
    expect(parseProtocolTxt(txt[MDNS_TXT_KEYS.protocol])).toEqual(SERVER_PROTOCOL_RANGE);
  });

  it('is off by default', () => {
    expect(makeConfig().mdnsAdvertise).toBe(false);
  });

  it('refuses to advertise a loopback bind, which nothing else could reach', () => {
    expect(mdnsAdvertiseProblem({ mdnsAdvertise: true, isNetworkExposed: false, host: '127.0.0.1' })).toMatch(
      /Not advertising/,
    );
    expect(mdnsAdvertiseProblem({ mdnsAdvertise: true, isNetworkExposed: true, host: '0.0.0.0' })).toBeNull();
    expect(mdnsAdvertiseProblem({ mdnsAdvertise: false, isNetworkExposed: false, host: '127.0.0.1' })).toBeNull();
  });

  it('advertises only the address a specific bind is reachable on', () => {
    const all = [
      { interfaceName: 'enp1s0', address: '10.100.1.61' },
      { interfaceName: 'docker0', address: '172.17.0.1' },
    ];
    expect(advertisedAddresses('0.0.0.0', all)).toEqual(all);
    expect(advertisedAddresses('10.100.1.61', all)).toEqual([all[0]]);
    // A literal address that is on no interface is advertised nowhere rather
    // than everywhere: every address listed would refuse the connection.
    expect(advertisedAddresses('10.9.9.9', all)).toEqual([]);
    expect(advertisedAddresses('stone-dev01', all)).toEqual(all);
  });

  it('names the instance after the short hostname', () => {
    expect(advertisedName('stone-dev01.lan.example')).toBe('stone-dev01');
    expect(advertisedName('')).toBe('pocketagent');
  });
});
