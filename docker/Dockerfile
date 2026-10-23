# PocketAgent backend image (PA-64).
#
# Build through `docker/build.sh`, never `docker build` directly: the agent CLI
# versions the `claude` and `all` targets pin live in `docker/agent-versions.env`
# so that one file is the single source of truth for this Dockerfile and for
# CI (PA-65). A direct build of those targets fails loudly rather than silently
# installing whatever is newest.
#
#   docker/build.sh              # thin
#   docker/build.sh claude
#   docker/build.sh all
#
# Three published targets, per the agreed tag strategy: agent CLIs release far
# faster than this app, so a per-agent tag matrix would be stale within days.
#
#   runtime  ->  :<semver>          :latest         no agent CLIs
#   claude   ->  :<semver>-claude   :latest-claude  + a pinned `claude`
#   all      ->  :<semver>-all      :latest-all     + every CLI with a pinnable,
#                                                     redistributable channel
#
# "Thin" means "no agent CLIs on PATH", NOT "small". The server's own
# dependency `@anthropic-ai/claude-agent-sdk-linux-x64` is ~291 MB on its own,
# so even the thin image lands near 1 GB. That package is also arch- and
# libc-specific (it has `…-linux-x64`, `…-linux-arm64` and musl siblings,
# selected as optionalDependencies at install time), which is why a multi-arch
# build has to be a genuine per-platform `pnpm install` under
# `buildx --platform` rather than one build plus `COPY --from`.

# Debian for deps/build/hub-runtime and Ubuntu 26.04 for server runtime (PA-79).
# `node-pty` and `better-sqlite3` compile against glibc and Alpine/musl is a known
# way to break the first of them — and separately, the agent CLIs this image is meant
# to run include dynamically-linked glibc ELF binaries (Google's `agy` is one),
# so a musl base would break them even when the server itself started fine.
ARG NODE_IMAGE=node:22-bookworm-slim
ARG SERVER_BASE_IMAGE=ubuntu:26.04
ARG DOCKER_CLI_IMAGE=docker:cli

# ---------------------------------------------------------------------------
# deps — the full dependency tree, with the toolchain the native modules need
# ---------------------------------------------------------------------------
# Separate from `build` so a source-only change does not re-run `pnpm install`.
FROM ${NODE_IMAGE} AS deps

# Corepack resolves the exact pnpm named in package.json's `packageManager`
# field, so the image cannot drift from what the repo is developed against.
# The prompt suppression is required because a build has no tty to answer it.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PNPM_HOME=/pnpm
ENV CI=true

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        python3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable pnpm

WORKDIR /app

# Manifests and pnpm patches only, so this layer is reused until a dependency actually changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/hub/package.json apps/hub/
COPY packages/protocol/package.json packages/protocol/
COPY packages/node-kit/package.json packages/node-kit/

# `allowBuilds` in pnpm-workspace.yaml is what permits node-pty,
# better-sqlite3 and esbuild to run their build scripts; without the toolchain
# above this install fails rather than falling back to a prebuild.
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build — protocol -> server -> web, in that order
# ---------------------------------------------------------------------------
FROM deps AS build

COPY . .

# `.dockerignore` excludes `.git`, so `apps/web/vite.config.ts` cannot derive
# the version stamp from `git rev-parse` here — it would silently report
# `unknown` in the UI. Passing it explicitly is also what makes the bundle's
# stamp and the server's own `/health` version (PA-61's
# POCKETAGENT_BUILD_VERSION) the same string rather than two unrelated ones.
ARG POCKETAGENT_BUILD_VERSION=0.0.0-dev
ENV POCKETAGENT_BUILD_VERSION=${POCKETAGENT_BUILD_VERSION}

RUN pnpm build

# ---------------------------------------------------------------------------
# prod-deps — the same tree with devDependencies pruned away
# ---------------------------------------------------------------------------
# Runs on the toolchain base rather than in the runtime stage on purpose: the
# prune reconfigures node_modules, which can re-link the native modules, and
# the runtime image deliberately has no compiler.
FROM deps AS prod-deps

RUN pnpm install --frozen-lockfile --prod

