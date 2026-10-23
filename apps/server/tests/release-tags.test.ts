/**
 * The release pipeline's two pure decisions (PA-65): which Docker tags a
 * version publishes, and whether the repo's four `package.json` versions
 * agree.
 *
 * These cover repo tooling under `scripts/`, not server source — they live in
 * this directory because `vitest.config.ts` has exactly two projects (`server`
 * and `web`) rooted at `apps/*`, and adding a third project for two modules
 * would be more configuration than the thing being tested. The server project
 * does not typecheck its tests (`apps/server/tsconfig.json` includes only
 * `src/**`), which is also why importing plain `.mjs` here is fine.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { imageForTarget, parseReleaseVersion, releaseTags, TARGETS } from '../../../scripts/release-tags.mjs';
import { readDeclaredVersions, VERSIONED_PACKAGES } from '../../../scripts/set-version.mjs';

describe('parseReleaseVersion', () => {
  it('accepts a bare semver', () => {
    expect(parseReleaseVersion('1.2.3')).toMatchObject({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: null,
    });
  });

  it('rejects a `v` prefix', () => {
    // The tag format was specified on PA-65 as `1.2.3`, no `v`. Accepting both
    // would mean `1.2.3` and `v1.2.3` are two releases of the same commit that
    // publish the same image tags, and the second one to build wins.
    expect(parseReleaseVersion('v1.2.3')).toBeNull();
  });

  it('rejects build metadata', () => {
    // A Docker tag may not contain `+`, so a release named `1.2.3+abc1234`
    // could only be published under a mangled tag — and a release whose git tag
    // and image tag are different strings is the exact ambiguity this ticket
    // exists to remove. The *stamp* still accepts it (see version.ts), because
    // a local dev build is `<pkg>+<sha>` by construction and is never pushed.
    expect(parseReleaseVersion('1.2.3+abc1234')).toBeNull();
  });

  it('keeps a prerelease label', () => {
    expect(parseReleaseVersion('1.2.3-rc.1')).toMatchObject({ prerelease: 'rc.1' });
  });
});

describe('releaseTags', () => {
  it('publishes the semver, the minor series and latest for a stable release', () => {
    expect(releaseTags({ version: '1.2.3', target: 'thin' })).toEqual(['1.2.3', '1.2', 'latest']);
  });

  it('suffixes every tag for a variant target', () => {
    // The variants are separate images with their own moving tags: someone
    // tracking `:latest-claude` must not be handed the thin image.
    expect(releaseTags({ version: '1.2.3', target: 'claude' })).toEqual([
      '1.2.3-claude',
      '1.2-claude',
      'latest-claude',
    ]);
    expect(releaseTags({ version: '2.0.0', target: 'all' })).toEqual([
      '2.0.0-all',
      '2.0-all',
      'latest-all',
    ]);
  });

  it('moves nothing for a prerelease', () => {
    // The load-bearing rule (PA-65 decision 3). `1.2` and `latest` are what an
    // operator gets when they have *not* pinned, so a release candidate
    // reaching either would ship an unfinished build to precisely the people
    // who never asked to test one.
    expect(releaseTags({ version: '1.2.3-rc.1', target: 'thin' })).toEqual(['1.2.3-rc.1']);
    expect(releaseTags({ version: '1.2.3-rc.1', target: 'claude' })).toEqual([
      '1.2.3-rc.1-claude',
    ]);
  });

  it('prefixes the image name when given one', () => {
    expect(
      releaseTags({ version: '1.2.3', target: 'thin', image: 'registry.example/ns/pa-server' }),
    ).toEqual([
      'registry.example/ns/pa-server:1.2.3',
      'registry.example/ns/pa-server:1.2',
      'registry.example/ns/pa-server:latest',
    ]);
  });

  it('refuses a non-release version rather than inventing a tag', () => {
    expect(() => releaseTags({ version: 'not-a-version', target: 'thin' })).toThrow(
      /not a release version/i,
    );
  });

  it('refuses an unknown target', () => {
    // `build.sh` passes this through from its own argv, so a typo must fail
    // loudly instead of publishing an unsuffixed tag built from the wrong stage.
    expect(() => releaseTags({ version: '1.2.3', target: 'slim' })).toThrow(/unknown target/i);
  });
});

describe('the hub is a second image, not a tag suffix (PA-66)', () => {
  it('publishes pocketagent-hub under unsuffixed tags', () => {
    expect(releaseTags({ version: '1.2.3', target: 'hub', image: 'reg/pocketagent-hub' })).toEqual([
      'reg/pocketagent-hub:1.2.3',
      'reg/pocketagent-hub:1.2',
      'reg/pocketagent-hub:latest',
    ]);
  });

  it('never puts the hub in the server image namespace', () => {
    // `pocketagent-server:1.2.3-hub` would be actively misleading: an
    // operator pulling it would reasonably expect a backend.
    expect(imageForTarget('hub', 'reg')).toBe('reg/pocketagent-hub');
    expect(imageForTarget('thin', 'reg')).toBe('reg/pocketagent-server');
    for (const target of Object.keys(TARGETS)) {
      expect(imageForTarget(target, '')).not.toContain('/');
    }
  });

  it('still refuses an unknown target', () => {
    expect(() => imageForTarget('nope', 'reg')).toThrow(/Unknown target/);
  });

  it('gives a prerelease hub only its own exact tag', () => {
    expect(releaseTags({ version: '1.2.3-rc.1', target: 'hub', image: '' })).toEqual(['1.2.3-rc.1']);
  });
});

describe("docker/build.sh's target table", () => {
  // The bug this guards was live on `feature/hub`: `docker/build.sh` defaulted
  // its image to the literal `pocketagent-server` while the *root* `build.sh`
  // asked `imageForTarget`, so `docker/build.sh hub` — the invocation the
  // README and CLAUDE.md both document — built the gateway and pushed it over
  // the backend's own `:latest`. A comment in `release-tags.mjs` already said
  // the two "cannot drift"; nothing made that true, so these do.
  const script = fs.readFileSync(new URL('../../../docker/build.sh', import.meta.url), 'utf8');

  it('offers exactly the targets release-tags.mjs knows about', () => {
    // The `case` arms, e.g. `    thin)   stage=runtime;     suffix='' ;;`.
    const offered = [...script.matchAll(/^\s{4}([a-z|]+)\)\s+stage=/gm)]
      .flatMap((match) => match[1].split('|'));
    expect(offered.sort()).toEqual(Object.keys(TARGETS).sort());
  });

  it('derives the image name rather than hardcoding one', () => {
    // Any literal image name in the default is a second copy of the TARGETS
    // table, and the `hub` row is the one that makes the copy wrong.
    expect(script).toMatch(/imageForTarget/);
    expect(script).not.toMatch(/PA_IMAGE:-[^}$]*pocketagent-/);
  });

  it('copies patches/ in every Dockerfile stage that copies pnpm-workspace.yaml', () => {
    // `pnpm-workspace.yaml` declares `patchedDependencies` under `patches/`,
    // so any manifest-only stage that runs `pnpm install --frozen-lockfile`
    // (`deps` and `hub-deps`) fails unless `patches/` is copied alongside it.
    const dockerfile = fs.readFileSync(new URL('../../../docker/Dockerfile', import.meta.url), 'utf8');
    const workspaceCopies = [...dockerfile.matchAll(/^COPY .*pnpm-workspace\.yaml .*\n([^\n]*)/gm)];
    expect(workspaceCopies.length).toBeGreaterThanOrEqual(2);
    for (const [, nextLine] of workspaceCopies) {
      expect(nextLine).toBe('COPY patches/ patches/');
    }
  });

  it('uses a container builder when pushing to avoid host split-horizon DNS timeouts', () => {
    expect(script).toMatch(/docker-container/);
    expect(script).toMatch(/PA_BUILDER/);
    expect(script).toMatch(/pocketagent-builder/);
  });
});

describe('the repo version', () => {
  it('is identical in every package.json', () => {
    // Root is authoritative; the other three are synced by
    // `pnpm version:set`. They are allowed to be boring, but not to disagree:
    // `version.ts` falls back to `apps/server/package.json` and
    // `docker/build.sh` derives a local tag from the root one, so a drift here
    // means the server reports a version its own image tag contradicts.
    const versions = readDeclaredVersions();
    expect(Object.keys(versions)).toEqual(VERSIONED_PACKAGES);
    expect(new Set(Object.values(versions)).size).toBe(1);
  });

  it('is a taggable release version', () => {
    // Whatever is committed has to be directly usable as a git tag, or a
    // release cannot be cut without editing it first — and `build.sh` asserts
    // the tag and this value match.
    const [rootVersion] = Object.values(readDeclaredVersions());
    expect(parseReleaseVersion(rootVersion)).not.toBeNull();
  });
});
