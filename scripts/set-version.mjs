#!/usr/bin/env node
/**
 * Sets the repo's version, in every `package.json` at once (PA-65).
 *
 *   node scripts/set-version.mjs 1.2.3
 *   pnpm version:set 1.2.3
 *
 * ## Why a script rather than `pnpm -r exec npm version`
 *
 * These four packages are `private` and are never published to a registry, so
 * their versions carry no dependency semantics — nothing resolves
 * `@pocketagent/protocol@^0.1.0`, because it is consumed as a workspace link.
 * What the version *does* carry is build identity: `version.ts` falls back to
 * `apps/server/package.json` when no build stamp is set, and `docker/build.sh`
 * derives a local image tag from it. Four numbers that are allowed to disagree
 * would mean "the repo's version" depends on which file you looked at, which
 * is exactly the ambiguity the hardcoded `VERSION = '0.1.0'` created.
 *
 * So: **the root `package.json` is authoritative and the other three are kept
 * identical to it** (approved on PA-65: "synced is fine"). `version-sync.test.ts`
 * asserts they match, so a hand-edit of one file fails the suite rather than
 * quietly shipping a server that disagrees with its own image tag.
 *
 * This script deliberately does not `git tag`, `git commit`, or push. Cutting a
 * release is a human act with a changelog attached; this only edits files, so
 * the version bump can be reviewed like any other diff.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { parseReleaseVersion } from './release-tags.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every `package.json` whose version has to move together. Root first, because
 * it is the authoritative one and reads as the subject of the edit.
 */
export const VERSIONED_PACKAGES = [
  'package.json',
  'apps/server/package.json',
  'apps/web/package.json',
  'packages/protocol/package.json',
];

/** Reads the declared version of each file above, keyed by its repo-relative path. */
export function readDeclaredVersions(root = REPO_ROOT) {
  const versions = {};
  for (const relative of VERSIONED_PACKAGES) {
    const parsed = JSON.parse(readFileSync(join(root, relative), 'utf8'));
    versions[relative] = parsed.version;
  }
  return versions;
}

/**
 * Rewrites the `version` field in place.
 *
 * A targeted replacement of the first `"version": "…"` rather than
 * `JSON.parse` → `JSON.stringify`, so the diff is one line and nothing else
 * about the file's formatting is at the mercy of a serializer.
 */
function writeVersion(absolutePath, version) {
  const before = readFileSync(absolutePath, 'utf8');
  const after = before.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`);
  if (after === before) {
    throw new Error(`No version field to update in ${absolutePath}`);
  }
  writeFileSync(absolutePath, after);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [version] = process.argv.slice(2);
  if (parseReleaseVersion(version) === null) {
    console.error(
      `Usage: node scripts/set-version.mjs <version>\n` +
        `  <version> must be 1.2.3 or 1.2.3-rc.1 — no 'v' prefix, no '+build' metadata.\n` +
        `  Got: ${version ?? '(nothing)'}`,
    );
    process.exit(2);
  }
  for (const relative of VERSIONED_PACKAGES) {
    writeVersion(join(REPO_ROOT, relative), version);
    console.log(`${relative} -> ${version}`);
  }
  console.log(
    `\nNext: commit this, then tag the commit \`${version}\` (no 'v') and run ./build.sh -p.`,
  );
}
