import dgram from 'node:dgram';
import os from 'node:os';

/**
 * Just enough multicast DNS / DNS-SD (RFC 6762, RFC 6763) for a backend to say
 * "I am here" and for a Hub to hear it (PA-110).
 *
 * ## Why it is here, and why it is hand-rolled
 *
 * Both halves live in this one module because they are one contract: the
 * service type, the TXT keys and the record TTLs have to agree between an
 * advertiser in `apps/server` and a browser in `apps/hub`, which is exactly the
 * "two implementations drifting" case `node-kit` exists for. Hand-rolled
 * rather than a dependency for the reason `cron-expr.ts` and
 * `telegram/format.ts` are: the subset needed is small and fully specified
 * (PTR/SRV/TXT/A/AAAA, one query, one response shape), a unit test can pin
 * every byte of it, and nothing here needs the parts of mDNS that are hard —
 * probing and conflict resolution, known-answer suppression, or a full
 * resolver cache.
 *
 * ## What this deliberately does not do
 *
 * - **Probing (RFC 6762 §8).** Instance names are made unique by construction
 *   (hostname *and* port), which is enough for a handful of backends on one
 *   LAN and is a stated limitation rather than a hidden one.
 * - **IPv6 transport.** Records may carry AAAA, but the socket is IPv4 only —
 *   every LAN this is aimed at has IPv4 multicast, and a second socket family
 *   doubles the interface bookkeeping for no reachable host.
 * - **Anything the Hub could act on.** Discovery produces *suggestions*; the
 *   only way a host becomes usable is an operator adding it and binding it
 *   with that backend's master token (PA-63). A spoofed advertisement can at
 *   worst put a wrong row in a list a human reads.
 */

export const MDNS_ADDRESS = '224.0.0.251';
export const MDNS_PORT = 5353;

/** The DNS-SD service type every PocketAgent backend advertises under. */
export const POCKETAGENT_SERVICE_TYPE = '_pocketagent._tcp.local';

/** The DNS-SD meta-query name, so `avahi-browse -a` and friends list us. */
const SERVICES_META_NAME = '_services._dns-sd._udp.local';

/**
 * TTLs the advertiser publishes, and that the browser's re-query cadence is
 * derived from. RFC 6762 §10's recommendations: 120 s for records naming a
 * host or its addresses, 75 minutes for the rest.
 */
export const HOST_RECORD_TTL_S = 120;
export const SERVICE_RECORD_TTL_S = 4500;

export const RR_TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, NSEC: 47, ANY: 255 } as const;
const CLASS_IN = 1;
/** Top bit of the class field: cache-flush on a record, unicast-response on a question. */
const CLASS_TOP_BIT = 0x8000;

export interface SrvData {
  readonly priority: number;
  readonly weight: number;
  readonly port: number;
  readonly target: string;
}

interface RecordBase {
  readonly name: string;
  readonly ttl: number;
  /** RFC 6762 §10.2: this record replaces, rather than adds to, cached ones. */
  readonly flush?: boolean;
}

export type DnsRecord =
  | (RecordBase & { readonly type: 'PTR'; readonly data: string })
  | (RecordBase & { readonly type: 'SRV'; readonly data: SrvData })
  | (RecordBase & { readonly type: 'TXT'; readonly data: readonly string[] })
  | (RecordBase & { readonly type: 'A'; readonly data: string })
  | (RecordBase & { readonly type: 'AAAA'; readonly data: string })
  /** Anything else is kept only so a decode can skip it; never encoded. */
  | (RecordBase & { readonly type: 'OTHER'; readonly rrType: number });

export interface DnsQuestion {
  readonly name: string;
  /** A numeric RR type, e.g. `RR_TYPE.PTR`. */
  readonly type: number;
  /** The QU bit (RFC 6762 §5.4): the asker would like a unicast reply. */
  readonly unicastResponse?: boolean;
}

export interface DnsPacket {
  readonly id: number;
  readonly response: boolean;
  readonly questions: readonly DnsQuestion[];
  readonly answers: readonly DnsRecord[];
  /** Authority records are decoded (so their bytes are skipped) but never produced. */
  readonly authorities?: readonly DnsRecord[];
  readonly additionals: readonly DnsRecord[];
}

/** Thrown for a packet this codec cannot read. Callers drop the packet. */
export class DnsDecodeError extends Error {
  override readonly name = 'DnsDecodeError';
}

