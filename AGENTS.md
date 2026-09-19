# AGENTS.md

This file provides guidance and rules for agentic AI coding assistants (including Antigravity, Claude Code, and others) when working in the PocketAgent repository.

## Reference Document

See [CLAUDE.md](file:///data/homes/stoneshi/src/agents-remote-control/CLAUDE.md) for the authoritative repository instructions, developer commands, unit testing guides, and architectural details. Follow all guidelines therein to maintain consistency and prevent breaking critical invariants.

---

## Workspace Layout & Key Modules

PocketAgent is a monorepo configured with `pnpm` workspace packages:
* [packages/protocol](file:///data/homes/stoneshi/src/agents-remote-control/packages/protocol) — Single source of truth containing Zod schemas for HTTP bodies and WebSocket frames. **Must be built before anything else works.**
* [apps/server](file:///data/homes/stoneshi/src/agents-remote-control/apps/server) — Fastify server, driving child terminals and tmux sessions.
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
pnpm version:set 1.2.3   # Set the repo semver in all four package.json files
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
keeps the other three files identical and a test fails if they drift. `./build.sh` publishes
only when HEAD carries a tag parsing as `1.2.3` (no `v` prefix) and refuses when that tag
disagrees with the committed version — publishing an image whose `/health` contradicts its own
tag is the failure the whole pipeline exists to prevent. A prerelease publishes its exact tags
only and never moves `:<major>.<minor>` or `:latest`. CI is `./test.sh` then `./build.sh -p`;
`test.sh` deliberately runs the tests first and collects failures rather than aborting, because
Bamboo's parser globs `test-reports/*.xml` and an early exit reports "no test results found"
instead of naming the failure.
