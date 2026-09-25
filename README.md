# PocketAgent

Self-hosted remote control for terminal-based AI coding agents. Run Claude Code (or a
plain shell) on your Linux box and drive it from your phone's browser.

PocketAgent runs the CLI you already have installed inside a server-managed pseudo-terminal
and streams it to a browser over a WebSocket. The CLI cannot tell the difference between
this and a human sitting at the terminal — including interactive approval prompts, which
you answer with normal keystrokes.

```
iPhone / Android / desktop browser
            ↕  HTTPS / WebSocket
     PocketAgent server  (Fastify + node-pty + SQLite)
            ↕  PTY
   claude / shell / future agents
            ↕
     local Linux filesystem
```

**What it is not:** it does not automate Claude authentication, scrape provider websites,
or use private remote-control APIs. It launches `claude` exactly the way you would.

---

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Configuration](#configuration)
- [Running](#running)
- [Running with Docker](#running-with-docker)
- [Running a Hub](#running-a-hub)
- [Releases](#releases)
- [Deploying to another machine](#deploying-to-another-machine)
  - [The data root](#the-data-root)
- [Two interfaces: native and terminal](#two-interfaces-native-and-terminal)
- [Picking up work you started elsewhere](#picking-up-work-you-started-elsewhere)
- [Scheduled jobs](#scheduled-jobs)
- [Process backends](#process-backends)
- [Accessing from another device](#accessing-from-another-device)
- [Using it](#using-it)
- [Copying a message](#copying-a-message)
- [Tidying the list](#tidying-the-list)
- [Layouts](#layouts)
- [Restarting a host](#restarting-a-host)
- [Security model](#security-model)
  - [Hub credentials](#hub-credentials)
  - [Continuing a chat on another provider](#continuing-a-chat-on-another-provider)
- [How it works](#how-it-works)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)

---

## Requirements

- **Linux** (this is Linux-first; macOS likely works, Windows does not)
- **Node.js 22+**
- **pnpm 12+**
- A C++ toolchain for the two native modules (`node-pty`, `better-sqlite3`):
  `sudo apt install build-essential python3` on Debian/Ubuntu
- Whatever agent CLI you want to drive, already installed and already logged in
  (`claude`, etc.)

---

## Install

```bash
git clone https://github.com/stone-shi/pocketagent
cd pocketagent
pnpm install
pnpm build
```

`pnpm install` compiles `node-pty` and `better-sqlite3` from source. If that fails, see
[Troubleshooting](#troubleshooting).

---

## Configuration

Copy the example file and edit it:

```bash
cp .env.example .env
```

### Generate an access token

```bash
pnpm generate-token
```

This writes a 256-bit token into `.env` (mode `600`) and prints it once. Paste it into the
login screen.

PocketAgent **will not start without a token, and will not invent one for you.** A token
auto-generated at boot is easy to miss in a log and easy to leak into shell scrollback, so
the server fails loudly with instructions instead. Tokens shorter than 24 characters are
rejected.

To rotate: edit `POCKETAGENT_AUTH_TOKEN` in `.env` and restart. Existing browser sessions
keep working until their cookies expire — to force everyone out, delete `pocketagent.db` from
your [data root](#the-data-root) (this also clears session history) or
`DELETE FROM auth_sessions;`.

### Project folders

Folders are managed from the app: **Add a project folder** at the bottom of the list opens
a picker with two tabs.

- **Suggested** — directories Claude Code and Codex have already run in, read from their
  own session stores. Usually the whole answer, and it saves navigating a filesystem on a
  phone.
- **Browse** — the host's directories, navigated from your home directory. Not an OS file
  dialog: a browser's directory picker returns a handle to storage on *this device*, and a
  file input never reveals an absolute path, so the server lists its own directories and the
  browser walks them.

Any absolute directory on the host can be added, except `/`. Subdirectories are *not* added
with it — `venv`, `node_modules` and `test-reports` are not projects.

```env
# Optional. Seeds the list on a *fresh database* only; after that the app owns it,
# so editing this later will not fight what you added in the UI.
POCKETAGENT_WORKSPACE_ROOTS=/home/me/src,/home/me/work
```

**What the boundary is now.** A session's working directory must still resolve inside one of
these folders — that check has not gone away, it just consults a list you curate instead of
one fixed in the environment. Adding a folder is the moment access is granted, and it is
logged. Removing one revokes it: new sessions there are refused, though anything already
running keeps running.

### All settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. Non-loopback logs a warning. |
| `PORT` | `8787` | |
| `POCKETAGENT_AUTH_TOKEN` | — | **Required.** Min 24 chars. |
| `POCKETAGENT_WORKSPACE_ROOTS` | — | Optional. Seeds project folders on a fresh database only. |
| `POCKETAGENT_DATA_DIR` | `<checkout>/data` | Where the database and the Pocket Agent scratch/skills directories live. Refused if it resolves inside a project folder. See [The data root](#the-data-root). |
| `POCKETAGENT_AGENT_INSTALL_PREFIX` | `~/.npm-global` | Where an npm-method install would land. No current agent uses it: **Set up agents** uses each vendor's official installer and location. It is searched *last*, and copies left there by older versions are listed in Settings. See [Installing agents](#installing-agents). |
| `POCKETAGENT_SESSION_TTL_HOURS` | `720` | How long a browser stays signed in. |
| `POCKETAGENT_COOKIE_SECURE` | auto | `Secure` cookie flag; defaults to on when `NODE_ENV=production`. |
| `POCKETAGENT_ALLOWED_ORIGINS` | same-origin | Comma-separated Origin allowlist. |
| `POCKETAGENT_TRUST_PROXY` | `false` | Trust `X-Forwarded-For` (only behind your own proxy). |
| `MAX_SESSIONS` | `10` | Concurrent live PTYs. |
| `OUTPUT_BUFFER_BYTES` | `2097152` | Per-session replay buffer. |
| `SESSION_IDLE_TIMEOUT` | `0` | Seconds idle **and** unattached before auto-kill. `0` disables. |
| `POCKETAGENT_BACKEND` | `direct` | `direct` or `tmux`. In containers, use `direct`. See [Process backends](#process-backends). |
| `POCKETAGENT_TMUX_BIN` | `tmux` | tmux executable. |
| `POCKETAGENT_TMUX_SOCKET` | `pocketagent` | Private tmux socket name. |
| `POCKETAGENT_ADOPT_TMUX_SOCKET` | unset | Foreign tmux socket to adopt existing user panes from. |
| `POCKETAGENT_GLOBAL_SKIP_PERMISSIONS` | `false` | **Dangerous:** Boot-time seed to globally bypass tool approvals. |
| `POCKETAGENT_SHELL` | `$SHELL` | Shell for the `shell` agent. |
| `POCKETAGENT_CLAUDE_BIN` | `claude` | Claude Code executable, resolved on `PATH`. |
| `POCKETAGENT_AGY_BIN` | `agy` | Google Antigravity CLI executable, resolved on `PATH`. |
| `POCKETAGENT_OPENCODE_BIN` | `opencode` | Opencode CLI executable, resolved on `PATH`. |
| `POCKETAGENT_CODEX_BIN` | `codex` | OpenAI Codex CLI executable, resolved on `PATH`. |
| `POCKETAGENT_PI_BIN` | `pi` | Pi CLI binary, resolved on `PATH`. |
| `POCKETAGENT_SETTINGS_ENC_KEY` | — | Base64 of 32 random bytes, encrypting each custom Claude provider's API key (and the Gemini Live key, Telegram bot tokens) at rest. Unset disables that feature (it is not a boot error); set-but-invalid is. See [Continuing a chat on another provider](#continuing-a-chat-on-another-provider). |
| `POCKETAGENT_PUSH_CONTACT` | `mailto:pocketagent@localhost` | VAPID contact email/URI for Web Push notifications. |
| `POCKETAGENT_CODE_SERVER_URL` | unset | Base URL for code-server deep links. |
| `POCKETAGENT_DEEPSEEK_*`, `POCKETAGENT_OMNIROUTE_*` | — | **Deprecated.** Read once on the first boot after upgrading, to import the old built-in variants as custom Claude providers, then never again. See [Continuing a chat on another provider](#continuing-a-chat-on-another-provider). |
| `POCKETAGENT_WEB_DIST` | `<checkout>/apps/web/dist` | Directory the frontend is served from. The container image sets it explicitly; a normal install never needs it. If it does not exist the API still runs and page requests get a plain 404. |
| `POCKETAGENT_BUILD_VERSION` | `package.json`, then `0.0.0-dev` | Semver reported on `/health` and in the host list. Build identity, normally stamped by the image build rather than set by hand; a malformed value is ignored with a boot warning. |
| `LOG_LEVEL` | `info` | |
| `NODE_ENV` | `development` | |

---

## Running

### Production (one process serves everything)

```bash
pnpm build
pnpm start
```

Open <http://127.0.0.1:8787/>. The same process serves the frontend, the REST API, and the
WebSocket. No nginx required.

### Development (hot reload)

```bash
pnpm dev
```

Starts the API on `:8787` and Vite on `:5173`, with `/api` and `/health` proxied
(WebSockets included). Use <http://127.0.0.1:5173/>.

### Running it as a service

```ini
# ~/.config/systemd/user/pocketagent.service
[Unit]
Description=PocketAgent
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/src/pocketagent
ExecStart=/usr/bin/node apps/server/dist/server.js
Restart=on-failure
Environment=NODE_ENV=production
Environment="PATH=%h/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now pocketagent
loginctl enable-linger "$USER"     # keep it running when you are logged out
```

With the default `direct` backend, restarting the service **kills every running session**.
Set `POCKETAGENT_BACKEND=tmux` and they survive restarts — see
[Process backends](#process-backends).

A note on the restart policy, because it interacts with
[Restarting a host](#restarting-a-host). When asked to restart over the API the server drains
and exits with status **75**, deliberately non-zero, so that `on-failure` *and* `always` both
bring it back — a clean `exit(0)` is a *successful* exit, which `on-failure` correctly ignores,
and the endpoint would then be a remote off switch. The only policy that cannot work is
`Restart=no` (the default if you omit the line), and there the endpoint refuses to exit at all
rather than taking the host down. Docker's `always`, `unless-stopped` and `on-failure` all
behave the same way.

Independently of that, `Restart=always` is the safer choice: a `SIGTERM` from anywhere — a
stray `pkill -f dist/server.js` aimed at a scratch server in another checkout matches this one
too — is a graceful shutdown that exits `0`, which `on-failure` will not restart, and the
journal shows nothing but a clean stop.

---

## Running with Docker

This is the recommended way to deploy. It removes the native-toolchain and Node-version
problem outright — no `build-essential`, no `pnpm rebuild` after a Node upgrade, no
architecture-pinned `node_modules` to move. `git pull && pnpm build` remains the *development*
path.

```bash
cp docker/.env.example docker/.env      # token, workspace root, your uid/gid
docker compose -f docker/compose.yaml up -d
```

Then open <http://127.0.0.1:8787/>.

The container ships no agent CLI in the default tag, so install one (or use the `-claude`
tag) and **log it in** — PocketAgent holds no provider credentials of its own and cannot log
in for you:

```bash
docker compose -f docker/compose.yaml exec --user "$(id -u):$(id -g)" pocketagent \
    npm install -g @anthropic-ai/claude-code
docker compose -f docker/compose.yaml exec --user "$(id -u):$(id -g)" pocketagent claude
```

**`--user` on every `exec` is not optional.** `docker exec` defaults to the image's user,
which is root, because the entrypoint needs to start as root to remap the uid before dropping
privileges. Without the flag, an interactive login writes root-owned credential files into
your mounted `$HOME` and the server — which runs as *you* — then cannot read them.

### Tags

Agent CLIs release far faster than this app, so there is no per-agent tag matrix; it would be
stale within days.

| Tag | Contains |
| --- | --- |
| `:<semver>`, `:<major>.<minor>`, `:latest` | Node, git, tmux, bash, the server. **No agent CLIs.** |
| `:<semver>-claude`, `:<major>.<minor>-claude`, `:latest-claude` | The above plus a pinned `claude`, installed by its official installer. The common case. |
| `:<semver>-all`, `:<major>.<minor>-all`, `:latest-all` | Plus pinned `codex` and `opencode`, and `agy` and `pi` at their release of the build date, for air-gapped installs. |

`:<major>.<minor>` is the "give me patches of the minor I qualified" subscription and `:latest`
is the unpinned default; both move, and only a **stable** release moves them — see
[Releases](#releases). Neither is a substitute for pinning by digest.

Every baked-in CLI is installed with its **vendor's official installer**, the same one Settings
runs, so it has the official layout and updates the way any official install does. The
official locations are all under `$HOME`, which is a mount point at run time, so the image
installs them under a build-time home, `/opt/pocketagent-agents`, and links them into
`/usr/local/bin`. Pins live in `docker/agent-versions.env`, and only where the installer
accepts a version: `claude`, `codex` and `opencode`. **`agy` and `pi` are unpinned**: their
official installers always take the current release, so `-all` gets whatever was current when
it was built. The agents update themselves after the first run. An update is written into the
mounted `$HOME`, which comes before `/usr/local/bin` on `PATH`, so the updated copy is the one
that runs and it survives a restart.

"Thin" means *no agent CLIs on PATH*, not *small*. The image is ~900 MB, most of which is one
of the server's own dependencies: `@anthropic-ai/claude-agent-sdk` ships a ~291 MB
platform-specific binary.

### The volume contract

Stable, and meant to be extended against.

| Container path | Selected by | Holds | Must match the host path? |
| --- | --- | --- | --- |
| `/data` | `POCKETAGENT_DATA_DIR` | `pocketagent.db`, `planner-workspaces/`, `planner-skills/` | No |
| `/home/pocketagent` | `HOME` | agent CLI credentials and config, the transcript stores (`~/.claude/projects`, `~/.gemini/…`, `~/.pi/…`), **and every agent CLI installed or updated from Settings** (their official locations: `~/.local`, `~/.codex`, `~/.opencode`, `~/.pi`) | No |
| your repositories | `POCKETAGENT_WORKSPACE_ROOTS` | your code | **Yes** |

Installed agents need no separate mount: their official locations are inside `$HOME`. The
server and a login shell search the same directories in the same order: `~/.opencode/bin`,
`~/.local/bin` and `~/.pi/agent/bin` first, then the system `PATH` (where the image's
baked-in CLIs are linked), then `~/.cargo/bin`, and `~/.npm-global/bin` last. An agent you
install or update from Settings therefore overrides the one the image pinned. That is
deliberate: an explicit install should beat an image default, and it is how you move off a pin
without rebuilding.

**Mount your repositories at the same absolute path they have on the host.** `-v
/home/me/src:/home/me/src`, never `-v /home/me/src:/workspace`. The second one appears to work
and makes every conversation you have already had undiscoverable — see
[On containers](#on-containers) for why, and note it applies to the database's stored `cwd`
values too, not only to transcripts.

### Matching your user

Everything an agent writes in a mounted repository is written as the container's uid.

```yaml
environment:
  PUID: 1000      # id -u
  PGID: 1000      # id -g
```

A mismatch is worse than untidy ownership: `git` refuses a repository whose owner it cannot
match (`detected dubious ownership`), so `git status`, the diff views and every worktree
operation fail as well.

The entrypoint **never chowns a mounted volume** — that tree is yours. It chowns only paths
that are still part of the image (which is what makes an *empty named volume* inherit the
right owner; a bind mount keeps the host's), and if the data root or `$HOME` is not writable
by the mapped user it refuses to start with exit 78 and prints the exact `chown` to run.

`--user $(id -u):$(id -g)` works too, but is second class: the remap needs root, so with
`--user` there is no passwd entry for your uid, which some tools want.

### Two defaults that differ from a bare-metal install

- **`HOST=0.0.0.0`.** Loopback inside a network namespace means *unreachable*, not *safe*, so
  the deliberate act that the `127.0.0.1` default exists to force moves to publishing the
  port. The compose file publishes `127.0.0.1:8787:8787`; put Tailscale or a TLS reverse proxy
  in front rather than widening it. The server still warns at every boot that it is bound to a
  non-loopback address — that warning is now always true and is left in place rather than
  suppressed.
- **`NODE_ENV=production`, so the auth cookie is `Secure`.** A browser silently discards a
  `Secure` cookie over plain HTTP, so login appears to succeed and bounces straight back.
  Over plain HTTP on a tailnet or LAN, set `POCKETAGENT_COOKIE_SECURE=false` (the compose file
  does).

### The tmux backend does not belong in a container

Use `direct`, which is the default. The tmux backend exists to outlive a *server* restart, and
it still does that inside the container — but the tmux server dies with the container, so it
buys nothing across the restart people actually mean. Two related notes:

- `POCKETAGENT_ADOPT_TMUX_SOCKET` (attaching to *your own* tmux) needs the host socket
  bind-mounted (`/tmp/tmux-<uid>/<socket>`) and a matching uid. Possible; not recommended.
- `POCKETAGENT_TMUX_SESSION_SCOPE_SLICE` is meaningless — there is no per-user systemd manager
  to delegate to.

Conversation liveness also becomes container-scoped: PocketAgent detects a running agent by
reading `/proc`, so agents you started on the host are not seen.

### Building and extending

```bash
docker/build.sh            # thin      -> pocketagent-server:<version>, :latest
docker/build.sh claude
docker/build.sh all
docker/build.sh hub        # the Hub   -> pocketagent-hub:<version>, :latest
PA_PLATFORM=linux/arm64 PA_PUSH=1 docker/build.sh
```

`hub` builds a *different image name*, not a suffixed tag of the server's — see
[Running a Hub](#running-a-hub). The name comes from `scripts/release-tags.mjs`, the same
table the release driver reads, so the two cannot disagree about which image a target
publishes.

Use `docker/build.sh`, not `docker build`: it is what reads `docker/agent-versions.env` and
what stamps the version into both the server and the web bundle. One platform per invocation —
the Agent SDK selects an architecture- and libc-specific package at install time, so a second
architecture is a second real build, not a copy.

`docker/extend.example.Dockerfile` is a working example of adding a tool:

```dockerfile
FROM registry.shifamily.com/homestack/pocketagent-server:latest
RUN apt-get update \
    && apt-get install -y --no-install-recommends ripgrep \
    && rm -rf /var/lib/apt/lists/*
```

Do not add a `USER` instruction and do not override `ENTRYPOINT`: the container starts as root
so the entrypoint can remap the uid, then drops privileges itself.

`pnpm demo:docker` builds the image and checks the whole contract end to end — a session that
writes a host-owned file, `git` inside the mount, the login-shell `PATH`, state surviving
`docker restart`, the extension example, that the token is in no image layer, and that the
stamped version reaches both `/health` and the web bundle.

---

## Running a Hub

Optional, and only worth it once you have more than one machine. A **Hub**
(`apps/hub`, image `pocketagent-hub`) is a single origin that fronts several
backends: you sign in once to the Hub, and every machine bound to it is reachable
from that one browser tab.

```
phone / desktop ──TLS──► Hub (one origin, SQLite, registry, credentials)
                          ├── /h/dev01/api/*  ──► backend #1
                          ├── /h/dev02/api/*  ──► backend #2  (+ WebSocket upgrade)
                          └── /api/hub/*      ──► the host registry
```

**A backend needs no Hub-specific configuration.** Nothing about running one changes,
and a backend reached directly with no Hub in front behaves exactly as it always has.
The only thing a Hub needs from a backend is one `hub-bind` call, which you make from
the Hub's own UI.

### Why one origin instead of several

The browser talks to exactly one origin and reaches each backend under a path prefix.
That is not a stylistic choice: a frontend talking to N backend origins would need
`SameSite=None; Secure` cookies, and Safari blocks third-party cookies outright — so
the obvious cross-origin design fails silently on iPhone, which is the primary target.
Path-routing keeps the existing `SameSite=Strict` HttpOnly cookie working unchanged,
needs no CORS, makes the WebSocket a plain upgrade proxy, and leaves exactly one TLS
certificate to manage.

The consequence worth knowing: a backend is reachable through the Hub only as a
same-origin path prefix, so "add a host" means registering a machine the Hub itself can
reach, not pointing your browser at a second address.

### Setting one up

```bash
# The Hub's own credential — NOT any backend's POCKETAGENT_AUTH_TOKEN.
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
# And a key to encrypt the backend credentials it will hold:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```bash
# docker/.env
POCKETAGENT_HUB_AUTH_TOKEN=<the first value>
POCKETAGENT_SETTINGS_ENC_KEY=<the second value>

docker compose -f docker/compose.hub.yaml up -d
```

Then open the Hub, sign in, and for each machine: **add a host** (an id, a label and the
backend's base URL as the Hub can reach it), then **bind** it by pasting that backend's
`POCKETAGENT_AUTH_TOKEN` once. The Hub exchanges it for a scoped credential and discards
it — see [Hub credentials](#hub-credentials) for why that matters and what it does not
buy you.

For development, run it from the checkout instead:

```bash
POCKETAGENT_HUB_AUTH_TOKEN=... POCKETAGENT_SETTINGS_ENC_KEY=... \
  pnpm -F @pocketagent/hub dev
```

It is deliberately not part of `pnpm dev`: most work here is against a single backend,
and a Hub with nothing registered has nothing to show.

### Hub settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `POCKETAGENT_HUB_AUTH_TOKEN` | — | **Required.** The Hub's own operator credential, min 24 chars. Never a backend's token. |
| `POCKETAGENT_SETTINGS_ENC_KEY` | — | **Required here.** Encrypts the stored backend credentials. Unlike on a backend, the Hub refuses to boot without it. |
| `POCKETAGENT_HUB_HOST` | `127.0.0.1` | Bind address. Non-loopback logs a warning — this process reaches every bound backend. |
| `POCKETAGENT_HUB_PORT` | `8788` | |
| `POCKETAGENT_HUB_DATA_DIR` | `<checkout>/data/hub` | The registry database. Its own variable, not `POCKETAGENT_DATA_DIR`. |
| `POCKETAGENT_HUB_SESSION_TTL_HOURS` | `720` | How long a Hub login lasts. |
| `POCKETAGENT_HUB_LATEST_RELEASE` | unset | Newest release to compare hosts against, for the drift badge. Unset infers it from the hosts in the list. |
| `POCKETAGENT_HUB_PUSH_CONTACT` | `mailto:pocketagent@localhost` | VAPID contact claim for Hub-managed Web Push relay (PA-73). |
| `POCKETAGENT_ALLOWED_ORIGINS`, `POCKETAGENT_COOKIE_SECURE`, `POCKETAGENT_TRUST_PROXY` | as for a backend | Set these on the **Hub**: it is the origin the browser talks to, and where TLS terminates. |

### TLS

The Hub is the only thing that should be published, so there is one certificate. In
order of preference:

1. **Tailscale Serve.** Keep the Hub on loopback and let Tailscale terminate TLS:
   `tailscale serve --bg 8788`. Real HTTPS, no certificate management, and only your
   tailnet can reach it.
2. **Caddy or Traefik** in front, forwarding to `127.0.0.1:8788`. Forward the WebSocket
   upgrade headers and use a long read timeout — terminals idle for a long time.

Then set `POCKETAGENT_TRUST_PROXY=true` and `POCKETAGENT_ALLOWED_ORIGINS=https://your.domain`
on the Hub. Over plain HTTP you must also set `POCKETAGENT_COOKIE_SECURE=false`, or login
silently fails — the same trap a bare backend has.

### Two things the Hub deliberately does not do

**It does not proxy `/api/hooks/*`.** Inbound webhook deliveries are the only
unauthenticated route in a backend, and the guarantee that `grep '/api/hooks/'` finds the
whole unauthenticated surface is worth more than the convenience. Jira keeps delivering
**straight to the backend**, so a machine that receives webhooks still needs its own
reachable address. `/h/<id>/api/hooks/...` is refused by the Hub and never forwarded.

**It does not look at your terminal traffic.** The WebSocket is spliced at the TCP level:
the Hub has no WebSocket library at all on that path, so it does not buffer, inspect,
transform or log a single frame. "Terminal I/O is never logged or persisted" holds in the
Hub because there is no code there that could do it, not because it was asked nicely.

It also does not merge anything. The Hub proxies; it does not aggregate. Every response
you see came from one backend.

### Provisioning from a Hub

A Hub can also define configuration once and instantiate it on any bound host — a Pocket
Agent, an MCP registry, a skill, a custom Claude provider, or the Pocket Agent LLM endpoint
and its model catalog. Everything else stays per-host.

The model is **templates you instantiate, not continuous sync.** A template is provisioned
onto a host and then diverges freely: editing the template afterwards changes nothing on any
host that already has it, and the Hub simply shows those hosts as behind ("dev01 has r3, this
template is r5"). There is no reconciliation loop, deliberately — one that silently overwrote a
local change would fight the per-host editor every one of these resources already has, and is a
much bigger decision than "provision a new machine quickly".

Three things to know before using it:

- **A template never contains a secret.** It declares the *shape* of what it needs — a provider
  API key, an MCP bearer token, the planner LLM key — and you fill that in per host when you
  instantiate. The Hub stores none of it: there is no column it could go in, and the value only
  exists for the one request that carries it to that backend. The cost is that re-provisioning
  asks again, which is deliberate: the alternative is a Hub holding every upstream credential
  your fleet uses, none of which PocketAgent can revoke for you.
- **Re-provisioning is always an explicit, confirmed overwrite.** Without the confirmation a
  host that already has the template is skipped and nothing is written. And the confirmation
  only ever replaces what *this Hub* provisioned — a same-named agent or a same-slug skill
  somebody created on that machine is reported as a conflict and left alone.
- **A planner-endpoint template replaces host-wide settings**, so it needs the confirmation even
  the first time: it repoints the LLM endpoint every Pocket Agent chat on that machine talks to.

A template carries no filesystem paths, so each host creates its own directories under its own
`POCKETAGENT_DATA_DIR` — which is what lets one template serve machines with different layouts.

Every provisioning action is logged **on both sides**: once by the Hub, and once by the
receiving backend, whose line names the Hub that made the change (`by: "hub:<label>"`, at
`warn`, so it survives a deployment running at `LOG_LEVEL=warn`). The backend's copy is the one
that still exists if the Hub is ever compromised.

Webhooks and scheduled jobs are deliberately **not** provisionable. A webhook's slug, HMAC
secret and delivery URL point at exactly one host, so cloning it to three would leave one real
and two dead; and a nightly cron job cloned to three machines runs three times.

`pnpm demo:provision` exercises all of this against two real backends and a real Hub it starts
itself.

### What a Hub costs you

Worth reading before you run one, because none of it is hidden:

- **It is one process that can reach every machine bound to it.** That is the trade the scoped
  credentials make survivable rather than eliminate — nothing it holds is a master token, and
  every credential is revocable from the machine it grants access to, under that machine's
  **Settings → Hubs**.
- **With provisioning, that reach includes writing configuration.** A compromised Hub can create
  Pocket Agents, MCP registries, providers and skills on every bound host. The mitigations are
  the ones already listed — revocable per-host credentials, no master tokens — plus the fact
  that both sides log every provisioning action, so the receiving machine keeps its own record
  of what changed and which Hub changed it. It is not eliminated, and it is the reason to bind
  only Hubs you run.
- **It is a single point of failure for *reaching* your backends**, though not for their state.
  Each one stays directly usable with no Hub involved.
- **An operator can extract a stored credential** by repointing a host's base URL and then
  removing it, which sends the credential to whatever is listening. Not an escalation — the
  same person holds the master token that minted it — but it does mean "the Hub never shows you
  a credential" is a UI property, not a guarantee.
- **Losing the Hub's data directory** loses the registry, and losing
  `POCKETAGENT_SETTINGS_ENC_KEY` makes every stored credential undecryptable. Neither loses
  access: re-add and re-bind each host, then revoke the orphaned credentials on each backend.

---

## Releases

### Versioning

The **root `package.json` `version` is the repo's semver**, and it is the single source for
three things that used to disagree: the server's `/health` version, the web bundle's
`__APP_VERSION__`, and the image tags. The other three `package.json` files are kept identical
to it — they are private and nothing resolves them as dependencies, so a version there is
build identity rather than dependency semantics, and four numbers allowed to drift would mean
"the repo's version" depended on which file you opened.

```bash
pnpm version:set 1.2.3     # writes all four package.json files
```

A test asserts they match, so a hand-edit of one fails the suite rather than shipping a server
that contradicts its own image tag.

### Cutting one

```bash
pnpm version:set 1.2.3
git commit -am 'Release 1.2.3'
git tag 1.2.3              # no `v` prefix
./build.sh -p              # build all three targets and publish
```

`./build.sh` refuses to push unless HEAD carries a tag that parses as a release version, and
refuses if that tag disagrees with the committed version — one of the two is wrong, and
guessing which would publish an image whose `/health` contradicts its own tag. A commit with
no release tag still builds all three targets (so a broken `Dockerfile` fails on the commit
that broke it) and publishes nothing, which is what lets `:latest` mean "the most recent
release" rather than "whatever built last night".

**A prerelease moves nothing.** `1.2.3-rc.1` publishes only its own exact tags: no
`:1.2`, no `:latest`. Those two are what an operator gets when they have *not* pinned, so a
release candidate reaching them would ship an unfinished build to precisely the people who
never asked to test one.

### Pinning by digest

`./build.sh -p` writes `release-digests.txt` and CI publishes it as a build artifact:

```
registry.shifamily.com/homestack/pocketagent-server:1.2.3 sha256:...
registry.shifamily.com/homestack/pocketagent-server:1.2.3-claude sha256:...
```

A deployment that pins `@sha256:...` gets the image that was tested; one that pins `:1.2` gets
whatever the next patch release moves that tag to.

### What "reproducible" does and does not mean here

Rebuilding the same tag gives you the same **semver, the same dependency tree** (the build
installs with `--frozen-lockfile`) and the same pinned agent CLI versions from
`docker/agent-versions.env` (for the agents whose installers can be pinned; see above). It does **not** give a byte-identical image, and nothing here
claims it does: the web bundle embeds a build timestamp for display, the base image is
referenced by tag, and three native modules are compiled during the build. Pin by digest when
you need "the exact image that was tested" — that is what the digest list is for.

### CI

One Bamboo plan, defined in `bamboo-specs.yaml`, whose job is two scripts:

```bash
./test.sh      # install --frozen-lockfile, vitest (JUnit XML), lint, typecheck
./build.sh -p  # build all targets; publish only from a release tag
```

Both are runnable locally and are where all the logic lives — the Bamboo job itself is a
checkout, one script task and a JUnit parser, matching every other plan on that server.
`test.sh` runs the tests *first* and never aborts early: the parser globs
`test-reports/*.xml`, and a run that died before vitest would report "no test results found"
instead of naming the failure.

The plan's one-time creation is manual (this Bamboo has no plan-creation REST API); the steps
are at the top of `bamboo-specs.yaml`.

The release driver builds **four** targets in one loop: the server's three (`thin`, `claude`,
`all`) and the Hub (`hub`). The Hub publishes under its own image name, `pocketagent-hub`,
rather than as a suffixed tag of the server's — an operator pulling
`pocketagent-server:1.2.3-hub` would reasonably expect a backend. Both images are stamped with
the same `POCKETAGENT_BUILD_VERSION`, which is what lets the version-drift check compare a Hub
and a backend without knowing which is which.

---

## Deploying to another machine

This is the from-source path. **For a deployment, prefer the container image** — it exists
precisely to make this section unnecessary ([Running with Docker](#running-with-docker)).
What follows is still what you want for development, and for a machine where you would rather
not run a container runtime.

**Build on the target.** Not because it is tidier, but because two dependencies leave you
no choice: `node-pty` publishes prebuilt binaries for macOS and Windows and *not* for
Linux, so it compiles from source on every Linux install, and `better-sqlite3` does the
same. Both artifacts are pinned to the architecture, C library and Node ABI they were
built against.

```bash
# Debian/Ubuntu. tmux is optional but see Process backends.
sudo apt install -y build-essential python3 git tmux
# Node 22+ — nvm, NodeSource, or your distribution's package
npm i -g pnpm@12

git clone https://github.com/stone-shi/pocketagent && cd pocketagent
pnpm install          # compiles node-pty and better-sqlite3 here
pnpm build
pnpm generate-token   # writes a fresh token into .env, mode 600
pnpm start
```

Then wire up the service unit from [Running it as a service](#running-it-as-a-service).

### What has to be true on the target

- **Node 22+**, and a C++ toolchain for the two native modules.
- **The agent CLI is installed *and already logged in*.** PocketAgent runs `claude` the way
  you would; it holds no provider credentials of its own and cannot log in for you. This is
  the step that gets forgotten.
- **A fresh access token.** Generate one there — do not copy `.env` across. One token on two
  hosts means one leak costs you both.
- **A fresh database.** Do not copy `pocketagent.db`. It records sessions that
  reference process ids, tmux session names and paths belonging to the old machine, along
  with a project-folder list pointing at directories that may not exist here. Start empty
  and add folders from the app.

### Copying a build instead

Works only when the target genuinely matches: same architecture, same or newer glibc, same
Node major version. Then `pnpm build` and ship the tree including `node_modules`, and the
target needs no compiler.

Weigh it first. The Claude Agent SDK resolves a platform-specific binary — there are
`linux-x64`, `linux-arm64` and musl variants — and it is the better part of 300 MB on its
own, so you are moving roughly 430 MB to avoid installing `build-essential`. A
`node_modules` built here will also fail on a musl distribution such as Alpine, on arm64,
or against an older glibc, usually with a linker error rather than a clear one.

If you later upgrade Node across a major version, the compiled `.node` files stop loading
with an ABI mismatch. `pnpm rebuild` fixes it.

### The data root

Everything PocketAgent itself owns and writes lives under one directory:

```
<checkout>/data/
├── pocketagent.db          # sessions, project folders, webhooks, cron jobs, secrets
├── planner-workspaces/     # each Pocket Agent's scratch directory
└── planner-skills/         # the global skills root
```

`POCKETAGENT_DATA_DIR` moves all three together. Unset, it is `<checkout>/data` — which is
where every install had it before the variable existed, so leaving it alone changes nothing.

You want it for one reason: the data root is the only thing that has to survive replacing the
checkout. A container image contains the checkout, so without this the database dies with the
image.

Two things are worth knowing before you set it:

- **It is refused if it resolves inside a project folder**, with an error at boot. The
  database holds webhook signing secrets in plaintext and custom provider API keys
  encrypted, and an agent working in that tree can rewrite or delete the lot — `git clean
  -xfd` is enough. A project folder *inside* the data root is allowed: one volume holding
  both your repos and the state is a reasonable layout, and the hazard does not run that way.
  Only the folders seeded from `POCKETAGENT_WORKSPACE_ROOTS` are checked, so a folder you add
  later from the app can still come to contain the data root and nothing will re-check it.
- **Every boot logs the data root it opened** (`"data root"`, at `info`). If a server looks
  like it has someone else's chats in it, read that line first.

If you run the demo scripts (`pnpm demo:*` against a `PA_BASE` scratch server), point this at
a throwaway directory outside every project folder. That is how a scratch server isolates
itself now; previously the only way was to run it from a second checkout, because the database
path was always inside the checkout that served it.

### On containers

**There is a supported image — see [Running with Docker](#running-with-docker).** This section
is the reference for *why* its volume contract looks the way it does, and it applies to any
containerised deployment, including one you build yourself.

Containers do not give you isolation here, and it is worth being clear that they were not
adopted for it. The point of PocketAgent is to run agents against *your* filesystem with
*your* CLI credentials, so a working container mounts your repositories, your agent config
directory and your credentials; what it buys is a pinned, repeatable runtime — no C++
toolchain, no Node ABI to match — not a security boundary. The agent can still do anything
your user can, inside what you mounted.

`POCKETAGENT_DATA_DIR` on a mounted volume is the first half. The rest of what the process
reads lives outside the checkout too, and none of it is configurable:

| Path | Read by | What to do |
| --- | --- | --- |
| `~/.claude/projects` | Claude Code transcript discovery | Mount `$HOME`. |
| `~/.gemini/antigravity-cli/brain` | agy transcript discovery | Mount `$HOME`. |
| `~/.pi/agent/sessions` | pi transcript discovery | Mount `$HOME`. |
| `~/.opencode/bin`, `~/.local/bin`, `~/.pi/agent/bin`, `~/.cargo/bin`, `~/.npm-global/bin` | agent binary discovery, in that order | Nothing extra: they are inside `$HOME`. Pin the CLIs in the image (`-claude`/`-all`) or install them from Settings. |

The three transcript directories are deliberately *not* configurable. They are other
programs' private state and PocketAgent is only a reader; a setting pointing somewhere the
owning CLI never writes would fail as "no history" rather than as an error, which is worse
than having no setting at all.

**Mount every project folder at the same absolute path it has on the host.** This one is not
obvious and it fails silently. Claude Code derives a transcript's directory name from the
working directory (`~/.claude/projects/<encoded-cwd>/`, with `/` replaced by `-`), and that
encoding is lossy and never inverted. A repo at `/home/you/src/app` on the host, mounted at
`/workspace/app` in the container, produces an entirely different directory name — so every
conversation you already had becomes undiscoverable, with an empty history and no error. The
pi and agy stores key off session directories the same way, and the database itself records
absolute `cwd` values on session and webhook rows, so a relocated workspace mount and a
relocated data root can also invalidate each other.

---

## Accessing from another device

### Tailscale (recommended)

Tailscale gives you an encrypted private network plus real HTTPS certificates, which is
exactly what this needs.

```bash
# On the Linux host
tailscale up
```

Then either:

**Option A — Tailscale Serve (HTTPS, easiest and safest).** Keep PocketAgent on loopback
and let Tailscale terminate TLS:

```bash
# .env
HOST=127.0.0.1
NODE_ENV=production
```

```bash
tailscale serve --bg 8787
tailscale serve status     # prints the https://<host>.<tailnet>.ts.net URL
```

Open that HTTPS URL on your phone. Because it is real HTTPS, `Secure` cookies work with no
extra configuration. Only devices on your tailnet can reach it.

**Option B — bind to the tailnet address directly (plain HTTP).**

```bash
# .env
HOST=100.x.y.z                    # your tailscale IP, from `tailscale ip -4`
POCKETAGENT_COOKIE_SECURE=false   # required: browsers drop Secure cookies over http://
```

Traffic is still encrypted by WireGuard, but the browser sees plain HTTP, so the `Secure`
flag has to be off or login will silently fail.

### LAN

```env
HOST=0.0.0.0
POCKETAGENT_COOKIE_SECURE=false
```

Anyone on the network can now reach the login page. Only do this on a network you trust,
and prefer a VPN.

### Behind a reverse proxy

Terminate TLS at the proxy, forward to `127.0.0.1:8787`, and make sure it forwards
WebSocket upgrade headers:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;     # terminals idle for a long time
}
```

Then set `POCKETAGENT_TRUST_PROXY=true`, `NODE_ENV=production`, and
`POCKETAGENT_ALLOWED_ORIGINS=https://your.domain`.

### Add it to your home screen

On iOS, Share → Add to Home Screen. It opens fullscreen without Safari's chrome, which
gives the terminal noticeably more room.

---

## Using it

1. **Log in** with your access token.
2. **On a desktop browser you get a two-pane layout**: the chat list stays in a
   sidebar and a session opens beside it, so switching chats is a click rather than a
   round trip through the home screen. Below 900px — or on any touch device — you get the
   phone layout described here. That is decided by viewport width and pointer type, live,
   so dragging a window narrow switches layouts without a reload. See
   [Layouts](#layouts).
3. **Home screen — Projects.** A folder per workspace directory, with every chat that has
   happened in it underneath. Tap a folder to collapse it, a chat to open it, the ✎ beside a
   folder to start a chat there, or the search field to filter across all of them. The header
   names the host you are connected to.

   Live sessions and finished conversations share one list, marked with a green dot when
   running. Tapping a finished one resumes it as a new branch — the original transcript is
   only read. See
   [Picking up work you started elsewhere](#picking-up-work-you-started-elsewhere).
4. **Compose (✎).** Four rows say what is about to happen — host, workspace, agent and
   interface, and either "New chat" or something already on the host — over a prompt box.
   The session is created when you send, and your text becomes its first turn, so nothing
   is left running if you back out.

   The fourth row lists chats in the chosen directory **and anything under it**, so picking
   a workspace root still finds the work inside it; a chat resumed from a subdirectory runs
   where it belongs, not where the row above points. Chats already **running** are offered
   too — picking one joins it and sends your prompt there rather than starting a second
   process against the same conversation.

   The ⋯ menu holds the rest: refresh, sign out, and **More session options…**, which is the
   older dialog and the only place offering *Continue in place* and *Attach to a tmux pane*.
5. **Terminal.** Type directly into it, or compose in the prompt box at the bottom and hit
   Send — much easier for long prompts on a phone.
6. **Answer prompts yourself.** When Claude asks "Do you want to make this edit?", you
   answer with `1`/`2`/Enter/Esc, exactly as at the terminal. PocketAgent never answers for
   you.
7. **Key bar** provides Esc, Ctrl, ^C, Tab, arrows, Enter, and a `»` overflow with ⌫,
   ⇧Tab, ^D, ^Z, ^L, ^R and `1`/`2`/`3`/`y`/`n` for menu answers.
8. **Close the tab whenever.** The process keeps running. Reopen later and you get the
   buffered history plus everything that happened while you were gone.

### Copying a message

Every prompt and answer has a copy icon underneath it, which copies the **markdown
source** rather than the rendered text — a code block you cannot paste back into an editor
is not much use.

It works over plain HTTP. `navigator.clipboard` only exists in a secure context, so on a
LAN or tailnet address it is simply undefined; the button falls back to the older
selection-based copy. The icon becomes a tick on success; the only case that spells
anything out is failure, where it says *Couldn't copy* rather than silently doing nothing.

### Tidying the list

There is no "delete a project" — a project is a directory that has chats in it, so it
disappears when its last chat does. Two controls get you there, and **neither deletes
anything from disk**:

- **✕ on a finished chat** removes it from the list. The session record goes and the
  conversation is remembered as removed so the next scan does not put it back. The
  transcript stays where it is and stays resumable from a terminal. Running chats have no
  ✕ — stop them first, or the process would be left alive with no way back to it.
- **⋯ on a folder** offers *Clear N finished chats* and *Hide this project*.

Hiding is reversible from **⋯ → Hidden projects…**, which also lists the directories hidden
by default: `__pycache__`, `node_modules`, `.venv`, `dist`, `build`, `target`, `.next` and
friends. Those are defaults, not rules — unhiding one is remembered and wins over the
pattern.

To actually delete a conversation you delete its `.jsonl` under `~/.claude/projects`
yourself. PocketAgent will not do it: that file belongs to Claude Code, and losing it loses
the conversation everywhere, not just here.

### Layouts

There are two, and which you get is decided by `matchMedia`, never by the user-agent
string. UA strings lie by design, the platform parts are being frozen in favour of Client
Hints, and none of it answers the question that matters: a desktop window dragged to half
width wants the compact layout, and a tablet with a trackpad wants the roomy one.

```
(min-width: 900px) and (pointer: fine)   ->  two panes
anything else                            ->  single column
```

Both halves matter. Width alone hands a landscape tablet a sidebar it loses the moment a
keyboard appears; pointer alone hands a narrow desktop window a layout that does not fit.

The desktop pane also drops the on-screen key bar — a real keyboard already has Esc and
Ctrl — and holds the transcript to a readable column while leaving the terminal full width,
because a terminal is a character grid and constraining it just wastes the space.

### More than one machine

If you register a second host (⋯ → **Hosts…**), the home screen groups by machine instead of
adding anything to a row: one heading per host, with the same three categories under each. The
default view is **all hosts** at once; picking one narrows to it, and the URL says which
(`#/h/dev02/s/<sessionId>` is shareable and survives a reload). Switching is a state swap, so a
session running on one machine keeps streaming while you read another's chats.

Desktop gets a rail of host tiles on the far left; a phone gets the same list as a sheet behind
the header chip, because a permanent column is not worth the width for something you switch
rarely. Either way, an offline or too-old host renders as a legible line in its own group and
leaves every other host alone. With one host registered, none of this appears.

A host is a **path prefix on this origin** — see limitation 26 for why, and for what still has
to be true of your reverse proxy.

When one host is running an older build than another, its row says so — a quiet `update` badge
on the host heading, the whole sentence in the tile's tooltip or on the sheet row
("`stone-dev01` is on 1.4.2, 1.5.0 available"). "Behind" and "too old to talk to" stay separate
states: a lagging host still works, and one whose wire protocol this bundle cannot negotiate
says *that* instead, because it needs upgrading before it can be used at all rather than
whenever convenient.

Nothing here downloads or installs anything. With no Hub, "the latest version" simply means the
newest build any registered host reports, so a single host — or a fleet that is uniformly stale
— reports no drift at all. That is deliberate: the alternative is this server phoning a release
feed on the internet to ask.

### Restarting a host

Settings → **This Host** shows the build it is running and a **Restart** button. The server's
only role is picking a safe moment to stop: it drains, exits, and whatever supervises it starts
it again **on whatever image that unit points at**. There is no version picker and no upgrade
button, and the API has no field for naming an image, tag or digest — the update source is
fixed at deploy time, in your compose file or systemd unit. "Upgrade this host from a browser"
would otherwise mean "run an arbitrary image on that host".

By default it **refuses while anything is mid-turn** and names what: a session whose agent is
working, or one parked on an approval only you can answer, or a Pocket Agent chat mid-turn.
There is no timeout — a blocked request keeps refusing until the work finishes or you press
**Restart anyway**, which interrupts it and says exactly what it is interrupting. Queued
webhook deliveries and queued prompts are never blockers: they are on disk and resume
afterwards.

What survives is the same as for any other restart: terminal sessions on the tmux backend are
re-adopted, and everything running under the agent SDK — agent chats, cron runs, webhook
deliveries — ends and shows as **interrupted**, whichever backend is configured. Sessions are
not silently listed as live afterwards.

### Reconnect behaviour

Every chunk of terminal output carries a sequence number. The client tracks the highest one
it has rendered; on reconnect it sends that number back and the server replays exactly the
gap. Dropping the network does **not** clear your terminal.

If you were away long enough that the missing output has been evicted from the server's
ring buffer, the server says so, the client clears the screen and writes what remains, and
a banner tells you older output was dropped. (A partial ANSI stream would otherwise corrupt
the display.)

The connection badge reads **Connected**, **Reconnecting**, **Disconnected**, or the
session's own status. Reconnection uses exponential backoff with jitter, capped at 15s.

Unsent text in the prompt box is preserved across reconnects and page reloads.

---

## Security model

**PocketAgent is remote shell access. Exposing it publicly is equivalent to handing out a
terminal on this machine, running as your user, with your SSH keys, your cloud credentials,
and your source code.** Treat the access token like a root password. Put it behind
Tailscale, WireGuard, or a Cloudflare Tunnel; do not put it on the public internet.

What it does enforce:

| Boundary | Implementation |
| --- | --- |
| Default reachability | Binds `127.0.0.1`; anything else is explicit and logs a warning. |
| Authentication | Every route except `/health`, the login endpoints, `POST /api/auth/hub-bind` and `POST /api/hooks/:slug` requires either a valid session cookie or a hub credential — including the WebSocket upgrade. `hub-bind` takes the access token in its body and is rate-limited like login; the delivery route authenticates itself by HMAC over the raw request body (see [Inbound webhooks](#inbound-webhooks-and-what-they-change)). |
| Health disclosure | `/health` is unauthenticated on purpose, so a front server can tell whether a backend is usable before it holds a credential for it. It returns only `status`, `version`, `protocol` and `uptimeSeconds` — the semver does tell an unauthenticated caller which build is running, which is accepted; a commit SHA, build host, path or config value must go behind the cookie instead, and a test pins the field list so adding one is deliberate. |
| Token handling | The master token is exchanged once at login for a random 32-byte session id in an `HttpOnly; SameSite=Strict` cookie. The token never reaches JavaScript, localStorage, or the URL. Comparison is constant-time. |
| Hub credentials | A Hub authenticates with a named, revocable credential instead of storing this backend's access token — see [Hub credentials](#hub-credentials). Only `sha256(token)` is stored, so a copied database yields nothing presentable, and the access token is never accepted as a bearer token. |
| Brute force | Login is rate-limited to 8 attempts/minute; other routes to 300/minute. |
| CSRF | `SameSite=Strict` plus an explicit `Origin` check on every state-changing request and on the WebSocket handshake. |
| Command execution | The browser picks an **agent id** from a server-side registry and a **cwd**. It cannot supply a command, arguments, or environment. Adapters return `argv[]` and are spawned without a shell. |
| Filesystem | Requested directories are `realpath`'d and must be contained in a configured root. This defeats `..`, symlink escapes, and prefix tricks like `/home/me/srcEVIL`. |
| Secret leakage | The whole `POCKETAGENT_*` namespace is stripped from the child environment, so `env` in a session cannot print the master token. |
| Input validation | Every WebSocket frame is Zod-validated; unknown types are rejected, not ignored. Message size, input length, and terminal dimensions are all capped. |
| Logging | Terminal input and output are never logged. Cookies and tokens are redacted. Only lifecycle events are recorded. |
| Memory | Output buffers are byte-bounded per session; a client that stops reading is disconnected past 8 MB of backpressure. |
| Browser hardening | CSP, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`. |

What it deliberately does **not** do: sandbox the agent, restrict what it can do once
running, or provide multi-user isolation. It is single-user by design. Anyone who
authenticates has your full user privileges.

The optional terminal classifier emits advisory hints (`working`, `waiting_for_input`,
`possible_approval_prompt`, `idle`) that drive a best-effort push notification when a
terminal session goes quiet (see below). These hints **never** cause input to be sent and
can never approve anything.

### Hub credentials

A Hub — one front end onto several PocketAgent backends — needs a credential for each backend
it talks to. The obvious choice is the wrong one: if it stores five access tokens, then one
compromised Hub is five machines rooted permanently, and the only remedy is editing five `.env`
files by hand and re-pairing everything.

So a backend mints credentials of its own instead:

```bash
# The Hub does this once, with the access token an operator pasted into it.
curl -X POST http://127.0.0.1:8787/api/auth/hub-bind \
  -H 'content-type: application/json' \
  -d '{"token":"<POCKETAGENT_AUTH_TOKEN>","label":"kitchen hub"}'
# => {"id":"…","label":"kitchen hub","token":"pah_…","createdAt":…}
```

The Hub keeps the `pah_…` token and discards the access token; from then on it sends
`Authorization: Bearer pah_…` on every request, including the WebSocket upgrade. The backend
lists what is bound under **Settings → Hubs** and revokes any of them there, which takes effect
on the next request with no restart.

Four properties are worth stating plainly, because each one is a deliberate choice:

- **It is not a permissions model.** A hub credential is full access, exactly like a session.
  What it buys is revocability and not having to write the root token down; restricting what a
  Hub may *do* is a separate question that has not been answered yet.
- **The access token is never a bearer token.** It authenticates `login` and `hub-bind`, and
  nothing else. Accepting it as a bearer token would put back the unrevocable root credential
  this exists to remove.
- **The backend stores only a digest.** There is no reveal endpoint, and not because of a
  policy — after the bind response there is nothing left to reveal. A Hub that loses its token
  binds again, and the operator revokes the stale row.
- **A Hub can revoke other hubs**, since it has full access. That is denial of service rather
  than escalation: it cannot mint a replacement, because binding requires the access token.

Binding requires no new configuration, and the credential is bound to no particular Hub
implementation. This repository ships one — see [Running a Hub](#running-a-hub) — but the
exchange above is just an HTTP call, so anything that can make it can hold a credential.

### Continuing a chat on another provider

Optional, off until you create one, and the second feature that changes where your data goes. A
**custom Claude provider** runs the same `claude` binary against a third-party
Anthropic-compatible endpoint, so a conversation that has hit an Anthropic rate limit can be
*continued* rather than abandoned: Claude Code derives its transcript path from the working
directory rather than from which API it talked to, so the new turns append to the same
conversation the Anthropic turns are in.

**Setting one up.** Generate an encryption key once, since the API key is stored encrypted in
`pocketagent.db`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# add the output to .env as POCKETAGENT_SETTINGS_ENC_KEY=..., then restart
```

Then open **Settings → Custom Claude Providers → Add provider** and fill in a name, the base URL
(a bare origin — Claude Code appends its own path), the API key, and the model ids the endpoint
actually serves. Take those from the provider's own `GET /models`: the CLI reports *Anthropic's*
catalog whatever the base URL says, so this list replaces it, and a guessed id yields a picker
entry the endpoint rejects. Adding, editing or deleting a provider takes effect immediately —
there is no restart, and no environment variable involved.

This is the one thing in PocketAgent that sends repository contents somewhere other than
Anthropic, so:

- Nothing exists until you create it, and a provider whose key cannot be decrypted is greyed out
  rather than failing at spawn.
- A session using one **says so persistently** in the UI, on every visit — not just at creation
  — naming the provider and its base URL. Cost figures in that session are computed with
  Anthropic's price list and are therefore wrong; the same banner says that too.
- Stock `claude` is unaffected. No global environment change is needed, and every other session,
  scheduled job and webhook delivery keeps talking to Anthropic.
- **Scheduled jobs and inbound webhooks refuse a provider by default**, at the route. They would
  work mechanically, but shipping a repository to a third party on a timer or on a stranger's
  Jira edit is a decision that deserves to be made on purpose. Each provider has its own
  **"allow unattended use"** toggle — off by default, per provider, and warned about in the
  editor — which is the only thing that lifts it.
- The API key is write-only. It is never returned by any route and there is no reveal action:
  editing a provider re-enters the key, or leaves the field blank to keep the stored one.
- Do not rotate `POCKETAGENT_SETTINGS_ENC_KEY` without re-entering every provider's key. A row
  encrypted with the old key cannot be decrypted with a new one; the provider stays listed but
  greys out, and the server logs which one.

To use it: stop the chat, then pick the agent from the **"Continue as … / Change"** row above the
composer and send your next message. One caveat worth knowing — this feature gets reached for
*because* a conversation grew long, and a long transcript may exceed the third-party model's
context window on the very first resumed turn. `/compact` before switching if that happens.

**Upgrading from the old environment variables.** Before PA-28 there were exactly two variants,
`claude-deepseek` and `claude-omniroute`, configured through `POCKETAGENT_DEEPSEEK_*` and
`POCKETAGENT_OMNIROUTE_*`. Those variables are no longer configuration, but they are not
ignored either: on the first boot after upgrading, if any of them is still set *and*
`POCKETAGENT_SETTINGS_ENC_KEY` is set, the server imports one provider row per configured
variant, logs a deprecation warning, and records that it has done so — after which they are
never read again and can be deleted from `.env`. If the encryption key is not set the import is
*deferred* rather than skipped, so generating a key and restarting still picks it up. Two things
to know: the imported provider has "allow unattended use" **off**, exactly as the old variants
did, and its agent id changes (`claude-deepseek` becomes `custom-claude:deepseek`), so an old
chat's row keeps naming the old id and can no longer be continued on it — continue that
conversation on the imported provider from the "Continue as…" picker instead. Deleting the
imported provider in Settings is permanent; the still-present variables will not resurrect it.

### Gemini Live in a Pocket Agent chat

A Pocket Agent can use Google's **Gemini Live** for live mode instead of the built-in
live-stt pipeline. It hears you directly, answers out loud with native barge-in, and calls
that agent's own tools. Turn it on in two places:

1. **Settings → Pocket Agent → Gemini Live.** Paste an AI Studio (Gemini API) key. Vertex keys
   do not work, because the short-lived tokens used here are an AI Studio feature. Storing the
   key needs `POCKETAGENT_SETTINGS_ENC_KEY`, the same as a custom Claude provider. The model,
   voice and idle auto-off are set there too.
2. **The agent's editor → Live mode → Gemini Live.** This is per agent. Every other agent, and
   every coding session, keeps the built-in pipeline.

What changes about where your data goes, and what does not:

- **Your voice, the conversation and tool results** (files the agent reads, session output) are
  sent to Google while live mode is on. The chat says so on every visit.
- **The API key never leaves this server.** It is stored encrypted, never returned by any route
  and never logged. The browser gets a single-use token that expires within 30 minutes and is
  locked to that agent's instructions and tools. A copied token cannot be turned into a general
  Gemini session on your key.
- **Approvals do not change.** Every tool call Gemini makes goes through this server's approval
  gate, exactly as a typed turn's would. Mutating tools still wait for the on-screen button,
  with no timeout, and saying "yes" out loud does not approve anything.
- **Cost.** Gemini bills audio for as long as the mic is open, including silence. Live mode turns
  itself off after 5 minutes without speech by default.

### Inbound webhooks, and what they change

A webhook is the one feature that inverts the posture above: it requires that some machine you
do not control can open a connection to this process and hand it bytes that cause an agent to
run. If you are not using webhooks, none of this applies — no webhook exists until you create
one, and the endpoint rejects everything without a valid signature.

**Exposure, ranked.** These are not equivalent; pick the highest one you can.

1. **Jira on the same tailnet (recommended).** Jira Data Center is on-prem for most people who
   can use a signing secret at all. Put its host on the tailnet, keep the `127.0.0.1` bind, and
   the threat model barely moves — nothing is publicly exposed.
2. **A reverse proxy that forwards only `/api/hooks/*` (acceptable).** TLS at the proxy, forward
   to `127.0.0.1:8787`, and — the part that matters — return 404 for everything else, so the
   API, the WebSocket and the UI stay on the tailnet:

   ```nginx
   location /api/hooks/ {
     proxy_pass http://127.0.0.1:8787;
     proxy_set_header Host $host;
     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
     proxy_set_header X-Forwarded-Proto $scheme;
   }
   location / { return 404; }
   ```

   Set `POCKETAGENT_TRUST_PROXY=true` so rate limiting keys on the real client IP.
3. **`HOST=0.0.0.0` (don't).** The login page, the API and the terminal WebSocket are then on the
   same interface as the webhook.

**A proxy-only posture is not enforceable by the app.** The server cannot distinguish a request
that arrived via a proxy from one that arrived directly: `X-Forwarded-For` is a header and
`trustProxy` is a claim about your own topology. Anything the app could "enforce" here would be
advisory, so it does not pretend to.

**Prompt injection is the real risk, not the endpoint.** A Jira issue's summary, description and
comments are written by whoever can file or comment on a ticket — in most organisations every
employee, and in a Service Desk project possibly an anonymous portal submitter. That text is
interpolated into a prompt for an agent with shell access, as your user. What PocketAgent does
about it:

- Only an enumerated allowlist of Jira fields reaches the prompt, never a generic path walker.
- Free text is stripped of control, zero-width and bidi characters, truncated, and wrapped in a
  per-delivery nonce fence that cannot be closed from inside, behind a preamble telling the
  agent it is data.
- Untrusted text reaches the prompt body and nothing else — never a branch name, path, title or
  command.
- `skipPermissions` defaults to **off** for webhooks, unlike scheduled jobs. A delivery that hits
  an approval waits for you, indefinitely, and pushes a notification.
- The editor recommends a per-delivery worktree, and a required-label filter — which is worth
  more than everything above, because it narrows the trigger from "anyone who can comment on a
  ticket" to "anyone who can label this project".

**Be clear about what a worktree does and does not contain.** It contains *file* damage: a
successful injection dirties a throwaway branch and leaves a diff to read, instead of editing the
tree you are working in. It does **not** contain `git push`, `gh`, `curl`, an SSH key, an MCP
server holding a Jira or GitHub token, or `~/.aws/credentials`. A successful injection in a
webhook session can exfiltrate anything your machine can reach. Real isolation is a container,
and that is a different piece of work.

**Do not point a webhook at this checkout.** `pocketagent.db` holds webhook signing secrets
in plaintext — HMAC needs the key material, so there is no alternative — and an agent running
with approvals bypassed inside this repository could read them. Moving the database out with
`POCKETAGENT_DATA_DIR` does not make this safe: the checkout still holds the `.env` with your
access token in it.

---

## Two interfaces: native and terminal

Every session is driven over one of two **transports**, chosen per session:

| | **Native** (`structured`) | **Terminal** |
| --- | --- | --- |
| What you see | Chat bubbles, markdown, tool cards, inline diffs | The real CLI in xterm.js |
| Approvals | Buttons: Allow / Allow-for-session / Deny with a reason | Keystrokes, exactly as at the terminal |
| Reasoning | Collapsed behind "Thought for N words" | Inline, as the CLI prints it |
| Cost & tokens | Shown per turn and per session | Only if the CLI prints them |
| Works with | Agents that expose a structured mode (today: Claude Code) | **Anything with a CLI** |
| Fidelity | We render the UI, so new agent affordances need UI work here | Exact, forever |
| Under the hood | Claude Agent SDK (`query()` + `canUseTool`) | `node-pty` |

Claude Code defaults to **native**; `shell` is terminal-only. Pick per session in the
New Session dialog, or via `transport` on `POST /api/sessions`.

**Terminal mode is not deprecated and is not going away.** It is the universal path — it
works with any CLI ever written and never goes stale — and it remains the escape hatch when
the native UI does not render something.

### How the native transport works

```
browser ──WS── PocketAgent ──Agent SDK query()── claude ── your files
   ▲                │
   └── normalized ──┘   text · thinking · tool_use · tool_result
       agent events     permission_request · turn_complete
```

The SDK emits ~40 message types; the server normalizes them into a **small union of ~11
events** before anything reaches the browser. That keeps the UI decoupled from any one
agent's schema — a future Codex or Gemini structured adapter emits the same events and the
UI works unchanged.

Approvals use the SDK's `canUseTool` callback. When the agent wants to do something that
needs consent, the callback parks until a human answers; PocketAgent forwards the SDK's own
rendered prompt (so the phone shows the same wording the terminal would), plus a diff of the
proposed change. "Allow for this session" adopts the SDK's suggested permission rules, which
is the equivalent of the terminal's don't-ask-again.

**There is no approval timeout, by design.** An unanswered request must never silently
become an allow, and turning it into a deny would throw away work you simply had not looked
at yet. It waits.

**Approvals can be bypassed, but only if you say so.** The "New session" dialog offers a
"Skip approvals for this session" toggle for agents that support it — off by default. Turning
it on runs Claude Code with `--dangerously-skip-permissions` (terminal transport) or the
Agent SDK's `bypassPermissions` mode (structured transport): every tool call runs
immediately, unattended. A session running this way says so persistently in its header, not
just at the moment you created it. Use it only for a session you trust completely.

**A scheduled job is the one exception, and it defaults to bypassed.** There is nobody
awake at 3am to answer an approval, so a job created with approvals routed to the browser
would park on its first tool call and never finish — the default would make the feature
useless rather than safe. The per-job switch is still there and can be turned off, and
turning it off does *not* introduce a timeout: the run waits indefinitely for you and sends
a notification, because an unanswered approval must never become an allow. A job running
bypassed says so on its row, in the list, and on every run it produces. See
[Scheduled jobs](#scheduled-jobs).

### What native mode does not give you

- **Durability.** The Agent SDK owns the child process, so structured sessions do not use
  the tmux backend and do not survive a PocketAgent restart. What *is* durable is the
  conversation: the agent persists its own history, and the session's `agentSessionId` can
  be passed as `resumeAgentSessionId` to continue it.
- **Universality.** Only agents with a machine-readable mode qualify.
- **Automatic coverage of new CLI features.** Anything Claude Code adds to its TUI needs
  matching work here before it shows up.

## Picking up work you started elsewhere

Most of the time you want to continue something, not start it. There are two ways, and they
are different in kind: one continues a *conversation*, the other joins a *terminal*.

| | Resume a conversation | Attach to a tmux pane |
| --- | --- | --- |
| What you get | the history, in a fresh process | a live mirror of a running pane |
| Interface | native (chat, tool cards) | terminal |
| Needs the original still running | no | yes, by definition |
| Effect on the original | none — it is only read | you become a second viewer |
| Enabled by default | yes | **no** |

### Resume a conversation

**New session → Resume.** Claude Code writes every session to
`~/.claude/projects/<encoded-cwd>/<id>.jsonl`, so anything you started at a terminal is
resumable from a phone hours later — the original process does not need to be alive, or
ever to have known about PocketAgent.

The list shows the title, workspace, branch, age, message count and last prompt. A green dot
means an agent is running in that directory right now.

Each conversation offers two actions:

- **Resume as new branch** (default). Starts from the full history but writes to a *new*
  transcript. The original file is only ever read.
- **Continue in place…** Appends to the original transcript. This needs an explicit
  confirmation, and the confirmation is loud if something is already running there.

The default is branching because resuming in place while the original is alive genuinely
breaks: both processes append to the same file, neither sees the other's turns, and both
edit the same working tree. Verified rather than assumed — two processes resuming one id
produced a single interleaved transcript that each read back as if it were its own.

Only conversations whose recorded working directory resolves inside a workspace root are
listed. The directory-name encoding is lossy (`src/agents-remote-control` and
`src/agents/remote/control` encode identically), so containment is decided on the `cwd`
recorded inside the transcript, never on a path reconstructed from the directory name.

Liveness is reported honestly as *"a Claude session is running in this directory"* rather
than *"this conversation is open"*. Claude does not hold its transcript open, so the check
is directory-level and the UI says so.

### Attach to a tmux pane

**Off by default.** Point PocketAgent at a tmux socket you own and it will offer to attach
to panes running there:

```bash
# .env — `default` is the socket a plain `tmux` command uses
POCKETAGENT_ADOPT_TMUX_SOCKET=default
```

**New session → Attach** then lists panes, and picking one requires a confirmation that
spells out what is about to happen. Two properties of a foreign tmux server make this
different from PocketAgent's own:

- **You are a guest.** Your `.tmux.conf` is in force, including your prefix key, so
  keystrokes from the browser can drive tmux itself. PocketAgent does not rewrite your
  server's options to prevent that — silently reconfiguring your tmux would be worse than
  the risk.
- **Sizing is shared.** tmux sizes a window to its most recent client, so a phone attaching
  at 52 columns shrinks a 120-column desktop until one of you detaches. PocketAgent joins at
  the pane's *current* size and leaves it alone; the terminal page offers "Fit to this
  screen anyway" as a deliberate choice.

Closing or stopping the session **detaches only** — your pane keeps running, as does
whatever is inside it. The attach client is always spawned as a direct child of the server
even when `POCKETAGENT_BACKEND=tmux`, precisely so that killing it can only ever mean
"detach".

Only panes whose working directory resolves inside a workspace root are offered, and the
browser receives an opaque id rather than a tmux target string.

The **Shell** dialog (the round terminal button on the home screen) can also start a
brand-new, user-named session on that same socket and attach to it immediately — the reverse
of the above: create one from your phone, then pick it up later with
`tmux -L <socket> attach -t <name>` from your desk.

> **Bare terminals cannot be taken over.** If you started `claude` in a plain terminal
> rather than tmux, there is no second client to add — its PTY has one master, held by that
> terminal. Reparenting it needs `ptrace`-level tricks (`reptyr`), which are blocked by
> default on most distributions and which PocketAgent does not attempt. Resume the
> conversation instead.

## Scheduled jobs

Everything above starts when you tap something. A **scheduled job** runs a prompt on a
repeating schedule instead: a nightly review of yesterday's commits, a Monday-morning
dependency check, an hourly sweep of a log directory.

A job is a saved spec — project directory, agent, working-copy policy, model, effort, prompt
and schedule — and it lives at **"…" → Cron jobs…**, or `#/cron`. Each firing is a **run**:
one prompt, one turn, with its own transcript you can read afterwards.

### Defining when it runs

Two ways, and you can switch between them per job:

- **Simple** — hourly, daily, weekly (pick the weekdays) or monthly, at an hour and minute.
- **Advanced** — a raw five-field cron expression (`*/15 9-17 * * 1-5`), validated as you
  type, for anything the picker cannot say.

Either way the editor shows **the next three runs** as absolute times with countdowns, so a
schedule you got wrong is visible before you save rather than at 3am. Each job carries its
own **IANA time zone** (not a UTC offset — an offset does not survive DST), so "run at 9am"
means *your* 9am even on a server running in UTC.

Two DST behaviours worth knowing, because they are choices rather than accidents: a local
time that does not exist on a spring-forward day simply does not fire that day, and an hour
repeated by a fall-back transition fires **once**, on the first pass.

### Where it runs

A job either runs in the project directory as-is, or creates **a fresh git worktree per
run** on its own branch (`nightly-review-20260828-0300-a3f9c1`). The second is what you want
for anything that edits files: last night's uncommitted changes cannot trip up tonight's run.
Those worktrees are *not* cleaned up automatically — the run's output is what is in them.

### Approvals

**A scheduled job runs with tool approvals bypassed by default**, and this is the only place
in PocketAgent where that is the default. It is unattended by definition; a job that routed
approvals to a browser nobody is looking at would stop on its first tool call and never
finish.

You can turn it off per job. If you do, a run that needs an approval **waits for you** —
indefinitely, with a notification — rather than timing out into a yes or a no. Either way,
a job running bypassed says so persistently: on its row, in the list, and on every run.

### Watching it

- The **PROJECTS tree** shows each job under its directory with a clock icon, from the moment
  you save it — before it has ever run — plus a dot for how the last run went. Runs show up
  as ordinary chats carrying the same clock badge.
- **Run history** sits at the bottom of the job's editor. Tapping a run opens its transcript,
  exactly like any other chat.
- **Run now** fires a job by hand without waiting for its schedule, and takes you to the
  live session.
- Deleting a job **keeps its run history**, the same way removing a chat never deletes its
  transcript.

### What it will not do

- **It will not replay a backlog.** Runs missed while the server was off are collapsed into a
  single `skipped` entry once they are more than an hour stale — a week offline for an hourly
  job would otherwise start 168 agents at boot. Inside that hour it still fires once, so an
  ordinary restart does not lose a run.
- **It will not run two at once**, unless you ask it to. By default a firing is skipped while
  the previous run is still going, which for a job that edits files is the safe answer.
- **It needs an agent with a native mode.** Terminal-only agents (`shell`) cannot be
  scheduled: typing at a TUI gives no reliable signal that it is ready, or that it is done.

## Process backends

Where the agent process actually lives is pluggable. Everything above the
`ProcessBackend` interface — routes, the WebSocket transport, the replay buffer,
persistence — is written against a handle and does not know which backend is in use.

| | `direct` (default) | `tmux` |
| --- | --- | --- |
| Process owner | this Node server | a separate tmux server |
| Survives browser disconnect | yes | yes |
| Survives PocketAgent restart/crash | **no** | **yes** |
| Extra dependency | none | `tmux` |
| Attach from a real terminal | no | yes |

```bash
# .env
POCKETAGENT_BACKEND=tmux
```

With `tmux`, `systemctl --user restart pocketagent` — or a crash, or `kill -9` — stops
being an event: the agents keep running and are re-adopted on the next boot, with their
scrollback replayed into the browser.

You can also attach to a session from an ordinary terminal, which is handy for debugging:

```bash
tmux -L pocketagent -f /dev/null ls
tmux -L pocketagent -f /dev/null attach -t pocketagent-<session-id>
```

### How the tmux backend is configured

A few choices are deliberate and worth knowing about:

- **Private socket (`-L pocketagent`) and no config (`-f /dev/null`).** PocketAgent neither
  depends on nor disturbs your own tmux server, and a stray `.tmux.conf` cannot rebind keys
  inside an agent session.
- **`prefix None`.** The prefix key is disabled entirely, so every keystroke — including
  Ctrl-B — belongs to the agent. Without this tmux would silently swallow them.
- **`status off`.** No status bar stealing a row from a phone screen.
- **`window-size latest`.** The window follows the most recent client instead of the
  smallest, so attaching from a phone does not permanently shrink a desktop's view.
- **`remain-on-exit on`.** The pane survives its process just long enough for PocketAgent
  to read the true exit status, so you still get "exited with code 7" rather than a shrug.
- **Sanitized server environment.** The tmux server is long-lived and inherits what we hand
  it, so the `POCKETAGENT_*` namespace is stripped before it starts, and each session's
  environment is set explicitly with `-e`.

Exit detection uses a single `list-panes -a` poll per second covering every session, so the
cost does not grow with the number of agents.

### Switching backends

Sessions started under one backend are invisible to the other; switching applies to new
sessions only. Existing `direct` sessions die with the server as usual, and are marked
`interrupted`.

## How it works

### Stream epochs

Sequence numbers are only meaningful within one run of a session's output stream. When a
session is re-adopted after a restart its ring buffer starts empty and numbering restarts,
so a browser still holding `seq=500` from before would otherwise resume into a completely
different stream and splice new output onto a stale screen.

Each live session therefore carries an `epoch`. The client sends it back with `afterSeq`;
if it does not match, the server ignores the sequence number, replays what it has, and
flags `truncated` so the client clears first. This is why the WebSocket protocol is at
version 2.

### Session lifecycle

The server owns every PTY. WebSocket attach/detach only moves a reference count, so closing
a tab, losing signal, or force-quitting the browser has no effect on the process.

Statuses: `starting` → `running` → `exited` (finished on its own) / `killed` (you stopped
it) / `error` (failed to spawn) / `interrupted` (the server restarted underneath it).

Terminating sends `SIGTERM` and escalates to `SIGKILL` after 5 seconds. The escalation
matters: interactive shells ignore `SIGTERM` outright.

`SIGINT` and `SIGQUIT` are delivered as the control characters `^C` and `^\` through the
tty line discipline, so they reach the **foreground process group** — that is what
interrupts a running command instead of killing the shell hosting it, and it is exactly
what a keypress does.

### Output replay

Each PTY write is coalesced over an 8 ms window, assigned a sequence number, and appended
to a byte-bounded ring buffer. Replay concatenates everything after a given sequence. The
server runs no terminal emulator — the client gets a byte-exact suffix of the stream, and
xterm.js renders it identically to a live feed.

### Adding an agent

Create an adapter that turns a validated request into an argv vector:

```ts
// apps/server/src/agents/codex.ts
export function createCodexAdapter(bin: string): AgentAdapter {
  return {
    id: 'codex',
    displayName: 'Codex',
    description: 'OpenAI Codex CLI',
    buildCommand: () => ({ command: bin, args: [] }),
    isAvailable: () => resolveExecutable(bin) !== null,
  };
}
```

Register it in `apps/server/src/agents/registry.ts`. It appears in the UI automatically, and
its row reports whether the executable is present. Nothing else in the codebase is
agent-specific.

Two optional fields are worth adding if the CLI supports them. `bin` declares the configured
executable, which is what lets the UI warn when it is pinned to an absolute path (that bypasses
resolution entirely, so an install would not be found). `authProbe` declares how to ask the CLI whether it is signed in — argv plus
a pure `interpret` function. If the CLI has no non-interactive way to answer, leave it out: the
row then reports *Sign-in unknown*, which is the honest answer and is handled everywhere.

To make an agent installable from the UI, add an `official-script` entry to
`apps/server/src/agents/catalog.ts` and its id to `INSTALLABLE_AGENT_IDS` in
`packages/protocol/src/agent-install.ts`. The entry needs:

- the vendor's installer URL and interpreter;
- the arguments that pin a version, if the installer takes any (then add the pin to
  `docker/agent-versions.env` and the Dockerfile's `all` stage; a test fails if the file and the
  catalog disagree);
- how an update works;
- the path fragments that identify an official install.

Read the installer script itself for these. Don't rely on its documentation: the entries in
the catalog record what each script actually does. Use the `npm` method only for an agent with
no official installer.

### Installing agents

The thin container image ships no agent CLIs, so a freshly deployed backend can run nothing
until one is installed. **Settings → Coding Agents → Set up agents…** lists what this host has,
what state each one is in, and offers to install the missing ones or update the installed ones.
The job runs on the backend and streams its output as it goes.

Each agent is installed with its **vendor's official installer**, into the **vendor's official
location**, the same place it lands when you run the installer yourself:

| Agent | Installer | Lands in | Update runs |
| --- | --- | --- | --- |
| Claude Code | `https://claude.ai/install.sh` | `~/.local/share/claude/versions/`, linked from `~/.local/bin/claude` | `claude update` |
| Codex | `https://chatgpt.com/codex/install.sh` | `~/.codex/packages/standalone/`, linked from `~/.local/bin/codex` | the installer again (updates in place) |
| opencode | `https://opencode.ai/install` | `~/.opencode/bin/opencode` | the installer again (updates in place) |
| Antigravity CLI | `https://antigravity.google/cli/install.sh` | `~/.local/bin/agy` | `agy update` |
| pi | `https://pi.dev/install.sh` | `~/.pi/agent/`, linked from `~/.local/bin/pi` | `pi update --self` |

This matters because the server has to run **the same binary you get from a login shell on
that host**. Earlier versions installed a second, npm-managed copy into `~/.npm-global` and ran
that one. A Settings "upgrade" then changed nothing you could see from `ssh`, while the official
copies kept updating themselves and the npm copy never did. Now:

- The server searches the official directories first. The npm prefix comes **last**, so a
  leftover copy there never shadows an official one.
- An update updates **the copy that runs**, in place, through the agent's own update path. It
  never installs a second copy.
- Every install or update ends by checking that the copy that runs is the official install. If
  it isn't, the job **fails** and names the copy that runs instead.
- Each row shows the binary the server runs (**Runs …**; compare it with
  `bash -lc 'command -v claude'`) and lists every **other copy** on the host. A leftover copy in
  `~/.npm-global` can be removed from the dialog, after a confirmation. Any other copy (for
  example a stale `/usr/bin/codex` from a system npm) is only reported, because this server does
  not manage it. Nothing is ever deleted silently.

Upgrading from an older version that left `~/.npm-global/bin/{claude,codex,pi}` behind needs no
action. Those copies stop running as soon as the server restarts, and Settings lists them for
removal.

Installers write their own "add to PATH" line to your shell profile when their directory is not
already on `PATH`, just as they do when you run them by hand. opencode writes it to `~/.bashrc`
for bash, which a stock `.bashrc` skips for non-interactive shells. So `bash -lc opencode` may
not find it while an interactive login does. The server searches `~/.opencode/bin` either way.

Each row is one of four states, and the distinction matters:

| State | Meaning |
| --- | --- |
| **Not installed** | No such executable on this host. |
| **Not signed in** | Installed, and the CLI reports it has no credentials. Open a Shell session on that host and sign in. There is no way to do it from here, and the dialog says so rather than pretending. |
| **Sign-in unknown** | Installed, but the CLI cannot be asked non-interactively. Not an error: it may work, including via an environment variable this server cannot see. |
| **Ready** | Installed and signed in. |

Four properties are deliberate:

- **The browser sends only an id and an action from the server's own lists.** Never a URL,
  package name, version or path. Installing is arbitrary code execution as the server's user: an
  installer script downloads and runs a vendor binary. So the installer URLs are fixed in the
  server, and a script is downloaded to a private file (its sha256 goes in the log) and run as
  `bash <file>` with fixed arguments, never piped into a shell.
- **Settings installs the vendor's current release.** Every one of these agents updates itself,
  so a pin would stop being true within a day. Pins exist only for the Docker image.
- **There is no auto-install.** Choosing an uninstalled agent in the composer opens this dialog
  rather than fetching anything.
- **The job is not tied to the browser.** Closing the dialog leaves it running, and reopening
  attaches to it and replays the log.

In the container image the official locations are inside the mounted `$HOME`, which is what
makes an installed agent **survive a restart** with nothing extra to mount.

### Layout

```
pocketagent/
├── apps/
│   ├── server/
│   │   ├── scripts/
│   │   │   ├── browser-demo.mjs        # drives the real UI in Chrome
│   │   │   ├── e2e-demo.mjs            # drives the HTTP+WS protocol
│   │   │   └── generate-token.mjs
│   │   ├── src/
│   │   │   ├── agents/                 # adapter registry: shell, claude
│   │   │   ├── auth/                   # token check, cookie sessions, origin policy
│   │   │   ├── backends/               # direct (node-pty) and tmux process backends
│   │   │   ├── push/                   # Web Push (VAPID): approvals + turn-complete/idle
│   │   │   ├── config/                 # typed env loading
│   │   │   ├── db/                     # SQLite schema, migrations, stale recovery
│   │   │   ├── routes/                 # auth + session REST
│   │   │   ├── sessions/               # PTY + structured sessions, manager, SDK mapping
│   │   │   ├── terminal/               # output ring buffer, classifier
│   │   │   ├── ws/                     # WebSocket terminal transport
│   │   │   ├── workspaces/             # path canonicalization + containment
│   │   │   ├── app.ts
│   │   │   └── server.ts
│   │   └── tests/                      # 12 suites: PTYs, sockets, tmux, SDK mapping
│   └── web/
│       └── src/
│           ├── api/                    # REST client, reconnecting WS client
│           ├── components/             # key bar, prompt box, dialog, badges
│           ├── hooks/                  # hash routing
│           ├── pages/                  # login, session list, terminal
│           ├── terminal/               # xterm.js setup
│           ├── App.tsx
│           └── main.tsx
├── packages/
│   └── protocol/                       # Zod schemas shared by both sides
├── .env.example
└── README.md
```

---

## Development

```bash
pnpm install
pnpm dev              # server :8787 + Vite :5173
pnpm build
pnpm test             # 240 tests
pnpm lint
pnpm typecheck
```

Two demo scripts verify the whole stack against a **running** server:

```bash
pnpm demo:protocol    # terminal transport: login, replay, resize, signals, Claude
pnpm demo:browser     # terminal UI in real Chrome at iPhone viewport
pnpm demo:agent       # native transport: events, approvals, reconnect-mid-approval
pnpm demo:native-ui   # native UI in real Chrome: tool cards, diffs, approval sheet

# Home screen and composer. Seeds its own chats, so it needs only a scratch server
# with a couple of workspace directories.
PA_TOKEN=... pnpm demo:home-ui

# Resume and attach. These need a scratch server: a workspace root you do not mind
# an agent writing in, and POCKETAGENT_ADOPT_TMUX_SOCKET set to a throwaway socket.
# The first creates a real conversation and checks the original file is untouched;
# the second drives the pickers and confirmations in a real browser.
PA_TOKEN=... pnpm demo:resume-adopt
PA_TOKEN=... pnpm demo:resume-adopt-ui
```

The test suite uses `/bin/bash` and never requires Claude Code.

---

## Troubleshooting

**`node-pty` fails to build.** It compiles native code:

```bash
sudo apt install build-essential python3
pnpm rebuild node-pty
```

If you upgraded Node, native modules must be rebuilt: `pnpm rebuild`.

**`better-sqlite3` fails to build.** Same toolchain. `pnpm rebuild better-sqlite3`.

**Login appears to do nothing / immediately logs out again.** The cookie is being dropped
because it is marked `Secure` but you are on plain `http://`. Set
`POCKETAGENT_COOKIE_SECURE=false`, or serve over HTTPS (`tailscale serve`).

**Docker: login appears to do nothing.** The same cause as above, but reached by default
rather than by choice: the image sets `NODE_ENV=production`, so the cookie is `Secure`, and a
browser discards a `Secure` cookie over plain HTTP. Set `POCKETAGENT_COOKIE_SECURE=false`
(`docker/compose.yaml` already does) or terminate TLS in front.

**Docker: `git` says "detected dubious ownership", or agent-written files are root-owned.**
The container's uid does not match the owner of the mounted repository. Start it with
`-e PUID=$(id -u) -e PGID=$(id -g)`. Note this breaks more than file ownership — git refuses
the repository outright, so the diff views and every worktree operation fail too.

**Docker: the container exits immediately with code 78.** The entrypoint refused a mount it
will not silently chown. The message names the directory and the exact `chown` to run on the
host; `docker logs <name>` has it.

**Settings → Set up agents says "The installer cannot write its official location".** A
directory in the mounted `$HOME` (usually `~/.local`) is owned by root, so the vendor's
installer cannot write there; nothing was installed. It is left by a `docker exec` without
`--user` (which runs as root), or by a `-all` image built before this was fixed. Run the
`chown` the message names as root, for example
`docker exec -u 0 <container> chown -R 1000:1000 /home/pocketagent/.local`, then retry.

**Docker: an agent CLI you installed is gone after a restart.** It was installed outside the
mounted `$HOME`. Most likely that was a `docker exec` without `--user`, which runs as root and
writes where the server (running as you) cannot read. Install from **Settings → Set up agents**,
or with `docker exec --user "$(id -u):$(id -g)" …` and the vendor's own installer. Either one
lands in `$HOME/.local/bin` (or `$HOME/.opencode/bin`) on the mounted volume.

**403 `forbidden_origin`.** The `Origin` header does not match. Behind a proxy, set
`POCKETAGENT_ALLOWED_ORIGINS=https://your.domain`.

**WebSocket never connects, page says Reconnecting forever.** Your proxy is not forwarding
the upgrade. See the nginx snippet above. Check `/health` still responds.

**"Claude Code executable not found."** `claude` is not on the `PATH` of the *server*
process. Systemd user services get a minimal environment — set an absolute path:
`POCKETAGENT_CLAUDE_BIN=/home/me/.local/bin/claude`.

Since PA-68 there is a second answer: if `claude` is not installed on that host at all,
**Settings → Coding Agents → Set up agents…** will install it. Note the two fixes pull in
opposite directions — setting an absolute path makes the server stop searching the install
prefix, so an agent whose binary is pinned that way cannot be installed from the UI and the
dialog says so rather than offering a button that appears to do nothing. Pick one: an absolute
path, *or* a bare name plus the install prefix.

**"Ready" / "Not signed in" / "Sign-in unknown" on an agent row.** These are three different
things. *Not signed in* means the CLI is installed and told us it has no credentials — open a
Shell session on that host and sign in. *Sign-in unknown* means the CLI has no way to answer the
question non-interactively (`agy` has no such subcommand; opencode only prints a decorated
table), so the state is genuinely unknown rather than bad — the agent may well work, including
when it is authenticated by an environment variable this server cannot see. It is deliberately
not shown as a tick, because claiming an agent is ready and then failing its first session is
the failure this replaced.

**A third-party provider variant fails with `502 Stream ended before producing a non-ping
SSE event`.** The message is the gateway's, not PocketAgent's, and it hides the real cause —
ask the gateway directly to see it:

```bash
curl -s -X POST "$BASE_URL/v1/messages" -H 'content-type: application/json' \
  -H 'anthropic-version: 2023-06-01' -H "x-api-key: $KEY" \
  -d '{"model":"<model>","max_tokens":16,
       "messages":[{"role":"user","content":"say OK"},
                   {"role":"system","content":"Extra context."}]}' | jq .upstream_details
```

That two-message shape is the one that matters: **Claude Code puts a `role: "system"` message
*after* a user message**, on top of its own top-level `system` blocks. A gateway that
translates positionally then hands the backend `system, user, system`, and some chat templates
refuse it — a local Qwen served through LM Studio answers
`Jinja Exception: System message must be at the beginning` and returns 500, which the gateway
reports as the opaque 502 above. Hosted models on the same gateway accept the identical
request, so this presents as "one model is broken" rather than as a template problem.

Nothing in PocketAgent can work around it: the payload is the CLI's, and the variants
deliberately do not rewrite what the agent sends. Two fixes work, both outside this repo:

1. **The gateway normalizes system-message placement** — hoisting or merging system messages
   to the front during translation, which is what most gateways do. Fixes every strict-template
   model at once.
2. **Relax the model's chat template.** For the Qwen case above, the guard is a single
   `raise_exception` inside the template's message loop; rendering the message as a user turn
   instead (`'<|im_start|>user\n' + content + '<|im_end|>' + '\n'`) clears it. Verified end to
   end — a real `Read` tool call completes afterwards. It is per-model and a model update
   reverts it.

Note also that the CLI retries hard on 502 — a ~650 ms upstream failure surfaces as a
three-minute hang, so *slow* here does not mean *timeout*.

**Sessions all say `interrupted` after a restart.** Expected on the default `direct`
backend. Set `POCKETAGENT_BACKEND=tmux` if you want them to survive.

**tmux backend: session says `interrupted` even though tmux is running.** PocketAgent only
re-adopts sessions on its own socket, named `pocketagent-<id>`. Check
`tmux -L pocketagent -f /dev/null ls`. If you changed `POCKETAGENT_TMUX_SOCKET`, older
sessions are on the previous socket and will not be found.

**tmux backend: "Process backend "tmux" is unavailable".** `tmux` is not on the server
process's `PATH`. Install it, or set an absolute `POCKETAGENT_TMUX_BIN`.

**Ctrl-B does nothing / behaves oddly under tmux.** It should reach the agent normally —
PocketAgent sets `prefix None`. If it is being intercepted, something re-enabled a prefix
on the socket; PocketAgent starts tmux with `-f /dev/null` specifically to avoid this.

**Terminal is tiny or text is cut off on a phone.** Rotate to landscape, or add the page to
your home screen so the browser chrome disappears. The PTY resizes automatically.

**Garbled output after a long disconnect.** The replay buffer overflowed and the banner
should have told you. Raise `OUTPUT_BUFFER_BYTES`, or press `^L` to redraw.

---

## Known limitations

1. **Native sessions do not survive a server restart** (the Agent SDK owns the process, so
   the tmux backend does not apply). The conversation is recoverable via
   `resumeAgentSessionId`; the process is not. Terminal sessions on the tmux backend do
   survive — see [Process backends](#process-backends).
2. **On the default `direct` backend, terminal sessions do not survive a server restart.** The PTY is
   a child of the server process. Affected sessions are marked `interrupted` rather than
   pretending otherwise. Set `POCKETAGENT_BACKEND=tmux` to make them durable.
3. **Scrollback is bounded** by `OUTPUT_BUFFER_BYTES` (2 MB default). Older output is
   evicted and the client is told when that happened. On recovery the tmux backend seeds
   the buffer from `capture-pane` (2000 lines), so anything older than that is lost.
4. **Single user.** One token, no accounts, no per-session permissions. Everyone who logs
   in shares the same authority.
5. **No sandboxing.** PocketAgent authenticates you; it does not constrain the agent
   afterwards. The agent can do anything your user can.
6. **Terminal replay is byte-oriented, not screen-oriented.** Reattaching to a full-screen TUI
   mid-stream can briefly look odd until the app redraws (`^L` fixes it). A server-side
   headless terminal would solve this properly.
7. **A webhook cannot tell you whether Jira can reach it.** Nothing in the server can prove the
   inbound path works — the URL is composed in your browser, and `Host` headers are claims. The
   first received delivery is the only evidence, so the UI shows `never fired` until one arrives.
8. **Linux-first.** macOS is untested; Windows is not supported.
9. **Push notifications need HTTPS**, and on iOS the site must be installed to the home
   screen before the browser will allow them at all. PocketAgent pushes for two events —
   a pending approval, and a structured agent finishing its turn (or, best-effort, a
   terminal session going quiet) — always to a fully detached client only; both also fire
   in-page whenever the tab is merely backgrounded, which needs no push service.
10. **Terminal output is never persisted.** Buffers are in-memory only, so a restart loses
    scrollback along with the session.
11. **Conversation liveness is directory-level.** Claude does not keep its transcript file
    open and its command line does not name the session, so PocketAgent can tell you an
    agent is running in that directory but not that it is running *that conversation*. It
    labels it accordingly rather than guessing.
12. **Attaching to your own tmux is a shared session, not a takeover.** Your prefix key is
    live from the browser, and the window follows whichever client attached most recently.
    A pane in a plain terminal (no tmux) cannot be attached to at all.
13. **One host per backend; several only behind the Hub.** A backend only ever reports
    itself from `GET /api/hosts`, deliberately — it has no business claiming to know about
    its peers. Driving several machines from one browser needs the
    [Hub](#running-a-hub), which does concentrate credentials in one process: that is a
    real cost, accepted on the grounds that none of the credentials it holds is a root
    credential and each is revocable from the machine it grants access to. The Hub is also
    a single point of failure for *reaching* your backends, though not for their state —
    each one is still directly usable with no Hub involved.
14. **The home screen lists only directories with chats in them.** A configured workspace
    you have never used does not appear until you start something there; the composer's
    workspace row can still reach it.
15. **Conversation discovery is Claude-specific.** It reads Claude Code's on-disk transcript
    format. Other agents would each need their own reader; the rest of the session
    machinery is agent-agnostic.
16. **Per-run and per-delivery worktrees are never cleaned up.** A scheduled job set to
    branch per run leaves one tree per run under `<project>/.worktrees/`, so a nightly job
    accumulates roughly one a day. A webhook accumulates one per *delivery*, which a busy
    Jira project produces far faster. Deleting them afterwards is not an option — the run's
    work is what is in there — so pruning old branches stays a manual job.
17. **A scheduled job does not catch up after downtime.** Occurrences missed while the
    server was off are collapsed into a single `skipped` run once they are more than an hour
    stale, rather than firing a backlog at boot. Inside that hour the job still fires once,
    so an ordinary restart does not lose a run.
18. **Scheduled jobs cannot use the terminal transport.** They require an agent with a
    structured mode, because delivering a prompt to a TUI has no readiness signal and no
    reliable way to tell a finished turn from a hung one.
19. **A scheduled job runs with approvals bypassed by default.** It is unattended, so there
    is nobody to ask; the per-job switch can be turned off, in which case a run that needs
    an approval waits indefinitely for you instead of proceeding. See
    [Security model](#security-model).
20. **A webhook cannot tell you whether Jira can reach it.** Nothing in the server can prove
    the inbound path works — the URL is composed in your browser, and `Host` headers are
    claims — so the UI shows `never fired` until a delivery actually arrives, and that first
    delivery is the only evidence you get.
21. **A webhook runs with approvals *enabled* by default**, unlike a scheduled job, because
    its prompt is built partly from text a Jira user wrote. Turning the switch on is a
    deliberate act, and the editor says what it means. See
    [Inbound webhooks](#inbound-webhooks-and-what-they-change).
22. **Webhook signing secrets are stored in plaintext.** HMAC verification needs the key
    material, so there is no way around it. They live in `pocketagent.db`, which is
    another reason not to point a webhook at this checkout.
23. **The tmux backend is pointless in a container**, and the image does not pretend
    otherwise. It outlives a *server* restart inside the container, but the tmux server dies
    with the container, so it does not survive the restart that matters. Adopting the host's
    tmux needs its socket bind-mounted plus a matching uid; `POCKETAGENT_TMUX_SESSION_SCOPE_SLICE`
    has nothing to delegate to at all. Use `direct` — see [Running with Docker](#running-with-docker).
24. **Conversation liveness is container-scoped.** PocketAgent spots a running agent by
    reading `/proc`, so a containerised server cannot see agents you started on the host. It
    reports them as finished conversations rather than live ones — a sharper version of
    limitation 11.
25. **The published image is amd64 only, and multi-arch is a per-platform build.** The Agent
    SDK resolves an architecture- and libc-specific package at install time, so another
    architecture needs its own real build (`PA_PLATFORM=linux/arm64 docker/build.sh`) rather
    than one build retagged. Nothing about the Dockerfile prevents it; no arm64 tag is
    published yet.
26. **A second host has to be reverse-proxied onto this origin, and the list of them is
    per-browser until the Hub exists.** The UI is multi-host — an aggregated home, a host rail
    on desktop, a host sheet on a phone, and `#/h/<hostId>/…` deep links — but a host is
    addressed as a *path prefix* on the origin serving the app, because requests authenticate
    with a `SameSite` HttpOnly cookie and a cross-origin backend would need
    `SameSite=None; Secure` plus credentialed CORS, which the plain-HTTP-on-a-tailnet posture
    cannot provide. So adding `dev02` at `/h/dev02` assumes something already proxies that
    prefix to that machine, and hosts you add are remembered in *this browser* only. The
    PocketAgent Hub replaces both halves — one origin that proxies every bound backend, and a
    shared registry — and until then a host that nothing proxies simply shows as unreachable
    in its own group, which is the intended degradation rather than a failure.
27. **Web push notifications belong to the host that served the app.** A push subscription is
    per-origin by construction (one per browser, per service worker), and the backend composes
    the deep link in the payload itself — so a notification raised by another host links to the
    right session id on the wrong machine. Notifications raised *in the browser* (approval
    needed, turn complete, session idle) do carry their host.

---

## License

[MIT](LICENSE) © 2026 Stone Shi