# ---------------------------------------------------------------------------
# runtime — the thin image
# ---------------------------------------------------------------------------
# Ubuntu 26.04 LTS (PA-79), glibc-based for node-pty, better-sqlite3, and agent
# binaries (agy, etc.). Node 22 and npm/corepack/pnpm are copied from the deps
# stage so the runtime receives the exact official Node toolchain without
# pulling compilers into the runtime image.
FROM ${SERVER_BASE_IMAGE} AS runtime

COPY --from=deps /usr/local /usr/local

# Every package here is required by something the server actually does:
#   ca-certificates  TLS to the agent APIs and MCP endpoints
#   git              git/status.ts, the whole worktree service
#   gosu             the UID/GID remap in docker-entrypoint.sh
#   less             sessions/env.ts sets LESS=-R, which assumes a pager exists
#   procps           `ps` inside `docker exec`, for looking at PTY children
#   tini             PID 1 reaping (see ENTRYPOINT below)
#   tmux             POCKETAGENT_BACKEND=tmux fails its boot probe without it
#   openssh-client   the operator's repos normally have ssh remotes
#   zsh              interactive shell support with Oh-My-Zsh (PA-79)
#   curl, wget       fetching scripts and assets
#   autojump         terminal productivity plugin for zsh
#   sudo             passwordless sudo for developer container ergonomics
#   locales          UTF-8 locale support for zsh prompt and plugins
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        autojump \
        ca-certificates \
        curl \
        git \
        gosu \
        less \
        locales \
        openssh-client \
        procps \
        sudo \
        tini \
        tmux \
        wget \
        zsh \
    && locale-gen en_US.UTF-8 \
    && rm -rf /var/lib/apt/lists/*

# The base image ships an `ubuntu` account already holding uid/gid 1000, which is
# the overwhelmingly common host uid and therefore the one this image's own
# user most needs to be able to take. Two accounts cannot share a uid without
# making passwd lookups ambiguous — and an ambiguous lookup is exactly what
# breaks `git`, which refuses a repository whose owner it cannot match. So the
# unused account is removed rather than worked around.
RUN userdel --remove ubuntu 2>/dev/null || true \
    && userdel --remove node 2>/dev/null || true \
    && groupadd --gid 1000 pocketagent \
    && useradd --uid 1000 --gid 1000 --shell /bin/zsh --create-home pocketagent \
    && echo "pocketagent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/pocketagent \
    && chmod 0440 /etc/sudoers.d/pocketagent

# Oh-My-Zsh and plugins (PA-79). Installed into /home/pocketagent and copied to
# /etc/skel so that when /home/pocketagent is mounted as a volume at run time,
# docker-entrypoint.sh can seed dotfiles into fresh mounts.
COPY docker/zsh-in-docker.sh /tmp/zsh-in-docker.sh
RUN chmod +x /tmp/zsh-in-docker.sh \
    && gosu pocketagent /tmp/zsh-in-docker.sh -x \
        -p "git" \
        -p "autojump" \
        -p https://github.com/zsh-users/zsh-autosuggestions \
        -p https://github.com/zsh-users/zsh-completions \
        -p https://github.com/zsh-users/zsh-history-substring-search \
        -p https://github.com/zsh-users/zsh-syntax-highlighting \
    && cp -r /home/pocketagent/.oh-my-zsh /etc/skel/.oh-my-zsh \
    && cp /home/pocketagent/.zshrc /etc/skel/.zshrc \
    && rm -rf /home/pocketagent/.oh-my-zsh/.git \
              /home/pocketagent/.oh-my-zsh/custom/*/*/.git \
              /etc/skel/.oh-my-zsh/.git \
              /etc/skel/.oh-my-zsh/custom/*/*/.git \
              /tmp/zsh-in-docker.sh

ENV NODE_ENV=production \
    HOME=/home/pocketagent \
    PORT=8787 \
    POCKETAGENT_DATA_DIR=/data \
    POCKETAGENT_WEB_DIST=/app/apps/web/dist \
    NPM_CONFIG_PREFIX=/home/pocketagent/.npm-global \
    SHELL=/bin/zsh \
    POCKETAGENT_SHELL=/bin/zsh \
    LANG=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    LC_ALL=en_US.UTF-8

