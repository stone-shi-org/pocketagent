# PA-68 — On-demand agent installation and a bind-time agent setup dialog

Implementation plan. **No code changed yet** beyond this document — there is no `agent-ready`/
`approved` label and no go-ahead comment, so this is posted for review first per the workflow.

The ticket's central claim is right and cheaper than it looks: detection really is nearly free.
Two of its other premises do not survive contact with this machine, and both are load-bearing —
the install mechanism it implies (`npm install -g`) **cannot work as written on this host**, and
the one agent its acceptance criterion names by name (`claude`) is the one with no install channel
this design is allowed to use. Everything below is what I verified, followed by the decisions I
want settled.

## 0. Where this sits, and the split that unblocks it

| Ticket | What it owns | Status today |
| --- | --- | --- |
| PA-64 | backend container image, the volume contract, the agent prefix on PATH | **In Progress** — plan posted |
| PA-66 | `apps/hub`: registry CRUD, proxy, SSO, **the bind flow** | **To Do** — no plan yet |
| PA-67 | multi-host UI, `AddHostDialog` | **To Do** — plan posted, not implemented |
| **PA-68** | the installable catalog, the install job, the three states, the setup dialog | this document |

**PA-68 splits cleanly in two, and only the second half is blocked.**

* **Half A — the server capability plus a Settings surface.** The catalog, the install job, the
  SSE progress stream, and the three-state model. Buildable and shippable *today*, against a
  single standalone backend. The ticket already demands this independence: "Install must be usable
  on a non-containerised backend too — it is a server capability, not a Docker feature."
