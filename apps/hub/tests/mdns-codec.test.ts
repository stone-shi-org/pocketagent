import { describe, expect, it } from 'vitest';
import {
  DnsDecodeError,
  RR_TYPE,
  decodePacket,
  decodeTxt,
  encodePacket,
  encodeTxt,
  type DnsPacket,
} from '@pocketagent/node-kit';

/**
 * PA-110: the DNS-SD codec in `packages/node-kit/src/mdns.ts`.
 *
 * Lives in the hub project because node-kit has no test project of its own,
 * and the Hub is the side that decodes whatever the LAN sends — every
 * malformed-packet case below is something a stranger's machine can put on
 * the wire.
 */
describe('mDNS codec', () => {
  it('round-trips a DNS-SD response with every record type', () => {
    const packet: DnsPacket = {
      id: 0,
      response: true,
      questions: [],
      answers: [
        {
          type: 'PTR',
          name: '_pocketagent._tcp.local',
          ttl: 4500,
          data: 'stone-dev01 (8787)._pocketagent._tcp.local',
        },
      ],
      additionals: [
        {
          type: 'SRV',
          name: 'stone-dev01 (8787)._pocketagent._tcp.local',
          ttl: 120,
          flush: true,
          data: { priority: 0, weight: 0, port: 8787, target: 'pocketagent-stone-dev01-8787.local' },
        },
        {
          type: 'TXT',
          name: 'stone-dev01 (8787)._pocketagent._tcp.local',
          ttl: 4500,
          flush: true,
          data: ['txtvers=1', 'version=1.2.3', 'proto=14-14'],
        },
        { type: 'A', name: 'pocketagent-stone-dev01-8787.local', ttl: 120, flush: true, data: '10.100.1.61' },
        {
          type: 'AAAA',
          name: 'pocketagent-stone-dev01-8787.local',
          ttl: 120,
          flush: true,
          data: 'fe80::1:2:3:4',
        },
      ],
    };
    const decoded = decodePacket(encodePacket(packet));
    expect(decoded.response).toBe(true);
    expect(decoded.answers).toEqual(packet.answers.map((r) => ({ ...r, flush: false })));
    expect(decoded.additionals).toEqual(packet.additionals);
  });

  it('writes IPv6 addresses in their compressed form (RFC 5952)', () => {
    for (const [written, read] of [
      ['0:0:0:0:0:0:0:1', '::1'],
      ['2601:600:827f:d663:0:0:1:61', '2601:600:827f:d663::1:61'],
      ['1:0:0:2:0:0:0:3', '1:0:0:2::3'],
      ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8'],
      ['1:0:2:3:4:5:6:7', '1:0:2:3:4:5:6:7'],
    ] as const) {
      const packet = decodePacket(
        encodePacket({
          id: 0,
          response: true,
          questions: [],
          answers: [{ type: 'AAAA', name: 'x.local', ttl: 1, data: written }],
          additionals: [],
        }),
      );
      expect(packet.answers[0]).toMatchObject({ type: 'AAAA', data: read });
    }
  });

  it('round-trips a query, keeping the QU bit', () => {
    const decoded = decodePacket(
      encodePacket({
        id: 7,
        response: false,
        questions: [{ name: '_pocketagent._tcp.local', type: RR_TYPE.PTR, unicastResponse: true }],
        answers: [],
        additionals: [],
      }),
    );
    expect(decoded.id).toBe(7);
    expect(decoded.response).toBe(false);
    expect(decoded.questions).toEqual([
      { name: '_pocketagent._tcp.local', type: RR_TYPE.PTR, unicastResponse: true },
    ]);
  });

  it('follows name compression pointers, which every real responder uses', () => {
    // A hand-built avahi-shaped answer: the PTR's rdata points back at the
    // question name for its `_pocketagent._tcp.local` suffix.
    const header = Buffer.from([0, 0, 0x84, 0, 0, 1, 0, 1, 0, 0, 0, 0]);
    const qname = Buffer.from([
      12, ...Buffer.from('_pocketagent'), 4, ...Buffer.from('_tcp'), 5, ...Buffer.from('local'), 0,
    ]);
    const question = Buffer.concat([qname, Buffer.from([0, 12, 0, 1])]);
    const rdata = Buffer.from([4, ...Buffer.from('box1'), 0xc0, 12]);
    const answer = Buffer.concat([
      Buffer.from([0xc0, 12]), // name → offset 12, the question name
      Buffer.from([0, 12, 0, 1, 0, 0, 0x11, 0x94, 0, rdata.length]),
      rdata,
    ]);
    const decoded = decodePacket(Buffer.concat([header, question, answer]));
    expect(decoded.answers).toEqual([
      {
        type: 'PTR',
        name: '_pocketagent._tcp.local',
        ttl: 4500,
        flush: false,
        data: 'box1._pocketagent._tcp.local',
      },
    ]);
  });

  it('refuses a compression loop instead of spinning on it', () => {
    const header = Buffer.from([0, 0, 0x84, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    // A question name that is a pointer to itself.
    const loop = Buffer.concat([header, Buffer.from([0xc0, 12, 0, 12, 0, 1])]);
    expect(() => decodePacket(loop)).toThrow(DnsDecodeError);
  });

  it('refuses truncated packets and overrunning records', () => {
    const good = encodePacket({
      id: 0,
      response: true,
      questions: [],
      answers: [{ type: 'A', name: 'x.local', ttl: 120, data: '10.0.0.1' }],
      additionals: [],
    });
    for (let cut = 1; cut < good.length; cut += 1) {
      expect(() => decodePacket(good.subarray(0, cut))).toThrow(DnsDecodeError);
    }
  });

  it('skips record types it does not know, without losing the ones after them', () => {
    const packet = encodePacket({
      id: 0,
      response: true,
      questions: [],
      answers: [{ type: 'A', name: 'x.local', ttl: 120, data: '10.0.0.1' }],
      additionals: [],
    });
    // Rewrite the A record's type to NSEC (47); its 4 rdata bytes are skipped.
    const typeOffset = 12 + Buffer.from([1, 120, 5, 108, 111, 99, 97, 108, 0]).length;
    packet.writeUInt16BE(RR_TYPE.NSEC, typeOffset);
    const decoded = decodePacket(packet);
    expect(decoded.answers).toEqual([
      { type: 'OTHER', name: 'x.local', ttl: 120, flush: false, rrType: RR_TYPE.NSEC },
    ]);
  });

  it('writes an empty TXT record as one zero byte (RFC 6763 §6.1)', () => {
    const packet = encodePacket({
      id: 0,
      response: true,
      questions: [],
      answers: [{ type: 'TXT', name: 'x.local', ttl: 1, data: [] }],
      additionals: [],
    });
    expect(packet.subarray(packet.length - 3)).toEqual(Buffer.from([0, 1, 0]));
    expect(decodePacket(packet).answers[0]).toMatchObject({ type: 'TXT', data: [] });
  });

  it('refuses a label over 63 bytes rather than emitting a corrupt name', () => {
    expect(() =>
      encodePacket({
        id: 0,
        response: true,
        questions: [],
        answers: [{ type: 'A', name: `${'a'.repeat(64)}.local`, ttl: 1, data: '10.0.0.1' }],
        additionals: [],
      }),
    ).toThrow(RangeError);
  });

  it('reads TXT key/values case-insensitively, first occurrence winning', () => {
    expect(encodeTxt({ version: '1.2.3', proto: '14-14' })).toEqual(['version=1.2.3', 'proto=14-14']);
    expect(decodeTxt(['Version=1.2.3', 'version=9.9.9', 'flag', 'empty=', '=x'])).toEqual({
      version: '1.2.3',
      flag: '',
      empty: '',
    });
  });
});
