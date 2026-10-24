import { execFile } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  WebhookRouteCacheEntry,
  WebhookRouteConfidence,
  WebhookRouteSource,
  WebhookType,
} from '@pocketagent/protocol';
import { BAMBOO_PLAN_KEY_RE, JIRA_PROJECT_KEY_RE } from '@pocketagent/protocol';
import type { Db, WebhookRouteCacheRow, WebhookRow } from '../db/index.js';
import {
  deleteWebhookRouteCacheEntry,
  readAllWebhookRouteCache,
  readWebhookRouteCache,
  readWebhookRouteCacheEntry,
  upsertWebhookRouteCacheEntry,
} from '../db/index.js';
import { findWorktreeRoot, treeRootOf } from '../git/worktree-paths.js';
import { readGitOriginUrl, readGitOriginUrlSync } from '../routes/capabilities.js';
import { buildChildEnv } from '../sessions/env.js';
import type { WorkspaceRegistry } from '../workspaces/index.js';
import { isContained } from '../workspaces/index.js';
import { parseBambooEvent } from './bamboo.js';

const execFileAsync = promisify(execFile);

/**
 * Maximum commits or age scanned per working tree during Signal 1 (git-history)
 * detection. Bounded so a repository with tens of thousands of commits never
 * stalls background detection.
 */
const GIT_LOG_MAX_COMMITS = 2000;
const GIT_LOG_SINCE = '180.days.ago';
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * Minimum score (`commits + branches`) and minimum multiplier over the
 * runner-up required for a git-history match to be considered `'unambiguous'`.
 *
 * A key with only 1–2 stray mentions or a tie/near-tie across two repositories
 * stays `'ambiguous'` so `autoRoute: 'auto'` falls back to `'suggest'` rather
 * than guessing.
 */
const UNAMBIGUOUS_MIN_SCORE = 3;
const UNAMBIGUOUS_MARGIN_MULTIPLIER = 3;

/**
 * Normalize a git remote URL so SSH (`git@host:org/repo.git`,
 * `ssh://git@host/org/repo`) and HTTPS (`https://user@host/org/repo.git/`)
 * forms of the same repository compare equal.
 */
export function normalizeGitRemoteUrl(raw: string): string {
  let s = raw.trim();
  if (s === '') return '';

  // Strip trailing slashes and optional `.git` suffix.
  s = s.replace(/\/+$/, '');
  if (s.toLowerCase().endsWith('.git')) {
    s = s.slice(0, -4);
  }
  s = s.replace(/\/+$/, '');

  // Standard URL form: https://, http://, ssh://, git://
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const parsed = new URL(s);
      const host = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
      return pathname ? `${host}/${pathname}` : host;
    } catch {
      // Fall through to SCP-style normalization.
    }
  }

  // SCP-style SSH remote: [user@]host:path/to/repo
  const scpMatch = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(s);
  if (scpMatch && scpMatch[1] && scpMatch[2]) {
    const host = scpMatch[1].toLowerCase();
    const repoPath = scpMatch[2].replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
    return `${host}/${repoPath}`;
  }

  return s.toLowerCase();
}

/**
 * Convert a database row into the wire DTO, computing `workspaceLabel` via
 * `WorkspaceRegistry.labelFor`.
 */
export function toWebhookRouteCacheEntry(
  row: WebhookRouteCacheRow,
  workspaces: WorkspaceRegistry,
): WebhookRouteCacheEntry {
  return {
    webhookId: row.webhook_id,
    routeKey: row.route_key,
    hostId: row.host_id,
    cwd: row.cwd,
    workspaceLabel: workspaces.labelFor(row.cwd),
    source: row.source as WebhookRouteSource,
    confidence: row.confidence as WebhookRouteConfidence,
    evidence: row.evidence,
    detectedAt: row.detected_at,
    confirmedAt: row.confirmed_at,
    confirmedBy: row.confirmed_by,
    dismissedAt: row.dismissed_at,
  };
}

