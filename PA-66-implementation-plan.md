# PA-66 — PocketAgent Hub: one-origin gateway, host registry and single sign-on

Implementation plan. **No code changed yet** beyond this document — there is no `agent-ready`/
`approved` label and no go-ahead comment, so this is posted for review first per the workflow.

## 0. Where this sits

| Ticket | What it owns | Status in this worktree |
| --- | --- | --- |
| PA-60 | `HostEndpoint`, `#/h/<hostId>/` parsing, host-scoped API/WS client | **implemented** (`bb387c5`) |
| PA-61 | per-host protocol negotiation, real semver on `/health` | **implemented** (`afbaf35`) |
| PA-63 | scoped hub credentials: `hub-bind`, list, revoke — the *backend* half | **implemented** (`9928355`) |
| PA-65 | release pipeline, tag matrix, image digests | **implemented** (`fe610e4`) |
| **PA-66** | `apps/hub`: registry, one-origin proxy, SSO, health polling, image | this document |
| PA-67 | the multi-host UI that consumes the registry | plan posted (`808cc3e`), not implemented |
| PA-70 / PA-71 | provisioning; the docs/CLAUDE.md rewrite | not started |

Every dependency this ticket declares is already on the branch, so PA-66 is unblocked. The
important sequencing question is the *other* direction, and it produced decision **D6b** below:
without care, a Hub that serves the current web bundle serves a UI that cannot talk to anything,
because `DEFAULT_HOST.basePath` is `''` and the bundle would ask the *Hub* for `/api/projects`.
D6b makes PA-66 independently shippable and demonstrable, and turns the unmodified single-host
bundle into the strongest available regression test for the proxy itself.

## 1. What I verified in the code

Line numbers are current `feature/hub` (`fe610e4`).

1. **The backend already expects a Hub that strips `Origin`.** The single auth gate
   (`app.ts:689–741`) runs the CSRF Origin check *above* the bearer check, and its comment says
   so outright: "A Hub is not a browser and sends no Origin, which `isOriginAllowed` already
   permits". And it must be stripped, not forwarded: `isOriginAllowed`
   (`auth/index.ts:104–120`) returns true for an absent Origin but otherwise falls back to
   `new URL(origin).host === host`, and a Hub's origin is by construction never the backend's
   `Host`. Forwarding the browser's Origin therefore 403s **every non-GET request** through the
   proxy. This is the single most likely way to get the proxy subtly wrong.
2. **`HostInfo.id` is not a usable routing key.** `ProjectService.host()`
   (`projects/index.ts:141–144`) seeds the sha256 with `hostname + workspace roots joined`, so
   **adding a project folder from the UI changes the host id.** Its doc comment only promises
   stability "across a restart and a database wipe" — not across a roots change. Routing
   `/h/<HostInfo.id>/` would silently break every bookmark, every open tab and every stored
   pairing the first time an operator adds a folder. Hence D3.
3. **The entire unauthenticated backend surface is four exact strings plus one prefix.**
   `PUBLIC_API_PATHS` (`app.ts:117–122`) is an exact-string `Set` — `/health`,
   `/api/auth/login`, `/api/auth/me`, `/api/auth/hub-bind` — and `isWebhookDelivery`
   (`app.ts:140–150`) matches POST with exactly one non-empty segment after `/api/hooks/`. That
   list is what the proxy's deny list has to cover, and hooks is only one entry of it (D6).
4. **There is already a precedent for a byte-exact passthrough in this codebase.**
   `routes/webhook-delivery.ts` is its own Fastify plugin scope with `removeAllContentTypeParsers()`
   precisely because Fastify's JSON parser hands back an object whose re-serialization is not
   byte-identical. The proxy needs the same mechanism for the opposite direction, and inherits
   the same encapsulation test.
5. **The Hub needs no WebSocket library at all.** The backend registers `@fastify/websocket`
   (`app.ts:661–663`) and `/api/ws` is a normal route (`ws/index.ts:194`), authenticated by the
   one `onRequest` gate. A gateway that splices at the socket level never constructs a
   `WebSocket` object on either side — which is what turns "must not inspect frames" from a
   convention into a property of the code (D8).
6. **The web client is already host-parameterised, and PA-66 needs none of PA-67's work.**
   `hostUrl` (`api/host.ts`), `requestAt` (`api/client.ts:118`, `credentials: 'same-origin'`) and
   `wsUrl` (`api/ws-client.ts:144`, a *relative* `<basePath>/api/ws?v=`) all honour a base path
   today. What is still single-host is `KNOWN_HOSTS = [DEFAULT_HOST]`, the module singleton
   `api` (`client.ts:959`) and `App.tsx:35` discarding `useHashRoute()`'s third element. PA-66
   changes **none** of them; PA-67 does.
7. **`/health` is the designed probe and `negotiateProtocol` already names this service.**
   `HealthResponse` (`http.ts:306`) is exactly four keys and `health.test.ts` pins the count;
   `protocol-negotiation.ts:12` says in prose that "the Hub polls `/health` across every bound
   backend to draw the host list" and that a second copy of the arithmetic "in `apps/web` (or
   later in `apps/hub`) guarantees the host list eventually disagrees with what the socket
   handshake actually does."
