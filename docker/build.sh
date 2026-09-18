#!/usr/bin/env bash
# Build a PocketAgent backend image (PA-64).
#
#   docker/build.sh                 # thin      -> :<version>, :latest
#   docker/build.sh claude          # + claude  -> :<version>-claude, :latest-claude
#   docker/build.sh all             # + all     -> :<version>-all, :latest-all
#
# This is the documented entry point rather than `docker build` because it is
# what reads docker/agent-versions.env, so the pins live in exactly one file.
# It also stamps the version into both halves of the image at once: PA-61's
# POCKETAGENT_BUILD_VERSION for /health and HostInfo, and the same string into
# the web bundle, which cannot derive it from git inside a build context that
# (correctly) excludes .git.
#
# Environment:
#   PA_IMAGE      image name          (default registry.shifamily.com/homestack/pocketagent-server)
#   PA_VERSION    semver to stamp     (default: apps/server/package.json version + git sha)
#   PA_PLATFORM   buildx --platform   (default: the host's own architecture)
#   PA_PUSH=1     push instead of loading into the local daemon
#   PA_TAGS       tag names to apply  (default: "<version><suffix> latest<suffix>")
#   PA_METADATA_FILE  write buildx --metadata-file here, for the pushed digest
#
# The last two exist for the release driver, `./build.sh` at the repo root
# (PA-65): a release publishes three tags per target rather than this script's
# local-dev pair, and pins by digest rather than by any of them.
set -euo pipefail

target="${1:-thin}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# Tag suffix per target. `thin` is the Dockerfile stage `runtime`, because
# "runtime" is what the stage *is* and "thin" is what the tag means.
case "$target" in
    thin)   stage=runtime; suffix='' ;;
    claude) stage=claude;  suffix='-claude' ;;
    all)    stage=all;     suffix='-all' ;;
    *)
        echo "Unknown target '$target'. Use: thin | claude | all" >&2
        exit 2
        ;;
esac

image="${PA_IMAGE:-registry.shifamily.com/homestack/pocketagent-server}"

# Default version: the package version, plus the short sha when this is a git
# checkout, so a locally built image is never mistaken for a release. Kept
# valid semver (`+` build metadata) because version.ts rejects anything else
# and would fall back to package.json silently.
if [[ -z "${PA_VERSION:-}" ]]; then
    base_version="$(node -p "require('./apps/server/package.json').version")"
    if sha="$(git rev-parse --short=8 HEAD 2>/dev/null)"; then
        PA_VERSION="${base_version}+${sha}"
    else
        PA_VERSION="${base_version}"
    fi
fi

# shellcheck disable=SC1091
set -a
source docker/agent-versions.env
set +a

# A Docker tag may not contain `+`, and semver build metadata may not be
# expressed any other way, so the two have to differ: the *stamped* version
# stays valid semver (version.ts rejects anything else and would silently fall
# back to package.json), while the tag substitutes a dash. They are the same
# identity written for two grammars — do not "fix" one to match the other.
tag_version="${PA_VERSION//+/-}"

args=(
    --file docker/Dockerfile
    --target "$stage"
    --build-arg "POCKETAGENT_BUILD_VERSION=${PA_VERSION}"
)

# Tag names, not full refs: the image name stays in exactly one place, so a
# caller overriding the tag set cannot accidentally publish the right tags to
# the wrong repository.
if [[ -n "${PA_TAGS:-}" ]]; then
    read -r -a tag_names <<<"${PA_TAGS}"
else
    tag_names=("${tag_version}${suffix}" "latest${suffix}")
fi
for name in "${tag_names[@]}"; do
    args+=(--tag "${image}:${name}")
done

if [[ -n "${PA_METADATA_FILE:-}" ]]; then
    # buildx writes `containerimage.digest` here, which is the only place the
    # pushed digest is available as data rather than as a line of push output
    # that has to be scraped.
    args+=(--metadata-file "${PA_METADATA_FILE}")
fi

# Only the targets that install a CLI need the pins, but passing them always is
# harmless and keeps the invocation uniform.
args+=(
    --build-arg "CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION}"
    --build-arg "CODEX_VERSION=${CODEX_VERSION}"
    --build-arg "OPENCODE_VERSION=${OPENCODE_VERSION}"
    --build-arg "PI_VERSION=${PI_VERSION}"
)

if [[ -n "${PA_PLATFORM:-}" ]]; then
    # One platform per invocation on purpose. @anthropic-ai/claude-agent-sdk
    # selects an arch- and libc-specific optionalDependency at install time, so
    # each platform needs its own real `pnpm install` — a two-platform build
    # here is two builds, not one build copied twice.
    args+=(--platform "$PA_PLATFORM")
fi

if [[ "${PA_PUSH:-}" == '1' ]]; then
    args+=(--push)
else
    args+=(--load)
fi

echo "==> ${image} (stage: ${stage}, stamped ${PA_VERSION})"
for name in "${tag_names[@]}"; do
    echo "      :${name}"
done
exec docker buildx build "${args[@]}" .
