# syntax=docker/dockerfile:1.7
#
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

# Debian, deliberately, and for two independent reasons. `node-pty` and
# `better-sqlite3` compile against glibc and Alpine/musl is a known way to
# break the first of them — and separately, the agent CLIs this image is meant
# to run include dynamically-linked glibc ELF binaries (Google's `agy` is one),
# so a musl base would break them even when the server itself started fine.
ARG NODE_IMAGE=node:22-bookworm-slim

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

# Manifests only, so this layer is reused until a dependency actually changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
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
FROM ${NODE_IMAGE} AS runtime

# Every package here is required by something the server actually does:
#   ca-certificates  TLS to the agent APIs and MCP endpoints
#   git              git/status.ts, the whole worktree service
#   openssh-client   the operator's repos normally have ssh remotes
#   tmux             POCKETAGENT_BACKEND=tmux fails its boot probe without it
#   tini             PID 1 reaping (see ENTRYPOINT below)
#   gosu             the UID/GID remap in docker-entrypoint.sh
#   less             sessions/env.ts sets LESS=-R, which assumes a pager exists
#   procps           `ps` inside `docker exec`, for looking at PTY children
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        gosu \
        less \
        openssh-client \
        procps \
        tini \
        tmux \
    && rm -rf /var/lib/apt/lists/*

# The base image ships a `node` account already holding uid/gid 1000, which is
# the overwhelmingly common host uid and therefore the one this image's own
# user most needs to be able to take. Two accounts cannot share a uid without
# making passwd lookups ambiguous — and an ambiguous lookup is exactly what
# breaks `git`, which refuses a repository whose owner it cannot match. So the
# unused account is removed rather than worked around.
RUN userdel --remove node \
    && groupadd --gid 1000 pocketagent \
    && useradd --uid 1000 --gid 1000 --shell /bin/bash --create-home pocketagent

ENV NODE_ENV=production \
    HOME=/home/pocketagent \
    PORT=8787 \
    POCKETAGENT_DATA_DIR=/data \
    POCKETAGENT_WEB_DIST=/app/apps/web/dist \
    NPM_CONFIG_PREFIX=/home/pocketagent/.npm-global

# The mounted agent prefix comes *before* /usr/local/bin, so an agent the
# operator installs on demand (PA-68) overrides the one this image pinned
# rather than being silently shadowed by it. `agents/registry.ts` searches PATH
# before it falls back to these same three directories, so without the
# ordering being stated somewhere an upgrade appears to do nothing.
ENV PATH=/home/pocketagent/.npm-global/bin:/home/pocketagent/.local/bin:/home/pocketagent/.cargo/bin:$PATH

# `HOST` defaults to 127.0.0.1 in config/index.ts, which inside a network
# namespace means "unreachable" rather than "safe". Binding the container's own
# interface is therefore the only workable default, and the deliberate act the
# loopback default exists to force moves to publishing the port — the
# documented compose file uses `-p 127.0.0.1:8787:8787`. A consequence worth
# knowing rather than suppressing: `isNetworkExposed` is now always true, so
# the boot warning about non-loopback binds fires on every start.
ENV HOST=0.0.0.0

# A login shell is not a detail here: planner/tools.ts runs `exec_command` as
# `$SHELL -lc`, and Debian's /etc/profile *overwrites* PATH unconditionally,
# dropping everything set above. /etc/profile.d is sourced afterwards, so this
# is what keeps a tool call and the server itself agreeing about where agent
# binaries live. Verified by docker-smoke.mjs rather than assumed.
RUN printf '%s\n' \
    '# PocketAgent: re-apply the agent prefix that /etc/profile just discarded.' \
    'PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"' \
    'export PATH' \
    > /etc/profile.d/10-pocketagent-path.sh \
    && chmod 0644 /etc/profile.d/10-pocketagent-path.sh

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
FROM runtime AS claude

# Installed into /usr/local, NOT the default prefix. NPM_CONFIG_PREFIX above
# points at $HOME/.npm-global, which is a *mount point* at run time — a CLI
# installed there is hidden by the volume on the first `docker run`, which
# would silently defeat the entire purpose of this tag.
#
# Getting that right takes both halves. `env -u` is required because npm reads
# its environment config case-insensitively, so the inherited
# NPM_CONFIG_PREFIX and a lowercase `npm_config_prefix=...` prefixed to the
# command are the *same* setting — and the inherited one wins. `--prefix` is
# belt and braces (a CLI flag outranks env). The `test -x` afterwards is the
# part that actually keeps this fixed: `claude --version` alone passes whether
# the binary landed in /usr/local/bin or in the doomed directory, which is how
# this shipped broken the first time.
ARG CLAUDE_CODE_VERSION
RUN test -n "${CLAUDE_CODE_VERSION}" \
    || { echo "CLAUDE_CODE_VERSION is unset. Build via docker/build.sh, which reads docker/agent-versions.env." >&2; exit 1; } \
    && env -u NPM_CONFIG_PREFIX npm install -g --prefix /usr/local --no-fund --no-audit \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force \
    && test -x /usr/local/bin/claude \
    && /usr/local/bin/claude --version

# ---------------------------------------------------------------------------
# all — every agent CLI with a pinnable, redistributable install channel
# ---------------------------------------------------------------------------
# `agy` (Google's Antigravity CLI) is deliberately absent, and this is the
# reason rather than an oversight: it is distributed as a Google-published
# binary with no npm package. The names that look plausible on the registry
# (`agy`, `antigravity-cli`) are unrelated 0.0.x placeholders, so pinning one
# would be a supply-chain hazard dressed up as completeness. An operator who
# wants `agy` installs it into the mounted agent prefix, which is what that
# prefix is for. README's Docker section lists what each tag contains.
FROM claude AS all

ARG CODEX_VERSION
ARG OPENCODE_VERSION
ARG PI_VERSION
RUN test -n "${CODEX_VERSION}" && test -n "${OPENCODE_VERSION}" && test -n "${PI_VERSION}" \
    || { echo "Agent versions are unset. Build via docker/build.sh, which reads docker/agent-versions.env." >&2; exit 1; } \
    && env -u NPM_CONFIG_PREFIX npm install -g --prefix /usr/local --no-fund --no-audit \
        "@openai/codex@${CODEX_VERSION}" \
        "opencode-ai@${OPENCODE_VERSION}" \
        "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && npm cache clean --force \
    && test -x /usr/local/bin/codex \
    && test -x /usr/local/bin/opencode \
    && test -x /usr/local/bin/pi \
    && /usr/local/bin/codex --version \
    && /usr/local/bin/opencode --version \
    && /usr/local/bin/pi --version

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
