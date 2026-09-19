# AGENTS.md

This file provides guidance and rules for agentic AI coding assistants (including Antigravity, Claude Code, and others) when working in the PocketAgent repository.

## Reference Document

See [CLAUDE.md](file:///data/homes/stoneshi/src/agents-remote-control/CLAUDE.md) for the authoritative repository instructions, developer commands, unit testing guides, and architectural details. Follow all guidelines therein to maintain consistency and prevent breaking critical invariants.

---

## Workspace Layout & Key Modules

PocketAgent is a monorepo configured with `pnpm` workspace packages:
* [packages/protocol](file:///data/homes/stoneshi/src/agents-remote-control/packages/protocol) — Single source of truth containing Zod schemas for HTTP bodies and WebSocket frames. **Must be built before anything else works.**
* [packages/node-kit](file:///data/homes/stoneshi/src/agents-remote-control/packages/node-kit) — Node-only sibling of protocol containing shared security primitives (`secret-box`, `safeTokenEqual`, `generateToken`, `bearerTokenFrom`, `isOriginAllowed`).
* [apps/server](file:///data/homes/stoneshi/src/agents-remote-control/apps/server) — Fastify server, driving child terminals and tmux sessions.
* [apps/hub](file:///data/homes/stoneshi/src/agents-remote-control/apps/hub) — One-origin gateway service, host registry (SQLite), and TCP-level WebSocket splice.
* [apps/web](file:///data/homes/stoneshi/src/agents-remote-control/apps/web) — Frontend Vite + React application.

---

## Core Agent Guidelines & Rules

When modifying code or running tasks, agents must strictly adhere to the following:

### 1. Invariants (Do Not Break)
* **Never Auto-Approve by default:** Auto-approval is disabled by default; all tool executions and approvals are routed directly to the client browser, with no timeout on pending approvals. There are exactly three documented exceptions, all covered in CLAUDE.md Invariants: `skipPermissions` (an explicit per-session opt-in, off by default), the operator-level `POCKETAGENT_GLOBAL_SKIP_PERMISSIONS` switch, and **scheduled jobs**, which are the one place a skip-permissions *default* is on — a cron job is unattended by definition. None of them relax the part that matters: an unanswered approval must never decay into an allow, so a run with the toggle off waits indefinitely rather than timing out into a yes. Never add a fourth exception, or flip a default quietly.
* **Scheduled jobs are always structured sessions:** Enforced in [`routes/cron.ts`](file:///data/homes/stoneshi/src/agents-remote-control/apps/server/src/routes/cron.ts), never merely defaulted. Writing keystrokes into a terminal TUI with no readiness signal is precisely what `terminal/classifier.ts` is forbidden from doing.
* **The scheduler never replays a backlog:** A firing more than an hour late records one coalesced `skipped` run and rolls forward. Never write the obvious `while (next <= now) fire(next)` loop — a week offline would spawn hundreds of agents at boot.
* **One agent per working tree:** `runs/queue.ts` (`RunQueue`) serializes work that would share a checkout, keyed on `treeRootOf` — the working tree, never a string prefix and never a containment test (a run in `<project>` must not block one in `<project>/.worktrees/x`). Occupancy is *derived* from whether a live session is mid-turn, never leased in a table, so a crash cannot strand a lock; `tryAcquire` must stay synchronous from check to claim, or one tree goes to two runs. There is no timeout on a waiter — a run parked on an approval is genuinely still working — so never add one; cancelling is a human's decision, which is why every waiter is visible in the project tree.
* **The server never replaces its own code:** `POST /api/admin/restart` ([`admin/index.ts`](file:///data/homes/stoneshi/src/agents-remote-control/apps/server/src/admin/index.ts)) only drains and exits; a supervisor starts it again on whatever image its unit already named. Never add a field naming a version, image, tag or digest — `RestartRequest` has exactly one field, `force`, and a test asserts it. The exit status must stay **non-zero** (`RESTART_EXIT_CODE`): `Restart=on-failure` ignores a clean exit, so `exit(0)` would turn this into a remote off switch. A restart refuses by default while anything is mid-turn and names it, asking both the session manager *and* `PlannerChatService.inFlightTurns` (a Pocket Agent turn has no session, so it is invisible to the first), and there is no timeout — only a human passing `force` overrides it.
* **Safe Directory Containment Check:** Containment is checked via `fs.realpath` + `path.relative` in [`workspaces/index.ts`](file:///data/homes/stoneshi/src/agents-remote-control/apps/server/src/workspaces/index.ts). Never use simple string prefix matching.
* **No Adopted Tmux Resizing:** Never resize tmux panes automatically for adopted sessions.
* **Sanitize Child Environments:** Strip all environment variables prefixed with `POCKETAGENT_*` in [`sessions/env.ts`](file:///data/homes/stoneshi/src/agents-remote-control/apps/server/src/sessions/env.ts) to prevent token leaks.
* **No Persistent Terminal Logs:** Terminal I/O is held in-memory via [`terminal/output-buffer.ts`](file:///data/homes/stoneshi/src/agents-remote-control/apps/server/src/terminal/output-buffer.ts) and [`terminal/event-buffer.ts`](file:///data/homes/stoneshi/src/agents-remote-control/apps/server/src/terminal/event-buffer.ts); do not store output buffers in the database.
* **Never kill a server by process pattern:** A production PocketAgent instance normally runs on the same machine, as the same user, with `ExecStart=node apps/server/dist/server.js`. So `pkill -f dist/server.js` — or `node apps/server`, or `pnpm start` — matches **prod**, not just the scratch server you started, in every checkout at once. pkill's default SIGTERM runs the graceful shutdown path, so it exits 0 and the journal shows only a clean stop; prod was taken down this way on 2026-09-17. Record the pid when you start a server (`node apps/server/dist/server.js & SRV=$!`) and `kill "$SRV"`. The same caution applies to `systemctl restart pocketagent` — never restart, stop, or `pkill` a server you did not start.
* **The Hub never proxies `/api/hooks/*`:** Inbound webhook deliveries are the only unauthenticated routes on a backend. `PROXY_DENY_PREFIXES` in [`proxy/allowlist.ts`](file:///data/homes/stoneshi/src/agents-remote-control/apps/hub/src/proxy/allowlist.ts) blocks `/api/hooks/*` so `grep '/api/hooks/'` continues to enumerate the entire unauthenticated surface on the backend. Jira and Bamboo deliver straight to the backend.
* **The Hub is a dumb pipe for WebSocket frames:** Terminal I/O is held in-memory and never logged or persisted, now across two processes. [`proxy/ws.ts`](file:///data/homes/stoneshi/src/agents-remote-control/apps/hub/src/proxy/ws.ts) splices the browser and backend sockets at the TCP level via `pipe()` with no WebSocket parser or frame inspection library on that path.
* **The browser never supplies an executable or argv (extended to agent installation):** `POST /api/agents/install` accepts only a closed enum of installable agent IDs (`packages/protocol/src/agent-install.ts`), never a package name, version, or URL. Pinned catalog in [`agents/catalog.ts`](file:///data/homes/stoneshi/src/agents-remote-control/apps/server/src/agents/catalog.ts) maps IDs to argv only with no shell.
* **Front-server reversal and scoped credentials:** The Hub fronts multiple backends (a knowing reversal of the old single-server design). The mitigation is scoped hub credentials ([`POST /api/auth/hub-bind`](file:///data/homes/stoneshi/src/agents-remote-control/apps/server/src/routes/auth.ts) exchanges the master token once; stored as `sha256(token)` on backend, encrypted with `secret-box` on Hub; revocable per host). What remains true: a Hub compromise can still write configuration to bound hosts (templates, LLM endpoint replacement, or revoking sibling credentials).

### 2. Code Style & Standards
* **ESM Throughout:** The project uses ES modules. Relative imports must explicitly carry the `.js` extension (e.g. `import { foo } from './foo.js'`), even in TypeScript sources.
* **Frontend styling:** CSS tokens are configured at the top of [`apps/web/src/styles.css`](file:///data/homes/stoneshi/src/agents-remote-control/apps/web/src/styles.css). Avoid ad-hoc styling outside of it.
* **React State & Routing:** React state is hand-rolled using simple hooks. Avoid introducing heavy routers or state management libraries.
* **Explain the "Why":** Comments should explain the rationale behind the code (e.g. why an arbitrary choice was made), not what the code does.

---

## Developer Command Quick-Reference

For more command variations and troubleshooting steps, consult [CLAUDE.md](file:///data/homes/stoneshi/src/agents-remote-control/CLAUDE.md).

```bash
pnpm install            # Build native modules (node-pty, better-sqlite3)
pnpm dev                # Start API dev server (:8787) + Vite dev server (:5173)
pnpm build              # Build protocol -> server -> web (in order)
pnpm start              # Start the production Fastify server
pnpm lint               # Run eslint lint checks across packages
pnpm typecheck          # Run type checks across packages
pnpm test               # Run all tests using vitest
pnpm generate-token     # Generate secure auth token in .env
docker/build.sh         # Build an image: thin | claude | all (backend) | hub (gateway)
pnpm demo:docker        # Verify the image contract against a real container
pnpm version:set 1.2.3   # Set the repo semver in all six package.json files
./test.sh               # CI entry: install, vitest (JUnit XML), lint, typecheck
./build.sh -p           # CI entry: build every target; publish only from a release tag
```

**Deployment is the container image** (`docker/`); `git pull && pnpm build` is the development
path. Build through `docker/build.sh`, never a bare `docker build` — it is what reads
`docker/agent-versions.env` and stamps `POCKETAGENT_BUILD_VERSION` into both the server and the
web bundle. Three rules there are load-bearing: the runtime image must preserve the repo layout
under `/app` (`REPO_ROOT` is computed by walking four levels up from `dist/config/`, so a
flattened tree silently re-points it at `/`); a pinned agent CLI belongs in `/usr/local/bin`,
never the default npm prefix, which lives inside the mounted `$HOME` and is hidden by the
volume at run time; and the entrypoint **never chowns a mounted volume** — it remaps the
container user to `PUID`/`PGID` and refuses to start with exit 78 when a mount is unwritable,
naming the `chown` to run on the host.

**A release is a tag.** The root `package.json` `version` is the repo's semver and the single
source for `/health`, the web bundle's `__APP_VERSION__` and the image tags; `pnpm version:set`
keeps the other five files identical and a test fails if they drift. `./build.sh` publishes
only when HEAD carries a tag parsing as `1.2.3` (no `v` prefix) and refuses when that tag
disagrees with the committed version — publishing an image whose `/health` contradicts its own
tag is the failure the whole pipeline exists to prevent. A prerelease publishes its exact tags
only and never moves `:<major>.<minor>` or `:latest`. CI is `./test.sh` then `./build.sh -p`;
`test.sh` deliberately runs the tests first and collects failures rather than aborting, because
Bamboo's parser globs `test-reports/*.xml` and an early exit reports "no test results found"
instead of naming the failure.

---

## Deployment Topologies

PocketAgent supports two main deployment topologies:

### 1. Standalone Deployment
* A single backend server process (`apps/server`, or container image `pocketagent-server`) serves the Fastify API, handles WebSocket terminal connections, and serves the static web bundle on port `8787` (default).
* Suitable for single-machine setups.
* Agents run on the local host (or inside the container).

### 2. Hub + N Backends Topology
* A one-origin gateway (`apps/hub`, or container image `pocketagent-hub`) runs on port `8788` (default) and fronts multiple backend instances (`apps/server`).
* **Single Origin & Routing:** The browser connects exclusively to the Hub (`https://hub.example.com/#/h/<hostId>/`). The Hub proxies HTTP API calls (`/h/<hostId>/api/*`) and transparently splices WebSocket terminal connections at the TCP level.
* **Security & Scoped Credentials:** The Hub stores no master tokens. When adding a host, the backend master token is exchanged once for a scoped `pah_` credential (`POST /api/auth/hub-bind`), stored as an AES-256-GCM ciphertext on the Hub and as `sha256(token)` on the backend. Each backend can revoke the Hub's access at any time from **Settings → Hubs** without restarting.
* **Notification Relay (PA-73):** Web Push is owned by the Hub. Backends expose an authenticated SSE stream (`GET /api/push/events`); the Hub maintains persistent relay connections to bound hosts, rewrites notification deep links to the Hub origin, and pushes to subscribed browsers.
* **Inbound Webhooks:** Webhooks (`/api/hooks/*`) are **never** proxied through the Hub; Jira and Bamboo deliver directly to the specific backend handling the repository.

---

## Container Images & Volume Contract

### Images
Build images using `docker/build.sh` (never bare `docker build`, which misses pinned versions and build stamps):
* `docker/build.sh` (or `docker/build.sh thin`): Base backend image `pocketagent-server:<version>` without preinstalled agent CLIs.
* `docker/build.sh claude`: Backend image with pinned Claude Code installed.
* `docker/build.sh all`: Backend image with pinned Claude Code, Codex, Opencode, and Pi installed.
* `docker/build.sh hub`: Gateway image `pocketagent-hub:<version>`.

### Volume Contract
* **Data Root (`POCKETAGENT_DATA_DIR`):** Set to `/var/lib/pocketagent` in containers. Holds `pocketagent.db`, `planner-workspaces/`, and `planner-skills/`. Must be mounted on a persistent volume. The server refuses to boot if `POCKETAGENT_DATA_DIR` resolves inside any workspace root.
* **User Home (`$HOME`):** Mount the host user's home directory (or dedicated agent home) to `/home/pocketagent`. Contains CLI configs and credentials (`~/.claude`, `~/.gemini`, `~/.pi`), `~/.gitconfig`, and `~/.npm-global` (on-demand agent install prefix).
* **Workspace Roots & Identical-Mount-Paths Requirement:**
  > [!IMPORTANT]
  > **Workspace roots must be mounted at the exact same absolute path inside the container as on the host.**
  > (e.g. `-v /data/repos/my-project:/data/repos/my-project`).
  > Claude Code derives transcript storage directories by hashing the absolute working directory path (`/` replaced with `-`, lossy and irreversible). If mounted at a different path inside the container, existing conversation transcripts become completely undiscoverable. Furthermore, database tables (`workspaces`, `sessions`, `cron_jobs`, `webhook_deliveries`, `webhook_issue_sessions`) store absolute paths.
* **Permissions & UID Mapping:**
  * Containers start as root so the entrypoint can remap the internal `pocketagent` user to the host's `PUID` and `PGID` environment variables, then privileges are permanently dropped.
  * **The entrypoint never chowns a mounted volume.** If a mounted directory is not writable by the remapped user, the entrypoint exits immediately with code `78` and prints the exact host `chown` command to run.

---

## TLS & Reverse-Proxy Posture

* **Single Origin Termination:** In both topologies, PocketAgent binds to loopback (`127.0.0.1`) by default. Terminate TLS at the reverse proxy or VPN edge:
  1. **Tailscale Serve (Recommended):** `tailscale serve --bg 8787` (standalone) or `tailscale serve --bg 8788` (Hub). Zero-config HTTPS within your tailnet.
  2. **Caddy / Traefik / Nginx:** Forward to loopback with WebSocket upgrade headers enabled (`Upgrade`, `Connection "upgrade"`) and long timeouts (PTYs idle for hours).
* **Proxy Configuration:**
  * Set `POCKETAGENT_TRUST_PROXY=true` so the rate limiter and audit logs see the real client IP from `X-Forwarded-For`.
  * Set `POCKETAGENT_ALLOWED_ORIGINS=https://hub.yourdomain.com` for CSRF validation.
  * `POCKETAGENT_COOKIE_SECURE=true` is the default in production (`NODE_ENV=production`). If deliberately accessing over plain HTTP across an internal trusted VPN, set `POCKETAGENT_COOKIE_SECURE=false` or cookies will be rejected by the browser.

---

## Environment Variables Reference

### Backend Server (`apps/server`)

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. Non-loopback logs a warning. |
| `PORT` | `8787` | Port to listen on. |
| `POCKETAGENT_AUTH_TOKEN` | — | **Required.** Operator access token (minimum 24 characters). |
| `POCKETAGENT_DATA_DIR` | `<checkout>/data` | Directory for `pocketagent.db`, planner workspaces, and planner skills. Refused if inside a workspace root. |
| `POCKETAGENT_WORKSPACE_ROOTS` | — | Comma-separated list of directories to seed project folders on initial DB setup. |
| `POCKETAGENT_ALLOWED_ORIGINS` | same-origin | Comma-separated allowed HTTP origins for CORS/CSRF checks. |
| `POCKETAGENT_TRUST_PROXY` | `false` | Enable to trust `X-Forwarded-For` from reverse proxies. |
| `POCKETAGENT_COOKIE_SECURE` | auto (`true` in prod) | Flag for `Secure` cookie attribute. Set to `false` if serving over plain HTTP on private VPN. |
| `POCKETAGENT_SESSION_TTL_HOURS` | `720` | Browser session lifetime in hours (default 30 days). |
| `MAX_SESSIONS` | `10` | Maximum concurrent active terminal sessions. |
| `OUTPUT_BUFFER_BYTES` | `2097152` | Size of in-memory terminal replay buffer per session (default 2MB). |
| `SESSION_IDLE_TIMEOUT` | `0` | Seconds of inactivity before auto-killing session (`0` disables). |
| `POCKETAGENT_BACKEND` | `direct` | Process backend: `direct` (child process) or `tmux` (persistent tmux server). In containers, use `direct`. |
| `POCKETAGENT_TMUX_BIN` | `tmux` | Path to tmux binary. |
| `POCKETAGENT_TMUX_SOCKET` | `pocketagent` | Private tmux socket name. |
| `POCKETAGENT_ADOPT_TMUX_SOCKET` | unset | Foreign tmux socket to adopt existing user panes from. |
| `POCKETAGENT_TMUX_SESSION_SCOPE_SLICE` | unset | systemd user slice for tmux process isolation. |
| `POCKETAGENT_GLOBAL_SKIP_PERMISSIONS` | `false` | **Dangerous:** Initial seed to globally bypass tool approvals. |
| `POCKETAGENT_SHELL` | `$SHELL` or `/bin/bash`| Default shell executable. |
| `POCKETAGENT_CLAUDE_BIN` | `claude` | Path to Claude Code CLI binary. |
| `POCKETAGENT_AGY_BIN` | `agy` | Path to Google Antigravity CLI binary. |
| `POCKETAGENT_OPENCODE_BIN` | `opencode` | Path to Opencode CLI binary. |
| `POCKETAGENT_CODEX_BIN` | `codex` | Path to OpenAI Codex CLI binary. |
| `POCKETAGENT_PI_BIN` | `pi` | Path to Pi CLI binary. |
| `POCKETAGENT_AGENT_INSTALL_PREFIX` | `~/.npm-global` | Destination directory for on-demand agent CLI installations. |
| `POCKETAGENT_SETTINGS_ENC_KEY` | unset | Base64-encoded 32-byte key to encrypt custom provider API keys at rest. |
| `POCKETAGENT_PUSH_CONTACT` | `mailto:pocketagent@localhost` | VAPID contact email/URI for Web Push notifications. |
| `POCKETAGENT_CODE_SERVER_URL` | unset | Base URL for code-server deep links. |
| `POCKETAGENT_WEB_DIST` | `<checkout>/apps/web/dist` | Directory where compiled frontend bundle is located. |
| `POCKETAGENT_BUILD_VERSION` | `package.json` | Semver reported on `/health` and `HostInfo.version`. |
| `LOG_LEVEL` | `info` | Fastify logger level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`). |
| `NODE_ENV` | `development` | Environment mode (`development`, `production`, `test`). |

### Hub Gateway (`apps/hub`)

| Variable | Default | Description |
| --- | --- | --- |
| `POCKETAGENT_HUB_AUTH_TOKEN` | — | **Required.** Operator credential for Hub web UI and API (min 24 chars). Never reuse backend tokens. |
| `POCKETAGENT_SETTINGS_ENC_KEY` | — | **Required on Hub.** 32-byte base64 key encrypting per-backend scoped credentials in `pocketagent-hub.db`. |
| `POCKETAGENT_HUB_HOST` | `127.0.0.1` | Bind address for Hub gateway. |
| `POCKETAGENT_HUB_PORT` | `8788` | Port for Hub gateway. |
| `POCKETAGENT_HUB_DATA_DIR` | `<checkout>/data/hub` | Directory for `pocketagent-hub.db` (host registry and template definitions). |
| `POCKETAGENT_HUB_SESSION_TTL_HOURS`| `720` | Lifetime in hours for Hub session cookies. |
| `POCKETAGENT_HUB_LATEST_RELEASE` | unset | Pinned latest release string for fleet version drift detection. |
| `POCKETAGENT_HUB_PUSH_CONTACT` | `mailto:pocketagent@localhost` | VAPID contact claim for Hub-managed Web Push relay. |
| `POCKETAGENT_ALLOWED_ORIGINS` | same-origin | Allowed origins for Hub access. |
| `POCKETAGENT_COOKIE_SECURE` | auto (`true` in prod) | `Secure` attribute for `pocketagent_hub_sid` cookie. |
| `POCKETAGENT_TRUST_PROXY` | `false` | Trust `X-Forwarded-For` on Hub. |
| `POCKETAGENT_WEB_DIST` | `<checkout>/apps/web/dist` | Directory where frontend bundle is served from. |

