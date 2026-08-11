import { useEffect, useMemo, useRef, useState } from 'react';
import type { TranscriptItem, TranscriptState } from '../agent/transcript.js';
import { renderMarkdown } from '../agent/markdown.js';
import { ToolCard } from './ToolCard.js';

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

  return (
    <div className="transcript" ref={scrollRef} onScroll={onScroll}>
      {past.length === 0 && state.items.length === 0 && (
        <div className="empty">Send a prompt to start the conversation.</div>
      )}

      {past.map((item) => (
        <Item key={`h_${item.key}`} item={item} />
      ))}
      {past.length > 0 && (
        <div className="history-divider">
          <span>Resumed here</span>
        </div>
      )}

      {state.items.map((item) => (
        <Item key={item.key} item={item} />
      ))}
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

function Item({ item }: { item: TranscriptItem }): JSX.Element | null {
  switch (item.type) {
    case 'text':
      return item.role === 'user' ? (
        <div className="bubble user">{item.text}</div>
      ) : (
        <Markdown text={item.text} streaming={item.streaming} />
      );
    case 'thinking':
      return <Thinking text={item.text} />;
    case 'tool':
      return <ToolCard item={item} />;
    case 'notice':
      return <div className={`notice inline ${item.level}`}>{item.text}</div>;
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
