# PA-64 — Backend container image with mountable data and workspace volumes

**Status: plan only. No code has been changed.** There is no "go ahead"/"approve" comment and
no `agent-ready`/`approved` label on PA-64, so this is the Initial Phase deliverable.

The ticket is accurate and the design calls in it are the right ones — `node:22-bookworm-slim`,
multi-stage, non-root with a settable UID, no `chown` of mounts, byte-identical workspace mounts,
and a thin/`-claude`/`-all` tag set rather than a per-agent matrix. What follows is what I found
verifying it against the code, the places where reality is more awkward than the ticket assumes,
and the decisions I want settled before writing a Dockerfile.

Docker 29.5.0 with buildx is available on this machine and the service account is in the `docker`
group, so every acceptance criterion in the ticket is verifiable live rather than by inspection.

---

## 1. The PA-62 dependency is real but softer than "blocked"

PA-62 (configurable data directory) is still `To Do` with an unapproved plan comment. Two facts
change how much that matters:

- `REPO_ROOT` is `path.resolve(dirname(import.meta.url), '../../../..')`
  (`config/index.ts:9-11`), and it resolves identically from `src/` and `dist/` because both sit
  four levels deep. If the image keeps the repo layout under `/app`, `REPO_ROOT` is `/app` and
  `databasePath` is `/app/data/pocketagent.db` (`config/index.ts:297`). **A volume mounted at
  `/app/data` works today, with zero code change.**
- But that puts mutable state inside the install directory, which is precisely what an image
  upgrade replaces, forecloses a read-only root filesystem later, and — worst — makes the volume
  contract this ticket says must be "documented and stable" a path that exists only because of an
  implementation detail of `import.meta.url` arithmetic.

**Recommendation: land PA-62 first.** It is ~4 source files and its plan is already written. The
image then sets `POCKETAGENT_DATA_DIR=/data` and the contract is honest. If PA-62 stalls, PA-64
*can* ship against `/app/data` and migrate later, but the migration is a breaking change to a
documented volume path, which is the one thing the ticket explicitly asks us not to do. I would
rather wait a day.

Note also PA-62's own review finding, which is load-bearing here: the data root is **three**
directories, not one — `pocketagent.db`, `data/planner-workspaces` (`app.ts:252`) and
`data/planner-skills` (`planner/skills.ts:126-128`). All three are app-owned mutable state and all
three belong on the mounted volume. Pocket Agent chat transcripts live under
`<workspace>/.transcripts/` (`planner/transcript.ts:28`), i.e. inside `planner-workspaces`, so
they ride along automatically.

---

## 2. Verified facts that constrain the image

I checked each of these rather than assuming them.

**The base image choice is not just caution about `node-pty`.** The agent CLIs installed on this
machine are: `agy` — a stripped, dynamically-linked glibc ELF (`interpreter
/lib64/ld-linux-x86-64.so.2`); `claude` — the native installer's versioned binary under
`~/.local/share/claude/versions/`; `codex` — a `x86_64-unknown-linux-musl` standalone release;
`pi` — an npm global. So `-bookworm-slim` is required by more than the two native modules, and
musl would break at least `agy`. The ticket's "not alpine" is right for a second, independent
reason.

**"Thin" is a statement about agent CLIs, not about size.**
`@anthropic-ai/claude-agent-sdk-linux-x64` is **291 MB** and is a plain runtime dependency of the
server (`node_modules` here totals 585 MB; `node-pty` is another 60 MB). The thin image will land
somewhere near 700 MB–1 GB. The tag name is still right — it means "no agent CLIs on PATH" — but
the README must say the number out loud, or the first person who pulls it files a bug.

**That SDK package is arch- *and* libc-specific** (`…-linux-x64`, `…-linux-x64-musl`,
`…-linux-arm64`, … selected as `optionalDependencies` at install time). An amd64 `node_modules`
is not usable on arm64. Multi-arch therefore needs a genuine per-platform install, not a single
build with `COPY --from`. PA-64 delivers a Dockerfile that is correct under
`buildx --platform`; publishing the matrix is PA-65's job.