8. **The static-serving shape is 30 lines and must be copied, not invented** (`app.ts:780–813`):
   `@fastify/static` with `index: false`, `index.html` `readFileSync`'d **once at boot**, served
   with `cache-control: no-store`, and a not-found handler that 404-JSONs `/api/` and otherwise
   returns the shell. The boot-time read is the reason CLAUDE.md's "rebuild **then** restart"
   rule exists, and it will apply to the Hub identically.
9. **`packages/protocol/src/hub.ts` already exists** and is PA-63's *credential* protocol
   (`HUB_TOKEN_SCHEME_PREFIX = 'pah_'`, `HubBindRequest/Response`, `HubCredentialSummary`). It
   contains no registry, routing or gateway types. PA-67's posted plan proposed adding
   `HubHostEntry`/`HubHostListResponse`/`HubHostStatus` to it; PA-67 is not implemented, so
   PA-66 owns those names — in a new module, see D13.
10. **`apps/hub` is asserted not to exist in four places** that become false the moment this
    lands: `CLAUDE.md:83–84`, `README.md:456–458`, `README.md:854`, and
    `protocol-negotiation.ts:12`. README:457–458 also already prescribes the packaging shape:
    "adding the hub is a second image in the same loop, not a second pipeline."
11. **The repo's build wiring is glob-based and mostly free.** `pnpm-workspace.yaml` is
    `apps/*` + `packages/*`, and root `typecheck` is `pnpm -r`, so both pick a new package up
    with no edit. What is *not* free: root `build` (`package.json:12`) is an explicit ordered
    chain; `vitest.config.ts` lists two projects by hand; `eslint.config.js` has **no default
    Node globals block**, so without an `apps/hub/src/**` entry every `process` is a `no-undef`.
12. **`VERSIONED_PACKAGES` is a four-item list and its test is self-referential.**
    `scripts/set-version.mjs:40–45`, and `release-tags.test.ts:110` asserts
    `Object.keys(versions)` **equals** that list — so adding `apps/hub/package.json` to it makes
    the no-drift guarantee cover the Hub automatically, and *not* adding it means `build.sh`'s
    tag/version reconciliation silently ignores the Hub's version forever.
13. **The tag matrix is suffix-on-one-image, and a Hub image is a different name.**
    `build.sh:35` hardcodes `image_name='pocketagent-server'` and `release-tags.mjs:19–23` is
    `TARGET_SUFFIXES = { thin: '', claude: '-claude', all: '-all' }`. Publishing
    `pocketagent-server:1.2.3-hub` would be actively misleading. Hence D17.
14. **One Dockerfile line blocks all four targets if missed.** The manifest-only COPY block
    (`Dockerfile:62–65`) names each workspace `package.json` explicitly; a lockfile that lists
    `apps/hub` with no manifest in the context fails `pnpm install --frozen-lockfile` for the
    *existing* images too.
15. **The shared primitives the Hub needs live inside a package it must not depend on.**
    `crypto/secret-box.ts`, and `safeTokenEqual`/`generateToken`/`bearerTokenFrom`/
    `isOriginAllowed` (`auth/index.ts:9–120`), are exactly right — but `@pocketagent/server`'s
    dependencies are node-pty, better-sqlite3, `@anthropic-ai/claude-agent-sdk` and the MCP SDK.
    Depending on it to reach 200 lines of crypto puts all of that in the Hub image. Hence D2.
16. **A 401 from one backend currently logs the operator out of everything.** `App.tsx`'s
    `handleApiError` sets the whole app to `'anonymous'` on any `ApiError.isUnauthorized`. Behind
    a Hub, one revoked credential would therefore bounce the operator to the login screen for
    *all* hosts. Hence D21.
17. **`fatalCloseMessage` keys its wording on `basePath === ''`** (`ws-client.ts:49`). Behind the
    Hub every host has a non-empty base path — including the machine the operator thinks of as
    local — so the "reload the page" branch becomes unreachable. That is arguably correct (no
    proxied backend served the bundle) but it is a behaviour change nobody has signed off.
    Flagged for PA-67; PA-66 does not touch it.
18. **No proxy library is in the lockfile** (no `@fastify/http-proxy`, no `undici` beyond
    `undici-types`). `ws@8.21.3` is present, and Node ≥22 gives global `fetch`. The plan below
    adds **no** new runtime dependency for the proxy: `node:http` for HTTP and for the upgrade
    dial, which is also what makes D8 possible.

## 2. Design decisions

Each records the alternative it rejected.

### D1 — `apps/hub` is a Fastify service that does not depend on `@pocketagent/server`

New workspace package `@pocketagent/hub`: Fastify 5, `@fastify/cookie`, `@fastify/rate-limit`,
`@fastify/static`, `better-sqlite3`, `pino`, `dotenv`, `zod`, `@pocketagent/protocol`. It reuses
the server's *shapes* — boot order, the single `onRequest` gate, the pino redact list, the
static/SPA block, the positional-migration opener — because a reader who knows one should be able
to read the other. It does not reuse the server's *package*, for finding #15.