# PA-104: the same order `agents/registry.ts`'s `executableSearchDirs` uses —
# the agents' *official* install locations first (all inside the mounted
# $HOME, so an agent installed or self-updated at run time survives a
# restart and outranks the copy this image baked in), then the system PATH
# (where the `claude`/`all` targets link their build-time installs, in
# /usr/local/bin), then ~/.cargo/bin, and the npm install prefix *last*. It
# used to be first, and on a bare-metal host the same rule in the resolver is
# what made the server run a leftover Settings copy while a human's shell ran
# the official one. `agent-install.test.ts` fails if this line, the two
# login-shell snippets below and the resolver disagree.
ENV PATH=/home/pocketagent/.opencode/bin:/home/pocketagent/.local/bin:/home/pocketagent/.pi/agent/bin:$PATH:/home/pocketagent/.cargo/bin:/home/pocketagent/.npm-global/bin

# `HOST` defaults to 127.0.0.1 in config/index.ts, which inside a network
# namespace means "unreachable" rather than "safe". Binding the container's own
# interface is therefore the only workable default, and the deliberate act the
# loopback default exists to force moves to publishing the port — the
# documented compose file uses `-p 127.0.0.1:8787:8787`. A consequence worth
# knowing rather than suppressing: `isNetworkExposed` is now always true, so
# the boot warning about non-loopback binds fires on every start.
ENV HOST=0.0.0.0

# A login shell is not a detail here: planner/tools.ts runs `exec_command` as
# `$SHELL -lc`. /etc/profile *overwrites* PATH unconditionally on login shells,
# dropping everything set above. /etc/profile.d is sourced afterwards for bash,
# and /etc/zsh/zshenv is read for all zsh invocations. This is what keeps a
# tool call and the server itself agreeing about where agent binaries live.
# Verified by docker-smoke.mjs rather than assumed.
RUN printf '%s\n' \
    '# PocketAgent: re-apply the agent directories that /etc/profile just discarded.' \
    'PATH="$HOME/.opencode/bin:$HOME/.local/bin:$HOME/.pi/agent/bin:$PATH:$HOME/.cargo/bin:$HOME/.npm-global/bin"' \
    'export PATH' \
    > /etc/profile.d/10-pocketagent-path.sh \
    && chmod 0644 /etc/profile.d/10-pocketagent-path.sh \
    && mkdir -p /etc/zsh \
    && printf '%s\n' \
    '# PocketAgent: ensure the agent directories are in PATH for all zsh invocations.' \
    'PATH="$HOME/.opencode/bin:$HOME/.local/bin:$HOME/.pi/agent/bin:$PATH:$HOME/.cargo/bin:$HOME/.npm-global/bin"' \
    'export PATH' \
    >> /etc/zsh/zshenv \
    && chmod 0644 /etc/zsh/zshenv

# Created in the image, owned by the image's user, so that an *empty named
# volume* mounted here inherits that ownership from Docker. A bind mount does
# not inherit anything — the host directory keeps its own owner, which is why
# the entrypoint checks writability and says so instead of chowning.
RUN install -d -o pocketagent -g pocketagent -m 0755 /data

WORKDIR /app

# The repo layout is preserved deliberately. config/index.ts derives REPO_ROOT
# as `resolve(dirname(import.meta.url), '../../../..')`, so `dist/config/` must
# sit four levels below the root for REPO_ROOT to be /app. Flattening the tree
# (as `pnpm deploy` does) silently re-points REPO_ROOT at `/`, taking .env
# loading, the webDist default and the data-dir default with it.
COPY --from=prod-deps --chown=root:root /app/node_modules ./node_modules
COPY --from=prod-deps --chown=root:root /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=prod-deps --chown=root:root /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=prod-deps --chown=root:root /app/packages/protocol/node_modules ./packages/protocol/node_modules
# PA-66: `@pocketagent/node-kit` is a workspace dependency of the server, so
# omitting it here is not a smaller image, it is a server that cannot resolve
# `crypto/secret-box` at boot.
COPY --from=prod-deps --chown=root:root /app/packages/node-kit/node_modules ./packages/node-kit/node_modules

COPY --from=build --chown=root:root /app/package.json ./package.json
COPY --from=build --chown=root:root /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=root:root /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build --chown=root:root /app/packages/node-kit/package.json ./packages/node-kit/package.json
COPY --from=build --chown=root:root /app/apps/web/package.json ./apps/web/package.json

COPY --from=build --chown=root:root /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build --chown=root:root /app/packages/node-kit/dist ./packages/node-kit/dist
COPY --from=build --chown=root:root /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=root:root /app/apps/web/dist ./apps/web/dist

COPY --chown=root:root docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