/**
 * Validate cached route entries without spawning `git`.
 *
 * Invalidates (deletes) any entry whose `cwd` no longer resolves inside a
 * configured workspace folder (checked with `realpath` + `isContained`) or
 * whose folder's `.git/config` origin remote has changed since the entry was
 * detected.
 *
 * Synchronous so `toDto` and `toDelivery` can prune stale entries on read
 * while keeping list views pure cache reads with zero child processes.
 */
export function validateAndPruneRouteCacheSync(
  db: Db,
  workspaces: WorkspaceRegistry,
  webhookId?: string,
): WebhookRouteCacheRow[] {
  const rows =
    webhookId !== undefined ? readWebhookRouteCache(db, webhookId) : readAllWebhookRouteCache(db);
  const roots = workspaces.getRoots();
  const valid: WebhookRouteCacheRow[] = [];

  for (const row of rows) {
    let real: string;
    try {
      real = fsSync.realpathSync(path.resolve(row.cwd));
      if (!fsSync.statSync(real).isDirectory()) {
        deleteWebhookRouteCacheEntry(db, row.webhook_id, row.route_key);
        continue;
      }
    } catch {
      deleteWebhookRouteCacheEntry(db, row.webhook_id, row.route_key);
      continue;
    }

    if (!roots.some((root) => isContained(root, real))) {
      deleteWebhookRouteCacheEntry(db, row.webhook_id, row.route_key);
      continue;
    }

    const currentRemote = readGitOriginUrlSync(real);
    const cachedRemote = row.git_remote ?? null;
    if (
      normalizeGitRemoteUrl(currentRemote ?? '') !== normalizeGitRemoteUrl(cachedRemote ?? '')
    ) {
      deleteWebhookRouteCacheEntry(db, row.webhook_id, row.route_key);
      continue;
    }

    valid.push(row);
  }

  return valid;
}

interface CandidateRepo {
  /** Canonical path to the main repository folder inside workspaces. */
  cwd: string;
  /** `.git/config` origin URL (or null if none). */
  gitRemote: string | null;
  /**
   * Canonical paths to scan with `git`: the main repository folder plus any
   * linked worktree roots (`<repo>/.worktrees/*`) via `treeRootOf`.
   */
  treeRoots: string[];
}

