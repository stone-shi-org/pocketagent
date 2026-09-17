# PA-67 — Multi-host web UI: all-hosts home, desktop host rail, mobile host sheet

Implementation plan. **No code changed yet** beyond this document — there is no `agent-ready`/
`approved` label and no go-ahead comment, so this is posted for review first per the workflow.

## 0. Where this sits

| Ticket | What it owns | Status today |
| --- | --- | --- |
| PA-60 | `HostEndpoint` threaded through `ApiClient`/`TerminalConnection`, `#/h/<hostId>/` parsing | **To Do** — plan posted, not implemented |
| PA-66 | `apps/hub`: registry CRUD, one-origin reverse proxy, SSO, per-host health polling | **To Do** — no plan yet |
| **PA-67** | the UI: aggregate home, rail, sheet, host-scoped tabs/deep links | this document |

PA-67 cannot merge before PA-60: without `createApiClient(endpoint)` and the `#/h/<id>/` prefix
there is nothing to point a second host at. It *can* be built and demonstrated before PA-66, and
the plan below is deliberately shaped so that it is: the host list arrives through a
`HostDirectory` seam with two implementations, and the standalone one (today's single backend)
renders **byte-identically to the current UI**. That property is the main safety net in this
ticket and several decisions below exist only to preserve it.

Recommended order: PA-60 → PA-67 phases 1–2 → PA-66 → PA-67 phases 3–5. Phase 3 (add/remove a
host) is the only part that genuinely needs a live Hub; everything before it is exercisable with
one host, and phase 3 is exercisable against a fixture directory.

## 1. What I verified in the code

Line numbers are current `feature/hub` (`37dc8a6`).

1. **One data hook feeds both layouts.** `useProjects` (`components/ProjectList.tsx:159`) owns the
   5 s `GET /api/projects` poll plus 15 mutating actions (`open`, `removeChat`, `detachChat`,
   `clearFinished`, `deleteWorktree`, `resolveQueued`, …) and is consumed by `ProjectsPage:66` and
   `DesktopShell:338`. `usePlannerChats` (`agent/use-planner-chats.ts`) is a **second** 5 s poller
   issuing two requests. So the aggregate view costs 3 requests × 5 s × N hosts if nothing is
   throttled — hence D4.
2. **`HostChip` is already shared chrome**, not a page element: `ProjectList.tsx:1401`, rendered
   from `ProjectsPage:88` (`.home-title`) and `DesktopShell:495` (`.sidebar-brand`). Its CSS
   (`styles.css:2030–2063`) already has an `offline` dot variant. Turning the chip into a button
   changes one component and both layouts get it — exactly the shape the ticket asks for.
3. **`HostInfo` is first-class already** (`packages/protocol/src/session.ts:363`): `id`, `name`,
   `version`, `online`, `codeServerBaseUrl`, and its doc comment already says "anything that varies
   per machine belongs here rather than in a global response field". `GET /api/hosts`
   (`routes/sessions.ts:294`) returns `[projects.host()]`; the id is a sha256 of hostname + workspace
   roots (`projects/index.ts:141`), stable across restarts and a database wipe — so it is usable in
   a shareable deep link.
4. **The composer already has a host row.** `ComposerPage.tsx:117` builds a one-option
   `SelectorRow` with the comment "one host until a front server registers others". It becomes a
   real picker; nothing new is designed.
5. **`DesktopShell` already keeps every tab mounted at once**, hiding inactive ones with
   `.tab-panel.inactive` (line 658ff). "A live session on host A keeps streaming while the user
   browses host B" is therefore almost free — provided tab identity and the tab strip do not
   filter by host (D6, D7).
6. **Tab ids are not host-qualified.** `tabIdFor` (`agent/tab-list.ts`) emits `t:<sessionId>`,
   `c:<conversationId>`, `p:<chatId>` and the fixed singleton `s:settings`; `open-tabs-pref.ts`
   persists the same routes to `localStorage`. Two hosts with a session id in common (or, for
   `s:settings`, *any* two hosts) collide into one tab. This is the highest-risk correctness item
   in the ticket and it typechecks clean.
7. **Web tests run in `environment: 'node'`** with `include: ['src/**/*.test.ts']`
   (`vitest.config.ts`) and there is no React Testing Library in `apps/web/package.json` — there
   are no `.test.tsx` files at all. Component behaviour is therefore **not unit-testable** here;
   the repo's existing answer is to keep the logic in pure modules (`agent/tab-list.ts`,
   `agent/fleet-groups.ts`, `agent/search.ts`) and cover the rendering with a Playwright demo.
   This plan follows that split rather than adding a DOM test stack.
