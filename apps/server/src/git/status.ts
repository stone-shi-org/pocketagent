import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitStatus } from '@pocketagent/protocol';

const execFileAsync = promisify(execFile);

/**
 * How long a cached status is trusted before another `git status` is spawned
 * for that directory.
 *
 * `gitBranch`/`isGitRepo` are free — a raw read of `.git/HEAD` — so
 * `ProjectService.list` can recompute them on every 5s home-screen poll
 * without a second thought. Working-tree dirtiness and ahead/behind-upstream
 * have no equivalently cheap file-based equivalent (that would mean
 * reimplementing the index format and the commit-graph walk git already does
 * correctly), so this bounds staleness with a slower cache instead of
 * chasing every poll with a subprocess. A push made from a second terminal
 * is picked up within one TTL window, not instantly — that trade is the
 * point.
 */
const CACHE_TTL_MS = 15_000;

interface CacheEntry {
  status: GitStatus;
  computedAt: number;
}

/**
 * Tracks per-directory git status (`GitStatus`), each entry refreshed by
 * spawning `git status` at most once per `CACHE_TTL_MS` — see that constant's
 * comment for why. One instance is shared across an entire `ProjectService`
 * so a project and its folded worktrees each keep their own independent
 * cache entry (they are different working trees, even though they share one
 * object store).
 */
export class GitStatusTracker {
  private readonly cache = new Map<string, CacheEntry>();
  // Coalesces concurrent callers for the same directory (e.g. two overlapping
  // `GET /api/projects` requests) onto a single `git status` spawn rather
  // than racing separate ones.
  private readonly inFlight = new Map<string, Promise<GitStatus | null>>();

  constructor(private readonly ttlMs: number = CACHE_TTL_MS) {}

  /** `cwd` must already be known to be a git repository — this always spawns on a miss. */
  async get(cwd: string): Promise<GitStatus | null> {
    const cached = this.cache.get(cwd);
    if (cached && Date.now() - cached.computedAt < this.ttlMs) return cached.status;

    const pending = this.inFlight.get(cwd);
    if (pending) return pending;

    const promise = computeGitStatus(cwd).finally(() => this.inFlight.delete(cwd));
    this.inFlight.set(cwd, promise);
    const status = await promise;

    // A transient failure (e.g. a `git gc` running concurrently, or the
    // directory vanishing mid-poll) keeps serving the last known-good status
    // rather than flipping the indicator off and back on every few seconds.
    if (status === null) return cached?.status ?? null;
    this.cache.set(cwd, { status, computedAt: Date.now() });
    return status;
  }
}

async function computeGitStatus(cwd: string): Promise<GitStatus | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=2', '--branch', '--untracked-files=normal'],
      { cwd },
    ));
  } catch {
    // Not (or no longer) a valid repository, or `git` itself failed —
    // callers only ask for directories `isGitRepo` already said yes to, but
    // that check is a cheap `fs.stat` and can be stale by the time this runs.
    return null;
  }
  return parsePorcelainV2(stdout);
}

/**
 * `git status --porcelain=2 --branch` output, parsed for exactly the three
 * things a `GitStatus` needs: whether anything is uncommitted, whether an
 * upstream is configured, and how many commits are ahead of it.
 *
 * Header lines start with `#`; every other non-empty line (`1 .M ...`,
 * `2 ...`, `u ...`, `? untracked-file`) means something changed in the
 * working tree or index — the exact kind does not matter, only that dirty
 * beats unpushed beats clean.
 */
export function parsePorcelainV2(output: string): GitStatus {
  let hasUpstream = false;
  let ahead = 0;
  let dirty = false;

  for (const line of output.split('\n')) {
    if (line.startsWith('# branch.upstream')) {
      hasUpstream = true;
    } else if (line.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -\d+/.exec(line);
      if (match?.[1]) ahead = Number(match[1]);
    } else if (line && !line.startsWith('#')) {
      dirty = true;
    }
  }

  if (dirty) return 'dirty';
  if (!hasUpstream || ahead > 0) return 'unpushed';
  return 'clean';
}