# PA-61 reads this for /health and HostInfo.version; the same value went into
# the web bundle in the build stage.
ARG POCKETAGENT_BUILD_VERSION=0.0.0-dev
ENV POCKETAGENT_BUILD_VERSION=${POCKETAGENT_BUILD_VERSION}

EXPOSE 8787

# /health is public (it is in PUBLIC_API_PATHS), so this needs no credential.
# Node's own fetch rather than curl, which the slim base does not ship.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

# tini, because this process is PID 1 and its entire job is spawning PTYs,
# agent CLIs and `bash -lc`. Node reaps what it spawns itself but not
# re-parented orphans, and server.ts's SIGTERM handler only helps if something
# forwards the signal. Note `app.close()` has no force-exit timer, so
# `docker stop --time 30` is the documented stop: the session shutdown loop can
# legitimately spend several seconds terminating PTYs.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "apps/server/dist/server.js"]

# ---------------------------------------------------------------------------
# claude — the thin image plus one pinned CLI
# ---------------------------------------------------------------------------
# Docker's own CLI image is the source of the static `docker` client and the
# buildx plugin, rather than Docker's apt repo: that repo is keyed by Ubuntu
# codename and 26.04 may not be published there, and a static copy needs no
# gpg key fetch at build time.
FROM ${DOCKER_CLI_IMAGE} AS docker-cli

FROM runtime AS claude

