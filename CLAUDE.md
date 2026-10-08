# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. See [AGENTS.md](file:///data/homes/stoneshi/src/agents-remote-control/AGENTS.md) for guidelines applicable to other agentic coding assistants.

## Commands

```bash
pnpm install            # compiles node-pty and better-sqlite3 from source
pnpm dev                # API on :8787 + Vite on :5173 (use the Vite URL; /api and /health are proxied)
pnpm build              # protocol -> server -> web, in that order
pnpm start              # production: one process serves API, WebSocket, and the built frontend
pnpm lint               # eslint
pnpm typecheck          # tsc --noEmit across all packages
pnpm test               # vitest run
pnpm generate-token     # writes POCKETAGENT_AUTH_TOKEN into .env (mode 600)

docker/build.sh         # images: thin | claude | all (PA-64) | hub (PA-66)
pnpm demo:docker        # the backend image's whole contract, against a real container
pnpm demo:hub           # PA-66's acceptance criteria: two real backends, a real Hub
pnpm demo:hub-ui        # PA-110: the Hub's own UI and mDNS discovery, in real Chrome
pnpm demo:mcp           # PA-118: /mcp as an external agent sees it, against a scratch server

pnpm version:set 1.2.3  # the repo's semver, written to all six package.json files (PA-65, PA-66)
./test.sh               # CI: install --frozen-lockfile, vitest (JUnit XML), lint, typecheck
./build.sh -p           # CI: build every image target; publish only from a release tag
```

**Docker is the deployment mechanism; `git pull && pnpm build` is the dev path** (PA-64).
`docker/Dockerfile` is multi-stage and `docker/build.sh` is the entry point rather than a bare
`docker build`, because it is what reads `docker/agent-versions.env` (one file pins the agent
CLI versions for this repo and for CI) and what stamps `POCKETAGENT_BUILD_VERSION` into *both*
the server and the web bundle — `apps/web/vite.config.ts` cannot fall back to `git rev-parse`
inside a build context that correctly excludes `.git`. Three things about the image are
load-bearing and easy to undo by accident:

- **The runtime image preserves the repo layout under `/app`.** `REPO_ROOT` is
  `resolve(dirname(import.meta.url), '../../../..')`, so `dist/config/` has to sit four levels
  below the root. `pnpm deploy`'s flattened output silently re-points `REPO_ROOT` at `/`,
  taking `.env` loading, the `webDistPath` default and the data-dir default with it.
- **`/etc/profile.d/10-pocketagent-path.sh` is not redundant with `ENV PATH`.** Debian's
  `/etc/profile` overwrites `PATH` unconditionally, and `exec_command` runs `$SHELL -lc`, so
  without it an agent installed into `$HOME` is invisible to exactly the surface most likely to
  look for it. Its order is `agents/registry.ts`'s search order — official agent directories,
  system `PATH`, `~/.cargo/bin`, the npm prefix last (PA-104) — and `agent-install.test.ts`
  fails if `ENV PATH`, the two login-shell snippets and the resolver disagree.
  `docker-smoke.mjs` asserts the login-shell `PATH`.
- **A baked-in agent CLI is an official install under `/opt/pocketagent-agents`, linked into
  `/usr/local/bin` — never anything under `$HOME`** (PA-104). The `claude`/`all` targets run each
  vendor's *official* installer (the same one Settings runs), and every official location is under
  `$HOME`, which is a *mount point* at run time — an install there is hidden by the volume on
  first run, which is how the old npm version of this stage shipped broken once. So each
  installer runs with a build-time `HOME=/opt/pocketagent-agents` (`AGENT_IMAGE_HOME`), keeping
  the official layout under a different home, and its launcher is linked into `/usr/local/bin`.
  Each block ends with checks that fail the build — `test -x`, the `readlink -f` target inside
  the official layout, the pinned version — because `claude --version` passes wherever the
  binary landed. A run-time update writes into the *real* `$HOME`, whose official directories
  precede `/usr/local/bin` for the server and a login shell alike, so both move to it together.
  **Every command in those stages runs under the build-time `HOME`, `--version` checks included,
  and each stage fails the build if anything under `/home/pocketagent` is not the app user's.**
  Docker copies an image directory into an *empty named volume* on first mount, so a root-owned
  file there lands in the operator's home volume: the first cut of the `all` stage ran
  `opencode --version`/`codex --version` as root with the image's `HOME`, shipped root-owned
  `~/.local`, `~/.config`, `~/.codex` and `~/.cache`, and `claude update` from Settings then
  failed on a brand-new test01 deployment. `docker-smoke.mjs` checks every locally built tag.

The entrypoint's own rule: **it never chowns a mounted volume.** It remaps the `pocketagent`
account to `PUID`/`PGID` (so `git` can match the owner of a bind-mounted repo — a uid mismatch
is not just untidy ownership, it makes git refuse the repository), chowns only paths still
part of the image, and otherwise exits 78 naming the `chown` to run on the host. Two defaults
differ from a bare-metal install and are disclosed in the README rather than quietly assumed:
`HOST=0.0.0.0` (loopback in a namespace means unreachable, so the deliberate act moves to
publishing the port) and `NODE_ENV=production`, which makes the auth cookie `Secure` and so
breaks login over plain HTTP until `POCKETAGENT_COOKIE_SECURE=false`.

**A release is a tag, and the tag is the only thing that publishes** (PA-65). The root
`package.json` `version` is the repo's semver and the single source for `/health`, the web
bundle's `__APP_VERSION__` and the image tags; the other five `package.json` files are kept
identical by `pnpm version:set` and a test fails if they drift — numbers allowed to
disagree would mean "the repo's version" depended on which file you opened, which is the
ambiguity the old hardcoded `VERSION = '0.1.0'` created. It also matters across *components*
since PA-66: a Hub and a backend cut from one release report the same string, which is what
lets the version-drift check compare them without knowing which is which. `./build.sh` publishes only when HEAD
carries a tag parsing as `1.2.3` (no `v`), and refuses when that tag disagrees with the
committed version: one of the two is wrong, and guessing publishes an image whose `/health`
contradicts its own tag. A commit with no release tag still builds every target — a broken
Dockerfile should fail on the commit that broke it — and pushes nothing, which is what lets
`:latest` mean "the most recent release" rather than "whatever built last night". **A
prerelease moves nothing**: `1.2.3-rc.1` publishes its own exact tags and never `:1.2` or
`:latest`, because those two are what an operator gets when they have *not* pinned. The tag
matrix lives in `scripts/release-tags.mjs` rather than in bash, because the prerelease rule is
a decision and a decision deserves a test.

Everything CI does is `./test.sh` then `./build.sh -p`, both runnable locally: the Bamboo job
is a checkout, one script task and a JUnit parser, which is the shape every other plan on that
server has, and it keeps the logic in the repo where it can be diffed. Two details are
load-bearing rather than stylistic. `test.sh` runs vitest **first** and collects failures
instead of aborting, because the parser globs `test-reports/*.xml` and a run that died in
`lint` would report "no test results found" instead of naming anything. And the plan's
creation is **manual** — this Bamboo has no plan-creation REST endpoint — so `bamboo-specs.yaml`
is the reviewable definition plus the one-time UI steps, and the webhook URL in it is
deliberately blank: `POST /api/hooks/:slug` is the only unauthenticated route here, so a
committed slug is a published endpoint. `docker/build.sh` has a fourth target, `hub`, which builds
`apps/hub` into a *separate image name* (`pocketagent-hub`) rather than a suffixed tag of
the server's: `pocketagent-server:1.2.3-hub` would be actively misleading to anyone who
pulled it. `scripts/release-tags.mjs` owns that table, so the tag matrix and the build
driver cannot disagree about which image a target publishes.

**`packages/protocol` must be built before anything else works.** It is consumed as
compiled output, not source, so `lint`, `typecheck`, and `test` each run `pnpm protocol`
first — which since PA-66 also builds `packages/node-kit`, the Node-only sibling holding the
security primitives `apps/server` and `apps/hub` share. When editing protocol types, run `pnpm protocol` (or a full `pnpm build`) before you
trust a typecheck in `apps/server` or `apps/web`.

### Running a single test

Vitest is configured with three projects — `server`, `hub` and `web` — from the root
`vitest.config.ts`:

```bash
pnpm exec vitest run apps/server/tests/sessions.test.ts     # one file
pnpm exec vitest run --project server                       # one project
pnpm exec vitest run -t 'detaches on request'               # one test by name
pnpm test:watch
```

Server tests run in `pool: 'forks'` with a 20s timeout: they spawn real PTYs, real tmux
servers, and real SQLite handles, so each file needs its own process. The `hub` project does
the same, for a related reason — its proxy suites bind real sockets, because a TCP splice
cannot be exercised through `app.inject()`. `tmux-backend.test.ts`
and `adopt.test.ts` skip themselves when `tmux` is not installed.

### Live demos

The unit suite cannot cover xterm rendering, a real agent, a real tmux server, or a layout
decision. Twenty-one demo scripts do; all but five run against a *running* server:

```bash
pnpm demo:protocol        # terminal transport over HTTP+WS
pnpm demo:browser         # terminal UI in real Chrome at iPhone viewport
pnpm demo:agent           # structured transport: events, approvals, reconnect mid-approval
pnpm demo:native-ui       # native UI in real Chrome: tool cards, diffs, approval sheet
PA_TOKEN=... pnpm demo:resume-adopt      # resume + tmux attach over the API
PA_TOKEN=... pnpm demo:resume-adopt-ui   # both pickers and confirmations in a browser
PA_TOKEN=... pnpm demo:home-ui           # projects screen and composer, phone viewport
PA_TOKEN=... pnpm demo:resume-history    # resuming a real transcript, with its history
PA_TOKEN=... pnpm demo:desktop-ui        # two-pane shell, and the width/pointer switch
PA_TOKEN=... pnpm demo:copy-ui           # copy-to-clipboard fallback over plain HTTP
PA_TOKEN=... pnpm demo:cron-ui           # scheduled jobs: picker, preview, tree badge
PA_TOKEN=... pnpm demo:webhook-ui        # webhooks: secret panel, signed delivery, filtered row
PA_DEEPSEEK_KEY=... pnpm demo:deepseek-variant   # cross-provider resume: one transcript, two providers
PA_DEEPSEEK_KEY=... pnpm demo:provider-ui        # provider CRUD, picker, disclosure banner, "Continue as…"
pnpm demo:hub             # PA-66: two real backends + a real Hub, started by the script
pnpm demo:provision       # PA-70: templates provisioned onto two real backends, checked on each
pnpm demo:hub-ui          # PA-110: Hub view, server-only/Hub-only menus, real mDNS discovery
PA_TOKEN=... pnpm demo:multi-host-ui     # multi-host: rail, sheet, aggregate home, deep links, both viewports
PA_TOKEN=... pnpm demo:agent-install-ui  # agent setup dialog: four states, streamed install, phone viewport
PA_TOKEN=... PA_GEMINI_KEY=... pnpm demo:gemini-live-ui  # PA-96: real speech → Gemini Live → tool → approval card, phone viewport
pnpm demo:mcp             # PA-118: scratch server + SDK client; PA_MCP_REAL_AGENT=1 / PA_MCP_CLAUDE_CLIENT=1 add real claude
```

The first four read the token from `.env` and default to `:8787`. The rest expect a
*scratch* server (`PA_BASE`) with a throwaway workspace root — they create files, start
agents, and kill tmux servers. **Never point them at the real database.** Until PA-62 that was
structural: the path was always `<checkout>/data/pocketagent.db` and a second checkout was the
only way to get an isolated one. A containerised backend cannot live with that (the checkout is
in the image, the state has to outlive it), so `POCKETAGENT_DATA_DIR` now moves the whole data
root — database, `planner-workspaces/`, `planner-skills/` — and **a scratch server isolates
itself by setting it**, to a throwaway directory outside every workspace root. It is absent by
default, so an existing install is unaffected and the old rule still holds wherever nobody sets
it. Two things replace what the structure used to guarantee: `loadConfig` refuses a data root
*inside* a workspace root (an agent working there can delete the database, which holds webhook
signing secrets and encrypted provider API keys), and every boot logs the data root it opened —
check that line first when a demo behaves as though it has someone else's state.

**Kill a scratch server by pid, never by pattern.** `pkill -f dist/server.js` — or any
pattern of that shape, `node apps/server`, `pnpm start` — matches the full argv of *every*
process this user owns in *every* checkout, including the production unit, whose `ExecStart`
is `node apps/server/dist/server.js`. That is exactly how prod went down on 2026-09-17: an
agent finished a browser verification and ran that pattern to clean up its own server.
Because pkill sends SIGTERM, the graceful shutdown path runs and the process exits 0, so the
journal shows nothing but a clean stop and it does not read as an incident at all. The unit
is `Restart=always`, so it does come back — but every live session is still interrupted and
every unattended run in flight still dies with it. Record the pid instead:

```bash
node apps/server/dist/server.js & SRV=$!
# ...
kill "$SRV"
```

`pnpm demo:hub` needs no running server either, and is where PA-66's acceptance criteria live:
it starts two real backends and a real Hub with throwaway state, binds them through the actual
`hub-bind` handshake, drives a terminal session and a reconnect-with-replay through the splice,
and checks that `/h/<id>/api/hooks/*` is refused, that a dead backend does not affect its
neighbour, and that a backend reached directly with no Hub behaves exactly as before.

`pnpm demo:provision` is the third that starts its own processes, and it is where PA-70's
acceptance criteria live: two real backends plus a Hub, bound through the real handshake, then a
Pocket Agent, a provider and a skill template provisioned onto both — with every result checked
against *each backend's own API* rather than through the Hub, since "the Hub believes it worked"
is what a demo must not accept as evidence. It also reads each backend's stdout, because the
backend's own audit line naming the Hub is a deliverable rather than a side effect.

`pnpm demo:hub-ui` is the fourth, and where PA-110's acceptance criteria live: a real Hub, then
a real backend started with `POCKETAGENT_MDNS_ADVERTISE=true`, driven in Chrome at desktop and
phone viewports — a hostless Hub shows the Hub page with Hub-only menu items, the backend
appears under "On this network" over *real* multicast, "Add…" registers and binds it with the
address prefilled, selecting it shows server-only items, and stopping it removes it via its
goodbye. The backend binds a container-bridge address when the machine has one, so the scratch
server is never LAN-reachable; multicast loopback still carries the advertisement to a Hub on
the same machine. The unit suites run mDNS over an in-memory bus instead, so this is the only
place real multicast is exercised.

`pnpm demo:mcp` is the fifth that starts its own process, and where PA-118's acceptance
criteria live: a scratch backend, a token minted through a real browser-session login, then the
SDK's real clients over real HTTP — both protocol eras (a legacy v1 client and a v2 client
auto-negotiating 2026-07-28, seeing the identical catalog; an unknown revision's `-32022`), the 401s (no token, the master token as a bearer, an MCP token
on the REST API), the scope-filtered catalog, the structured-only and containment refusals, and
revocation ending an open MCP session. Two opt-in steps use real agents:
`PA_MCP_REAL_AGENT=1` runs `run_coding_task` against a real `claude` (with your real `HOME`, so it
can sign in, which files one transcript under the scratch path), and `PA_MCP_CLAUDE_CLIENT=1` has
a real Claude Code call `get_host_info` through `--mcp-config` — PocketAgent as the server end.

`pnpm demo:docker` is the other odd one out: it needs no running server and no `PA_BASE`, because it
builds the image and starts its own container with a throwaway data root, HOME and git
workspace. It is where PA-64's acceptance criteria live — a host-owned file written by a
session, `git` inside the mount, the login-shell `PATH`, state surviving `docker restart`, the
extension example, and that the auth token is in no image layer.

**Rebuild then restart** before running a browser demo against a built server: the server
caches `index.html` at boot, so a fresh bundle on disk is not the one being served, and the
page loads blank with a 404 for the old asset.

## Architecture

PocketAgent runs a normally-installed agent CLI on this machine and drives it from a phone
browser. Two dimensions are independent and are the key to the whole design:

### Transports — how the agent is presented

Chosen per session; both live behind one session abstraction in `sessions/manager.ts`
(`ManagedSession = PtySession | StructuredSession`).

- **`terminal`** (`sessions/pty-session.ts`) — node-pty → xterm.js. Byte-exact CLI
  fidelity, answered with keystrokes. Works for *any* agent, including ones this codebase
  knows nothing about. `terminal/classifier.ts` produces non-binding UI *hints* only; it
  must never answer a prompt.
- **`structured`** (`sessions/structured-session.ts`) — the Claude Agent SDK. The SDK's ~40
  message types are collapsed by `sessions/normalize.ts` into the 11-event union in
  `packages/protocol/src/agent-events.ts`, so SDK shapes never reach the browser. Adding
  agent-side features means work here *and* in the React renderer — that is the price of a
  native feel.

`normalize.ts` is a pure function and returns `[]` for unknown message types; that is where
SDK upgrades should land first.

**A transport is not a provider.** A *custom Claude provider*
(`agents/claude-provider.ts`, PA-19; user-managed since PA-28) is the *same* `claude` binary on
the *same* SDK path, with `ANTHROPIC_BASE_URL` and friends set by `buildCommand`'s `env` — the
swap happens below the CLI. That is what lets a conversation rate-limited on Anthropic be
continued on a third party: Claude Code derives its transcript path from the cwd rather than
from which API it talked to, so `resumeAgentSessionId` + `forkSession: false` appends the new
turns to the same `.jsonl`. It is the only cross-provider continuation the architecture can
offer, because `resumeAgentSessionId` is agent-namespaced everywhere else — hence
`usesClaudeTranscripts` in `packages/protocol/src/session.ts`, the single rule both sides read
(the server to decide who may resume a conversation, the browser to decide who to offer in the
"Continue as…" picker and which finished chats have a transcript to preview). A variant must
never gain a `structuredKind`: routing it to another engine silently breaks the shared
transcript, which is the only reason the feature exists. `AgentAdapter.staticModels` exists for
the same reason in reverse — the CLI reports *Anthropic's* catalog whatever the base URL is, so
for a variant its answer is actively wrong, and the declared list replaces it rather than
merging with it.

**Providers are rows, not env vars, and the registry is dynamic for exactly one thing** (PA-28).
There were two compiled-in variants (`claude-deepseek` / `claude-omniroute`) built from
`POCKETAGENT_DEEPSEEK_*` / `POCKETAGENT_OMNIROUTE_*` into a fully static `AgentRegistry`. They
are now rows in `custom_claude_providers`, created from Settings, and
`agents/custom-providers-store.ts` is what keeps the live registry in step: it hydrates every
row at construction and each mutation writes the row *and* calls
`AgentRegistry.registerCustomProvider` synchronously in the same request, so the very next
`GET /api/agents` reflects it — no restart, no cache-invalidation window. That is the whole
payoff of keeping the change inside `AgentAdapter`/`AgentRegistry` rather than inventing a
parallel UI path: the composer's model row, the "Continue as…" picker and the cron/webhook agent
selectors all pick a new provider up unmodified.

A provider occupies the reserved `custom-claude:` prefix in the *existing* agent id value space
(`CUSTOM_CLAUDE_PROVIDER_ID_PREFIX` and friends in `packages/protocol/src/session.ts`, the exact
`pocket:` pattern PA-10 established and for the same reason). That is what let
`usesClaudeTranscripts` stop being a hardcoded array — a user-created id is minted at runtime and
is not enumerable at compile time — while keeping every existing reader of `agent` unchanged.
`AgentRegistry.list` splices custom providers in immediately *after* `claude`, so PA-19's "read
together in the picker, never before stock claude" ordering survives a provider that arrives
long after boot.

The API key is the first encrypted-at-rest secret here (`crypto/secret-box.ts`, AES-256-GCM,
`base64(iv || tag || ciphertext)`). `POCKETAGENT_SETTINGS_ENC_KEY` unset **disables the feature
rather than failing the boot** — an existing deployment must not stop starting because it has
never generated a key — but set-but-invalid throws, since a typo would silently turn off a
feature the operator thinks they just enabled. There is no reveal route and no reveal action:
unlike a webhook's HMAC secret, which the *sender* must also hold, nothing outside this server
needs to read this key back, so editing a provider re-enters it or leaves the field blank to keep
the stored one. A row that cannot be decrypted is registered with a null key — listed, greyed
out, and logged — rather than skipped, so a rotated key is visible instead of looking like a
provider that vanished.

The old env vars are read exactly once, from raw `process.env` (deliberately *not* through the
`Config` schema — they are no longer configuration), by
`CustomClaudeProviderStore.migrateLegacyEnvProviders`: one row per configured legacy variant, then
a `legacy_claude_providers_migrated` settings flag so it never runs again. Flag-gated rather than
"the table is empty", the same discipline `workspaces_seeded` uses, so deleting the imported
provider does not resurrect it. With no encryption key the import is *deferred* and the flag is
**not** written — consuming the one-shot with nothing to encrypt with would mean it silently never
happens.

### On-demand agent installation (PA-68)

What makes the thin image usable: it ships no agent CLIs, so a freshly bound backend can run
nothing until one is installed. `agents/catalog.ts` declares what may be installed,
`agents/install.ts` does it, `routes/agent-install.ts` exposes it, and the whole id-only posture
is the "browser never supplies an executable or argv" invariant — see the invariants list, which
is where the security reasoning lives rather than here.

**Official installers, official locations (PA-104).** PA-68 installed every agent with
`npm install --prefix ~/.npm-global`, and PA-92 then put that prefix *first* in
`resolveExecutable`. On stone-dev01 that produced two independent sets of CLIs: the server ran the
npm copies, a human's login shell (`~/.opencode/bin:~/.local/bin:…`, no `~/.npm-global/bin` at
all) ran the vendors' official installs, the official copies updated themselves and the npm copy
never did — so a Settings "upgrade" reported success and changed nothing a human at the same shell
could see. Three things replaced that, and each is load-bearing:

- **Resolution follows a login shell, not the service's `PATH`.** `executableSearchDirs`
  (`agents/registry.ts`) is the one search order everything uses — sessions, probes, `available`,
  post-install verification: the official directories (`~/.opencode/bin`, `~/.local/bin`,
  `~/.pi/agent/bin`) first, then `PATH`, then `~/.cargo/bin`, then the install prefix
  (`~/.npm-global/bin` plus the configured `agentInstallPrefix`) **last**, removed from wherever
  `PATH` put it. Official-first rather than `PATH`-first because a systemd `PATH` carries
  `/usr/bin`, where stale system-npm copies live (`/usr/bin/codex` 0.147.0 beside an official
  0.157.0). Prefix-last is "no `~/.npm-global` copy may shadow the official one" stated as an
  ordering: such a copy runs only when nothing else exists, and is otherwise *reported*.
- **Install and update use the vendor's own path.** `agents/catalog.ts` holds, per agent, the
  official installer's fixed `https://` URL, its interpreter, the arguments that read off the
  script itself (claude's `[stable|latest|VERSION]`, codex's `--release`, opencode's `--version`;
  agy's and pi's take none), and how an update works: `claude update`, `agy update`,
  `pi update --self` on the *resolved official binary*, or re-running the installer for codex and
  opencode, whose installers update in place and whose own update subcommands could not be
  verified to run without a terminal. `update` on an agent with no official copy is a fresh
  official install, never an update of a stray one. The installer runs in its own session
  (`detached`) with no controlling terminal — codex's and pi's installers prompt on `/dev/tty`
  when they can open one, and a server started from a terminal would otherwise hand them one to
  wait on — plus `CODEX_NON_INTERACTIVE=1`, under which codex's installer also declines its own
  offer to `npm uninstall` a conflicting copy. `NPM_CONFIG_PREFIX` is unset for every official
  job (the image sets it, and pi's legacy `npm -g` would land in the old prefix). The installer's
  `PATH` is login-like on purpose (`officialInstallerPath`): the prefix removed (opencode's
  installer no-ops when *any* `opencode` on PATH has the version; pi's refuses to pass a pi it
  does not manage), `~/.local/bin` added (pi links into the first candidate directory on PATH),
  and the vendor directories *not* added — found by running the real installer: with
  `~/.opencode/bin` listed, opencode's installer decided the shell was configured and never wrote
  its PATH line.
- **Verification is the rule, not a log line.** After every job the copy that runs must pass
  `isOfficialInstallPath` — a path fragment matched against the *real* path
  (`/.local/share/claude/versions/`, `/.codex/packages/standalone/`, …), so one rule covers
  `$HOME` and the image's build-time home — or the job **fails** naming the copy that runs
  instead. PA-68 only logged that case as a warning; it fired for pi on 2026-09-23 and nobody saw
  it. `GET /api/agents` reports `resolvedPath`, `officialInstall` and `otherCopies` for catalog
  agents (filesystem reads only, the budget `available` already spends; never for the shell or a
  variant, since this list exposes no command line), and the setup dialog can remove an
  `install-prefix` copy with an argv-only `npm uninstall --prefix=<that prefix>` behind a
  confirmation. Any other copy (`/usr/bin/codex`) is report-only. Nothing is ever deleted
  silently. The container image's own baked-in copy is a third kind, `image` (its real path is
  under `AGENT_IMAGE_HOME`): the image layer is read-only, so the first Update in a container
  necessarily writes a second copy into the mounted `$HOME`, which then runs for the server and
  a login shell alike and survives restarts and image pulls. The baked-in copy is a superseded
  baseline, shown as such — the first cut told test01's operator to "remove it on the host",
  which cannot be done to an image layer. Consequence worth knowing: once `$HOME` holds an
  updated copy, pulling a newer image does not change which copy runs; the agents' own
  self-update is what keeps that copy current.
- **An unwritable official location is refused up front, with the fix named**
  (`homeWritabilityProblem`). Before an official install or update runs, the `$HOME`
  directories its catalog entry declares (`homeDirs`) must be writable by this process — a
  missing one judged by its nearest existing parent — or the request is a 409
  `home_not_writable` naming the directory, its owner and the exact `chown`, persisted to the
  row. The installer's own failure is opaque *and partial* (test01's `claude update` downloaded
  2.1.283, then exited 1 unable to create `~/.local/bin`), and the container entrypoint
  deliberately never chowns a mounted volume, so naming the fix is the only honest move. A
  failed job's persisted error also carries the tail of the command's own output
  (`outputTail`): "exited with code 1, see the log above" is useless once the dialog is closed.

**Pins exist only for image builds** (PA-104). Every agent updates itself, so a Settings pin stops
being true within a day of the first run; Settings installs the vendor's current release, and the
npm registry survives only as a *version-number source* for the "update available" hint (these
vendors publish the same numbers there). `docker/agent-versions.env` pins only agents whose
installer accepts a version, and `agent-install.test.ts` fails in both directions if the file and
the catalog's `imagePinVar` disagree. `agy` is installable now — it was excluded only for having
no npm package — and is disclosed as unpinnable, as is pi. The installer script itself is not
hash-pinned: vendors edit them without notice and they fetch "latest" themselves (verifying the
artifact against a checksum from the same release), so the log and the audit line record the
sha256 of what actually ran instead.

(`~/.opencode/bin` was added to the search list in PA-68: opencode's own installer puts the binary
there and nothing else does, so a host with a perfectly working `opencode` reported it missing.)

