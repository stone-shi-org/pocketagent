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

      const windows: UsageWindowInfo[] = [];
      const fiveHourBuckets = buckets.filter(
        (b) => b.window === '5h' || /5h|5-hour|five hour/i.test(b.window || b.name || ''),
      );
      const weeklyBuckets = buckets.filter(
        (b) => b.window === 'weekly' || /weekly|7day|7-day/i.test(b.window || b.name || ''),
      );

      if (fiveHourBuckets.length > 0) {
        const worst5h = fiveHourBuckets.reduce((a, b) =>
          (b.remaining_fraction as number) < (a.remaining_fraction as number) ? b : a,
        );
        const resetsAt = worst5h.reset_time ? new Date(worst5h.reset_time) : null;
        const validResetsAt = resetsAt && !Number.isNaN(resetsAt.getTime()) ? resetsAt : null;
        windows.push({
          label: [worst5h.groupName, worst5h.window || '5h'].filter(Boolean).join(' '),
          percentUsed: Math.max(
            0,
            Math.min(100, Math.round((1 - (worst5h.remaining_fraction as number)) * 100)),
          ),
          resetsAtLabel: validResetsAt ? formatResetLabel(validResetsAt) : null,
          timezone: validResetsAt ? Intl.DateTimeFormat().resolvedOptions().timeZone : null,
        });
      }

      if (weeklyBuckets.length > 0) {
        const worstWeekly = weeklyBuckets.reduce((a, b) =>
          (b.remaining_fraction as number) < (a.remaining_fraction as number) ? b : a,
        );
        const resetsAt = worstWeekly.reset_time ? new Date(worstWeekly.reset_time) : null;
        const validResetsAt = resetsAt && !Number.isNaN(resetsAt.getTime()) ? resetsAt : null;
        windows.push({
          label: [worstWeekly.groupName, worstWeekly.window || 'weekly'].filter(Boolean).join(' '),
          percentUsed: Math.max(
            0,
            Math.min(100, Math.round((1 - (worstWeekly.remaining_fraction as number)) * 100)),
          ),
          resetsAtLabel: validResetsAt ? formatResetLabel(validResetsAt) : null,
          timezone: validResetsAt ? Intl.DateTimeFormat().resolvedOptions().timeZone : null,
        });
      }

      if (windows.length === 0) {
        const worst = buckets.reduce((a, b) =>
          (b.remaining_fraction as number) < (a.remaining_fraction as number) ? b : a,
        );
        const resetsAt = worst.reset_time ? new Date(worst.reset_time) : null;
        const validResetsAt = resetsAt && !Number.isNaN(resetsAt.getTime()) ? resetsAt : null;
        windows.push({
          label: [worst.groupName, worst.window].filter(Boolean).join(' ') || 'Limit',
          percentUsed: Math.max(
            0,
            Math.min(100, Math.round((1 - (worst.remaining_fraction as number)) * 100)),
          ),
          resetsAtLabel: validResetsAt ? formatResetLabel(validResetsAt) : null,
          timezone: validResetsAt ? Intl.DateTimeFormat().resolvedOptions().timeZone : null,
        });
      }

      const worstOverall = buckets.reduce((a, b) =>
        (b.remaining_fraction as number) < (a.remaining_fraction as number) ? b : a,
      );
      const resetsAt = worstOverall.reset_time ? new Date(worstOverall.reset_time) : null;
      const validResetsAt = resetsAt && !Number.isNaN(resetsAt.getTime()) ? resetsAt : null;

      return {
        agent: 'agy',
        agentDisplayName: 'Antigravity CLI',
        available: true,
        percentUsed: Math.max(
          0,
          Math.min(100, Math.round((1 - (worstOverall.remaining_fraction as number)) * 100)),
        ),
        windowLabel: [worstOverall.groupName, worstOverall.window].filter(Boolean).join(' ') || null,
        resetsAtLabel: validResetsAt ? formatResetLabel(validResetsAt) : null,
        timezone: validResetsAt ? Intl.DateTimeFormat().resolvedOptions().timeZone : null,
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
