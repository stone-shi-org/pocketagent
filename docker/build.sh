#!/usr/bin/env bash
# Build a PocketAgent backend image (PA-64).
#
#   docker/build.sh                 # thin      -> :<version>, :latest
#   docker/build.sh claude          # + claude  -> :<version>-claude, :latest-claude
#   docker/build.sh all             # + all     -> :<version>-all, :latest-all
#   docker/build.sh hub             # the Hub   -> pocketagent-hub:<version>, :latest
#
# This is the documented entry point rather than `docker build` because it is
# what reads docker/agent-versions.env, so the pins live in exactly one file.
# It also stamps the version into both halves of the image at once: PA-61's
# POCKETAGENT_BUILD_VERSION for /health and HostInfo, and the same string into
# the web bundle, which cannot derive it from git inside a build context that
# (correctly) excludes .git.
#
# Environment:
#   PA_IMAGE      image name          (default: this target's image under PA_REGISTRY)
#   PA_REGISTRY   registry/namespace  (default registry.shifamily.com/homestack)
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
    thin)   stage=runtime;     suffix='' ;;
    claude) stage=claude;      suffix='-claude' ;;
    all)    stage=all;         suffix='-all' ;;
    # PA-66. No suffix, because the Hub is a different *image name* rather
    # than a variant of the server's — see TARGETS in scripts/release-tags.mjs,
    # which owns that table so this switch and the tag matrix cannot disagree.
    hub)    stage=hub-runtime; suffix='' ;;
    *)
        echo "Unknown target '$target'. Use: thin | claude | all | hub" >&2
        exit 2
        ;;
esac

# The image name is per *target*, not global (PA-66): the three server targets
# publish `pocketagent-server` and `hub` publishes `pocketagent-hub`, because a
# gateway and a machine-with-agent-CLIs must not share a tag namespace where
# `:latest` has to mean one of them. `scripts/release-tags.mjs` owns that table
# and is read here rather than copied, which is what the root `./build.sh` has
# always done — this script defaulting to a literal `pocketagent-server` meant
# a bare `docker/build.sh hub` silently retagged the *backend's* `:latest` with
# the Hub image, and the two share neither a role nor a single byte of content.
registry="${PA_REGISTRY:-registry.shifamily.com/homestack}"
image="${PA_IMAGE:-$(node -e '
  import("./scripts/release-tags.mjs").then(({ imageForTarget }) => {
    process.stdout.write(imageForTarget(process.argv[1], process.argv[2]));
  });
' "$target" "$registry")}"

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
    --build-arg "PLAYWRIGHT_CLI_VERSION=${PLAYWRIGHT_CLI_VERSION}"
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