What was *not* free is that **installed is not authenticated**. `AgentSetupState` has four values,
not the three the ticket asked for, and the fourth is the interesting one. Only some of these CLIs
can be asked non-interactively and cheaply — `claude auth status` answers JSON in ~0.2s,
`codex login status` a line of text in ~0.1s, and `agy` has no such subcommand at all — so
`unknown` is a real answer rather than a gap. Rounding it to `ready` would recreate exactly the
"sees claude ✓, first session fails cryptically" failure the feature exists to prevent, and
rounding it to `signed-out` would nag an operator authenticated through `ANTHROPIC_API_KEY` (a
real third path: opencode reads `HF_TOKEN` the same way), which is also why reading a credential
file is the wrong probe in both directions. `AgentAdapter.authProbe` is therefore *declarative* —
argv plus a pure `interpret` — so the part that actually breaks when a CLI changes its output is
a function a unit test drives with recorded output instead of a real credentialed CLI.

**The probe is cached and never runs on a GET.** `GET /api/agents` recomputes `available`
synchronously on every request and is fetched on mount by six components, so spawning a CLI there
would turn a cheap list into N subprocesses per page load. Results live in `agent_defaults`'s
`last_auth_*` columns beside `last_refresh_*`, refreshed by the existing Settings "Refresh" button
and immediately after an install — so the state half adds **no new routes**, and `deriveSetupState`
is the single place the rule lives, with `available` winning outright (a cached `ready` for a
binary since deleted must read `not-installed`). Deliberately *not* reused: `usage/claude-source.ts`
already makes an authenticated call, but it exists for only three of five agents, conflates a
missing binary with a signed-out one, and `claude -p /usage` is a headless agent invocation that
files a transcript — the whole reason `usage/probe-cwd.ts` exists.

**An install is a job; the SSE stream is only a view of it.** The existing
`streamPlannerEvents` has no heartbeat, no disconnect handling and no abort, which a 30-second
chat turn can afford and a multi-minute install cannot: a phone locking its screen or a proxy
idle timeout would otherwise abort an install halfway through a package tree, or leave it writing
to a dead socket forever. So `AgentInstallService` owns the work, the response subscribes to it,
closing the stream detaches without cancelling, and re-`POST`ing the same id attaches to the
install already in flight and replays its log from `afterSeq` — the same sequence-numbered
`OutputBuffer` a terminal session uses, which already reports its own eviction. This is
`RunExecutor`'s "the drain is the pump, not the sensor" split. `routes/sse.ts` is the one SSE
writer both routes now share; the heartbeat and close handler are opt-in so the planner's stream
keeps its tested behaviour, with `x-accel-buffering: no` the one unconditional change (nginx
buffers proxied responses by default, which defeats SSE for both).

An installer's exit code is necessary but not sufficient, which is the whole verification rule
above; a zero exit into the wrong place is exactly what `docker/Dockerfile`'s own checks exist to
catch, having shipped broken once. `prefixDetectable` now gates only the npm fallback, which no
catalogued agent uses.

Timeouts: the installer is bounded at 10 minutes and one install runs at a time (a second for a
different agent is refused, not queued — `RunQueue` keys on working trees and an install has
none). A subprocess timeout here is *not* a breach of the standing no-decay rule: that rule is
about an approval, which is a decision a human has not made yet, whereas a wedged installer is
nobody's decision and holds the only install slot.

Known limitation: an installer decides where to write its PATH line, not this server. opencode's
writes to `~/.bashrc` for bash, and a stock Ubuntu `.bashrc` returns early for non-interactive
shells, so `bash -lc opencode` misses it while an interactive login finds the same copy the server
runs (the server searches `~/.opencode/bin` regardless). Also: no catalogued agent lets its
official location be chosen, so an agent whose official location is not under `$HOME` would need
a catalog entry of its own shape.

### Process backends — where the process lives

`backends/types.ts` defines `ProcessBackend`/`ProcessHandle`; everything above it (routes,
WebSocket, replay, persistence) is written against a handle.

- **`direct`** — child of this server. Dies with it.
- **`tmux`** — a tmux server on a private socket (`-L pocketagent -f /dev/null`) that
  outlives restarts; sessions are re-adopted on boot from `listRecoverable()`.

Structured sessions bypass backends entirely (the SDK owns the process). What is durable
there is the *conversation*, not the process.

### The two "take over existing work" paths

- `conversations/index.ts` — discovers Claude Code transcripts under
  `~/.claude/projects/<encoded-cwd>/<id>.jsonl`. The directory-name encoding
  (`/` → `-`) is **lossy and must never be inverted**: containment is decided by a
  forward-encoded prefix filter plus the `cwd` recorded *inside* the transcript. Resuming
  defaults to `forkSession: false` so continuing a conversation appends in-place without creating duplicate chats.
  Reading a transcript and resuming it into a session are deliberately separate: tapping a
  finished chat opens `ChatPreviewPage`, which reads history straight off disk via `GET
  /api/conversations/:id/history` — no session, no agent process. `POST /api/sessions` with
  `resumeAgentSessionId` only fires once a prompt is actually sent from there (same
  `setPendingPrompt` handoff `ComposerPage` and `AgentPage`'s own resume-after-finish use).
  Resuming eagerly on tap used to spawn a subprocess per idle look at old history, and made
  that chat's row read as live (see the home screen's merge rule below) before anyone had
  said anything to it.
  **Not every transcript is a conversation.** Any headless `claude -p <something>` files one,
  so `readTranscriptMeta` flags a transcript holding a local slash command with no reply and
  nothing a human typed (`localCommandOnly`) and `list()` skips it — *without* consuming the
  caller's limit, or a directory full of them answers `list(40)` with nothing while every real
  chat sits just past the window. This is the second half of a fix whose first half is
  `usage/probe-cwd.ts`: the rate-limit poller ran `claude -p "/usage"` every five minutes from
  `workspaceRoots[0] ?? process.cwd()`, so it filed 288 transcripts a day *inside a workspace*
  and the project tree grew a project named after that directory, full of chats titled
  `/usage`. The poller now probes from `os.tmpdir()`, which is outside every workspace root by
  construction. Anything else that shells out to an agent must pick its cwd the same way.
- `adopt/index.ts` — attaches to a pane on a *foreign* tmux socket. Off unless
  `POCKETAGENT_ADOPT_TMUX_SOCKET` is set. The browser only ever sends an opaque
  sha256-derived id; the server builds the argv. Adopted sessions always use the direct
  backend, because what we spawn is a tmux *client* and killing it must only ever detach.

### Scheduled jobs

`cron/index.ts` (`CronService`) is one of two things in the server that start agent work with
no human present — see "Inbound webhooks" below for the other, which shares its run pipeline.
A job is a saved spec — directory, agent, worktree policy, model, effort,
prompt, schedule — and a *run* is one firing of it: one prompt, one turn.

The ticker is modelled on `SessionManager`'s sweep timer, deliberately not on a chain of
`setTimeout(nextRunAt - now)`: one long timer is what a laptop suspend or an NTP step breaks
silently. A fixed 30s poll against the clock recovers from both for free, and makes a forward
clock jump indistinguishable from the server having been down — which is why there is one
catch-up policy rather than two. `next_run_at` is materialized on write, so a tick is one
indexed query no matter how many jobs exist, and the UI gets "next run" for free.

**The schedule solver lives in `packages/protocol/src/cron-expr.ts`**, not in the server,
because both sides need the same answer: the server decides when a job fires, and the editor
shows a live "next runs" preview while you type. Duplicating it in `apps/web` guarantees the
preview eventually lies. It is hand-rolled (no npm dep) and only ever converts
instant → wall-clock via `Intl.DateTimeFormat`, never the reverse — the ambiguous direction is
the only genuinely hard part of time zones, and avoiding needing it is what makes a dep-free
implementation correct rather than approximately correct. Consequences worth knowing:
a local time that does not exist (spring forward) simply does not fire that day, and a
repeated hour (fall back) fires once, on the earlier instant. Both are covered in
`cron-schedule.test.ts`, which is where the real risk in this feature lives.

`cron_expr` is the single source of truth and the only thing the scheduler reads.
`preset_json` is a write-only-by-the-UI descriptor of *which picker built it*, kept so the
editor re-opens the picker rather than dumping you into raw cron; every write recompiles the
expression from it, so the two cannot drift, and switching a job to a hand-typed expression
drops the preset because it genuinely is no longer "weekly at 09:00".

