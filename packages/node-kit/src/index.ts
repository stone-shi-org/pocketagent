/**
 * Node-only primitives shared by `apps/server` and `apps/hub` (PA-66).
 *
 * The sibling of `packages/protocol`, and the split between them is the point:
 * protocol is wire *shapes* and is bundled into the browser, so `node:crypto`
 * must never appear in it. This package is the other half — the handful of
 * security primitives where two implementations drifting is a security bug
 * rather than an inconsistency.
 *
 * ## Why this exists at all
 *
 * The Hub needs `secret-box` (it stores each backend's scoped credential
 * encrypted at rest) and the token/origin helpers (it runs the same session
 * login and the same CSRF check the backend does). The obvious way to get them
 * would be `"@pocketagent/server": "workspace:*"`, and that is wrong twice
 * over: it would drag node-pty, better-sqlite3's server usage, the Claude Agent
 * SDK and the MCP SDK into an image whose entire job is to forward bytes, and
 * it would make a gateway depend on the thing it is a gateway *for*.
 *
 * ## What deliberately did not move
 *
 * `AuthService` and `openDatabase`. A session store is bound to its own table
 * in its own schema, and the server's database opener carries a long positional
 * `MIGRATIONS` array plus `PRAGMA table_info` repair blocks that exist to heal
 * branch drift in a schema with years of history. A brand-new schema must not
 * inherit that scaffolding, so the Hub has its own small opener and the
 * similarity between them is a convention rather than a shared function.
 *
 * What is here is exactly what must never be written twice: the AES-256-GCM
 * framing and its key-parsing contract, constant-time comparison, token
 * generation, bearer parsing, and the Origin policy.
 */
export {
  SECRET_KEY_BYTES,
  SETTINGS_ENC_KEY_HELP,
  SETTINGS_ENC_KEY_VAR,
  SecretKeyError,
  decryptSecret,
  encryptSecret,
  parseSettingsEncKey,
} from './secret-box.js';
export { bearerTokenFrom, generateToken, safeTokenEqual } from './tokens.js';
export { isOriginAllowed } from './origin.js';
// PA-110: DNS-SD over multicast DNS. Here rather than in either app because
// the advertiser (`apps/server`) and the browser (`apps/hub`) are one
// contract — the service type, the TXT keys and the TTLs — and a second copy
// of any of them is how a Hub stops seeing backends with no error anywhere.
export {
  DnsDecodeError,
  HOST_RECORD_TTL_S,
  MDNS_ADDRESS,
  MDNS_PORT,
  MdnsAdvertiser,
  MdnsBrowser,
  POCKETAGENT_SERVICE_TYPE,
  RR_TYPE,
  SERVICE_RECORD_TTL_S,
  decodePacket,
  decodeTxt,
  dnsKey,
  encodePacket,
  encodeTxt,
  localIpv4Addresses,
  openMdnsSocket,
  type DiscoveredService,
  type DnsPacket,
  type DnsQuestion,
  type DnsRecord,
  type MdnsAdvertiserOptions,
  type MdnsBrowserOptions,
  type MdnsInterfaceAddress,
  type MdnsLogger,
  type MdnsPayload,
  type MdnsRemote,
  type MdnsTransport,
  type SrvData,
} from './mdns.js';