8. **The web client does not validate responses.** `request<T>()` (`api/client.ts:115`) casts; no
   Zod parse on the client. So a field declared non-optional in `packages/protocol` but absent from
   an *older host's* response is `undefined` at runtime while typechecking clean. Everything read
   cross-host must be `optional`/`nullable` in the schema and handled — see D9.
9. **Migrating call sites is cheaper than it looks.** 33 files reference `api.` (~230 call sites),
   but almost all of them are inside components, so `const api = useHostApi();` is a *one-line*
   change per file with every `api.x()` call untouched. The real work is the handful that use it
   outside a component: `agent/notifications.ts` (module functions), `agent/use-planner-chats.ts`
   and `useProjects` (hooks — they take the client as an argument instead), `pages/LoginPage.tsx`
   and `App.tsx` (hub-level, deliberately stay on the default client).
10. **`window.location` has only five real call sites** in `apps/web/src`: `useHashRoute.ts:120/123/140`,
    `api/ws-client.ts:86–87`, `pages/CronJobEditorPage.tsx:326` (a raw hash write), and
    `components/SecretReveal.tsx:67` (`window.location.origin`). PA-60 covers the first three;
    `SecretReveal` is PA-67's, and it is not a rename — see D13.
11. **Notification deep links drop the host.** `agent/notifications.ts:52/79/107` build
    `/#/s/<sessionId>` in the browser, and server-sent web push carries a server-built `url`
    (`apps/server/src/push/index.ts:7`) through `public/sw.js`'s `notificationclick`. Under
    multi-host both resolve to the *default* host — see D14, which is a question for you rather
    than a decision I should make alone.
12. **No `PROTOCOL_VERSION` bump is needed.** Everything here is HTTP response shape plus client
    code; no WebSocket frame changes. (`packages/protocol/src/ws.ts:56` is at 15.)

## 2. Design decisions

Each one records the alternative it rejected, because most of them are not obvious.

### D1 — The host list comes from a `HostDirectory` seam, not from `GET /api/hosts` directly

New `apps/web/src/hosts/directory.ts`. Two implementations behind one interface:

* **standalone** — `GET /api/hosts`, exactly one host, `basePath: ''`, no add/remove. This is
  today's deployment and today's rendering.
* **hub** — `GET /api/hub/hosts`, N hosts with status, `basePath: '/h/<hostId>'`, add/bind/remove.

Resolved **once at boot** (probe the hub route; anything other than a 200 with a parseable body ⇒
standalone) and then kept in one place. Rejected: reading `/api/hosts` and letting it grow to N
entries. `HostListResponse` is a *backend* route — a backend must not claim to know about its
peers, which is the same reasoning that keeps the server from asserting its own external origin,
and PA-66 explicitly says the Hub proxies rather than merges.

Shared types go in a new `packages/protocol/src/hub.ts` (`HubHostEntry`, `HubHostListResponse`,
`HubHostStatus`) because protocol is this repo's single source of truth and PA-66's routes must
not invent a second shape. If PA-66 lands first, PA-67 consumes its types and this file is
already there.

### D2 — "All hosts" is the default *list* view, and only the list route

`#/` with no host segment ⇒ the aggregate home. Every **other** route with no host segment ⇒ the
default host, exactly as PA-60 promises, so `#/s/<id>` bookmarks keep working. There is no
conflict in practice: "all hosts" is meaningless for a session pane, a composer or an editor.
`#/h/<id>/` is one host's home. Rejected: a separate `#/all` route (a second spelling of the
default, and every `navigate({name:'list'})` call site would have to choose between them).

