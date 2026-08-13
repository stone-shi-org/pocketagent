import { useCallback, useEffect, useState } from 'react';
import type { AgentUsageInfo } from '@pocketagent/protocol';
import { api } from '../api/client.js';

/**
 * The server refreshes its own cache every few minutes (one timer per agent
 * source — see `UsageService`); polling faster than that here would only
 * ever re-fetch the same snapshot.
 */
const POLL_MS = 60_000;

/**
 * One rate-limit reading per agent that knows how to report its own — today
 * Claude and Codex. Polled from `GET /api/usage`, which always answers from a
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
 * A thin progress bar per agent in the status area: percent of its current
 * rate-limit window used, labelled by agent (this app drives more than one),
 * and when it resets. Renders nothing while loading and nothing for an agent
 * whose usage could not be read, rather than showing an empty or broken bar
 * — see `useUsage`.
 */
export function UsageBar(): JSX.Element | null {
  const usage = useUsage();
  const rows = usage?.filter((u) => u.available && u.percentUsed !== null) ?? [];
  if (rows.length === 0) return null;

  return (
    <div className="usage-bars">
      {rows.map((u) => (
        <UsageRow key={u.agent} usage={u} />
      ))}
    </div>
  );
}

function UsageRow({ usage }: { usage: AgentUsageInfo }): JSX.Element {
  const pct = Math.max(0, Math.min(100, usage.percentUsed ?? 0));
  const level = pct >= DANGER_AT ? 'danger' : pct >= WARN_AT ? 'warn' : 'ok';
  const title = usage.timezone ? `Resets ${usage.resetsAtLabel} (${usage.timezone})` : undefined;

  return (
    <div className="usage-bar" title={title}>
      <div className="usage-bar-head">
        <span className="usage-agent">{usage.agentDisplayName}</span>
        <span className="usage-meta">
          {pct}% used
          {usage.windowLabel && ` (${usage.windowLabel})`}
          {usage.resetsAtLabel && <> · resets {usage.resetsAtLabel}</>}
        </span>
      </div>
      <div className="usage-track">
        <div className={`usage-fill usage-fill-${level}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
