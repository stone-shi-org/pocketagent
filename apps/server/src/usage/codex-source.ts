import type { AgentUsageInfo } from '@pocketagent/protocol';
import type { CodexServerManager } from '../sessions/codex-server.js';
import { formatResetLabel, formatWindowLabel } from './format.js';
import { createPolled, type Polled } from './poll.js';

const DEFAULT_REFRESH_MS = 5 * 60 * 1000;

interface RateLimitWindow {
  usedPercent?: number;
  /** Minutes. 10080 = 7 days, 300 = 5 hours, etc. */
  windowDurationMins?: number;
  /** Unix seconds. Codex hands back a bare timestamp, no display string. */
  resetsAt?: number;
}

interface RateLimitsReadResult {
  rateLimits?: {
    primary?: RateLimitWindow | null;
    secondary?: RateLimitWindow | null;
  } | null;
}

function unavailable(error: string | null = null): AgentUsageInfo {
  return {
    agent: 'codex',
    agentDisplayName: 'Codex',
    available: false,
    percentUsed: null,
    windowLabel: null,
    resetsAtLabel: null,
    timezone: null,
    error,
    updatedAt: new Date().toISOString(),
  };
}

export interface CodexUsageSourceOptions {
  /**
   * Returns the same shared `codex app-server` process a real Codex session
   * would use, starting it on first call — see
   * `SessionManager.getCodexServerForUsage`. Null when Codex has no
   * executable configured at all, mirroring `AgentInfo.available`.
   */
  getServer: () => CodexServerManager | null;
  logger?: { warn: (o: object, m?: string) => void };
  refreshMs?: number;
}

/**
 * Reads OpenAI's own `account/rateLimits/read` RPC over the same JSON-RPC
 * connection a real Codex session drives (see `CodexServerManager`). Unlike
 * Claude's `/usage`, this is structured data straight from the API rather
 * than parsed terminal prose — confirmed live against codex-cli 0.147.0:
 * `{ rateLimits: { primary: { usedPercent, windowDurationMins, resetsAt } } }`.
 * `secondary` is a second, differently-sized window (e.g. a short session
 * limit alongside a weekly one) when the account has one; `primary` is shown
 * whenever both are absent-or-present, since it is the one always populated.
 *
 * Reusing the shared server means the very first Codex usage poll on a fresh
 * boot pays the cost of starting `codex app-server` — see the "Codex usage
 * source" decision this shipped with: that process then stays up in the
 * background, same tradeoff already accepted for the opencode server and the
 * tmux backend.
 */
export function createCodexUsageSource(opts: CodexUsageSourceOptions): Polled<AgentUsageInfo> {
  return createPolled(unavailable(), opts.refreshMs ?? DEFAULT_REFRESH_MS, async () => {
    try {
      const server = opts.getServer();
      if (!server) return unavailable('The "Codex" executable was not found on PATH.');

      const result = await server.sendRequest<RateLimitsReadResult>('account/rateLimits/read', {});
      const window = result.rateLimits?.primary ?? result.rateLimits?.secondary;
      if (!window || typeof window.usedPercent !== 'number') {
        return unavailable('Codex reported no rate-limit window.');
      }

      const resetsAt = typeof window.resetsAt === 'number' ? new Date(window.resetsAt * 1000) : null;
      return {
        agent: 'codex',
        agentDisplayName: 'Codex',
        available: true,
        percentUsed: Math.max(0, Math.min(100, Math.round(window.usedPercent))),
        windowLabel:
          typeof window.windowDurationMins === 'number'
            ? formatWindowLabel(window.windowDurationMins)
            : null,
        resetsAtLabel: resetsAt ? formatResetLabel(resetsAt) : null,
        timezone: resetsAt ? Intl.DateTimeFormat().resolvedOptions().timeZone : null,
        error: null,
        updatedAt: new Date().toISOString(),
      };
    } catch (err) {
      opts.logger?.warn({ err }, 'failed to refresh Codex usage');
      return unavailable(err instanceof Error ? err.message : 'Unknown error refreshing usage.');
    }
  });
}
