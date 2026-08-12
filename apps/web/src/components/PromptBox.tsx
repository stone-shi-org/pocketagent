import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from './Icon.js';

const DRAFT_KEY_PREFIX = 'pocketagent:draft:';
const MAX_HEIGHT = 160;

interface Props {
  sessionId: string;
  /** Returns false when the socket is down, so the draft is kept. */
  onSend: (text: string) => boolean;
  disabled: boolean;
}

/**
 * A plain textarea that composes a prompt and sends it followed by Enter.
 *
 * Composing a paragraph directly in xterm on a phone is miserable: no
 * autocorrect, no cursor dragging, and a stray Enter submits half a thought.
 * The draft survives reconnects — and reloads — via sessionStorage, so a dropped
 * tunnel never costs you the text you just typed.
 */
export function PromptBox({ sessionId, onSend, disabled }: Props): JSX.Element {
  const key = DRAFT_KEY_PREFIX + sessionId;
  const [text, setText] = useState(() => {
    try {
      return sessionStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  });
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      if (text) sessionStorage.setItem(key, text);
      else sessionStorage.removeItem(key);
    } catch {
      /* private browsing */
    }
  }, [key, text]);

  // Grow with content up to MAX_HEIGHT. overflow-y stays hidden until content
  // actually exceeds it, so a single line never shows a scrollbar.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const contentHeight = el.scrollHeight;
    el.style.height = `${Math.min(contentHeight, MAX_HEIGHT)}px`;
    el.style.overflowY = contentHeight > MAX_HEIGHT ? 'auto' : 'hidden';
  }, [text]);

  function send(): void {
    const value = text;
    if (value.length === 0 || disabled) return;
    if (onSend(value)) setText('');
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter sends; Shift+Enter is a newline — matches ComposerPage's convention
    // for the first-prompt composer, and the usual chat-app default.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  return (
    <div className="promptbar">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Type a prompt…"
        rows={1}
        aria-label="Prompt"
        enterKeyHint="enter"
      />
      <button
        type="button"
        className="primary"
        onClick={send}
        disabled={disabled || text.length === 0}
        aria-label="Send prompt"
      >
        <Icon name="arrow-up" size={18} />
      </button>
    </div>
  );
}