/** DNS names compare case-insensitively (RFC 1035 §2.3.3); every map key goes through this. */
export function dnsKey(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

// ---------------------------------------------------------------------------
// Encoding

function encodeName(name: string): Buffer {
  const trimmed = name.replace(/\.$/, '');
  const parts: Buffer[] = [];
  let total = 1;
  if (trimmed !== '') {
    for (const label of trimmed.split('.')) {
      const bytes = Buffer.from(label, 'utf8');
      if (bytes.length === 0) throw new RangeError(`Empty label in DNS name ${JSON.stringify(name)}`);
      if (bytes.length > 63) throw new RangeError(`DNS label over 63 bytes in ${JSON.stringify(name)}`);
      parts.push(Buffer.from([bytes.length]), bytes);
      total += bytes.length + 1;
    }
  }
  if (total > 255) throw new RangeError(`DNS name over 255 bytes: ${JSON.stringify(name)}`);
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value, 0);
  return buffer;
}

function encodeRdata(record: DnsRecord): { type: number; rdata: Buffer } {
  switch (record.type) {
    case 'PTR':
      return { type: RR_TYPE.PTR, rdata: encodeName(record.data) };
    case 'SRV':
      return {
        type: RR_TYPE.SRV,
        rdata: Buffer.concat([
          u16(record.data.priority),
          u16(record.data.weight),
          u16(record.data.port),
          encodeName(record.data.target),
        ]),
      };
    case 'TXT': {
      // RFC 6763 §6.1: a TXT record with no strings is one zero byte, never
      // an empty rdata.
      if (record.data.length === 0) return { type: RR_TYPE.TXT, rdata: Buffer.from([0]) };
      const parts: Buffer[] = [];
      for (const entry of record.data) {
        const bytes = Buffer.from(entry, 'utf8');
        if (bytes.length > 255) throw new RangeError('TXT string over 255 bytes');
        parts.push(Buffer.from([bytes.length]), bytes);
      }
      return { type: RR_TYPE.TXT, rdata: Buffer.concat(parts) };
    }
    case 'A': {
      const octets = record.data.split('.').map((part) => Number(part));
      if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
        throw new RangeError(`Not an IPv4 address: ${record.data}`);
      }
      return { type: RR_TYPE.A, rdata: Buffer.from(octets) };
    }
    case 'AAAA':
      return { type: RR_TYPE.AAAA, rdata: ipv6ToBytes(record.data) };
    case 'OTHER':
      throw new RangeError('An undecoded record cannot be re-encoded.');
  }
}

function encodeRecord(record: DnsRecord): Buffer {
  const { type, rdata } = encodeRdata(record);
  const header = Buffer.alloc(10);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(CLASS_IN | (record.flush ? CLASS_TOP_BIT : 0), 2);
  header.writeUInt32BE(record.ttl >>> 0, 4);
  header.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encodeName(record.name), header, rdata]);
}

function encodeQuestion(question: DnsQuestion): Buffer {
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(question.type, 0);
  tail.writeUInt16BE(CLASS_IN | (question.unicastResponse ? CLASS_TOP_BIT : 0), 2);
  return Buffer.concat([encodeName(question.name), tail]);
}

/**
 * Serialises a packet, without name compression.
 *
 * Compression is optional on the way out (every resolver must accept an
 * uncompressed name) and the packets here are a few hundred bytes, well under
 * the 1472-byte single-datagram budget RFC 6762 §17 asks for.
 */
export function encodePacket(packet: DnsPacket): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(packet.id, 0);
  // QR + AA for a response (RFC 6762 §18.2/§18.4); all zero for a query.
  header.writeUInt16BE(packet.response ? 0x8400 : 0, 2);
  header.writeUInt16BE(packet.questions.length, 4);
  header.writeUInt16BE(packet.answers.length, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(packet.additionals.length, 10);
  return Buffer.concat([
    header,
    ...packet.questions.map(encodeQuestion),
    ...packet.answers.map(encodeRecord),
    ...packet.additionals.map(encodeRecord),
  ]);
}

// ---------------------------------------------------------------------------
// Decoding

/** Bound on compression-pointer hops; a loop in a hostile packet must not hang the reader. */
const MAX_POINTER_HOPS = 32;

function need(buffer: Buffer, offset: number, length: number): void {
  if (offset < 0 || offset + length > buffer.length) {
    throw new DnsDecodeError('Truncated DNS packet.');
  }
}

function decodeName(buffer: Buffer, start: number): { name: string; next: number } {
  const labels: string[] = [];
  let offset = start;
  let next = -1;
  let hops = 0;
  let length = 0;
  for (;;) {
    need(buffer, offset, 1);
    const len = buffer[offset]!;
    if (len === 0) {
      if (next === -1) next = offset + 1;
      break;
    }
    const kind = len & 0xc0;
    if (kind === 0xc0) {
      need(buffer, offset, 2);
      if (++hops > MAX_POINTER_HOPS) throw new DnsDecodeError('DNS name compression loop.');
      if (next === -1) next = offset + 2;
      offset = ((len & 0x3f) << 8) | buffer[offset + 1]!;
      continue;
    }
    if (kind !== 0) throw new DnsDecodeError('Unsupported DNS label type.');
    need(buffer, offset + 1, len);
    labels.push(buffer.toString('utf8', offset + 1, offset + 1 + len));
    length += len + 1;
    if (length > 255) throw new DnsDecodeError('DNS name over 255 bytes.');
    offset += len + 1;
  }
  return { name: labels.join('.'), next };
}

