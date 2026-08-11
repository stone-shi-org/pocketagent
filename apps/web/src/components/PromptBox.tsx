import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

const DRAFT_KEY_PREFIX = 'pocketagent:draft:';

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

  // Grow with content up to the CSS max-height.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [text]);

  function send(): void {
    const value = text;
    if (value.length === 0 || disabled) return;
    if (onSend(value)) setText('');
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // Cmd/Ctrl+Enter sends on desktop; plain Enter stays a newline so multi-line
    // prompts are possible on a phone where there is no modifier key.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
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
      <button type="button" className="primary" onClick={send} disabled={disabled || text.length === 0}>
        Send
      </button>
    </div>
  );
}
