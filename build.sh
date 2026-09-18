#!/usr/bin/env bash
# Build — and, on a tagged release, publish — the PocketAgent images (PA-65).
#
#   ./build.sh                 # build every target locally; publish nothing
#   ./build.sh -p              # publish, but only if HEAD is a release tag
#   ./build.sh -t thin -p      # one target
#   ./build.sh --dry-run -p    # print what would be built and pushed
#
# This is the repo-root entry point Bamboo's one Script task calls, after
# `./test.sh` — the same two-line shape every other plan on that server uses,
# with all of the logic here where it can be reviewed rather than in a job
# configuration nobody can diff. It drives `docker/build.sh` once per target
# rather than reimplementing the build: that script owns the pins in
# docker/agent-versions.env and the version stamp, and duplicating either here
# is how the image and the release end up disagreeing about what they are.
#
# ## What makes a build a release
#
# A tag on HEAD that parses as `1.2.3` or `1.2.3-rc.1` — no `v` prefix (PA-65
# decision 1). Anything else is a branch build: it still builds all three
# targets, because a broken Dockerfile should fail on the commit that broke it
# rather than at release time, but it pushes nothing. `:latest` therefore only
# ever means "the most recent release", never "whatever main built last night",
# which is what an operator who did not pin is entitled to assume.
#
# Asking to push without a release tag is a hard error rather than a quiet
# skip: a green build that published nothing is the single most common way a
# pipeline like this lies to you.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_root"

registry="${PA_REGISTRY:-registry.shifamily.com/homestack}"
# PA-66: the image name is per *target* now, not global — `hub` publishes
# `pocketagent-hub` while the three server targets publish
# `pocketagent-server`. `scripts/release-tags.mjs` owns that table so the tag
# matrix and this driver cannot disagree about it.
targets=(thin claude all hub)
push=0
dry_run=0

# The digest of each pushed image, so a deployment can pin `@sha256:…` instead
# of a tag that moves under it (scope item 5). Gitignored and published as a
# Bamboo artifact; regenerated per build, never appended to.
digest_file="${PA_DIGEST_FILE:-release-digests.txt}"

usage() {
    cat >&2 <<'EOF'
Usage: ./build.sh [-p] [-r REGISTRY] [-t TARGET] [--dry-run]

  -p, --push          Push to the registry. Requires a release tag on HEAD.
  -r, --registry REG  Registry and namespace (default: $PA_REGISTRY, else
                      registry.shifamily.com/homestack).
  -t, --target T      Build one target only: thin | claude | all | hub.
                      Repeatable. Default: all four.
      --dry-run       Print the plan and exit without building.
EOF
}

explicit_targets=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        -p | --push) push=1 ;;
        -r | --registry)
            registry="${2:?--registry needs a value}"
            shift
            ;;
        -t | --target)
            explicit_targets+=("${2:?--target needs a value}")
            shift
            ;;
        --dry-run) dry_run=1 ;;
        -h | --help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            usage
            exit 2
            ;;
    esac
    shift
