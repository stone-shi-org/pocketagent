import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { EffortLevel, ModelInfo, SlashCommandInfo } from '@pocketagent/protocol';
import { modelDisplayName } from '../agent/transcript.js';
import { Icon } from './Icon.js';

/**
 * Friendlier names for the effort levels the Claude Agent SDK defines.
 * `EffortLevel` itself is a free-form string (other backends use different
 * vocabularies — codex adds `'ultra'`, pi adds `'off'`/`'minimal'` — see the
 * protocol type's own doc comment), so anything not in this table falls back
 * to a plain capitalized rendering in `effortLabel` below rather than
 * guessing a nicer name for a word this composer has never seen.
 */
const KNOWN_EFFORT_LABELS: Partial<Record<EffortLevel, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

function effortLabel(level: EffortLevel): string {
  return KNOWN_EFFORT_LABELS[level] ?? level.charAt(0).toUpperCase() + level.slice(1);
}

const DRAFT_KEY_PREFIX = 'pocketagent:draft:';
const MAX_HEIGHT = 160;
/** Enough to scan on a phone screen without the picker itself needing to scroll far. */
const MAX_PICKER_RESULTS = 8;

interface Props {
  sessionId: string;
  /** Returns false when the socket is down, so the draft is kept. */
  onSend: (text: string) => boolean;
  disabled: boolean;
  /**
   * Slash commands this agent currently supports, for the `/` picker.
   * Undefined/empty just means no picker — the box still sends whatever text
   * is typed, so an agent-agnostic caller (e.g. TerminalPage) can omit this
   * entirely rather than pass an empty array on purpose.
   */
  commands?: SlashCommandInfo[];
  /**
   * Models this agent can be switched to, for the model picker next to the
   * send button. Undefined/empty hides the picker entirely — same convention
   * as `commands` above, since not every agent backend reports any (only the
   * Claude Agent SDK does today).
   */
  models?: ModelInfo[];
  /** The model this session is currently using, if known yet. */
  currentModel?: string | null;
  /**
   * Switch the session's model. Effective on the *next* prompt sent, not the
   * one already streaming — the picker just fires the request; it does not
   * wait for a round trip before closing.
   */
  onSetModel?: (model: string) => void;
  /**
   * The effort level the user last picked, or null for "the model's own
   * default" — see `TranscriptState.effort`'s doc comment for why there is no
   * third "the model's actual starting level" state to show instead.
   */
  effort?: EffortLevel | null;
  /** Switch effort level. Same next-prompt timing as `onSetModel`. */
  onSetEffort?: (effort: EffortLevel | null) => void;
}

/**
 * Only matches when `/` starts the *whole* box with no space yet — the
 * common case of typing a command as the first thing in an empty composer.
 * Deliberately not cursor-aware (this is a plain controlled textarea, not a
 * PTY): a `/` typed mid-sentence is just a slash, not a trigger.
 */
const SLASH_TRIGGER = /^\/(\S*)$/;

/** The fragment after the leading `/`, or null when `text` isn't a trigger. */
export function slashFragment(text: string): string | null {
  return SLASH_TRIGGER.exec(text)?.[1] ?? null;
}

/**
 * Commands whose name or an alias starts with `fragment`, capped for a phone
 * screen. Exported pure so the matching rule is tested without rendering the
 * component — same pattern as `ctrlSequence` in MobileKeyBar.tsx.
 */
export function filterSlashCommands(
  commands: SlashCommandInfo[],
  fragment: string,
  max = MAX_PICKER_RESULTS,
): SlashCommandInfo[] {
  const needle = fragment.toLowerCase();
  return commands
    .filter(
      (c) => c.name.toLowerCase().startsWith(needle) || c.aliases.some((a) => a.toLowerCase().startsWith(needle)),
    )
    .slice(0, max);
}

/**
 * A plain textarea that composes a prompt and sends it followed by Enter.
 *
 * Composing a paragraph directly in xterm on a phone is miserable: no
 * autocorrect, no cursor dragging, and a stray Enter submits half a thought.
 * The draft survives reconnects — and reloads — via sessionStorage, so a dropped
 * tunnel never costs you the text you just typed.
 */
