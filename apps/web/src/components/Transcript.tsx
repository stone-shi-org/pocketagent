import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cleanCompactionErrorMessage, extractSpokenSummary, stripSpokenSummary } from '@pocketagent/protocol';
import type { TranscriptItem, TranscriptState, TurnNode } from '../agent/transcript.js';
import { groupIntoTurns } from '../agent/transcript.js';
import { HEADLINE_SEPARATOR, promptHeadline, promptHeadlineParts } from '../agent/prompt-headline.js';
import { renderMarkdown } from '../agent/markdown.js';
import { enhanceCodeBlocks, handleCodeBlockClick } from '../agent/code-blocks.js';
import { copyText } from '../agent/clipboard.js';
import { ToolCard } from './ToolCard.js';
import { CopyButton } from './CopyButton.js';
import { FollowUpChips } from './FollowUpChips.js';
import { Icon } from './Icon.js';
import { SentFileChips } from './FileChips.js';

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
  starterPrompts,
  onSelectPrompt,
  onUndoTurn,
  undoingTurnId,
  onOpenChangedFileCompare,
}: {
  state: TranscriptState;
  /** Messages from the conversation being resumed, shown above this session. */
  history?: TranscriptItem[];
  /** Clickable prompt chips shown when the conversation is empty. The chip
      shows `label`; tapping it sends `prompt`, which may be much longer. */
  starterPrompts?: readonly { label: string; prompt: string }[];
  /** Called when a starter prompt chip or follow-up suggestion is picked. */
  onSelectPrompt?: (prompt: string) => void;
  /** PA-143: called when the user clicks "Undo this turn" on a turn that changed workspace files. */
  onUndoTurn?: (turnId: string) => void;
  /** PA-143: turnId currently being undone. */
  undoingTurnId?: string | null;
  /** PA-145: called when the user clicks a changed file to open its compare view in the workspace panel. */
  onOpenChangedFileCompare?: (file: { workspaceId?: string; relPath: string; versionId?: string }) => void;
}): JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [copiedExport, setCopiedExport] = useState(false);

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
    <div
      className="transcript"
      ref={scrollRef}
      onScroll={onScroll}
      role="log"
      aria-label="Conversation transcript"
    >
      {past.length === 0 && state.items.length === 0 && (
        <div className="empty">
          <p className="empty-prompt-hint">Send a prompt to start the conversation.</p>
          {starterPrompts && starterPrompts.length > 0 && onSelectPrompt && (
            <div className="starter-prompts" aria-label="Starter prompts">
              {starterPrompts.map((starter, i) => (
                <button
                  key={`${i}:${starter.label}`}
                  type="button"
                  className="starter-prompt-chip"
                  title={starter.prompt === starter.label ? undefined : starter.prompt}
                  onClick={() => onSelectPrompt(starter.prompt)}
                >
                  {starter.label}
                </button>
              ))}
            </div>
          )}
        </div>
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
            onSelectPrompt={onSelectPrompt}
            onUndoTurn={onUndoTurn}
            undoingTurnId={undoingTurnId}
            onOpenChangedFileCompare={onOpenChangedFileCompare}
            busy={state.busy}
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
            onSelectPrompt={onSelectPrompt}
            onUndoTurn={onUndoTurn}
            undoingTurnId={undoingTurnId}
            onOpenChangedFileCompare={onOpenChangedFileCompare}
            busy={state.busy}
          />
        );
      })}
      {state.busy && <Working />}
      <div ref={endRef} />
      <div className="transcript-floating-actions">
        {allTurns.length > 0 && (
          <button
            type="button"
            className="export-transcript-btn"
            onClick={() => {
              const md = transcriptToMarkdown(historyTurns, liveTurns);
              void copyText(md).then((ok) => {
                if (ok) {
                  setCopiedExport(true);
                  setTimeout(() => setCopiedExport(false), 2000);
                }
              });
            }}
            title="Copy conversation transcript as Markdown"
            aria-label="Copy conversation transcript as Markdown"
          >
            <Icon name={copiedExport ? 'check' : 'copy'} size={13} />
            <span>{copiedExport ? 'Copied' : 'Export'}</span>
          </button>
        )}
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
  onSelectPrompt,
  onUndoTurn,
  undoingTurnId,
  onOpenChangedFileCompare,
  busy,
}: {
  turn: TurnNode;
  sticky: boolean;
  top: number | undefined;
  height: number | undefined;
  setHeaderRef: ((el: HTMLDivElement | null) => void) | undefined;
  onHeightChange?: () => void;
  onSelectPrompt?: (prompt: string) => void;
  onUndoTurn?: (turnId: string) => void;
  undoingTurnId?: string | null;
  onOpenChangedFileCompare?: (file: { workspaceId?: string; relPath: string; versionId?: string }) => void;
  busy?: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const promptText = turn.prompt?.text ?? '';
  const isMultiline = promptText.includes('\n') || promptText.length > 80;
  const headline = useMemo(() => (promptText ? promptHeadlineParts(promptText) : null), [promptText]);

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
          <div className={`prompt-text${expanded ? ' expanded' : ''}${!expanded && headline?.change ? ' has-change' : ''}`}>
            {turn.prompt.text
              ? expanded
                ? promptText
                : headline?.change
                  ? (
                    // Two spans so the summary is what ellipsizes on a narrow
                    // screen and "— Ada approved" stays readable (PA-114).
                    <>
                      <span className="prompt-lead">{headline.lead}</span>
                      <span className="prompt-change">{HEADLINE_SEPARATOR}{headline.change}</span>
                    </>
                  )
                  : promptHeadline(turn.prompt.text)
              : turn.prompt.image
                ? 'Sent an image'
                : turn.prompt.files?.length
                  ? turn.prompt.files.length === 1
                    ? `Sent ${turn.prompt.files[0]!.name}`
                    : `Sent ${turn.prompt.files.length} files`
                  : ''}
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
      {turn.prompt?.files && turn.prompt.files.length > 0 && <SentFileChips files={turn.prompt.files} />}
      <div className="turn-body">
        {turn.leaves.map((leaf) => (
          <Item
            key={leaf.key}
            item={leaf}
            onSelectPrompt={onSelectPrompt}
            onUndoTurn={onUndoTurn}
            undoingTurnId={undoingTurnId}
            onOpenChangedFileCompare={onOpenChangedFileCompare}
            busy={busy}
          />
        ))}
      </div>
    </>
  );
}