async function hasGitMarker(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover candidate git repositories across all added workspace folders,
 * re-checking every folder and worktree root with `resolveWorkspacePath`.
 *
 * A workspace root may itself be a git repository, or it may be a parent
 * directory whose immediate child folders are git repositories (or both).
 * Worktrees under `<repo>/.worktrees/<slug>` are attached to `<repo>`'s
 * `treeRoots` via `treeRootOf` rather than listed as separate candidate repos,
 * so a repository never competes against its own worktree.
 */
export async function discoverCandidateRepos(
  workspaces: WorkspaceRegistry,
): Promise<CandidateRepo[]> {
  const byCwd = new Map<string, CandidateRepo>();

  const registerRepo = async (candidatePath: string): Promise<void> => {
    let realRepo: string;
    try {
      realRepo = await workspaces.resolveWorkspacePath(candidatePath);
    } catch {
      return;
    }
    // If `realRepo` is inside `<main>/.worktrees/<slug>`, roll up to `<main>` if
    // `<main>` is also inside workspaces; otherwise treat `treeRootOf(realRepo)`
    // as the candidate.
    const wtRoot = findWorktreeRoot(realRepo);
    if (wtRoot !== null) {
      const mainCandidate = path.dirname(path.dirname(wtRoot));
      try {
        const realMain = await workspaces.resolveWorkspacePath(mainCandidate);
        if (await hasGitMarker(realMain)) {
          realRepo = realMain;
        }
      } catch {
        // Main repo is outside workspaces; keep `wtRoot`.
        realRepo = wtRoot;
      }
    }

    if (byCwd.has(realRepo)) return;
    if (!(await hasGitMarker(realRepo))) return;

    const treeRoots = new Set<string>([treeRootOf(realRepo)]);
    const worktreesDir = path.join(realRepo, '.worktrees');
    try {
      const entries = await fs.readdir(worktreesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const wtPath = path.join(worktreesDir, entry.name);
        try {
          const realWt = await workspaces.resolveWorkspacePath(wtPath);
          if (await hasGitMarker(realWt)) {
            treeRoots.add(treeRootOf(realWt));
          }
        } catch {
          // Ignore worktrees that fail containment or do not exist.
        }
      }
    } catch {
      // No `.worktrees` directory.
    }

    byCwd.set(realRepo, {
      cwd: realRepo,
      gitRemote: await readGitOriginUrl(realRepo),
      treeRoots: [...treeRoots],
    });
  };

  for (const root of workspaces.getRoots()) {
    let realRoot: string;
    try {
      realRoot = await workspaces.resolveWorkspacePath(root);
    } catch {
      continue;
    }

    if (await hasGitMarker(realRoot)) {
      await registerRepo(realRoot);
    }

    try {
      const children = await fs.readdir(realRoot, { withFileTypes: true });
      for (const child of children) {
        if (!child.isDirectory() || child.name.startsWith('.')) continue;
        const childPath = path.join(realRoot, child.name);
        if (await hasGitMarker(childPath)) {
          await registerRepo(childPath);
        }
      }
    } catch {
      // Unreadable root directory; skip.
    }
  }

  return [...byCwd.values()].sort((a, b) => a.cwd.localeCompare(b.cwd));
}

interface GitHistoryRepoScore {
  repo: CandidateRepo;
  commitCount: number;
  branchCount: number;
  score: number;
}

/**
 * Count `<KEY>-\d+` mentions in recent `git log` subjects/bodies and local +
 * remote branch names across a repository and its worktree roots.
 *
 * Runs `git` argv-only (`execFile`) with a sanitized environment, bounded to
 * the last 2,000 commits or 180 days. Commits and branch names are deduplicated
 * across the repository's worktree roots.
 */
async function scoreRepoGitHistoryForKey(
  repo: CandidateRepo,
  projectKey: string,
  workspaces: WorkspaceRegistry,
): Promise<GitHistoryRepoScore> {
  const escapedKey = projectKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match `<KEY>-\d+` on word/token boundaries, case-insensitively.
  const issueKeyRe = new RegExp(`(?:^|[^A-Za-z0-9])${escapedKey}-\\d+(?![0-9])`, 'i');

  const matchedCommits = new Set<string>();
  const seenCommits = new Set<string>();
  const matchedBranches = new Set<string>();

  for (const treeRoot of repo.treeRoots) {
    let verifiedPath: string;
    try {
      verifiedPath = await workspaces.resolveWorkspacePath(treeRoot);
    } catch {
      continue;
    }

    const env = buildChildEnv({ cwd: verifiedPath });

    // 1. Scan recent commits (`--all`, bounded by count and age).
    try {
      const { stdout } = await execFileAsync(
        'git',
        [
          '-C',
          verifiedPath,
          'log',
          '--all',
          `--since=${GIT_LOG_SINCE}`,
          '-n',
          String(GIT_LOG_MAX_COMMITS),
          '--format=%H%x1f%s%n%b%x1e',
        ],
        {
          cwd: verifiedPath,
          env,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER_BYTES,
        },
      );

      for (const record of stdout.split('\x1e')) {
        const trimmed = record.trim();
        if (!trimmed) continue;
        const sepIdx = trimmed.indexOf('\x1f');
        if (sepIdx <= 0) continue;
        const sha = trimmed.slice(0, sepIdx).trim();
        if (!sha || seenCommits.has(sha)) continue;
        seenCommits.add(sha);
        const text = trimmed.slice(sepIdx + 1);
        if (issueKeyRe.test(text)) {
          matchedCommits.add(sha);
        }
      }
    } catch {
      // Empty repo (no commits yet) or git failure; continue to branch check.
    }

    // 2. Scan local and remote branch names.
    try {
      const { stdout } = await execFileAsync(
        'git',
        [
          '-C',
          verifiedPath,
          'for-each-ref',
          '--format=%(refname:short)',
          'refs/heads',
          'refs/remotes',
        ],
        {
          cwd: verifiedPath,
          env,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER_BYTES,
        },
      );

      for (const rawLine of stdout.split('\n')) {
        const branch = rawLine.trim();
        if (!branch || branch === 'origin/HEAD' || branch.endsWith('/HEAD')) continue;
        const normalizedBranch = branch.replace(/^origin\//, '');
        if (issueKeyRe.test(normalizedBranch)) {
          matchedBranches.add(normalizedBranch);
        }
      }
    } catch {
      // Ignore branch listing errors.
    }
  }

  const commitCount = matchedCommits.size;
  const branchCount = matchedBranches.size;
  return {
    repo,
    commitCount,
    branchCount,
    score: commitCount + branchCount,
  };
}

function formatGitHistoryEvidence(
  projectKey: string,
  top: GitHistoryRepoScore,
  second: GitHistoryRepoScore | undefined,
  ambiguousWithSecond: boolean,
): string {
  const parts: string[] = [];
  if (top.commitCount > 0) {
    parts.push(`${top.commitCount} commit${top.commitCount === 1 ? '' : 's'}`);
  }
  if (top.branchCount > 0) {
    parts.push(`${top.branchCount} branch${top.branchCount === 1 ? '' : 'es'}`);
  }
  const verb = top.commitCount === 1 && top.branchCount === 0 ? 'mentions' : 'mention';
  const lead = `${parts.join(' and ')} ${verb} ${projectKey}-`;

  if (second !== undefined && second.score > 0) {
    if (ambiguousWithSecond) {
      return `${lead} in ${path.basename(top.repo.cwd)}; next best ${second.score} in ${path.basename(second.repo.cwd)}`;
    }
    return `${lead}; next best ${second.score}`;
  }
  return `${lead}; next best 0`;
}

/**
 * Signal 2: check past runs of this webhook for the same key in
 * `webhook_deliveries` and `webhook_issue_sessions`.
 */
async function detectFromPastDeliveries(
  db: Db,
  hook: WebhookRow,
  routeKey: string,
  workspaces: WorkspaceRegistry,
  now: number,
): Promise<WebhookRouteCacheRow | null> {
  const type = hook.type as WebhookType;
  const keyUpper = routeKey.toUpperCase();

  const deliveryRows =
    type === 'bamboo'
      ? (db
          .prepare(
            `SELECT cwd FROM webhook_deliveries
              WHERE webhook_id = ?
                AND UPPER(issue_key) = ?
                AND cwd IS NOT NULL
                AND status NOT IN ('rejected', 'invalid', 'duplicate', 'filtered', 'throttled', 'skipped')
              ORDER BY received_at DESC`,
          )
          .all(hook.id, keyUpper) as { cwd: string }[])
      : (db
          .prepare(
            `SELECT cwd FROM webhook_deliveries
              WHERE webhook_id = ?
                AND UPPER(project_key) = ?
                AND cwd IS NOT NULL
                AND status NOT IN ('rejected', 'invalid', 'duplicate', 'filtered', 'throttled', 'skipped')
              ORDER BY received_at DESC`,
          )
          .all(hook.id, keyUpper) as { cwd: string }[]);

  const issueSessionRows =
    type === 'bamboo'
      ? (db
          .prepare(
            `SELECT cwd FROM webhook_issue_sessions
              WHERE webhook_id = ? AND UPPER(issue_key) = ?`,
          )
          .all(hook.id, keyUpper) as { cwd: string }[])
      : (db
          .prepare(
            `SELECT cwd FROM webhook_issue_sessions
              WHERE webhook_id = ? AND UPPER(issue_key) LIKE ?`,
          )
          .all(hook.id, `${keyUpper}-%`) as { cwd: string }[]);

  const counts = new Map<string, number>();

  for (const r of [...deliveryRows, ...issueSessionRows]) {
    if (!r.cwd) continue;
    // If a past run used a `.worktrees/<slug>` checkout, attribute it to its
    // main repository folder when that folder resolves in workspaces.
    const wtRoot = findWorktreeRoot(r.cwd);
    const candidatePath = wtRoot !== null ? path.dirname(path.dirname(wtRoot)) : treeRootOf(r.cwd);
    try {
      const resolved = await workspaces.resolveWorkspacePath(candidatePath);
      counts.set(resolved, (counts.get(resolved) ?? 0) + 1);
    } catch {
      // Stale path outside workspaces; ignore.
    }
  }

  if (counts.size === 0) return null;

  const ranked = [...counts.entries()]
    .map(([cwd, count]) => ({ cwd, count }))
    .sort((a, b) => b.count - a.count || a.cwd.localeCompare(b.cwd));

  const top = ranked[0]!;
  const second = ranked[1];

  const isUnambiguous = second === undefined;
  const evidence = isUnambiguous
    ? `${top.count} past deliver${top.count === 1 ? 'y' : 'ies'} ran in ${path.basename(top.cwd)}`
    : `past deliveries split between ${path.basename(top.cwd)} (${top.count}) and ${path.basename(second.cwd)} (${second.count})`;

  return {
    webhook_id: hook.id,
    route_key: keyUpper,
    host_id: null,
    cwd: top.cwd,
    source: 'history',
    confidence: isUnambiguous ? 'unambiguous' : 'ambiguous',
    evidence,
    detected_at: now,
    confirmed_at: null,
    confirmed_by: null,
    git_remote: await readGitOriginUrl(top.cwd),
    dismissed_at: null,
  };
}

/**
 * Find the most recent `repositoryUrl` carried by a stored Bamboo delivery
 * payload for `(webhookId, planKey)`, used when re-detecting from the editor or
 * when workspaces change.
 */
function findStoredBambooRepoUrl(db: Db, webhookId: string, planKey: string): string | null {
  const rows = db
    .prepare(
      `SELECT payload_json FROM webhook_deliveries
        WHERE webhook_id = ? AND UPPER(issue_key) = ? AND payload_json IS NOT NULL
        ORDER BY received_at DESC LIMIT 10`,
    )
    .all(webhookId, planKey.toUpperCase()) as { payload_json: string }[];

  for (const r of rows) {
    try {
      const parsed = parseBambooEvent(JSON.parse(r.payload_json));
      if (parsed.ok && parsed.facts.repositoryUrl) {
        return parsed.facts.repositoryUrl;
      }
    } catch {
      // Ignore malformed stored payloads.
    }
  }
  return null;
}

export interface DetectRouteOptions {
  db: Db;
  workspaces: WorkspaceRegistry;
  hook: WebhookRow;
  routeKey: string;
  /** Optional Bamboo repository URL from the live payload. */
  bambooRepositoryUrl?: string | null;
  /** Pre-discovered candidate repos when running batch detection. */
  candidates?: CandidateRepo[];
  /** When false, clears `dismissed_at` even if the same `cwd` is re-detected. */
  preserveDismissed?: boolean;
  now?: number;
}

/**
 * Run route detection for a single `(hook, routeKey)` in priority order:
 * 1. Git history (`<KEY>-\d+` in commits + branches for Jira; repository remote
 *    URL match for Bamboo when the payload carries a repository URL).
 * 2. Past deliveries (`webhook_deliveries` / `webhook_issue_sessions`).
 *
 * Upserts the winning candidate into `webhook_route_cache` and returns it, or
 * returns `null` if no signal matched.
 */
export async function detectRouteForKey(
  opts: DetectRouteOptions,
): Promise<WebhookRouteCacheRow | null> {
  const { db, workspaces, hook } = opts;
  const now = opts.now ?? Date.now();
  const type = hook.type as WebhookType;
  const routeKey = opts.routeKey.trim().toUpperCase();
  if (!routeKey) return null;

  if (type === 'jira' && !JIRA_PROJECT_KEY_RE.test(routeKey)) {
    return null;
  }
  if (type === 'bamboo' && !BAMBOO_PLAN_KEY_RE.test(routeKey)) {
    return null;
  }

  const candidates = opts.candidates ?? (await discoverCandidateRepos(workspaces));

  // Signal 1: Git history (Jira) or git remote match (Bamboo).
  if (type === 'jira') {
    const scores: GitHistoryRepoScore[] = [];
    for (const repo of candidates) {
      const scored = await scoreRepoGitHistoryForKey(repo, routeKey, workspaces);
      if (scored.score > 0) {
        scores.push(scored);
      }
    }
    scores.sort((a, b) => b.score - a.score || a.repo.cwd.localeCompare(b.repo.cwd));

    const top = scores[0];
    if (top !== undefined) {
      const second = scores[1];
      const hasClearMargin =
        second === undefined ||
        second.score === 0 ||
        (top.score >= second.score * UNAMBIGUOUS_MARGIN_MULTIPLIER &&
          top.score - second.score >= UNAMBIGUOUS_MIN_SCORE);
      const isUnambiguous = top.score >= UNAMBIGUOUS_MIN_SCORE && hasClearMargin;
      const ambiguousWithSecond = second !== undefined && second.score > 0 && !hasClearMargin;

      const row: WebhookRouteCacheRow = {
        webhook_id: hook.id,
        route_key: routeKey,
        host_id: null,
        cwd: top.repo.cwd,
        source: 'git-history',
        confidence: isUnambiguous ? 'unambiguous' : 'ambiguous',
        evidence: formatGitHistoryEvidence(routeKey, top, second, ambiguousWithSecond),
        detected_at: now,
        confirmed_at: null,
        confirmed_by: null,
        git_remote: top.repo.gitRemote,
        dismissed_at: null,
      };
      upsertWebhookRouteCacheEntry(db, row, { preserveDismissed: opts.preserveDismissed });
      return readWebhookRouteCacheEntry(db, hook.id, routeKey);
    }
  } else {
    const repoUrl =
      opts.bambooRepositoryUrl ?? findStoredBambooRepoUrl(db, hook.id, routeKey);
    const wantedRemote = repoUrl ? normalizeGitRemoteUrl(repoUrl) : '';
    if (wantedRemote !== '') {
      const matches = candidates.filter(
        (c) => c.gitRemote !== null && normalizeGitRemoteUrl(c.gitRemote) === wantedRemote,
      );
      if (matches.length > 0) {
        const top = matches[0]!;
        const isUnambiguous = matches.length === 1;
        const evidence = isUnambiguous
          ? `git remote matches ${repoUrl}`
          : `git remote ${repoUrl} matches multiple folders (${matches.map((m) => path.basename(m.cwd)).join(', ')})`;
        const row: WebhookRouteCacheRow = {
          webhook_id: hook.id,
          route_key: routeKey,
          host_id: null,
          cwd: top.cwd,
          source: 'git-history',
          confidence: isUnambiguous ? 'unambiguous' : 'ambiguous',
          evidence,
          detected_at: now,
          confirmed_at: null,
          confirmed_by: null,
          git_remote: top.gitRemote,
          dismissed_at: null,
        };
        upsertWebhookRouteCacheEntry(db, row, { preserveDismissed: opts.preserveDismissed });
        return readWebhookRouteCacheEntry(db, hook.id, routeKey);
      }
    }
  }

  // Signal 2: Past deliveries (`webhook_deliveries` / `webhook_issue_sessions`).
  const historyRow = await detectFromPastDeliveries(db, hook, routeKey, workspaces, now);
  if (historyRow !== null) {
    upsertWebhookRouteCacheEntry(db, historyRow, { preserveDismissed: opts.preserveDismissed });
    return readWebhookRouteCacheEntry(db, hook.id, routeKey);
  }

  return null;
}

/**
 * Discover Jira project keys mentioned in recent git history or branch names
 * across all candidate repositories so "Re-detect" in the editor can populate
 * suggestions even before the first delivery for a project arrives.
 */
async function discoverProjectKeysInRepos(
  candidates: CandidateRepo[],
  workspaces: WorkspaceRegistry,
): Promise<Set<string>> {
  const keys = new Set<string>();
  const keyExtractRe = /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9_]{1,15})-\d+(?![0-9])/g;
  // Common non-Jira prefixes that appear in commit messages (e.g. UTF-8, SHA-256, CVE-2024).
  const ignoredPrefixes = new Set([
    'UTF',
    'SHA',
    'AES',
    'RSA',
    'CVE',
    'RFC',
    'ISO',
    'HTTP',
    'TLS',
    'SSL',
    'SSH',
    'TCP',
    'UDP',
    'DNS',
    'URL',
    'URI',
    'API',
    'CLI',
    'SDK',
    'CPU',
    'GPU',
    'RAM',
    'EOF',
    'PID',
    'UID',
    'GID',
  ]);

  for (const repo of candidates) {
    for (const treeRoot of repo.treeRoots) {
      let verifiedPath: string;
      try {
        verifiedPath = await workspaces.resolveWorkspacePath(treeRoot);
      } catch {
        continue;
      }
      const env = buildChildEnv({ cwd: verifiedPath });
      try {
        const { stdout } = await execFileAsync(
          'git',
          [
            '-C',
            verifiedPath,
            'log',
            '--all',
            `--since=${GIT_LOG_SINCE}`,
            '-n',
            String(GIT_LOG_MAX_COMMITS),
            '--format=%s%n%b',
          ],
          {
            cwd: verifiedPath,
            env,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER_BYTES,
          },
        );
        let match: RegExpExecArray | null;
        while ((match = keyExtractRe.exec(stdout)) !== null) {
          const k = match[1]?.toUpperCase();
          if (k && !ignoredPrefixes.has(k) && JIRA_PROJECT_KEY_RE.test(k)) {
            keys.add(k);
          }
        }
      } catch {
        // Ignore git errors.
      }
    }
  }
  return keys;
}