A run reaches its transcript through three tiers, in order: `#/s/<sessionId>` while live;
still `#/s/<sessionId>` once finished (`GET /api/sessions/:id/history` resolves via
`SessionManager.resumedConversationId`'s row fallback, **for every agent**); and
`#/c/<agentSessionId>` only once the session row itself has been pruned — which resolves for
`claude` alone, since `ConversationStore` is the one reader that can find a conversation with
no session. So the client rule is "prefer `sessionId`, fall back to `agentSessionId`, else no
link", and no new transcript viewer was needed.

Known limitation: per-run worktrees are **not** garbage-collected. A nightly job leaves a
tree per run under `<project>/.worktrees/`. Deleting them after a run would destroy the very
output the job was scheduled to produce, so the editor says so instead.

### Inbound webhooks

`webhooks/index.ts` (`WebhookService`) is the second thing that starts agent work with no
human present, and the only one whose trigger comes from **outside this machine**. A webhook
is a saved spec — path, type, filter, directory, agent, prompt template, conversation mode —
and a *delivery* is one firing of it.

Downstream of the trigger, a webhook and a cron job are the same thing, so they share
`runs/executor.ts`: **the worktree → session → prompt composite lives there**, extracted from
`CronService` when the second caller appeared. It reports progress through a `RunSink`, so one
implementation writes `cron_runs` and another writes `webhook_deliveries` without the executor
knowing either table exists. The subtle parts of that composite — watch before prompting, one
`onSettled` per run, liveness asked of the session rather than a timer — are why a second copy
was not acceptable.

**`POST /api/hooks/:slug` is the only unauthenticated route in the server**, and everything
unusual about it follows from that. It lives under `/api/` because the not-found handler
answers anything *outside* `/api/` with the SPA shell and a 200, which would make an unknown
slug distinguishable from a known one — a slug enumeration oracle. It has its own flat
namespace rather than sitting under `/api/webhooks/`, because that path also holds management
CRUD and an exemption that has to tell a slug from an `:id` is one bad `startsWith` from
opening `DELETE /api/webhooks/:id` to the internet. `grep '/api/hooks/'` must therefore
enumerate the entire *dynamic* unauthenticated surface, forever — and `PUBLIC_API_PATHS`
(`app.ts`) the entire static one, which PA-63 widened from three entries to four
(`/api/auth/hub-bind`). That guarantee is worth something only while both lists are exhaustive,
so a route added to either is a decision to state here, not a line of code.

`routes/webhook-delivery.ts` is its own Fastify plugin scope for one reason: HMAC has to be
computed over the exact bytes the sender signed, and Fastify's JSON parser hands back an object
whose re-serialization is **not** byte-identical (key order survives `JSON.stringify`, but
whitespace, unicode escaping and number formatting do not). Content-type parsers are
encapsulated per plugin scope, so `removeAllContentTypeParsers()` plus a buffer passthrough
there leaves every sibling plugin — including the webhook management routes that register it —
parsing JSON as before. A test POSTs JSON to a management route from inside the same app to
prove the encapsulation held, and another signs `{"a":1}` and sends `{ "a" : 1 }` expecting a
401: that one fails the moment anyone reintroduces the parser.

The handler order is the security design: look up the slug → verify over the raw buffer →
parse → check the payload's own `timestamp` for freshness → **claim idempotency by inserting
the row** → evaluate the filter → check the caps → run. Nothing answers 5xx once the body has
been read, because Jira Data Center does not retry and a 5xx loses the event permanently.

`webhooks/jira.ts` holds payload extraction and filter evaluation, both pure, for the `jira`
webhook type; `webhooks/bamboo.ts` is the parallel module for `bamboo`, and `webhooks/index.ts`
branches on `hook.type` (`WebhookType` in `packages/protocol/src/webhooks.ts`) to pick between
them. The filter's semantics are OR within a category and AND across categories, with empty
meaning *no constraint* — so an empty filter matches everything, which is the footgun of the
feature and is why the editor warns rather than the code choosing a different default. Every
non-match records a human-readable reason; "why isn't my webhook firing" is the only support
question this feature generates, and that string is the answer.

**The prompt renderer lives in `packages/protocol/src/webhook-template.ts`**, not in the
server, for the same reason `cron-expr.ts` does: the server renders the prompt that runs and the
editor previews it, and duplicating the renderer in `apps/web` guarantees the preview eventually
lies about what the agent will be told. One exported array drives both the substitution and the
editor's variable chips, so a variable existing in one but not the other is impossible.

**Each delivery says what it did, not just which issue it is** (PA-114). A `per-issue`
conversation receives every round of a ticket — triage, approval, review comments — and each
prompt used to open with the same `[KEY] Summary`, so the chat read as one turn repeated.
`describeJiraChange` (same file) turns the payload into one line (`Ada approved`, `Ada: still
broken on 2.1`, `Ada moved To Do → In Review`) exposed as `{{change.headline}}`, and
`promptHeadline` shows it after the key as `[KEY] Summary — Ada approved`, keeping the change
and shortening the summary when space runs out (the chat title already names the issue). Two details are deliberate. It is
**fenced prose**, found by its fence marker, because it carries a display name and comment text
— a bare first line would put Jira text outside the fence. And "approved" is reported only for a
label the approval presets accept: a "go ahead" *comment* stays a comment line, so the
headline never claims an approval the workflow text would judge differently. Saved webhooks
keep their own copy of the template, so an existing webhook shows it only once the preset is
re-selected (or the two-line `Latest activity:` block is added); without it the bar is
unchanged.

**A webhook's agent may be a Pocket Agent, not only a coding agent** (PA-10, reporter: "Today,
webhook can only select code agent, need add 'pocket agent' agents in there too. The Jira tag
should support pocket agent too."). The two halves of that request forced one design decision:
a Pocket Agent occupies the *same* `agent` value space as a coding agent, under the reserved
prefix `pocket:<plannerWorkspaceId>` (`POCKET_AGENT_ID_PREFIX` and friends in
`packages/protocol/src/planner.ts`, so the server and the editor cannot disagree about the
shape). The alternative — an `agentKind` discriminator plus a sibling `plannerWorkspaceId` —
would have added two fields whose either/or invariant no type could express, and every existing
reader of `agent` would have had to learn about it; worse, it could not express the second half
at all, since `resolveLabelOverrides` reads *one string* out of one Jira label. The prefix
contains a `:` precisely because no `AgentRegistry` id can, making a collision impossible
rather than merely unlikely. A Jira label names one by a slug of its display name
(`agent:pocket-release-notes`), because a uuid is untypeable and the label regex stops at the
second separator.

Downstream, a pocket run is a **different composite**, not a relaxed one:
`RunExecutor.startPocketAgent` replaces worktree → session → prompt with chat → watch → prompt,
reporting through the same `RunSink` (plus one optional `onPlannerChat`). There is no
directory to re-validate, no branch to mint, no session, and so no `effort` — the editor hides
the rows that do not apply and `worktreeMode` is saved as `none` rather than persisting a
setting the run ignores. Two subtleties carry the design. First, `sendMessage` is a generator,
so *nothing happens* until its first `next()`; subscribing before that call is the only way to
be sure no event is missed, which is a sharper version of the executor's existing "watch before
prompt" rule. Second, the run is settled by a **chat observer**
(`PlannerChatService.observe`, notified from `emit`), not by draining the generator — a turn
parked on an approval ends its generator while genuinely still running, and when a human
answers in the Pocket Agent UI the continuation streams to *their* browser, so without the
observer the delivery row would sit in `running` forever holding a concurrency slot. Draining
still happens; it is the pump, not the sensor. `webhook_deliveries.planner_chat_id` is the
pocket counterpart of `session_id` (the delivery links to `#/planner/<chatId>`), and
`webhook_issue_sessions.planner_chat_id` is what makes `per-issue` mode work for a chat rather
than a session.

**A `per-issue` conversation belongs to the agent that has been having it** (PA-26, reporter:
"If jira ticket changed tag for agent, webhook should horner that"). `webhook_issue_sessions`
answers "what is this issue already being handled in", and `per-issue` resumes it — but it never
recorded *who* was handling it, so an `agent:<other>` label added after the first delivery was
honoured for the run's spec and then ignored for its conversation: the new agent resumed the old
agent's transcript. That is not merely surprising, it cannot work — an `agentSessionId` is one
agent's own identifier, so handing agy's to codex resumes nothing. The row now carries an
`agent` column and `issueConversationFor` is the single place that decides whether there is a
conversation to continue, used by `startRun` *and* `queueKeyFor` so the directory the run waits
for cannot disagree with the directory it enters. Three details are load-bearing. `NULL` means
*unknown*, not "no agent", so upgrading the server does not abandon every live per-issue
conversation on its next delivery. The comparison is on the **agent only** — a `model:` label is
a mid-conversation model switch sessions already support (PA-17's `model_changed`), and
restarting the chat for it would discard history nobody asked to lose. And a stale row is
*deleted* rather than updated (`deleteWebhookIssueSession`), because `upsertWebhookIssueSession`
COALESCEs `agent_session_id`/`planner_chat_id` and an update would leave the abandoned agent's
ids in the row for the next delivery to resume. The overlap gate is deliberately untouched: it
asks whether work for this subject is *in progress*, which is true regardless of who is doing
it. Both directions are covered — coding→coding in `webhooks.test.ts`, pocket→pocket in
`webhooks-pocket.test.ts`, where the label names a whole other Pocket Agent's tools and
workspace.

One pre-existing bug had to be fixed to make this correct: `blankRow` copies the webhook's
*configured* agent, because the row must exist (it is the idempotency claim) before the filter
has matched — so with `autoSelectAgentModel` on, a label-overridden delivery used to keep
describing the agent that did not run. `recordEffectiveAgent` now corrects it, which matters
far more once the override can cross between a coding agent and a Pocket Agent, since
`agentDisplayName` and the row's transcript link both key off it.

Known limitations, both inherited and made worse: per-delivery worktrees are not
garbage-collected either, and a busy Jira project creates them far faster than a nightly job
does — the editor says so. And `webhook_issue_sessions` is a cache, so a pruned row means the
next event on that issue starts a fresh conversation rather than continuing one — as does an
agent change (PA-26), which drops the row: it holds one conversation per subject, so switching
the label back later starts a third rather than rejoining the first. A pocket run
inherits none of the worktree problem (a planner workspace is app-owned scratch space, reused
rather than multiplied) but does inherit the cache one: a pruned row starts a fresh chat.

### The directory queue (PA-11)

`runs/queue.ts` (`RunQueue`) serializes work that would otherwise share one **working tree**.
Two agents editing one checkout corrupt each other — a hazard `CronOverlapPolicy`'s own doc
comment recorded long before anything enforced it, and one the webhook path hits for real: a
Jira **component** maps to a *fixed* branch (`feature/<component>`), so two different issues in
one component deliberately resolve to the same worktree, and `worktreeMode: 'none'` runs every
delivery straight in the project folder.

It lives in `runs/` beside the executor, and for the same reason: **the directory does not
belong to the webhook.** A cron job, the planner's `send_instruction` and a human typing in a
chat all start work in the same trees, so a queue owned by one trigger could not see the others
— and observing every session is the entire point. Producers register a `QueueStore` (a
`RunSink`-shaped split: `WebhookService` writes `webhook_deliveries`, `PromptQueueService`
writes `session_prompt_queue`, and `RunQueue` never touches a table). One instance is shared;
`WebhookService` happens to construct it and exposes it as `runQueue`.

**The key is the working tree, and it is not a containment test.** `treeRootOf`
(`git/worktree-paths.ts`) rolls a cwd up to its worktree root, so a session in
`<tree>/apps/server` occupies `<tree>` — but a run in `<project>` does *not* block one in
`<project>/.worktrees/x`. Those are separate checkouts, and blocking across them would
serialize the very parallelism worktrees exist to provide. Same tree, or no conflict. Runs that
mint their own directory (`current-branch`, or `new-branch` with a per-run minted name) get **no
key at all** and never queue. `worktreePathFor` is exported and used by both
`WorktreeService.create` and the key computation, because the queue names a directory before it
exists and two copies of that formula would eventually disagree.

**Occupancy is derived, never leased.** A tree is busy because a live structured session rooted
in it is mid-turn (`SessionManager.busyTreeRoots`, from `busySince`), not because a row says so.
Three things follow: a crash cannot strand a lock (after a restart nothing is mid-turn, so every
tree is free); "concludes" means exactly `turn_complete`, so a session that is alive but waiting
for you is *not* a holder — which is the boundary the ticket asked for; and the start-window
grant that `tryAcquire` records is handed back by `RunQueue.started` the moment a session
exists, because a grant that outlived a session killed unnoticed would block the tree with
nothing left to release it. `tryAcquire` is synchronous from check to claim and **must stay
that way** — an `await` between the two hands one tree to two runs.

**There is no timeout, anywhere.** A run parked on an unanswered approval is genuinely still
working, so it keeps its tree and the queue waits indefinitely. That is the standing
no-decay-into-allow rule, not a bug: the answer is that every waiter is visible in the project
tree and individually cancellable. Depth caps (`DEFAULT_MAX_QUEUED_PER_KEY`,
`DEFAULT_MAX_QUEUED_TOTAL`) bound a bulk-edit burst; the pump runs on a session going idle
(`SessionManager.onTreeIdle`) with the existing 30s webhook sweep as the guaranteed backstop, so
a queue can be late but never stuck.

`WebhookDeliveryStatus` gains `queued`, and it is a **third class** of row — in neither
`OPEN_DELIVERY` nor `NOISE_STATUSES`. Every consumer of those two had to be checked: a waiter
holds no session so it must not count against `capReason` (a queue that throttles itself), must
not be force-failed by `markStaleWebhookDeliveriesFailed` at boot, and must never be pruned
(that would discard work already answered 202) — but it *must* be visible to
`hasActiveRunFor`, or a third delivery jumps the line. `queued_spec_json` freezes the fully
resolved run, prompt included, because `storePayloads` may be false and re-resolving later would
re-decide the agent, model and branch. Per-webhook `directoryPolicy` (`queue` | `allow`)
governs the gate, defaulting to `queue` **and backfilled to it for existing webhooks** — a
deliberate behaviour change approved on the ticket, on the grounds that the previous behaviour
was the absence of any check rather than a considered `allow`, and that queueing loses nothing.
It is orthogonal to `overlapPolicy` (which gained `queue` as a third value, webhook-only): that
one is scoped to a webhook's own conversation, this one to a directory anything can be working
in. The gate order is `filter → route → caps → overlap → render → directory → run`.

**A human's own prompt queues too, under stricter rules.** `sessions/prompt-queue.ts`
intercepts `case 'prompt'` in `ws/index.ts`: if a *different* session is mid-turn in the same
tree, the message is persisted, the client is told (`prompt_queued`, replayed on attach beside
`pendingPermissions`), and it goes in when the tree frees. It must never be silent, never be
lost, and always be escapable — `force` sends it anyway and is the **only** override of tree
occupancy in the app, deliberately available only here, where a person is present to own the
consequence. A webhook's "run next" merely reorders waiters. A full queue *sends* a human's
message rather than dropping it: the cap exists to bound a machine-generated burst, and a person
pressing send is not that. An attached image is not persisted — `ws/index.ts` has already
written it into the workspace and named it in the prompt text, and a 7 MB base64 row does not
belong in a database that otherwise holds metadata.

`ProjectInfo.queued` surfaces waiters as a synthetic, collapsible **"Queued"** group in the
project tree, modelled on `ProjectList`'s existing "Deleted worktrees" group rather than on a
`ProjectInfo` — a waiter is not a directory and has no chats. It is filed against the tree that
is actually blocked, so a queue behind a component worktree appears under that worktree's row,
and it vanishes on its own when the array empties. `debounceSeconds` was **removed** in the same
work: it was stored, editable and displayed, and delayed nothing whatsoever (its timer map was
only ever cleared, never populated), and the queue now covers the burst it was meant to smooth.

### Pocket Agent (PA-6)

A second chat surface, in parallel to project chats: **Pocket Agent** (user-facing name;
internal code, tables, and routes are still `planner*` — a full identifier rename was judged
higher-risk than the user-visible-text rename actually requested, and out of scope) talks to a
user-configured OpenAI-compatible LLM endpoint (`apps/server/src/planner/llm-client.ts`) and
calls tools that treat *existing* PocketAgent sessions as sub-agents, rather than owning a
parallel notion of "workspace" or "session" for them. The home screen's **"Pocket Agents"**
section (`components/PocketAgentsSection.tsx`) sits parallel to "Projects": one row per agent
(a planner workspace), its chats nested underneath — read/navigate only, the same split
"Projects" itself draws between browsing chats and managing folders; adding, renaming, or
removing an agent lives on the settings page instead.

**Two registries, not one.** `PlannerWorkspaceRegistry` (`planner/workspaces.ts`) is
deliberately separate from `WorkspaceRegistry`: a project workspace is one of the user's real
code repositories, read-only from this server's point of view; a planner workspace — an
"agent" in the UI — is app-owned scratch space the planner's own file tools may create, write
and delete inside freely, the same ownership `data/pocketagent.db` already has. One `Pocket
Agent` workspace is seeded once at `<dataDir>/planner-workspaces/default/` (the *directory*
keeps its `default` name always; only the *display* name a user sees was renamed — a rename
never touches the directory, see `PlannerWorkspaceRegistry.rename`), guarded by a settings
flag so deliberately removing it does not silently resurrect it on the next boot — the same
discipline `workspaces_seeded` applies to project folders.

**A planner workspace's directory can also be user-chosen, not just app-created.**
`PlannerWorkspaceRegistry.create`'s `opts.path` (wired from `CreatePlannerWorkspaceRequest.path`,
picked via the same host directory browser `AddProject` uses for a project folder —
`PlannerDirectoryPicker`) points an agent at an arbitrary existing directory instead of a fresh
one under the planner workspaces root; `opts.create` allows a not-yet-existing one, mirroring
`WorkspaceRegistry.add`'s own `create` flag. This is a deliberate widening, not an oversight:
picking a path here hands that agent's tools (`write_file`, `exec_command`, `rmdir`, ...) the
*same* full read/write/delete trust an auto-created scratch folder already has, just for a
directory a human chose — logged the same way `POST /api/workspaces/add` logs a project folder
being added. Two agents may never point at the exact same directory (checked at creation) to
avoid two "agents" silently sharing one identity for `PlannerWorkspaceRegistry.contains`.

**Each agent has its own default model and its own tool subset — "real multiple agents," not
just distinct names** (PA-6 round 4, reporter: "current multiple agents design is just name,
actual I need real multiple agents"). `planner_workspaces.default_model_id` seeds a new chat
created in that agent (`PlannerChatService.create` prefers it over the global last-used model);
each chat then keeps its own choice exactly as before, so this only changes what a *fresh* chat
starts with. `planner_agent_disabled_tools` stores only what one agent has *turned off* — the
catalog (`planner/tools.ts`) stays global and every tool defaults to enabled for every agent,
so a tool added to the catalog later reaches every existing agent with no backfill, and an
agent created before this feature existed is unaffected until someone explicitly restricts it.
This is the opposite structure from `planner_tool_approvals` (a record of a *decision made*,
worth keeping even for a deleted workspace) — a disabled-tool row is pure current configuration
of an agent that, once gone, makes the row meaningless, so it `ON DELETE CASCADE`s where
`planner_tool_approvals.workspace_id` deliberately has no FK at all. Enforced in two places, not
one: `driveLoop` excludes a disabled tool from the `tools` array sent to the model at all, and
`processToolCalls`/`resolveApproval` separately refuse to *execute* one even if a call for it
still arrives (a stale conversation from before it was disabled, a model that names it anyway)
— the same "the model choosing to call something is not this server's decision to trust
unchecked" posture `exec_command`'s own input validation already takes. A disabled tool's
refusal (`Tool "x" is disabled for this agent.`) is deliberately worded differently from an
unknown tool's (`Unknown tool: x`), so the transcript never conflates "doesn't exist" with
"exists but restricted."

**An existing agent's directory can be changed, not just chosen at creation** (PA-6 round 5:
"it lacks a way to change existing agent workspace directory"). `PlannerWorkspaceRegistry.setPath`
shares its validation with `create`'s own `opts.path` branch (must exist unless `create` is set,
must be a directory, must not collide with another agent's) via a private
`resolveWorkspaceDirectory` helper. It deliberately moves nothing on disk: a chat's transcript
lives at `<path at the time>/.transcripts/<chatId>.jsonl`, and `workspacePathFor` reads the row's
`path` fresh on every turn, so the moment this returns, every existing chat in that agent starts
reading and writing under the *new* directory — whatever transcripts sat under the old one are
still there, just no longer reachable through this agent. The editor discloses this before
calling it, the same "explicit action, and it's logged" posture pointing a path at creation
already has.

**Tool enablement is two independent layers, not one** (PA-6 round 5: "in global setting, add
section called 'tools' ... you can disable or enable globally," on top of round 4's per-agent
subset). `planner_global_disabled_tools` is a flat table (no `workspace_id` at all) — deliberately
*not* folded into `planner_agent_disabled_tools` with a nullable scope the way
`planner_tool_approvals.scope` does, because there is no per-row scope ambiguity to resolve here:
a tool is either off for everyone or it isn't. `PlannerChatService.toolsFor` excludes a tool if
*either* layer disables it, and the global layer applies even to an orphaned chat with
`workspaceId: null` (a global switch has no agent identity to be scoped by, unlike the per-agent
layer, which such a chat has none left to be restricted by). `PlannerAgentToolInfo.enabled` is
therefore the *effective* state (global AND per-agent); `disabledGlobally` lets the agent editor
grey out a checkbox that would otherwise silently do nothing while the tool is off globally.
`toolUnavailableMessage` distinguishes all three refusal reasons in the transcript text itself
("Unknown tool," "disabled globally," "disabled for this agent") so none of the three ever reads
as one of the others.

**Editing an agent is its own page, not an inline row** (PA-6 round 5: "once user click edit, it
will open a new page of agent configure"). `PlannerAgentEditorPage` follows the exact
`CronJobEditorPage`/`WebhookEditorPage` prop contract (`agentId`, `onApiError`, `onDone`, optional
`onBack`) and route pattern: `{ name: 'planner-agent'; agentId: string }` in `useHashRoute.ts`'s
`Route` union, parsed from `#/planner/agent/:id` — checked *before* the existing `planner-chat`
regex (`#/planner/:chatId`) in `parse()`, the same "detail route before the generic one" ordering
`cronJob`/`webhook` already establish, since both planner detail routes share the `#/planner/`
prefix and a chat id could otherwise swallow the literal segment `agent`. `PlannerPage`'s own
Agents list stays a plain list — name, path, Edit (opens the editor), Delete (a `ConfirmDialog`,
never the underlying directory or that agent's chats) — creating a new agent is still its own
quick inline form there, since naming one and picking a scratch directory needs no dedicated page.
Every field in the editor auto-saves on change except the directory, which is the one field here
with a real, easy-to-miss consequence (see `PlannerWorkspaceRegistry.setPath` above) and so pauses
on its own `ConfirmDialog` before applying.

**A chat auto-titles itself from its first prompt, and a user can always override it** (PA-6
round 6: "all chat currently is 'untitled chat', after first prompt, agent should find a suitable
name"). `PlannerChatService.sendMessage` checks `chat.title === null` before persisting anything
else, so this fires at most once per chat and only on whichever message first has usable text —
an all-whitespace prompt leaves `title` `null` and it tries again next time.
`deriveChatTitle` (`planner/chats.ts`) is a "first non-empty line, truncated to 80 characters"
heuristic, deliberately mirroring rather than reusing `conversations/index.ts`'s own
`fallbackTitle` for a coding-agent session with no external title-generating process: that
function's Jira-webhook-specific parsing (extracting `[KEY] Summary`, stripping an untrusted
fence's preamble) doesn't apply to a prompt a human typed directly into a chat, and importing it
anyway would leave a Pocket Agent chat's title deriver carrying logic a future reader would have
to puzzle out the relevance of. No LLM call — the title needs to exist before the turn's own LLM
call even starts, and a chat with a bad auto-title is one edit away from a better one.
`PlannerChatPage`'s header has an edit icon next to the title (new `edit` `IconName` — a bare
pencil, distinct from `compose`'s square-plus-pencil "write something new" glyph, which reads
wrong next to a title that already has text) that swaps it for an input; saving with an empty
value clears the title back to `null` rather than being rejected, the same "empty string means
unset" convention this app's other nullable-text settings use, and it's the deliberate way back
out of a bad auto-generated title without having to type a replacement. No new server route or
protocol type was needed for this half — `rename` (`PlannerChatService.rename`) and `PATCH
/api/planner/chats/:id` already existed and worked; only the frontend needed the affordance.

**A chat's transcript is the same `AgentEvent` union a structured session's own event stream
uses** (`packages/protocol/src/agent-events.ts`), not a parallel shape — reused directly so a
reopened Pocket Agent chat replays through the exact same `applyEvents` reducer the frontend
already has for a resumed structured session, rendering tool calls as real, expandable
`ToolCard`s. Persisted as JSONL on disk under `<workspace>/.transcripts/<chatId>.jsonl` — the
same "transcript is a file, the database only indexes it" split `conversations/index.ts`
already uses for Claude Code's own transcripts, with no `planner_messages` table. Every event a
turn produces — the user's message, each tool call and its result, permission events, the
final reply — is persisted in order, unlike the design's first cut, which kept only the user
message and final reply and discarded the tool trace; the fix (still tracked under PA-6)
followed a review round asking for exactly that visibility.

**The tool catalog** (`planner/tools.ts`) splits into read-only (`list_workspaces`,
`list_sessions`, `read_session_output`, `read_file`, `list_dir` — exempt from approval entirely) and
mutating (`send_instruction`, `write_file`, `edit_file`, `mkdir`, `rmdir`, `delete_worktree`,
`exec_command` — gated, see the invariants list). Every tool that touches a path resolves it
through the same realpath-then-containment check `workspaces/index.ts` already established,
extended to accept either a project workspace root or a planner workspace root.
`send_instruction` sends directly into a live session or resumes a stopped one exactly the
way `RunExecutor` does for cron/webhooks, including re-validating the session's `cwd` at call
time rather than trusting a cached value. `delete_worktree` calls the same `WorktreeService`
the UI's own worktree-delete flow uses, not a second implementation.

**PA-56 adds settings access**: `read_settings` (read-only) and five mutating tools —
`update_settings`, `update_webhook`, `update_cron_job`, `update_custom_claude_provider`,
`update_telegram_bot` — so a chat can act on a request like "change the Jira webhook's project
map" without a human opening the Settings page. Scoped deliberately to read + update: create/
delete of any of these resources is out of scope, decided on the ticket itself rather than
assumed. Each mutating tool runs through the *same* validation its own HTTP route does — never a
second copy — via a validator factored out of the route module itself
(`resolveWebhookUpdatePatch` in `routes/webhooks.ts`, `resolveCronJobUpdatePatch` in
`routes/cron.ts`; the provider/bot routes had no extra route-level validation to factor out, so
their tools call `CustomClaudeProviderStore.update`/`TelegramBotStore.update` directly after the
same Zod schema the route uses). Two things are refused unconditionally, not merely left off a
parameter list: `update_settings` explicitly rejects a patch naming `skipPermissionsEnabled` —
the global switch is not one of the four documented overrides of the "never default to skipping
approval" invariant and PA-56 deliberately did not make it a fifth, on the reporter's own answer
("not available to this tool, user must flip the switch") — and `update_custom_claude_provider`/
`update_telegram_bot` refuse a patch naming `apiKey`/`botToken` outright, so a turn can never make
a plaintext secret part of this chat's own persisted transcript; the JSON-schema `parameters`
sent to the model don't even list those fields, and the runtime check is the belt-and-suspenders
half. `read_settings` reuses `buildRuntimeSettingsSnapshot` (`settings/index.ts`) for the general
section and each store's own already-redacted `list()` for the rest, so nothing here can leak a
webhook secret, a provider API key, or a Telegram bot token — none of those are ever returned by
any route either, by the invariants list. `PlannerToolDeps.webhooks`/`.cron` are the one pair of
dependencies here threaded in *after* construction (`PlannerChatService.attachRunServices`,
called once from `app.ts`) rather than through the constructor, because `app.ts` builds `cron`/
`webhooks` after `plannerChats` (each of them needs `plannerChats` itself, to drive a Pocket
Agent run) — passing them the other way at construction time would be a genuine cycle.

**A skill crosses into a project only when a human exports it** (PA-55). PA-38 gave Pocket
Agent its own skills (`planner/skills.ts`), and round 2 added a one-way *import* from a project's
`.claude/skills/` or `.agents/skills/`. `POST /api/planner/skills/:id/export`
(`SkillRegistryService.exportToProject`) is the reverse direction. It copies one catalog skill,
global or one agent's own, into a project so a `claude`/`codex` session there can load it. Both
directions read one table, `SKILL_PROJECT_DIRS` (`packages/protocol/src/planner.ts`), so they
cannot disagree about where a coding agent looks. The user picks the target directories for each
export, and both are on by default. This is the first structured path from Pocket Agent scratch
space into a tree a coding agent treats as *source*, so its rules are about writing nothing else:
- The skill is named by id and re-checked against the trusted roots, as `loadSkillBody` does.
- The destination goes through `resolveWorkspacePath`, and a planner workspace is refused even
  when it sits inside a project folder.
- `.claude/skills` is realpath'd after it exists and must still be inside the project, because a
  `.claude` symlink out of the repository passes the containment check on the project path.
- Only regular files and directories are copied (each file opened `O_NOFOLLOW`). A symlink in
  the skill's folder is refused, never followed, and the copy is capped at 1 MiB / 200 files.
- Every target is checked before anything is written. A collision is a 409 with nothing written,
  and a confirmed overwrite is built in a sibling temp directory and swapped in by `rename`.
- Nothing touches git: the files are untracked changes, and the dialog says so.

**The approval gate needed no new rule, and that is the design rather than an omission.**
There is no `export_skill` planner tool and no `/mcp` tool. The click is the decision, and a
model that wants a skill in a project still has to use `write_file`, gated as ever. A test pins
that neither catalog grows one. The export is not routed through `RunQueue` (a few files a
person chose to write), but a mid-turn session in that tree is reported (`busy`) rather than
hidden. Known limitation: an export is a copy that then diverges, like a PA-70 template, so later
edits to the Pocket Agent's copy are not synced.

**A turn is streamed at both levels, not request/response.** `PlannerChatService.sendMessage`/
`resolveApproval` (`planner/chats.ts`) are async generators that `yield` one `AgentEvent` at a
time as each step of the turn happens; `routes/planner.ts`'s `streamPlannerEvents` drains one
onto the HTTP response as `text/event-stream` frames, and the browser reads it via `fetch` + a
manual `ReadableStream` reader (`api/client.ts`'s `streamPlannerEvents`) rather than
`EventSource`, since sending a message needs a POST body. The upstream LLM call itself is also
streamed (`llm-client.ts`'s `streamComplete`, `stream: true`): it parses the upstream provider's
own OpenAI-compatible SSE format and re-yields each content delta as a `text_delta` `AgentEvent`,
so the final reply fills in token-by-token the same way a structured session's own turn does — a
tool call's bar, by contrast, still only appears once the whole call is known, since a partial
tool call is not executable. `text_delta` is deliberately never persisted (`driveLoop` yields it
directly, bypassing the `emit()` helper that every other event goes through) — only the fully
assembled `text` event survives to the transcript, the same "deltas are transport, not history"
split a structured session's own JSONL transcript already relies on, so reopening a chat replays
the finished reply as one block rather than re-streaming it. Both service methods validate
synchronously *before* their first `yield` (chat exists, an approval id is still pending, an
LLM endpoint is configured), so a precondition failure can still answer a normal HTTP error
status; past that point the service never throws again — an in-flight failure (e.g. the LLM
endpoint erroring) becomes an in-band `text`/`turn_complete(isError: true)` event instead,
because headers are already committed by then and there is no status left to change.

**`turn_complete`'s stats are LLM time only.** `finishTurn` populates `durationMs`/
`inputTokens`/`outputTokens`/`completedAt` (the last one new, and optional on the shared
`TurnCompleteEvent` — a structured session's own `normalize.ts` doesn't set it) so the same
`TurnFooter` a structured session's turn already renders through also shows Pocket Agent's
tokens/sec, token totals, and a local-timezone timestamp with zero new frontend code.
`PlannerTurnStats` (`planner/chats.ts`) threads a running total across every LLM round trip a
tool-calling turn makes — and across an approval pause, via `PendingPlannerTurn.stats` — but
`elapsedMs` only ever accumulates time spent actually waiting on `streamComplete`, never tool
execution and never a human's approval-pause time; the latter is arbitrary and would make
tokens/sec meaningless. Token counts come from `stream_options.include_usage: true`, sent on
every request; not every OpenAI-compatible implementation honors it, so `usage` — and therefore
the rendered token/tps bits — is `null` rather than a fabricated zero when a provider never
reports one.

**The approval gate is a pause, not a block.** See the invariants list for the full mechanics
(`planner/approval.ts`); the short version is that a mutating tool call with no remembered
decision emits a `permission_request` event and ends that leg of the stream rather than
holding the connection open, and a second request (`POST .../approvals/:id`, itself another
streamed response) resumes it. The pause card in the UI is a deliberately plain stand-in for
the real `ApprovalSheet` — driven by the same `TranscriptState.pending` the real sheet reads,
just with its own four choices (once / remember for this workspace / remember globally / deny)
instead of `ApprovalSheet`'s two, since the shared `PermissionDecision` type has no
workspace/global concept of its own.

### The Pocket Agent loop: context budget, compaction, tool hygiene (PA-121)

The loop was compared against pi's (`earendil-works/pi`), and the gaps closed here were all
silent failures: a long chat overflowed the model's window and then failed every turn, a
malformed tool call ran with `{}`, a dead stream held the turn forever, a backgrounded process
hung `bash` past its timeout. Steering while busy, prompt caching, cost tracking and image
budgeting were deliberately left for PA-122 (below).

**Context is a token budget, not 20 turns.** Each `planner_models` row may set
`context_window`/`max_output_tokens`; unset falls back to `KNOWN_MODEL_WINDOWS`
(`planner/context-budget.ts`, matched on the id without its `provider/` prefix) and then to
128k / 16k. A request is estimated at chars÷4 plus a flat 1 200 tokens per image (a base64
data URL is not billed by its length), and `TokenCalibration` scales that per chat by the
provider's own `prompt_tokens` for the previous request — a ratio, clamped to [0.5, 4], so it
survives compaction and restarts degrade it to 1 rather than to a wrong figure. `max_tokens` is
sent **only** for a row that sets an output limit, because several OpenAI-compatible servers
reject the field.

**Compaction appends; it never rewrites.** Past `contextWindow − compactionReserveTokens`
(default 16 384), `compactChat` summarizes the older part with the chat's own model (the
reporter's choice: no separate compaction model) into pi's structured format, and appends a
`context_compaction` event. `projectContext` (`planner/compaction.ts`) is the single rule for
what a turn sends: the latest summary, then the events from its `firstKeptEventId` on. So the UI
still replays everything, and a bad summary costs a worse next turn, never lost history. Three
rules carry it. A cut never separates a `tool_use` from its result (providers reject an orphan
`tool` message), so it lands only on a prompt, a text, or the first call of a batch. A later
compaction is handed the previous summary to *update*, so what was learned before the first one
survives the second. And a summary that stopped at `length`, called a tool or came back empty is
rejected, with nothing recorded — a partial summary would silently replace history with less
than it claims. `keepRecentTokens` is capped at half the threshold so a small model is actually
shrunk. An overflow error from the provider compacts keeping as little as `/compact` does — the
estimate was wrong by definition — and retries that round trip **once**. `/compact [focus]` is
a web slash command, a Telegram one, and `POST /api/planner/chats/:id/compact`. With compaction
switched off the PA-29 20-turn window and its memory fold still apply; with it on, the summary
(capped) is what is saved to memory instead. `context_compaction` is in the `AgentEvent` union
but is planner-only — no structured session emits it, so it never reaches a WebSocket frame and
needed no `PROTOCOL_VERSION` bump.

**One system message, and it now always exists.** `buildSystemMessage` is
`basePlannerSystemPrompt` (where the agent runs, its workspace directory, that tool output is
data, a denied call is not retried unchanged) then the persona sections then the ranked
memories. It used to be up to two system messages, and none at all for an unconfigured agent.

**A tool call is validated before the gate, and refused before a human is asked.**
`prepareToolArguments` (`planner/tool-args.ts`) parses the arguments and checks them against
the tool's own `parameters`, coercing the usual model mistakes (`"5"`, `"true"`, an array sent
as a JSON string) and dropping unknown keys, and otherwise answers with the field and what was
received. Invalid JSON is kept in `tool_use.input` under `_invalidArguments` so the next round
trip shows the model what it sent. A tool may declare `prepareArguments` for shapes known to be
unambiguous but wrong (`edit_file`'s). A reply that ended `finish_reason: length` with tool calls
in it runs none of them — streamed JSON cut short can still parse. Narration written before a
tool call is persisted as `text` with `interim: true` and replayed in the same assistant message;
Telegram, MCP's `lastTurnText` and subagent summaries skip interim text, so they still relay only
the answer. An error result reaches the model as `Error: …`, a `tool_use` with no recorded result
(an approval lost to a restart) says so instead of replaying `''`, and `capToolOutput` keeps both
ends of anything over 50 000 characters.

**The LLM client retries, and gives up on a silent stream.** `PlannerLlmClient.streamComplete`
retries 408/409/429/5xx, network errors and an empty or idle stream up to 3 times (2 s doubling,
jittered, `retry-after(-ms)` honoured up to 60 s), but **only an attempt that streamed nothing**
— a retry after a delta would show the user the same text twice. Quota errors and overflows are
never retried (`planner/llm-errors.ts` classifies them from the body, since providers report
either with a 429 or a 400). Each retry is an `info` notice, which Telegram ignores and
`eventsToLlmMessages` drops. `llmIdleTimeoutSeconds` (default 300, 0 = off) bounds a wedged
connection — nobody's decision, not a timeout on an approval. An LLM failure is now an `error`
notice rather than assistant text, so it is no longer replayed to the model as something it said.
The Settings "Test" button does not retry.

**`bash` settles on exit and kills its process group.** stdin is `/dev/null` (a command
reading it used to wait out the timeout); the shell is `detached` so a timeout or an interrupt —
the turn's `AbortSignal` now reaches tools as `PlannerToolDeps.signal` — kills the whole group,
not just the shell; and the call settles on `exit` plus 100 ms of quiet rather than on `close`,
which waited for any background process still holding the pipes. A deliberately backgrounded
process is left running. Output keeps the *tail* (2 000 lines / 50 KB) with the full output saved
mode 0600 under the chat's workspace `.tool-output/` (pruned after a day), which `read_file` can
open; a non-zero exit is `isError`. `-l` stays, for the PATH reasons above.

**File tools.** `read_file` pages (`offset`/`limit`, 2 000 lines / 50 KB a page, with the offset
to continue from) and refuses binary files. `edit_file` (mutating, gated) replaces `oldText`s that
must each occur exactly once, all matched against the original, overlaps refused; a tolerant
match (trailing whitespace, typographic quotes and dashes) rewrites only the lines it touches and
only trusts a mid-line position where normalization kept the line's length. CRLF and a BOM
survive. The web renders `edit_file`/`write_file` input as a diff, on the card and in the approval
sheet. `list_dir` is new and read-only. `grep_files`/`find_files` use ripgrep/fd when they are on
`PATH` (`.gitignore`-aware) and grep/find otherwise. A batch of two or more calls that are all in
`PARALLEL_SAFE_TOOLS` runs concurrently with results persisted in the model's order; any batch with
anything else in it is sequential exactly as before, so the approval pause is untouched.

### The Pocket Agent loop, continued: steering, caching, cost, images (PA-122)

**A message sent mid-turn is queued, not refused.** `POST /api/planner/chats/:id/queue` writes a
`planner_prompt_queue` row, and the message is delivered at the next safe point: after the
running turn's current tool batch (`deliverQueuedPrompts`, called only where `processToolCalls`
hands back to `driveLoop`, so it can never land between a `tool_use` and its result), or — if
the model finishes first — as the next turn. It is the human-prompt queue's rules again: never
silent (every change is a `prompt_queue` snapshot to observers, never persisted), never lost (a
row, so a forced restart delivers it at boot via `resumeQueuedPrompts`), always cancellable
(`DELETE …/queue/:promptId`). `POST …/messages` **still answers 409** for a busy chat: cron,
webhooks and MCP rely on that, and steering is for the person at the chat — the web page and
Telegram queue, nothing unattended does. Queueing while a turn is parked on an approval is
allowed and answers nothing; the message waits behind the approval. Interrupt keeps the queue
(it becomes the next turn); `/clear` and deleting the chat discard it.

`drainNext` is the one "the chat just went idle" step every path calls, and its order is the
design: the person's queue first, then the subagent mailbox, which is still delivered only at
idle (a wake turn is never steered into). A steer that lands in a *wake* turn makes it the
person's — `activeWakeTurns` cleared, a human's spawn budget restored. `busyWithPlannerLoop`
counts a queued message as planner work, so Gemini Live cannot take the chat in the instant
before the follow-up starts; while live, typed text goes to Gemini and the queue route refuses.
`queueDrainInProgress` is load-bearing: a follow-up that fails its preconditions would otherwise
restart itself synchronously from its own `finally`. Such a queue is marked stalled and left
visible rather than retried; a new message, a cancel or the next turn clears it. Telegram keeps
one relay per chat until `whenIdle` fires, rather than one per turn, or the follow-up's reply
would reach nobody — and one, so a steer and its turn are not forwarded twice.

**Prompt caching** (`prompt-cache.ts`). `parseUsage` reads the cache from every usage shape —
`prompt_tokens_details.cached_tokens`, Anthropic-style `cache_read_input_tokens` /
`cache_creation_input_tokens` (normalised when a proxy left them out of `prompt_tokens`), and a
reported `usage.cost` — so the footer's "(N cached)" works for OpenAI and DeepSeek with no
markers at all. Markers are per model (`planner_models.prompt_caching`, null = on for Claude
ids), because a strict OpenAI-compatible server 400s on `cache_control`; a refusal is one
notice and the turn continues unmarked. Three breakpoints: the *stable* part of the system
message, the last tool, the last user/tool message. The ranked memories sit after the first
breakpoint because they change per turn, and are ranked once per turn (`turnMemories`) so the
system message is stable across a tool loop.

**Cost** (`cost.ts`). Optional per-model prices, USD per million tokens; a provider-reported
cost wins. `costUsd` is **null, never 0**, when the model has no input/output price or any
round trip of the turn reported no usage — an understated figure would read as a fact. The
prices are an operator's numbers, not a bill, the same caveat a custom Claude provider carries
the other way. They travel with exports and the Hub's `planner-endpoint` template, which now
carries every optional model field (`PlannerModelOptionalFields`) instead of id and label only.

**Images** (`image-budget.ts`, both sides). The browser downscales an attachment to at most
2000×2000 and ~4.5 MB of base64 (`apps/web/src/agent/image-budget.ts`) rather than refusing
photos over 5 MB — on the client because the server has no image library and `sharp` would be
a third native dependency. The server applies, to the *built messages* so the transcript keeps
every image: a text-only model (`plannerModelSupportsImages`, in the protocol package so the
composer can warn first) gets a one-line note per image; only the newest four images are
re-sent; one whose header will not parse or is over 8000 px is left out with a note rather
than failing the request. Unknown models are assumed to see images, as before.

### Telegram channel (PA-53)

Telegram is a second front end onto `PlannerChatService`, built entirely by reusing patterns
that already existed for other triggers rather than inventing parallel ones —
`apps/server/src/telegram/` holds all of it, alongside `routes/telegram.ts` and
`packages/protocol/src/telegram.ts`.

**A bot is a secret-backed row, exactly like a custom Claude provider.** `TelegramBotStore`
(`telegram/bots-store.ts`) is `CustomClaudeProviderStore`'s shape with the `AgentRegistry`
wiring removed: the token is encrypted at rest with the same `crypto/secret-box.ts` primitive,
there is no reveal endpoint (editing leaves the token blank to keep the stored one), and a row
that cannot be decrypted degrades to `revealToken() => null` rather than throwing, so one bad
key cannot take the whole poller down. Unlike a provider, a bot is not pushed into a live
registry on mutation — nothing selects a bot the way an agent id is selected — so
`TelegramPollerService` simply re-lists enabled bots on its own fixed reconcile tick instead of
needing a push-on-mutation callback.

**A pairing (`telegram_links`) is `webhook_issue_sessions` transplanted**: a cache, not
history, of which Pocket Agent chat one Telegram chat id is talking to, keyed on
`(bot_id, telegram_chat_id)` and `ON DELETE CASCADE` from its bot for the same "a row here
outliving its bot is meaningless" reason that table CASCADEs from its webhook.
`workspace_id` is `SET NULL` rather than CASCADE, so deleting the Pocket Agent a pairing points
at surfaces as a repairable orphan instead of silently deleting the pairing — the same
distinction `planner_chats.workspace_id` already draws. `TelegramLinksStore` splits "patch one
field on an existing pairing" into dedicated methods (`setPlannerChatId`, `touchLabel`) rather
than one generic upsert, because `skip_tool_approvals` is a `NOT NULL` boolean with no
representable "leave unspecified" value the way a nullable `TEXT` column's
`COALESCE(excluded.x, table.x)` upsert idiom gets for free — a single upsert that only
sometimes received that field could not tell "explicitly false" from "not provided" once it had
already been converted to `0`/`1` for binding.

**Transport is long-polling, not an inbound webhook** (`telegram/poller.ts`,
`TelegramPollerService`), because this app's own default posture is loopback-bind and
"exposing this is a deliberate act" — a Telegram webhook would require a public HTTPS URL,
which support for a chat bot should not force on every installer just to work behind a NAT or
Tailscale. Shaped like `CronService`: `init()`/`stop()` wired into `app.ts` next to
`cron`/`webhooks`, but one self-rescheduling long-poll loop *per enabled bot* rather than a
shared fixed tick, since a real `getUpdates` call itself blocks server-side for up to
`LONG_POLL_TIMEOUT_SECONDS`. Every network call this service makes is outbound.

**`TelegramBridge` drives a chat turn exactly the way `RunExecutor.startPocketAgent` already
does for a webhook's Pocket Agent runs**: resolve-or-create the chat, `observe()` before
prompting (a turn that pauses for approval ends its generator while genuinely still running —
missing this would silently drop the pause), await the turn's first `next()` synchronously so a
precondition failure becomes an immediate reply rather than a background rejection, then drain
the rest in the background. An unpaired chat id gets a fixed refusal and touches nothing — no
chat, no LLM call — so an unauthorized id can never spend a token.

**There is no server-side slash-command mechanism for Pocket Agent chats to reuse.** The web
UI's `/clear`, `/context`, `/mcp` (`PlannerChatPage.tsx`) are intercepted entirely client-side
and call REST endpoints directly; none of that reaches the server as a chat message. Telegram
has no client-side JS, so `telegram/slash-commands.ts` + `TelegramBridge.runSlashCommand`
re-implement the same three commands server-side, directly against `PlannerChatService`/
`McpRegistryService` — a second, independent implementation of the same semantics, since the
two surfaces share no transport to unify over.

**Approval relay, not a bypass, is the default** — the one place this feature adds a genuinely
new decision rather than reusing an old one; see the sixth invariant override below.

`send_telegram_message` (`planner/tools.ts`) is the one tool that reaches a human directly
rather than another PocketAgent subsystem or a third-party API. It is `readOnly: false` even
though `web_search`/`url_fetch` (also outbound HTTP) are not, because a message landing in a
stranger's Telegram client is exactly the consequential action the approval gate exists for —
gated like `send_instruction`/`exec_command`, unconditionally, even from a chat whose own
inbound messages are approval-exempt (`skipToolApprovals`): "this chat may talk to the agent"
and "this agent may message anyone" are different grants. It can only address an id already
present in `telegram_links` — never an arbitrary id typed into the argument — the same posture
`exec_command`'s own input validation takes.

`list_telegram_links` (read-only, exempt from the gate) is what a turn calls first to learn
which ids exist — added after a live bug report: the first cut of `send_telegram_message`'s own
description pointed the model at `list_workspaces` to "discover" a paired id, which has nothing
to do with Telegram at all, and the model dutifully called it, found nothing relevant, and gave
up rather than ever attempting `send_telegram_message` itself (whose own refusal message would
have listed every paired id). A tool-description bug like that cannot be caught by a unit test
that only exercises `execute()` with a known-good id; the fix is a real tool for the model to
call, not a better sentence, and `planner-tools.test.ts` now pins the description to the tool
name it actually points at so the two cannot drift apart silently again.

**Replies are rich text, and a formatting bug may lose the formatting but never the message**
(PA-105). Telegram renders formatting only when `sendMessage` is given a `parse_mode`, and its
subset has no headings, tables or real lists. `telegram/format.ts` converts the model's
Markdown into Telegram's **HTML** subset rather than MarkdownV2, because MarkdownV2 needs 18
characters escaped outside formatting and one missed `.` is a `400 can't parse entities` that
delivers nothing. HTML needs only `&`, `<` and `>`. The converter is an **emit-only allowlist**:
every run of source text is escaped before any tag exists, the only tags in the output are the
ones it writes (`b i s code pre a blockquote`), and `href` is written only for `http(s)`. That is
why it is hand-rolled rather than `marked`. Rendering everything and then sanitising back down
is the posture it exists to avoid, since a webhook-driven chat can carry Jira text. Headings
become `<b>`, lists become a literal `•`/`1.`, and tables become an aligned `<pre>`. Two
decisions carry the rest:

- **Split the Markdown, then convert each piece.** Every tag opens and closes in one call, so
  the output is balanced by construction, and `splitMarkdownForTelegram` cuts on block
  boundaries. It never cuts inside a fence (an oversized one becomes several complete fences
  with the same language), repeats a table's header on every piece, and measures a piece by the
  *larger* of its raw length (what the fallback sends) and its converted visible length (what
  Telegram counts). A padded table can outgrow its source. The old code sliced raw text every
  3800 characters, straight through fences and words.
- **`send.ts` is the only formatted sender.** A 400 `can't parse entities` resends *that
  chunk's original Markdown* as plain text, with the inline keyboard kept, and logs Telegram's
  description (never the message text). Any other failure is not formatting's fault, would fail
  the same way again, and propagates as before. Assistant `text`, approval prompts (the title
  in `<b>`, the tool input in an escaped `<pre>`, which the prompt did not show at all before)
  and `send_telegram_message` all go through it. The last was a single unsplit call, so any
  message over 4096 characters was rejected. Notices, `Error:` lines and slash-command replies
  stay plain (`sendPlainText`). There is no setting: the fallback is what makes always-on safe.

### The live-listen utterance harness (PA-85)

Voice input has two modes: push-to-talk (a finger is down, so intent is
unambiguous) and **live-listen**, a continuously open mic that endpoints
utterances itself. The second one has no intent signal at all, and the
reported failure was exactly that: a non-speech sound — "not even a word" —
gets transcribed into a filler token and forwarded to a coding agent as a
prompt. Reproduced against the real service while building this: a 350ms
synthetic thump came back from this deployment's own default ASR model as the
word **"yeah"**, at confidence 0.19.

**Two filters were proposed on the ticket and both were rejected**, which is
most of why the code looks the way it does. A **minimum word count** ("at
least three words") fails in both directions: the most valuable utterances in
a hands-free session are one word — *yes*, *no*, *stop*, *approve* — and the
first invariant here is that nobody answers an approval for the user, so
voice is precisely how you would answer one without a keyboard; meanwhile "oh
yeah okay" is three words of pure filler. So `isAllFiller` tests whether
*every* token is filler rather than how many there are. A **lightweight LLM
classifier** puts a round trip on the critical path of every utterance
(immediacy is the whole point of the mode), needs an endpoint a standalone
install may not have, and when wrong it silently discards a real command.

Three layers, cheapest first, and each catches something the others cannot:

- **The audio gate** (`audio/vad.ts`) never uploads a byte. `speechThreshold`
  became an absolute *floor* rather than the whole rule: the effective
  threshold is a margin above a tracked ambient noise floor, so the gate
  self-calibrates instead of asking the user to hand-tune an absolute level —
  which is what PA-83's sensitivity slider exists to work around. A
  `minVoicedRatio` requirement is orthogonal to `minSpeechMs` and catches what
  a duration floor cannot: a transient with a long decay tail *spans* enough
  milliseconds while only a couple of frames were ever loud. `minSpeechMs` was
  deliberately **not** raised — a spoken "yes" is 300-400ms, so a floor high
  enough to reject a throat-clear rejects the single-word answers the feature
  is most valuable for. Two details of the ratio are load-bearing rather than
  tidy. Its denominator is **voiced + hysteresis-band frames**, never all
  frames: counting silent ones puts every *internal* pause in the denominator,
  so "run the tests" — long pause — "in watch mode" would be discarded as
  noise at a generous `hangoverMs`, which is exactly the setting a slow
  speaker picks. And a run is bounded by `maxSpeechMs`, because ambient energy
  above the *silence* threshold never starts the hangover clock at all — the
  endpointer would stay `speaking` forever, buffering audio without bound and
  holding a barge-in pause nothing could resolve. That bound is not a
  decay-into-allow timeout: it answers nothing and relaxes no gate, it only
  refuses to have an unbounded state.
- **The ASR's own confidence** (`voice/live-stt-client.ts` asks for
  `verbose_json`; LS-7 on the live-stt side). live-stt computed per-word
  confidence all along — `proto/livestt/v1/asr.proto`'s `Word` carries it and
  `transcribe_http.py` accumulated it — and its serializer dropped the field,
  so nothing downstream could read it. Same request, no added latency, and it
  is the model's own judgement about its own output rather than a second
  model's guess about the first one's text. It is **evidence, not a contract**:
  a live-stt predating LS-7 reports none, and the harness must read absent as
  "no signal" rather than as "low confidence", or a voice feature silently
  gets stricter against an older service and looks like a broken mic.
  Confidence is *not* comparable across live-stt's backends (whisper reports a
  mean over a word's tokens, parakeet a `min`), so a threshold is meaningful
  against either but does not transfer exactly — raised as an open question on
  LS-7 rather than papered over. Because a backend swap is therefore
  *expected*, values outside `(0,1]` are discarded as no-signal rather than
  trusted: a backend reporting log-probabilities would otherwise put every
  mean under the drop threshold, and a perfectly working microphone would
  transcribe fine and send nothing at all — a silent, total failure no test
  would notice.
- **Text rules** (`audio/utterance-harness.ts`) — a filler-token set, an
  all-tokens-are-filler test, and the enumerable non-speech repertoire
  whisper-family decoders emit. Matched on the **whole** normalized utterance,
  never as substrings, for the reason `voice-commands.ts` already records:
  "thank you for fixing the tests" is a real instruction. This layer is not
  redundant with confidence, and the evidence is concrete: whisper returns
  `[BLANK_AUDIO]` for digital silence at confidence **0.79**, so a
  confidence-only filter sends it straight on. The words-per-second check
  belongs to this layer too, and it is measured against the endpointer's
  **voiced** span (`RecordedUtterance.voicedMs`) rather than the uploaded
  audio's length: both other measurements fold in up to `hangoverMs` of
  trailing silence, which is the dominant term and made the check essentially
  never fire on the short blips it was written for.

**"yeah" drops but "yes" sends**, a deliberate asymmetry on the reporter's own
evidence — PA-85 names "oh, yeah, hum" as what STT invents out of sounds that
were not words. A deliberate "yeah" is sacrificed; "yes" is the word to say
when you mean it, and also the one that answers an approval.

**The verdict is three-way, and that is the part worth defending hardest.**
Any threshold will eventually reject something a human meant, and a silently
dropped command is the worst available failure: no feedback, so the user
concludes the mic is dead and repeats themselves louder. So `send` goes
through unchanged, `drop` is discarded *with a visible reason*, and
**`review` is parked in the composer** — reusing PA-82's review-before-send
affordance rather than inventing a second one. That gives the thresholds an
honest tuning story: too tight degrades to "you have to tap send" rather than
to "your words vanished". The review handoff is a list of counter-keyed items
consumed as a **high-water mark**, which is the third design and the only
correct one: comparing by text swallows a genuine repeat (exactly what someone
does when they think they were not heard), and treating the counter as
"append one item" loses an utterance whenever two parks resolve in the same
React batch, while keying the effect on the counter alone re-appends
everything on any remount — a desktop tab switch, or crossing the layout
boundary that swaps the whole shell. It deliberately does not focus the textarea,
unlike push-to-talk's own review path: that one follows a tap, whereas this
fires at any moment in a hands-free session, and popping the on-screen
keyboard unasked is the wrong thing to do to someone not holding the phone.

**Barge-in is two-stage, and fixing it mattered more than the bug the ticket
was filed about.** `onSpeechStart` fires on a raw RMS crossing with no
transcript involved, and it used to call `stop()` and send `interrupt` — so a
cough while the agent was talking *destroyed a turn in flight*. A harness that
only filtered the prompt path would have left the more destructive path
untouched. Now the fast, reversible half happens immediately
(`TtsPlaybackQueue.pause()`, which is what makes barge-in feel responsive) and
the irreversible `interrupt` waits for the verdict: a real command commits it,
junk calls `resume()` and the reply carries on. `pause()`/`resume()` are
deliberately distinct from `stop()`, which PA-83 made a *durable* mute for its
own good reasons — a stop must never be downgradeable to a pause, and
`resume()` must never revive one.

Because every restart path is now gated on a `pumpActive` flag, **that flag's
lifetime is the fragile part**: `pump()` clears it in a `finally` and `stop()`
clears it outright, because `playChunk` can genuinely throw (an
`AudioContext` past Chrome's ~6-per-page limit is reachable — `DesktopShell`
keeps every session tab mounted with its own queue — as is `createBuffer` on a
bad `sampleRateHz` off the wire), and a leaked flag means the talk-back is
permanently silent for the life of the page with no way back. A suspended
context's `resume()` is raced against a timeout for the same reason: on iOS it
can stay pending indefinitely, and that `await` sits inside the pump.

Every path that ends a listening session or a run resolves the pause, and that
set is larger than it looks: the six verdict/error exits in `onUtterance`, a
VAD-level discard (`onSpeechDiscarded` — which fires *no* utterance, and which
the Tier 1 gate makes more frequent, so missing it left the reply paused
forever), and a mic that dies mid-utterance (`onError` stops locally rather
than waiting for `voice_mode_changed` to round-trip through a socket that may
be down for the same reason the capture died). `pause()` puts the interrupted sentence back
at the head of the queue, so resuming replays that sentence rather than losing
it (`AudioBufferSourceNode` has no resume-from-offset, and re-hearing one
sentence beats silently skipping it).

**The harness runs in the browser, not the server.** The route forwards
`words`/`durationSec` verbatim and judges nothing, because the other half of
the evidence is client-side — the endpointer's measured voiced span, and
whether the talk-back is currently playing. Splitting the decision across two
processes would mean neither could see all of it. It also keeps push-to-talk
honest: a server-side filter would drop "oh" for someone who deliberately held
the button down and is owed whatever they said.

Known limitation: the thresholds are fixed, well-commented constants rather
than settings. PA-83 already added two voice knobs, and the adaptive noise
floor is partly an attempt to stop needing the first one — a third knob should
wait until the fixed values are shown wrong on real hardware. None of this was
verifiable against a real microphone in the environment it was written in (the
same limitation `vad.ts`'s own header records), so the unit tests carry
recorded real-service output and real-device testing is the acceptance
evidence.

### The spoken-summary tag (PA-84)

Talk-back used to narrate the reply verbatim, code fences and all. A
voice-enabled turn now asks the model for a short spoken paraphrase wrapped in
`<speak>…</speak>` (`SPOKEN_SUMMARY_INSTRUCTION`), the TTS pipeline speaks only
that, and the chat still shows the written reply. Three decisions carry it.

**The tag is requested *first*, and that is a latency constraint rather than a
style choice.** PA-20 speaks each sentence as it streams, so a paraphrase
written *after* the reply could not be spoken until the turn's last token —
total silence then a summary, on exactly the multi-minute turn where a
hands-free user most wants to know what is happening. A spoken lede keeps the
immediacy, and it lets `SpokenTextExtractor` answer "is this a tagged reply?"
from the first few characters: text is held only while it is still a *prefix*
of `<speak>`. A model that emits the tag late therefore gets both halves
spoken, with the markup stripped rather than pronounced — the accepted cost of
not buffering every reply on the chance a tag shows up later.

**The instruction is prompt text, not a system prompt, and that is the whole of
PA-84's "does each backend need its own hook".** No coding-agent path here has
system-prompt plumbing at all (only `planner/chats.ts` builds one, and Pocket
Agent chats have no talk-back); an adapter's `buildCommand().args` never
reaches a structured session, since `SessionManager` forwards only
`executable`/`env` and each backend builds its own argv, so a CLI
`--append-system-prompt` would only affect the *terminal* transport, which has
no talk-back either; and the Claude SDK's `systemPrompt` option is fixed when
`query()` is called, making it spawn-time and unable to follow a mid-session
voice toggle. So the seam is `ws/index.ts`'s `case 'prompt'` — one chokepoint
every structured backend passes through, already composing server-side text for
the attached-image note — gated on `isVoiceModeEnabled`. It must stay *above*
`promptQueue.submit`: a queued prompt is re-sent from its persisted text
verbatim, so an instruction added later would be lost on exactly the deferred
path. `SUBAGENT_RESULT_TRAILER` (PA-76) is the same append-then-extract shape.

**An absent tag speaks a filtered reply, never silence.** Skipping speech would
be indistinguishable from a dead microphone — PA-85's own reasoning — and would
make this feature's non-compliance look like broken hardware, so
`SpokenTextExtractor`'s fallback mode speaks the prose with the unspeakable
parts removed: fenced code, inline code that is not a bare word, tables, URLs,
paths and markdown furniture. That half needs no model cooperation, which is
why it is unconditional and why `voiceSpokenSummaryEnabled` only governs
whether the *instruction* is appended — turning it off stops adding text to
prompts, it does not restore narrating code.

The grammar lives in `packages/protocol/src/spoken-text.ts` because both sides
read it: the server decides what to speak, the browser decides what to hide
(`stripSpokenSummary` at render in `Transcript.tsx`, `stripSpokenSummaryInstruction`
in `transcript.ts`'s `user_prompt` case). Same rule as `cron-expr.ts`. Stripping
is *presentational* for an assistant reply and *reducer-level* for a prompt, and
the asymmetry is deliberate: `text_delta` accumulates, so stripping on the way
in would drop a half-arrived `<spea` and then concatenate its `k>` onto
already-stripped text, corrupting the reply for the rest of the turn. A
`user_prompt` arrives whole, so it has no such state to break.

**A tag inside markdown code is a mention, not a tag.** Both sides find tags through one
`SpeakTagScanner` (`spoken-text.ts`), which ignores `<speak>` inside an inline span or a fence.
Before it, prod session `Axd2XlzNSf5d` — a reply *explaining* this feature — wrote
`` `<speak>` `` with no closing tag, and the chat cut the reply off at that backtick (492 of
8,452 characters shown) while the extractor would have read everything after it aloud as the
summary. And an unclosed block is hidden only while `stripSpokenSummary(text, { streaming })`
says the reply may still close it: once finished, it is shown, because a message cut off with
no sign anything was cut is the worst way this can fail.

**Hidden is not the same as unreachable.** The paraphrase is the one thing in a
turn that exists *only* as sound: stripped from the reply, gone after playback.
So an assistant message that carried one gets a small speaker button beside
"Copy answer" that expands the spoken text (`extractSpokenSummary`, the
disclosure in `Transcript.tsx`) — collapsed by default, because it must not
compete with the reply, and plain text rather than markdown, because it is the
exact string the synthesizer was handed. It is deliberately *not* offered when
the model wrapped its whole reply in the tag: the empty-bubble guard already
put that content on screen, so the toggle would expand to a duplicate of the
message above it. Without this there is no way to answer "what did it actually
say?", which is the first question a mis-tuned paraphrase provokes.

Two consequences worth knowing. The tag reaches the agent's *own* on-disk
transcript (for `claude`, Claude Code writes that file and this app never
rewrites it), so "TTS-only, discarded after playback" was never available —
hiding it at render is the entire mechanism, and `stripSpokenSummary` shows the
tag's content rather than an empty bubble if a model wraps its whole reply.
And because the tag is meaningful, text this app did not author can carry it — a
webhook prompt built from a Jira ticket, a file the agent echoes. The worst case
is the speaker saying attacker-chosen words rather than anything executing, and
the fallback path speaks reply text aloud regardless, so this is documented
rather than defended with a per-turn nonce fence.

`SpokenTextPipeline` owns the extractor and the `SentenceChunker` together so
one `reset()` clears both. That is load-bearing, not tidiness: an extractor left
mid-fence by a stop or an interrupt would swallow the *next* turn's whole reply
and present as talk-back dying for good, which is the shape of every PA-83 bug.
Real-device testing is the acceptance evidence here too, for the reason PA-85
records.

**Untagged text is held until the turn settles; tagged text is spoken at once**
(PA-89). A turn is not one reply — a tool-using turn is several LLM round trips,
and the content of a round trip that ends in tool calls is the model thinking out
loud. `planner/chats.ts`'s `driveLoop` streams that content as `text_delta` and
then never emits it as a `text` event at all, so on prod chat `83251c3c` the only
trace of "I need to fetch the URL…" was the speaker saying it. Worse, speaking it
*latched* the extractor: the mode decision is made on the first delta and held for
the pipeline's life, so an untagged scratchpad put the whole turn in fallback and
the final reply's `<speak>` summary was ignored in favour of narrating the written
answer — the exact failure PA-84 exists to prevent, reintroduced through a path
PA-84 never saw.

So `SpokenTextPipeline.push` returns tagged sentences immediately and *holds*
untagged ones, releasing them on `flush()` and dropping them on `reset()` — and
`tool_use` is now a plain `reset()` in both `VoiceTtsService` and
`routes/planner.ts`. Three things follow. PA-84's tag-first latency property is
untouched, because a `<speak>` lede still streams the moment it closes. Nothing
needs retracting from the browser's playback queue, which is what makes the
pump deliberately *untouched* by `tool_use`: cancelling it would also kill a
legitimate lede, and cut it off mid-word if it had already started playing —
the first cut of this fix did exactly that, and needed a matching
`ttsQueue.stop()` in both pages to work at all. And a model that ignores the
instruction entirely has its reply spoken starting at turn end rather than
sentence-by-sentence, which is the accepted cost: the alternative needs a second
signal telling the browser which audio to discard, and it guesses wrong in
precisely the compliant case.

**A Pocket Agent turn's audio is bound to the request that produced it, and the
drain budget is therefore load-bearing** (PA-89). A coding session's talk-back
rides a WebSocket that outlives the turn; a planner turn has only *this*
request's SSE stream, so when the generator ends, any sentence still being
synthesized is racing the response closing — and `SseStream.write` silently
no-ops once it has. `ttsDrainBudgetMs` (`routes/planner.ts`) is how long the
response is held open for that, and it **scales with the pump's queue depth**
rather than being one number: a compliant `<speak>` summary is one or two
sentences, but an *untagged* reply is held in full and released in one go at
`turn_complete`, onto a pump that synthesizes strictly serially — so a flat
budget generous enough for the second case would pin the response open for
minutes when one sentence is outstanding and the voice service has wedged. It
was a flat 5s, which is shorter than a single synthesis: live-stt on a CPU backend takes ~9.5s for a one-sentence summary
(measured on this deployment), so the summary was *always* dropped — no error,
no log, just silence. It went unnoticed only because untagged scratchpad text
used to be spoken mid-turn, early enough to land before the close; removing that
above is what exposed it. Two rules follow. The budget must stay well clear of the
queue it is given (a test pins it against the measured figure at several queue
depths, and against the hard cap), and **a discarded chunk must log** — this is the one TTS failure with no exception behind it, and
silence is indistinguishable from a dead speaker, which is the failure PA-85's
invariant is written against. The bound itself stays, because
`LiveSttClient.synthesize` puts no timeout on its `fetch`: this is PA-68's "a
wedged network call is nobody's decision", not the approval no-decay rule.
`TurnTtsPump.pendingSentences` is what the budget reads, so its count is
load-bearing in both directions — leaking one holds a socket open for a pump
with nothing to do, losing one truncates audio. It is released in a `finally`
that also **swallows a throwing chunk sink**: `queue` is the chain every later
sentence is appended to, so letting a failed write reject it skips all of them
*and* the `done` marker, stranding the drain until its budget expires. That one
is asserted by a test that fails without the guard.

### Gemini Live as a per-agent live-stream provider (PA-96)

A Pocket Agent can use **Gemini Live** instead of the live-stt pipeline for live mode,
chosen per agent (`planner_workspaces.live_provider`, `'pipeline' | 'gemini-live'`, default
`pipeline`, beside `default_model_id` for the same "real multiple agents" reason). Coding-agent
sessions are untouched. **While live mode is on, Gemini Live *is* the chat's model**, not a relay
in front of the planner LLM: it hears the user, speaks its own replies, and calls the agent's
existing planner tools. So none of the PA-84/85/89 machinery is on that path (`<speak>`, held
untagged text, the TTS drain budget, the utterance harness, live-stt). Server:
`planner/gemini-live.ts` plus the `// ---- Gemini Live` block in `planner/chats.ts`; wire types:
`packages/protocol/src/gemini-live.ts`; browser: `audio/gemini-live.ts` (controller, DOM) over
`audio/gemini-live-protocol.ts` and `audio/pcm-stream.ts` (pure, tested).

**Browser-direct with a constraint-locked ephemeral token, decided on the ticket** (the server
relay was the documented alternative; see the exploration doc). The AI Studio key is a
`secret-box` ciphertext in `settings` (`planner_gemini_api_key_enc`), with no reveal route; a
blank save keeps it and `clearApiKey` removes it. `POCKETAGENT_SETTINGS_ENC_KEY` unset makes
the feature unavailable without failing the boot. `POST /api/planner/chats/:id/live/token` mints
a **single-use** token (1 minute to open, 30 to use) whose `bidiGenerateContentSetup` holds the
model, audio-only output, the system instruction (live rules, persona, top-K memories) and the
exact `toolsFor(workspaceId)` list. It is refused unless the chat's agent is set to
`gemini-live`. Four things about the real service were found empirically and shape the code:
- **No `fieldMask`** locks every field of the setup: a client `setup` naming another model or
  instruction is overridden.
- **Resuming consumes a token use, and a client-supplied resumption handle is silently
  ignored.** So every reconnect (`goAway`, dropped socket) mints a fresh token with the handle
  baked in (`resumeHandle`), and a resumed token carries no seed history.
- Tool schemas pass verbatim as **`parametersJsonSchema`**: all built-in tools were accepted,
  so there is no conversion layer.
- **`turnComplete` arrives right after a `toolCall`, before it is answered.**
  `LiveTurnTracker` therefore closes a turn only after the reply that follows the tool.

**The tool bridge is the approval gate, shared rather than copied.** `gateToolCall` is the
single "may this run?" for both `processToolCalls` and `runLiveToolCalls`: unknown/disabled
(global and per agent), remembered decisions, yolo, `skipToolApprovalsEnabled`. So is
`applyApprovalDecision` for resolving one. A call needing approval is parked as a
`PendingLiveToolCall` in the **same `pendingTurns` map**, which is what makes PA-69's drain,
the chat's `busy` flag and chat deletion cover it for free. It has no LLM continuation: Gemini
is answered at once with `LIVE_AWAITING_APPROVAL_MESSAGE`, so no synchronous tool response is
held across its ~10-minute socket. After `POST .../approvals/:id` the result is persisted and
the page relays it to Gemini as `clientContent`. The persisted `tool_use.id` is minted
server-side (`live_<uuid>`) because Gemini's ids restart per session and would collide in a
long transcript.

**One model drives a chat at a time.** `busyWithPlannerLoop` refuses the token, the bridge and
transcript writes while a planner turn is running or parked (live work is counted separately in
`liveWork`, so a second Gemini call is not refused by the first). A parked live approval blocks a
typed message exactly as a parked planner approval does. Subagent **wake turns are deferred, not
dropped**, while a chat has a live session (`liveSessions`, released by `POST .../live/end` or a
10-minute activity TTL), because a wake runs the planner LLM.

**The transcript is the ordinary event log.** `POST .../live/transcript` takes a deliberately
narrow shape (`userText`, `modelText`, `turnComplete` with Gemini's `usageMetadata` tokens) and
writes `user_prompt`/`text`/`turn_complete`. The page can report what was *said*, never a tool
event; those are written by the bridge from the gate's own decisions. A reopened chat replays
through `applyEvents`, and turning live mode off hands the same history to the planner LLM.
Before resolving a live approval the page flushes what Gemini said while waiting
(`flushSpeech`), so that line lands before the result.

Browser details. Playback is **not** `TtsPlaybackQueue`: Gemini sends dozens of ~40ms chunks per
second, and chaining them on `onended` clicks between every one. `StreamingPcmPlayer` schedules
them on the audio clock instead (`scheduleChunk`). Mic audio uses `StreamingResampler`, because
resampling each 128-frame worklet quantum independently buzzes at the quantum rate. A dead socket
turns the mic indicator off (PA-83), and there are at most three resume attempts. The idle
auto-off defaults to 5 minutes, because Gemini bills audio for as long as the socket is open.
Typed messages go to Gemini (`realtimeInput.text`) while live. The disclosure renders on every
visit to a chat whose agent uses Gemini Live.

Known limitations: images cannot be sent while live. Resume-after-`goAway` is exercised by the
unit suite and was verified against the service in a spike, but a real `goAway` is not forced by
the demo. Subagent completion notices are not spoken to Gemini; they wake the planner once live
mode ends.

### The home screen

`projects/index.ts` composes `GET /api/projects`: live sessions and on-disk conversations
merged into one chat list per directory. Two rules live here — a session that resumed a
transcript hides that transcript's row (they are one chat, and the session is the live view
of it), and a chat's timestamp falls back through `lastActivityAt → startedAt → createdAt`
so a brand new one does not sort last.

**The home screen has three top-level categories, not one list**: "Pocket Agents"
(`PocketAgentsSection`), "Shell" (`ShellSection`), then "Projects" (`ProjectList`), in that
order in both layouts. **Shell is a category, not a project** (PA-25): `isShellSession`
(adopted, or `agent === 'shell'`) diverts a session out of `byCwd` entirely and
`ProjectService.shells` returns it as `ProjectsResponse.shells` — a flat,
`ShellSessionSummary[]` sibling of `projects`. This replaced a synthetic `ProjectInfo` with
`cwd: 'virtual:shell'` that had to lie about six fields to look like a folder and forced
every consumer of the project list to learn to skip a cwd that is not a path (the two
editor pickers, the containment filter, the worktree fold, `clear-finished`). Two
consequences worth knowing: a directory whose only activity was a shell no longer gets a
project card at all, and a shell row carries its own `cwd`/`cwdLabel`/`adopted` because
there is no card above it to inherit them from. Clearing is `POST
/api/shells/clear-finished` — no body, because the category has no directory to name — and
`SessionManager.forgetFinishedShells`'s two SQL clauses must keep mirroring
`isShellSession`, or the category lists rows that "Clear finished" silently leaves behind.
`virtual:webhooks` is still a synthetic project and is untouched by this. Known limitation:
the category is flat and unpaginated — no `CHAT_PAGE_SIZE` "show more" row — so "Clear
finished" is the answer to a long list rather than a page size.

Inbound webhooks surface the same way, as `ProjectInfo.webhooks`, and the argument for it is a
sharper version of the one below: a cron job will fire tonight whether or not anyone looks,
whereas "configured but never fired" is a webhook's *most likely* steady state — a wrong URL, a
mistyped secret, a proxy that is not forwarding. A row that only appeared after the first
delivery would hide precisely the case that needs attention, so `never fired` is shown as
information rather than as an empty state. `ChatSummary.webhookId` badges the chats a delivery
started, keyed on the conversation id for the same `representativeSessions` reason — and it
matters more here, because `per-issue` mode deliberately maps many deliveries onto one
conversation, making the badge a boolean about the conversation rather than a count.

Scheduled jobs also surface here, as `ProjectInfo.cronJobs` rather than folded into `chats`:
a job is a *spec*, not a conversation — it exists before it has ever run and survives every
run it starts — so it has no transcript to open and tapping it opens its editor instead. A
directory that only has a job in it still gets a project row, or a job configured in a
subdirectory with no chats yet would be invisible until its first run, which defeats the
point of listing it. Runs, in contrast, *are* chats: `ChatSummary.cronJobId` badges them,
keyed on the **conversation** id because `representativeSessions` collapses several session
rows sharing one `agentSessionId` and a session-keyed badge would vanish with the collapse.

`HostInfo` is first-class, and `GET /api/hosts` on a backend still answers with exactly one
entry: itself. A backend must not claim to know about its peers — the same reasoning that stops
it asserting its own external origin — so the *list* of machines comes from somewhere else: the
Hub (PA-66, below). The Hub is exactly that front server. This was a **knowing reversal** of the
previous posture ("No such front server exists... treat it as a design problem, not a feature request").
The mitigation that made it defensible is scoped hub credentials (PA-63): no master tokens are stored
on the Hub (exchanged once at bind time and discarded), and credentials are full-access but
individually revocable per host from the backend side (`Settings → Hubs`). What remains true and
accepted is that a Hub compromise can still write configuration to every bound host (e.g. provisioning
templates, LLM endpoint replacement, or revoking sibling credentials).

**Host is a grouping dimension on the home screen, not a mode** (PA-67). The client is
host-parameterised (`HostEndpoint`, PA-60), so the aggregated "all hosts" home is the default
*list* view: one `HostGroup` heading per host, wrapping **the same three category components in
the same order**. Nothing inside `PocketAgentsSection`, `ShellSection` or `ProjectList` knows a
host exists, which is what keeps them shared between the layouts — and with one registered host
the heading is not rendered at all, so a standalone install's home screen is byte-identical to
the pre-PA-67 one. That is the property the whole feature is shaped around: `HostRail` (desktop)
appears only when there is something to switch between, `HostSheet` (phone, opened from the
header chip) is the same switcher without spending scarce width, and the rail is *chrome, not a
category*, so it is a third grid column rather than anything inside the sidebar.

The host list has two sources and exactly one is live, chosen once at boot and never merged
(`hosts/directory.ts`): a **Hub** answering `GET /api/hub/hosts` (PA-66, whose registry types
live in `packages/protocol/src/hub-registry.ts` so the two tickets cannot invent different
shapes), or a **local** list in `localStorage` — the host that served the bundle plus whatever
same-origin path prefixes this browser has been told about. The local source is not a stub: with
a reverse proxy already publishing two backends on one origin it is a working registry, and it is
what makes the feature reviewable and demoable a ticket ahead of the service. It also cannot
become a hole — a registered host is a *base path*, and `normalizeBasePath` cannot produce an
absolute URL, so a hand-edited value can only make same-origin requests that 404.

**Polling is tiered, and no socket is ever opened for a merely-registered host**
(`hosts/poll-policy.ts`). The single-host home already ran two 5 s pollers issuing three
requests; repeating that per host is 3N requests every five seconds on a phone. So: the selected
host and any host with an open tab poll at the old 5 s; an expanded but unwatched group polls at
15 s; a collapsed group is not polled at all and still shows a dot and a running count, because
those come from one cheap `GET /api/hosts` per host per 30 s (that is what
`HostInfo.runningSessions` is for). A failing host backs off to a minute, and every probe has an
8 s `AbortController` — `request()` itself stays timeout-free, but a poll that hangs forever is
the "spinner that never resolves" an offline host must never become.

**A host's id is generated once; its name is what the user typed** (PA-107). The Add dialog
asks for a name and an address only. `generateHostId` (`hosts/registry.ts`) turns the name into
the routing slug: NFKD-folded, lowercase, `-`-joined, at most 40 characters, `-2`/`-3`/… past
any id the directory already holds, and `host-<random>` when nothing slug-able survives. The
**browser** mints it rather than the Hub, on purpose: local mode has no server to ask, so the
generator is needed anyway, and `CreateHubHostRequest.id` stays required so the schema and old
bundles are untouched. A Hub 409 re-derives the id against a fresh registry read and retries
once. The id never changes after that. A rename edits `label` only, because bookmarks,
`t:<hostId>:…` tabs and Hub-push deep links all key on the id. `HostRecord.label` is therefore
the registered name everywhere a host is named. It used to be `HostInfo.name ?? label`, so the
name field was a no-op once a probe answered. The hostname is `reportedName`, which is
secondary text and tooltips (`hostTitle`), and it replaces only the local-mode default host's
placeholder `local` (`labelIsPlaceholder`). The version line under the sidebar brand names its
component (`BuildVersions`): **Server** is the selected host's `HostInfo.version` (a summary in
the all-hosts view), and **Hub** comes from the Hub's own bare `/health` and appears only in hub
mode, where that URL is the Hub's rather than a backend's. The web bundle's
`formatBuildInfo()` moved to the tooltip. It used to be the whole line, unlabelled, and so read
as the server's version even behind a Hub, which serves the bundle itself.

**Tab identity is host-qualified, and that was the sharpest bug in the feature.** `tabIdFor`
emits `t:<hostId>:<sessionId>` (and one admin-page singleton *per host*), because two machines
can hand out the same session id and an unqualified id renders one host's transcript in the
other's tab — a failure that typechecks perfectly. `open-tabs-pref` migrates a pre-PA-67 entry
onto the default host rather than discarding the strip. Every tab panel stays mounted and is
wrapped in its own `HostProvider`, which is what lets a live session on one machine keep
streaming while the sidebar shows another.

**The client side of that shape is `HostEndpoint`** (`apps/web/src/api/host.ts`, PA-60). Before
it, the origin *was* the host identity: `request()` fetched relative paths and `wsUrl()` read
`window.location.host`, so "which backend am I talking to" was answered by the page's own URL
and could only be changed by a full page load. An endpoint (id + base path) is threaded through
`createApiClient` and both socket classes instead, and `useHashRoute` parses an optional
`#/h/<hostId>/` prefix — stripped *before* the route cascade runs, so the "detail route before
the generic one" ordering inside it is untouched. Still exactly one host: `DEFAULT_HOST`'s base
path is empty, every emitted URL is byte-identical to before, and a hash with no host segment
stays bare rather than being rewritten to `#/h/local/...`.

Two things there are load-bearing. **A base *path*, not a base URL**: `credentials:
'same-origin'` against an HttpOnly cookie survives a same-origin prefix untouched, whereas a
cross-origin base URL would need `credentials: 'include'`, a credentialed CORS allowlist and
`SameSite=None; Secure` — none of which the loopback-bind-over-plain-HTTP posture can provide.
So a second host is reachable only through a same-origin reverse proxy, and that is a constraint
the Hub inherits rather than one to lift by widening the type. And **the host rides alongside
`Route`, not inside it**: putting `hostId` on all 14 variants would make every `navigate({ ... })`
call site responsible for threading it, where one that forgot would silently move the user to
another machine while still typechecking. `navigate` preserves the current host unless explicitly
given one; a call site with no `navigate` in scope uses `hashForCurrentHost` rather than
assigning `window.location.hash` by hand, which drops the segment.

### The composer's fourth row

Reads `/api/projects`, not `/api/conversations`, so it shows exactly what the home screen
shows — live sessions included, removed and hidden ones left out. It matches the selected
directory *or any below it*, and a picked chat supplies its own `cwd`; resuming a
conversation in a directory it did not belong to would point the agent at the wrong tree.
Picking a chat that is already live navigates to it instead of creating anything.

### Hiding and removing

Nothing in the UI deletes a transcript. "Remove" means: drop the session row
(`SessionManager.forget`, refused for a running session) and record the conversation id in
`hidden_chats` so the next disk scan does not resurrect it. `project_visibility` stores
*decisions* rather than a hidden list, because build directories are hidden by default and
an unhide has to be storable too — an explicit row always wins over `AUTO_HIDDEN_DIRS`.

### Wire protocol

`packages/protocol` is the single source of truth: Zod schemas for every HTTP body and
WebSocket frame, shared by both sides. Bump `PROTOCOL_VERSION` in `ws.ts` when frames
change; the client sends it as `?v=` and a version outside the server's range is rejected
at connect.

**The handshake tests a range, and the range is deliberately narrow** (PA-61). With one
lockstep-deployed backend, "the version I speak" and "the version I accept" were the same
number and an equality check was right; with a Hub fronting several independently-upgraded
backends, version skew is the *steady state*, so a lagging host has to be one unusable row
rather than a dead app. `SERVER_PROTOCOL_RANGE` (`[PROTOCOL_MIN_SUPPORTED, PROTOCOL_VERSION]`)
is what `/api/ws` enforces *and* what `/health` and `HostInfo.protocol` advertise — one
constant, because a client told it was compatible and then closed on anyway is worse than
one refused up front. `PROTOCOL_MIN_SUPPORTED` equals `PROTOCOL_VERSION` today, so the
handshake is exactly as strict as the equality check it replaced: **widening the floor is a
per-version decision, and the version history in `ws.ts` is the argument it has to beat** —
v10 through v15 exist *specifically* to force an old bundle to reconnect, because an unknown
enum value or discriminant fails the whole frame's Zod schema rather than being ignored. What
PA-61 delivers is the mechanism, not a wider window.

**The verdict is the client's, never the server's.** A host reports facts (`version`, a real
semver from the build; `protocol`, the range) and `negotiateProtocol`
(`packages/protocol/src/protocol-negotiation.ts`) decides — it lives in the protocol package
for the same reason `cron-expr.ts` does, since the server, the browser and the Hub's own host
list all need the same answer and a second copy guarantees the list eventually disagrees with
what the handshake does. It is a point-in-interval test rather than a range intersection
because a bundle speaks exactly one version and cannot choose to emit an older frame set on
request. `describeIncompatibility` is the one place the sentence is worded, and the three
reasons get genuinely different advice: a stale *bundle* is fixed by reloading, a stale *host*
by upgrading that machine, and an `unreachable` one by neither. `CLOSE_PROTOCOL_MISMATCH`
still stops reconnecting — retrying is "Reconnecting…" forever — but it now yields a
`FatalClose` carrying the `hostId`, and `fatalCloseMessage` only says "reload the page" for
the host that *served this bundle*: for any other host reloading re-fetches the same bundle
from the same origin and changes nothing.

`version` and `protocol` are independent on purpose. One is build identity, for humans and
version-drift detection; the other is the machine-checkable gate. A patch release must not
imply a protocol change, and conflating them is how "can this bundle talk to that host?"
becomes unanswerable again — which is what the hardcoded `VERSION = '0.1.0'` made it.
`resolveServerVersion` (`apps/server/src/version.ts`) reads `POCKETAGENT_BUILD_VERSION` →
`package.json` → `0.0.0-dev`, from raw `process.env` rather than through `Config` because an
operator does not *choose* their build number; a malformed stamp warns at boot rather than
failing it.

Output replay is byte-oriented with monotonic sequence numbers (`terminal/output-buffer.ts`,
and `terminal/event-buffer.ts` for structured events). Each stream also has an **epoch**:
seq numbers are only meaningful within one run, so a resume with a stale epoch forces a
truncated full replay rather than splicing a corrupt ANSI stream.

### The Hub (PA-66)

`apps/hub` is the third deployable and the only component that knows more than one backend
exists. It is one origin: the browser loads the same `apps/web` bundle from it and reaches
each backend under `/h/<hostId>/api/**`, with `/api/hub/*` for the registry and `/api/auth/*`
for the Hub's own session.

**One origin rather than CORS, and that is a constraint rather than a preference.** A frontend
talking to N backend origins needs `SameSite=None; Secure` cookies and Safari blocks
third-party cookies outright, so the obvious design fails silently on the primary target.
Path-routing keeps the existing `SameSite=Strict` HttpOnly cookie unchanged, needs no CORS,
makes WSS a plain upgrade proxy and leaves one TLS endpoint. It is the same conclusion
`HostEndpoint`'s "a base *path*, not a base URL" comment reaches from the client side (PA-60) —
the Hub inherits that constraint rather than lifting it.

**The credential-concentration objection was overruled, not forgotten.** This file used to say
a front server "concentrates credentials for every registered machine in one process — treat it
as a design problem, not a feature request". PA-66 knowingly overrules it, and PA-63 is the
mitigation that makes it defensible: the Hub never holds a master token (it exchanges one, once,
per host and discards it), everything it does hold is full-access but *revocable from the
backend side*, and `hub_hosts.credential_enc` is a `secret-box` ciphertext rather than a token
in the clear. The accepted residual cost is real and worth stating: the Hub is one process that
can reach every bound machine, and it is a single point of failure for *reaching* them — though
not for their state, since each backend stays directly usable with no Hub involved. Furthermore,
what remains true is that a Hub compromise can still write configuration to every bound host
(create Pocket Agents, MCP registries, providers, skills, and repoint LLM endpoints; or revoke
sibling credentials), though it cannot mint new credentials or bypass per-host audit logging.

**`packages/node-kit` exists because of this ticket.** The Hub needs `secret-box` and the
token/origin helpers, and reaching them through `@pocketagent/server` would drag node-pty, the
Claude Agent SDK and the MCP SDK into a gateway image. So the primitives where two
implementations drifting is a *security* bug moved into a Node-only leaf package that both
services depend on; `apps/server` re-exports them from their original paths, which is what kept
the move pure enough for the existing suite to be its regression guard. What deliberately did
not move: `AuthService` (a session store is bound to its own table in its own schema — a Hub
session grants "reach every bound host", a backend session grants "terminal access on this
machine", and they must never be the same row) and `openDatabase` (the server's carries a long
positional `MIGRATIONS` array plus `PRAGMA table_info` repair blocks that exist to heal branch
drift in a schema with years of history; a schema whose first migration ships today must not
inherit that scaffolding).

**The proxy is a positive allowlist with an explicitly tested deny list**
(`proxy/allowlist.ts`). Two shapes are proxied under a host prefix — `/h/<id>/api/**` and
`/h/<id>/health` — and nothing else, because `hostUrl()` only ever asks a host for those two and
a backend answers any other path with its own copy of the SPA shell. The deny list is the
statable invariant below. Path handling **decides on the decoded path and forwards the raw
one**: deciding on the raw string alone waves `/api/%68ooks/foo` straight through (a real bug,
caught by `proxy-allowlist.test.ts` against the first cut), and forwarding a re-encoded path
would corrupt a legitimate `%3A` in an agent id. `%25` is refused outright so "decode once" is
the final word rather than one step of an unbounded loop.

**One host is the *default* and is also mounted at the bare `/api/*` root.** Without it the Hub
would serve a UI that cannot talk to anything: `DEFAULT_HOST.basePath` is `''`, so the
unmodified bundle asks the Hub itself for `/api/projects`. With it, every existing browser demo
can be pointed at the Hub and must behave identically — which is the broadest regression test
the proxy has, and is why `HubHostEntry.isDefault` exists rather than the Hub picking one
implicitly.

**Occupancy of a host row is read per request; live sockets are tracked separately.** The
registry row is re-read from SQLite on every proxied request with no cache — the same "read the
row fresh" discipline `HubCredentialStore.validate` follows, and the reason removing or
disabling a host takes effect with no restart. That is not sufficient for a WebSocket, which
outlives the request that created it, so `SocketRegistry` holds the socket *handles* (and
nothing about the traffic — no buffer, no byte counter, deliberately no foothold for
inspection) so a removal can destroy them.

**Health polling is one self-rescheduling loop per host**, modelled on `TelegramPollerService`
rather than `CronService`'s shared tick, because one hung machine must not delay every other
dot. It is unauthenticated — `/health` is public precisely so a Hub can judge a backend
*before* it holds a credential — which is what makes "add by base URL, then bind" a two-step
flow with visible progress. `negotiateProtocol` from `packages/protocol` renders the verdict;
a second copy of that arithmetic is the thing `protocol-negotiation.ts` already forbids.

**A backend's 401 becomes the Hub's 502.** `App.tsx` drops the whole app to the login screen on
any 401, so passing one through would sign the operator out of every host because one
credential was revoked. `host_credential_rejected` names the host instead.

**Two accepted costs, stated because they are real.** The Hub will connect to any `http(s)`
origin an operator registers, and `PATCH`ing a bound host's `base_url` and then deleting it
sends the stored credential to whatever is listening — so an operator can recover a credential
the API otherwise only ever shows as a 12-character prefix. That is not an escalation (the same
operator holds the master token that minted it, and re-binding produces a fresh one), but it
does defeat the "no reveal path" posture, so it is a known property rather than a hole to be
surprised by. And `/h/<id>/health` is proxied even though `/health` is in the backend's
`PUBLIC_API_PATHS` — a deliberate exception to the rule above, because the browser's own
protocol negotiation needs the range and a version number is the one thing in that set with no
security content. It still requires a Hub session, so the Hub is not an unauthenticated
reachability scanner for whoever can reach the port.

Packaging: a `hub-runtime` stage in the *same* `docker/Dockerfile`, a fourth `docker/build.sh`
target, and a second **image name** (`pocketagent-hub`) rather than a tag suffix —
`scripts/release-tags.mjs` grew a per-target `{ image, suffix }` table for it, because
`pocketagent-server:1.2.3-hub` would be actively misleading to whoever pulled it. The image
ships `apps/web/dist` (the Hub is the origin the browser loads from) and no agent CLI, no PTY
and no git. Its dependencies come from a **`hub-deps` stage built on a clean base**, not from
`prod-deps` and — the part that is easy to get wrong — not layered on `deps` either:
`pnpm install --filter` does not garbage-collect what an earlier install already materialised
in `node_modules/.pnpm`, so a filtered install on top of the shared stage still shipped the
291 MB Claude Agent SDK and 60 MB of node-pty. Measured, not reasoned about — the image stayed
at 796 MB until the stage started from scratch, and is 273 MB now.

### Hub config templates and provisioning (PA-70)

Define a Pocket Agent, an MCP registry, a skill, a provider or a planner endpoint once, and
instantiate it onto any bound host. `apps/hub/src/templates/` holds all of it —
`store.ts` (`hub_templates` plus the provisioning ledger), `kinds.ts` (payload → backend
calls), `provisioner.ts` (the run) — alongside `routes/templates.ts` and
`packages/protocol/src/hub-templates.ts`.

**Provisioning is the Hub being an API client, not a new contract.** Every path `kinds.ts`
emits already exists on a backend and is already validated there: `POST
/api/planner/workspaces` plus its `/tools` follow-ups, `POST /api/mcp-registries`, `POST
/api/custom-claude-providers`, `PATCH /api/planner/settings` with `POST /api/planner/models`.
That is the same rule PA-56 recorded for the planner's settings tools — *the same validation
the route does, never a second copy* — and a `POST /api/provision` taking five resource kinds
would have been five re-implementations of five validators, the first of which to drift would
have drifted silently on every bound host at once. It also gets "logged on both sides" for
free, because each of those routes writes its own audit line.

**A template is instantiated and then diverges freely.** No reconciliation, no desired state:
editing one bumps `hub_templates.revision` and touches nothing, and the ledger keeps whichever
revision each host actually received so the UI can say "dev01 has r3, this is r5". Showing
that is the obligation the no-sync model takes on in exchange for never correcting drift —
without it, "which hosts are behind?" is unanswerable. A drift-correcting loop would also fight
the per-host editors that already exist for every one of these resources.

**Two classes of hole, not one.** *Secret-shaped* holes (a provider key, an MCP token, the
planner LLM key) are declared by the template and filled per run; see the invariant below for
why nothing is stored. *Host-shaped* holes are the ones this ticket discovered:
`planner_workspaces.path` is `UNIQUE`, absolute, and since PA-62 lives under that host's own
`POCKETAGENT_DATA_DIR`, so a template carries no `path` at all — the fields are **absent from
the schema**, not rejected at runtime. Carrying one would be wrong on every machine but the one
it was typed on, and carrying it as an optional override would let a single Hub action grant an
agent's `write_file`/`exec_command`/`rmdir` tools full trust over arbitrary directories across
a fleet. The general rule: a template field is portable only if its *value* means the same thing
on every host. Absolute paths and host-local minted ids (`global:<slug>`, `mcp:<slug>-<hex>`)
do not qualify; tool names do, and so — surprisingly — does `defaultModelId`, which is the
provider's own model *name* rather than a `planner_models` row id.

**"Already provisioned" is a ledger answer, never a name match.** No backend table constrains a
Pocket Agent's, a registry's or a provider's name, so two may legitimately share one — matching
on names could therefore overwrite something a human made on that machine, which is exactly the
implicit overwrite the ticket forbids. `hub_provisionings` is keyed `(template, host)` and holds
the `remote_id`; a row whose id no longer resolves on the host is *dropped* and the run creates
afresh, because that is the deleted-by-hand case and patching a vanished id would strand the
template forever. Skills are the one kind where the host does enforce uniqueness (the slug is a
directory name), so a pre-existing skill at that slug is a **`conflict`** that no `overwrite`
flag replaces.

**Nothing is written until the host has answered a read.** Every run starts with a `GET` of the
target collection: a `404` is `unsupported` (that build has no such route) and the host is never
written to, a `401`/`403` becomes "rebind this host" rather than "provisioning failed" — the
same translation PA-66 makes for a proxied 401. Feature detection is deliberately a *probe*
rather than a version comparison, because a backport, a dev build or `0.0.0-dev` makes a semver
a lie about which routes exist; PA-69's drift badge stays advisory. Hosts are done one at a time
so a partial run reads in order, and one dead host fails alone.

`planner-endpoint` is the only **singleton** kind and the only one that is never a create: every
host already has one planner endpoint, and repointing it changes what every existing Pocket Agent
chat on that machine talks to. So it requires the overwrite confirmation *even the first time*,
it replaces the model catalog wholesale only when the template carries one (`models: []` means
"leave the host's own list alone"), and it never carries `yoloEnabled` — a template is not a way
to turn an approval gate off across a fleet.

Skills needed the one new backend route, `POST /api/planner/skills/import`: the existing `POST
/api/planner/skills` takes a filesystem path *on the receiving host*, and no protocol type
carried a skill's body at all. v1 provisions global skills only, one `SKILL.md`, no auxiliary
files — a template that silently dropped them would be worse than one that refuses.

Deliberately out of scope, each for a reason on the ticket: **webhooks** (a slug, an HMAC secret
and a delivery URL Jira points at one host — cloning to three means one is real and two are dead
config), **cron jobs** (three machines run the nightly job three times) and
**`planner_tool_approvals`** (a record of a *decision made*, so templating one would manufacture
consent nobody gave on that host). Known limitation: a per-host secret is re-entered on every
re-provisioning, which is the deliberate cost of the invariant below.

### Hub credentials (PA-63)

The second credential class, and the first addition to `auth/` since the session cookie.
`POCKETAGENT_AUTH_TOKEN` is the *root* credential — it exchanges for a session, and a session is
terminal access as this user — so a Hub fronting five backends by storing five master tokens is
five machines rooted permanently by one Hub compromise, with no revocation short of editing five
`.env` files and re-pairing everything. `POST /api/auth/hub-bind` takes the master token once
and returns a named, revocable credential; `GET /api/auth/hubs` and `DELETE /api/auth/hubs/:id`
are the property the master token cannot offer, which is visibility and a way to cut one off.

**It is not a permissions model, and saying so is part of the design** — a hub credential is
full-access, exactly like a session, and narrowing what one may *do* was explicitly ruled out of
scope on the ticket rather than forgotten. What follows from that is the one accepted cost: a
Hub can revoke its siblings, because it can reach every route. That is denial of service, not
escalation, and it still cannot *mint* — `hub-bind` takes the master token only, so a compromised
Hub cannot give itself a credential that survives the revocation of the one it was holding.

Three things make it cheap, and each is load-bearing rather than incidental. The check lives in
`app.ts`'s **single** `onRequest` gate beside `validateSession`, so no route learns a second auth
path and the WebSocket upgrade — a Hub proxying a terminal is the whole point — is covered for
free. The carrier is `Authorization: Bearer`, which is *already* on `REDACT_PATHS`, so "nothing
logs the credential" holds by construction rather than by a rule someone has to remember. And
`hub_credentials` stores `sha256(token)` rather than a `crypto/secret-box.ts` ciphertext, which
is a deliberate divergence from the ticket's own wording, approved on it: secret-box exists for
secrets this process must read back in plaintext (a provider's `ANTHROPIC_AUTH_TOKEN`, a bot
token it must send to Telegram), and the backend only ever *verifies* a hub credential. The
**Hub** side is the one that must replay it, so secret-box is right there — and since PA-66 it
is literally the same module, moved into `packages/node-kit` so both processes share one
implementation. Consequently there is no reveal
route and not even a reveal *decision*: past the bind response there is nothing to reveal, and
`token_prefix` — the leading characters kept in the clear — is what lets a list row be matched
against the token in hand.

### The MCP server (PA-118)

PocketAgent is an MCP *client* (`planner/mcp/`, PA-37 — a Pocket Agent calling someone else's
tools) and, since PA-118, an MCP *server*: another agent — Claude Code, Codex, a CI job, another
PocketAgent — connects to `/mcp` over Streamable HTTP and uses this machine the way a person
does. `apps/server/src/mcp-server/` holds all of it (`server.ts` the endpoint and its sessions,
`tools.ts` the catalog, `work.ts` the work-starting half, `internal-api.ts` the in-process route
client), beside `auth/mcp-tokens.ts`, `routes/mcp-server.ts` and
`packages/protocol/src/mcp-server.ts`. The tools are listed in `MCP_TOOLS`: `read` (projects,
sessions, transcripts, conversations, Pocket Agents, cron, webhooks, usage, worktrees, pending
approvals, a session's git diff), `sessions` (`start_session`, `send_prompt`, `wait_for_turn`,
`run_coding_task`, interrupt, stop), `planner` (create, message, wait on and interrupt a Pocket
Agent chat; `run_pocket_task`) and `admin` (project folders, worktrees, hiding and clearing
chats). Transcripts are also subscribable MCP resources, and the global skills are MCP prompts.

**`/mcp` is outside `/api/`, which is exactly what made it dangerous.** The gate's first line
returns early for every non-`/api/` path — that is how the SPA shell stays public — so a route
added at `/mcp` would have been unauthenticated remote code execution, and the not-found handler
would have answered its neighbours with a 200. The gate therefore names `/mcp` (and the
`/api/mcp` alias) by **exact match**, never a prefix: `/mcp/x` and `/mcpx` are still the shell,
and a test pins both directions. The alias exists only because a Hub proxies `/h/<id>/api/**`;
through a Hub it carries the Hub's own credential, so a remote agent connects to the backend
directly. `PUBLIC_API_PATHS` and `/api/hooks/` still enumerate the unauthenticated surface
exactly — `/mcp` is authenticated, it just had to be told so.

**A third credential class, scoped, and accepted on one endpoint only.** `pam_` tokens are
`hub_credentials`' twin (`sha256(token)`, a clear prefix, no expiry, no reveal, read fresh on
every request so revocation needs no restart, minted by a cookie session and never by an MCP
principal so a leaked token cannot mint its successor). Two things differ. A token carries
**scopes** (`read`/`sessions`/`planner`/`admin`, admin off by default) — a permissions model,
which PA-63 declined for hub credentials, justified here by who holds the token: a Hub is the
operator's own infrastructure, an MCP token is pasted into a third party's config file. And a
`pam_` token is accepted **only on the MCP endpoint**: on `/api/projects` it is a 401, or every
token would also be a full REST credential and its scopes would mean nothing. The master token
is never an MCP credential, and a cookie is not either (no MCP client holds one, and an ambient
credential on an endpoint that starts agents is CSRF surface for nothing). A hub credential is
accepted on `/mcp` with full scopes, since it is already full-access.

**Dual-era: MCP 2026-07-28 and every 2025-era revision, on one endpoint.** Revision
2026-07-28 ("modern") made MCP stateless — no `initialize`, no `Mcp-Session-Id`; every request
carries its version and client capabilities in `_meta`, `server/discover` advertises the server,
an unsupported version is a `-32022` error naming the supported ones (the client retries), and
change notifications moved to a `subscriptions/listen` POST stream. Every earlier revision
("legacy", 2025-11-25 back to 2024-10-07) negotiates once in `initialize` and holds a session.
Claude Code and most clients in the field are still legacy, so the server serves both, on the
**v2 SDK** (`@modelcontextprotocol/server`, and `@modelcontextprotocol/client` for the outbound
side below; v1 `@modelcontextprotocol/sdk` remains a dependency only for test fixtures, the legacy client in `pnpm demo:mcp` and the
zod→JSON-Schema helper). The routing decision is the SDK's own classifier
(`isLegacyRequest` — the exact code `createMcpHandler` runs), never a second copy here. Modern
requests go to a `createMcpHandler(..., { legacy: 'reject' })` held **per principal**, which is
what lets a revocation close that principal's listen streams and nobody else's. Legacy requests
keep stateful sessions on v2's sessionful `WebStandardStreamableHTTPServerTransport` — deliberately
*not* the SDK's stateless legacy fallback, which answers the session `GET` with 405 and would
silently break `resources/subscribe` for every legacy client. Both eras build their `McpServer`
from one `buildServer`, so a tool cannot exist in one era and not the other; the catalog's zod
shapes are converted to JSON Schema once (`fromJsonSchema`) so both validate identically. Two
SDK behaviours worth knowing: `initialize` echoes a requested legacy version it supports and
counter-offers `2025-11-25` otherwise, and `server/discover`'s `supportedVersions` (and the
`-32022` list) name only the modern revisions, even in the SDK's own dual-era mode — legacy ones
are negotiated in `initialize`, not advertised. `mcp-server.test.ts` runs every behavioural block
in both eras (v1 client for legacy, v2 pinned to 2026-07-28 for modern) plus wire-level
negotiation tests. A legacy session id is never a credential on its own: every request still
passes the gate with its own bearer, and one whose principal differs from the session's is
answered as if the session did not exist. Every tool call (either era) re-reads the principal, so
a revoked token or narrowed scope stops working on its next call, and revocation closes the
principal's sessions and listen streams immediately (`McpServerService.revoke`). Legacy sessions
are capped per principal and expire idle; none of it holds work, which is why `preClose` simply
closes everything.

**Tools that mirror a route call the route** (`InternalApiClient`). PA-70's rule — provisioning
is the Hub being an API client, not a new contract — applied from inside the process:
`delete_worktree` sits on forty lines of route logic, and a second copy is the thing that drifts.
The call is `app.inject()` with a single-use 256-bit nonce, registered against the MCP principal
and consumed by the gate, which honours it **only when `request.raw` is not an
`http.IncomingMessage`** — only `light-my-request`'s synthetic request qualifies, so a network
request carrying the header gets nothing. The principal is the MCP client's own, so a route's
`auditConfigChange` writes `mcp:<label>` at `warn`, as it does for a Hub. Tools with no route
(prompting, waiting, interrupting, Pocket Agent turns) compose services directly.

**Work goes through the paths that already exist, with nothing relaxed.** `start_session`
reuses `structuredAgentProblem` (structured only; an attended-only provider refused unless it
allows unattended use), re-resolves the cwd for containment, mints any branch name, and sends the
prompt through `PromptQueueService.submit` — so a prompt into a tree another session is mid-turn
in queues visibly behind it, and there is no `force`. Prompting a session a human is using is
allowed (decided on the ticket); stopping or interrupting one is not — only the client that
started a session may (`mcp_owned_work`, which is also the home screen's `mcp` badge). Pocket
Agent turns follow `startPocketAgent`'s observe-before-`next()` shape, never pass
`skipToolApprovals`, and inherit the planner's gate unchanged. Caps: three live sessions per
client, and all MCP sessions together stay below `maxSessions` minus the two slots webhooks
already reserve for a human. A depth guard (`MAX_MCP_CALL_DEPTH`) stops PocketAgent calling
itself through its own MCP registry in a loop — PocketAgent's client sends the depth in each
`tools/call`'s `_meta` (it connects once per call but serves many chats, so depth belongs to the
call). It is a loop guard, not a boundary; the caps are what bound a hostile caller.

**`wait_for_turn` has a timeout; a turn never does.** States are `complete`,
`awaiting_approval`, `queued`, `still_running` and `ended`. `still_running` ends the *wait*.
`awaiting_approval` names the tool and says a human must answer — there is no approve tool, no
decision field anywhere in the catalog (`mcp-server.test.ts` greps the input schemas for one),
and the turn stays parked until a person answers in PocketAgent.

Nothing about a tool call's arguments or results is logged — prompts and transcripts sit with
terminal I/O. Each call logs its name, principal, era, duration and outcome. Known limitations: no
OAuth (clients send a static bearer header, which Claude Code and Codex both accept); a Hub-level
`/mcp` aggregating every host is a follow-up; a coding agent started over MCP that is itself
configured to call `/mcp` sends no depth, so only the caps bound that loop.

**The outbound client negotiates too, and caches the answer** (`planner/mcp/client.ts`,
`McpRegistryService`). A Pocket Agent's MCP registries use the v2 client with
`versionNegotiation: 'auto'` on `streamable_http`: a definitive modern `server/discover` answer
selects 2026-07-28, anything else falls back to `initialize`, byte-equivalent to the old v1
client, so no server that worked before stops working. `sse` is the deprecated HTTP+SSE
transport, legacy by definition, and never probes. Because `McpClient` is one connection per tool
call, probing every time would put a round trip in front of every call; the spec says a client
SHOULD cache the era per server, so the verdict is stored on the registry row
(`protocol_era`/`protocol_version`/`protocol_discover_json`/`protocol_checked_at`) and handed back
as the SDK's `prior` — a cached modern verdict adopts the stored `DiscoverResult` with zero round
trips, a cached legacy one skips the probe. The cache is a cache: Test/Refresh always re-probe; a
URL, transport or auth change clears it; a modern verdict that fails to connect is dropped and the
connection retried on a fresh probe (connecting runs no tool, so that is always safe); and a
legacy verdict expires after `LEGACY_ERA_VERDICT_TTL_MS` (a day), because — the SDK's own warning —
a stale modern verdict fails loudly but a stale legacy one succeeds silently forever, so an
upgraded server would otherwise never be noticed. A `tools/call` that fails under a cached modern
verdict clears it, and is retried **only** when the error proves the server refused the protocol
(`ERA_REJECTION`: `-32022`, method not found, or the 400 `Bad Request: Server not initialized` a
real 2025-era SDK server answers a handshake-less request with) — any other failure may have
happened after the tool ran, and a mutating tool must never run twice because a retry guessed.
The negotiated revision is shown on the registry row in Settings. `mcp-client-negotiation.test.ts`
drives both directions against real servers: this app's own dual-era `/mcp`, and the v1 test
server in `helpers-mcp-server.ts`, a genuine 2025-era server.

### Hub Web Push fan-out (PA-73)

The browser's service worker registration is per-origin: a browser visiting the Hub connects
to the Hub's origin, not to individual backend hosts. Having each backend manage its own
push subscriptions and VAPID keys meant only the default backend or whichever host matched the
origin could deliver notifications, leaving multi-host setups without notifications for background
approvals or session updates.

**Option A architecture: The Hub owns push subscriptions and relays notifications.**
- **The Hub owns the VAPID keypair and subscription store:** `apps/hub` generates and persists
  its own VAPID keys in `hub_push_keys` and stores client push subscriptions in `hub_push_subscriptions`
  (migration #2). The browser registers for push via the Hub's native `/api/push/*` routes (`/api/push/key`,
  `/api/push/subscribe`, `/api/push/unsubscribe`, `/api/push/status`, `/api/push/test`).
- **Backends expose a push events stream:** `GET /api/push/events` on `apps/server` provides an
  authenticated Server-Sent Events (SSE) stream (protected by bearer token or `pah_` hub credential).
  To ensure notifications are not missed across reconnections or Hub restarts, connecting clients
  receive an immediate replay of all currently pending approvals, followed by live broadcasts.
  A 15-second heartbeat comment keeps proxy connections alive.
- **Push Notification Relay:** In `apps/hub/src/push/relay.ts`, `PushNotificationRelay` maintains
  persistent SSE connections to all bound backends using their encrypted host credentials.
  When an event is received from a backend:
  - Deep links (`url`) are rewritten from `/#/s/<sessionId>` to `/#/h/<hostId>/s/<sessionId>` so clicking
    the notification navigates directly to the relevant session on that host.
  - Notification tags are namespaced as `<hostId>-<tag>` to avoid accidental collision or dismissal
    across different hosts.
  - Notification titles are prefixed with `[<hostLabel>]` so the operator immediately recognizes which
    machine needs attention.
  - Connection health per host (`connected`, `reconnecting`, `unsupported`, `unauthorized`, `unbound`,
    `disabled`) is reported by `GET /api/push/status`. The UI's `PushToggle` component displays a warning
    badge if any bound host is offline or unsupported, ensuring push gaps are never silent.
- **Backward compatibility:** In standalone deployments without a Hub, `apps/server` continues to handle
  VAPID keys and push subscriptions via its existing `/api/push/*` endpoints.

### The Hub's own view, and network discovery (PA-110)

A Hub used to have no UI of its own: it served the backend bundle unmodified, so a Hub with no
hosts rendered "New chat", Settings, Cron and the rest, every one of them talking to a default
host that did not exist. The fix is a **third selection** beside "all hosts" and "one host": the
Hub itself — a **Hub** tile first in `HostRail`, the first entry in `HostSheet`, and a
host-less `#/hub` route (`HubPage`) beside the existing `#/hub/templates`.

**`hosts/hub-view.ts` is the one place both layouts ask.** `hubViewActive(source, hostCount,
route)` is true only behind a Hub, and then either for a Hub route or for **a Hub with no hosts
at all** — there every host surface is a dead end, so the Hub page is the home screen. That case
is also *written to the URL* (`App`'s hostless effect navigates to `#/hub`), not merely rendered
as a fallback: otherwise adding the first host from that very page flips the view to "all hosts"
mid-task, which the browser demo caught. With the Hub selected the desktop sidebar is
`HubSidebar` (Overview, Config templates, the host list as a way out) and the tab strip is not
rendered on a hostless Hub, since a restored tab there has nothing to talk to.

**The overflow menu follows the selection, and `overflowMenuItems` decides it.** Hub selected:
Hub items only (hosts overview, add host, templates). A host selected: that server's items only
— which in hub mode means *no* "Hosts…", because host management is the Hub's and a server menu
offering it again is the mixing the ticket asked to end; a standalone install keeps "Hosts…",
since it has no Hub tile and it is the only way a single-host desktop registers a second.
`OverflowMenu` renders from that list with a handler map and skips any id without a handler, so
the rule is one tested function rather than two components' JSX. The Hub's config-templates card
moved off the *host's* Settings page onto `HubPage` for the same reason; the host Settings'
"Hubs" section stays, because it is that backend's own list of Hubs bound to it.

`HubPage` talks only to the Hub origin (`api/hub.ts`, `HostDirectory`) — never a host-scoped
client, since there may be no host. It shows each registry row as a card with the verdicts the
rail already computes plus the two only the Hub knows (credential held, push relay connected),
the host-management actions that used to live only in the sheet, templates, and a test push.

**Discovery is mDNS/DNS-SD, hand-rolled in `packages/node-kit/src/mdns.ts`.** Both halves live
there because the service type (`_pocketagent._tcp`), the TXT keys (`MDNS_TXT_KEYS` in
`packages/protocol/src/hub-discovery.ts`) and the TTLs are one contract between an advertiser in
`apps/server` and a browser in `apps/hub`. Hand-rolled for the `cron-expr.ts` reason: the subset
is small and fully specified, and no probing or conflict resolution is needed — instance names
are unique by construction (hostname *and* port). Four things were found against a real avahi
on stone-dev01 and are load-bearing:

- **Sends are serialised.** `dgram.send` is asynchronous while `setMulticastInterface` is not, so
  "set interface, send" in a loop sent every copy out of the *last* interface — a Docker bridge
  — and nothing on the LAN heard it. `close()` also drains the queue, or the goodbye is dropped.
- **Each multicast copy carries only its own interface's A record** (`MdnsPayload`'s builder
  form). Listing every address told LAN peers to dial `172.22.0.1`.
- **The SRV target is a name the advertiser owns** (`pocketagent-<host>-<port>.local`), never
  `<hostname>.local`: avahi publishes that, and a second publisher with a different address set
  is a conflict avahi resolves by renaming the machine.
- **The Hub ranks addresses** (`usableAddresses`/`preferredAddress`): avahi-style responders
  advertise `127.0.0.1`, `::1` and link-local IPv6 beside the LAN address. Link-local is never
  offered (no URL can carry a zone id); loopback is a last resort; an advertised address a
  packet actually arrived from wins, since that is evidence of a route.

The backend's advertiser is started from `server.ts` after `listen` (never `buildApp`, so no
test multicasts), is off by default, refuses a loopback bind with a warning, and advertises only
the bound address for a specific `HOST`. The Hub's `DiscoveryService` is on by default, and a
socket it cannot open is a `failed` *state* with a sentence, never a boot error. Discovered rows
are computed on read and never stored; `registeredHostId` matches a row on port, scheme and any
name the backend is known by. Known limitations: no IPv6 transport, no probing, and mDNS does
not cross routers or Tailscale — across a tailnet, hosts are still added by address. In Docker,
containers on one user-defined network hear each other with no host networking (verified on
stone-test01's `home-net`); the trap found there was Compose, not multicast: a project `.env`
only fills `${…}` in the compose file and is never passed into a container, so the variable
must be in the service's `environment:` (`docker/compose.hub.yaml` wires it as
`${PA_MDNS_ADVERTISE:-false}`), and a backend with no `hostname:` advertises its container id.

### Version drift and drain-then-exit restart (PA-69)

The safe shape of "the frontend can upgrade the backend": **the frontend detects and reports,
a supervisor applies.** The server never downloads or replaces its own code, and no request can
name what to install — `RestartRequest` carries one boolean and `admin-restart.test.ts` asserts
the schema has no other key, because a server that could be told which image to run would turn
"restart this host" into a grant strictly larger than the terminal access this app already
hands out, and one that survives every later revocation.

**The exit status is deliberately non-zero, and that is the load-bearing detail.** The ticket
assumed `Restart=always`; this repo's README recommends `Restart=on-failure` and production
uses it, under which a clean `exit(0)` is a *successful* exit that systemd correctly ignores —
so `POST /api/admin/restart` would have been a remote off switch on every deployment following
our own documentation. `RESTART_EXIT_CODE` is 75 (`EX_TEMPFAIL`, beside the 78 `EX_CONFIG`
already used for a bad config), which restarts under every supervisor policy that restarts at
all. The cost is one misleading "failed" line in the journal, so the drain logs why first.

`AdminService` (`admin/index.ts`) decides; `server.ts` acts. The split exists because
`buildApp` is what every test calls, so a `process.exit` reachable from it would kill the
runner: the *act* is a hook installed after construction (`setRestartHook`), the same
after-construction wiring `PlannerChatService.attachRunServices` uses. No hook means the route
answers 501 rather than pretending — a server that drains into no supervisor stays down until
somebody reaches the machine, which is the one failure here an operator cannot undo remotely.
The hook waits `RESPONSE_FLUSH_GRACE_MS` before closing, because `app.close()` tears down the
HTTP server and a 202 written after that reaches nobody.

**Occupancy is asked of two sources, because only one of them is a session.**
`SessionManager.midTurnSessions` shares its predicate — now the module-level `isMidTurn` — with
`busyTreeRoots`, so a drain and the run queue cannot disagree about what "busy" means; a drain
that was stricter would refuse forever, and one that was laxer would exit cleanly mid-turn.
`PlannerChatService.inFlightTurns` is the other, and it closes a real gap: a Pocket Agent turn
has no session, no cwd and no worktree (exactly why `RunQueue` never keys on one), so a check
consulting only the session manager would report "nothing in the way" and then destroy a live
webhook- or Telegram-driven turn with nobody watching. Its `activeTurns` map is a *count*
incremented past the synchronous preconditions and released in a `finally`; over-counting
refuses a clean restart, which `force` escapes, while under-counting silently kills work, so
the error direction is chosen. A turn parked on an approval blocks too, from `pendingTurns` —
sharper than for a session, since that map is in-memory only, so restarting does not pause the
turn and let someone answer later, it destroys the approval outright.

What is deliberately **not** a blocker, each because the work is in no danger: a queued webhook
delivery (`queued_spec_json`) and a queued human prompt (`session_prompt_queue`) are persisted
and left alone by the boot sweeps, so counting them would refuse a restart to protect work that
resumes anyway; and a terminal session, which has no end-of-turn signal, so an idle shell would
otherwise block every restart forever.

`GET /api/admin/drain-state` exists because the POST cannot be used to *look*: on a host with
nothing running, asking what is blocking would restart the server. The 409 carries `blockers`
for a `curl` caller, while the browser re-reads drain-state, since `ApiError` deliberately
carries only a code and a message.

**Drift is advisory; protocol incompatibility is blocking; they must stay distinguishable.**
`version-drift.ts` lives in the protocol package beside `protocol-negotiation.ts` and for the
identical reason — the browser's host list and `apps/hub`'s own will both draw this badge, and
a second copy of semver comparison is a second set of prerelease edge cases. `hostVersionStatus`
is the single place their precedence is decided (incompatible wins), because an unusable host
has a problem an "update available" badge would bury. Build metadata is ignored per semver §11,
which matters concretely: CI stamps a git sha there, so two hosts on one release must not read
as drifting. `0.0.0-dev` sorts below every real release by construction, which is why
`resolveServerVersion` chose it.

"Latest known release" has two sources: `HubHostListResponse.latestRelease` when a Hub reports
one, else `latestKnownVersion` over the hosts in the list — *evidence*, not authority, so a
standalone install and a uniformly-stale fleet both report no drift. That is honest, and the
alternative is this app querying a release feed on the internet. `withVersionDrift` fills
`HostRecord.drift` in a second pass, because drift is a property of the list and
`hostRecordFor` sees one host.

## Invariants

These are load-bearing. Several were bugs first.

- **Never answer a prompt for the user, unless they explicitly said so.** `permissionMode`
  stays `default` and `canUseTool` routes every call to the browser *by default*, and there
  is deliberately **no timeout** on a pending approval — an unanswered one must never decay
  into an allow. The one exception is `CreateSessionRequest.skipPermissions`, a per-session,
  off-by-default opt-in (`structured-session.ts` sets the SDK's `bypassPermissions` mode;
  `claude.ts` adds `--dangerously-skip-permissions` for the terminal transport). It must stay
  opt-in — never the default — and a session running with it must say so persistently in the
  UI (`SessionInfo.skipPermissionsEnabled`), not just at the moment it was created. There are
  exactly **two** documented overrides of the "never the default" half of that rule, both
  below (the global switch, and scheduled jobs); adding a third needs the same treatment
  rather than a quiet default flip.
- **The global skip-permissions switch is the one deliberate, operator-level override of the
  invariant above.** `POCKETAGENT_GLOBAL_SKIP_PERMISSIONS` seeds it at boot; the database
  (`settings.global_skip_permissions`, via `SessionManager.setGlobalSkipPermissions`) wins after
  that, toggleable at runtime over `PATCH /api/settings`. It is off by default and was added
  only because a specific operator asked for it with full knowledge of what it removes — it is
  not a pattern to reach for casually elsewhere. On: every new session (either transport) starts
  bypassed, and every currently *running structured* session is flipped live via the SDK's
  `setPermissionMode`, draining anything already parked waiting for a human. What it does **not**
  do: reach a terminal session already running — `--dangerously-skip-permissions` is fixed in
  argv at spawn, and `terminal/classifier.ts` must still never gain an answerable approval
  channel to fake a live toggle. `SessionInfo.skipPermissionsEnabled` for a structured session
  ORs in `StructuredSession.globalBypassActive` so the badge reflects live reality; `spec` itself
  is never mutated, so history and persistence still record what a session was actually created
  with.
- **A scheduled job is the second override, and the only place a skip-permissions *default* is
  on.** `CreateCronJobRequest.skipPermissions` defaults to `true` (`cron_jobs.skip_permissions`
  likewise) because a cron job is unattended by definition: there is nobody at 3am to answer an
  approval, so a job created the usual way would park on its first tool call and never finish.
  What is *not* relaxed is the half that matters — with the toggle off, a run that hits an
  approval waits **forever** (no timeout is added anywhere) and pushes a notification; an
  unanswered approval still never decays into an allow. Because the default is inverted, two
  things are mandatory and asserted in `apps/server/tests/cron.test.ts`: the editor shows a
  visible warning whenever it is on, and `CronJob.skipPermissionsEnabled` is surfaced
  persistently on the job row, the list, and every run — never only at creation. A job must
  never touch the global switch or leak its bypass into interactive sessions; it only ever sets
  `CreateSessionInput.skipPermissions` for its own run.
- **A scheduled job is always a structured session.** Enforced at the route
  (`routes/cron.ts` rejects an agent whose `transports` lacks `structured`), not merely
  defaulted, and `CreateCronJobRequest` has no `transport` field at all. Delivering a prompt to
  a terminal session means writing keystrokes into a TUI with no readiness signal and no way to
  tell a finished turn from a hung one — exactly the judgement `terminal/classifier.ts` is
  forbidden from making.
- **The scheduler never catches up on a backlog.** A firing more than `CATCH_UP_GRACE_MS`
  (1 hour) late records **one** coalesced `skipped` run and rolls forward from now
  (`cron/index.ts`). A week offline for an hourly job would otherwise fire 168 agents at boot —
  which is what the obvious `while (next <= now)` loop does — and recording all 168 as rows just
  moves the storm from processes into the run list. Inside the grace window it fires once, so a
  `systemctl restart` at 08:59:58 does not lose the 09:00 run.
- **A wedged run is detected by asking whether its session is alive, never by a timeout.** The
  overlap check counts only runs whose session is still `starting`/`running`. A "stale run"
  timeout would kill a legitimately long turn, and a run parked on an unanswered approval is
  *genuinely still running* — force-failing it is the same disrespect for an undecided decision
  the no-timeout rule exists to prevent.
- **A repeating job must never store a literal git branch name.** `branchMode: 'new'` with a
  fixed name succeeds exactly once and then throws `branch_exists` forever, so
  `cron/index.ts` mints `<slug>-<YYYYMMDD-HHmm>-<hex>` per run, stamped in the job's own zone.
- **Deleting a scheduled job keeps its run history.** `cron_runs.job_id` is `ON DELETE SET
  NULL`, and `job_name`/`agent` are copied onto every run row so an orphan still describes
  itself — the same discipline that stops "Remove" from deleting a transcript. `session_id` is
  deliberately *not* a foreign key: `pruneOldSessions` and `SessionManager.forget` delete
  session rows out from under it, so a CASCADE would quietly destroy history and a RESTRICT
  would make pruning fail.
- **An inbound webhook is the third override of the skip-permissions rule, and it is the one
  that goes the other way.** `CreateWebhookRequest.skipPermissions` defaults to **`false`**,
  unlike a scheduled job's `true`. Cron's rationale has two halves — nobody is awake at 3am,
  which transfers, and *the operator wrote the prompt*, which does not: a webhook's prompt is
  built partly from text a stranger typed into a Jira ticket, and in a Service Desk project
  that stranger can be an anonymous customer. Inheriting the inversion would be exactly the
  quiet default flip the first invariant forbids, on the one path where the prompt is not
  ours. What *is* inherited is the disclosure discipline: the editor warns more strongly than
  cron's does, `Webhook.skipPermissionsEnabled` is surfaced on the list row, the project-tree
  row and **every delivery**, and the value is copied onto the delivery row at delivery time so
  turning the toggle off later does not retroactively make last week's bypassed deliveries look
  supervised. Asserted in `apps/server/tests/webhooks.test.ts`.
- **A webhook's `agent` has one value space, and only the route knows what is in it.** A
  coding-agent id and a Pocket Agent (`pocket:<plannerWorkspaceId>`) are both legal values of the
  same string (PA-10), so nothing downstream may infer the run kind from the *saved* `hook.agent`:
  a Jira `agent:` label can move a single delivery across that boundary in either direction, and
  `WebhookService.resolveAgent` is the one place that decides. The schema still validates only a
  bounded string, because which coding agents exist lives in the registry and which Pocket Agents
  exist lives in `planner_workspaces` — `webhookAgentProblem` checks whichever applies, and it is
  a *branch*, not a relaxation: the structured-transport requirement is meaningless for a planner
  chat, so what replaces it is "this planner workspace still exists". Cron is deliberately **not**
  widened; `CreateCronJobRequest` still accepts a coding agent only, and doing otherwise is its
  own decision with its own disclosure work. PA-26 adds the downstream half of this: a
  `per-issue` conversation is **owned by the agent that has been having it**, recorded in
  `webhook_issue_sessions.agent`, and a delivery whose effective agent differs starts a fresh one
  rather than resuming — an `agentSessionId` (or a Pocket Agent chat) is not portable across
  agents, so the old behaviour ignored the label exactly where it mattered most. `NULL` there
  means *unknown* and continues as before, never "mismatch".
- **A webhook delivery is authenticated over the raw request bytes, in constant time.**
  HMAC-SHA256 of the body exactly as received — never of a re-serialized parse, which validates
  cleanly in a unit test with canonical JSON and then fails on every real Jira payload, because
  `JSON.stringify` preserves key order but not whitespace, unicode escaping or number
  formatting. `routes/webhook-delivery.ts` therefore replaces its own content-type parsers
  inside its own plugin scope, and comparison goes through `safeTokenEqual`, which sha256s both
  sides first so a truncated or non-hex signature is a mismatch rather than a throw out of
  `timingSafeEqual`. The bearer fallback exists for senders that cannot sign, is off unless
  chosen per webhook, and authenticates nothing about the body.
- **Unknown slug, disabled webhook and bad signature are one response.** Same status, same
  body, and an HMAC against a dummy key on the unknown-slug path so timing does not answer what
  the status refuses to. `filtered` and `duplicate`, by contrast, answer 2xx: they succeeded,
  and a 4xx only makes Jira retry harder. Nothing here answers 5xx once the body has been read,
  because Jira Data Center does not retry and a 5xx loses the event permanently.
- **Replay is stopped by the body, never by the header.** `X-Atlassian-Webhook-Identifier` sits
  *outside* the signature, so keying idempotency on it means a captured delivery replays forever
  with a fresh identifier: the HMAC still verifies, the uniqueness index never fires, and an
  agent starts every time. The key is `sha256(rawBody)`, unique per webhook, and the insert *is*
  the claim — no read-then-write race, and durable across a restart as an in-memory set is not.
  The payload's own `timestamp` *is* inside the signature, so it is trustworthy where present;
  it is checked against a window with the observed skew logged on rejection, because
  "webhooks stopped working" with no diagnostic is the failure mode of a clock check.
- **Jira text is data, and it is fenced as data.** Only an enumerated allowlist of fields
  reaches the renderer — never a generic path walker, or any Jira admin, custom field or
  marketplace plugin could push content into the prompt through a path nobody reviewed. Free
  text is stripped of control, zero-width and bidi characters, truncated, and wrapped in a
  per-delivery nonce fence whose opener is removed from the content *first*, which is what makes
  the fence unclosable from inside. **The fence lowers the hit rate; it is not a boundary** —
  the boundary is the approval toggle and the worktree. Untrusted text reaches the prompt body
  and nothing else: not the branch name (minted server-side from the *validated* issue key, for
  the reason the repeating-job invariant already gives), not a path, not a session title, not a
  command.
- **Jira can never consume the last of `maxSessions`.** A webhook has no natural rate ceiling
  the way a cron ticker does: one bulk edit is hundreds of signed, filtered, entirely legitimate
  deliveries. Per-webhook and global caps hold the total strictly below `maxSessions` with slots
  reserved for a human, and a delivery over a cap is recorded and answered 2xx rather than 429 —
  a 429 provokes Jira's retry storm and eventually gets the webhook disabled at Jira's end.
  Both caps exclude the asking delivery's own row, because unlike a cron firing that row is
  inserted *before* the caps are checked (the insert is the idempotency claim), and counting it
  made every delivery throttle itself.
- **Deleting a webhook keeps its delivery history.** `webhook_deliveries.webhook_id` is
  `ON DELETE SET NULL`, with `webhook_name`/`agent`/`skip_permissions_enabled` copied onto every
  row so an orphan still describes itself, and `session_id` deliberately not a foreign key — the
  same reasoning `cron_runs` records. `webhook_issue_sessions` is the one webhook table that
  CASCADEs, because it is a cache rather than history.
- **The webhook secret exists in the database in plaintext and must not exist anywhere else.**
  HMAC is a keyed MAC, so verification needs the key material and "shown once" is a UX choice
  rather than a cryptographic one: it is returned at creation and from an explicit,
  rate-limited, logged `POST …/secret/reveal`, and never from a list or a get. Reveal and rotate
  are POSTs specifically so the Origin check covers them. The render context handed to the
  template engine has no field for it, and `x-hub-signature` plus the whole request body are on
  the logger's redact list — with bracket-quoted paths, because pino silently ignores a dotted
  path containing a dash.
- **The planner's tool-approval gate is the fourth override of the skip-permissions rule, and
  the first with per-tool, per-workspace-or-global granularity.** Every other override (the
  global switch, cron, webhooks) is all-or-nothing per session; a planner decision can instead
  be remembered for one tool in one workspace, or for one tool everywhere, in
  `planner_tool_approvals` — persistence none of the earlier three needed, because none of them
  had more than one kind of approval to ask about. The chat's transport is one-way — an SSE
  response stream down to the browser, no channel back up except a fresh request — so an
  unremembered mutating tool call cannot be answered mid-request the way
  `StructuredSession.requestPermission` answers one over a genuinely bidirectional WebSocket;
  `PlannerChatService` instead *pauses* the turn (yields a `permission_request` event and ends
  that leg of the stream) and a separate `POST /api/planner/chats/:id/approvals/:approvalId`
  resumes it. The invariant holds exactly the
  same way: nothing runs, and nothing decays into an allow, until that second request arrives —
  there is no timeout in this path either. Read-only tools (`list_workspaces`, `list_sessions`,
  `read_session_output`, `read_file`) are exempt from the gate entirely, a deliberate product
  decision (not a default assumed lightly) recorded against PA-6. `plannerYoloEnabled` is this
  override's own "skip everything" switch, checked live on every call — same "read the flag
  fresh" discipline `SessionManager.setGlobalSkipPermissions` uses — and it wins over even a
  remembered *deny*, but never writes one itself: turning it back off must not retroactively make
  every bypassed call while it was on look individually reviewed, the same reasoning that keeps
  cron's/webhooks' inverted defaults from quietly becoming the norm elsewhere.
- **`PlannerChat.skipToolApprovalsEnabled` is the fifth override, and the narrowest one yet**
  (PA-10). It pre-approves the mutating tool calls of **one chat**, because that chat was created
  by an unattended trigger — an inbound webhook, or (PA-53) a Telegram pairing an operator has
  explicitly opted in — whose own skip-permissions decision was already made. It is not a new
  decision, it is the existing one reaching the planner's gate: a webhook (or Telegram pairing)
  with the toggle *off* still parks its pocket turn on the first mutating call and waits
  **forever** for a human to answer, with no timeout added anywhere, which is exactly cron's own
  "unattended run waits forever" behaviour. Three things keep it from widening. It lives on the
  chat row rather than being threaded through a turn, because it has to survive an approval
  pause, a restart and a `per-issue` webhook reusing the chat — but that row can only be written
  by the server: `CreatePlannerChatRequest` has **no such field**, so no browser can mint a
  pre-approved chat, and `apps/server/tests/webhooks-pocket.test.ts` asserts that a client asking
  for one is ignored. It short-circuits *before* the remembered-decision lookup and, like yolo,
  **never writes one** — turning the toggle off later must not leave the tool looking
  individually approved for everyone. And it is disclosed persistently: `PlannerChatPage`
  renders a standing callout on every visit, per the first invariant's "not just at the moment it
  was created" (Telegram's own disclosure is the pairing row's persistent "skip approvals" state
  in Settings, per the sixth override below).
- **Telegram approval relay is the sixth override, and it goes the other way from webhook's
  default** (PA-53). A webhook chat is unattended *by definition* — nobody is watching to answer
  an approval, so its own override (above) defaults toward not asking. A Telegram-paired chat has
  exactly the human it's paired to, present the whole time it's talking to the agent — the
  premise of "just like web UI" the ticket asked for — so inheriting the webhook default would be
  exactly the quiet default flip the first invariant forbids, on a channel where a human genuinely
  is there to answer. `telegram_links.skip_tool_approvals` therefore defaults to **off**, and a
  `permission_request` instead becomes a real inline-keyboard message
  (`TelegramBridge.sendApprovalPrompt`) offering the same four choices the web UI's own card does;
  a `callback_query` reply resolves it through the identical `PlannerChatService.resolveApproval`
  path a browser's `POST .../approvals/:id` would use — no timeout, same as every other approval
  in this app. The per-pairing opt-in is explicit, off by default, and surfaced persistently on
  the pairing row in Settings — an operator who deliberately wants one paired id to run
  unattended sets it there, and it reuses the *fifth* override's own field/mechanism
  (`PlannerChat.skipToolApprovalsEnabled`) rather than inventing a second one.
- **One agent per working tree, and occupancy is derived rather than leased.** `RunQueue`
  (`runs/queue.ts`) keys on `treeRootOf` — the working tree, so a cwd below a tree root rolls up
  to it, and a run in `<project>` deliberately does **not** conflict with one in
  `<project>/.worktrees/x` (separate checkouts; blocking across them would serialize the
  parallelism worktrees exist for). A tree is busy because a live structured session in it is
  mid-turn (`busySince`), never because a row says so, so a crash cannot strand a lock and
  "concludes" means exactly `turn_complete` — a session that is alive but waiting for you holds
  nothing. The only stated claim is the start-window grant, handed back by `RunQueue.started` as
  soon as a session exists; keeping it would block a tree whose session died unnoticed.
  `tryAcquire` is synchronous from check to claim and must stay so — an `await` between the two
  gives one tree to two runs. Runs that mint their own directory take no key and never queue, and
  neither does a **Pocket Agent** delivery (PA-10): it has no cwd, no worktree and no session, so
  there is no checkout to contend for and nothing this queue's derived occupancy could observe.
  Two pocket runs in one planner workspace can still touch the same scratch files; serializing
  that would need occupancy derived from in-flight pocket runs rather than sessions.
- **A queued delivery is a third class of row, in neither `OPEN_DELIVERY` nor
  `NOISE_STATUSES`.** It holds no session, so counting it in `capReason` makes a queue throttle
  itself, force-failing it in `markStaleWebhookDeliveriesFailed` destroys work already answered
  202, and pruning it discards that work silently — but it *must* be visible to
  `hasActiveRunFor`, or a third delivery jumps the line. All four are asserted in
  `apps/server/tests/webhooks.test.ts`. Queueing answers **2xx immediately** and never holds the
  connection: Jira Data Center does not retry usefully, and a held connection is a timeout in
  disguise.
- **The queue has no timeout, and exactly one override.** A run parked on an unanswered approval
  is genuinely still working, so it keeps its tree and waiters wait indefinitely — the same
  no-decay rule the approval invariants state, which is why every waiter is visible in the
  project tree and individually cancellable. A webhook's "run next" only reorders waiters;
  the sole bypass of tree occupancy anywhere is `force` on a *human's own* queued prompt
  (`sessions/prompt-queue.ts`), available only where a person is present to own it. A queued
  human prompt must never be silent (`prompt_queued`, replayed on attach), never be lost (it is
  persisted), and a full queue *sends* it rather than dropping it — the depth cap exists to bound
  a machine burst, and a person pressing send is not that.
- **`/health` is the only unauthenticated *read*, and nothing sensitive may be added to it.**
  It stays public because a Hub has to decide whether a backend is usable *before* it can
  present a credential to it (PA-61) — so `version` and `protocol` are readable by anyone who
  can reach the port, which is a deliberate decision rather than an oversight: the old
  hardcoded `0.1.0` disclosed nothing, and a real semver tells a caller exactly which build,
  and therefore which known bugs, they are looking at. That is the whole budget. A git SHA,
  build host, Node version, path or config value belongs behind the cookie (`/api/hosts`, or
  the settings snapshot), and `health.test.ts` asserts the response has exactly four keys so
  adding a fifth is a decision someone has to make on purpose. `HealthResponse` is also now
  load-bearing rather than decorative — the handler's return type is annotated with it and the
  browser's probe parses it — because it sat unused long enough for its neighbour
  `ProjectListResponse` to silently drift from the route it describes.
- **A protocol mismatch is a per-host state, never a global fatal.** One incompatible host
  must leave every other host, and everything already on screen, fully usable — so the
  incompatibility renders as a notice above the three home-screen categories (both layouts)
  plus a third `host-dot` state, never in place of the list. `FatalClose.hostId` is what makes
  that possible, and `ConversationWatchConnection` had to be fixed to honour it: it shipped
  with no `PROTOCOL_MISMATCH` branch at all and reconnected forever on a backoff, invisibly,
  because a chat preview draws no connection state.
- **The server never replaces its own code, and no request may name what to install** (PA-69).
  A process that replaces itself has no supervisor left to replace it, so `POST
  /api/admin/restart` only ever *drains and exits* and something outside starts it again on
  whatever image its unit already pointed at. `RestartRequest` has exactly one field, `force`,
  and a test asserts that — the update source is fixed at deploy time, and a UI that could name
  an image would be a larger and less revocable grant than terminal access. Three things hold
  the rest of it up. The exit status is **non-zero** (`RESTART_EXIT_CODE`, 75), because
  `Restart=on-failure` — the README's own unit, and production's — ignores a clean exit, so
  `exit(0)` would make this a remote off switch; with no restart hook installed the route
  answers 501 instead of exiting into nothing. A restart **refuses by default while anything is
  mid-turn and names it**, asking both `SessionManager.midTurnSessions` (sharing `isMidTurn`
  with the run queue, so the two cannot disagree) and `PlannerChatService.inFlightTurns` (a
  Pocket Agent turn has no session and is invisible to the first). And there is **no timeout**:
  a blocked request keeps refusing until the work ends or a human passes `force`, which is the
  same single override `force` has on a queued prompt and the same no-decay rule every approval
  path here follows. Asserted in `apps/server/tests/admin-restart.test.ts`.
- **A hub credential is a second principal, never a second root** (PA-63). `POST
  /api/auth/hub-bind` is the only new way to obtain one, it takes the *master* token (rate-limited
  and Origin-checked exactly as `login` is, since `PUBLIC_API_PATHS` skips the gate for both), and
  what it returns is full-access — deliberately, because the win is revocability rather than
  least-privilege. Four things hold it in place. The master token is **never** accepted as a
  bearer credential, or the unrevocable root credential this removes would be straight back. The
  gate is `app.ts`'s one `onRequest` hook, so every route including `/api/ws` accepts a hub
  credential and none of them knows it exists. The stored form is `sha256(token)` and nothing
  else — no ciphertext, no reveal route, so a copied `pocketagent.db` yields nothing presentable,
  and an audit line (`hubId`/`label`, never the token) is not one step from recovering one.
  And **validation reads the row on every request with no cache**, which is the whole reason
  revocation is immediate with no restart: an in-memory roster would be a faster wrong answer,
  the same "read the flag fresh" discipline `setGlobalSkipPermissions` follows. A hub credential
  has no `expires_at` (revocation is its only lifecycle, so no sweep may delete one) and lives in
  its own table, so nothing that clears sessions touches it. The accepted cost, stated because it
  is a real one: a compromised Hub can revoke its siblings — denial of service, not escalation,
  since it cannot mint. All of it is asserted in `apps/server/tests/hub-credentials.test.ts`.
- **The Hub never proxies a backend's unauthenticated surface, and `/api/hooks/*` is the
  entry that matters** (PA-66). `PROXY_DENY_PREFIXES` (`apps/hub/src/proxy/allowlist.ts`)
  covers every member of the backend's own `PUBLIC_API_PATHS` plus the dynamic `/api/hooks/`
  prefix, so the statable rule is *nothing unauthenticated on a backend is reachable through
  `/h/`*. Hooks is listed separately with its own reason because its reason is different and
  larger: re-exposing it would break the standing guarantee that `grep '/api/hooks/'`
  enumerates the whole dynamic unauthenticated surface, and would make the Hub inherit the
  entire slug-enumeration-oracle design — one indistinguishable response for unknown slug,
  disabled webhook and bad signature, HMAC over raw bytes, a dummy-key hash on the unknown
  path. None of that is reimplemented in the Hub because none of it is reachable there: Jira
  delivers straight to the backend. The check **decides on the decoded path and forwards the
  raw one** — deciding on the raw string alone lets `/api/%68ooks/foo` through — and refuses
  `%25`, a backslash or a dot segment outright rather than canonicalizing. Asserted in
  `apps/hub/tests/proxy-allowlist.test.ts`, including that the backend is never *dialed*
  rather than merely that the status is 404. A path check is only half of it, though: the
  **body has to be framed explicitly** or the allowlist can be walked straight past. Stripping
  the client's `content-length`/`transfer-encoding` (both per-hop, so stripping is right) and
  piping the body leaves framing to Node, which does not add chunked encoding for `GET`,
  `HEAD`, `DELETE`, `OPTIONS` or `TRACE` — so the body goes out unframed on a pooled keep-alive
  socket and the backend reads it as the *next* request. A body of
  `POST /api/hooks/evil HTTP/1.1…` then executes having passed through no deny list and
  carrying no credential. `bodyFramingFor` (`proxy/headers.ts`) states the framing on every
  request instead, and `proxy-headers.test.ts` reproduces the smuggle. The host id is likewise
  parsed from *both* spellings and required to match, because taking it from the decoded path
  and slicing the raw one with that offset desynchronises the path that was checked from the
  path that is sent.
- **The Hub is a dumb pipe for the WebSocket, as a property of the code rather than a rule**
  (PA-66). "Terminal I/O is never logged or persisted" has to hold in a second process, so
  `proxy/ws.ts` splices at the TCP level: it dials the backend with `node:http`, relays the raw
  101 head, and `pipe()`s the two sockets. There is **no WebSocket library on that path** — no
  frame parser, no `permessage-deflate` negotiation of its own (the extension header passes
  through, so compression is agreed end to end and the Hub could not decompress a frame if it
  tried), no buffering and nothing that could log one. What *is* rewritten is stated rather
  than hidden: the handshake head, because the Hub must strip `Cookie`/`Origin` and attach the
  host credential. Two mistakes here are silent and were both made and caught:
  `clientSocket.unshift(upstreamHead)` instead of `upstreamSocket.unshift(upstreamHead)` sends
  the backend's first frame back to the backend, and destroying the peer socket on `close`
  rather than letting `pipe()` end it truncates the close frame — which turns PA-61's 4001
  protocol mismatch into a 1006 and silently restores "reconnect forever". Both are asserted in
  `apps/hub/tests/ws-splice.test.ts`, alongside byte identity for a 1 MB binary frame and a
  compressed one.
- **The Hub strips `Origin` upstream, so the CSRF boundary moves rather than disappearing**
  (PA-66). `isOriginAllowed` falls back to comparing the Origin's host against the `Host` the
  request was routed to, which for a proxied request is the backend's — so forwarding the
  browser's Origin 403s every non-GET while every read keeps working, a failure that presents
  as a permissions bug. Stripping it lands the request in the "no Origin, not a browser" branch
  the backend's gate already documents as the Hub's case. The check itself is run by the Hub's
  own single `onRequest` gate, which is where the ambient cookie actually is. `Cookie` is
  stripped for the same one-way reason, and `Set-Cookie` is stripped on the way back.
- **The Hub holds no root credential and answers to no bearer** (PA-66). A master token exists
  in the bind request body, is spent on exactly one call to that backend, and is never
  persisted — `bind.test.ts` scans every column of every row to prove it. What is stored is the
  minted `pah_` credential as a `secret-box` ciphertext plus its prefix in the clear; a row that
  will not decrypt (a rotated `POCKETAGENT_SETTINGS_ENC_KEY`) is **listed, marked unbound and
  refused** rather than dropped from the list or dialed without a credential. The Hub itself
  accepts only its own session cookie — it presents credentials and does not take them, so there
  is no bearer path to front a Hub with, and `POCKETAGENT_HUB_AUTH_TOKEN` is deliberately a
  different variable from any backend's `POCKETAGENT_AUTH_TOKEN`. Removing a host *attempts*
  revocation on the backend and reports whether it worked, but never blocks on it: a machine
  that is down is precisely when an operator most wants it gone.
- **A template never carries a secret, and the Hub never stores one** (PA-70). The template
  tables have **no column a secret could go in** — not a plaintext one and not a
  `secret-box` ciphertext — so "no secret value is ever stored in a template" is a property of
  the schema rather than a rule someone has to keep remembering, and
  `apps/hub/tests/templates-secrets.test.ts` proves it by scanning every column of every row.
  A template declares its *secret-shaped holes*; the values arrive in one instantiate request
  body (redacted wholesale by the Hub's pino config, which is what makes `req.body` on
  `REDACT_PATHS` load-bearing rather than decorative), reach one outbound call each, and are
  gone when the response returns. The rejected alternative was storing the filled holes
  encrypted per `(template, host)` so re-provisioning is one click: that moves the Hub from
  "holds a revocable credential per host" to "holds every upstream key the fleet uses" — none of
  them revocable from this product — and makes one `POCKETAGENT_SETTINGS_ENC_KEY` the only thing
  between a Hub compromise and every third-party account behind it. The accepted cost is
  re-typing a key on re-provisioning, which is already the shape both editors use (blank keeps
  the stored one). Provisioning is also **logged on both sides**: the Hub writes one line per
  host per run, and the backend writes its own through `auditConfigChange` naming
  `hub:<label>` — that second one is the record that survives a compromise of the Hub that
  wrote the first, which is the threat the ticket's own security note names. The *level*
  depends on the principal: a Hub's change is `warn`, so it survives a deployment running at
  `LOG_LEVEL=warn`, while the same change made by a browser session is `info` — the agent
  editor auto-saves on every field change, and a `warn` per keystroke would bury the remote
  lines under local ones. Neither line ever carries a secret or a request body; they carry ids,
  names and field *names* only, the same "an audit line must not be one step away from
  recovering a credential" rule provider mutations already follow.
- **A template is provisioned, never synchronised, and an overwrite is always confirmed**
  (PA-70). There is no reconciliation loop anywhere: editing a template bumps its revision and
  writes to no host, and `hub_provisionings` keeps the revision each host actually received so
  staleness is *displayed* rather than corrected. Re-provisioning without an explicit
  `overwrite` is `skipped` and writes **nothing**; with it, the ledger's own `remote_id` is
  patched in place rather than a duplicate created. What `overwrite` never does is replace
  something this Hub did not put there — that is a `conflict` regardless of the flag, because
  no backend table constrains these resources' names and a name match could otherwise destroy
  work a human did on that machine. And nothing is written before a `GET` of the target
  collection has succeeded, so a build without the route is `unsupported` rather than
  half-provisioned. All four are asserted in `apps/hub/tests/templates-*.test.ts` and
  demonstrated end to end by `pnpm demo:provision`.
- **Web Push fan-out is owned by the Hub; the backend exposes an SSE push events stream**
  (PA-73). Browser push subscriptions are scoped to an origin, so a multi-host setup fronted
  by a Hub cannot have the browser subscribe to each backend directly. The Hub owns the VAPID
  keypair and browser push subscriptions (`hub_push_subscriptions`). Backends provide an
  authenticated SSE stream `GET /api/push/events` that replays pending approvals upon connection
  and broadcasts new ones. `PushNotificationRelay` maintains connections to each bound host,
  rewriting deep links to `/#/h/<hostId>/s/...`, namespacing notification tags (`<hostId>-`),
  prefixing titles (`[<label>]`), and tracking per-host push stream health. Disconnected or
  unauthorized hosts are reported at `GET /api/push/status` and surfaced as warning badges in
  the UI rather than silently dropping notifications. Crucially, terminal I/O is never sent or
  stored over this mechanism — only high-level approval/message notification metadata.
- **An MCP client can see an approval and can never answer one** (PA-118). `/mcp` exposes no
  tool that resolves a permission, and no tool input carries `skipPermissions`, `force`, a
  decision, an executable or an argv — asserted by grepping `MCP_TOOLS` in
  `apps/server/tests/mcp-server.test.ts`. A turn that needs approval reports
  `awaiting_approval` and waits, with no timeout, for a human in PocketAgent; `wait_for_turn`'s
  own timeout ends the wait, never the turn. An MCP-started session obeys exactly the approval
  gate a human-started one does, and an MCP-created Pocket Agent chat is never pre-approved. The
  planner's raw `exec_command`/`bash`/`write_file`/`rmdir` are not re-exported: MCP has no
  pause/resume, so they would be a remote shell with no gate. Agent installation and server
  restart stay unreachable from it, like from every other unattended trigger.
- **`/mcp` is authenticated by exact match, and a `pam_` token is accepted nowhere else**
  (PA-118). Both protocol eras pass this gate before the SDK sees anything — a modern request's
  `_meta` envelope authenticates nothing. The gate's early return for non-`/api/` paths would otherwise make `/mcp` public, so
  `MCP_SERVER_PATH`/`MCP_SERVER_API_ALIAS` are named exactly — a prefix would gate the SPA, and
  forgetting the line would expose an endpoint that starts agents. On the MCP endpoint only a
  bearer credential counts (an MCP token, or a hub credential); the master token and a cookie are
  401. Off it, a `pam_` token is a 401, so scopes mean something. Tokens are `sha256` digests,
  read fresh per request, minted only by a cookie session or a Hub — never by an MCP principal.
- **An MCP tool's in-process route call cannot be forged from the network** (PA-118).
  `InternalApiClient` authenticates `app.inject()` with a single-use nonce that the gate honours
  only when `request.raw` is not an `http.IncomingMessage`; a real request carrying the header
  falls through to ordinary authentication (asserted). The principal it resolves to is the MCP
  client's, so audit lines say `mcp:<label>`.
- **A queued Pocket Agent message never answers an approval, and only a person can queue one**
  (PA-122). A message sent while a turn is parked waits behind the approval and is delivered
  only after a human answers it; nothing about queueing resolves, denies or dismisses one, and
  there is still no timeout. `POST …/messages` keeps answering 409 for a busy chat, so no
  unattended trigger (cron, webhook, MCP) can steer a turn — only the web chat and a paired
  Telegram chat use the queue. Asserted in `apps/server/tests/planner-pa122.test.ts`.
- **A Pocket Agent's skill reaches a project tree only by a human's explicit export** (PA-55).
  No planner tool and no MCP tool exports a skill (asserted in `planner-skills.test.ts`), so the
  model's only way into a project is still `write_file` behind the approval gate. The export
  route copies regular files only, never through a symlink at either end. It writes nothing on a
  collision without a confirmed overwrite, and its audit line carries ids and paths, never the
  skill's body.
- **An mDNS advertisement carries nothing `/health` does not, and discovery never registers
  anything** (PA-110). `advertisedTxt` is a version, a protocol range, a role, a scheme and a
  TXT format number — `/health`'s budget — and `mdns-advertise.test.ts` asserts the exact key
  set, because an advertisement reaches every machine on the LAN whether or not it can connect.
  Advertising is off by default and refused on a loopback bind: binding to a network address
  and announcing it are two separate disclosures, and each must be deliberate. On the Hub side a
  discovered backend is only ever a suggestion — rows are computed per read and never stored,
  "Add…" is the ordinary `POST /api/hub/hosts` with its URL validation, and binding still takes
  that backend's master token — so a forged advertisement (mDNS is unauthenticated by nature)
  can at worst put a wrong row in front of a human. `GET /api/hub/discovery` sits behind the
  Hub session like every other `/api/hub/*` route, and its refresh is a POST so the Origin
  check covers it.
- **A live-listen utterance is never silently discarded, and barge-in commits
  only after the harness has judged it** (PA-85). The mic is open with no
  intent signal, so a filter is unavoidable — but the filter's own mistakes
  must be visible and recoverable, which is why the verdict has three values
  and not two: `drop` always names a reason in the UI, and the borderline case
  is *parked in the composer* rather than thrown away. A silently dropped
  command reads as a dead microphone, which is a worse failure than the filler
  prompt the harness exists to stop, and it is the failure a two-valued filter
  inevitably produces. Two things follow and must not be quietly reverted. The
  audio gate may only ever get *stricter* than its configured absolute
  thresholds (the adaptive noise floor is a `max`, so a quiet room behaves
  exactly as it did before), and `minSpeechMs` must stay low enough to admit a
  spoken "yes" — rejecting short utterances by duration, or by a word count,
  breaks answering an approval by voice, which is the one thing the first
  invariant says must always be the user's own act. And `onSpeechStart` must
  never send `interrupt` on its own: it fires on a raw energy threshold with no
  transcript, so the only irreversible action it may take is none —
  `TtsPlaybackQueue.pause()` is reversible, `stop()` plus `interrupt()` waits
  for a verdict. Before that split, a cough destroyed a turn in flight.
  Asserted in `apps/web/src/audio/utterance-harness.test.ts` (including
  recorded real-service output, where this deployment's own model transcribed a
  350ms thump as "yeah" and whisper returned `[BLANK_AUDIO]` at confidence
  0.79) and `playback.test.ts`.
- **A voice turn's reply is always spoken as *something*, and never as code** (PA-84),
  **and never before the turn has proved it was the reply** (PA-89).
  The `<speak>` tag is a model's cooperation, not a contract, so an absent tag must fall
  back to speaking the reply with its unspeakable parts stripped — never to silence,
  which is indistinguishable from a dead microphone and is the failure PA-85's own
  invariant is written against. That is why the filter half of
  `SpokenTextExtractor` is unconditional and `voiceSpokenSummaryEnabled` governs only
  whether the *instruction* is appended: the knob can stop text being added to prompts,
  it may never restore narrating a code block. Three things hold the rest up. The tag
  must keep being requested **first**, or talk-back stops being incremental and goes
  silent for the length of a turn. The injection must stay **above**
  `promptQueue.submit` in `ws/index.ts`, because a queued prompt is re-sent from its
  persisted text verbatim and would otherwise lose it on exactly the deferred path —
  and `appendSpokenSummaryInstruction` is idempotent so that re-send cannot stack
  copies. And `SpokenTextPipeline.reset()` must clear the extractor *and* the chunker:
  an extractor left mid-fence by a stop swallows the next turn's whole reply, which is
  the PA-83 shape of bug. PA-89 adds the fourth: untagged text is **held** by
  `SpokenTextPipeline` until `flush()`, because mid-turn there is no way to tell the
  reply from a model narrating its way to a tool call — and a round trip that ends in
  tool calls is never emitted as a `text` event at all, so the speaker was the only
  place that scratchpad ever appeared. `tool_use` therefore drops the held text and
  **must not cancel the pump**: tagged content has already been judged and may
  already be playing, and PA-84's tag-first rule exists precisely so it is. Asserted in
  `apps/server/tests/voice-spoken-text-extractor.test.ts`, `voice-spoken-text.test.ts`
  and `voice-tts-service.test.ts`.
- **A Gemini Live tool call gets exactly the planner's own gate, and Gemini can never approve**
  (PA-96). The bridge request carries calls only. Whether each runs is `gateToolCall`, the same
  function `processToolCalls` uses, and resolution is the same `applyApprovalDecision`. Gemini
  is given no approve tool, and its instruction says a spoken "yes" is not an approval. There is
  no timeout on a parked live call, which sits in `pendingTurns` so a restart refuses while it
  waits. The API key never leaves the server: no reveal route, not in any response, not in any log
  line (the mint is logged by chat id only). The browser gets a single-use token locked to the
  server's own setup, with no `fieldMask`, because a mask would unlock whatever it does not name.
  Asserted in `apps/server/tests/gemini-live.test.ts`, and end to end by `pnpm demo:gemini-live-ui`.
- **Containment is decided with `fs.realpath` + `path.relative`, never a string prefix**
  (`workspaces/index.ts`). Resolve the whole path first, *then* test containment, or a
  symlink inside a root escapes it.
- **A session's cwd must still resolve inside a workspace folder** — but that list is now
  user-managed (`workspaces` table, seeded once from config) rather than fixed in the
  environment. Adding a folder via `POST /api/workspaces/add` is the moment access is
  granted, and it is logged. `GET /api/browse` is read-only and can see any directory the
  server's user can; that is a deliberate widening and the cost of picking any folder.
- **The browser never supplies an executable or argv.** Adoption and resume both take their
  `cwd` from the server-validated target. **PA-68 extends this to installing one**, which is the
  sharpest case yet: `POST /api/agents/install` takes an id out of a closed set plus an *action*
  out of another (`install` | `update` | `remove-prefix-copy`, PA-104) and nothing else — never a
  package name, version, registry, URL or path. Both sets live in
  `packages/protocol/src/agent-install.ts` precisely so the request schema is two `z.enum`s, so an
  arbitrary package or URL is refused by *request validation* rather than by a handler check a
  future refactor could drop; `agents/catalog.ts` is the only thing that turns an id into an argv,
  and it is a frozen table with no create/edit route. Worth being exact about what that buys,
  because an enum reads like a safety proof and is not one: since PA-104 an install runs the
  vendor's *official installer script*, which downloads and runs a vendor binary as the server's
  user — arbitrary code execution *by design*, exactly as npm's `postinstall` was before it. The
  id check bounds **which** vendor's code runs, not what it may do. **PA-104 deliberately amends
  "argv-only with no shell anywhere"**: the script *is* a shell program, so the rule is now that
  nothing this server builds is a shell command — the script is fetched from the catalog's fixed
  `https://` URL (the final URL after redirects must be `https:` too, and the body must start
  `#!`), written to a private temp file, its sha256 recorded, and run as
  `[interpreter, file, ...fixedArgs]` with no `-c`, no pipeline and no client value anywhere in
  it. An update runs the *resolved* binary with fixed arguments, and a removal is
  `npm uninstall --prefix=<install prefix>` of a copy the server itself found there — never a
  system npm directory. The real boundary is still the frozen catalog plus a human deliberately
  pressing the button — which is why no unattended trigger and no planner tool can reach
  `AgentInstallService`, and why there is no lazy auto-install on session start (a typo in an
  agent id must never become an installation; the composer offers the setup dialog instead).
  Versions are no longer pinned for Settings installs (every agent updates itself, so a pin
  would lie within a day); `docker/agent-versions.env` pins the image where the installer can.
- **A third-party provider variant is disclosed, and is unattended only by explicit
  per-provider opt-in** (PA-19; the opt-in is PA-28). This is an override of the *attended-use*
  rule, not of the approval rule — `skipPermissions` is untouched by it, and a provider running
  a cron job still obeys whatever that job's own toggle says. A `custom-claude:` variant is the same binary with a different
  `ANTHROPIC_BASE_URL`, so nothing about *how* it runs is visible from the agent id alone —
  which makes two things load-bearing. `AgentAdapter.providerDisclosure` is surfaced through
  `SessionInfo.providerDisclosure` and rendered on **every visit**, following
  `skipPermissionsEnabled`'s "not just at the moment it was created" rule, and it names the
  provider *and its base URL* and says the cost figures are wrong (they are computed with
  Anthropic pricing; a trivial DeepSeek turn reports ~$0.26). And
  `AgentAdapter.requiresAttendedUse` makes `structuredAgentProblem` reject it for scheduled jobs
  and inbound webhooks — a structured transport is necessary but no longer sufficient there.
  PA-28 lifts that block for one provider at a time, through
  `custom_claude_providers.allow_unattended`, which flows straight into that same field: **off by
  default in the column, in the create request and in the editor**, warned about inline, and
  surfaced on the provider row rather than only at creation. So `routes/shared.ts` and
  `routes/cron.ts` need no branch for it — the per-provider decision arrives through the field
  they already check, which is the whole reason the toggle was shaped this way rather than as a
  global switch or a route exemption. A provider with it *off* is refused exactly as PA-19
  refused both variants; turning it on is a deliberate act with its own disclosure, and turning
  it back off re-tightens immediately with no restart.
  What that flag does **not** cover, and deliberately: the planner's `send_instruction`
  resuming a session that is *already* a variant (it passes `info.agent` through, so it
  continues a choice a human made attended, rather than selecting a provider on its own).
  Refusing there would strand a legitimately created variant session with no way to be
  continued by a tool that can continue every other kind.
  The API key is decrypted from the row and emitted as `ANTHROPIC_AUTH_TOKEN`; it is never
  returned by any route, in plaintext or ciphertext, and there is no reveal endpoint.
  `ANTHROPIC_API_KEY` is blanked rather than left alone, so an operator's own exported key
  cannot change how the variant behaves. Nothing that logs a provider mutation includes the key
  or the ciphertext — an audit line must not be one step away from recovering a credential.
- **A project is an added folder, or a directory inside one.** Chats in a directory outside
  every folder are not listed, so removing a folder actually removes it. Nothing is deleted;
  re-adding brings its chats back.
- **An `agy` session is one long-lived process, and a turn ending must never end it.**
  `AgySession` drives the CLI with `--input-format stream-json` — agy's own documented
  "so a driver can keep a session open" mode — writing one NDJSON prompt per turn to a
  child that outlives every turn. It used to spawn `agy -p <prompt>` per turn, and that
  silently destroyed work: agy converts any `run_command` still running past the model's
  `WaitMsBeforeAsync` (the model routinely passes 10s) into a background task, the model
  will happily end its turn while one is still `RUNNING` ("waiting for the tests to
  finish"), and the process exiting cancelled it — `Cancelling steps [614]` / `CLI store
  manager shutting down` in agy's own log, with a two-minute `pnpm test` killed 71s in and
  the session left idle insisting it was still waiting. Holding the process open also
  makes agy *defer* the turn's `result` until its background tasks drain (confirmed
  against v1.2.6: a 150s task held the turn open 152.7s, where the same probe under `-p`
  ended the turn in 5.8s and killed the task), so `busy` is finally honest. Three things
  follow. A slash command must go out as its own one-shot `--print` invocation, because
  agy answers those itself and refuses them on the stream ("run it as its own
  `--print /x` invocation") — and the check for one must not match a leading absolute
  path, or an ordinary prompt silently loses the guarantee. `--model` is spawn-time only,
  so a switch recycles the child *between* turns (`respawnBeforeNextTurn`) rather than
  killing the running turn's background work. And `result` figures are
  **conversation-cumulative** on a held-open process rather than per-turn, so
  `makeStatsPerTurn` converts them or every turn footer after the first reports growing
  nonsense. Asserted in `apps/server/tests/agy-session.test.ts`, whose fixture
  deliberately stays alive across turns so a regression to per-turn processes fails a
  test rather than passing quietly.
- **`cols`/`rows` are `nonnegative()`, not `positive()`** — a structured session has no
  character grid and reports 0. Requiring a positive value silently invalidated every
  `attached` frame for structured sessions.
- **tmux format strings use `|` as the separator, parsed right-to-left.** A literal tab is
  not passed through a tmux format unchanged; every line collapsed into one field and the
  poller concluded that all sessions had vanished. Session names may contain `|`, hence
  right-to-left.
- **Adopted panes are not resized** unless the user explicitly opts in — tmux sizes a window
  to its most recent client, so a phone would shrink someone's desktop.
- **Terminal I/O is never logged or persisted.** SQLite holds session metadata only; buffers
  are in-memory.
- **`POCKETAGENT_*` is stripped from every child environment** (`sessions/env.ts`) so the
  master token cannot leak into an agent.

## Conventions

- ESM throughout; relative imports carry the `.js` extension even in `.ts` sources.
- Comments explain *why*, especially where behaviour looks arbitrary — most of them record
  something that was verified empirically or that broke once. Match that density; do not
  narrate what the code already says.
- Frontend state is hand-rolled React (hash routing, no router or state library) and plain
  CSS in `apps/web/src/styles.css`. Keep it that way unless there is a real reason.
- **Under `pages/` and `components/`, `api` comes from `useHostApi()` or not at all** (PA-67).
  The module-level `api` client is bound to the host that served the bundle, so importing it in a
  host-scoped surface silently reads and writes the wrong machine as soon as a second host is
  registered — and it typechecks, lints, and behaves correctly in every single-host deployment,
  which is every deployment until it isn't. `hosts/host-scoping.test.ts` enforces it by grepping
  the source, with an allowlist that has to carry a reason; `LoginPage` is on it because
  authenticating is per *origin*, which with a Hub in front is the Hub. Sockets take the same
  endpoint through `useHostEndpoint()`, and endpoints are interned (`hostEndpoint`) because their
  identity is a React dependency — a fresh object per status poll would reopen every live socket
  every 30 seconds.
- **Nothing reads `window.location` to reach the API or the WebSocket** (PA-60). Host identity
  is a `HostEndpoint`, so a request goes through `api`/`createApiClient` and a socket takes its
  endpoint from its options. The socket URL is deliberately *relative* (`<basePath>/api/ws`) so
  the browser derives origin and `ws:`/`wss:` itself, exactly as it already does for `fetch` —
  one rule for both transports instead of a hand-rolled scheme map that can disagree with the
  page. The remaining `window.location.origin` reads are `SecretReveal.tsx` and, by the same
  reasoning, `McpClientsSection.tsx` (PA-118's `/mcp` URL for a client config). `SecretReveal.tsx` composes a
  webhook's *delivery* URL for a human to paste into Jira; the server deliberately has no notion
  of its own external origin, so that one stays — but it is only valid for the host that served
  the bundle. For any host reached through a path prefix, this origin is the *gateway's*, and a
  Hub is forbidden from proxying `/api/hooks/*` at all, so composing a URL from it would be both
  wrong and an invitation to try the one route that must stay unroutable. The panel says so and
  asks for that backend's address instead, remembering it per host (PA-67).
- **Two layouts, chosen by `matchMedia` in `hooks/useMediaQuery.ts` — never by user-agent
  sniffing.** `(min-width: 900px) and (pointer: fine)` gets `DesktopShell` (sidebar plus
  session pane); everything else gets the single-column phone pages. The list itself lives
  in `components/ProjectList.tsx` and is shared, so the two layouts cannot drift on rules
  like "tapping a finished chat resumes it as a branch". The same goes for the other two
  home-screen categories (`PocketAgentsSection`, `ShellSection`) and their order — both
  layouts render the same three components in the same sequence, and a category added to
  one but not the other is a bug. A **host** is a grouping level *above* those three, never a
  fourth category and never a badge on a row (PA-67): the desktop expresses the switcher as a
  rail and the phone as a sheet — different chrome, deliberately — but both render the same
  `HostGroup` around the same three shared components. The host rail is chrome rather than a
  category, so the "both layouts render the same three categories" rule is unaffected. The one
  place a host *is* shown per row is the desktop tab strip, and only while two hosts have tabs open,
  because two machines can have identically-titled chats side by side.
- **The theme is light, and `color-scheme` is pinned to it.** Everything reads from the
  token block at the top of `styles.css`; adding a raw hex outside it is how the palette
  rots. The one dark surface is the terminal (`--console`), because ANSI palettes are drawn
  for dark backgrounds.
- Icons are inline SVG in `components/Icon.tsx`, 24px grid, 1.7 stroke, `currentColor`. Add
  to that set rather than reaching for a text glyph or an icon font. `speaker` is the agent's
  *output*, deliberately a different silhouette from `mic` and `live-listen`, which are both
  input — a voice UI where "it spoke" looks like "the mic is on" is the one confusion to avoid.
- **There is exactly one component test, and it is an exception with a reason**
  (`components/spoken-summary-disclosure.test.tsx`). The web project is `environment: 'node'`
  with no jsdom and no testing-library, because everything else here is either pure logic
  (tested directly) or needs a real browser (the demo scripts). PA-84's disclosure is neither
  — it is a decision about *what to render*, whose two failure modes (an icon that never
  appears, or one that expands to a duplicate of the message above it) are invisible to the
  pure tests under it. `renderToStaticMarkup` settles both with no new dependency; the
  markdown renderer is stubbed because DOMPurify wants a DOM. `vitest.config.ts`'s web
  `include` therefore covers `.test.tsx` as well — a JSX test file that silently never runs is
  worse than no test.
- **`navigator.clipboard` is not available here.** It needs a secure context, and this app
  is normally reached over plain HTTP on a LAN or tailnet address. `agent/clipboard.ts`
  falls back to a throwaway textarea plus `execCommand('copy')`; anything that copies must
  go through it. The same caveat applies to any other secure-context-only API.
- **`--console` is the one dark surface in a light app, so anything using it as a background
  must also set `color: var(--console-text)`** — inheriting the body colour renders
  dark-on-dark, which is exactly how the code blocks broke once.
- The home screen carries no metadata per row on purpose — a chat is its title and, if
  running, a green dot. Structure comes from weight and whitespace, not borders and badges.
- `eslint.config.js` scopes browser globals to the Playwright demo scripts by filename — add
  new browser-driving scripts to that list.

## Environment

A custom Claude provider is the one thing here that changes *where your data goes*: it routes
prompts and repository contents to a gateway the `claude` adapter has never talked to. Since
PA-28 it is not an env var at all — it is created in Settings and stored (key encrypted) in the
database, so `POCKETAGENT_SETTINGS_ENC_KEY` is the only related setting left in `.env`. Unset
disables the feature rather than failing the boot; the old `POCKETAGENT_DEEPSEEK_*` /
`POCKETAGENT_OMNIROUTE_*` variables are read exactly once to import an existing setup and then
ignored forever. Rotating the encryption key without re-entering every provider's key greys them
out — the README's security section says all of this out loud rather than leaving it to a
variable name.

`POCKETAGENT_BUILD_VERSION` is build identity rather than configuration: the image build
stamps the semver that `/health` and `HostInfo.version` report (PA-61), falling back to
`package.json` and then `0.0.0-dev`. It is read from raw `process.env` for the same reason the
legacy provider variables are — an operator does not choose their build number, and a
deployment that overrode it by hand would be lying about which code is running.

`POCKETAGENT_DATA_DIR` is the app-owned data root (PA-62) — `pocketagent.db`,
`planner-workspaces/`, `planner-skills/`. Unset it is `<checkout>/data`, which is what keeps
an existing install unaffected; it exists so a containerised backend can put every mutable
directory on one mounted volume. It is refused if it resolves *inside* a workspace root, since
an agent working in that tree could delete the database; the reverse (a project folder inside
the data root) is allowed on purpose, because one volume holding both repos and state is a
reasonable container layout. Only the roots *seeded* from the environment are checked — a
folder added later from the UI can still come to contain the data root, and nothing re-checks.

**`POCKETAGENT_HUB_*` is read by `apps/hub` and by nothing else** (PA-66). A backend ignores
every one of them, which is what keeps "a backend needs no Hub-specific configuration" true.
Two are required and both refuse the boot when missing, with exit 78 like any other config
error. `POCKETAGENT_HUB_AUTH_TOKEN` is the Hub's own operator credential and is deliberately a
*different variable* from `POCKETAGENT_AUTH_TOKEN`: one name for both would mean a compose file
could hand the Hub's login password the power of a backend master token, which is the exact
concentration PA-63 exists to remove. `POCKETAGENT_SETTINGS_ENC_KEY` is shared by name with the
backend but not by policy — there, unset disables an optional feature and booting anyway is
right; on the Hub every stored backend credential depends on it, so unset is fatal rather than
a failure deferred to the operator's first bind. `POCKETAGENT_HUB_DATA_DIR` is likewise its own
variable rather than `POCKETAGENT_DATA_DIR`: one name for two unrelated schemas is a trap in
the one deployment where it matters, a compose file running both. The Hub has no workspace
roots, so PA-62's "refuse a data root inside a workspace root" check has nothing to check here
and is absent rather than quietly dropped. `POCKETAGENT_HUB_MDNS` (PA-110) defaults to *on*,
unlike the backend's `POCKETAGENT_MDNS_ADVERTISE`, which defaults to off: hearing an
advertisement discloses and grants nothing, announcing a terminal-access service to a LAN does.

**Everything else the process reads outside the checkout is `$HOME`, and the rule is: if
another binary owns the path, mount it rather than making it configurable.** The three
transcript stores read other programs' private state — `~/.claude/projects`
(`conversations/index.ts`), `~/.gemini/antigravity-cli/brain` (`conversations/agy.ts`),
`~/.pi/agent/sessions` (`conversations/pi.ts`) — and a config knob there would only let this
server look somewhere the owning CLI never writes, which fails as "no history" rather than as
an error; each already takes a constructor override, which is how tests point at a fixture.
`agents/registry.ts`'s `~/.opencode/bin`, `~/.local/bin`, `~/.pi/agent/bin`, `~/.cargo/bin` and
`~/.npm-global/bin` are not a mount decision at all — they are PATH discovery for agent binaries,
in that order with the npm prefix last (PA-104). The first three are the agents' *official*
install locations, all inside `$HOME` and so already on the documented volume, which is what makes
an agent installed or self-updated from Settings survive a container restart with nothing extra to
mount. `POCKETAGENT_AGENT_INSTALL_PREFIX` (default `~/.npm-global`) is now only the npm-fallback
prefix and where pre-PA-104 installs left copies, which Settings reports and can remove.

**A workspace root must be mounted at the same absolute path it has on the host.** Claude Code
derives a transcript directory name from the cwd (`~/.claude/projects/<encoded-cwd>/`, `/` →
`-`, lossy and never inverted), so a repo mounted at a different path inside a container gets
different encoded directory names and *every existing conversation silently becomes
undiscoverable* — no error, just an empty history. The same applies to the pi and agy stores,
and absolute `cwd` values are persisted in the database itself (session rows,
`webhook_issue_sessions`), so a relocated data volume and a relocated workspace mount can break
each other too.

`.env` (gitignored) is required: `POCKETAGENT_AUTH_TOKEN` (min 24 chars, never
auto-generated) and `POCKETAGENT_WORKSPACE_ROOTS` (no default — unset must never mean the
whole filesystem). The server refuses to start without both. `.env.example` documents every
setting; the README covers deployment, the security model, and known limitations.

Default bind is `127.0.0.1`. This grants terminal access as your user, so exposing it is a
deliberate act — prefer Tailscale over `0.0.0.0`.

An inbound webhook inverts the direction of that posture: it requires that a machine you do not
control can open a connection to this process. **The server has no reliable notion of its own
external origin** — the bind is loopback and `Host`/`X-Forwarded-*` are attacker-supplied
claims — so it returns only `Webhook.deliveryPath` and the browser composes the URL, labelling
which origin it used. Nothing claims the URL is reachable from Jira; the first received delivery
is the only evidence, and the UI shows its absence as `never fired` rather than hiding it. The
recommended posture is Jira on the same tailnet; a reverse proxy forwarding only `/api/hooks/*`
is the acceptable second, and **not enforceable by the app** — the server cannot tell a proxied
request from a direct one.

## Confluence documentation

This project is documented in Confluence at
[`https://confluence.local.shifamily.com/spaces/PA/`](https://confluence.local.shifamily.com/spaces/PA/)
(space key `PA`), accessed via the `mcp-atlassian` MCP server. The space root page is
"Pocket Agent", with seven child pages:

- **Architecture Overview** — what PocketAgent is, the two independent dimensions
  (transport/backend), the wire protocol, and the repo layout.
- **Transports & Process Backends** — `terminal` vs `structured` transports, `direct` vs
  `tmux` backends, session lifecycle, and how to add a new agent adapter.
- **Key Workflows** — resuming a conversation vs. attaching to a tmux pane, the home screen
  merge rules, the composer's fourth row, hiding/removing chats, and layouts.
- **Invariants & Security Model** — the load-bearing invariants list and the enforced
  security boundaries table.
- **Development Guide** — commands, running a single test, live demo scripts, and
  troubleshooting.
- **Conventions & Environment** — coding/frontend conventions, the full environment variable
  table, deployment notes summary, and known limitations.
- **Installation & Deployment** — requirements, install, first-run configuration (token,
  project folders), running (dev/production/systemd), deploying to another machine, and
  accessing it remotely (Tailscale, LAN, reverse proxy).

**Keep this documentation in sync with the code.** When a change in this repo touches
anything one of those pages describes — a new transport, backend, agent adapter, invariant,
env var, workflow, or convention — update the corresponding Confluence page(s) in the same
piece of work, not as a follow-up. Read the existing page with
`mcp__mcp-atlassian__confluence_get_page` before editing so the update lands as a diff against
current content rather than a rewrite, and use `mcp__mcp-atlassian__confluence_update_page` to
save it. When creating new pages, remember Confluence storage format requires HTML entities
to be escaped (`&` → `&amp;`, literal `<`/`>` in prose → `&lt;`/`&gt;`); passing
`content_format: "markdown"` to the create/update tools and writing plain Markdown handles this
conversion automatically — verified by round-tripping a page and confirming `&` came back as
`&amp;` in the stored XHTML.
