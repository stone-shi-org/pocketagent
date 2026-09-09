import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TranscriptItem, TranscriptState, TurnNode } from '../agent/transcript.js';
import { groupIntoTurns } from '../agent/transcript.js';
import { promptHeadline } from '../agent/prompt-headline.js';
import { renderMarkdown } from '../agent/markdown.js';
import { ToolCard } from './ToolCard.js';
import { CopyButton } from './CopyButton.js';

/**
 * Only the most recent turns' prompts stay pinned at the top as their output
 * scrolls past — older ones scroll away like ordinary content instead of
 * stacking forever. By the time turn N+4 exists you're not scrolling back
 * through turn N's output looking for its prompt anyway.
 */
const STICKY_WINDOW = 3;

/** Visual gap between two stacked pinned headers. Baked into the JS-computed
    `top` offsets rather than left to CSS margin — see the comment on
    `.turn-header.pinned` in styles.css for why margin alone isn't reliable
    here. */
const STICKY_GAP = 8;

/** Extra offset added to every pinned header's own `top`, on top of the
    JS-computed stacking offset — gives the topmost pinned prompt some
    breathing room instead of sitting flush against the glass panel's own
    top edge. Uniform across all stacked headers (not just the first), so
    the *relative* spacing between them — governed entirely by STICKY_GAP —
    is unaffected by a constant added equally to all of them. The glass
    panel itself is positioned at the raw, un-inset offset (see
    `.prompt-glass-anchor` in styles.css), so this gap reads as "glass show-
    ing behind the header," not as empty space above the stack. */
const TOP_INSET = 10;

/** Extra height each glass segment reaches beyond its own header's measured
    height — bridges the STICKY_GAP into the next stacked header's segment
    (or, for the last one, softens the edge into ordinary reply content).
    Must stay >= STICKY_GAP (8) or a sliver of scrolling content shows
    through between stacked headers; kept well above that, at roughly
    TOP_INSET's own scale, so the glass panel reads as having its own
    breathing room below it rather than stopping the instant its own
    header's box ends — the header's `margin-bottom` gives *the header*
    room before the reply text, but the glass is a visually separate,
    wider panel now (see Transcript.tsx's TurnPanel and `.prompt-glass` in
    styles.css) and needs that same breathing room on its own account. */
const GLASS_BRIDGE = 16;

export function Transcript({
  state,
  history,
}: {
  state: TranscriptState;
  /** Messages from the conversation being resumed, shown above this session. */
  history?: TranscriptItem[];
}): JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);

  // Follow the tail, but stop fighting the user the moment they scroll up.
  useEffect(() => {
    if (pinned) endRef.current?.scrollIntoView({ block: 'end' });
  }, [state.items.length, history?.length, pinned]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setPinned(atBottom);
  };

  const past = history ?? [];
  const historyTurns = useMemo(() => groupIntoTurns(past), [past]);
  const liveTurns = useMemo(() => groupIntoTurns(state.items), [state.items]);

  const allTurns = useMemo(() => {
    return [
      ...historyTurns.map((t) => ({ key: `h_${t.key}`, turn: t })),
      ...liveTurns.map((t) => ({ key: t.key, turn: t })),
    ];
  }, [historyTurns, liveTurns]);

  const promptTurnIndices = useMemo(() => {
    const indices: number[] = [];
    allTurns.forEach((t, i) => {
      if (t.turn.prompt) indices.push(i);
    });
    return indices;
  }, [allTurns]);

  const allKeys = useMemo(() => allTurns.map((t) => t.key), [allTurns]);
  const { tops, heights, setHeaderRef, turnAnchorsRef, recompute } = useStackedOffsets(allKeys);

  // Determine which turns are currently sticky/pinned based on scroll position:
  // Find turns where the header has reached or scrolled past its stacked top offset.
  // The most recent `STICKY_WINDOW` turns among those that have reached the top are pinned.
  const stickyTurnIndices = useMemo(() => {
    const container = scrollRef.current;
    if (!container || promptTurnIndices.length === 0) {
      // Default: last STICKY_WINDOW prompt turns if not yet scrolled or before measurement
      return new Set(promptTurnIndices.slice(-STICKY_WINDOW));
    }
    const containerRect = container.getBoundingClientRect();
    const passed: number[] = [];
    promptTurnIndices.forEach((turnIdx) => {
      const anchorEl = turnAnchorsRef.current[turnIdx];
      if (anchorEl) {
        const anchorRect = anchorEl.getBoundingClientRect();
        // The anchor's position relative to the scroll container's top
        const relTop = anchorRect.top - containerRect.top;
        // If anchor has scrolled past or reached its stacking top offset
        if (relTop <= (tops[turnIdx] ?? 0) + TOP_INSET + 2) {
          passed.push(turnIdx);
        }
      }
    });
    // Keep at most the newest STICKY_WINDOW passed turns pinned
    const active = passed.slice(-STICKY_WINDOW);
    // If no turns have passed yet (e.g. at the very top of a short transcript),
    // default to the last STICKY_WINDOW so headers behave correctly
    if (active.length === 0) {
      return new Set(promptTurnIndices.slice(-STICKY_WINDOW));
    }
    return new Set(active);
  }, [promptTurnIndices, allTurns, tops, turnAnchorsRef, scrollTop]);

  // Compute stacking offsets for the currently active sticky turns
  const activeStickyTops = useMemo(() => {
    const map = new Map<number, number>();
    let sum = 0;
    promptTurnIndices.forEach((turnIdx) => {
      if (stickyTurnIndices.has(turnIdx)) {
        map.set(turnIdx, sum);
        const h = heights[turnIdx] ?? 0;
        if (h > 0) sum += h + STICKY_GAP;
      }
    });
    return map;
  }, [promptTurnIndices, stickyTurnIndices, heights]);

  return (
    <div className="transcript" ref={scrollRef} onScroll={onScroll}>
      {past.length === 0 && state.items.length === 0 && (
        <div className="empty">Send a prompt to start the conversation.</div>
      )}

      {historyTurns.map((turn, i) => {
        const turnIdx = i;
        const sticky = stickyTurnIndices.has(turnIdx);
        return (
          <TurnPanel
            key={`h_${turn.key}`}
            turn={turn}
            sticky={sticky}
            top={sticky ? activeStickyTops.get(turnIdx) : undefined}
            height={sticky ? heights[turnIdx] : undefined}
            setHeaderRef={setHeaderRef(turnIdx)}
            onHeightChange={recompute}
          />
        );
      })}
      {past.length > 0 && (
        <div className="history-divider">
          <span>Resumed here</span>
        </div>
      )}

      {liveTurns.map((turn, i) => {
        const turnIdx = historyTurns.length + i;
        const sticky = stickyTurnIndices.has(turnIdx);
        return (
          <TurnPanel
            key={turn.key}
            turn={turn}
            sticky={sticky}
            top={sticky ? activeStickyTops.get(turnIdx) : undefined}
            height={sticky ? heights[turnIdx] : undefined}
            setHeaderRef={setHeaderRef(turnIdx)}
            onHeightChange={recompute}
          />
        );
      })}
      {state.busy && <Working />}
      <div ref={endRef} />
      {!pinned && (
        <button
          type="button"
          className="jump-latest"
          onClick={() => {
            setPinned(true);
            endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
          }}
        >
          ↓ Latest
        </button>
      )}
    </div>
  );
}

