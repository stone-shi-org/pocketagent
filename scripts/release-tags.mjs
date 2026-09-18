#!/usr/bin/env node
/**
 * Computes the Docker tags one release publishes (PA-65).
 *
 * This is a module rather than a few lines of `sed` inside `build.sh` for one
 * reason: the prerelease rule below is a *decision*, and a decision deserves a
 * test. `release-tags.test.ts` covers it; a bash substring expression could
 * only be verified by pushing something wrong to the registry and noticing.
 *
 * Usage:
 *   node scripts/release-tags.mjs 1.2.3 claude
 *   node scripts/release-tags.mjs 1.2.3 thin --image registry.example/foo
 */

/**
 * Tag suffix per build target. The keys are `docker/build.sh`'s own target
 * names, so the two cannot drift into disagreeing about what `-claude` means.
 */
export const TARGET_SUFFIXES = {
  thin: '',
  claude: '-claude',
  all: '-all',
};

/**
 * A release tag, exactly as the reporter specified it on PA-65: `1.2.3`, with
 * **no** `v` prefix.
 *
 * Build metadata (`+sha`) is deliberately rejected here even though
 * `version.ts` accepts it for the *stamp*. A Docker tag may not contain `+` at
 * all, so a release named that way could only be published under a mangled
 * tag — and a release whose git tag and image tag are different strings
 * defeats the point of the whole ticket. `docker/build.sh` still mangles `+`
 * for local dev builds, where the version is `<pkg>+<sha>` by construction and
 * nothing is published.
 */
const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Parses a release version, or returns null.
 *
 * Returning null rather than throwing keeps the "is this a release build?"
 * question answerable without exception handling — `build.sh` asks it on every
 * build, and the common answer is "no, this is a branch build".
 */
export function parseReleaseVersion(version) {
  const match = RELEASE_VERSION.exec(String(version ?? '').trim());
  if (match === null) return null;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ?? null,
    version: `${major}.${minor}.${patch}${prerelease === undefined ? '' : `-${prerelease}`}`,
  };
}

/**
 * The tags one target of one release publishes.
 *
 * **A prerelease moves nothing.** `1.2.3-rc.1` publishes only its own exact
 * tag: no `1.2`, no `latest`. Approved on PA-65 (decision 3), and the reason is
 * that both of those are what an operator gets when they *don't* pin, so a
 * release candidate reaching them would ship an unfinished build to everyone
 * who wrote `:latest` — the one group who has said nothing about wanting to
 * test it.
 *
 * The moving tags are otherwise deliberate: `1.2` is the "give me patches of
 * the minor I qualified" subscription, and `latest` is the unpinned default.
 * Neither is a substitute for the digest — see `--metadata-file` in
 * `build.sh`, which is what a deployment should pin by (scope item 5).
 */
export function releaseTags({ version, target, image }) {
  const parsed = parseReleaseVersion(version);
  if (parsed === null) {
    throw new Error(
      `Not a release version: '${version}'. Expected 1.2.3 or 1.2.3-rc.1 (no 'v' prefix).`,
    );
  }
  const suffix = TARGET_SUFFIXES[target];
  if (suffix === undefined) {
    throw new Error(
      `Unknown target '${target}'. Expected one of: ${Object.keys(TARGET_SUFFIXES).join(', ')}.`,
    );
  }

  const names = [`${parsed.version}${suffix}`];
  if (parsed.prerelease === null) {
    names.push(`${parsed.major}.${parsed.minor}${suffix}`, `latest${suffix}`);
  }
  return names.map((name) => (image ? `${image}:${name}` : name));
}

// CLI. Kept to stdout-one-per-line so `build.sh` can read it with `mapfile`
// rather than parsing JSON in bash.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [version, target, ...rest] = process.argv.slice(2);
  const imageFlag = rest.indexOf('--image');
  const image = imageFlag === -1 ? '' : rest[imageFlag + 1];
  try {
    for (const tag of releaseTags({ version, target, image })) console.log(tag);
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(2);
  }
}