done
if [[ ${#explicit_targets[@]} -gt 0 ]]; then
    targets=("${explicit_targets[@]}")
fi

# An empty registry means "local image name with no registry prefix", which is
# what a developer building for their own daemon wants; `release-tags.mjs`
# keeps the slash out in that case rather than producing `/pocketagent-server`.
image_for() {
    node -e '
      import("./scripts/release-tags.mjs").then(({ imageForTarget }) => {
        process.stdout.write(imageForTarget(process.argv[1], process.argv[2]));
      });
    ' "$1" "$registry"
}

# ---- Is this a release? -----------------------------------------------------

# `git tag --points-at HEAD` rather than `git describe --exact-match`, because
# this repo already carries a non-release tag (`pa10-pre-rebase`) and describe
# would hand it back as though it were the version. Take the first tag that
# actually parses as a release version and ignore the rest.
release_version=''
while read -r candidate; do
    [[ -z "$candidate" ]] && continue
    if node scripts/release-tags.mjs "$candidate" thin >/dev/null 2>&1; then
        release_version="$candidate"
        break
    fi
done < <(git tag --points-at HEAD 2>/dev/null || true)

if [[ -n "$release_version" ]]; then
    # A tag that disagrees with the committed version is a mistake worth
    # failing on, not reconciling: one of the two is wrong, and guessing which
    # would publish an image whose own /health contradicts its tag — the exact
    # failure this ticket exists to prevent. `pnpm version:set` writes all four
    # package.json files, so the fix is to bump, commit, and re-tag.
    declared="$(node -e '
      import("./scripts/set-version.mjs").then(({ readDeclaredVersions }) => {
        const versions = Object.values(readDeclaredVersions());
        process.stdout.write([...new Set(versions)].join(" "));
      });
    ')"
    if [[ "$declared" != "$release_version" ]]; then
        echo "Release tag '${release_version}' does not match the declared version(s): ${declared}" >&2
        echo "Run: pnpm version:set ${release_version}  (then commit and re-tag)" >&2
        exit 1
    fi
    echo "==> Release build: ${release_version}"
else
    echo "==> Branch build (no release tag on HEAD). Nothing will be published."
    if [[ "$push" == '1' ]]; then
        echo "--push was given, but HEAD carries no release tag." >&2
        echo "Tag the commit (e.g. 'git tag 1.2.3') or drop --push." >&2
        exit 1
    fi
fi

# ---- Plan -------------------------------------------------------------------

# The version *stamped into* the image. For a release it is the tag. For a
# branch build `docker/build.sh` derives `<pkg>+<sha>` itself, so leaving
# PA_VERSION unset is what keeps a local build from ever looking like a release.
stamp_version="$release_version"

declare -A planned_tags=()
declare -A target_images=()
for target in "${targets[@]}"; do
    target_images["$target"]="$(image_for "$target")"
    if [[ -n "$release_version" ]]; then
        planned_tags["$target"]="$(node scripts/release-tags.mjs "$release_version" "$target" | tr '\n' ' ')"
    else
        planned_tags["$target"]=''
    fi
done

echo "    targets:  ${targets[*]}"
echo "    push:     $([[ "$push" == '1' ]] && echo yes || echo 'no (build only)')"
for target in "${targets[@]}"; do
    echo "    ${target}: ${target_images[$target]} ${planned_tags[$target]:-(local dev tags)}"
done

if [[ "$dry_run" == '1' ]]; then
    echo "==> --dry-run: stopping before the build."
    exit 0
fi

# ---- Build ------------------------------------------------------------------

metadata_dir="$(mktemp -d)"
trap 'rm -rf "$metadata_dir"' EXIT

for target in "${targets[@]}"; do
    env_args=(
        "PA_IMAGE=${target_images[$target]}"
        "PA_PUSH=${push}"
        "PA_METADATA_FILE=${metadata_dir}/${target}.json"
    )
    [[ -n "$stamp_version" ]] && env_args+=("PA_VERSION=${stamp_version}")
    [[ -n "${planned_tags[$target]}" ]] && env_args+=("PA_TAGS=${planned_tags[$target]}")
    [[ -n "${PA_PLATFORM:-}" ]] && env_args+=("PA_PLATFORM=${PA_PLATFORM}")

    env "${env_args[@]}" docker/build.sh "$target"
done

# ---- Digests ----------------------------------------------------------------

# Only a push produces a digest worth recording: a `--load`ed image has a local
# id, not a registry digest, and writing that down would invite someone to try
# pinning a deployment to it.
if [[ "$push" == '1' ]]; then
    {
        echo "# PocketAgent ${release_version} — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        echo "# Pin a deployment by digest: the tags below move, the digests do not."
        for target in "${targets[@]}"; do
            digest="$(node -e '
              const fs = require("node:fs");
              const meta = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
              process.stdout.write(meta["containerimage.digest"] ?? "");
            ' "${metadata_dir}/${target}.json")"
            for name in ${planned_tags[$target]}; do
                echo "${target_images[$target]}:${name} ${digest}"
            done
        done
    } >"$digest_file"
    echo "==> Digests written to ${digest_file}"
    cat "$digest_file"
fi

echo "==> Done."
