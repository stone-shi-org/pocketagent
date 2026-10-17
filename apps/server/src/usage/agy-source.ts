import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentUsageInfo, UsageWindowInfo } from '@pocketagent/protocol';
import { agyFileTokenStorageEnv } from '../agents/agy.js';
import { buildChildEnv } from '../sessions/env.js';
import { formatResetLabel } from './format.js';
import { createPolled, type Polled } from './poll.js';
import { usageProbeCwd } from './probe-cwd.js';

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

const AGY_MODEL_TIERS = ['Pro', 'Flash', 'Flash Lite', 'Third-Party'] as const;
type AgyModelTier = (typeof AGY_MODEL_TIERS)[number];

/**
 * Maps `agy /usage`'s per-model groups (`"Gemini Pro Next"`, `"Gemini 3.1 Pro"`,
 * `"Gemini Teamfood Models"`, `"Gemini Flash"`, `"Gemini Flash Next"`,
 * `"Gemini Flash Lite"`, `"Third-Party Models"`) onto the four canonical model
 * tiers surfaced in the gauge ring and expanded panel (PA-156). Returns `null`
 * for legacy or unrecognized group names (such as the older `"Gemini Models"` /
 * `"Claude and GPT models"` 5h+weekly shape) so they keep their verbatim label.
 */
function classifyAgyTier(groupName: string | undefined): AgyModelTier | null {
  if (!groupName) return null;
  if (/flash[\s-]*li(?:te|ght)/i.test(groupName)) return 'Flash Lite';
  if (/flash/i.test(groupName)) return 'Flash';
  if (/\bpro\b|teamfood/i.test(groupName)) return 'Pro';
  if (/third[\s-]*party|\b3p\b/i.test(groupName)) return 'Third-Party';
  return null;
}

/**
 * One `UsageWindowInfo` from a set of buckets that share a group and window
 * type — reduced to the most depleted bucket so a tier backed by multiple raw
 * CLI groups (e.g. `"Gemini Pro Next"` and `"Gemini 3.1 Pro"`) surfaces the
 * active quota rather than an unused sibling's 0% bar.
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
  logger?: { warn: (o: object, m?: string) => void };
  refreshMs?: number;
}

export function createAgyUsageSource(opts: AgyUsageSourceOptions): Polled<AgentUsageInfo> {
  return createPolled(unavailable(), opts.refreshMs ?? DEFAULT_REFRESH_MS, async () => {
    // Never a workspace directory: every invocation leaves a transcript behind
    // in the agent's own history, keyed by this path. See probe-cwd.ts.
    const cwd = usageProbeCwd();
    try {
      const { stdout } = await execFileAsync(
        opts.agyBin,
        ['-p', '/usage', '--output-format', 'json'],
        {
          cwd,
          env: buildChildEnv({ cwd, overrides: agyFileTokenStorageEnv() }),
          timeout: TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        },
      );
      const parsed = JSON.parse(stdout) as UsageCommandResult;
      const groups = parsed.command?.data?.groups ?? [];
      const buckets = groups.flatMap((group) => {
        const groupName = classifyAgyTier(group.name) ?? group.name;
        return (group.buckets ?? [])
          .filter((b) => typeof b.remaining_fraction === 'number')
          .map((b) => ({ ...b, groupName }));
      });
      if (buckets.length === 0) {
        return unavailable('Could not find a usage bucket in `agy /usage` output.');
      }

      // Antigravity multiplexes quota across model tiers (`Pro`, `Flash`,
      // `Flash Lite`, `Third-Party`, each with a 20h bucket in current CLI
      // releases, or `5h`/`weekly` per family in older ones). Emit one window
      // per (tier/group, window-type) pair in canonical tier order so both the
      // 4-ring gauge and the expanded panel show every tier in lockstep.
      const windows: UsageWindowInfo[] = [];
      const rawGroupNames = [
        ...new Set(buckets.map((b) => b.groupName).filter((n): n is string => Boolean(n))),
      ];
      const groupNames = [
        ...AGY_MODEL_TIERS.filter((tier) => rawGroupNames.includes(tier)),
        ...rawGroupNames.filter((name) => !AGY_MODEL_TIERS.includes(name as AgyModelTier)),
      ];
      const isFiveHour = (b: GroupedBucket) =>
        b.window === '5h' || /5h|5-hour|five hour/i.test(b.window || b.name || '');
      const isWeekly = (b: GroupedBucket) =>
        b.window === 'weekly' || /weekly|7day|7-day/i.test(b.window || b.name || '');

      // Buckets with no group name at all (an older/simpler `/usage` shape)
      // are still one implicit group, so the loop below runs at least once.
      for (const groupName of groupNames.length > 0 ? groupNames : [undefined]) {
        const groupBuckets = groupName ? buckets.filter((b) => b.groupName === groupName) : buckets;
        const fiveHour = groupBuckets.filter(isFiveHour);
        const weekly = groupBuckets.filter(isWeekly);
        if (fiveHour.length > 0) windows.push(buildWindow(fiveHour, '5h'));
        if (weekly.length > 0) windows.push(buildWindow(weekly, 'weekly'));

        const otherBuckets = groupBuckets.filter((b) => !isFiveHour(b) && !isWeekly(b));
        const otherWindowTypes = [...new Set(otherBuckets.map((b) => b.window || 'Limit'))];
        for (const win of otherWindowTypes) {
          const matching = otherBuckets.filter((b) => (b.window || 'Limit') === win);
          if (matching.length > 0) windows.push(buildWindow(matching, win));
        }
      }

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
