import { useCallback, useEffect, useState } from 'react';
import type { AgentUsageInfo, UsageWindowInfo } from '@pocketagent/protocol';
import { Icon } from './Icon.js';
import { useHostApi } from '../hosts/HostContext.js';

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
  const api = useHostApi();
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
 * The window(s) a collapsed gauge leads with (its outer ring — see
 * `ringWindows`): just the 5-hour one, since it resets soon enough to be
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

/** Matches a weekly window however each source spells it ("Weekly", "7-day", agy's "... weekly"). */
const WEEKLY_RE = /\b(?:week(?:ly)?|7[\s-]?d(?:ays?)?)\b/i;

/**
 * The two windows one ring gauge draws (PA-131): the outer ring is the window
 * the collapsed view always led with (`collapsedWindows`' first — the 5-hour
 * one), the inner ring the weekly one. For agy the weekly window is taken from
 * the same model group as the outer ring when there is one, so the two rings
 * describe one quota rather than two unrelated ones. `inner` is null when the
 * agent reports a single window, and the gauge then draws one ring.
 */
export function ringWindows(
  usage: AgentUsageInfo,
  windows: UsageWindowInfo[],
): { outer: UsageWindowInfo | null; inner: UsageWindowInfo | null } {
  const outer = collapsedWindows(usage, windows)[0] ?? null;
  if (!outer) return { outer: null, inner: null };
  const rest = windows.filter((w) => w !== outer);
  const weekly = rest.filter((w) => WEEKLY_RE.test(w.label));
  const group = outer.label.replace(FIVE_HOUR_RE, '').trim().toLowerCase();
  const sameGroup = group ? weekly.find((w) => w.label.toLowerCase().includes(group)) : undefined;
  return { outer, inner: sameGroup ?? weekly[0] ?? rest[0] ?? null };
}

const AGENT_ABBREVIATIONS: Record<string, string> = { claude: 'CC', codex: 'CX', agy: 'AG' };

/** The two letters inside a gauge — CC / CX / AG, else the display name's initials. */
export function agentAbbreviation(usage: Pick<AgentUsageInfo, 'agent' | 'agentDisplayName'>): string {
  const known = AGENT_ABBREVIATIONS[usage.agent];
  if (known) return known;
  const words = usage.agentDisplayName.split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words.map((w) => w[0]).join('') : usage.agentDisplayName;
  return letters.slice(0, 2).toUpperCase();
}

function levelOf(pct: number): 'ok' | 'warn' | 'danger' {
  return pct >= DANGER_AT ? 'danger' : pct >= WARN_AT ? 'warn' : 'ok';
}

function clampPct(pct: number): number {
  return Math.max(0, Math.min(100, pct));
}

function windowsOf(usage: AgentUsageInfo): UsageWindowInfo[] {
  if (usage.windows && usage.windows.length > 0) return usage.windows;
  if (usage.percentUsed === null) return [];
  return [
    {
      label: usage.windowLabel ?? '',
      percentUsed: usage.percentUsed,
      resetsAtLabel: usage.resetsAtLabel,
      timezone: usage.timezone,
    },
  ];
}

const EXPANDED_KEY = 'pocketagent:usage-expanded';

function loadExpanded(): boolean {
  try {
    return globalThis.localStorage?.getItem(EXPANDED_KEY) === '1';
  } catch {
    return false;
  }
}

function saveExpanded(value: boolean): void {
  try {
    globalThis.localStorage?.setItem(EXPANDED_KEY, value ? '1' : '0');
  } catch {
    // Private browsing or a blocked store — the toggle still works for this page.
  }
}

/**
 * Rate-limit status per agent. Collapsed (the default) it is one row of small
 * two-ring gauges — outer ring the 5-hour window, inner the weekly one, the
 * agent's initials in the middle — because a full bar per agent per window
 * took a third of a phone screen (PA-131). Tapping the row expands it in place
 * to every window as a labelled bar with its reset time; the choice is
 * remembered. Renders nothing while loading and nothing for an agent whose
 * usage could not be read.
 */
export function UsageBar(): JSX.Element | null {
  const usage = useUsage();
  const [expanded, setExpanded] = useState(loadExpanded);
  const rows =
    usage?.filter(
      (u) =>
        u.available &&
        ((u.windows && u.windows.length > 0) || u.percentUsed !== null),
    ) ?? [];
  if (rows.length === 0) return null;

  const toggle = () => {
    setExpanded((v) => {
      saveExpanded(!v);
      return !v;
    });
  };

  return (
    <div className={`usage-bars${expanded ? ' expanded' : ''}`}>
      <button
        type="button"
        className="usage-rings"
        onClick={toggle}
        aria-expanded={expanded}
        aria-label={`Agent usage — ${expanded ? 'hide details' : 'show every window'}`}
      >
        {rows.map((u) => (
          <UsageRing key={u.agent} usage={u} />
        ))}
        <Icon name="chevron-down" size={13} className={expanded ? 'usage-chevron expanded' : 'usage-chevron'} />
      </button>
      {expanded &&
        rows.map((u) => <UsageAgentDetail key={u.agent} usage={u} />)}
    </div>
  );
}

