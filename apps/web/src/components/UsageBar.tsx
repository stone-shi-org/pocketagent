import { useCallback, useEffect, useState } from 'react';
import type { AgentUsageInfo, UsageWindowInfo } from '@pocketagent/protocol';
import { api } from '../api/client.js';
import { Icon } from './Icon.js';

/**
 * The server refreshes its own cache every few minutes (one timer per agent
 * source — see `UsageService`); polling faster than that here would only
 * ever re-fetch the same snapshot.
 */
const POLL_MS = 60_000;

/**
 * Rate-limit readings per agent that knows how to report its own — today
 * Claude, Codex, and agy. Polled from `GET /api/usage`, which always answers from a
 * server-side cache, so, unlike `useProjects`, a failure here never surfaces
 * as an error banner: this is a nicety next to the host chip, not something
 * the rest of the app depends on, and an agent whose usage could not be read
 * (missing binary, not on a metered plan) is not something the user needs an
 * alert for — its bar just does not appear.
 */
export function useUsage(): AgentUsageInfo[] | null {
  const [usage, setUsage] = useState<AgentUsageInfo[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      setUsage((await api.getUsage()).usage);
    } catch {
      // Silently ignored — see the doc comment above.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return usage;
}

/** Above which a bar's colour starts warning that a reset is worth watching for. */
const WARN_AT = 80;
const DANGER_AT = 95;

/**
 * Matches a Claude/Codex `"5-hour"` label or an agy `"... 5h"` one (agy bakes
 * its model-group name into the label — see `agy-source.ts` — so this must
 * match the suffix, not the whole string).
 */
const FIVE_HOUR_RE = /\b5[\s-]?h(?:our)?s?\b/i;

/**
 * The window(s) shown while a group is collapsed (the default state — see
 * `UsageAgentGroup`): just the 5-hour one, since it resets soon enough to be
 * worth a glance without tapping anything, while the weekly number is one
 * tap away behind the expand arrow. agy additionally multiplexes quota
 * across model families into separate windows (Gemini, Claude/GPT, ... — see
 * `agy-source.ts`); showing all of their 5-hour windows by default would be
 * as many bars as expanded, so collapsed agy narrows further to the Gemini
 * group specifically, since that's the model family actually in play for a
 * typical agy session.
 *
 * Exported so the label-matching rules are unit-tested without rendering the
 * component — same pattern as `filterSlashCommands` in PromptBox.tsx.
 */
export function collapsedWindows(usage: AgentUsageInfo, windows: UsageWindowInfo[]): UsageWindowInfo[] {
  const fiveHour = windows.filter((w) => FIVE_HOUR_RE.test(w.label));
  if (usage.agent !== 'agy') return fiveHour.length > 0 ? fiveHour : windows;
  const gemini5h = fiveHour.filter((w) => /gemini/i.test(w.label));
  return gemini5h.length > 0 ? gemini5h : fiveHour.length > 0 ? fiveHour : windows;
}

/**
 * Progress bars per agent in the status area: percent of rate-limit window(s)
 * used (5-hour, weekly, etc.), labelled by agent and window, and when it resets.
 * Renders nothing while loading and nothing for an agent whose usage could not be read.
 */
export function UsageBar(): JSX.Element | null {
  const usage = useUsage();
  const rows =
    usage?.filter(
      (u) =>
        u.available &&
        ((u.windows && u.windows.length > 0) || u.percentUsed !== null),
    ) ?? [];
  if (rows.length === 0) return null;

  return (
    <div className="usage-bars">
      {rows.map((u) => (
        <UsageAgentGroup key={u.agent} usage={u} />
      ))}
    </div>
  );
}

function UsageAgentGroup({ usage }: { usage: AgentUsageInfo }): JSX.Element {
  // Collapsed by default: a glanceable 5-hour number beats four bars per
  // agent taking over the sidebar every time this renders.
  const [expanded, setExpanded] = useState(false);
  const windows: UsageWindowInfo[] =
    usage.windows && usage.windows.length > 0
      ? usage.windows
      : usage.percentUsed !== null
        ? [
            {
              label: usage.windowLabel ?? '',
              percentUsed: usage.percentUsed,
              resetsAtLabel: usage.resetsAtLabel,
              timezone: usage.timezone,
            },
          ]
        : [];
  const visible = expanded ? windows : collapsedWindows(usage, windows);

  return (
    <div className="usage-agent-group">
      <button
        type="button"
        className="usage-agent-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={`${usage.agentDisplayName} usage — ${expanded ? 'collapse' : 'expand'} to ${expanded ? 'show only the 5-hour window' : 'show every window'}`}
      >
        <span className="usage-agent-title">{usage.agentDisplayName}</span>
        <Icon name="chevron-down" size={13} className={expanded ? 'usage-chevron expanded' : 'usage-chevron'} />
      </button>
      {visible.map((w, idx) => {
        const pct = Math.max(0, Math.min(100, w.percentUsed));
        const level = pct >= DANGER_AT ? 'danger' : pct >= WARN_AT ? 'warn' : 'ok';
        const title = w.timezone && w.resetsAtLabel ? `Resets ${w.resetsAtLabel} (${w.timezone})` : undefined;

        return (
          <div key={idx} className="usage-bar" title={title}>
            <div className="usage-bar-head">
              {w.label && <span className="usage-window-label">{w.label}</span>}
              <span className="usage-meta">
                {pct}% used
                {w.resetsAtLabel && <> · resets {w.resetsAtLabel}</>}
              </span>
            </div>
            <div className="usage-track">
              <div className={`usage-fill usage-fill-${level}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