/**
 * Re-detect routes for all unmapped keys associated with `hook`:
 * - keys in `webhook_route_cache`
 * - keys seen in `webhook_deliveries` or `webhook_issue_sessions`
 * - keys named in the webhook's filter (`projectKeys` / `planKeys`)
 * - for Jira webhooks, project keys discovered in workspace git history.
 *
 * Keys that already have an explicit `projectMap` / `planMap` entry are skipped.
 */
export async function detectAllRoutesForWebhook(opts: {
  db: Db;
  workspaces: WorkspaceRegistry;
  hook: WebhookRow;
  explicitKeys: ReadonlySet<string>;
  filterKeys?: readonly string[];
  preserveDismissed?: boolean;
  now?: number;
}): Promise<WebhookRouteCacheRow[]> {
  const { db, workspaces, hook } = opts;
  const type = hook.type as WebhookType;
  validateAndPruneRouteCacheSync(db, workspaces, hook.id);

  const candidates = await discoverCandidateRepos(workspaces);
  const keysToDetect = new Set<string>();

  for (const row of readWebhookRouteCache(db, hook.id)) {
    keysToDetect.add(row.route_key.toUpperCase());
  }

  for (const fk of opts.filterKeys ?? []) {
    if (fk.trim()) keysToDetect.add(fk.trim().toUpperCase());
  }

  if (type === 'bamboo') {
    const dRows = db
      .prepare(
        `SELECT DISTINCT issue_key FROM webhook_deliveries
          WHERE webhook_id = ? AND issue_key IS NOT NULL`,
      )
      .all(hook.id) as { issue_key: string }[];
    for (const r of dRows) keysToDetect.add(r.issue_key.toUpperCase());
  } else {
    const dRows = db
      .prepare(
        `SELECT DISTINCT project_key FROM webhook_deliveries
          WHERE webhook_id = ? AND project_key IS NOT NULL`,
      )
      .all(hook.id) as { project_key: string }[];
    for (const r of dRows) keysToDetect.add(r.project_key.toUpperCase());

    const repoKeys = await discoverProjectKeysInRepos(candidates, workspaces);
    for (const rk of repoKeys) keysToDetect.add(rk);
  }

  for (const explicit of opts.explicitKeys) {
    keysToDetect.delete(explicit.toUpperCase());
  }

  for (const key of keysToDetect) {
    const matched = await detectRouteForKey({
      db,
      workspaces,
      hook,
      routeKey: key,
      candidates,
      preserveDismissed: opts.preserveDismissed,
      now: opts.now,
    });
    if (matched === null) {
      deleteWebhookRouteCacheEntry(db, hook.id, key);
    }
  }

  return validateAndPruneRouteCacheSync(db, workspaces, hook.id);
}
