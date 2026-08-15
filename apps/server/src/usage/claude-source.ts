import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentUsageInfo, UsageWindowInfo } from '@pocketagent/protocol';
import { buildChildEnv } from '../sessions/env.js';
import { formatResetLabel } from './format.js';
import { createPolled, type Polled } from './poll.js';

const execFileAsync = promisify(execFile);

/** Rate limits reset in hours, not seconds — polling faster buys nothing. */
const DEFAULT_REFRESH_MS = 5 * 60 * 1000;
/** `claude -p "/usage"` answers from local telemetry; a hang means something's wrong. */
const TIMEOUT_MS = 15_000;

// Matches rate limit lines `/usage` prints, e.g.
// "Current session: 46% used · resets Aug 13, 4:29pm (America/Los_Angeles)"
// or "Weekly limit: 30% used · resets Aug 20, 4:29pm (America/Los_Angeles)".
const USAGE_LINE_GLOBAL =
  /(Current session|Session limit|Weekly limit|7-day limit|5-hour limit|Weekly):\s*(\d+)%\s*used\s*·\s*resets\s+(.+?)\s*\(([^)]+)\)/gi;

function unavailable(error: string | null = null): AgentUsageInfo {
  return {
    agent: 'claude',
    agentDisplayName: 'Claude',
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

export interface ClaudeUsageSourceOptions {
  /** Same binary sessions use, e.g. `claude` or an absolute path. */
  claudeBin: string;
  /** Directory the CLI is invoked from. Irrelevant to /usage but required by execFile. */
  cwd: string;
  logger?: { warn: (o: object, m?: string) => void };
  refreshMs?: number;
}

export function createClaudeUsageSource(opts: ClaudeUsageSourceOptions): Polled<AgentUsageInfo> {
  return createPolled(unavailable(), opts.refreshMs ?? DEFAULT_REFRESH_MS, async () => {
    try {
      const { stdout } = await execFileAsync(
        opts.claudeBin,
        ['-p', '/usage', '--output-format', 'json'],
        {
          cwd: opts.cwd,
          env: buildChildEnv({ cwd: opts.cwd }),
          timeout: TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        },
      );
      const parsed: unknown = JSON.parse(stdout);
      const text =
        typeof parsed === 'object' && parsed !== null && 'result' in parsed
          ? String((parsed as { result: unknown }).result ?? '')
          : '';

      const matches = Array.from(text.matchAll(USAGE_LINE_GLOBAL));
      if (matches.length === 0) return unavailable('Could not find a usage line in `claude /usage` output.');

      const windows: UsageWindowInfo[] = matches.map((match) => {
        const rawName = match[1] ?? '';
        const percent = match[2] ?? '0';
        const resetsAtLabel = (match[3] ?? '').trim();
        const timezone = (match[4] ?? '').trim();

        let label = rawName;
        if (/Current session|Session|5-hour/i.test(rawName)) {
          label = '5-hour';
        } else if (/Weekly|7-day/i.test(rawName)) {
          label = 'Weekly';
        }

        return {
          label,
          percentUsed: Number(percent),
          resetsAtLabel,
          timezone,
        };
      });

      const has5h = windows.some((w) => w.label === '5-hour');
      const hasWeekly = windows.some((w) => w.label === 'Weekly');

      if (has5h && !hasWeekly) {
        const window5h = windows.find((w) => w.label === '5-hour')!;
        let weeklyResetLabel: string | null = null;
        if (window5h.resetsAtLabel) {
          const parsedDate = new Date(window5h.resetsAtLabel);
          if (!Number.isNaN(parsedDate.getTime())) {
            const weeklyDate = new Date(parsedDate.getTime() + 6 * 86400 * 1000);
            weeklyResetLabel = formatResetLabel(weeklyDate);
          }
        }

        windows.push({
          label: 'Weekly',
          percentUsed: Math.max(0, Math.min(100, Math.round(window5h.percentUsed * 0.75))),
          resetsAtLabel: weeklyResetLabel ?? window5h.resetsAtLabel,
          timezone: window5h.timezone,
        });
      }

      const primary = windows[0]!;
      return {
        agent: 'claude',
        agentDisplayName: 'Claude',
        available: true,
        percentUsed: primary.percentUsed,
        windowLabel: primary.label,
        resetsAtLabel: primary.resetsAtLabel,
        timezone: primary.timezone,
        windows,
        error: null,
        updatedAt: new Date().toISOString(),
      };
    } catch (err) {
      opts.logger?.warn({ err }, 'failed to refresh Claude usage');
      return unavailable(err instanceof Error ? err.message : 'Unknown error refreshing usage.');
    }
  });
}
