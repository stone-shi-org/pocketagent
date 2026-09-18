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
  without it an agent installed into the mounted prefix is invisible to exactly the surface
  most likely to look for it. `docker-smoke.mjs` asserts the login-shell `PATH`.
- **A pinned agent CLI goes in `/usr/local/bin`, never the default npm prefix.**
  `NPM_CONFIG_PREFIX` points into `$HOME`, which is a *mount point* at run time, so an install
  that lands there is hidden by the volume on first run. npm reads its env config
  case-insensitively, so the inherited `NPM_CONFIG_PREFIX` beats a lowercase
  `npm_config_prefix=…` on the command — hence `env -u NPM_CONFIG_PREFIX … --prefix
  /usr/local`, plus a `test -x` that fails the build, because `claude --version` passes either
  way and this shipped broken once.

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
decision. Eighteen demo scripts do; all but three run against a *running* server:

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
PA_TOKEN=... pnpm demo:multi-host-ui     # multi-host: rail, sheet, aggregate home, deep links, both viewports
PA_TOKEN=... pnpm demo:agent-install-ui  # agent setup dialog: four states, streamed install, phone viewport
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

**Detection really was nearly free; the third state was not.** `resolveExecutable` already
searched `~/.local/bin`, `~/.cargo/bin` and `~/.npm-global/bin`, so pointing the install prefix at
one of those needs no detection code at all — and the container image already sets
`NPM_CONFIG_PREFIX=$HOME/.npm-global`, mounts `$HOME` and puts that prefix *first* on PATH, so
`config.agentInstallPrefix` defaults to the same directory and the bare-metal default agrees with
the image by construction rather than by a second decision. (`~/.opencode/bin` was added to that
search list in the same work: opencode's own installer puts the binary there and nothing else
does, so a host with a perfectly working `opencode` reported it missing.)

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

Two things the install does that npm's exit code does not cover. The prefix must be a directory
`resolveExecutable` actually searches, or an install succeeds and stays invisible — so
`prefixDetectable` refuses up front rather than letting the UI offer it. And success is confirmed
by re-resolving the binary (`verifyInstalled`), because a zero exit into the wrong prefix is
exactly what `docker/Dockerfile`'s own `test -x` exists to catch, having shipped broken once; a
binary that resolves from *outside* the prefix is not a failure but is logged, since it means an
older copy earlier on PATH will run and the operator's upgrade silently did nothing.

Timeouts: the installer is bounded at 10 minutes and one install runs at a time (a second for a
different agent is refused, not queued — `RunQueue` keys on working trees and an install has
none). A subprocess timeout here is *not* a breach of the standing no-decay rule: that rule is
about an approval, which is a decision a human has not made yet, whereas a wedged `npm install`
is nobody's decision and holds the only install slot.

Known limitation: the catalog's pins are duplicated from `docker/agent-versions.env` rather than
read from it, because the runtime image does not ship `docker/`. `agent-install.test.ts` parses
that file and fails when the two disagree — the same drift guard PA-65 uses for the four
`package.json` versions.

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
`list_sessions`, `read_session_output`, `read_file` — exempt from approval entirely) and
mutating (`send_instruction`, `write_file`, `mkdir`, `rmdir`, `delete_worktree`,
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
Hub (PA-66, below). Building a front server **does** concentrate credentials for every
registered machine in one process, which this repo previously recorded as a reason not to build
one at all; that guidance was knowingly overruled on PA-66, and PA-63's scoped, revocable hub
credentials are the mitigation that made it defensible — no credential the Hub holds is a root
credential, and every one of them is revocable from the machine it grants access to.

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
not for their state, since each backend stays directly usable with no Hub involved.

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
  sharpest case yet: `POST /api/agents/install` takes an id out of a closed set and nothing else
  — never a package name, version, registry or URL. The id set lives in
  `packages/protocol/src/agent-install.ts` precisely so the request schema can be a `z.enum`, so
  an arbitrary package is refused by *request validation* rather than by a handler check a future
  refactor could drop; `agents/catalog.ts` is the only thing that turns an id into an argv, and it
  is a frozen table with pinned versions and no create/edit route. Worth being exact about what
  that buys, because an enum reads like a safety proof and is not one: `npm install` runs the
  package's own `postinstall` scripts as the server's user and `--ignore-scripts` breaks these
  CLIs, so an install is arbitrary code execution *by design*. The id check bounds **which**
  package runs, not what it may do. The real boundary is the pinned catalog plus a human
  deliberately pressing the button — which is why versions are pinned rather than floating, why
  the installer is argv-only with no shell anywhere, why no unattended trigger and no planner tool
  can reach `AgentInstallService`, and why there is no lazy auto-install on session start (a typo
  in an agent id must never become a package installation; the composer offers the setup dialog
  instead). `agy` is deliberately absent from the catalog: it has no npm package and the registry
  names that look right are unrelated placeholders, so pinning one would be a supply-chain hazard
  dressed up as completeness — the same call `docker/agent-versions.env` already made.
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
  page. The one remaining `window.location.origin` read is `SecretReveal.tsx`, which composes a
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
  `HostGroup` around the same three shared components. The one place a host *is* shown per row is
  the desktop tab strip, and only while two hosts have tabs open, because two machines can have
  identically-titled chats side by side.
- **The theme is light, and `color-scheme` is pinned to it.** Everything reads from the
  token block at the top of `styles.css`; adding a raw hex outside it is how the palette
  rots. The one dark surface is the terminal (`--console`), because ANSI palettes are drawn
  for dark backgrounds.
- Icons are inline SVG in `components/Icon.tsx`, 24px grid, 1.7 stroke, `currentColor`. Add
  to that set rather than reaching for a text glyph or an icon font.
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
and is absent rather than quietly dropped.

**Everything else the process reads outside the checkout is `$HOME`, and the rule is: if
another binary owns the path, mount it rather than making it configurable.** The three
transcript stores read other programs' private state — `~/.claude/projects`
(`conversations/index.ts`), `~/.gemini/antigravity-cli/brain` (`conversations/agy.ts`),
`~/.pi/agent/sessions` (`conversations/pi.ts`) — and a config knob there would only let this
server look somewhere the owning CLI never writes, which fails as "no history" rather than as
an error; each already takes a constructor override, which is how tests point at a fixture.
`agents/registry.ts`'s `~/.local/bin`, `~/.cargo/bin`, `~/.npm-global/bin`, `~/.opencode/bin` are
not a mount decision at all — they are PATH discovery for agent binaries. Those belong in the
image, *except* the one an operator installs on demand (PA-68):
`POCKETAGENT_AGENT_INSTALL_PREFIX` defaults to `~/.npm-global`, which is inside `$HOME` and so
already on the documented volume, which is what makes an installed agent survive a container
restart with nothing extra to mount.

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