/**
 * Cumulative `top` offset for each currently-pinned header, so header N
 * stacks directly below header N-1 rather than both sticking to `top: 0`
 * and overlapping. Plain `getBoundingClientRect` measurement of the actual
 * rendered header, not a guessed constant — a prompt's height depends on how
 * many lines it wraps to or whether it is expanded.
 */
function useStackedOffsets(keys: string[]): {
  tops: number[];
  heights: number[];
  setHeaderRef: (position: number) => (el: HTMLDivElement | null) => void;
  turnAnchorsRef: React.MutableRefObject<(HTMLDivElement | null)[]>;
  recompute: () => void;
} {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const [tops, setTops] = useState<number[]>([]);
  const [heights, setHeights] = useState<number[]>([]);

  // Stable across renders (reads refs.current fresh each call) so passing
  // it as a prop never trips a consumer's own effect dependency array —
  // a fresh closure here every render turned TurnPanel's onHeightChange
  // effect into an infinite recompute -> setState -> re-render loop.
  const recompute = useCallback((): void => {
    const nextTops: number[] = [];
    const nextHeights: number[] = [];
    let sum = 0;
    for (const el of refs.current) {
      nextTops.push(sum);
      const height = el?.getBoundingClientRect().height ?? 0;
      nextHeights.push(height);
      if (height > 0) sum += height + STICKY_GAP;
    }
    setTops(nextTops);
    setHeights(nextHeights);
  }, []);

  const keySignature = keys.join('|');
  useLayoutEffect(() => {
    recompute();
  }, [keySignature]);

  useEffect(() => {
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, []);

  const setHeaderRef = (position: number) => (el: HTMLDivElement | null) => {
    refs.current[position] = el;
  };

  return { tops, heights, setHeaderRef, turnAnchorsRef: refs, recompute };
}

function TurnPanel({
  turn,
  sticky,
  top,
  height,
  setHeaderRef,
  onHeightChange,
}: {
  turn: TurnNode;
  sticky: boolean;
  top: number | undefined;
  height: number | undefined;
  setHeaderRef: ((el: HTMLDivElement | null) => void) | undefined;
  onHeightChange?: () => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const promptText = turn.prompt?.text ?? '';
  const isMultiline = promptText.includes('\n') || promptText.length > 80;

  const toggleExpand = (): void => {
    setExpanded((v) => !v);
  };

  useLayoutEffect(() => {
    onHeightChange?.();
  }, [expanded, onHeightChange]);

  return (
    <>
      {turn.prompt && sticky && (
        <div className="prompt-glass-anchor" style={{ top }} aria-hidden="true">
          <div className="prompt-glass" style={{ height: (height ?? 0) + GLASS_BRIDGE }} />
        </div>
      )}
      {turn.prompt && (
        <header
          ref={setHeaderRef}
          className={`turn-header${sticky ? ' pinned' : ''}${expanded ? ' expanded' : ''}`}
          style={sticky ? { top: (top ?? 0) + TOP_INSET } : undefined}
        >
          <div className={`prompt-text${expanded ? ' expanded' : ''}`}>
            {turn.prompt.text
              ? expanded
                ? promptText
                : promptHeadline(turn.prompt.text)
              : (turn.prompt.image ? 'Sent an image' : '')}
          </div>
          {turn.prompt.text && <CopyButton text={turn.prompt.text} label="Copy prompt" />}
          {isMultiline && (
            <button
              type="button"
              className="prompt-expand-btn"
              onClick={toggleExpand}
              aria-expanded={expanded}
              aria-label={expanded ? 'Collapse prompt' : 'Expand prompt'}
            >
              <span className="chev" aria-hidden="true">
                {expanded ? '▾' : '▸'}
              </span>
            </button>
          )}
        </header>
      )}
      {turn.prompt?.image && (
        <div className="prompt-image-row">
          <img
            className="prompt-image"
            src={`data:${turn.prompt.image.mediaType};base64,${turn.prompt.image.data}`}
            alt="Attached screenshot"
          />
        </div>
      )}
      <div className="turn-body">
        {turn.leaves.map((leaf) => (
          <Item key={leaf.key} item={leaf} />
        ))}
      </div>
    </>
  );
}

function Item({ item }: { item: TranscriptItem }): JSX.Element | null {
  switch (item.type) {
    case 'text':
      // A user-role text item is always a turn's `prompt` — groupIntoTurns
      // pulls it out of the leaves list, so it renders via TurnPanel's
      // header, never through here.
      return (
        <div className="message assistant">
          <Markdown text={item.text} streaming={item.streaming} />
          {/* Nothing to copy until the block has stopped growing. */}
          {!item.streaming && (
            <div className="message-actions">
              <CopyButton text={item.text} label="Copy answer" />
            </div>
          )}
        </div>
      );
    case 'thinking':
      return <Thinking text={item.text} />;
    case 'tool':
      return <ToolCard item={item} />;
    case 'notice':
      return <div className={`notice inline ${item.level}`}>{item.text}</div>;
    case 'command_output':
      return <div className="command-output">{item.text}</div>;
    case 'turn':
      return <TurnFooter item={item} />;
    default:
      return null;
  }
}

function Markdown({ text, streaming }: { text: string; streaming: boolean }): JSX.Element {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div className={`answer ${streaming ? 'streaming' : ''}`}>
      {/* Sanitized in renderMarkdown; the agent's output is untrusted content. */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function Thinking({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const words = text.trim().split(/\s+/).length;
  return (
    <div className="thinking">
      <button type="button" className="thinking-head" onClick={() => setOpen((v) => !v)}>
        <span className="chev">{open ? '▾' : '▸'}</span> Thought for {words} words
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  );
}

function Working(): JSX.Element {
  return (
    <div className="working" role="status">
      <span className="dot" />
      <span className="dot" />
      <span className="dot" />
    </div>
  );
}

function TurnFooter({ item }: { item: Extract<TranscriptItem, { type: 'turn' }> }): JSX.Element {
  const bits: string[] = [];
  if (item.durationMs !== null) bits.push(`${(item.durationMs / 1000).toFixed(1)}s`);
  if (item.inputTokens !== null || item.outputTokens !== null) {
    bits.push(`${item.inputTokens ?? 0}↑ ${item.outputTokens ?? 0}↓`);
  }
  // Tokens/sec only means something for actual generation time, so it needs
  // both a duration and an output-token count — either missing (a backend
  // that doesn't report usage, or an instant/errored turn) just omits this
  // bit rather than showing a fabricated or divide-by-zero rate.
  if (item.durationMs !== null && item.durationMs > 0 && item.outputTokens !== null) {
    bits.push(`${(item.outputTokens / (item.durationMs / 1000)).toFixed(1)} tok/s`);
  }
  if (item.costUsd !== null) bits.push(`$${item.costUsd.toFixed(4)}`);
  if (item.isError) bits.push('error');
  // The viewer's own local time zone, via `toLocaleTimeString`'s default
  // (no explicit `timeZone` option) — never the server's.
  if (item.completedAt !== null) bits.push(new Date(item.completedAt).toLocaleTimeString());

  if (bits.length === 0) return <div className="turn-sep" />;
  return <div className="turn-footer">{bits.join(' · ')}</div>;
}
