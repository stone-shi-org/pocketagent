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
COPY packages/protocol/package.json packages/protocol/

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

COPY --from=build --chown=root:root /app/package.json ./package.json
COPY --from=build --chown=root:root /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=root:root /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build --chown=root:root /app/apps/web/package.json ./apps/web/package.json

COPY --from=build --chown=root:root /app/packages/protocol/dist ./packages/protocol/dist
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