function decodeRecord(buffer: Buffer, start: number): { record: DnsRecord; next: number } {
  const { name, next: afterName } = decodeName(buffer, start);
  need(buffer, afterName, 10);
  const type = buffer.readUInt16BE(afterName);
  const klass = buffer.readUInt16BE(afterName + 2);
  const ttl = buffer.readUInt32BE(afterName + 4);
  const rdlength = buffer.readUInt16BE(afterName + 8);
  const rdStart = afterName + 10;
  need(buffer, rdStart, rdlength);
  const next = rdStart + rdlength;
  const base = { name, ttl, flush: (klass & CLASS_TOP_BIT) !== 0 };

  switch (type) {
    case RR_TYPE.PTR:
      return { record: { ...base, type: 'PTR', data: decodeName(buffer, rdStart).name }, next };
    case RR_TYPE.SRV: {
      need(buffer, rdStart, 6);
      return {
        record: {
          ...base,
          type: 'SRV',
          data: {
            priority: buffer.readUInt16BE(rdStart),
            weight: buffer.readUInt16BE(rdStart + 2),
            port: buffer.readUInt16BE(rdStart + 4),
            target: decodeName(buffer, rdStart + 6).name,
          },
        },
        next,
      };
    }
    case RR_TYPE.TXT: {
      const strings: string[] = [];
      let offset = rdStart;
      while (offset < next) {
        const len = buffer[offset]!;
        if (offset + 1 + len > next) throw new DnsDecodeError('TXT string overruns its record.');
        if (len > 0) strings.push(buffer.toString('utf8', offset + 1, offset + 1 + len));
        offset += 1 + len;
      }
      return { record: { ...base, type: 'TXT', data: strings }, next };
    }
    case RR_TYPE.A:
      if (rdlength !== 4) throw new DnsDecodeError('A record is not 4 bytes.');
      return {
        record: { ...base, type: 'A', data: [...buffer.subarray(rdStart, next)].join('.') },
        next,
      };
    case RR_TYPE.AAAA:
      if (rdlength !== 16) throw new DnsDecodeError('AAAA record is not 16 bytes.');
      return { record: { ...base, type: 'AAAA', data: bytesToIpv6(buffer.subarray(rdStart, next)) }, next };
    default:
      return { record: { ...base, type: 'OTHER', rrType: type }, next };
  }
}

/** Parses one datagram. Throws `DnsDecodeError` on anything malformed. */
export function decodePacket(buffer: Buffer): DnsPacket {
  need(buffer, 0, 12);
  const id = buffer.readUInt16BE(0);
  const flags = buffer.readUInt16BE(2);
  const counts = [4, 6, 8, 10].map((at) => buffer.readUInt16BE(at)) as [number, number, number, number];
  let offset = 12;

  const questions: DnsQuestion[] = [];
  for (let i = 0; i < counts[0]; i += 1) {
    const { name, next } = decodeName(buffer, offset);
    need(buffer, next, 4);
    const klass = buffer.readUInt16BE(next + 2);
    questions.push({
      name,
      type: buffer.readUInt16BE(next),
      unicastResponse: (klass & CLASS_TOP_BIT) !== 0,
    });
    offset = next + 4;
  }

  const sections: DnsRecord[][] = [[], [], []];
  for (let section = 0; section < 3; section += 1) {
    for (let i = 0; i < counts[section + 1]!; i += 1) {
      const { record, next } = decodeRecord(buffer, offset);
      sections[section]!.push(record);
      offset = next;
    }
  }

  return {
    id,
    response: (flags & 0x8000) !== 0,
    questions,
    answers: sections[0]!,
    authorities: sections[1]!,
    additionals: sections[2]!,
  };
}

function ipv6ToBytes(address: string): Buffer {
  const [head = '', tail] = address.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) {
    throw new RangeError(`Not an IPv6 address: ${address}`);
  }
  const groups = [...headGroups, ...Array<string>(missing).fill('0'), ...tailGroups];
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => {
    const value = Number.parseInt(group, 16);
    if (!/^[0-9a-f]{1,4}$/i.test(group) || Number.isNaN(value)) {
      throw new RangeError(`Not an IPv6 address: ${address}`);
    }
    bytes.writeUInt16BE(value, index * 2);
  });
  return bytes;
}