Rejected: `"@pocketagent/server": "workspace:*"` to reach `secret-box.ts`. It drags node-pty, the
Claude Agent SDK and the MCP SDK into an image whose entire job is to forward bytes.

### D2 — The security primitives move to a new leaf package; the SQLite opener does not

New `packages/node-kit` (`@pocketagent/node-kit`), a Node-only sibling of `packages/protocol`
holding exactly what both services must agree on and where drift is a security bug:

* `secret-box.ts` verbatim (`encryptSecret`/`decryptSecret`/`parseSettingsEncKey`/
  `SECRET_KEY_BYTES`/`SETTINGS_ENC_KEY_VAR`) — the two never share a ciphertext, but they *do*
  share the variable name, the 32-byte rule and the "empty means unset, wrong length throws"
  boot contract, and those three drifting is operator-visible.
* `safeTokenEqual`, `generateToken`, `bearerTokenFrom`, `isOriginAllowed`.

This is a **pure move**: `apps/server` re-exports from its existing paths so not one server call
site changes, and the existing server suite (`auth.test.ts`, `hub-credentials.test.ts`,
`custom-claude-providers.test.ts`, `telegram-bots.test.ts`, `config.test.ts`) is the regression
guard. `packages/protocol` is deliberately *not* the home: it is imported by the browser bundle,
and `node:crypto` does not belong there.

The database opener is deliberately **not** moved. `openDatabase` (`db/index.ts:1346`) carries a
1,100-line positional `MIGRATIONS` array plus three `PRAGMA table_info` repair blocks that exist
to heal branch drift in a schema with years of history. A brand-new schema must not inherit that
scaffolding; the Hub gets its own ~30-line opener with the same three pragmas, the same
`schema_version` row and the same append-only array, and the similarity is a convention rather
than a shared function.

Rejected: copying `secret-box.ts` into `apps/hub` (zero churn in `apps/server`, at the cost of
two AES-GCM framings and two boot contracts that must stay identical by vigilance). This is
**question 1** — it is the only part of PA-66 that edits `apps/server`, and I will take the copy
if you prefer the blast radius to be zero.

### D3 — The host id is Hub-minted, operator-chosen and slug-shaped — never `HostInfo.id`

Finding #2 is the argument: the backend's own id changes when a project folder is added.
`/h/<hostId>/` uses a Hub-local id validated as `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$` — which
by construction contains no `/`, `.`, `%` or uppercase, so it can neither traverse nor collide
with the Hub's own `/api/` namespace. The ticket's own diagram (`/h/stone-dev01/`) is already
this shape.

The Hub *does* record the backend's reported `HostInfo.id` at bind time and compares it on every
health poll, surfacing a `identityChanged` flag — display-only. "The machine behind this base URL
is not the one you bound" is worth saying; acting on it automatically is not, because the common
cause is the benign one (a folder was added).

Rejected: a uuid (untypeable, and the id is in every URL the operator sees).

### D4 — The Hub answers the backend's own `/api/auth/*` shapes, at its own origin

`POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`, with the same request and
response schemas from `packages/protocol`, the same 8/min rate limit, the same in-handler
`isOriginAllowed`, the same HttpOnly `SameSite=Strict` cookie and the same `auth_sessions`-shaped
table. **That is the entirety of single sign-on**: the shipped `LoginPage.tsx` and `App.tsx` work
against the Hub unmodified, with no client branch and no new protocol type.

Rejected: a `/api/hub/auth/*` namespace. It would force a client fork and break the
"standalone renders identically" property PA-67's whole plan is built on.

### D5 — The Hub's cookie name and token are its own

`POCKETAGENT_HUB_AUTH_TOKEN`, min 24 chars, no default, boot refused without it — deliberately
**not** `POCKETAGENT_AUTH_TOKEN`. A compose file that reused one variable for both services would
make the Hub's login password also a backend master token, which is exactly the credential
concentration this architecture exists to avoid. The Hub never reads `POCKETAGENT_AUTH_TOKEN` at
all.

The cookie is `pocketagent_hub_sid`, not `pocketagent_sid`. **Cookies are not port-scoped**: a
Hub on `:9090` and a backend on `:8787` of one hostname — the obvious development setup — share a
jar, and one would silently overwrite the other's session. The cookie is HttpOnly and never read
by JavaScript, so this needs no client change.

### D6 — The proxy is a positive allowlist with an explicit, separately-tested deny list

Two path shapes are proxied under a host prefix: `/h/<id>/api/**` and `/h/<id>/health`. Anything
else under `/h/<id>/` is a Hub 404 and the backend is never dialed — the browser only ever asks a
host for those two (`hostUrl` is called with `/api/...` and `/health`), and the bundle's assets
come from the Hub's own origin.

Inside that allowlist, `HUB_PROXY_DENY` refuses, before any routing decision:

| Denied | Why |
| --- | --- |
| `/api/hooks/` (prefix) | The ticket's hard constraint #1. Re-exposing it would break CLAUDE.md's "`grep '/api/hooks/'` enumerates the entire dynamic unauthenticated surface" guarantee and make the Hub inherit the slug-enumeration-oracle design wholesale. Jira keeps delivering straight to the backend. |
| `/api/auth/login`, `/api/auth/logout`, `/api/auth/hub-bind` | The SSO promise (D4) is that a browser never logs in to a backend. Proxying `login`/`hub-bind` would also relay master-token guesses through the Hub. |
| `/api/auth/me` | Answered *locally* by the Hub instead (D7). |

Together that is every entry of the backend's `PUBLIC_API_PATHS` plus the hooks prefix, which is
the statable invariant: **nothing in a backend's unauthenticated surface is reachable through
`/h/`.** The hooks entry stays its own named constant with its own test anyway, because the
ticket asks for that and because its reasoning is different from the others'.

Path handling is **reject, not canonicalize**: a request whose raw path contains `%2f`, `%5c`,
`%2e` (any case) or a `.`/`..` segment is refused with the same 404, rather than normalized. A
rejection is analysable in one line; a canonicalizer is where path-confusion bugs live. The deny
comparison is then a plain case-insensitive `startsWith` on a path already known to be free of
escapes.

### D6b — One host is the *default* and is also mounted at the bare `/api/*` root