function Item({
  item,
  onSelectPrompt,
  onUndoTurn,
  undoingTurnId,
  onOpenChangedFileCompare,
  busy,
}: {
  item: TranscriptItem;
  onSelectPrompt?: (prompt: string) => void;
  onUndoTurn?: (turnId: string) => void;
  undoingTurnId?: string | null;
  onOpenChangedFileCompare?: (file: { workspaceId?: string; relPath: string; versionId?: string }) => void;
  busy?: boolean;
}): JSX.Element | null {
  switch (item.type) {
    case 'text':
      // A user-role text item is always a turn's `prompt` — groupIntoTurns
      // pulls it out of the leaves list, so it renders via TurnPanel's
      // header, never through here.
      return <AssistantText item={item} />;
    case 'thinking':
      return <Thinking text={item.text} streaming={item.streaming} />;
    case 'tool':
      return <ToolCard item={item} />;
    case 'notice':
      return <div className={`notice inline ${item.level}`}>{item.text}</div>;
    case 'command_output':
      return <div className="command-output">{item.text}</div>;
    case 'compaction':
      return <CompactionDivider item={item} />;
    case 'turn':
      return (
        <TurnFooter
          item={item}
          onSelectPrompt={onSelectPrompt}
          onUndoTurn={onUndoTurn}
          undoingTurnId={undoingTurnId}
          onOpenChangedFileCompare={onOpenChangedFileCompare}
          busy={busy}
        />
      );
    default:
      return null;
  }
}

/**
 * PA-121: where a Pocket Agent chat was compacted. Collapsed by default — the
 * summary is for the model, and a human who wants it can open it — and
 * plain text rather than markdown, because it is exactly the string the
 * model is sent.
 */
function CompactionDivider({ item }: { item: TranscriptItem & { type: 'compaction' } }): JSX.Element {
  const why =
    item.reason === 'manual' ? 'on request' : item.reason === 'overflow' ? 'after the model ran out of room' : 'to fit the context window';
  return (
    <details className="compaction-divider">
      <summary>
        Earlier conversation summarized {why} (about {item.tokensBefore.toLocaleString()} →{' '}
        {item.tokensAfter.toLocaleString()} tokens)
      </summary>
      <div className="compaction-summary">{item.summary}</div>
    </details>
  );
}