export function PromptBox({
  sessionId,
  onSend,
  disabled,
  commands = [],
  models = [],
  currentModel = null,
  onSetModel,
  effort = null,
  onSetEffort,
}: Props): JSX.Element {
  const key = DRAFT_KEY_PREFIX + sessionId;
  const [text, setText] = useState(() => {
    try {
      return sessionStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  });
  const ref = useRef<HTMLTextAreaElement>(null);
  const [selected, setSelected] = useState(0);
  // One entry per currently-rendered picker row, so the active one can be
  // scrolled into view on arrow-key navigation — `.slash-picker` scrolls
  // (`max-height` + `overflow-y: auto`) but the browser has no reason to
  // follow a *keyboard* selection change on its own the way it would a
  // mouse click; without this, arrow-down past the visible rows moves
  // `selected` (and the `active` class) right off screen with nothing
  // showing which command Enter would actually pick.
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Escape hides the picker without touching the text underneath it; typing
  // again (any change at all) un-dismisses it, same as a normal autocomplete.
  const [dismissed, setDismissed] = useState(false);
  // The model picker is an independent toggle (a click, not a text trigger),
  // so it gets its own open flag rather than piggybacking on `dismissed`.
  const [modelPickerOpen, setModelPickerOpen] = useState(false);

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

  const fragment = slashFragment(text);
  const filtered = useMemo(
    () => (fragment === null || commands.length === 0 ? [] : filterSlashCommands(commands, fragment)),
    [commands, fragment],
  );
  const pickerOpen = !dismissed && filtered.length > 0;

  // Re-clamp rather than reset to 0 on every keystroke — arrow-key selection
  // survives the list narrowing as long as the index is still in range.
  useEffect(() => {
    setSelected((prev) => Math.min(prev, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  // `block: 'nearest'` scrolls the minimum amount needed to bring the row
  // fully into `.slash-picker`'s own scroll area — never yanks the whole
  // page, and does nothing at all once the row is already visible.
  useEffect(() => {
    itemRefs.current[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  function send(): void {
    const value = text;
    if (value.length === 0 || disabled) return;
    if (onSend(value)) setText('');
  }

  function pick(command: SlashCommandInfo): void {
    setText(`/${command.name} `);
    setDismissed(false);
    ref.current?.focus();
  }

  function pickModel(model: ModelInfo): void {
    onSetModel?.(model.value);
    setModelPickerOpen(false);
  }

  function pickEffort(level: EffortLevel | null): void {
    onSetEffort?.(level);
    setModelPickerOpen(false);
  }

  // The chip's own label: the current model's display name once it's known
  // (vendor prefix stripped — see `modelDisplayName`), falling back to the
  // first available choice so the chip is never blank while
  // `session_started` is still in flight. Effort deliberately does not
  // appear here — the chip is "just the model name", the picker is where
  // effort lives.
  const currentModelLabel = modelDisplayName(models, currentModel) ?? models[0]?.displayName ?? null;
  // The model this session is actually on, if the list has caught up with
  // `session_started` — its `supportedEffortLevels` decide what the effort
  // section of the picker offers, since that varies per model.
  const currentModelInfo = models.find((m) => m.value === currentModel || m.resolvedModel === currentModel) ?? null;
  const effortLevels = currentModelInfo?.supportsEffort ? currentModelInfo.supportedEffortLevels : [];
  // The slash picker is text-triggered and spans the full width; showing both
  // at once would overlap it, so a `/` in progress wins.
  const modelPickerVisible = modelPickerOpen && !pickerOpen && models.length > 0;

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (pickerOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelected((i) => (i + 1) % filtered.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelected((i) => (i - 1 + filtered.length) % filtered.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const chosen = filtered[selected] ?? filtered[0];
        if (chosen) pick(chosen);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }

    if (modelPickerOpen && event.key === 'Escape') {
      event.preventDefault();
      setModelPickerOpen(false);
      return;
    }

    // Enter sends; Shift+Enter is a newline — matches ComposerPage's convention
    // for the first-prompt composer, and the usual chat-app default.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  return (
    <div className="promptbar">
      {modelPickerVisible && (
        <div className="model-picker" role="listbox" aria-label="Models">
          {models.map((model) => (
            <button
              key={model.value}
              type="button"
              role="option"
              aria-selected={model.value === currentModelInfo?.value}
              className={model.value === currentModelInfo?.value ? 'active' : ''}
              onMouseDown={(e) => {
                // mousedown (not click), same reason as the slash picker below:
                // this must fire before the chip's own blur closes the popover.
                e.preventDefault();
                pickModel(model);
              }}
            >
              <span className="model-name">{model.displayName}</span>
              {model.description && <span className="model-desc">{model.description}</span>}
            </button>
          ))}
          {effortLevels.length > 0 && (
            <>
              <div className="model-picker-divider" role="separator">
                Effort
              </div>
              <button
                type="button"
                role="option"
                aria-selected={effort === null}
                className={effort === null ? 'active' : ''}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickEffort(null);
                }}
              >
                <span className="model-name">Default</span>
              </button>
              {effortLevels.map((level) => (
                <button
                  key={level}
                  type="button"
                  role="option"
                  aria-selected={effort === level}
                  className={effort === level ? 'active' : ''}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickEffort(level);
                  }}
                >
                  <span className="model-name">{effortLabel(level)}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
      {pickerOpen && (
        <div className="slash-picker" role="listbox" aria-label="Slash commands">
          {filtered.map((command, index) => (
            <button
              key={command.name}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              type="button"
              role="option"
              aria-selected={index === selected}
              className={index === selected ? 'active' : ''}
              onMouseDown={(e) => {
                // mousedown (not click) so this fires before the textarea's own
                // blur, otherwise the picker vanishes before the tap registers.
                e.preventDefault();
                pick(command);
              }}
            >
              <span className="cmd-name">
                /{command.name}
                {command.argumentHint && <span className="cmd-hint">{command.argumentHint}</span>}
              </span>
              {command.description && <span className="cmd-desc">{command.description}</span>}
            </button>
          ))}
        </div>
      )}
      {models.length > 0 && (
        <button
          type="button"
          className="model-chip"
          onClick={() => setModelPickerOpen((v) => !v)}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={modelPickerOpen}
          aria-label={`Model: ${currentModelLabel ?? 'unknown'}. Choose a different model.`}
        >
          <span>{currentModelLabel ?? '…'}</span>
          <Icon name="chevron-down" size={14} />
        </button>
      )}
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setDismissed(false);
          setModelPickerOpen(false);
        }}
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
