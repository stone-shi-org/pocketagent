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
```

**`packages/protocol` must be built before anything else works.** It is consumed as
compiled output, not source, so `lint`, `typecheck`, and `test` each run `pnpm protocol`
first. When editing protocol types, run `pnpm protocol` (or a full `pnpm build`) before you
trust a typecheck in `apps/server` or `apps/web`.

### Running a single test

Vitest is configured with two projects, `server` and `web`, from the root `vitest.config.ts`:

```bash
pnpm exec vitest run apps/server/tests/sessions.test.ts     # one file
pnpm exec vitest run --project server                       # one project
pnpm exec vitest run -t 'detaches on request'               # one test by name
pnpm test:watch
```

Server tests run in `pool: 'forks'` with a 20s timeout: they spawn real PTYs, real tmux
servers, and real SQLite handles, so each file needs its own process. `tmux-backend.test.ts`
and `adopt.test.ts` skip themselves when `tmux` is not installed.

### Live demos

The unit suite cannot cover xterm rendering, a real agent, a real tmux server, or a layout
decision. Eleven demo scripts do, against a *running* server:

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
```

The first four read the token from `.env` and default to `:8787`. The rest expect a
*scratch* server (`PA_BASE`) with a throwaway workspace root — they create files, start
agents, and kill tmux servers. Never point them at the real database: `DATABASE_PATH` is not
configurable (always `<checkout>/data/pocketagent.db` — see `Config.databasePath`), so the
only way to get an isolated database for a scratch server is to run it from a second checkout
rather than pointing an env var at a different file.

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
- `adopt/index.ts` — attaches to a pane on a *foreign* tmux socket. Off unless
  `POCKETAGENT_ADOPT_TMUX_SOCKET` is set. The browser only ever sends an opaque
  sha256-derived id; the server builds the argv. Adopted sessions always use the direct
  backend, because what we spawn is a tmux *client* and killing it must only ever detach.

### Scheduled jobs

`cron/index.ts` (`CronService`) is the only thing in the server that starts agent work with
no human present. A job is a saved spec — directory, agent, worktree policy, model, effort,
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

### The home screen

`projects/index.ts` composes `GET /api/projects`: live sessions and on-disk conversations
merged into one chat list per directory. Two rules live here — a session that resumed a
transcript hides that transcript's row (they are one chat, and the session is the live view
of it), and a chat's timestamp falls back through `lastActivityAt → startedAt → createdAt`
so a brand new one does not sort last.

Scheduled jobs also surface here, as `ProjectInfo.cronJobs` rather than folded into `chats`:
a job is a *spec*, not a conversation — it exists before it has ever run and survives every
run it starts — so it has no transcript to open and tapping it opens its editor instead. A
directory that only has a job in it still gets a project row, or a job configured in a
subdirectory with no chats yet would be invisible until its first run, which defeats the
point of listing it. Runs, in contrast, *are* chats: `ChatSummary.cronJobId` badges them,
keyed on the **conversation** id because `representativeSessions` collapses several session
rows sharing one `agentSessionId` and a session-keyed badge would vanish with the collapse.

`HostInfo` is first-class with exactly one entry: this server. The header chip, the
composer's host row and `GET /api/hosts` are all shaped for several machines so that a front
server registering backs would not force a client rewrite. **No such front server exists**,
and building one concentrates credentials for every registered machine in one process —
treat it as a design problem, not a feature request.

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
change; the client sends it as `?v=` and a mismatch is rejected at connect.

Output replay is byte-oriented with monotonic sequence numbers (`terminal/output-buffer.ts`,
and `terminal/event-buffer.ts` for structured events). Each stream also has an **epoch**:
seq numbers are only meaningful within one run, so a resume with a stale epoch forces a
truncated full replay rather than splicing a corrupt ANSI stream.

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
- **Containment is decided with `fs.realpath` + `path.relative`, never a string prefix**
  (`workspaces/index.ts`). Resolve the whole path first, *then* test containment, or a
  symlink inside a root escapes it.
- **A session's cwd must still resolve inside a workspace folder** — but that list is now
  user-managed (`workspaces` table, seeded once from config) rather than fixed in the
  environment. Adding a folder via `POST /api/workspaces/add` is the moment access is
  granted, and it is logged. `GET /api/browse` is read-only and can see any directory the
  server's user can; that is a deliberate widening and the cost of picking any folder.
- **The browser never supplies an executable or argv.** Adoption and resume both take their
  `cwd` from the server-validated target.
- **A project is an added folder, or a directory inside one.** Chats in a directory outside
  every folder are not listed, so removing a folder actually removes it. Nothing is deleted;
  re-adding brings its chats back.
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
- **Two layouts, chosen by `matchMedia` in `hooks/useMediaQuery.ts` — never by user-agent
  sniffing.** `(min-width: 900px) and (pointer: fine)` gets `DesktopShell` (sidebar plus
  session pane); everything else gets the single-column phone pages. The list itself lives
  in `components/ProjectList.tsx` and is shared, so the two layouts cannot drift on rules
  like "tapping a finished chat resumes it as a branch".
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

`.env` (gitignored) is required: `POCKETAGENT_AUTH_TOKEN` (min 24 chars, never
auto-generated) and `POCKETAGENT_WORKSPACE_ROOTS` (no default — unset must never mean the
whole filesystem). The server refuses to start without both. `.env.example` documents every
setting; the README covers deployment, the security model, and known limitations.

Default bind is `127.0.0.1`. This grants terminal access as your user, so exposing it is a
deliberate act — prefer Tailscale over `0.0.0.0`.

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
