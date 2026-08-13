import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentUsageInfo } from '@pocketagent/protocol';
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

/**
 * Reads Antigravity CLI's own `/usage` slash command — intercepted locally in
 * print mode the same way Claude's `/usage` is (see `--disable-slash-commands`
 * in `agy --help`), confirmed live against agy 1.1.12:
 * `agy -p "/usage" --output-format json` answers in structured JSON with
 * `usage.total_tokens: 0` and `num_turns: 0`, so — like Claude and Codex — a
 * background poll never touches the model or the network.
 *
 * Unlike Claude and Codex, agy has no single quota number: usage splits into
 * named groups (model families — "Gemini Models" vs "Claude and GPT models")
 * each with its own weekly and 5-hour window, so a session can be nowhere
 * near one limit and about to hit another depending which models it uses.
 * This surfaces the single most-depleted bucket across every group as the
 * headline — the one that will actually stop you next — labelled with which
 * group and window it came from (`windowLabel`, e.g. "Gemini Models weekly").
 * The rest are not shown; a four-number breakdown does not fit the one-line
 * status area every other agent gets here, and the one number that matters
 * is the one closest to zero.
 */
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

      const worst = buckets.reduce((a, b) =>
        (b.remaining_fraction as number) < (a.remaining_fraction as number) ? b : a,
      );
      const resetsAt = worst.reset_time ? new Date(worst.reset_time) : null;
      const validResetsAt = resetsAt && !Number.isNaN(resetsAt.getTime()) ? resetsAt : null;

      return {
        agent: 'agy',
        agentDisplayName: 'Antigravity CLI',
        available: true,
        percentUsed: Math.max(
          0,
          Math.min(100, Math.round((1 - (worst.remaining_fraction as number)) * 100)),
        ),
        windowLabel: [worst.groupName, worst.window].filter(Boolean).join(' ') || null,
        resetsAtLabel: validResetsAt ? formatResetLabel(validResetsAt) : null,
        timezone: validResetsAt ? Intl.DateTimeFormat().resolvedOptions().timeZone : null,
        error: null,
        updatedAt: new Date().toISOString(),
      };
    } catch (err) {
      opts.logger?.warn({ err }, 'failed to refresh Antigravity CLI usage');
      return unavailable(err instanceof Error ? err.message : 'Unknown error refreshing usage.');
    }
  });
}
