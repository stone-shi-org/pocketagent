import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * This Hub build's identity, resolved exactly as `apps/server/src/version.ts`
 * resolves the backend's: `POCKETAGENT_BUILD_VERSION` → this package's own
 * `package.json` (+ short git sha if in a git checkout) → `0.0.0-dev`.
 *
 * Same variable, deliberately. One image build stamps both, and the repo's
 * four (now six) `package.json` versions are kept identical by
 * `pnpm version:set`, so a Hub and a backend cut from one release report the
 * same string — which is what lets PA-69's drift check compare them at all
 * rather than needing to know which component it is looking at.
 *
 * Not shared as a module with the server's copy: that one reads
 * `../package.json` relative to itself, and "which package.json is mine" is
 * precisely the part that cannot be shared.
 */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const FALLBACK_VERSION = '0.0.0-dev';

function versionFromPackageJson(): string | null {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const version = (parsed as { version?: unknown }).version;
    return typeof version === 'string' && SEMVER.test(version) ? version : null;
  } catch {
    return null;
  }
}

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

export function resolveHubVersion(
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

const resolved = resolveHubVersion();

export const HUB_VERSION = resolved.version;
export const HUB_VERSION_WARNING = resolved.warning;