/** RFC 5952 text form: lowercase, the longest run of two or more zero groups as `::`. */
function bytesToIpv6(bytes: Buffer): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== '0') {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === '0') j += 1;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  if (bestStart === -1) return groups.join(':');
  return `${groups.slice(0, bestStart).join(':')}::${groups.slice(bestStart + bestLength).join(':')}`;
}

// ---------------------------------------------------------------------------
// TXT key/value (RFC 6763 §6.3)

/** `key=value` strings, as DNS-SD writes them. Keys are compared case-insensitively. */
export function encodeTxt(values: Readonly<Record<string, string>>): string[] {
  return Object.entries(values).map(([key, value]) => `${key}=${value}`);
}

/** The inverse of `encodeTxt`. The first occurrence of a key wins, per RFC 6763 §6.4. */
export function decodeTxt(strings: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of strings) {
    const eq = entry.indexOf('=');
    const key = (eq === -1 ? entry : entry.slice(0, eq)).toLowerCase();
    if (key === '' || key in out) continue;
    out[key] = eq === -1 ? '' : entry.slice(eq + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Transport

export interface MdnsRemote {
  readonly address: string;
  readonly port: number;
}

/**
 * The socket, reduced to what the advertiser and browser need, so both can be
 * driven by an in-memory bus in a test. CI has no guaranteed multicast, and a
 * test that silently passed because nothing was ever delivered would be worse
 * than none.
 */
/**
 * A packet, or a builder for one given the local address it will leave from
 * (`null` when that is not known — a unicast reply, or a machine with no
 * usable interface). The builder form is what lets an advertiser put only the
 * outgoing interface's own address in each copy, as RFC 6762 §6.2 intends:
 * a LAN peer told "reach me at 172.22.0.1" is being handed a Docker bridge.
 */
export type MdnsPayload = Buffer | ((viaAddress: string | null) => Buffer);

export interface MdnsTransport {
  /** Sends to the multicast group on every interface, or unicast when `to` is given. */
  send(packet: MdnsPayload, to?: MdnsRemote): void;
  onMessage(listener: (packet: Buffer, from: MdnsRemote) => void): void;
  close(): Promise<void>;
}

export interface MdnsInterfaceAddress {
  readonly interfaceName: string;
  readonly address: string;
}

/**
 * Interface names whose addresses are listed last in an advertisement.
 *
 * Container and VM bridges live on the same machine as a real LAN interface,
 * and their addresses are unreachable from anywhere but that machine — so a
 * browser taking "the first address" should get the LAN one. Ordering rather
 * than omitting, because a Hub in a container on that very bridge *can* reach
 * the bridge address, and is the one case where it is the right answer.
 */
const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|vmnet|vboxnet|cni|flannel|cali|tailscale|zt|utun|tun|tap)/;

/** Non-internal IPv4 addresses of this machine, physical interfaces first. */
export function localIpv4Addresses(): MdnsInterfaceAddress[] {
  const out: MdnsInterfaceAddress[] = [];
  for (const [interfaceName, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push({ interfaceName, address: entry.address });
    }
  }
  const virtual = (entry: MdnsInterfaceAddress): number => (VIRTUAL_INTERFACE.test(entry.interfaceName) ? 1 : 0);
  return out.sort((a, b) => virtual(a) - virtual(b));
}

/**
 * Opens the real UDP socket: port 5353, shared.
 *
 * `reuseAddr` is not optional. On any machine running avahi or
 * mDNSResponder, port 5353 is already bound, and the multicast group is the
 * whole point — every member socket gets a copy. Without it the bind fails
 * with `EADDRINUSE` on exactly the machines most likely to have working mDNS.
 */
export async function openMdnsSocket(
  interfaces: () => readonly MdnsInterfaceAddress[] = localIpv4Addresses,
): Promise<MdnsTransport> {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    socket.once('error', onError);
    socket.bind(MDNS_PORT, () => {
      socket.off('error', onError);
      resolve();
    });
  });
  // A hub and a backend on the same machine must hear each other.
  socket.setMulticastLoopback(true);
  socket.setMulticastTTL(255);

  let joined = 0;
  for (const { address } of interfaces()) {
    try {
      socket.addMembership(MDNS_ADDRESS, address);
      joined += 1;
    } catch {
      // An interface without multicast (a point-to-point tunnel) refuses the
      // join; the others are still worth having.
    }
  }
  if (joined === 0) socket.addMembership(MDNS_ADDRESS);

  // After a successful bind, an 'error' is a send failure on one interface.
  // Swallowed rather than left unhandled: an uncaught 'error' on a dgram
  // socket kills the process, and one bad interface must not take the server
  // down with it.
  socket.on('error', () => undefined);

  /**
   * Sends are serialised, and that is load-bearing rather than tidy.
   * `dgram.send` is asynchronous — the syscall happens on a later tick — while
   * `setMulticastInterface` changes the socket *now*, so the obvious loop of
   * "set interface, send" for each interface sends every copy out of whichever
   * interface was set last. On the machine this was first run on that was a
   * Docker bridge, and nothing on the LAN heard a thing. Each copy therefore
   * waits for the previous one's callback before the interface moves, and
   * `close()` waits for the queue so a goodbye is not dropped on the floor.
   */
  let queue: Promise<void> = Promise.resolve();
  const sendOne = (packet: Buffer, port: number, address: string, viaInterface?: string): Promise<void> =>
    new Promise<void>((resolve) => {
      try {
        if (viaInterface !== undefined) socket.setMulticastInterface(viaInterface);
        socket.send(packet, port, address, () => resolve());
      } catch {
        // Same reasoning as the membership loop above: one interface that
        // refuses must not stop the rest.
        resolve();
      }
    });

  return {
    send(packet, to) {
      const build = (via: string | null): Buffer => (typeof packet === 'function' ? packet(via) : packet);
      queue = queue.then(async () => {
        if (to) {
          await sendOne(build(null), to.port, to.address);
          return;
        }
        const addresses = interfaces();
        if (addresses.length === 0) {
          await sendOne(build(null), MDNS_PORT, MDNS_ADDRESS);
          return;
        }
        for (const { address } of addresses) {
          await sendOne(build(address), MDNS_PORT, MDNS_ADDRESS, address);
        }
      });
    },
    onMessage(listener) {
      socket.on('message', (packet, rinfo) => listener(packet, { address: rinfo.address, port: rinfo.port }));
    },
    async close() {
      await queue;
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// Names

/**
 * A DNS label derived from free text: at most 63 bytes, no dots.
 *
 * Instance names are allowed spaces and punctuation (RFC 6763 §4.1.1), so only
 * the two things that break the encoding are removed.
 */
function instanceLabel(text: string): string {
  let label = text.replace(/\./g, '-').trim() || 'pocketagent';
  while (Buffer.byteLength(label, 'utf8') > 63) label = label.slice(0, -1);
  return label;
}

/** A hostname-safe slug, for the SRV target this advertiser owns. */
function hostSlug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'host'
  );
}

