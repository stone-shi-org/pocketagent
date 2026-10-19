import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentUsageInfo, UsageWindowInfo } from '@pocketagent/protocol';
import { buildChildEnv } from '../sessions/env.js';
import { createPolled, type Polled } from './poll.js';
import { usageProbeCwd } from './probe-cwd.js';

const execFileAsync = promisify(execFile);

/** Rate limits reset in hours, not seconds — polling faster buys nothing. */
const DEFAULT_REFRESH_MS = 5 * 60 * 1000;
/** `claude -p "/usage"` answers from local telemetry; a hang means something's wrong. */
const TIMEOUT_MS = 15_000;

// Matches rate limit lines `/usage` prints, e.g.
// "Current session: 46% used · resets Aug 13, 4:29pm (America/Los_Angeles)",
// "Weekly limit: 30% used · resets Aug 20, 4:29pm (America/Los_Angeles)" or
// "Current week (all models): 30% used · resets …". The parenthesised scope of
// a "Current week" line is captured so a per-model weekly limit stays
// distinguishable from the all-models one.
const USAGE_LINE_GLOBAL =
  /(Current session|Session limit|Current week(?:\s*\(([^)]*)\))?|Weekly limit|7-day limit|5-hour limit|Weekly):\s*(\d+)%\s*used\s*·\s*resets\s+(.+?)\s*\(([^)]+)\)/gi;

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
  logger?: { warn: (o: object, m?: string) => void };
  refreshMs?: number;
}

export function createClaudeUsageSource(opts: ClaudeUsageSourceOptions): Polled<AgentUsageInfo> {
  return createPolled(unavailable(), opts.refreshMs ?? DEFAULT_REFRESH_MS, async () => {
    // Never a workspace directory: every invocation leaves a transcript behind
    // in the agent's own history, keyed by this path. See probe-cwd.ts.
    const cwd = usageProbeCwd();
    try {
      const { stdout } = await execFileAsync(
        opts.claudeBin,
        ['-p', '/usage', '--output-format', 'json'],
        {
          cwd,
          env: buildChildEnv({ cwd }),
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
        const scope = (match[2] ?? '').trim();
        const percent = match[3] ?? '0';
        const resetsAtLabel = (match[4] ?? '').trim();
        const timezone = (match[5] ?? '').trim();

        let label = rawName;
        if (/Current session|Session|5-hour/i.test(rawName)) {
          label = '5-hour';
        } else if (/Weekly|7-day|Current week/i.test(rawName)) {
          label = scope && !/^all models$/i.test(scope) ? `Weekly (${scope})` : 'Weekly';
        }

        return {
          label,
          percentUsed: Number(percent),
          resetsAtLabel,
          timezone,
        };
      });

      // Only windows `/usage` actually printed are reported (PA-162). This
      // used to synthesize a "Weekly" window (75% of the session figure, reset
      // = session reset + 6 days) whenever none was printed, on the assumption
      // that every account has one. It doesn't: an Enterprise seat can have a
      // session limit and no weekly cap at all, and the invented bar then
      // reads as a real limit. Codex's synthetic 5-hour window was removed for
      // the same reason (see `codex-source.ts`); `collapsedWindows()` in
      // `UsageBar.tsx` already copes with a single window.

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
