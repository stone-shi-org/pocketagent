import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentUsageInfo, UsageWindowInfo } from '@pocketagent/protocol';
import { buildChildEnv } from '../sessions/env.js';
import { formatResetLabel } from './format.js';
import { createPolled, type Polled } from './poll.js';

const execFileAsync = promisify(execFile);

/** Rate limits reset in hours, not seconds — polling faster buys nothing. */
const DEFAULT_REFRESH_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 15_000;

// Field names match the CLI's own JSON verbatim (snake_case), not this
// codebase's style — this is wire data, not something we author.
interface UsageBucket {
  name?: string;
  window?: string;
  remaining_fraction?: number;
  /** ISO 8601. */
  reset_time?: string;
}
interface UsageGroup {
  name?: string;
  buckets?: UsageBucket[];
}
interface UsageCommandResult {
  command?: { data?: { groups?: UsageGroup[] } };
}

type GroupedBucket = UsageBucket & { groupName?: string };

/**
 * One `UsageWindowInfo` from a set of buckets that are all the same window
 * type (5h or weekly) — normally one bucket per group, but reduced to the
 * worst rather than just taking `[0]` in case a future `/usage` shape ever
 * reports more than one per group per type.
 */
function buildWindow(buckets: GroupedBucket[], fallbackWindow: string): UsageWindowInfo {
  const worst = buckets.reduce((a, b) =>
    (b.remaining_fraction as number) < (a.remaining_fraction as number) ? b : a,
  );
  const resetsAt = worst.reset_time ? new Date(worst.reset_time) : null;
  const validResetsAt = resetsAt && !Number.isNaN(resetsAt.getTime()) ? resetsAt : null;
  return {
    label: [worst.groupName, worst.window || fallbackWindow].filter(Boolean).join(' '),
    percentUsed: Math.max(0, Math.min(100, Math.round((1 - (worst.remaining_fraction as number)) * 100))),
    resetsAtLabel: validResetsAt ? formatResetLabel(validResetsAt) : null,
    timezone: validResetsAt ? Intl.DateTimeFormat().resolvedOptions().timeZone : null,
  };
}

function unavailable(error: string | null = null): AgentUsageInfo {
  return {
    agent: 'agy',
    agentDisplayName: 'Antigravity CLI',
    available: false,
    percentUsed: null,
    windowLabel: null,
    resetsAtLabel: null,
    timezone: null,
    windows: [],
    error,
    updatedAt: new Date().toISOString(),
  };
}

export interface AgyUsageSourceOptions {
  /** Same binary sessions use, e.g. `agy` or an absolute path. */
  agyBin: string;
  /** Directory the CLI is invoked from. Irrelevant to /usage but required by execFile. */
  cwd: string;
  logger?: { warn: (o: object, m?: string) => void };
  refreshMs?: number;
}

export function createAgyUsageSource(opts: AgyUsageSourceOptions): Polled<AgentUsageInfo> {
  return createPolled(unavailable(), opts.refreshMs ?? DEFAULT_REFRESH_MS, async () => {
    try {
      const { stdout } = await execFileAsync(
        opts.agyBin,
        ['-p', '/usage', '--output-format', 'json'],
        {
          cwd: opts.cwd,
          env: buildChildEnv({ cwd: opts.cwd }),
          timeout: TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        },
      );
      const parsed = JSON.parse(stdout) as UsageCommandResult;
      const groups = parsed.command?.data?.groups ?? [];
      const buckets = groups.flatMap((group) =>
        (group.buckets ?? [])
          .filter((b) => typeof b.remaining_fraction === 'number')
          .map((b) => ({ ...b, groupName: group.name })),
      );
      if (buckets.length === 0) {
        return unavailable('Could not find a usage bucket in `agy /usage` output.');
      }

      // Antigravity multiplexes quota across model families — confirmed live,
      // `/usage` returns separate groups like "Gemini Models" and "Claude and
      // GPT models", each with its own 5h/weekly buckets. Collapsing to a
      // single worst-of-all-groups window (the original approach here) hid a
      // whole group's quota whenever another group was more depleted — a
      // healthy non-Gemini allowance read as if it didn't exist. One window
      // per (group, window-type) pair instead, so every group gets its own bar.
      const windows: UsageWindowInfo[] = [];
      const groupNames = [
        ...new Set(buckets.map((b) => b.groupName).filter((n): n is string => Boolean(n))),
      ];
      // Buckets with no group name at all (an older/simpler `/usage` shape)
      // are still one implicit group, so the loop below runs at least once.
      for (const groupName of groupNames.length > 0 ? groupNames : [undefined]) {
        const groupBuckets = groupName ? buckets.filter((b) => b.groupName === groupName) : buckets;
        const fiveHour = groupBuckets.filter(
          (b) => b.window === '5h' || /5h|5-hour|five hour/i.test(b.window || b.name || ''),
        );
        const weekly = groupBuckets.filter(
          (b) => b.window === 'weekly' || /weekly|7day|7-day/i.test(b.window || b.name || ''),
        );
        if (fiveHour.length > 0) windows.push(buildWindow(fiveHour, '5h'));
        if (weekly.length > 0) windows.push(buildWindow(weekly, 'weekly'));
      }

      // Nothing matched the 5h/weekly patterns at all (an unrecognized
      // `/usage` shape) — still surface the single worst bucket rather than
      // an empty windows list.
      if (windows.length === 0) windows.push(buildWindow(buckets, 'Limit'));

      // The compact top-level summary (used where there is only room for one
      // number, e.g. the fleet list) stays the single worst bucket across
      // every group — `windows` above is what shows each group separately.
      const overall = buildWindow(buckets, 'Limit');

      return {
        agent: 'agy',
        agentDisplayName: 'Antigravity CLI',
        available: true,
        percentUsed: overall.percentUsed,
        windowLabel: overall.label || null,
        resetsAtLabel: overall.resetsAtLabel,
        timezone: overall.timezone,
        windows,
        error: null,
        updatedAt: new Date().toISOString(),
      };
    } catch (err) {
      opts.logger?.warn({ err }, 'failed to refresh Antigravity CLI usage');
      return unavailable(err instanceof Error ? err.message : 'Unknown error refreshing usage.');
    }
  });
}