// ---------------------------------------------------------------------------
// Advertiser

export interface MdnsLogger {
  debug?: (obj: object, msg: string) => void;
  info?: (obj: object, msg: string) => void;
  warn?: (obj: object, msg: string) => void;
}

export interface MdnsAdvertiserOptions {
  /** Human-facing name, e.g. the machine's hostname. Suffixed with the port. */
  readonly name: string;
  readonly port: number;
  /** Published as `key=value` TXT strings — keep to what is already public. */
  readonly txt: Readonly<Record<string, string>>;
  readonly transport: () => Promise<MdnsTransport>;
  readonly addresses?: () => readonly MdnsInterfaceAddress[];
  readonly serviceType?: string;
  readonly log?: MdnsLogger;
  /** Injected so a test does not wait for the real announcement schedule. */
  readonly schedule?: (fn: () => void, ms: number) => { cancel: () => void };
}

/** RFC 6762 §8.3: announce at least twice, a second apart; a third catches a lossy link. */
const ANNOUNCE_DELAYS_MS = [0, 1000, 3000];

function defaultSchedule(fn: () => void, ms: number): { cancel: () => void } {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
}

/**
 * Publishes one DNS-SD service and answers queries for it.
 *
 * The records are the four DNS-SD needs — PTR (type → instance), SRV
 * (instance → host and port), TXT (instance → metadata) and A (host →
 * addresses) — plus the `_services._dns-sd._udp` meta PTR so general-purpose
 * browsers list the type. The SRV target is a name *this* advertiser owns
 * (`<slug>-<port>.pocketagent.local` style) rather than the machine's own
 * `<hostname>.local`: avahi publishes that name already, and a second
 * publisher of it with a different address set is a conflict avahi resolves
 * by renaming the machine.
 */
export class MdnsAdvertiser {
  readonly instanceName: string;
  readonly targetName: string;
  private readonly serviceType: string;
  private transport: MdnsTransport | null = null;
  private readonly timers: { cancel: () => void }[] = [];
  private readonly schedule: NonNullable<MdnsAdvertiserOptions['schedule']>;
  private readonly addresses: () => readonly MdnsInterfaceAddress[];