const OUTER_R = 19;
const INNER_R = 13.5;

/**
 * Radii and stroke width for a 4-ring gauge (PA-156: agy's Pro, Flash,
 * Flash Lite, and Third-Party model tiers, outside-in in the same order as the
 * expanded panel). Leaves a 9.1px clear inner radius (18.2px diameter) for the
 * two-letter agent label.
 */
const FOUR_RING_RADII = [20.2, 16.8, 13.4, 10.0] as const;
const FOUR_RING_WIDTH = 1.8;

export interface GaugeRingSpec {
  window: UsageWindowInfo;
  r: number;
  width: number;
}

/**
 * Concentric arcs drawn inside one 44x44 gauge, outside-in. Agents reporting
 * 1–2 windows (Claude, Codex, or legacy 5h+weekly agy) use the two thicker
 * rings from `ringWindows`; agy's per-tier model windows (`Pro`, `Flash`,
 * `Flash Lite`, `Third-Party`) draw up to four thinner rings in the exact
 * order of the expanded panel so both views match 1:1 (PA-156).
 */
export function gaugeRings(usage: AgentUsageInfo, windows: UsageWindowInfo[]): GaugeRingSpec[] {
  const hasLegacy5hOrWeekly = windows.some(
    (w) => FIVE_HOUR_RE.test(w.label) || WEEKLY_RE.test(w.label),
  );
  if (usage.agent === 'agy' && !hasLegacy5hOrWeekly && windows.length > 2) {
    return windows.slice(0, FOUR_RING_RADII.length).map((window, idx) => ({
      window,
      r: FOUR_RING_RADII[idx]!,
      width: FOUR_RING_WIDTH,
    }));
  }
  const { outer, inner } = ringWindows(usage, windows);
  const specs: GaugeRingSpec[] = [];
  if (outer) specs.push({ window: outer, r: OUTER_R, width: 3.5 });
  if (inner) specs.push({ window: inner, r: INNER_R, width: 3 });
  return specs;
}

function UsageRing({ usage }: { usage: AgentUsageInfo }): JSX.Element {
  const rings = gaugeRings(usage, windowsOf(usage));
  const describe = (w: UsageWindowInfo) =>
    `${w.label ? `${w.label} ` : ''}${clampPct(w.percentUsed)}% used${w.resetsAtLabel ? `, resets ${w.resetsAtLabel}` : ''}`;
  const title = [usage.agentDisplayName, ...rings.map((ring) => describe(ring.window))].filter(Boolean).join(' · ');
  const worst = rings.reduce((max, ring) => Math.max(max, clampPct(ring.window.percentUsed)), 0);
  const dense = rings.length > 2;

  return (
    <span
      className={`usage-ring usage-ring-${levelOf(worst)}${dense ? ' usage-ring-dense' : ''}`}
      title={title}
      role="img"
      aria-label={title}
    >
      <svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true">
        {rings.map((ring, idx) => (
          <RingArc key={idx} r={ring.r} width={ring.width} pct={clampPct(ring.window.percentUsed)} />
        ))}
      </svg>
      <span className="usage-ring-label">{agentAbbreviation(usage)}</span>
    </span>
  );
}

function RingArc({ r, width, pct }: { r: number; width: number; pct: number }): JSX.Element {
  return (
    <>
      <circle className="usage-ring-track" cx="22" cy="22" r={r} strokeWidth={width} fill="none" />
      {pct > 0 && (
        <circle
          className={`usage-ring-fill usage-fill-${levelOf(pct)}`}
          cx="22"
          cy="22"
          r={r}
          strokeWidth={width}
          fill="none"
          pathLength={100}
          strokeDasharray={`${pct} 100`}
          strokeLinecap="round"
          // Start at twelve o'clock and run clockwise.
          transform="rotate(-90 22 22)"
        />
      )}
    </>
  );
}

function UsageAgentDetail({ usage }: { usage: AgentUsageInfo }): JSX.Element {
  return (
    <div className="usage-agent-group">
      <span className="usage-agent-title">{usage.agentDisplayName}</span>
      {windowsOf(usage).map((w, idx) => {
        const pct = clampPct(w.percentUsed);
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
              <div className={`usage-fill usage-fill-${levelOf(pct)}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