**Do not use `pnpm deploy`.** Its flattened output puts `dist/` at `<out>/dist`, which makes
`REPO_ROOT` resolve to `/` — silently re-pointing `.env` loading (`config/index.ts:13`), the
`webDistPath` default, the token-help text, and (post-PA-62) the data-dir default at the
filesystem root. The image keeps the repo layout under `/app`.

**`exec_command` uses a login shell and the shell agent an interactive one**
(`planner/tools.ts:2009` — `spawn(shell, ['-lc', …])`; `agents/shell.ts:18-20` — `<shell> -i`).
So PATH for agent binaries must be set in `/etc/profile.d/`, not only as a Docker `ENV`, or an
agent installed into the mounted prefix will be invisible to exactly the two surfaces most likely
to look for it. `SHELL` is normally unset in a container, so `config/index.ts:305` falls through
to `/bin/bash` — present in bookworm-slim, absent in alpine. Another independent "not alpine".

**Required runtime binaries**, from the sweep: `node ≥22`, `/bin/bash`, `git`, `grep`, `find`
(the last two back the planner's `grep_files`/`find_files`, `planner/tools.ts:2070`). Conditional:
`tmux` (boot *fails* at `app.ts:298` if `POCKETAGENT_BACKEND=tmux` and `tmux -V` does not run),
and `systemd-run`, which is meaningless in a container and must be documented as such
(`POCKETAGENT_TMUX_SESSION_SCOPE_SLICE`).

**MCP needs nothing extra** — the registry is HTTP/SSE only (`planner/mcp/client.ts`), no stdio
servers are spawned, so no `npx`/`uvx` in the image.

---

## 3. Image structure

One `docker/Dockerfile`, four stages, three published targets.

```
deps       node:22-bookworm-slim + build-essential python3 + pnpm
           └── pnpm install --frozen-lockfile        (full; vite/tsc needed)
build      └── pnpm build                            (protocol → server → web)
prod-deps  same toolchain base
           └── pnpm install --frozen-lockfile --prod (recompiles node-pty/better-sqlite3)
runtime    node:22-bookworm-slim + git tmux ca-certificates tini
           └── COPY the dist outputs + the pruned node_modules, preserving layout
```

`allowBuilds` in `pnpm-workspace.yaml` lists exactly `better-sqlite3`, `esbuild`, `node-pty`, so
the `--prod` stage still needs the toolchain — hence a separate stage rather than a `--prod`
install in the runtime image.

Runtime layout, chosen so `REPO_ROOT === /app`:

```
/app/apps/server/dist/…          /app/apps/server/package.json
/app/apps/web/dist/…             /app/packages/protocol/dist/…
/app/node_modules/…              (+ the per-package node_modules symlink trees)
```

`POCKETAGENT_WEB_DIST=/app/apps/web/dist` is set explicitly even though the default already
resolves there — the bundle location becomes a stated contract instead of an inference from
`import.meta.url`. (That variable exists in the schema today, `config/index.ts:78`, but appears
in neither the README nor `.env.example`; this fixes that too.)

`tini` as `ENTRYPOINT` (plus documenting `--init`): Node as PID 1 does not reap re-parented
orphans, and this app's whole job is spawning PTYs and a `-lc` shell. `server.ts:59-60` already
handles SIGTERM/SIGINT, and tini forwards them, so graceful shutdown works — but note
`server.ts:46-57` has **no force-exit timer**, so a hung `app.close()` never exits. The docs
should recommend `--stop-timeout 30`, above the 4 s the session shutdown loop can spend
(`sessions/manager.ts:1928-1958`).

`HEALTHCHECK` hits `/health`, which is public (`app.ts:96`) — via `node -e "fetch(…)"`, no curl
needed.

**The version stamp regresses without a fix.** `apps/web/vite.config.ts:25-31` shells out to
`git rev-parse HEAD` and falls back to `'unknown'` when there is no `.git` — which is exactly the
case in a build context that (correctly) excludes it. One small change: read
`POCKETAGENT_VERSION` from the environment first, keep the git probe as the fallback, and pass it
as a `--build-arg`. PA-61/PA-65 own real semver; this just stops every container's UI from
reporting `unknown`.

`.dockerignore` is load-bearing, not hygiene: without it, `.env` enters the build context and the
auth token is baked into an image layer. It excludes `.env*`, `node_modules/`, `data/`,
`.worktrees/`, `screenshots/`, `dist/`, `*.tsbuildinfo`.

---

## 4. Non-root and UID/GID

The image creates `pocketagent` (uid/gid 1000) with `HOME=/home/pocketagent`. Two supported
modes, both documented:

1. **`PUID`/`PGID` (default, what the compose example uses).** The entrypoint starts as root,
   `usermod`/`groupmod`s the `pocketagent` account to the requested ids — touching only
   `/etc/passwd`, `/etc/group` and the image's own `HOME` skeleton — and `exec`s the server
   under `gosu`. This is the only way to get a real passwd entry for an arbitrary uid, which
   `git` and several CLIs want.
2. **`--user $(id -u):$(id -g)`.** The entrypoint detects a non-root euid and skips the remap
   entirely. `os.homedir()` reads `$HOME` first, and the image sets it, so this works — but there
   is no passwd entry, so it is the second-class option.

**The entrypoint never chowns a mount.** It *checks* that the data dir and `$HOME` are writable
and, if not, exits with a message naming the exact `chown` to run on the host — the same
fail-loudly-with-the-fix posture `ConfigError` already takes (`server.ts:8-11`, exit 78). Two
things the docs must state because they are the predictable support load:

- An **empty named volume** inherits ownership from the image's directory; a **bind mount** does
  not. Bind mounts must be pre-created with the right owner.
- `git` refuses to operate on a repo owned by a different uid (`detected dubious ownership`). A
  uid mismatch therefore does not merely produce root-owned files, it breaks `git status`
  (`git/status.ts:69`) and every worktree operation. This is the strongest practical argument for
  matching the uid, stronger than the one the ticket gives.

Ownership matters in more places than the ticket lists: uploaded attachments are written into
`<session cwd>/.pocketagent/attachments/` (`sessions/attachments.ts:12-26`), and worktree creation
appends to `<repo>/.git/info/exclude` (`git/worktree.ts:333`) — both inside the *user's* checkout.

---

## 5. The volume contract

| Container path | Set by | Holds | Must match the host path? |
| --- | --- | --- | --- |
| `/data` | `POCKETAGENT_DATA_DIR` (PA-62) | `pocketagent.db` (+WAL sidecars), `planner-workspaces/` (incl. Pocket Agent transcripts), `planner-skills/` | No |
| `/home/pocketagent` | `HOME` | agent CLI credentials and config; `~/.claude/projects` transcripts; `~/.gemini/antigravity-cli/brain`; `~/.pi/agent/sessions`; `~/.codex/sessions`; **and the agent prefix** | No |
| *(inside `$HOME`)* | `NPM_CONFIG_PREFIX=$HOME/.npm-global` | agent CLIs installed on demand (PA-68) | No |
| the operator's repos | `POCKETAGENT_WORKSPACE_ROOTS` | the user's code | **Yes — byte-identical** |

**The agent prefix does not need its own volume.** `resolveExecutable` already searches
`~/.local/bin`, `~/.cargo/bin` and `~/.npm-global/bin` after PATH (`agents/registry.ts:174-177`),
so it is inside `$HOME` by construction. The image sets `NPM_CONFIG_PREFIX` and puts both
`$HOME/.npm-global/bin` and `$HOME/.local/bin` on PATH (in `ENV` *and* `/etc/profile.d/`, per §2),
giving PA-68 a documented, persistent install target with no new mount. It can still be split out
as a separate volume by an operator who wants credentials and binaries on different disks; the
contract does not forbid it.

**Byte-identical workspace mounts** — the ticket's most important line, and it generalizes:

- Claude Code encodes the cwd into its transcript directory name (`~/.claude/projects/<encoded>/`,
  `/`→`-`, lossy and never inverted). A remapped mount changes every encoded name, so every
  existing conversation becomes undiscoverable — silently, as "no history" rather than an error.
- The same applies to the agy and pi transcript stores (`conversations/agy.ts:41`,
  `conversations/pi.ts:49`) and to folder discovery (`discover/index.ts:38-40`, which scans
  `~/.claude/projects` and `~/.codex/sessions`).
- Absolute cwds are also persisted **in the database** — session rows, `webhook_issue_sessions`,
  cron job specs — so a relocated workspace mount and a relocated data volume can break each
  other.
- `-v /home/me/src:/home/me/src` is the documented form, with a warning that `-v
  /home/me/src:/workspace` will appear to work and lose all history.

---

## 6. Two deliberate posture changes that must be disclosed

**`HOST=0.0.0.0` in the image.** The config default is `127.0.0.1` (`config/index.ts:47`), which
inside a network namespace means *unreachable*, full stop. The image sets `0.0.0.0` and the
deliberate act moves to port publishing: the documented compose uses `-p 127.0.0.1:8787:8787`.
This is not a weakening — the container's namespace is the new boundary and the publish flag is
the new opt-in — but it inverts a default the README and CLAUDE.md both call out, so it gets
stated in both, and in the Confluence security page. A consequence to accept rather than paper
over: `isNetworkExposed` is now always true, so the boot warning at `server.ts:33-41` fires every
time. It stays. It is honest, and suppressing it would mean teaching the server to believe a
claim about its own reachability that it cannot verify — the same reasoning that keeps webhooks
from asserting their own external URL.

**`NODE_ENV=production` makes the auth cookie `Secure` by default** (`config/index.ts:~320`).
Over plain HTTP on a tailnet — the recommended posture — the browser discards the cookie and
login appears to fail with no error. The compose example sets `POCKETAGENT_COOKIE_SECURE=false`
with the same comment `.env.example` already carries, and the troubleshooting section gets an
entry, because this will otherwise be the single most common first-run failure.

---

## 7. tmux, adoption, and `/proc` — the documented limitations

The ticket asks for one paragraph; the code says there are three.

1. **The tmux backend buys nothing in a container.** Its value is outliving a *server* restart —
   which it still does, inside the container — but the tmux server dies with the container, so it
   does not survive the restart people actually mean. `direct` is the realistic backend, as the
   ticket says. It is not refused, just pointless unless you `docker exec`.
2. **Adoption needs the host socket and a matching uid.** `POCKETAGENT_ADOPT_TMUX_SOCKET` requires
   bind-mounting `/tmp/tmux-<uid>/<socket>` and a uid match. Documented as possible, not
   recommended.
3. **`POCKETAGENT_TMUX_SESSION_SCOPE_SLICE` is meaningless** — there is no per-user systemd
   manager to `systemd-run` into.
4. **Conversation liveness is PID-namespace-scoped.** `listRunningAgentCwds()` reads
   `/proc/*/cmdline` and `/proc/*/cwd` (`conversations/index.ts:518-543`), so it sees only
   processes inside the container. Agents the operator started on the host will not be reported as
   live. This sharpens existing Known Limitation #11 rather than adding a new failure, but it is
   not currently written down anywhere and would read as a bug.

---

## 8. Tags and what goes in them

One Dockerfile, three buildx targets, with pins in a single `docker/agent-versions.env` that both
the Dockerfile and PA-65's CI read — so a version bump is one file, not two.

- `:<semver>` / `:latest` — thin. Node, git, tmux, bash, the server.
- `:<semver>-claude` / `:latest-claude` — plus a pinned `claude` CLI.
- `:<semver>-all` / `:latest-all` — see the open question below.

**A PATH-precedence decision is forced here** and should be made deliberately: image-installed
CLIs live in `/usr/local/bin`; the mounted prefix (`$HOME/.npm-global/bin`, `$HOME/.local/bin`)
is on PATH too. My recommendation is **mounted prefix first**, so an operator's explicit
on-demand install (PA-68) overrides the image's pin rather than being shadowed by it — deliberate
user action beating an image default. It needs to be a stated rule either way, because
`resolveExecutable` searches PATH before the home dirs (`agents/registry.ts:174-177`), so getting
it wrong is invisible until someone wonders why their upgrade did nothing.

`-all` is the shakiest part of the ticket, and not because of CI cost. Each CLI has a different
install channel and only some are cleanly pinnable and redistributable: `pi` is an npm global;
`claude` has both an npm package and a native installer; `codex` ships standalone release tarballs
(musl-static, so it would work); `agy` is a Google-distributed glibc ELF I can find no npm package
for. Baking third-party CLIs into a published image is a **redistribution** decision with
licensing consequences, not just a build one. See open question 4.

---

## 9. Files

New:

- `docker/Dockerfile`, `docker/entrypoint.sh`, `docker/agent-versions.env`
- `docker/compose.yaml` (thin, documented volumes) and `docker/compose.claude.yaml`
- `docker/extend.example.Dockerfile` — the ticket's third acceptance criterion, as a real file
- `.dockerignore`
- `apps/server/scripts/docker-smoke.mjs` — the acceptance criteria, runnable

Changed:

- `apps/web/vite.config.ts` — version from env, git as fallback (§3)
- `package.json` — `docker:build`, `demo:docker`
- `README.md` — **rewrite `### On containers` (lines 262-269), which currently argues Docker is a
  poor fit and is directly contradicted by this ticket**; new "Running with Docker" section; the
  volume-contract table; adjust "Deploying to another machine" so Docker reads as primary and
  `git pull && pnpm build` as the dev path; Known Limitations entries for §7; `POCKETAGENT_WEB_DIST`
  and `POCKETAGENT_DATA_DIR` in the settings table; troubleshooting entries for the cookie-Secure
  and dubious-ownership failures
- `.env.example` — container notes on `HOST`, `POCKETAGENT_COOKIE_SECURE`, `POCKETAGENT_BACKEND`
- `CLAUDE.md` / `AGENTS.md` — deployment mechanism, and the direct-backend consequence
- Confluence, per the repo's sync rule: **Installation & Deployment** (primary — the whole
  container section), **Conventions & Environment** (env table), **Development Guide** (build and
  smoke commands), **Invariants & Security Model** (the `HOST=0.0.0.0` / port-publishing posture)