  constructor(private readonly options: MdnsAdvertiserOptions) {
    this.serviceType = options.serviceType ?? POCKETAGENT_SERVICE_TYPE;
    // The port is part of the name so two backends on one machine (the
    // `pnpm demo:hub` shape, or a dev checkout beside production) cannot
    // collide — this module does no conflict probing, so uniqueness has to
    // come from construction.
    this.instanceName = `${instanceLabel(`${options.name} (${options.port})`)}.${this.serviceType}`;
    this.targetName = `pocketagent-${hostSlug(options.name)}-${options.port}.local`;
    this.schedule = options.schedule ?? defaultSchedule;
    this.addresses = options.addresses ?? localIpv4Addresses;
  }

  /**
   * The records this advertiser publishes, with `ttlScale` 0 for a goodbye.
   *
   * `via` narrows the A records to the one address a copy leaves from, when
   * it is one of ours; otherwise every address goes, physical ones first.
   */
  records(ttlScale: 0 | 1 = 1, via: string | null = null): { answers: DnsRecord[]; additionals: DnsRecord[] } {
    const hostTtl = HOST_RECORD_TTL_S * ttlScale;
    const serviceTtl = SERVICE_RECORD_TTL_S * ttlScale;
    const answers: DnsRecord[] = [
      { type: 'PTR', name: this.serviceType, ttl: serviceTtl, data: this.instanceName },
    ];
    const additionals: DnsRecord[] = [
      {
        type: 'SRV',
        name: this.instanceName,
        ttl: hostTtl,
        flush: true,
        data: { priority: 0, weight: 0, port: this.options.port, target: this.targetName },
      },
      {
        type: 'TXT',
        name: this.instanceName,
        ttl: serviceTtl,
        flush: true,
        data: encodeTxt(this.options.txt),
      },
      ...this.addressesFor(via).map(
        (address): DnsRecord => ({ type: 'A', name: this.targetName, ttl: hostTtl, flush: true, data: address }),
      ),
    ];
    return { answers, additionals };
  }

  private addressesFor(via: string | null): string[] {
    const all = this.addresses().map(({ address }) => address);
    return via !== null && all.includes(via) ? [via] : all;
  }

  /** A packet builder for `records(ttlScale, via)` — see `MdnsPayload`. */
  private payload(ttlScale: 0 | 1, header: { id: number; questions: readonly DnsQuestion[] } = { id: 0, questions: [] }) {
    return (via: string | null): Buffer =>
      encodePacket({ id: header.id, response: true, questions: header.questions, ...this.records(ttlScale, via) });
  }

  async start(): Promise<void> {
    if (this.transport) return;
    const transport = await this.options.transport();
    this.transport = transport;
    transport.onMessage((packet, from) => this.onMessage(packet, from));
    for (const delay of ANNOUNCE_DELAYS_MS) {
      this.timers.push(this.schedule(() => this.announce(), delay));
    }
    this.options.log?.info?.(
      { instance: this.instanceName, target: this.targetName, port: this.options.port },
      'advertising on mDNS',
    );
  }

  /** Sends goodbye packets (TTL 0, RFC 6762 §10.1) and closes the socket. */
  async stop(): Promise<void> {
    for (const timer of this.timers.splice(0)) timer.cancel();
    const transport = this.transport;
    if (!transport) return;
    this.transport = null;
    try {
      transport.send(this.payload(0));
    } catch {
      // Best effort: a missed goodbye only means browsers keep the row until
      // its TTL runs out.
    }
    await transport.close();
  }

  private announce(): void {
    this.transport?.send(this.payload(1));
  }

  private onMessage(buffer: Buffer, from: MdnsRemote): void {
    let packet: DnsPacket;
    try {
      packet = decodePacket(buffer);
    } catch {
      return;
    }
    if (packet.response || packet.questions.length === 0) return;
    if (!packet.questions.some((question) => this.answers(question))) return;

    // A query from a port other than 5353 is a "legacy unicast" resolver
    // (`dig -p 5353 @224.0.0.251`, RFC 6762 §6.7): it only hears a reply sent
    // straight back, carrying its own id and questions.
    const legacy = from.port !== MDNS_PORT;
    const reply = this.payload(1, legacy ? { id: packet.id, questions: packet.questions } : undefined);
    if (legacy || packet.questions.some((question) => question.unicastResponse)) {
      this.transport?.send(reply, from);
    }
    if (!legacy) this.transport?.send(reply);
    this.options.log?.debug?.({ from: from.address }, 'answered mDNS query');
  }