* **Half B — the bind-time dialog.** Needs a bind flow to hang off. There is none: `HostInfo` is a
  one-element array (`routes/sessions.ts:294`), the composer's host row has a deliberately empty
  `onChange` (`ComposerPage.tsx:371-379`, comment "one host until a front server registers
  others"), and nothing in `apps/web` can add or bind a host. PA-67's own file list is where
  `AddHostDialog` appears.

**Recommendation: implement Half A now**, surfaced in the Settings section that already exists for
exactly this, and ship the dialog as a *self-contained component* that PA-66/PA-67 mount after
bind. Half B then costs one call site rather than a feature. Waiting for PA-66 instead would park
a capability that is useful on every existing single-host install, including this one — which has
a working agent the server cannot see (finding 11).

## 1. What I verified

Line numbers are current `feature/hub` (`808cc3e`). Findings 7–12 are empirical, from this host.

1. **Detection is nearly free, exactly as claimed.** `resolveExecutable`
   (`agents/registry.ts:167-184`) searches `PATH` and then `~/.local/bin`, `~/.cargo/bin`,
   `~/.npm-global/bin` (`:175-177`). `isExecutable` (`:186-193`) wants `X_OK` **and**
   `statSync().isFile()`, so an npm shim symlink passes. Point the prefix at one of those three and
   the state half needs no new detection code.

2. **But an absolute-path override silently defeats it.** `resolveExecutable` returns early for any
   `bin` containing a separator (`:169-171`) and never consults the three home dirs. `claudeBin` is
   a live, runtime-editable setting (`settings/fields.ts:100`) and **the README actively tells
   people to set it to an absolute path** — `README.md:1067`, the documented fix for "Claude Code
   executable not found." On such a host an on-demand install lands in the prefix and stays
   invisible. This has to be surfaced in the dialog, not left to be discovered (D15).

3. **`available` is computed synchronously on a route six components fetch on mount, with nothing
   cached anywhere.** `AgentRegistry.list()` calls `a.isAvailable?.()` per agent per request
   (`registry.ts:108-124`); there is no TTL at any layer (contrast `git/status.ts:8-45`, which has
   one). Consumers: `ComposerPage.tsx:81`, `AgentPage.tsx:373`, `ChatPreviewPage.tsx:144`,
   `CronJobEditorPage.tsx:110`, `WebhookEditorPage.tsx:249`, `NewSessionDialog.tsx:57`,
   `CodingAgentsSection.tsx:46`. N × (PATH + 3) `statSync` calls is fine; **a subprocess spawn
   there would not be.** So the third state can never be probed inline on `GET /api/agents`. This
   is the hardest constraint in the ticket and the ticket does not mention it.

4. **The right Settings surface already exists, with the right shape.**
   `components/CodingAgentsSection.tsx` (125 lines) already lists one row per coding agent, already
   renders `{!a.available && <span className="settings-badge">Not on PATH</span>}` (`:98`), already
   has a section-level mutating button (`POST /api/agents/refresh`,
   `routes/sessions.ts:82-85`) that replaces the list wholesale, and already surfaces a per-agent
   error string (`lastRefreshError`, `session.ts:286-302`). Its own doc comment (`:31-37`) even
   settles the version question in advance: no CLI version is shown "deliberately: no adapter here
   has a confirmed `--version` invocation, and fabricating one would be exactly the kind of
   unverified CLI assumption this codebase's adapters go out of their way not to make."

5. **The "prompt, do not install" half is an affordance change, not machinery.** The composer
   already builds `detail: !agent.available ? 'not installed' : …` with `disabled: !agent.available`
   (`ComposerPage.tsx:142-147`), and `SessionManager` already re-checks and fails loudly with
   `agent_unavailable` / 503 (`sessions/manager.ts:698-706`). Nothing needs to learn to refuse;
   one disabled row needs to become actionable.

6. **The model refresh is not an authentication probe, so the third state cannot ride on it.**
   `probeClaudeModels` (`sessions/agent-probe.ts:179-217`) passes a never-yielding prompt so no turn
   is billed, and its doc records that `supportedModels()` "resolves normally in well under a
   second" — a local SDK handshake, not a credentialed call. `lastRefreshOk` therefore cannot mean
   "signed in".

7. **Every agent's login state is probeable, but the probes are wildly unequal — and two do not
   exist.** Measured here, all local unless noted:

   | Agent | Non-interactive probe | Quality | Time |
   | --- | --- | --- | --- |
   | `claude` | `claude auth status` — **JSON by default**, `{loggedIn, authMethod, apiProvider, …}` | ideal | 0.205 s |
   | `codex` | `codex login status` → one line of text | good | 0.105 s |
   | `pi` | `pi auth check --provider <p> --json` | **per-provider only, no global answer; always exits 0** | 0.404 s |
   | `opencode` | `opencode auth list` | ANSI box-drawing text, **no `--json`** | 0.805 s |
   | `agy` | **none — no `auth`/`login`/`status` subcommand exists** | only the token file, or network-bound `agy models` (1.809 s) | — |

   `codex doctor --json` is richer but performs DNS, a WSS handshake and an HTTP reachability probe,
   so it is not a cheap probe and is excluded. Credential paths follow no convention at all
   (`~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.pi/agent/auth.json`,
   `~/.local/share/opencode/auth.json`, and `agy` under **`~/.gemini/antigravity-cli/`**), and
   **env-var auth is a real third path** — `opencode auth list` reported `HF_TOKEN` under its own
   "Environment" heading, and `claude` documents `ANTHROPIC_API_KEY`/`apiKeyHelper`. So reading a
   credential file is the wrong probe in both directions: absent file ≠ signed out.

8. **`npm install -g` does not work on this host, for two independent reasons.**
   * `npm` is `/usr/bin/npm` → **`/usr/share/nodejs/corepack/dist/npm.js`**, a corepack shim.
     Every invocation from inside this repo fails with `Usage Error: This project is configured to
     use pnpm`, because corepack reads the nearest `package.json`'s `packageManager` field. **This
     is cwd-dependent, and the server's own cwd is the repo.** An installer that shells out to
     `npm` from `process.cwd()` fails 100% of the time here and would have shipped that way.
   * `npm config get prefix` is **`/usr`**, and `/usr/lib/node_modules` is `root root
     drwxr-xr-x` — not writable by the server's user. `NPM_CONFIG_PREFIX` is unset, there is no
     `~/.npmrc`, and **`~/.npm-global` does not exist** despite `registry.ts:177` searching it.

   Both are fixable and the fix is nearly free: run the installer with `cwd` = `usageProbeCwd()`
   (`usage/probe-cwd.ts`, `os.tmpdir()`), which the codebase *already mandates* for every headless
   CLI invocation for an unrelated reason, and pass an explicit `--prefix`. `npm --version` is
   `11.18.0` and works fine from a neutral cwd. The established precedent on this box is
   `--prefix ~/.local`: that is how both `pi` and `pnpm` got here
   (`~/.local/lib/node_modules`, shims in `~/.local/bin`, which *is* searched).

9. **Only two of the five declared agents have an install channel this design may use.** What is
   actually installed here, and how:

   | Agent | Installed as | npm package | argv-installable? |
   | --- | --- | --- | --- |
   | `pi` | npm global shim → `~/.local/lib/node_modules/@earendil-works/pi-coding-agent` | `@earendil-works/pi-coding-agent@0.85.1` | **yes** |
   | `codex` | native standalone `~/.codex/packages/standalone/…-musl/bin/codex` (0.151.0), shadowing an npm global `@openai/codex@0.147.0` at `/usr/bin/codex` | `@openai/codex` | **yes** (npm path) |
   | `claude` | native self-installer, `~/.local/bin/claude` → `~/.local/share/claude/versions/2.1.261` (215 MB ELF). `claude doctor`: `install method: native` | **not verified locally** | **no — see Q1** |
   | `agy` | plain 217 MB ELF copied into `~/.local/bin`; self-updates from a Google-hosted updater service. `agy install` only edits PATH/shell profile — it does not download | none found | **no** |
   | `opencode` | native installer drop in `~/.opencode/`; `opencode upgrade` self-manages | not derivable locally | **no** |

   `claude`, `agy` and `opencode` expose *self-update* subcommands rather than any discoverable
   download URL, which is useless for a first install. So a catalog restricted to argv-only,
   pinnable installs contains **`pi` and `codex`, and nothing else** — while acceptance criterion
   #2 is written about `claude`. That gap is Q1 and Q2, and it is the main thing I need an answer
   on.

10. **The binaries are enormous and a persistent prefix has real disk cost.** 184–275 MB each;
    `~/.local/share/claude/versions/` is retaining three versions at ~750 MB total. Worth stating
    in PA-64's volume documentation rather than discovering it when a volume fills.

11. **`opencode` is installed, working (v1.18.29) — and invisible to the server.** Its binary is
    `~/.opencode/bin/opencode`, which is neither on `PATH` nor among the three fallback dirs
    `resolveExecutable` searches. This is a live detection bug on this host, independent of the
    feature, and fixing it is a one-line change to the very list this ticket is about (D16).

12. **Two `codex` installs disagree, and the adapter's comment is stale.** `~/.local/bin/codex`
    (0.151.0) shadows `/usr/bin/codex` (0.147.0); `agents/codex.ts:15` records the app-server
    protocol as "confirmed live against the installed CLI (v0.147.0)", and `codex doctor` reports
    0.154.0 as available. Not PA-68's problem to fix, but it is precisely the drift a pinned
    catalog is supposed to make visible.

13. **The SSE pattern is not built for a slow job.** `streamPlannerEvents`
    (`routes/planner.ts:149-184`) is the only `reply.hijack()` site in the server. It writes three
    headers and `data: <json>\n\n` frames with no `event:`/`id:`, and it has **no heartbeat, no
    `request.raw.on('close')`, and no abort** — `PlannerChatService.sendMessage` accepts an
    `AbortSignal` (`planner/chats.ts:764`) that *no caller passes*. Hijacking also bypasses the
    `onSend` security-header hook (`app.ts:622-642`). For a 30-second chat turn those gaps are
    survivable. For a multi-minute install behind a reverse proxy, an idle timeout killing the
    stream *and* an abandoned install continuing to write to a dead socket are the two most likely
    failure modes in this ticket.

14. **The fix already exists in this codebase.** `runs/executor.ts:462-489` awaits the generator's
    first `next()` so a synchronous precondition failure is still a real error, then drains
    detached — "the drain is the pump, not the sensor." `telegram/bridge.ts:105` does the same.
    That is the shape an install wants: the job is authoritative, the stream is a view.

15. **Subprocess precedents are settled.** `runArgvCommand` (`planner/tools.ts:2055-2096`) is
    argv-only, never a shell, per-call timeout → `SIGKILL`, and never rejects; `runShellCommand`
    (`:1998-2046`) is the one place a `-lc` shell is deliberate. `EXEC_TIMEOUT_MS` is 60 s
    (`:342`) — far too short for a 200 MB install, so this needs its own budget. `buildChildEnv`
    (`sessions/env.ts:22-43`) strips every `POCKETAGENT_*` var and can set but never unset, which
    is how the prefix gets overridden safely.

16. **Everything here is unit-testable without a live server.** `app.inject()` buffers a hijacked
    stream and `tests/planner-chats.test.ts:183-189` already has a `parseEvents` that splits on
    `\n\n` and strips `data: `. `createTestApp` already takes injected seams
    (`plannerLlmFetch`, `telegramFetch` — `tests/helpers.ts:75-146`), so an install runner injects
    the same way. Origin/CSRF rejection precedent: `tests/auth.test.ts:159-168`.

17. **Web tests have no DOM.** The `web` vitest project is `environment: 'node'`,
    `include: ['src/**/*.test.ts']`, and `.tsx` is not even matched. UI logic must live in pure
    modules — the convention is stated in `components/DeleteWorktreeFlow.test.ts:5-16`, and
    `DeleteWorktreeFlow` is also the only multi-step-dialog precedent, with its transitions
    extracted as pure exported functions (`isBlockingDeleteError`, `stepAfterWorktreeDeleted`).
    There is **no progress dialog anywhere**, and `ConfirmDialog.body` is a plain `string`, not a
    `ReactNode`.

18. **No `PROTOCOL_VERSION` bump.** HTTP response shapes and a new HTTP route only; no WebSocket
    frame changes (`packages/protocol/src/ws.ts` stays at 15).

## 2. Design decisions

Each records the alternative it rejected.

### D1 — Ship Half A into the Settings section that already exists; the dialog is a component

`CodingAgentsSection` gains per-row state and an Install action; the reusable piece is a new
`AgentSetupDialog` that takes a list and a client and nothing else, so PA-66/PA-67 can mount it
after bind with no PA-68 changes. Rejected: building it *only* as a bind-time dialog (blocked on
PA-66, and useless to every existing install), and a whole new Settings page (the section is
already the right shape — finding 4).

### D2 — The catalog is a compiled-in constant, and the id is validated by the schema

`apps/server/src/agents/catalog.ts` exports a frozen array of entries: `id`, `displayName`,
`method`, the method's own pinned payload, and a `notes` string. `GET /api/agents/installable`
returns it. `POST /api/agents/install` takes `{ id: z.enum([...CATALOG_IDS]) }` — **a Zod enum
built from the catalog itself**, so an arbitrary package name is rejected by request validation
before any handler runs, and acceptance criterion #1 is enforced at the layer that cannot be
bypassed by a handler bug. Rejected: `z.string()` plus a handler lookup (the same check, one
refactor away from being forgotten), and an operator-editable catalog table (a
package-name-from-the-client channel with extra steps — the exact thing the ticket forbids).

### D3 — argv only. No shell, ever, and no `curl | sh`

The install runs through a `runArgvCommand`-shaped helper: `spawn(bin, args)`, never `-lc`. This is
the existing rule for anything whose input is not the operator's own typing
(`planner/tools.ts:2048-2054`), and it is what makes D2's id constraint mean something. Its direct
consequence is finding 9: `claude`'s, `agy`'s and `opencode`'s native installers are pipe-to-shell
scripts or undiscoverable, so **they cannot go in the catalog under this rule.** I would rather
state that than quietly add a shell.

### D4 — Two install methods: `npm`, and `download` with a mandatory pinned digest

`npm` covers `pi` and `codex` today. For the rest, the honest safe primitive is not a shell script
but a `download` method carrying a pinned URL **and a pinned `sha256`**: the server fetches,
verifies the digest, `chmod +x`, and atomically renames into the prefix. No shell, no piping
remote code into an interpreter, and a compromised or wrong artefact fails closed. Rejected:
`curl -fsSL … | bash` (executes unverified remote code as the server's user, from a URL the
operator never sees), and npm-only (leaves three of five agents permanently uninstallable,
including the one in the ACs). The cost is real and must be owned: per-arch, per-libc digests are
maintenance, which is Q2 and Q4.

### D5 — An install is arbitrary code execution *by design*, and the plan says so out loud

`npm install` runs registry `postinstall` scripts as the server's user; `--ignore-scripts` would
break most of these CLIs. So the catalog-id constraint bounds **which** package, not **what it may
do**. The real boundary here is the pinned catalog plus an operator's explicit click — not the id
check. Writing that down is the point: it is why versions are pinned, why D4 requires a digest,
why D13 keeps this away from the planner, and why this is not "safe because the id is an enum".

### D6 — Four states, not three. `unknown` is a real answer

```ts
type AgentSetupState = 'not-installed' | 'signed-out' | 'ready' | 'unknown';
```

`not-installed` is free (finding 1). `ready`/`signed-out` need finding 7's probe. `unknown` covers
"no probe declared for this adapter", "the probe failed or timed out", and "never run". Per finding
7 that means **`agy` and `opencode` are `unknown` in v1**, and `pi` is the awkward middle (Q7).
Rendered as a neutral badge with the reason, never as a green tick — the same reasoning PA-67's D9
gives for its own fourth host state. Rejected: three states with a default of `ready` (the exact
"binds a host, sees claude ✓, first session fails cryptically" failure the ticket is written to
prevent, just relocated), and defaulting to `signed-out` (nags an operator who is signed in via
`ANTHROPIC_API_KEY` — finding 7's third auth path).

### D7 — The auth probe is adapter-declared, cached, and never runs on a GET

New optional `AgentAdapter.probeAuth?(): Promise<AgentAuthProbe>` — the natural home, beside
`isAvailable`, and the only place that can know that `claude` answers JSON while `codex` answers a
line of text and `agy` answers nothing. It returns `{ state, detail }` and **never throws**, the
`McpRegistryService.checkConnection` posture (`planner/mcp/registry-service.ts:321-343`).

Results are persisted in `agent_defaults` as three additive columns
(`last_auth_at`, `last_auth_state`, `last_auth_detail`), exactly like `last_refresh_*`
(`db/index.ts:1207-1209`), and merged in `listAgentsWithCache` (`routes/sessions.ts:33-66`)
alongside the fields already merged there. Refreshed on three triggers only: the existing
**Refresh** button, immediately after a successful install, and an explicit dialog open. Never on a
plain `GET /api/agents` (finding 3).

**So the state half adds zero new routes**: `GET /api/agents` gains fields and
`POST /api/agents/refresh` gains the probe. That is the same "detection needs zero new code" payoff
the ticket claims, applied one layer up. Rejected: a `createPolled` background poller like
`usage/poll.ts` (a timer spawning five CLIs forever to answer a question nobody is currently
asking), and a new `GET /api/agents/setup` route (a second shape of the same list, which the
composer and four editors would then have to choose between).

### D8 — Do not reuse the usage sources as the auth probe

Tempting — `usage/claude-source.ts:50-58` already runs `claude -p /usage` every 5 minutes and
already degrades to `available: false` plus a human-readable `error`, and `AgentUsageInfo` is the
closest existing "probe result with a legible failure" shape. Rejected anyway, for three reasons:
it exists only for `claude`/`agy`/`codex`, so it answers `false` for `opencode` and `pi` because
there is no source rather than because they are signed out; `available` there conflates a missing
binary, a signed-out CLI and a changed output format; and `claude -p /usage` is a **headless agent
invocation that files a transcript** (the entire reason `probe-cwd.ts` exists), where
`claude auth status` is local, structured, 0.2 s and files nothing. The dedicated subcommand is
strictly better; the usage sources stay a usage feature.

### D9 — An install is a job; the SSE stream is only a view of it

`apps/server/src/agents/install.ts` — `AgentInstallService` owning at most one job per catalog id:
`{ catalogId, state: 'running'|'succeeded'|'failed', startedAt, finishedAt, exitCode, error, log }`.
`log` is an `OutputBuffer` (`terminal/output-buffer.ts`) — already bounded, already
sequence-numbered, already reports its own eviction as `truncated`, which is exactly what a
re-attaching client needs. The job survives the stream: closing the browser does not cancel an
install, and re-`POST`ing the same id **attaches to the running job rather than starting a second
one** (idempotency by id, the same "the claim is the insert" spirit as a webhook delivery).
Rejected: driving the install from the generator the way `streamPlannerEvents` drives a chat turn
(finding 13 — a phone locking its screen would then abort an install, or worse, not abort it and
write to a dead socket forever).

The route therefore: `POST /api/agents/install` starts-or-attaches and streams; a `?afterSeq=`
re-attach replays the buffered log. Frames add a `: ping\n\n` comment every 15 s so a proxy idle
timeout does not kill a long install, and a `request.raw.on('close')` handler stops writing while
leaving the job running — both gaps the existing helper has and a chat turn could afford. I will
factor the shared header/frame writing out of `routes/planner.ts` rather than copy it, so there is
one SSE writer; the heartbeat and close handling are opt-in so planner behaviour is unchanged.

### D10 — A subprocess timeout here is required, and is not the no-timeout invariant

`INSTALL_TIMEOUT_MS` (recommend 10 minutes), then `SIGKILL`, recorded as a failure naming the
timeout. This does **not** touch the standing rule that an unanswered *approval* must never decay
into an allow: no human decision is pending, nobody is being second-guessed, and a wedged
installer holds the single concurrency slot forever otherwise. The precedent is already uniform —
every probe times out at 15 s (`agent-probe.ts:24`), `exec_command` at 60 s
(`planner/tools.ts:342`), usage at 15 s. It is only approvals that wait forever.

### D11 — One install at a time, refused rather than queued

A second install of a *different* agent while one is running answers 409 naming the running one.
These are 200 MB downloads (finding 10) and an operator setting up a fresh host is not served by
five concurrent ones. Rejected: `RunQueue` (it keys on **working trees** and its occupancy is
derived from live sessions — an install has no cwd, no worktree and no session, so there is nothing
for it to observe; PA-10 already established that a run with no checkout takes no key), and an
unbounded fan-out.

### D12 — The install log is terminal-ish output: in memory, never persisted

The full log lives in the `OutputBuffer` and dies with the process, consistent with "Terminal I/O
is never logged or persisted." What *is* persisted, for acceptance criterion #4 to survive a page
reload, is the **outcome**: `last_install_at`, `last_install_ok`, `last_install_error` on
`agent_defaults`, truncated. The child's environment is never logged at all — an npm failure can
echo a registry URL carrying basic-auth credentials, and an audit line must not be one step from
recovering one (the same rule the provider-mutation logging follows).

### D13 — Not a planner tool, and not reachable by any unattended trigger

PA-56 gave Pocket Agent chats settings read/update. An install tool would be arbitrary code
execution (D5) selected by a model, so: no `install_agent` tool, and nothing in `cron/` or
`webhooks/` reaches this service. The decision matches PA-56's own refusal to make
`skipPermissionsEnabled` patchable — some capabilities require a human at the keyboard, and this is
the clearest one yet.

### D14 — No lazy auto-install; the composer's existing disabled row becomes the prompt

`ComposerPage.tsx:142-147`'s row keeps saying "not installed" but stops being `disabled`; choosing
it opens `AgentSetupDialog` instead of creating a session. Nothing installs without an explicit
confirm inside that dialog, so a typo still cannot install a package. The hard 503 at
`sessions/manager.ts:698-706` is untouched, so a hand-written API call still fails loudly.

### D15 — An absolute-path override is disclosed where it would otherwise lie

When an agent's configured bin contains a separator (finding 2), the dialog says so and names the
path, instead of offering an install that will land somewhere the server will not look. `AgentInfo`
gains `binOverridden: boolean` — derived, one line in `AgentRegistry.list()`, and worth a field
because the browser cannot compute it (it never sees `claudeBin`).

### D16 — Fix the detection list in the same change

Add `~/.opencode/bin` to `resolveExecutable`'s search dirs (finding 11). It is a live bug, it is
one line, and it is in the exact list this ticket is about — deferring it would mean shipping an
"agent setup" feature that reports a working agent as missing. `~/.bun/bin` and `~/.deno/bin` are
deliberately *not* added: no agent here uses them, and this list should grow on evidence.

### D17 — Install prefix is a setting, and the installer runs from `os.tmpdir()`

New `agentInstallPrefix`, `live: true`, one line in `settings/fields.ts` plus the config schema and
the protocol's settings shape. Default **`~/.local`** — it already exists on a normal host, it
already holds `pi` and `pnpm` by the same mechanism, and `~/.local/bin` is already searched.
`~/.npm-global` is the alternative PA-64's plan names; it is equally searched but does not exist
here and nothing uses it (Q3). The `npm` method passes `--prefix <resolved>` explicitly rather than
trusting `NPM_CONFIG_PREFIX`, and every install runs with `cwd = usageProbeCwd()` — which fixes the
corepack failure (finding 8) using the helper the codebase already requires for headless CLI calls.
`COREPACK_ENABLE_STRICT=0` goes in the child env as belt-and-braces; it is untested here and the
neutral cwd is the actual fix.

### D18 — A new, small event union — not `AgentEvent`

`packages/protocol/src/agent-install.ts`: `AgentInstallEvent` = `install_started` |
`install_log` | `install_finished`. Rejected: reusing `AgentEvent`'s `notice`/`text` to avoid a new
type — `AgentEvent` is a *conversation* shape fed to `applyEvent`/`transcript.ts`, and an install
log routed through it would make a transcript reducer responsible for rendering npm output.

## 3. Files

**New**

| File | Purpose |
| --- | --- |
| `packages/protocol/src/agent-install.ts` | `InstallableAgent`, `AgentInstallMethod`, `AgentInstallEvent`, `AgentSetupState` |
| `apps/server/src/agents/catalog.ts` | the frozen catalog + `CATALOG_IDS` for D2's enum |
| `apps/server/src/agents/install.ts` | `AgentInstallService`: the job, the `OutputBuffer`, the two methods |
| `apps/server/src/agents/auth-probe.ts` | per-adapter `probeAuth` implementations (finding 7) |
| `apps/server/src/routes/agent-install.ts` | `GET /api/agents/installable`, `POST /api/agents/install` |
| `apps/server/src/routes/sse.ts` | the SSE writer factored out of `routes/planner.ts`, + heartbeat/close |
| `apps/web/src/components/AgentSetupDialog.tsx` | the dialog (D1), mountable from Settings, composer, or a bind flow |
| `apps/web/src/agent/agent-setup.ts` | **pure**: state derivation, badge/label text, dialog step machine |
| `apps/web/src/agent/agent-setup.test.ts` | the truth table and the step transitions (finding 17) |
| `apps/server/tests/agent-install.test.ts` | the ACs (§5) |
| `apps/server/scripts/agent-install-ui-demo.mjs` | browser demo, phone viewport |

**Changed**

`agents/types.ts` (+`probeAuth?`), `agents/registry.ts` (D16's one line; `binOverridden` in
`list()`), `packages/protocol/src/session.ts` (`AgentInfo` += `setupState`, `setupDetail`,
`binOverridden`, `lastInstall*`), `packages/protocol/src/http.ts` (settings shape),
`apps/server/src/config/index.ts` + `settings/fields.ts` (D17), `db/index.ts` (six additive
columns + their read/write helpers), `routes/sessions.ts` (`listAgentsWithCache` merge; the refresh
route also probes), `routes/planner.ts` (use the extracted SSE writer), `app.ts` (construct the
service, register the route), `sessions/manager.ts` (probe after install), `api/client.ts`
(`listInstallableAgents`, `installAgent` streaming — generalise `streamPlannerEvents`, which is
currently hard-typed to `AgentEvent`), `CodingAgentsSection.tsx`, `ComposerPage.tsx` (D14),
`tests/helpers.ts` (inject an install runner), `package.json` + `eslint.config.js` (demo),
`.env.example`, `README.md`, `CLAUDE.md` / `AGENTS.md`, Confluence (§5).

## 4. Phases

1. **State, no install.** `probeAuth` for `claude` + `codex`, the six columns, the merge, D15, D16.
   `CodingAgentsSection` shows four states. Immediately useful on its own, and it makes finding 11
   visible.
2. **The catalog and the job.** `catalog.ts`, `install.ts`, the `npm` method, the extracted SSE
   writer with heartbeat and close handling, the route, the server tests.
3. **The dialog.** `AgentSetupDialog` + the pure module, wired into Settings and the composer.
4. **`download` + digest** (D4), if approved in Q2 — this is the phase that lets `claude` into the
   catalog and therefore the phase acceptance criterion #2 depends on.
5. **Demo + docs.**

If this is too large for one change, the honest cut is phase 4 and the composer entry point:
phases 1–3 deliver the three states, a catalog-id-only install, and the dialog, which is the
ticket's substance for the agents that *can* be installed.

## 5. Verification

`pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` (remember `pnpm protocol` first —
`AgentInfo` changes here).

New `apps/server/tests/agent-install.test.ts`, mapping 1:1 onto the ACs:

* **AC #1, the important one.** `POST /api/agents/install` with `{ id: '@evil/pkg' }` → **400**,
  and separately with a syntactically valid but uncatalogued id → 400; plus an assertion that the
  rejection comes from schema validation (no install runner invocation recorded). Also the
  Origin-rejection case (`auth.test.ts:159-168`'s shape) and the 401 case, since this is a POST.
* **AC #4.** An injected runner that exits non-zero with real stderr → that stderr appears in the
  streamed `install_log` frames *and* in the persisted `last_install_error`, not a generic string.
* **The job semantics.** A second POST for the same id while running attaches and replays rather
  than spawning twice; a different id while running → 409; a runner that never exits → killed at
  the timeout and recorded as such; the stream ending does not kill the job.
* **Frame shape**, via `app.inject()` + `parseEvents` (finding 16): `content-type` matches
  `text/event-stream` and the `kind` sequence is `install_started`, `install_log`…,
  `install_finished`.
* **State derivation**, table-driven: `not-installed` when the binary is absent even if a probe
  once said `ready`; `unknown` for an adapter with no `probeAuth`; `unknown` when a probe throws;
  `signed-out` propagating its `detail`.

New `apps/web/src/agent/agent-setup.test.ts`: the same truth table on the client side (a stale
field from an older host must not render as a green tick — PA-67 finding #8: the web client never
validates responses), the dialog's step transitions, and the composer row's detail text.

`demo:agent-install-ui` — phone viewport against a scratch server with a **stubbed catalog entry**
whose install is a local script, asserting: the four badges render, "Install" streams visible log
lines, a failure shows the real error, and navigating away and back re-attaches to a running
install rather than restarting it. Registered in `package.json` and added to
`eslint.config.js`'s browser-globals `files:` list.

**Not verifiable here: AC #3 (survives a container restart).** It is a property of the volume, and
PA-64's own plan already has it — step 3 of its `docker-smoke.mjs` asserts "database, session
history and an installed agent survive". PA-68 supplies the install; PA-64's smoke script verifies
the persistence. Neither should grow a second copy.

Docs in the same change: **CLAUDE.md**'s "The browser never supplies an executable or argv"
invariant gains the catalog-id rule (the ticket is explicit that this is an *extension* of that
invariant, and it belongs beside it); README gets an "Installing agents" subsection, the D5
disclosure, D17's prefix, and a rewrite of the `README.md:1067` troubleshooting entry, which now
has a UI answer and a caveat (finding 2). Confluence: **Invariants & Security Model** (primary),
**Transports & Process Backends** ("adding an agent adapter" now also means adding a catalog
entry), **Conventions & Environment** (the new setting), **Installation & Deployment** (prefix,
volume, disk cost from finding 10), **Development Guide** (the demo).

## 6. Risks

* **The catalog may be nearly empty** (finding 9). Without Q2, `claude` — the agent AC #2 names —
  cannot be installed by this feature at all. This is the single biggest risk and it is a decision,
  not an engineering problem.
* **Pinned digests are ongoing maintenance.** Per-arch, per-libc, per-version. PA-64 has the same
  problem and proposes one `docker/agent-versions.env`; if these do not share that file they will
  drift (Q4).
* **`unknown` could become the normal answer.** If Q7 lands on "no probe for pi/agy/opencode", then
  three of five rows read `unknown` forever, and a state model whose usual value is "don't know" is
  close to no state model. Mitigated by `claude` and `codex` being the agents people actually bind
  a fresh host for, but worth naming.
* **The install is the one genuinely privileged thing this server has learned to do** (D5). Every
  guard here is a *bound* on it, not a sandbox.

## 7. Questions

Answers wanted on 1–4 before implementing; I will take my own recommendation on the rest.

1. **`claude`'s install channel.** Its native installer is the pipe-to-shell kind D3 forbids, and I
   deliberately did not fetch anything from the network to confirm an npm package name. Is an npm
   channel for Claude Code acceptable and supported for your deployment? **This blocks AC #2.** If
   the answer is "native installer only", then D4's `download` method with a pinned digest is the
   only way it can be in the catalog, and I need a URL and digest source.
2. **Approve D4's `download` + mandatory sha256 method?** It is the only safe route for `agy` and
   `opencode`, and possibly for `claude`. The alternative is npm-only, and a catalog of two.
3. **Install prefix: `~/.local` (my recommendation, and this host's existing convention) or
   `~/.npm-global` (what PA-64's plan names)?** Both are already searched; they should not disagree
   between the image and the server.
4. **Should the catalog's pins live in PA-64's `docker/agent-versions.env`**, so the image's baked
   CLIs and the on-demand installs bump in one file? Recommend yes.
5. **Is D16 (the `~/.opencode/bin` detection fix) in scope here?** Recommend yes — it is a live bug
   in the list this ticket is about.
6. **Half B sequencing**: PA-68 ships the server capability plus a mountable dialog; PA-66/PA-67
   mount it at bind time. Confirm, or you want PA-68 held until a bind flow exists.
7. **`pi`/`agy`/`opencode` auth probes**: accept `unknown` in v1? `pi`'s own answer is per-provider
   and its default provider is *not* the one configured here, `opencode` emits ANSI text with no
   JSON, and `agy` has no subcommand at all. I would rather ship `unknown` with a legible reason
   than encode three guesses.

Estimate: medium–large. The job, the catalog and the probes are each small; the four-state model
touching `AgentInfo` (read by six components), the SSE extraction, and the honest documentation of
D5 are the larger half.

Reply "go ahead" or add the `agent-ready` label and I will implement it, run
build/typecheck/lint/test plus the new demo, and rebase onto `master` before committing.
