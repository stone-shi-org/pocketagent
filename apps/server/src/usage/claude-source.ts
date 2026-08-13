import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentUsageInfo } from '@pocketagent/protocol';
import { buildChildEnv } from '../sessions/env.js';
import { createPolled, type Polled } from './poll.js';

const execFileAsync = promisify(execFile);

/** Rate limits reset in hours, not seconds — polling faster buys nothing. */
const DEFAULT_REFRESH_MS = 5 * 60 * 1000;
/** `claude -p "/usage"` answers from local telemetry; a hang means something's wrong. */
const TIMEOUT_MS = 15_000;

// Matches the one line `/usage` prints that this feature cares about, e.g.
// "Current session: 46% used · resets Aug 13, 4:29pm (America/Los_Angeles)".
// The rest of the command's output (the "what's contributing" breakdown) is
// not parsed: it is prose meant for a human reading a terminal, not a stable
// field to key UI off.
const USAGE_LINE = /Current session:\s*(\d+)%\s*used\s*·\s*resets\s+(.+?)\s*\(([^)]+)\)/;

function unavailable(error: string | null = null): AgentUsageInfo {
  return {
    agent: 'claude',
    agentDisplayName: 'Claude',
    available: false,
    percentUsed: null,
    windowLabel: null,
    resetsAtLabel: null,
    timezone: null,
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

/**
 * Polls Claude Code's own `/usage` slash command for this machine's
 * subscription rate-limit status, so the browser can show it without the
 * user having to open a terminal and type `/usage` themselves.
 *
 * `claude -p "/usage" --output-format json` runs the command non-interactively
 * and returns in well under a second because it reads local session telemetry
 * rather than calling the API (`total_cost_usd` and `duration_api_ms` are both
 * 0). That is what makes a background poll acceptable here despite it being a
 * real subprocess spawn: it is cheap, and every request after the first one
 * reads a cache rather than spawning anything itself — see `createPolled`.
 */
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

      const match = USAGE_LINE.exec(text);
      if (!match) return unavailable('Could not find a usage line in `claude /usage` output.');

      // All three groups are non-optional in USAGE_LINE, so a match guarantees
      // they matched something — TS just can't see that through a regex.
      const [, percent = '', resetsAtLabel = '', timezone = ''] = match;
      return {
        agent: 'claude',
        agentDisplayName: 'Claude',
        available: true,
        percentUsed: Number(percent),
        windowLabel: null,
        resetsAtLabel: resetsAtLabel.trim(),
        timezone: timezone.trim(),
        error: null,
        updatedAt: new Date().toISOString(),
      };
    } catch (err) {
      opts.logger?.warn({ err }, 'failed to refresh Claude usage');
      return unavailable(err instanceof Error ? err.message : 'Unknown error refreshing usage.');
    }
  });
}
