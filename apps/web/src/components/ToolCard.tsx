import { useEffect, useRef, useState } from 'react';
import type { ToolItem } from '../agent/transcript.js';
import { collapseContext, diffFromToolInput, diffLines, diffStat } from '../agent/diff.js';
import { renderMarkdown } from '../agent/markdown.js';
import { planFromToolInput } from '../agent/plan.js';
import {
  QUIET_TOOLS,
  formatToolInput,
  stateLabel,
  toolCallText,
  toolState,
} from '../agent/tool-text.js';
import { CopyButton } from './CopyButton.js';

/**
 * Past this, a running tool call gets flagged as long-running rather than just
 * "…" — most tool calls finish in well under a minute, so one that hasn't is
 * worth calling out rather than pulsing identically to one that started a
 * second ago.
 */
const LONG_RUNNING_MS = 60_000;

export function ToolCard({ item }: { item: ToolItem }): JSX.Element {
  const [open, setOpen] = useState(false);
  const plan = planFromToolInput(item.name, item.input);
  const diff = plan ? null : diffFromToolInput(item.name, item.input);
  const lines = diff ? diffLines(diff.before, diff.after) : null;
  const stat = lines ? diffStat(lines) : null;

  const state = toolState(item);

  // Elapsed time since this card first rendered, ticking while `running` so a
  // hung tool call looks different from one that just started — a CSS pulse
  // alone conveys nothing about how long it's actually been. `startedAt` is
  // captured once on mount, which is exact for a call watched live; the wire
  // protocol carries no per-event timestamp, so a call already `running` at
  // page load (replay/reconnect) under-counts from the moment this mounted,
  // not the tool's true start.
  const startedAtRef = useRef(Date.now());
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (state !== 'running') return;
    const id = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 1000);
    return () => clearInterval(id);
  }, [state]);

  const longRunning = state === 'running' && elapsedMs > LONG_RUNNING_MS;

  return (
    <div className={`tool-card ${state}`}>
      {/*
        The bar is a row of three controls rather than one big button: a copy
        icon nested inside the toggle would be invalid HTML and would toggle the
        card on every copy. The chevron keeps its own button so the copy icon can
        sit to its left, where the ticket (PA-16) asked for it.
      */}
      <div className="tool-head">
        <button
          type="button"
          className="tool-head-main"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span
            className={`tool-dot ${state}${longRunning ? ' long-running' : ''}`}
            aria-hidden="true"
            title={longRunning ? `Still running after ${formatElapsed(elapsedMs)} — no result yet` : undefined}
          />
          <span className="tool-summary">{item.summary}</span>
          {stat && (stat.added > 0 || stat.removed > 0) && (
            <span className="diff-stat">
              <span className="add">+{stat.added}</span>
              <span className="del">−{stat.removed}</span>
            </span>
          )}
          <span className="tool-state">
            {state === 'running' ? formatElapsed(elapsedMs) ?? '…' : stateLabel(state)}
          </span>
        </button>
        <CopyButton text={toolCallText(item)} label="Copy tool call" />
        <button
          type="button"
          className="tool-chev"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? 'Collapse tool call' : 'Expand tool call'}
        >
          <span className="chev" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
        </button>
      </div>

      {open && (
        <div className="tool-body">
          {plan ? (
            <div className="tool-plan answer" dangerouslySetInnerHTML={{ __html: renderMarkdown(plan) }} />
          ) : lines ? (
            <DiffView lines={lines} />
          ) : (
            <pre className="tool-input">{formatToolInput(item.input)}</pre>
          )}

          {item.result !== null && !QUIET_TOOLS.has(item.name) && (
            <>
              <div className="tool-label">Result</div>
              <pre className={`tool-result ${item.isError ? 'error' : ''}`}>
                {item.result || '(empty)'}
                {item.resultTruncated && '\n… truncated'}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DiffView({ lines }: { lines: ReturnType<typeof diffLines> }): JSX.Element {
  const collapsed = collapseContext(lines, 3);
  return (
    <div className="diff">
      {collapsed.map((line, index) =>
        line === null ? (
          <div key={`gap${index}`} className="diff-gap">
            ⋯
          </div>
        ) : (
          <div key={index} className={`diff-line ${line.op}`}>
            <span className="gutter">{line.op === 'add' ? '+' : line.op === 'remove' ? '−' : ' '}</span>
            <span className="code">{line.text || ' '}</span>
          </div>
        ),
      )}
    </div>
  );
}

/** `null` under a second, so a fresh card still shows the plain "…" state. */
function formatElapsed(ms: number): string | null {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 1) return null;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
