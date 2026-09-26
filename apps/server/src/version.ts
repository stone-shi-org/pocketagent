import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * This build's identity, as a real semver string (PA-61, PA-108).
 *
 * `VERSION` used to be the literal `'0.1.0'` in `app.ts`, which made
 * `HostInfo.version` and `/health` decorative: every host in a fleet reported
 * the same number forever, so nothing could answer "is that machine lagging?"
 * — the question the Hub's version-drift detection is built on.
 *
 * ## Why this is not in `Config`
 *
 * `POCKETAGENT_BUILD_VERSION` is read from raw `process.env` rather than
 * through the `Config` schema, the same way the legacy provider variables are,
 * and for the same reason: it is not configuration. An operator does not
 * *choose* their build number — the image build stamps it, and a deployment
 * that overrode it by hand would be lying about which code is running. Keeping
 * it out of `Config` also keeps it out of the settings UI, where it would look
 * editable.
 *
 * ## Resolution order
 *
 * The env var comes first so the CI image build can stamp it without touching
 * a tracked file. `package.json` is the fallback, suffixed with the short git
 * revision hash (`+<sha>`) when running in a git checkout, so a source
 * checkout reports the exact commit it is running from. `0.0.0-dev` is the
 * last resort — deliberately a *valid* semver that sorts below every real
 * release, so a drift check comparing versions never has to special-case it.
 *
 * Resolved once at module load: the answer cannot change while the process
 * runs, and `/health` is polled often enough that re-reading a file per request
 * would be a pointless syscall.
 */

/** Matches the numeric core of a semver, with optional prerelease/build parts. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Sorts below any real release, and is itself valid semver. */
const FALLBACK_VERSION = '0.0.0-dev';

/**
 * Reads `version` out of this package's own `package.json`.
 *
 * The fixed `../` works from both layouts because `src/version.ts` and
 * `dist/version.js` sit at the same depth under `apps/server` — if this module
 * ever moves into a subdirectory, that stops being true and the path has to
 * become a walk upwards.
 */
function versionFromPackageJson(): string | null {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const version = (parsed as { version?: unknown }).version;
    return typeof version === 'string' && SEMVER.test(version) ? version : null;
  } catch {
    // A packaged deployment that dropped package.json is not a reason to
    // refuse to boot — it just falls through to the placeholder below.
    return null;
  }
}

/**
 * Reads the short git revision hash when running from a git checkout.
 * Falls back to null when not in a git repository or git is unavailable.
 */
function gitShortSha(): string | null {
  try {
    const raw = execSync('git rev-parse --short=8 HEAD', {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 1000,
    }).trim();
    return /^[0-9a-fA-F]{7,40}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

function withGitSha(version: string, gitSha: () => string | null): string {
  if (version.includes('+')) return version;
  const sha = gitSha();
  return sha ? `${version}+${sha}` : version;
}

/**
 * Picks the version string this process reports.
 *
 * Exported for the tests, which need to exercise the precedence without
 * mutating the module-level constant.
 *
 * A malformed override is *ignored rather than fatal*: an unparseable build
 * stamp is a CI bug, and refusing to start over it would turn a cosmetic
 * mistake into an outage. It is still worth surfacing, hence the returned
 * `warning` — `app.ts` logs it once at boot rather than swallowing it.
 */
export function resolveServerVersion(
  env: NodeJS.ProcessEnv = process.env,
  gitSha: () => string | null = gitShortSha,
): {
  version: string;
  warning: string | null;
} {
  const override = env.POCKETAGENT_BUILD_VERSION?.trim();
  if (override !== undefined && override !== '') {
    if (SEMVER.test(override)) return { version: override, warning: null };
    const base = versionFromPackageJson();
    return {
      version: base ? withGitSha(base, gitSha) : FALLBACK_VERSION,
      warning: `POCKETAGENT_BUILD_VERSION is not a valid semver (${override}); ignoring it`,
    };
  }
  const base = versionFromPackageJson();
  return {
    version: base ? withGitSha(base, gitSha) : FALLBACK_VERSION,
    warning: null,
  };
}

const resolved = resolveServerVersion();

/** Semver of this build. Reported on `/health` and `HostInfo.version`. */
export const VERSION = resolved.version;

/** Non-null when the build stamp was present but unusable. Logged once at boot. */
export const VERSION_WARNING = resolved.warning;