Without this, PA-66 ships a Hub that serves a UI which cannot talk to anything: the current
bundle's `DEFAULT_HOST.basePath` is `''`, so it asks the Hub itself for `/api/projects`
(finding #6). So the registry carries exactly one `is_default` host, and the Hub proxies bare
`/api/**` (minus its own `/api/hub/**` and `/api/auth/**`, minus the same deny list) and bare
`/api/ws` to it.

Two things this buys, beyond "PA-66 is shippable alone". It makes the **unmodified single-host
bundle the proxy's regression test** — every existing browser demo can be pointed at the Hub and
must behave identically, which is a far broader assertion than any unit test of the proxy. And it
gives PA-67 a working fallback for any code path that has not yet learned about host prefixes.

Rejected: requiring PA-67 to land simultaneously (couples the two largest tickets in the series
and leaves PA-66 undemonstrable), and serving a hub-specific placeholder UI (a second frontend).

This is **question 2**: it is a genuine addition to the ticket's stated routing table.

### D7 — `/h/<id>/api/auth/me` is answered by the Hub; `/h/<id>/health` is proxied live

`GET /api/auth/me` on the backend reports **cookie** sessions only — a bearer-authenticated
caller reads as `authenticated: false` (`routes/auth.ts:149`). Proxied, it would tell a per-host
`me()` call the operator is logged out of a host they can plainly reach. The Hub answers it from
its own session instead: "you are authenticated to the Hub, which is what reaches this host" is
the true answer.

`/health` is proxied live rather than served from the poller's cache, so `negotiate.ts`'s probe
reads the same bytes the socket handshake will honour. It still requires a **Hub** session, so
the Hub does not become an unauthenticated reachability scanner for anyone who can reach the
port.

### D8 — The WebSocket is spliced at the TCP level; only the handshake head is rewritten

On the raw `server.on('upgrade')`: authenticate the Hub cookie, run the Origin check, resolve the
host, apply the *same* allowlist and deny list (so `/h/<id>/api/hooks/x` cannot be upgraded
either), then `http.request` upstream with a rewritten head, and on the upstream's own `upgrade`
event write its raw 101 response head to the client socket and `pipe()` in both directions.

The Hub therefore has **no WebSocket library, no frame parser, no `permessage-deflate`
negotiation of its own, and no place a frame could be logged even by accident.** "Terminal I/O is
never logged or persisted" holds in the second process as a property of the code rather than as a
rule someone has to remember — which is what the ticket's hard constraint #2 asks for. The 4001
protocol-mismatch close and its reason string reach the browser byte-identical, so PA-61's
per-host negotiation keeps working through the Hub unchanged.

What *is* rewritten is stated rather than hidden: the request head (Host, credential, stripped
Cookie/Origin — D9). The frames are the dumb pipe; the handshake is not.

Rejected: `ws` in `noServer` mode with a client `WebSocket` and `on('message')` forwarding. It
decodes and re-encodes every frame — which makes "must not inspect" a convention rather than a
property, has to re-negotiate compression and gets fragmentation and binary/text subtly wrong,
and adds a copy per frame on the terminal hot path.

### D9 — One header-hygiene function, shared by both transports

Upstream: drop hop-by-hop headers (`connection`, `keep-alive`, `proxy-*`, `te`, `trailer`,
`transfer-encoding`); drop **`cookie`** (the Hub's session means nothing to a backend and must
not travel) and **`origin`** (finding #1); set `host` to the backend's authority; set
`authorization: Bearer <decrypted pah_ token>`; replace any client-supplied `x-forwarded-*` with
the Hub's own view of the peer. Downstream: drop hop-by-hop headers and **`set-cookie`** — a
backend has no business setting a cookie on the Hub's origin, and the deny list already means it
never has a reason to.

`Authorization` is already on the server's `REDACT_PATHS` and will be on the Hub's, so "nothing
logs the credential" holds by construction, exactly as PA-63 arranged it on the other side.

### D10 — Bodies are streamed and never parsed, in both directions

The proxy lives in its own Fastify plugin scope with `removeAllContentTypeParsers()` and a `*`
parser that hands back the raw stream; the response goes out via `reply.hijack()` + `reply.raw`.
No buffering, no re-chunking, no invented `content-length` — which is also what lets the planner's
`text/event-stream` turns flow through untouched. Same mechanism as
`routes/webhook-delivery.ts`, same encapsulation test: a JSON POST to a sibling Hub route must
still parse normally.

### D11 — Host rows are read per request; live sockets are tracked, their bytes are not

The registry row is read from SQLite on **every** proxied request with no in-memory cache — the
same "validation reads the row fresh" discipline `HubCredentialStore.validate` uses, and the
reason revocation there is immediate with no restart. That satisfies "removing a host stops all
proxying immediately" for HTTP.

It is not sufficient for WebSockets: a spliced socket outlives the request that created it. So
the Hub keeps `Map<hostId, Set<Socket>>` — socket handles only, no metadata about the traffic —
and `DELETE`/disable destroys them synchronously. This is the only per-connection state the Hub
holds anywhere, and it is deliberately the handle rather than anything about the bytes.

### D12 — Health polling is per-host and self-rescheduling, modelled on the Telegram poller

One self-rescheduling loop per enabled host, 30 s cadence, an 8 s `AbortController` per probe,
`GET <baseUrl>/health` parsed with `HealthResponse` — the one and only place the Hub validates a
backend's response body, because it *is* the usability decision — and the verdict from
`negotiateProtocol`, never a second copy of the arithmetic (finding #7).

Per-host rather than `CronService`'s single shared tick, because a hung host must not delay the
others; that is acceptance criterion 5. A probe failure sets `online: false` with a human-readable
reason and never escapes the loop. The poll is **unauthenticated**, which is what makes "add a
backend by base URL, *then* bind it" a two-step flow the UI can show progress for.

### D13 — Registry types go in a new `packages/protocol/src/hub-registry.ts`

`hub.ts` is the *backend's* view of a credential (PA-63); `hub-registry.ts` is the *Hub's* own
API. Keeping them apart keeps "what a backend must implement" separate from "what the Hub
offers", which matters because `apps/server` must never grow a dependency on the second. Added to
`index.ts`'s re-export list (everything there is `export *`, so a new module needs an explicit
line).

Types: `HubHostEntry` (id, label, baseUrl, enabled, isDefault, boundAt, credentialPrefix,
backendHostId, identityChanged, status), `HubHostStatus` (online, version, protocol|null,
lastCheckedAt, error|null), `HubHostListResponse`, `CreateHubHostRequest`, `UpdateHubHostRequest`,
`BindHubHostRequest`, `HubHostBindResponse`. Names match what PA-67's posted plan expects; only
the file differs, and PA-67 is not implemented, so this is a coordination note rather than a
conflict.

### D14 — `POCKETAGENT_SETTINGS_ENC_KEY` is **required** on the Hub

A deliberate divergence from the server, where unset disables the feature and boot succeeds
because providers and bots are optional extras. On the Hub, encrypted credentials are the entire
product: a Hub with nowhere to put them has nothing to do, and starting anyway would only defer
the failure to the operator's first bind. Unset is a boot error (exit 78, the same `ConfigError`
path `server.ts:9–14` uses); set-but-invalid throws exactly as it does today.

The master token is accepted **only** in the bind request body, is never written to the database,
and is never logged (`req.body` is redacted wholesale in the copied pino config). Stored per host:
`encryptSecret(token)` plus `token_prefix` in the clear, so a row can be matched against what is
listed under the backend's Settings → Hubs. A row whose credential cannot be decrypted (a rotated
key) is **listed, marked `unbound`, logged, and refuses to proxy** — never proxied uncredentialed,
and never silently dropped from the list, the same posture `CustomClaudeProviderStore` takes.

This is **question 3**.

### D15 — Removing a host attempts revocation but never blocks on it

`DELETE /api/hub/hosts/:id` makes a best-effort `DELETE <base>/api/auth/hubs/<credentialId>`,
reports `revokedOnBackend: boolean`, and removes the row either way. Blocking would mean a host
that is *down* — precisely the case where an operator most wants it gone — cannot be removed.
Silently skipping would leave an orphaned full-access credential on that machine while the UI
implied it was cleaned up. So: try, say what happened, and always name the backend's Settings →
Hubs page in the confirmation.

### D16 — The Hub serves the same `apps/web` bundle, the same way