No server source changes, which is deliberate: if the image needs the server to behave differently,
that is a sign the layout is wrong.

---

## 10. Verification

The unit suite cannot cover any of this, exactly as the repo's "Live demos" section already argues
for xterm rendering and real tmux. So the acceptance criteria become
`apps/server/scripts/docker-smoke.mjs`, run as `pnpm demo:docker` against a throwaway data
directory and workspace:

1. Build the thin target; `docker run` with the documented volumes; `/health` answers; log in;
   **create a session using the `shell` agent** — which is always available, so the thin image is
   verifiable with no agent CLI installed — and run a command.
2. Write a file into the mounted repo from that session; assert `stat -c %u` equals the host uid
   (AC #2), and assert `git status` works inside the mount (the dubious-ownership check).
3. `docker restart`; assert the database, the session history and an installed agent survive
   (AC #1).
4. Build `docker/extend.example.Dockerfile` (`FROM pocketagent/server:latest` + one apt package)
   and assert it starts (AC #3).

Plus `pnpm lint`, `pnpm typecheck`, `pnpm test` — unaffected, since the only source change is
`vite.config.ts`.

---

## 11. Open decisions

I would like answers to 1, 4 and 5 before implementing; I will take my own recommendation on the
rest unless told otherwise.

1. **Land PA-62 first?** Recommend yes (§1). The alternative ships a volume path we would later
   have to break.
2. **`PUID`/`PGID` + `gosu` as the default**, with `--user` also supported? Recommend yes (§4).
3. **PATH precedence**: mounted agent prefix before the image's pinned CLIs? Recommend yes (§8).
4. **What is actually in `-all`**, and is baking third-party CLIs into a published image approved
   as a redistribution matter? Recommend: `-all` contains only CLIs with a pinnable, reproducible,
   redistributable channel; the README lists exactly which; anything else stays an on-demand
   install. This needs your call, not mine.
5. **Where do images go?** The ticket writes `pocketagent/server`, implying Docker Hub, but this
   is a self-hosted setup with a local Bamboo. Registry and namespace need naming now, because the
   docs and the extension example hardcode it. PA-65 depends on the same answer.
6. **A `:dev` image that bind-mounts the checkout?** Recommend no — the ticket says pick one
   mechanism, and `pnpm dev` is that mechanism.

---

Estimate: medium. The Dockerfile and entrypoint are small; the honest volume/UID/posture
documentation and the smoke script are the larger half, and the README section being *rewritten
against its own current argument* deserves care.

Reply "go ahead" or add the `agent-ready` label and I will implement it.
