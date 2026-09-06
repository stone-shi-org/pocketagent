import type { ToolItem } from './transcript.js';

/**
 * Tools whose result is noise once you can see the summary. `ExitPlanMode`'s
 * result just echoes the same plan text already rendered from its input, so
 * showing it again under "Result" would be a second copy of the same markdown.
 */
export const QUIET_TOOLS = new Set(['TodoWrite', 'ExitPlanMode']);

export type ToolState = 'denied' | 'waiting' | 'error' | 'ok' | 'running';

/** The card's visual state, derived from the item alone. */
export function toolState(item: ToolItem): ToolState {
  if (item.denied) return 'denied';
  if (item.awaitingApproval) return 'waiting';
  if (item.isError) return 'error';
  return item.result !== null ? 'ok' : 'running';
}

/** Empty for `ok`: a finished, successful call needs no words next to its dot. */
export function stateLabel(state: ToolState): string {
  switch (state) {
    case 'waiting':
      return 'needs approval';
    case 'denied':
      return 'denied';
    case 'error':
      return 'failed';
    case 'running':
      return '…';
    default:
      return '';
  }
}

/** Show the interesting arguments, not a wall of JSON. */
export function formatToolInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return '(no arguments)';
  return entries
    .map(([k, v]) => {
      const value = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
      return `${k}: ${value}`;
    })
    .join('\n\n');
}

/**
 * The whole tool call as plain text, for the card's copy button.
 *
 * Copies the *arguments*, not the rendering: an `Edit` card shows a diff with
 * unchanged context collapsed to `⋯`, and a plan card shows rendered markdown
 * — pasting either of those loses exactly the thing you wanted to paste back
 * somewhere. `formatToolInput` is shared with the card body so the two cannot
 * drift on what "the input" means.
 *
 * It does not depend on whether the card is expanded: the icon sits on the
 * collapsed bar, and having to open a card first to copy it would be a
 * pointless extra tap on a phone.
 */
export function toolCallText(item: ToolItem): string {
  const label = stateLabel(toolState(item));
  const parts: string[] = [label && label !== '…' ? `${item.summary} — ${label}` : item.summary];

  parts.push(`Input:\n${formatToolInput(item.input)}`);

  // Mirrors the card body: a quiet tool's result is a duplicate of its input,
  // and a still-running call has none yet.
  if (item.result !== null && !QUIET_TOOLS.has(item.name)) {
    const body = item.result || '(empty)';
    parts.push(`Result:\n${body}${item.resultTruncated ? '\n… truncated' : ''}`);
  }

  return `${parts.join('\n\n')}\n`;
}