/**
 * PA-84: an assistant reply with its `<speak>` block removed.
 *
 * The spoken paraphrase is for the speaker only — the ask was that the chat
 * keeps showing the normal written reply untouched — and the tag genuinely
 * reaches this component, because it is the model's own output and lands in
 * the agent's own transcript, which this app never rewrites.
 *
 * Stripped at render rather than in the reducer on purpose: `text_delta`
 * accumulates (`prev.text + event.text`), so stripping on the way in would
 * drop a half-arrived `<spea` and then concatenate its `k>` onto
 * already-stripped text, corrupting the reply for the rest of the turn.
 * `stripSpokenSummary` is safe on a partial reply, so the raw text stays in
 * `TranscriptState` and only the view hides it. The copy action uses the same
 * text, so what you copy is what you saw.
 */
function AssistantText({ item }: { item: TranscriptItem & { type: 'text' } }): JSX.Element {
  // `streaming` matters for a finished reply: a `<speak>` the model opened and
  // never closed is hidden only while it may still close, and shown after.
  const cleanedText = useMemo(() => cleanCompactionErrorMessage(item.text), [item.text]);
  const shown = useMemo(
    () => stripSpokenSummary(cleanedText, { streaming: item.streaming }),
    [cleanedText, item.streaming],
  );
  const spoken = useMemo(() => extractSpokenSummary(cleanedText), [cleanedText]);
  const [spokenOpen, setSpokenOpen] = useState(false);

  // Offered only when there is something the disclosure would actually add.
  // A model that wrapped its *whole* reply in the tag has already had that
  // content shown by `stripSpokenSummary`'s own empty-bubble guard, so a
  // toggle there would expand to a duplicate of the message above it.
  const hasSpoken = spoken !== null && spoken !== shown;

  return (
    <div
      className="message assistant"
      aria-live={item.streaming ? 'polite' : undefined}
      aria-atomic={item.streaming ? 'false' : undefined}
    >
      <Markdown text={shown} streaming={item.streaming} />
      {/* Nothing to copy until the block has stopped growing. */}
      {!item.streaming && (
        <div className="message-actions">
          {hasSpoken && (
            <button
              type="button"
              className={`copy-btn spoken-btn${spokenOpen ? ' open' : ''}`}
              onClick={() => setSpokenOpen((open) => !open)}
              aria-expanded={spokenOpen}
              aria-label="Spoken summary"
              title={spokenOpen ? 'Hide what was read aloud' : 'Show what was read aloud'}
            >
              <Icon name="speaker" size={15} />
            </button>
          )}
          <CopyButton text={shown} label="Copy answer" />
        </div>
      )}
      {/* Plain text, never markdown: this is the string handed to the
          synthesizer, so rendering it as anything else would show something
          other than what was said. */}
      {hasSpoken && spokenOpen && !item.streaming && (
        <div className="spoken-summary">
          <span className="spoken-summary-label">Spoken</span>
          {spoken}
        </div>
      )}
    </div>
  );
}

