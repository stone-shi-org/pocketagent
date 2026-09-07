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
decision. Fourteen demo scripts do, against a *running* server:

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
enumerate the entire unauthenticated surface, forever.

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
Agent` workspace is seeded once at `<repo>/data/planner-workspaces/default/` (the *directory*
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
  by an unattended trigger — today only an inbound webhook — whose own `skipPermissions` was
  already on. It is not a new decision, it is the existing one reaching the planner's gate: a
  webhook with the toggle *off* still parks its pocket turn on the first mutating call and waits
  **forever** for a human to answer in the Pocket Agent UI, with no timeout added anywhere, which
  is exactly cron's own "unattended run waits forever" behaviour. Three things keep it from
  widening. It lives on the chat row rather than being threaded through a turn, because it has to
  survive an approval pause, a restart and a `per-issue` webhook reusing the chat — but that row
  can only be written by the server: `CreatePlannerChatRequest` has **no such field**, so no
  browser can mint a pre-approved chat, and `apps/server/tests/webhooks-pocket.test.ts` asserts
  that a client asking for one is ignored. It short-circuits *before* the remembered-decision
  lookup and, like yolo, **never writes one** — turning the webhook's toggle off later must not
  leave the tool looking individually approved for everyone. And it is disclosed persistently:
  `PlannerChatPage` renders a standing callout on every visit, per the first invariant's "not
  just at the moment it was created".
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
  like "tapping a finished chat resumes it as a branch". The same goes for the other two
  home-screen categories (`PocketAgentsSection`, `ShellSection`) and their order — both
  layouts render the same three components in the same sequence, and a category added to
  one but not the other is a bug.
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
