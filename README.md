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
- [Deploying to another machine](#deploying-to-another-machine)
- [Two interfaces: native and terminal](#two-interfaces-native-and-terminal)
- [Picking up work you started elsewhere](#picking-up-work-you-started-elsewhere)
- [Scheduled jobs](#scheduled-jobs)
- [Process backends](#process-backends)
- [Accessing from another device](#accessing-from-another-device)
- [Using it](#using-it)
- [Copying a message](#copying-a-message)
- [Tidying the list](#tidying-the-list)
- [Layouts](#layouts)
- [Security model](#security-model)
- [How it works](#how-it-works)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)

---

## Requirements

- **Linux** (this is Linux-first; macOS likely works, Windows does not)
- **Node.js 22+**
- **pnpm 10+**
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
keep working until their cookies expire — to force everyone out, delete `data/pocketagent.db`
(this also clears session history) or `DELETE FROM auth_sessions;`.

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
| `POCKETAGENT_SESSION_TTL_HOURS` | `720` | How long a browser stays signed in. |
| `POCKETAGENT_COOKIE_SECURE` | auto | `Secure` cookie flag; defaults to on when `NODE_ENV=production`. |
| `POCKETAGENT_ALLOWED_ORIGINS` | same-origin | Comma-separated Origin allowlist. |
| `POCKETAGENT_TRUST_PROXY` | `false` | Trust `X-Forwarded-For` (only behind your own proxy). |
| `MAX_SESSIONS` | `10` | Concurrent live PTYs. |
| `OUTPUT_BUFFER_BYTES` | `2097152` | Per-session replay buffer. |
| `SESSION_IDLE_TIMEOUT` | `0` | Seconds idle **and** unattached before auto-kill. `0` disables. |
| `POCKETAGENT_BACKEND` | `direct` | `direct` or `tmux`. See [Process backends](#process-backends). |
| `POCKETAGENT_TMUX_BIN` | `tmux` | tmux executable. |
| `POCKETAGENT_TMUX_SOCKET` | `pocketagent` | Private tmux socket name. |
| `POCKETAGENT_SHELL` | `$SHELL` | Shell for the `shell` agent. |
| `POCKETAGENT_CLAUDE_BIN` | `claude` | Claude Code executable, resolved on `PATH`. |
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

---

## Deploying to another machine

**Build on the target.** Not because it is tidier, but because two dependencies leave you
no choice: `node-pty` publishes prebuilt binaries for macOS and Windows and *not* for
Linux, so it compiles from source on every Linux install, and `better-sqlite3` does the
same. Both artifacts are pinned to the architecture, C library and Node ABI they were
built against.

```bash
# Debian/Ubuntu. tmux is optional but see Process backends.
sudo apt install -y build-essential python3 git tmux
# Node 22+ — nvm, NodeSource, or your distribution's package
npm i -g pnpm@10

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
- **A fresh database.** Do not copy `data/pocketagent.db`. It records sessions that
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

### On containers

Docker is the usual answer to "package it" and a poor fit here. The point of PocketAgent is
to run agents against *your* filesystem with *your* CLI credentials, so a working container
ends up mounting the host filesystem, the agent's config directory and the CLI itself —
at which point the isolation it was bought for is gone, and tmux adoption and PTY handling
have new ways to break. Worth it only if you specifically want a pinned, repeatable build
toolchain.

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
| Authentication | Every route except `/health` requires a valid session cookie — including the WebSocket upgrade. |
| Token handling | The master token is exchanged once at login for a random 32-byte session id in an `HttpOnly; SameSite=Strict` cookie. The token never reaches JavaScript, localStorage, or the URL. Comparison is constant-time. |
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

Register it in `apps/server/src/agents/registry.ts`. It appears in the UI automatically,
greyed out if the executable is not on `PATH`. Nothing else in the codebase is
agent-specific.

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

**403 `forbidden_origin`.** The `Origin` header does not match. Behind a proxy, set
`POCKETAGENT_ALLOWED_ORIGINS=https://your.domain`.

**WebSocket never connects, page says Reconnecting forever.** Your proxy is not forwarding
the upgrade. See the nginx snippet above. Check `/health` still responds.

**"Claude Code executable not found."** `claude` is not on the `PATH` of the *server*
process. Systemd user services get a minimal environment — set an absolute path:
`POCKETAGENT_CLAUDE_BIN=/home/me/.local/bin/claude`.

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
7. **Linux-first.** macOS is untested; Windows is not supported.
8. **Push notifications need HTTPS**, and on iOS the site must be installed to the home
   screen before the browser will allow them at all. PocketAgent pushes for two events —
   a pending approval, and a structured agent finishing its turn (or, best-effort, a
   terminal session going quiet) — always to a fully detached client only; both also fire
   in-page whenever the tab is merely backgrounded, which needs no push service.
9. **Terminal output is never persisted.** Buffers are in-memory only, so a restart loses
   scrollback along with the session.
10. **Conversation liveness is directory-level.** Claude does not keep its transcript file
    open and its command line does not name the session, so PocketAgent can tell you an
    agent is running in that directory but not that it is running *that conversation*. It
    labels it accordingly rather than guessing.
11. **Attaching to your own tmux is a shared session, not a takeover.** Your prefix key is
    live from the browser, and the window follows whichever client attached most recently.
    A pane in a plain terminal (no tmux) cannot be attached to at all.
12. **One host.** The header, the composer's host row and `GET /api/hosts` are shaped for
    several machines, but a server only ever reports itself. Driving more than one needs a
    front server that registers backs and proxies to them; that does not exist yet, and it
    would concentrate credentials for every registered machine in one place, so it wants
    designing rather than bolting on.
13. **The home screen lists only directories with chats in them.** A configured workspace
    you have never used does not appear until you start something there; the composer's
    workspace row can still reach it.
14. **Conversation discovery is Claude-specific.** It reads Claude Code's on-disk transcript
    format. Other agents would each need their own reader; the rest of the session
    machinery is agent-agnostic.
15. **Per-run worktrees are never cleaned up.** A scheduled job set to branch per run leaves
    one tree per run under `<project>/.worktrees/`, so a nightly job accumulates roughly one
    a day. Deleting them afterwards is not an option — the run's work is what is in there —
    so pruning old branches stays a manual job.
16. **A scheduled job does not catch up after downtime.** Occurrences missed while the
    server was off are collapsed into a single `skipped` run once they are more than an hour
    stale, rather than firing a backlog at boot. Inside that hour the job still fires once,
    so an ordinary restart does not lose a run.
17. **Scheduled jobs cannot use the terminal transport.** They require an agent with a
    structured mode, because delivering a prompt to a TUI has no readiness signal and no
    reliable way to tell a finished turn from a hung one.
18. **A scheduled job runs with approvals bypassed by default.** It is unattended, so there
    is nobody to ask; the per-job switch can be turned off, in which case a run that needs
    an approval waits indefinitely for you instead of proceeding. See
    [Security model](#security-model).

---

## License

[MIT](LICENSE) © 2026 Stone Shi