### D3 — Grouping under a host heading; no per-row metadata

The aggregate home renders, per host, a `HostGroup` — a heading (name, status dot, running count,
collapse chevron, per-host overflow menu) wrapping **the same three category components, with
their existing props unchanged**: `PocketAgentsSection`, `ShellSection`, `ProjectList`, in that
order, in both layouts. No `hostName` prop, no badge on a chat row: the standing "a chat is its
title and, if running, a green dot" convention survives because the host is carried by the
*heading*, which is what the ticket asks for.

**The heading is suppressed entirely when the directory has one host.** A single-host install
therefore renders precisely today's home screen — no wrapper, no chevron, no change. Collapse
state persists per host id in `localStorage` alongside the other prefs
(`agent/*-pref.ts` pattern).

### D4 — Two polling tiers, and never a socket per host

* **Status tier** — drives every dot in all three surfaces. One request per cycle in hub mode
  (`GET /api/hub/hosts`, which PA-66 already populates from its own health polling), one per host
  in standalone (where there is exactly one). 30 s cadence.
* **Data tier** — the existing 5 s home payload (`/api/projects` + the two planner requests), run
  **only** for hosts that are selected, whose group is expanded, or that have an open tab. A
  collapsed group shows its heading and status from the status tier and fetches nothing.

Plus: a per-host `AbortController` timeout (8 s) in the fleet poller only — *not* in `request()`,
which must stay shared — because today nothing times out and a hung host would spin forever,
which the ticket forbids; and exponential backoff (5 s → 60 s) for a host whose last fetch failed,
so one dead host does not cost a request every 5 s forever.

**No WebSocket is ever opened for a host merely because it is registered.** Sockets live in the
session/chat panes, so they exist only for hosts with an open tab. Asserted in the demo script by
counting `page.on('websocket')` events after switching hosts.

**D4b — "N running" without the data tier.** The rail tile wants a count for a *collapsed* host.
Add `runningSessions` to `HostInfo` (an in-memory count in `SessionManager`; no disk scan, no new
route) so the status tier carries it. Rejected: leaving the count to the data tier (then the rail
is blank exactly where the ticket says it should be informative) and adding a new counts endpoint
(a route for a number that belongs on the object that already describes a machine).

### D5 — Host-scoped API/WS access through React context, with a default

New `apps/web/src/hosts/HostContext.tsx`: `HostProvider` + `useHostApi()` returning
`{ hostId, endpoint, api, createTerminalConnection, createWatchConnection }`. The context's
**default value is the default host's client**, so every component that has not been migrated
keeps behaving exactly as it does today; migration is incremental and reviewable.