# Operator/agent tooling for the `claude` and `all` images only — the thin
# runtime stays lean (and the Hub image never sees any of it). `all` inherits
# this layer because it is built FROM claude. Kept before the agent installs
# so a package change does not invalidate the (slow) installer layers' inputs
# any more than adding a layer here must.
#   build-essential, python3   agents compiling native deps (npm/pip installs)
#   sqlite3                    exploring pocketagent.db from `docker exec`
#   iproute2                   `ip`, `ss`
#   net-tools                  `netstat`, `ifconfig`
#   iputils-ping, traceroute   reachability from inside the container
#   dnsutils                   `dig`, `nslookup`
#   netcat-openbsd             `nc` port checks
#   vim                        editing files from `docker exec`
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        dnsutils \
        iproute2 \
        iputils-ping \
        net-tools \
        netcat-openbsd \
        python3 \
        sqlite3 \
        traceroute \
        vim \
    && rm -rf /var/lib/apt/lists/*

# Docker *client* only (`docker build`, `docker buildx`). It has no daemon: it
# works only when DOCKER_HOST or a mounted /var/run/docker.sock points at one.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx

# PA-104: agent CLIs are installed with each vendor's *official* installer —
# the same one Settings uses (`apps/server/src/agents/catalog.ts`) and the one
# a human runs by hand — so a baked-in agent has the official layout and
# `claude update` / `codex`'s installer / `agy update` update it the way they
# update any other install. npm is no longer involved.
#
# The official locations are all under $HOME, and $HOME is a *mount point* at
# run time: anything installed there now would be hidden by the volume on the
# first `docker run`, which is exactly how the npm version of this stage
# shipped broken once. So each installer runs with a build-time HOME of
# /opt/pocketagent-agents — every one of them installs relative to $HOME —
# and its launcher is linked into /usr/local/bin, which is on PATH and not
# under any mount. The tree stays in the official layout (under a different
# home), which is what `isOfficialInstallPath` recognises.
#
# At run time an update writes into the *real* $HOME (claude and codex install
# relative to it), whose official directories precede /usr/local/bin for both
# the server and a login shell, so both switch to the updated copy together.
# pi updates its managed install in place, so the tree is owned by the app
# user and the entrypoint re-chowns it on a PUID remap (it is an image path,
# never a mount).
#
# Every command here that runs an agent — the `--version` checks included —
# runs with the build-time HOME, and each stage ends by *failing the build* if
# anything under /home/pocketagent is not owned by the app user. That check
# exists because it shipped broken (PA-104, test01): `opencode --version` and
# `codex --version` run as root with the image's HOME wrote root-owned
# ~/.local, ~/.config, ~/.codex and ~/.cache into /home/pocketagent, Docker
# copies an image directory into an *empty named volume* on first mount, and
# the app user then could not create ~/.local/bin — so `claude update` from
# Settings failed on a perfectly fresh deployment.
#
# Each installer is downloaded to a file and run as `<interpreter> <file>`,
# never piped — the same shape as the server's own runner — and each block
# ends with checks that fail the build: `test -x` on the link, the resolved
# target inside the official layout, and the pinned version where there is
# one. `claude --version` alone passes whatever directory the binary landed
# in, which is how the npm stage shipped broken the first time.
#
# Every download uses `curl --compressed`. Google's front end for
# antigravity.google sometimes answers with `Content-Encoding: gzip` although
# no Accept-Encoding was sent (about one request in three, observed
# 2026-10-08), and plain curl then writes the gzip bytes to disk: `bash` fails
# with "cannot execute binary file" and the `all` target breaks at random
# (PA-PD-75). `--compressed` asks for compression and decodes whatever comes
# back, so the file is the script either way. The server's own installer
# (`agents/install.ts`) fetches with Node's `fetch`, which already decodes.
ENV AGENT_IMAGE_HOME=/opt/pocketagent-agents
ARG CLAUDE_CODE_VERSION
RUN test -n "${CLAUDE_CODE_VERSION}" \
    || { echo "CLAUDE_CODE_VERSION is unset. Build via docker/build.sh, which reads docker/agent-versions.env." >&2; exit 1; } \
    && install -d -m 0755 "$AGENT_IMAGE_HOME" \
    && curl -fsSL --compressed https://claude.ai/install.sh -o /tmp/claude-install.sh \
    && env -u NPM_CONFIG_PREFIX HOME="$AGENT_IMAGE_HOME" \
        bash /tmp/claude-install.sh "${CLAUDE_CODE_VERSION}" \
    && rm -f /tmp/claude-install.sh \
    && ln -sf "$AGENT_IMAGE_HOME/.local/bin/claude" /usr/local/bin/claude \
    && test -x /usr/local/bin/claude \
    && readlink -f /usr/local/bin/claude | grep -q "^$AGENT_IMAGE_HOME/.local/share/claude/versions/" \
    && HOME="$AGENT_IMAGE_HOME" /usr/local/bin/claude --version | grep -qF "${CLAUDE_CODE_VERSION}" \
    && rm -rf "$AGENT_IMAGE_HOME/.claude/downloads" \
    && chown -R pocketagent:pocketagent "$AGENT_IMAGE_HOME" \
    && { test -z "$(find /home/pocketagent ! -user pocketagent -print -quit)" \
         || { echo "root-owned files leaked into /home/pocketagent:" >&2; find /home/pocketagent ! -user pocketagent >&2; exit 1; }; }

# ---------------------------------------------------------------------------
# all — every agent CLI with an official installer
# ---------------------------------------------------------------------------
# Pinned where the official installer accepts a version (codex's `--release`,
# opencode's `--version`); `agy` and `pi` are installed from their current
# release because their installers cannot take one (see
# docker/agent-versions.env). `agy` was absent from this target before PA-104
# because it has no npm package; it has an official installer, which is now
# the only channel this image uses.
FROM claude AS all

ARG CODEX_VERSION
ARG OPENCODE_VERSION
RUN test -n "${CODEX_VERSION}" && test -n "${OPENCODE_VERSION}" \
    || { echo "Agent versions are unset. Build via docker/build.sh, which reads docker/agent-versions.env." >&2; exit 1; } \
    && A="$AGENT_IMAGE_HOME" \
    && curl -fsSL --compressed https://chatgpt.com/codex/install.sh -o /tmp/codex-install.sh \
    && env -u NPM_CONFIG_PREFIX HOME="$A" CODEX_NON_INTERACTIVE=1 sh /tmp/codex-install.sh --release "${CODEX_VERSION}" \
    && curl -fsSL --compressed https://opencode.ai/v2/install -o /tmp/opencode-install.sh \
    && env -u NPM_CONFIG_PREFIX HOME="$A" bash /tmp/opencode-install.sh --version "${OPENCODE_VERSION}" --no-modify-path \
    && curl -fsSL --compressed https://antigravity.google/cli/install.sh -o /tmp/agy-install.sh \
    && env -u NPM_CONFIG_PREFIX HOME="$A" bash /tmp/agy-install.sh \
    && curl -fsSL --compressed https://pi.dev/install.sh -o /tmp/pi-install.sh \
    && env -u NPM_CONFIG_PREFIX HOME="$A" sh /tmp/pi-install.sh \
    && rm -f /tmp/codex-install.sh /tmp/opencode-install.sh /tmp/agy-install.sh /tmp/pi-install.sh \
    && ln -sf "$A/.local/bin/codex" /usr/local/bin/codex \
    && ln -sf "$A/.opencode/bin/opencode" /usr/local/bin/opencode \
    && ln -sf "$A/.local/bin/agy" /usr/local/bin/agy \
    && ln -sf "$A/.pi/agent/bin/pi" /usr/local/bin/pi \
    && for bin in codex opencode agy pi; do test -x "/usr/local/bin/$bin" || { echo "$bin was not installed" >&2; exit 1; }; done \
    && readlink -f /usr/local/bin/codex | grep -q "^$A/.codex/packages/standalone/" \
    && readlink -f /usr/local/bin/opencode | grep -q "^$A/.opencode/bin/opencode$" \
    && readlink -f /usr/local/bin/agy | grep -q "^$A/.local/bin/agy$" \
    && readlink -f /usr/local/bin/pi | grep -q "^$A/.pi/agent/" \
    && HOME="$A" /usr/local/bin/codex --version | grep -qF "${CODEX_VERSION}" \
    && HOME="$A" /usr/local/bin/opencode --version | grep -qF "${OPENCODE_VERSION}" \
    && HOME="$A" /usr/local/bin/agy --version \
    && HOME="$A" /usr/local/bin/pi --version \
    && rm -rf "$A/.cache" "$A/.pi/agent/install/staging" /root/.npm \
    && chown -R pocketagent:pocketagent "$A" \
    && { test -z "$(find /home/pocketagent ! -user pocketagent -print -quit)" \
         || { echo "root-owned files leaked into /home/pocketagent:" >&2; find /home/pocketagent ! -user pocketagent >&2; exit 1; }; }

# A headless browser agents drive from the shell: Microsoft's `playwright-cli`
# (`@playwright/cli`) plus the Chromium build *its own bundled* playwright-core
# expects. Without one, an agent asked for an HTML page could not look at what
# it made; prod chat a95c510b spent 16 tool rounds on geometry maths and a
# fake-DOM harness instead. About 700 MB (Chromium ~400, its apt libraries and
# fonts ~300), which is why it is here and not in `runtime` or `claude`.
# Four things were found by running it and are load-bearing:
#   - The browser comes from the CLI's bundled playwright-core, in the same
#     layer: each Playwright release expects one browser revision, and the
#     CLI bundles its own (an alpha at 0.1.22), so the repo's playwright
#     devDependency would install the wrong one.
#   - Full Chromium (`--no-shell`): the CLI refuses the headless shell, and
#     without PLAYWRIGHT_MCP_BROWSER it looks for Google Chrome in /opt/google.
#   - file:// is blocked by default. Lifting it grants nothing, since every
#     caller of this CLI already has a shell as the same user.
#   - Outside $HOME (PLAYWRIGHT_BROWSERS_PATH), like every other baked-in
#     tool here, or the home volume hides it on first run.
#   - NO_UPDATE_NOTIFIER: otherwise every run asks the npm registry for a newer
#     CLI and caches the answer in ~/.cache/ms-playwright. The first cut of
#     this layer ran `--version` as root with the image's HOME and left that
#     file root-owned in /home/pocketagent (the check below caught it), and a
#     pinned image has no use for an "update available" line an agent might
#     act on anyway.
# The build renders a page as the app user at the end, because a browser that
# installs fine and cannot launch is the failure a `--version` check misses.
ARG PLAYWRIGHT_CLI_VERSION
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    PLAYWRIGHT_MCP_BROWSER=chromium \
    PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS=true \
    NO_UPDATE_NOTIFIER=1
RUN test -n "${PLAYWRIGHT_CLI_VERSION}" \
    || { echo "PLAYWRIGHT_CLI_VERSION is unset. Build via docker/build.sh, which reads docker/agent-versions.env." >&2; exit 1; } \
    && env -u NPM_CONFIG_PREFIX HOME=/root npm install --global --prefix /usr/local --no-audit --no-fund \
        "@playwright/cli@${PLAYWRIGHT_CLI_VERSION}" \
    && PWCORE=/usr/local/lib/node_modules/@playwright/cli/node_modules/playwright-core \
    && test -f "$PWCORE/cli.js" \
    && HOME=/root node "$PWCORE/cli.js" install --with-deps --no-shell chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache \
    && chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH" \
    && test -x /usr/local/bin/playwright-cli \
    && HOME=/root playwright-cli --version | grep -qF "${PLAYWRIGHT_CLI_VERSION}" \
    && probe="$(mktemp -d)" && chmod 0777 "$probe" \
    && printf '<title>pa-probe</title><svg width="40" height="40"><circle cx="20" cy="20" r="18"/></svg>' > "$probe/p.html" \
    && cd "$probe" \
    && gosu pocketagent env HOME="$probe" playwright-cli open "file://$probe/p.html" | grep -qF 'pa-probe' \
    && gosu pocketagent env HOME="$probe" playwright-cli screenshot --filename=p.png >/dev/null \
    && gosu pocketagent env HOME="$probe" playwright-cli close >/dev/null \
    && test -s "$probe/p.png" \
    && cd / && rm -rf "$probe" \
    && { test -z "$(find /home/pocketagent ! -user pocketagent -print -quit)" \
         || { echo "root-owned files leaked into /home/pocketagent:" >&2; find /home/pocketagent ! -user pocketagent >&2; exit 1; }; }

# PA-140: Headless LibreOffice Calc (`soffice`) for `sheet_check` and
# `sheet_edit` formula recalculation, plus `python3-openpyxl` for creating
# brand-new `.xlsx` workbooks from scratch. Installed only in `all` (~250 MB
# with `--no-install-recommends`); `runtime` and `claude` stay lean and
# `sheet_check`/`sheet_edit` degrade gracefully when `soffice` is absent.
# `poppler-utils` (`pdftotext`, a few MB) is the shell's PDF text extractor:
# libreoffice-calc has no PDF import filter, and outside a document workspace
# `read_file` refuses a PDF as binary, so without it an agent had no way to a
# PDF's text at all (prod chat b5defce8). The base prompt names it only when
# it resolves on PATH.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libreoffice-calc \
        poppler-utils \
        python3-openpyxl \
    && rm -rf /var/lib/apt/lists/* \
    && lo_probe="$(mktemp -d)" && chmod 0777 "$lo_probe" \
    && gosu pocketagent env HOME="$lo_probe" soffice "-env:UserInstallation=file://$lo_probe/profile" --headless --version | grep -qi "libreoffice" \
    && gosu pocketagent env HOME="$lo_probe" python3 -c "import openpyxl; wb = openpyxl.Workbook(); assert wb.active is not None" \
    && gosu pocketagent env HOME="$lo_probe" pdftotext -v 2>&1 | grep -qi "pdftotext" \
    && rm -rf "$lo_probe" \
    && { test -z "$(find /home/pocketagent ! -user pocketagent -print -quit)" \
         || { echo "root-owned files leaked into /home/pocketagent:" >&2; find /home/pocketagent ! -user pocketagent >&2; exit 1; }; }

# ---------------------------------------------------------------------------
# hub-deps — production dependencies for the Hub alone
# ---------------------------------------------------------------------------
# Not `prod-deps`, and — the part that is easy to get wrong — **not `FROM deps`
# either**. `prod-deps` holds the whole workspace's store: the Claude Agent SDK
# alone is 291 MB and node-pty another 60, none of which a gateway has a code
# path for. But layering a filtered install on top of `deps` does not help,
# because `pnpm install --filter` does not garbage-collect packages an earlier
# install already materialised in `node_modules/.pnpm` — measured, not assumed:
# the image stayed at 796 MB until this stage started from a clean base.
#
# So: clean base, all manifests (the lockfile describes every workspace project
# and `--frozen-lockfile` wants them present), and one filtered install.
# `@pocketagent/hub...` resolves the Hub plus its workspace dependencies —
# protocol and node-kit — and nothing else.
#
# On the toolchain base rather than the runtime one for the same reason
# `prod-deps` is: better-sqlite3 is a native module, and the runtime image
# deliberately has no compiler.
FROM ${NODE_IMAGE} AS hub-deps

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PNPM_HOME=/pnpm
ENV CI=true

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        python3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable pnpm

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/hub/package.json apps/hub/
COPY packages/protocol/package.json packages/protocol/
COPY packages/node-kit/package.json packages/node-kit/

RUN pnpm install --frozen-lockfile --prod --filter '@pocketagent/hub...'

# `node-kit` has no runtime dependencies — it only uses `node:crypto` — so a
# --prod install creates no directory for it and the COPY below would fail on
# a missing path. Materialising an empty one keeps that COPY unconditional, so
# the day node-kit gains a real dependency it is already carried rather than
# silently absent at runtime.
RUN mkdir -p packages/node-kit/node_modules

# ---------------------------------------------------------------------------
# hub-runtime — the gateway image (PA-66)
# ---------------------------------------------------------------------------
# A separate image rather than a second entrypoint on the backend one, because
# the two have almost disjoint needs: the Hub forwards bytes and has no agent
# CLI, no PTY, no tmux, no git and no workspace mount. It is emphatically
# *not* a static nginx image either — the Hub has state (the registry and the
# encrypted credentials), which is what the data volume below is for.
#
# It does ship `apps/web/dist`: behind a Hub, the Hub is the single origin the
# browser talks to, so it serves the same bundle the backend would have.
FROM ${NODE_IMAGE} AS hub-runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        tini \
    && rm -rf /var/lib/apt/lists/*

# Same uid/gid convention as the backend image, so an operator who has already
# matched PUID/PGID for their repositories does not meet a second scheme. The
# Hub touches no bind mount of the operator's, so there is no entrypoint
# remapping here — only its own data volume, which it may own outright.
RUN userdel -r node 2>/dev/null || true \
    && groupadd -g 1000 pocketagent \
    && useradd -u 1000 -g 1000 -m -s /bin/bash pocketagent

ENV NODE_ENV=production \
    HOME=/home/pocketagent \
    POCKETAGENT_HUB_PORT=8788 \
    POCKETAGENT_HUB_DATA_DIR=/data \
    POCKETAGENT_WEB_DIST=/app/apps/web/dist

# Loopback inside a namespace means unreachable, so the deliberate act moves
# to publishing the port — the same trade the backend image documents. It
# matters more here: this process can reach every bound backend.
ENV POCKETAGENT_HUB_HOST=0.0.0.0

WORKDIR /app

# The repo layout is preserved for the same reason the backend image preserves
# it, with one fewer level: `apps/hub/dist/config.js` resolves the repo root as
# `../../..`, so `dist/` must sit three levels below /app. Keeping the shape
# identical between the two images means there is one layout rule to remember
# rather than two, and `pnpm deploy`'s flattening would break this one too.
COPY --from=hub-deps --chown=root:root /app/node_modules ./node_modules
COPY --from=hub-deps --chown=root:root /app/apps/hub/node_modules ./apps/hub/node_modules
COPY --from=hub-deps --chown=root:root /app/packages/protocol/node_modules ./packages/protocol/node_modules
COPY --from=hub-deps --chown=root:root /app/packages/node-kit/node_modules ./packages/node-kit/node_modules

COPY --from=build --chown=root:root /app/package.json ./package.json
COPY --from=build --chown=root:root /app/apps/hub/package.json ./apps/hub/package.json
COPY --from=build --chown=root:root /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build --chown=root:root /app/packages/node-kit/package.json ./packages/node-kit/package.json
COPY --from=build --chown=root:root /app/apps/web/package.json ./apps/web/package.json

COPY --from=build --chown=root:root /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build --chown=root:root /app/packages/node-kit/dist ./packages/node-kit/dist
COPY --from=build --chown=root:root /app/apps/hub/dist ./apps/hub/dist
COPY --from=build --chown=root:root /app/apps/web/dist ./apps/web/dist

# Part of the image, so it is chowned here rather than at run time — the
# backend entrypoint's "never chown a mounted volume" rule applies to a
# *bind* mount whose owner the operator chose. This is a named volume the Hub
# owns outright, and it holds nothing but the registry.
RUN install -d -o pocketagent -g pocketagent /data

ARG POCKETAGENT_BUILD_VERSION=0.0.0-dev
ENV POCKETAGENT_BUILD_VERSION=${POCKETAGENT_BUILD_VERSION}

USER pocketagent

EXPOSE 8788

# The Hub's own /health is public for the same reason the backend's is, and
# carries the same four keys.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.POCKETAGENT_HUB_PORT||8788)+'/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

# tini for the same PID-1 signal-forwarding reason, though the Hub spawns
# nothing: it costs a few kilobytes and means `docker stop` is prompt.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/hub/dist/server.js"]