  private answers(question: DnsQuestion): boolean {
    const name = dnsKey(question.name);
    const any = question.type === RR_TYPE.ANY;
    if (name === dnsKey(this.serviceType)) return any || question.type === RR_TYPE.PTR;
    if (name === dnsKey(SERVICES_META_NAME)) return any || question.type === RR_TYPE.PTR;
    if (name === dnsKey(this.instanceName)) {
      return any || question.type === RR_TYPE.SRV || question.type === RR_TYPE.TXT;
    }
    if (name === dnsKey(this.targetName)) return any || question.type === RR_TYPE.A;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Browser

export interface DiscoveredService {
  /** The full instance name — stable, and the key a UI should use. */
  readonly instance: string;
  /** The instance label alone, e.g. `stone-dev01 (8787)`. */
  readonly name: string;
  /** The SRV target. */
  readonly target: string;
  readonly port: number;
  /** A-record addresses, in the advertiser's own preference order. */
  readonly addresses: readonly string[];
  /** Addresses packets about this instance actually arrived from — reachability evidence. */
  readonly sourceAddresses: readonly string[];
  readonly txt: Readonly<Record<string, string>>;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

export interface MdnsBrowserOptions {
  readonly transport: () => Promise<MdnsTransport>;
  readonly serviceType?: string;
  readonly now?: () => number;
  /** How often to re-ask, so a service keeps being refreshed well inside its 120 s TTL. */
  readonly requeryMs?: number;
  readonly schedule?: (fn: () => void, ms: number) => { cancel: () => void };
  readonly log?: MdnsLogger;
}

interface Expiring<T> {
  readonly value: T;
  readonly expiresAt: number;
}

/** Early re-queries after start (RFC 6762 §5.2), then the steady cadence. */
const INITIAL_QUERY_DELAYS_MS = [0, 1000, 3000];
const DEFAULT_REQUERY_MS = 60_000;

/**
 * Listens for one DNS-SD service type and keeps a TTL-bounded view of it.
 *
 * Passive and active at once: every response on the group is read (so a
 * backend that just booted and announced appears with no query at all), and
 * a PTR query goes out on a fixed cadence (so one that booted before this
 * browser is found too). A goodbye — any record at TTL 0 — removes its
 * instance at once rather than after a timeout.
 */
export class MdnsBrowser {
  private readonly serviceType: string;
  private readonly now: () => number;
  private readonly schedule: NonNullable<MdnsBrowserOptions['schedule']>;
  private transport: MdnsTransport | null = null;
  private timers: { cancel: () => void }[] = [];
  private readonly ptr = new Map<string, Expiring<string>>();
  private readonly srv = new Map<string, Expiring<SrvData>>();
  private readonly txt = new Map<string, Expiring<readonly string[]>>();
  private readonly addr = new Map<string, Map<string, { expiresAt: number; receivedAt: number }>>();
  private readonly sources = new Map<string, Map<string, number>>();
  private readonly firstSeen = new Map<string, number>();
  private readonly lastSeen = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: MdnsBrowserOptions) {
    this.serviceType = options.serviceType ?? POCKETAGENT_SERVICE_TYPE;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? defaultSchedule;
  }

  async start(): Promise<void> {
    if (this.transport) return;
    const transport = await this.options.transport();
    this.transport = transport;
    transport.onMessage((packet, from) => this.onMessage(packet, from));
    for (const delay of INITIAL_QUERY_DELAYS_MS) {
      this.timers.push(this.schedule(() => this.query(), delay));
    }
    this.scheduleRequery();
  }

  async stop(): Promise<void> {
    for (const timer of this.timers.splice(0)) timer.cancel();
    const transport = this.transport;
    this.transport = null;
    await transport?.close();
  }

  /** Called whenever the set of services may have changed. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Asks the group for every instance of the service type, now. */
  query(): void {
    this.transport?.send(
      encodePacket({
        id: 0,
        response: false,
        questions: [{ name: this.serviceType, type: RR_TYPE.PTR }],
        answers: [],
        additionals: [],
      }),
    );
  }

  /** Every instance with a live SRV record, most recently seen first. */
  services(): DiscoveredService[] {
    const now = this.now();
    this.purge(now);
    const suffix = `.${dnsKey(this.serviceType)}`;
    const out: DiscoveredService[] = [];
    for (const [key, srv] of this.srv) {
      if (!key.endsWith(suffix)) continue;
      const display = this.ptr.get(key)?.value ?? key;
      const name = display.slice(0, display.length - suffix.length);
      const target = srv.value.target;
      out.push({
        instance: display,
        name,
        target,
        port: srv.value.port,
        addresses: [...(this.addr.get(dnsKey(target))?.keys() ?? [])],
        sourceAddresses: [...(this.sources.get(key)?.keys() ?? [])],
        txt: decodeTxt(this.txt.get(key)?.value ?? []),
        firstSeenAt: this.firstSeen.get(key) ?? now,
        lastSeenAt: this.lastSeen.get(key) ?? now,
      });
    }
    return out.sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.instance.localeCompare(b.instance));
  }

  private scheduleRequery(): void {
    const every = this.options.requeryMs ?? DEFAULT_REQUERY_MS;
    this.timers.push(
      this.schedule(() => {
        this.query();
        this.scheduleRequery();
      }, every),
    );
  }

  private purge(now: number): void {
    for (const map of [this.ptr, this.srv, this.txt] as Map<string, Expiring<unknown>>[]) {
      for (const [key, entry] of map) if (entry.expiresAt <= now) map.delete(key);
    }
    for (const [key, addresses] of this.addr) {
      for (const [address, entry] of addresses) if (entry.expiresAt <= now) addresses.delete(address);
      if (addresses.size === 0) this.addr.delete(key);
    }
    for (const key of [...this.firstSeen.keys()]) {
      if (!this.srv.has(key) && !this.ptr.has(key)) {
        this.firstSeen.delete(key);
        this.lastSeen.delete(key);
        this.sources.delete(key);
      }
    }
  }

  private onMessage(buffer: Buffer, from: MdnsRemote): void {
    let packet: DnsPacket;
    try {
      packet = decodePacket(buffer);
    } catch {
      return;
    }
    if (!packet.response) return;

    const now = this.now();
    const typeKey = dnsKey(this.serviceType);
    const suffix = `.${typeKey}`;
    const touched = new Set<string>();
    const needsDetail = new Set<string>();
    let changed = false;

    for (const record of [...packet.answers, ...(packet.authorities ?? []), ...packet.additionals]) {
      const key = dnsKey(record.name);
      const expiresAt = now + record.ttl * 1000;
      const goodbye = record.ttl === 0;
      switch (record.type) {
        case 'PTR': {
          if (key !== typeKey) break;
          const instance = dnsKey(record.data);
          if (!instance.endsWith(suffix)) break;
          if (goodbye) {
            this.forget(instance);
          } else {
            this.ptr.set(instance, { value: record.data, expiresAt });
            touched.add(instance);
            if (!this.srv.has(instance)) needsDetail.add(record.data);
          }
          changed = true;
          break;
        }
        case 'SRV':
          if (!key.endsWith(suffix)) break;
          if (goodbye) this.forget(key);
          else {
            this.srv.set(key, { value: record.data, expiresAt });
            touched.add(key);
          }
          changed = true;
          break;
        case 'TXT':
          if (!key.endsWith(suffix)) break;
          if (goodbye) this.txt.delete(key);
          else {
            this.txt.set(key, { value: record.data, expiresAt });
            touched.add(key);
          }
          changed = true;
          break;
        case 'A':
        case 'AAAA': {
          // Kept for any name: an A record often arrives in the same packet as
          // the SRV that names it, and filtering by "a target we already
          // know" would drop exactly that one.
          const addresses = this.addr.get(key) ?? new Map<string, { expiresAt: number; receivedAt: number }>();
          if (record.flush) {
            // RFC 6762 §10.2: a cache-flush record replaces older ones — but
            // only those received more than a second ago, so the several A
            // records of one announcement do not flush each other.
            for (const [address, entry] of addresses) {
              if (entry.receivedAt < now - 1000) addresses.delete(address);
            }
          }
          if (goodbye) addresses.delete(record.data);
          else addresses.set(record.data, { expiresAt, receivedAt: now });
          if (addresses.size > 0) this.addr.set(key, addresses);
          else this.addr.delete(key);
          changed = true;
          break;
        }
        default:
          break;
      }
    }

    for (const key of touched) {
      if (!this.firstSeen.has(key)) this.firstSeen.set(key, now);
      this.lastSeen.set(key, now);
      const sources = this.sources.get(key) ?? new Map<string, number>();
      sources.set(from.address, now);
      this.sources.set(key, sources);
    }

    // A PTR with no SRV beside it (a responder that answers the type query
    // minimally) is followed up once, for the details.
    if (needsDetail.size > 0) {
      this.transport?.send(
        encodePacket({
          id: 0,
          response: false,
          questions: [...needsDetail].flatMap((instance) => [
            { name: instance, type: RR_TYPE.SRV },
            { name: instance, type: RR_TYPE.TXT },
          ]),
          answers: [],
          additionals: [],
        }),
      );
    }

    if (changed) for (const listener of this.listeners) listener();
  }

  private forget(instanceKey: string): void {
    this.ptr.delete(instanceKey);
    this.srv.delete(instanceKey);
    this.txt.delete(instanceKey);
    this.sources.delete(instanceKey);
    this.firstSeen.delete(instanceKey);
    this.lastSeen.delete(instanceKey);
  }
}