Rejected: prop-drilling an endpoint through `SessionRoute` → `AgentPage`/`TerminalPage` →
`Transcript`/`ToolCard`/`ApprovalSheet` (a very wide diff for a value nothing in between cares
about), and mutating a module-level `api` singleton on host switch (it would silently retarget a
*background* tab's in-flight requests, which is precisely the streaming AC).

### D6 — Tab identity becomes host-qualified, with a storage migration

`tabIdFor(hostId, route)` → `t:<hostId>:<sessionId>` etc., and the admin singleton becomes
`s:settings:<hostId>` — one admin tab **per host**, since a cron job, a webhook and a Pocket Agent
are per-host resources and collapsing two hosts' Settings into one tab would show the wrong
machine's data under the right title. `StoredTabRoute` gains `hostId`, and `isStoredTabRoute`
fills a missing one with the default host id rather than rejecting the entry — that validator is
already the designated place where a shape change degrades gracefully, so an existing user's open
tabs survive the upgrade. Rejected: keeping bare ids for the default host and suffixing only the
others (two id formats forever, and the format depends on a runtime value).

### D7 — The tab strip keeps every host's tabs; the home list does not label rows

Two different surfaces, two different rules. The strip is chrome, so a small host marker on a tab
is legitimate there (and necessary: two hosts can have identically-titled chats) and it appears
only when more than one host has tabs open. Selecting a foreign-host tab switches the selected
host along with the route. Rejected: filtering the strip by selected host — tabs vanishing on a
host switch reads as "my sessions were closed", and it would make the streaming AC invisible even
while true.

### D8 — One `ProjectsState` implementation, N façades

`ProjectList`, `ShellSection` and `PocketAgentsSection` must stay shared, and they already take a
`state: ProjectsState`. So: extract the 15 action bodies out of `useProjects` into a plain
`projectActions(client, deps)` factory (no hooks), then

* `useProjects(client?, …)` keeps its current signature and behaviour for the single-host path, and
* `useHostFleet()` holds one `Map<hostId, HostSlice>` of raw data behind **one** poller and builds
  a per-host `ProjectsState` façade with `useMemo`, each bound to that host's client.

This is what avoids calling a hook N times for a runtime-length N, and it keeps "tapping a
finished chat resumes it as a branch" in exactly one place, which the existing doc comment on
`useProjects` says is the whole point of the split.

### D9 — Four host states, and the socket stays the authority on version

`HostStatus = 'unknown' | 'online' | 'offline' | 'incompatible'`.

`HostInfo` gains `protocolVersion?: number` (optional, per finding #8: an older host simply will
not send it). A host is `incompatible` when it reports a version this bundle does not speak;
`unknown` when it has not answered yet or does not report one, rendered as a neutral dot rather
than a false green. The existing per-socket `?v=` check (`ws/index.ts:186`) remains the authority —
it is the only place that can be *sure* — and its permanent "version skew" state promotes the host
to `incompatible` in the directory.

Rendering rule, in all three surfaces: an offline/incompatible host shows a one-line legible
state (`Unreachable · retry` / `Speaks protocol v14, this app speaks v15`) with a Retry action,
**never** an empty list and never a spinner. Its group renders collapsed-with-reason; its rail
tile and sheet row show the same dot and the same words.

### D10 — Removing a host closes its tabs

Reuse the established pattern rather than inventing one: `PlannerChatPage` and `SessionRoute`
already fire `onBack()` when they discover the thing behind them is gone, which `DesktopShell`
wires to `closeTab` (PA-36/PA-58). A removed host's tabs go the same way, and its group leaves the
aggregate on the next status tick.

### D11 — The composer gets a real host picker

The row exists (`ComposerPage.tsx:374`); it becomes N options, defaulting to the selected host. In
all-hosts mode there *is* no implied host, so the picker is the answer rather than a guess — and
this is also why "New chat" from a host group heading pre-selects that host.

### D12 — Host-scoped dialogs take the host from context and say so

`AddProject`, `ShellDialog`, `NewSessionDialog`, `HiddenProjects`, `RunningSessions`,
`clear-finished`, "New tmux session", `DeleteWorktreeFlow` are all per-host operations. They read
the client from context and name the host in their title when more than one exists. Project-level
entry points additionally live on the host group heading, because a project folder is added to a
specific machine and picking it from a global menu would be ambiguous.

### D13 — `SecretReveal`'s delivery URL must name the backend, not the Hub

PA-66's hard constraint is that the Hub **must not** proxy `/api/hooks/*`. So under a hub the
correct URL to paste into Jira is the *backend's own* origin + `Webhook.deliveryPath` — and
`window.location.origin` (the Hub) is then actively wrong, in a way that would also invite someone
to try `/h/<id>/api/hooks/...` and conclude the feature is broken. The directory entry therefore
carries the host's registered base URL for **display only**, and the panel labels which origin it
used (it already labels the browser origin today). Standalone keeps `window.location.origin`
unchanged. This is the one place where a UI ticket has to encode a security constraint from
another ticket, so it gets a comment saying so.

### D14 — Notification deep links: needs your call

Local notifications (`notifications.ts:52/79/107`) are a small fix — the pane that raises them
knows its host, so the URL becomes `/#/h/<hostId>/s/<id>`.

Server-sent web push is not: the backend builds the `url` and, under a hub, has no idea what host
id the Hub filed it under. The only clean fix is for the client to record a link prefix when it
subscribes (`POST /api/push/subscribe` gains an optional `linkPrefix`, echoed into the payload
`url`), which is a protocol + server change inside a "web UI" ticket. **Options:** (a) do it, ~20
lines server-side; (b) leave it, and accept that a push from a non-default host opens the right
session id on the wrong host. I recommend (a) but will not add server surface without a word from
you. Either way the aggregate home itself is unaffected.

### D15 — The rail appears only when it means something

`HostRail` renders when the directory is hub-backed or reports more than one host. A 56 px column
containing one tile is not chrome, it is clutter, and suppressing it is what keeps "desktop looks
exactly as today for a single-host install" true alongside D3.

### D16 — The mobile sheet reuses the *picker* sheet, not `ApprovalSheet`

The ticket says "reusing the existing `ApprovalSheet` pattern". `ApprovalSheet` is a draggable,
minimizable, `pointer-events`-juggling pane built for a decision that blocks an agent
(`components/ApprovalSheet.tsx:22–54`); none of those mechanics belong to a switcher. The thing
actually meant is the **picker sheet** already in `styles.css:2709–2816` (`.sheet-backdrop`,
`.sheet`, `.sheet-title`, `.sheet-options`, `.sheet-option[.selected]`, `.sheet-cancel`) that
`WorktreeDialog` and friends use — a bottom sheet with a list of options, which is exactly the
described interaction. `HostSheet` is that, with a status dot per row plus "All hosts" and
"Add host…". Flagging the substitution rather than silently doing something other than the ticket
says.

## 3. Files

**New**

| File | Purpose |
| --- | --- |
| `packages/protocol/src/hub.ts` | `HubHostEntry`, `HubHostListResponse`, `HubHostStatus` — shared with PA-66 |
| `apps/web/src/hosts/directory.ts` | `HostDirectory`, standalone + hub implementations, boot probe |
| `apps/web/src/hosts/host-status.ts` | status derivation + labels (pure, tested) |
| `apps/web/src/hosts/host-groups.ts` | grouping + the "one host ⇒ no heading" rule (pure, tested) |
| `apps/web/src/hosts/selected-host.ts` | selected host from route + directory, unknown-id fallback (pure, tested) |
| `apps/web/src/hosts/poll-policy.ts` | data-tier membership + backoff (pure, tested) |
| `apps/web/src/hosts/HostContext.tsx` | `HostProvider`, `useHostApi` |
| `apps/web/src/hosts/useHostFleet.ts` | the one poller + per-host `ProjectsState` façades |
| `apps/web/src/components/HostRail.tsx` | desktop tiles |
| `apps/web/src/components/HostSheet.tsx` | phone bottom sheet |
| `apps/web/src/components/HostGroup.tsx` | heading + collapse + per-host menu |
| `apps/web/src/components/AddHostDialog.tsx` | hub-mode add/bind/remove |
| `apps/server/scripts/multi-host-ui-demo.mjs` | both viewports, per the ACs |

**Changed** (the shape of the change, not a line count)

`session.ts` (+`protocolVersion?`, +`runningSessions?`), `routes/sessions.ts` + `projects/index.ts`
(populate them), `ProjectList.tsx` (`projectActions` extraction; `HostChip` becomes a button),
`ProjectsPage.tsx` + `DesktopShell.tsx` (groups, rail, sheet, host-qualified tabs),
`agent/tab-list.ts` + `agent/open-tabs-pref.ts` (host in the id, migration),
`use-planner-chats.ts` (takes a client), `ComposerPage.tsx` (real picker), `SecretReveal.tsx` (D13),
`notifications.ts` (D14a), the ~25 remaining `const api = useHostApi();` one-liners,
`styles.css` (rail/group/sheet, from the existing token block only), `package.json` +
`eslint.config.js` (demo script), `CLAUDE.md`, and the Confluence pages below.

## 4. Phases

1. **Plumbing** (needs PA-60): `HostDirectory` + `HostContext` + `projectActions` extraction.
   Single host, no visible change. Ends with `pnpm build/typecheck/lint/test` green and the
   existing `demo:home-ui` / `demo:desktop-ui` passing unchanged — that pair is the regression
   guard for "looks exactly like today".
2. **Aggregate home**: `useHostFleet`, `HostGroup`, two-tier polling, offline/incompatible states.
   Both layouts, still one host in practice.
3. **Chrome**: `HostRail`, `HostSheet`, `AddHostDialog`, host switching as a state swap.
4. **Host-scoped everything else**: tab ids + storage migration, deep links end to end, composer
   picker, the host-scoped dialogs, `SecretReveal`, notifications (pending D14).
5. **Demo + docs**: `demo:multi-host-ui`, `eslint.config.js` browser-globals entry, CLAUDE.md, and
   the Confluence pages.

## 5. Verification

* `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`.
* New unit tests (pure modules, node environment — finding #7): `host-status.test.ts` (all four
  states, absent `protocolVersion` ⇒ `unknown`), `host-groups.test.ts` (one host ⇒ no heading;
  N hosts ⇒ stable order; an offline host's group still renders), `selected-host.test.ts` (bare
  list route ⇒ all hosts; bare detail route ⇒ default host; unknown host id ⇒ legible not-found,
  not a silent fallback), `poll-policy.test.ts` (collapsed host excluded; open tab forces
  inclusion; backoff schedule).
* Extended: `tab-list.test.ts` (no collision between two hosts' identical session ids; one admin
  tab per host), `open-tabs-pref.test.ts` (a stored entry with no `hostId` migrates to the default
  host), `client.test.ts` / `ws-client.test.ts` (PA-60's non-empty base path, re-asserted per host).
* `demo:multi-host-ui` — desktop and iPhone viewports, against a scratch server: rail tiles and
  their dots, the phone chip opening the sheet, switching hosts with **no page load** (assert on a
  `page.on('load')` counter), a deep link `#/h/<id>/s/<id>` surviving `reload()`, a second host
  pointed at a dead port rendering "unreachable" rather than an empty list or a spinner, and a
  socket count that does not grow when a host is merely registered. Registered in `package.json`
  and added to `eslint.config.js`'s browser-globals `files:` list.
* Docs in the same piece of work, not as a follow-up: **Key Workflows** (the aggregate home, host
  switching, deep links), **Conventions & Environment** (the three-categories convention now has
  host grouping above it; the rail is chrome), **Architecture Overview** (the client is
  host-parameterised). The `HostInfo` doc comment's "No such front server exists" paragraph and
  CLAUDE.md's matching text are **PA-66's** docs ticket by its own scope note — I will link, not
  overwrite, unless you want it done here.

## 6. Risks, and what I would cut first

* **Tab id collision (finding #6)** is the one bug here that ships silently: it typechecks, and it
  only shows up when two hosts share a session id or when anyone opens Settings twice. Phase 4 and
  its tests are not optional.
* **Polling cost** is the other: 3 requests × N hosts × 5 s is the naive shape. D4 is the answer;
  the demo asserts request counts so a regression is visible.
* **Scope.** If this is too large for one change, the honest cut is phase 3's `AddHostDialog` and
  D14 — the aggregate home, the grouping, the rail/sheet *switcher* and host-scoped deep links are
  the ticket's substance; adding a host can stay a Hub-side concern for one more round, at the cost
  of one acceptance criterion ("adding … works from both layouts").
* **Two unimplemented dependencies.** If PA-60's shape lands differently from its posted plan
  (notably `createApiClient` and `parse()` returning `{ hostId, route }`), phase 1 changes shape
  with it. I would rather implement PA-60 first, in its own change, than guess.

## 7. Questions

1. **D14** — add the optional `linkPrefix` to push subscription (server change), or accept
   mis-routed notifications from non-default hosts for now?
2. **D6/admin tabs** — one Settings/Cron/Webhooks tab **per host** is what I propose; confirm that
   is what you want rather than one global admin tab that follows the selected host.
3. **D16** — confirm the picker-sheet pattern rather than `ApprovalSheet` literally.
4. Should PA-67 wait on PA-66, or ship phases 1–2 (aggregate home, single host, no visible change)
   as its own change first? I lean to the latter: it is the whole refactor, with the regression
   guard of "the existing demos must still pass".

Reply "go ahead" (or add `agent-ready` / `approved`) and I will implement it, run
build/typecheck/lint/test plus the new demo, and rebase onto `main` before committing.