`@fastify/static` with `index: false`, `index.html` read once at boot, `cache-control: no-store`,
SPA fallback for anything not under `/api/` or `/h/`. Byte-identical to the backend's block
(finding #8), including inheriting the "rebuild **then** restart" rule, which the README note
will state for the Hub too.

Rejected: a hub-specific frontend. PA-67 is explicitly the multi-host UI *in this bundle*, and
two bundles means every page exists twice.

### D17 — A fourth build target, a second image name, one pipeline

* `docker/Dockerfile` gains a `hub-runtime` stage in the **same** file (README:457–458 already
  prescribes "a second image in the same loop, not a second pipeline"), plus
  `COPY apps/hub/package.json apps/hub/` in the manifest block — which is required for *all four*
  targets, not just the new one (finding #14).
* `docker/build.sh` gains target `hub` → stage `hub-runtime`.
* `build.sh` and `scripts/release-tags.mjs` change from "one image, per-target suffix" to a
  per-target `{ image, suffix }` table, so the Hub publishes `pocketagent-hub:1.2.3`, `:1.2`,
  `:latest` — and never `pocketagent-server:1.2.3-hub`, which an operator would reasonably
  pull expecting a server. Prerelease behaviour is unchanged and reused, not restated.
* A `hub-deps` stage runs `pnpm install --frozen-lockfile --prod --filter @pocketagent/hub...` so
  the Hub image carries neither node-pty nor the Claude Agent SDK. If that filter does not prune
  cleanly under pnpm 12, the honest fallback is to ship the shared `prod-deps` tree and record
  the size cost — **not** `pnpm deploy`, which flattens the layout the `REPO_ROOT` rule depends
  on. The Hub image keeps the `/app/apps/hub/dist/...` depth regardless, so the two images have
  one layout rule between them rather than two.
* `apps/hub/package.json` joins `VERSIONED_PACKAGES`, which makes `release-tags.test.ts` enforce
  it with no test edit (finding #12).
* `test.sh` and `bamboo-specs.yaml` need **no** change — both are package-agnostic, and a third
  vitest project lands in the same JUnit XML.

### D18 — `POCKETAGENT_HUB_DATA_DIR`, separate from `POCKETAGENT_DATA_DIR`

Default `<REPO_ROOT>/data/hub`, `/data` in the image, holding `pocketagent-hub.db`. A separate
variable because one variable naming two unrelated schemas is a trap in a compose file where both
services are present, and because the Hub has no workspace roots — so PA-62's "refuse a data root
inside a workspace root" check has nothing to check and is deliberately absent rather than
copied. The Hub logs the data root it opened at boot, exactly as the backend does.

### D19 — Reference TLS deployment: the Hub is the only published port

`docker/compose.hub.yaml`: one Hub plus two example backends on an internal network, with **only**
the Hub's port published, and `tailscale serve` on the Hub as the recommended TLS front (Caddy
and Traefik as the alternatives). `POCKETAGENT_TRUST_PROXY=true` on the Hub so rate limiting and
the audit IP see the real client; `POCKETAGENT_COOKIE_SECURE` left at its production default,
because the entire premise is that TLS now exists.

The backend-side configuration a Hub requires is worth stating because it is nearly nothing: one
`hub-bind` call. In particular the backends need **no** `POCKETAGENT_ALLOWED_ORIGINS` entry,
because the Hub strips `Origin` (D9) — and they should keep binding loopback or the tailnet, since
the Hub reaches them and nothing else should.

### D20 — Standalone is protected by the existing suites, not by intention

`apps/web` is untouched by PA-66. `apps/server` is touched only by D2's pure move, whose
regression guard is the server suite that already covers every one of those functions. Acceptance
criterion 6 is therefore a property of the diff rather than a new test — though the demo asserts
it anyway.

### D21 — An upstream 401 becomes a 502, not a passthrough

Finding #16: passing a backend's 401 through logs the operator out of the whole UI. A proxied
401/403 becomes **502 `host_credential_rejected`** naming the host id, and marks the row
`unbound` so the host list explains itself. Rejected: passthrough (one revoked credential logs you
out of every host) and swallowing it as a 200 (hides a real failure behind an empty list).

This is **question 4** — it is the Hub inventing a status the backend did not send, which is
exactly the kind of thing that should be a decision rather than a convenience.

### D22 — The CSRF boundary moves to the Hub; it does not disappear

Because D9 strips `Origin` upstream, the backend's Origin check becomes a no-op for proxied
traffic — correctly, since a bearer-authenticated request is not vulnerable to a confused browser
in the first place. What matters is that the check now has to happen *where the ambient cookie
is*, which is the Hub: same `isOriginAllowed`, same non-GET/HEAD scope, same
`POCKETAGENT_ALLOWED_ORIGINS` variable, in the Hub's own single `onRequest` gate. Stating this is
the point — "we removed a check" and "we moved a check" look identical in a diff.

### D23 — One `onRequest` gate, one redact list, no per-request logging

The Hub copies the server's exact posture: a single `onRequest` hook (so `/h/*` and the upgrade
path cannot acquire a second auth path), `disableRequestLogging: true`, and `REDACT_PATHS`
verbatim. `/h/*` adds one open and one close line per socket — host id, duration, close code —
and nothing else. By D8 there is no code path that could log a frame.

## 3. Files

**New**

| File | Purpose |
| --- | --- |
| `packages/protocol/src/hub-registry.ts` | registry/gateway wire types (D13) |
| `packages/node-kit/{package.json,tsconfig.json}` | the shared Node primitives package (D2) |
| `packages/node-kit/src/{index,secret-box,tokens,origin}.ts` | moved verbatim from `apps/server/src` |
| `apps/hub/{package.json,tsconfig.json}` | the new service |
| `apps/hub/src/server.ts` | entry point: `loadHubConfig` → `buildHubApp` → listen, exit 78 on config error |
| `apps/hub/src/app.ts` | Fastify build: plugins, security headers, the one auth gate, routes, static, upgrade handler |
| `apps/hub/src/config.ts` | `POCKETAGENT_HUB_*` env schema (D5, D14, D18) |
| `apps/hub/src/db.ts` | opener + append-only `MIGRATIONS` (`hub_hosts`, `hub_sessions`) |
| `apps/hub/src/auth.ts` | Hub session store + `/api/auth/*` routes (D4) |
| `apps/hub/src/registry/{store.ts,routes.ts}` | host CRUD, bind, enable/disable, remove (D3, D15) |
| `apps/hub/src/registry/health.ts` | the per-host poller (D12) |
| `apps/hub/src/proxy/{allowlist.ts,headers.ts,http.ts,ws.ts,sockets.ts}` | D6, D9, D10, D8, D11 — `allowlist.ts` and `headers.ts` are pure and unit-tested on their own |
| `apps/hub/tests/*.test.ts` | see §5 |
| `apps/hub/scripts/hub-demo.mjs` | the live demo (§5) |
| `docker/compose.hub.yaml` | reference deployment (D19) |

**Changed** (shape, not line count)

`packages/protocol/src/index.ts` (one re-export line) · `apps/server/src/crypto/secret-box.ts`
and `apps/server/src/auth/index.ts` (re-export the moved symbols) · `apps/server/package.json`
(+`@pocketagent/node-kit`) · root `package.json` (`build` chain, a `dev` pane, `demo:hub`,
`docker:build` unchanged) · `vitest.config.ts` (a third project) · `eslint.config.js` (an
`apps/hub/src/**` Node-globals block, and `hub-demo.mjs` in the browser-globals list) ·
`scripts/set-version.mjs` (`VERSIONED_PACKAGES`) · `scripts/release-tags.mjs` (per-target image)
· `build.sh` (per-target image, `hub` in `targets`) · `docker/build.sh` (the `hub` case) ·
`docker/Dockerfile` (manifest COPY + `hub-deps` + `hub-runtime`) · `apps/web/vite.config.ts` (a
`/h` dev proxy entry) · `.env.example`, `README.md`, `CLAUDE.md` (the four now-false statements,
finding #10) · Confluence.

## 4. Phases

Each ends with `pnpm build && pnpm typecheck && pnpm lint && pnpm test` green.

1. **Scaffold + SSO.** `packages/node-kit` move, `apps/hub` package, config, db, the auth gate,
   `/api/auth/*`, `/health`, static serving. No proxy. The Hub serves the login page and nothing
   behind it.
2. **Registry.** `hub_hosts`, CRUD, bind, the health poller, `GET /api/hub/hosts`.
3. **HTTP proxy.** Allowlist, deny list, header hygiene, streaming, 401 translation, the default
   host at bare `/api/*` (D6b). At the end of this phase the existing browser demos can be
   pointed at the Hub.
4. **WebSocket splice.** The upgrade handler, the live-socket registry, immediate teardown on
   remove/disable. Terminal and structured sessions work end to end.
5. **Ship.** Image target, tag matrix, compose, `demo:hub`, README/CLAUDE.md/Confluence.

Phases 1–2 are independently reviewable and land nothing user-visible; 3 and 4 are where the
security assertions live and should be reviewed as a pair with their tests.

## 5. Verification

**Unit / integration** — a new `hub` vitest project (`root: './apps/hub'`, `include:
['tests/**/*.test.ts']`, `pool: 'forks'` because the proxy tests open real sockets and SQLite).
A `createTestHub()` helper mirrors `apps/server/tests/helpers.ts`, and — unlike the server's —
boots a **real listening** backend via `createTestApp()` + `listen({ port: 0 })`, because a TCP
splice cannot be exercised through `app.inject()`.

* `proxy-allowlist.test.ts` — `/h/<id>/api/hooks/foo` is 404 **and the backend is never dialed**
  (asserted on a request counter in the upstream, not merely on the status); the same for the
  encoded and mixed-case variants (`%2f`, `%2e`, `/api/./hooks/x`, `/api/HOOKS/x`), for the
  WebSocket upgrade path, and for `/api/auth/login|logout|hub-bind|me`; `/api/sessions` passes.
* `proxy-headers.test.ts` — upstream sees no `cookie` and no `origin`, sees
  `authorization: Bearer pah_…`, sees a rewritten `host`; a backend `set-cookie` never reaches the
  client; a `POST` body arrives **byte-identical** (sha256 of the received buffer vs the sent
  one); a JSON POST to a sibling Hub route still parses, proving the parser removal stayed
  encapsulated.
* `ws-splice.test.ts` — the ticket's hard constraint #2. A fragmented binary frame and a
  `permessage-deflate` frame both arrive byte-identical; compression is negotiated *end to end*
  (the Hub is not a party to it); a 4001 close and its reason string reach the client unchanged;
  and the Hub's captured log output for the whole exchange contains none of the payload bytes.
* `registry.test.ts` — removing a host 404s the next request *and* destroys its live socket;
  disabling does the same; an unknown id and a disabled id are one indistinguishable response.
* `bind.test.ts` — the master token appears in **no column of any row** (scanned, not assumed);
  the minted token is stored encrypted and `tokenPrefix` matches; a rotated key leaves the row
  listed, `unbound`, and refusing to proxy rather than proxying uncredentialed.
* `health-poll.test.ts` — one dead host delays neither of the others; `negotiateProtocol`'s three
  verdicts surface; a host answering non-JSON is `online: false` with a reason, not a crash.
* `hub-auth.test.ts` — one login reaches two bound hosts with no second prompt (acceptance
  criterion 1); an upstream 401 becomes 502 `host_credential_rejected` and does **not** clear the
  Hub cookie; the Hub's own gate refuses an unauthenticated `/h/<id>/api/sessions`.
* `apps/server` — unchanged and must stay green; that is criterion 6's guard (D20).

**Live demo** — `pnpm demo:hub`, against two scratch backends with throwaway data roots:
a terminal session and a structured session end to end through the proxy including a
reconnect with replay (criterion 2); `/h/<id>/api/hooks/foo` refused from the browser
(criterion 3); one backend killed mid-session showing offline while the other keeps streaming
(criteria 4 and 5); and the same bundle against a bare backend, unchanged (criterion 6).

**Image** — `docker/build.sh hub`, plus a `hub-smoke.mjs` sibling asserting the Hub image's own
`/health` version matches its `POCKETAGENT_BUILD_VERSION` stamp, that the data volume survives
`docker restart`, and that no image layer contains the Hub token.

**Docs, in the same change** — the four now-false statements (finding #10); `.env.example` and
the README's settings table for the new variables; a README "Running a Hub" section carrying D19.
Confluence: **Architecture Overview** (the Hub as a third deployable and the one-origin argument),
**Invariants & Security Model** (the `/api/hooks/` exclusion, the dumb-pipe property, the moved
CSRF boundary), **Installation & Deployment** (the reference TLS deployment), **Development
Guide** (`demo:hub`, the third vitest project). CLAUDE.md's "no front server exists" paragraph is
**PA-71's** by that ticket's own scope note — I will correct the statements of fact that this
change falsifies and link PA-71 for the architecture rewrite, rather than doing both.

## 6. Risks, and what I would cut first

* **The WebSocket splice is the highest-risk item and cannot be half-done.** It is also the one
  place where getting it wrong is invisible in a unit test that only checks a round trip —
  hence the byte-identity and compression assertions rather than "a message arrived".
* **Origin forwarding (finding #1) is the likeliest silent break**: reads work, every write 403s,
  and the symptom looks like a permissions bug rather than a proxy bug.
* **Scope.** This is the largest ticket in the series. If it has to be cut, the honest line is
  after phase 4: the image, the compose file and the reference TLS deployment (scope items 6–7)
  are a coherent second change, and they are the only parts that do not affect the security
  assertions. I would *not* cut D6b — it is what makes the rest testable.
* **D2 is the only edit to `apps/server`.** If you would rather that be zero, say so and the
  primitives get copied instead (question 1); everything else in the plan is unaffected.
* **pnpm `--prod --filter` pruning** may not cleanly exclude the server's native modules; the
  fallback is a larger image, recorded rather than worked around with `pnpm deploy`.

## 7. Questions

1. **D2** — extract `secret-box` and the token/origin helpers into a new `packages/node-kit`
   (a pure move, the only `apps/server` change in this ticket), or copy them into `apps/hub` and
   keep the blast radius at zero? I recommend the move.
2. **D6b** — mount the default host at the bare `/api/*` root as well as at `/h/<id>/`. This is
   an addition to the ticket's routing table, and it is what makes PA-66 shippable and
   demonstrable before PA-67. Confirm?
3. **D14** — `POCKETAGENT_SETTINGS_ENC_KEY` **required** on the Hub, diverging from the server's
   "unset disables the feature, boot anyway". Confirm?
4. **D21** — translate an upstream 401/403 into 502 `host_credential_rejected` rather than passing
   it through, so one revoked credential does not log the operator out of every host. Confirm?
5. **Identity drift (D3)** — I propose recording the backend's `HostInfo.id` and surfacing
   "this base URL is now a different machine" as display-only. Should it instead disable the host
   automatically? I lean no: the common cause is a project folder being added.

Reply "go ahead" (or add `agent-ready` / `approved`) and I will implement it, run
build/typecheck/lint/test plus the new demo and the image smoke, and rebase onto `main` before
committing.
