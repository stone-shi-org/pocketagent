import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TranscriptItem, TranscriptState, TurnNode } from '../agent/transcript.js';
import { groupIntoTurns } from '../agent/transcript.js';
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

  // Follow the tail, but stop fighting the user the moment they scroll up.
  useEffect(() => {
    if (pinned) endRef.current?.scrollIntoView({ block: 'end' });
  }, [state.items.length, history?.length, pinned]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setPinned(atBottom);
  };

  const past = history ?? [];
  const historyTurns = useMemo(() => groupIntoTurns(past), [past]);
  const liveTurns = useMemo(() => groupIntoTurns(state.items), [state.items]);

  // History and live turns share one continuous scroll region, so the sticky
  // window and stacking offsets are computed over both combined — otherwise
  // "the last 3 turns" would mean the last 3 of the live session only, even
  // while still scrolled up inside resumed history.
  const totalTurns = historyTurns.length + liveTurns.length;
  const windowStart = Math.max(0, totalTurns - STICKY_WINDOW);
  const eligibleKeys = useMemo(() => {
    const combined = [
      ...historyTurns.map((t) => `h_${t.key}`),
      ...liveTurns.map((t) => t.key),
    ];
    return combined.slice(windowStart);
  }, [historyTurns, liveTurns, windowStart]);
  const { tops, heights, setHeaderRef } = useStackedOffsets(eligibleKeys);

  return (
    <div className="transcript" ref={scrollRef} onScroll={onScroll}>
      {past.length === 0 && state.items.length === 0 && (
        <div className="empty">Send a prompt to start the conversation.</div>
      )}

      {historyTurns.map((turn, i) => {
        const position = i - windowStart;
        const sticky = position >= 0;
        return (
          <TurnPanel
            key={`h_${turn.key}`}
            turn={turn}
            sticky={sticky}
            top={sticky ? tops[position] : undefined}
            height={sticky ? heights[position] : undefined}
            setHeaderRef={sticky ? setHeaderRef(position) : undefined}
          />
        );
      })}
      {past.length > 0 && (
        <div className="history-divider">
          <span>Resumed here</span>
        </div>
      )}

      {liveTurns.map((turn, i) => {
        const position = historyTurns.length + i - windowStart;
        const sticky = position >= 0;
        return (
          <TurnPanel
            key={turn.key}
            turn={turn}
            sticky={sticky}
            top={sticky ? tops[position] : undefined}
            height={sticky ? heights[position] : undefined}
            setHeaderRef={sticky ? setHeaderRef(position) : undefined}
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
 * many lines it wraps to, and this box never changes shape once mounted
 * (unlike the old compact-on-stick version, nothing here toggles a class or
 * a size in response to scrolling, which is what caused the flicker: native
 * `position: sticky` repositions the box, it never touches the box itself).
 *
 * Recomputes when the *set* of pinned turns changes (a new prompt enters the
 * window) and on viewport resize (a rotation or width change can rewrap a
 * prompt to a different number of lines). Never on scroll — scrolling only
 * moves already-correctly-offset boxes, it doesn't change their heights.
 */
function useStackedOffsets(keys: string[]): {
  tops: number[];
  /** Each pinned header's own measured height — separate from `tops`
      because the glass panel needs *its own* height per turn (see
      `.prompt-glass` in styles.css), not just the cumulative offset that
      positions it. */
  heights: number[];
  setHeaderRef: (position: number) => (el: HTMLDivElement | null) => void;
} {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const [tops, setTops] = useState<number[]>([]);
  const [heights, setHeights] = useState<number[]>([]);

  const recompute = (): void => {
    const nextTops: number[] = [];
    const nextHeights: number[] = [];
    let sum = 0;
    for (const el of refs.current) {
      nextTops.push(sum);
      const height = el?.getBoundingClientRect().height ?? 0;
      nextHeights.push(height);
      // No gap after a slot with nothing rendered into it yet (the leading,
      // prompt-less turn can occupy a window position early in a session) —
      // otherwise the next real header would start one gap too far down.
      if (height > 0) sum += height + STICKY_GAP;
    }
    setTops(nextTops);
    setHeights(nextHeights);
  };

  const keySignature = keys.join('|');
  useLayoutEffect(() => {
    recompute();
    // Deliberately keyed on the key signature alone, not `recompute` itself
    // (a new closure every render) — re-measuring on every render would
    // defeat the point of only reacting to the pinned set actually changing.
  }, [keySignature]);

  useEffect(() => {
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
    // Runs once: `recompute` always reads the latest refs via `.current`
    // regardless of which render's closure is still attached as the
    // listener, so it never goes stale.
  }, []);

  const setHeaderRef = (position: number) => (el: HTMLDivElement | null) => {
    refs.current[position] = el;
  };

  return { tops, heights, setHeaderRef };
}

function TurnPanel({
  turn,
  sticky,
  top,
  height,
  setHeaderRef,
}: {
  turn: TurnNode;
  sticky: boolean;
  top: number | undefined;
  /** This turn's own measured header height, once known — sizes its glass
      segment (see the render below and `.prompt-glass` in styles.css). */
  height: number | undefined;
  setHeaderRef: ((el: HTMLDivElement | null) => void) | undefined;
}): JSX.Element {
  // No per-turn wrapper div: `position: sticky` can never escape its own
  // parent's box, so a header boxed inside "just this turn's own content"
  // gets forced to release the instant that (often short) box scrolls past —
  // it can't stay pinned through a later turn's content. Header, glass
  // anchor, and body are all siblings directly under `.transcript` instead,
  // so `.transcript` itself (which spans the whole conversation) is every
  // sticky element's containing block, and a pinned header stays put for as
  // long as the JS-computed sticky window (see Transcript.tsx) says it
  // should, not for however tall its own turn happens to be.
  return (
    <>
      {turn.prompt && sticky && (
        // The glass backdrop for this turn's pinned header — a genuine
        // sibling *before* the header in the DOM, not a pseudo-element on
        // it. That's load-bearing: a pseudo-element can never paint behind
        // its own element's background (only behind its own *normal
        // content*, which is a different, higher paint step — an earlier
        // version tried a `::after` with a negative z-index for this and it
        // ended up painting a translucent layer directly over the header's
        // own solid tint, not just around it). A true sibling rendered
        // first paints first, so the header's own opaque box — rendered
        // right after it, in the same call — naturally paints on top of it,
        // the same way an `.agent-strip` chip sits opaque on that bar's own
        // background. Positioned at the raw (un-inset) `top`, one turn's
        // worth of glass segments end up contiguous — see the comment on
        // `.prompt-glass-anchor` in styles.css.
        <div className="prompt-glass-anchor" style={{ top }} aria-hidden="true">
          <div className="prompt-glass" style={{ height: (height ?? 0) + GLASS_BRIDGE }} />
        </div>
      )}
      {turn.prompt && (
        <header
          ref={setHeaderRef}
          className={`turn-header${sticky ? ' pinned' : ''}`}
          style={sticky ? { top: (top ?? 0) + TOP_INSET } : undefined}
        >
          {/* Single line, icon on the same row: a stack of pinned prompts
              needs to stay thin, and a prompt is for "what did I ask"
              at a glance, not for re-reading in full here. */}
          <div className="prompt-text">{turn.prompt.text}</div>
          <CopyButton text={turn.prompt.text} label="Copy prompt" />
        </header>
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
  if (item.costUsd !== null) bits.push(`$${item.costUsd.toFixed(4)}`);
  if (item.isError) bits.push('error');

  if (bits.length === 0) return <div className="turn-sep" />;
  return <div className="turn-footer">{bits.join(' · ')}</div>;
}