function Markdown({ text, streaming }: { text: string; streaming: boolean }): JSX.Element {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    enhanceCodeBlocks(containerRef.current);
  }, [html]);

  return (
    <div
      ref={containerRef}
      className={`answer ${streaming ? 'streaming' : ''}`}
      onClick={handleCodeBlockClick}
    >
      {/* Sanitized in renderMarkdown; the agent's output is untrusted content. */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function Thinking({ text, streaming }: { text: string; streaming?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return (
    <div className={`thinking${streaming ? ' streaming' : ''}`}>
      <button type="button" className="thinking-head" onClick={() => setOpen((v) => !v)}>
        <span className="chev">{open ? '▾' : '▸'}</span> {streaming ? 'Thinking…' : 'Thought for'} {words} {words === 1 ? 'word' : 'words'}
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

function TurnFooter({
  item,
  onSelectPrompt,
  onUndoTurn,
  undoingTurnId,
  onOpenChangedFileCompare,
  busy,
}: {
  item: Extract<TranscriptItem, { type: 'turn' }>;
  onSelectPrompt?: (prompt: string) => void;
  onUndoTurn?: (turnId: string) => void;
  undoingTurnId?: string | null;
  onOpenChangedFileCompare?: (file: { workspaceId?: string; relPath: string; versionId?: string }) => void;
  busy?: boolean;
}): JSX.Element {
  const [filesOpen, setFilesOpen] = useState(true);
  const bits: string[] = [];
  if (item.durationMs !== null) bits.push(`${(item.durationMs / 1000).toFixed(1)}s`);
  if (item.inputTokens !== null || item.outputTokens !== null) {
    // PA-122: the cached share, only when the provider reported a non-zero
    // one — "0 cached" would read as caching being broken on a provider that
    // simply does not say.
    const cached = item.cacheReadTokens ? ` (${item.cacheReadTokens} cached)` : '';
    bits.push(`${item.inputTokens ?? 0}↑${cached} ${item.outputTokens ?? 0}↓`);
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

  const hasChips = Boolean(item.suggestions && item.suggestions.length > 0 && onSelectPrompt);
  const changedFiles = item.changedFiles;
  const hasChangedFiles = Boolean(changedFiles && changedFiles.length > 0);
  const isUndoing = Boolean(item.turnId && undoingTurnId === item.turnId);

  return (
    <div className="turn-footer-wrap">
      {hasChangedFiles && changedFiles && (
        <div className="turn-changed-files-box">
          <div className="turn-changed-files-chip">
            <button
              type="button"
              className="turn-changed-files-toggle"
              onClick={() => setFilesOpen((v) => !v)}
              aria-expanded={filesOpen}
            >
              <Icon name="file" size={13} />
              <span>
                Changed {changedFiles.length} file{changedFiles.length === 1 ? '' : 's'}
              </span>
              <span className="chev">{filesOpen ? '▾' : '▸'}</span>
            </button>
            {item.undone ? (
              <span className="turn-undone-badge">Undone</span>
            ) : (
              onUndoTurn &&
              item.turnId && (
                <button
                  type="button"
                  className="turn-undo-btn"
                  disabled={Boolean(busy) || isUndoing}
                  onClick={() => onUndoTurn(item.turnId!)}
                  title="Restore every workspace file touched by this turn to its state before the turn"
                >
                  <Icon name="rotate" size={12} />
                  <span>{isUndoing ? 'Undoing…' : 'Undo this turn'}</span>
                </button>
              )
            )}
          </div>
          {filesOpen && (
            <ul className="turn-changed-files-list">
              {changedFiles.map((f) => (
                <li key={`${f.workspaceId}:${f.relPath}:${f.versionId}`}>
                  {onOpenChangedFileCompare ? (
                    <button
                      type="button"
                      className="turn-changed-file-link"
                      onClick={() => onOpenChangedFileCompare(f)}
                      title={`Compare changes for ${f.relPath} in workspace panel`}
                    >
                      <code>{f.relPath}</code>
                      {f.summary ? <span className="turn-changed-file-summary"> — {f.summary}</span> : null}
                    </button>
                  ) : (
                    <>
                      <code>{f.relPath}</code>
                      {f.summary ? <span className="turn-changed-file-summary"> — {f.summary}</span> : null}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {bits.length === 0 ? <div className="turn-sep" /> : <div className="turn-footer">{bits.join(' · ')}</div>}
      {hasChips && (
        <FollowUpChips
          suggestions={item.suggestions!}
          onPick={onSelectPrompt!}
          disabled={busy}
        />
      )}
    </div>
  );
}

/**
 * Formats full conversation history and live turns into GitHub-flavored Markdown
 * for export or clipboard copy.
 */
export function transcriptToMarkdown(historyTurns: TurnNode[], liveTurns: TurnNode[]): string {
  const turns = [...historyTurns, ...liveTurns];
  const parts: string[] = [];
  for (const t of turns) {
    if (t.prompt?.text) {
      parts.push(`### User\n\n${t.prompt.text}`);
    }
    const assistantParts: string[] = [];
    for (const leaf of t.leaves) {
      if (leaf.type === 'text') {
        const text = stripSpokenSummary(cleanCompactionErrorMessage(leaf.text));
        if (text) assistantParts.push(text);
      } else if (leaf.type === 'tool') {
        assistantParts.push(`> **Tool:** \`${leaf.summary}\``);
      }
    }
    if (assistantParts.length > 0) {
      parts.push(`### Assistant\n\n${assistantParts.join('\n\n')}`);
    }
  }
  return parts.join('\n\n---\n\n');
}
