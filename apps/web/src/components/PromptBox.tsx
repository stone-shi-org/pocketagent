import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import type { EffortLevel, ModelInfo, PromptImage, SlashCommandInfo } from '@pocketagent/protocol';
import { readImageFile } from '../agent/image-attachment.js';
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
  /**
   * Returns false when the socket is down, so the draft (and any attached
   * image) is kept rather than cleared. `image` is only ever set for a
   * structured Claude Agent SDK session — see `readImageFile`'s caller here
   * for the only place one gets attached.
   */
  onSend: (text: string, image?: PromptImage) => boolean;
  disabled: boolean;
  /**
   * Shows the attach button (file picker + paste-an-image). Only the Claude
   * Agent SDK backend's `prompt()` actually understands an image content
   * block — `ws/index.ts` rejects one from any other backend outright — so
   * this defaults to hidden rather than showing an affordance that would
   * just error for every other agent and for terminal sessions.
   */
  supportsImageAttachment?: boolean;
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
  /**
   * True while the agent is generating a turn. Swaps the send button into a
   * stop button (see `onInterrupt`) instead of showing a separate control
   * elsewhere — undefined/false is indistinguishable from "not generating",
   * same optional-prop convention as `models`/`commands` above, so callers
   * that never report this (TerminalPage, ChatPreviewPage) just keep the
   * plain send button.
   */
  busy?: boolean;
  /** Stops the in-flight turn. Only meaningful (and only rendered) while `busy`. */
  onInterrupt?: () => void;
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
  supportsImageAttachment = false,
  commands = [],
  models = [],
  currentModel = null,
  onSetModel,
  effort = null,
  onSetEffort,
  busy = false,
  onInterrupt,
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Not persisted to sessionStorage like `text` — an attached image surviving
  // a reload but pointing at nothing the user can see again would be worse
  // than just losing the draft, since there would be no way to tell it was
  // still going to be sent.
  const [attachedImage, setAttachedImage] = useState<PromptImage | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
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
  // Referenced by the outside-click dismissal below — a click on the chip
  // itself must not count as "outside" (the chip's own onClick already
  // toggles the picker; treating it as outside too would close it and then
  // immediately reopen it, a no-op that looks like the picker is stuck).
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const modelChipRef = useRef<HTMLButtonElement>(null);

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

  // Dismiss the model picker on Escape or a click/tap outside it. It used to
  // rely on the chip's own blur for this (a stale comment on the `onMouseDown`
  // handlers below still claims that), but no blur handler ever existed, so
  // the popover stayed open until an option was picked or the chip was
  // clicked again. A document-level listener, not a blur handler, is also
  // what makes Escape work regardless of which element currently has focus
  // (the chip button, a picker row, or nothing) — the textarea's own
  // `onKeyDown` only ever saw Escape while the textarea itself was focused.
  useEffect(() => {
    if (!modelPickerOpen) return;
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === 'Escape') setModelPickerOpen(false);
    }
    function onPointerDown(event: PointerEvent): void {
      const target = event.target as Node;
      if (modelPickerRef.current?.contains(target) || modelChipRef.current?.contains(target)) return;
      setModelPickerOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [modelPickerOpen]);

  function send(): void {
    const value = text;
    if ((value.length === 0 && !attachedImage) || disabled) return;
    if (onSend(value, attachedImage ?? undefined)) {
      setText('');
      setAttachedImage(null);
    }
  }

  /** Shared by the attach button's file input and pasting an image directly. */
  async function attach(file: File): Promise<void> {
    setAttachError(null);
    try {
      setAttachedImage(await readImageFile(file));
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : 'Could not attach that image.');
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const item = Array.from(event.clipboardData.items).find((i) => i.type.startsWith('image/'));
    if (!item) return; // an ordinary text paste — let the browser handle it
    const file = item.getAsFile();
    if (!file) return;
    // A pasted image is not also text, so nothing here competes with a normal
    // paste — but prevent it anyway in case the OS also puts a filename or a
    // data URL on the clipboard as a text fallback.
    event.preventDefault();
    void attach(file);
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

    // Model-picker Escape is handled by the document-level listener above —
    // it needs to work regardless of focus, not just while the textarea has
    // it, so it isn't duplicated here.

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
        <div className="model-picker" role="listbox" aria-label="Models" ref={modelPickerRef}>
          {models.map((model) => (
            <button
              key={model.value}
              type="button"
              role="option"
              aria-selected={model.value === currentModelInfo?.value}
              className={model.value === currentModelInfo?.value ? 'active' : ''}
              onMouseDown={(e) => {
                // mousedown (not click) so this fires before the document-level
                // pointerdown-based outside-click dismissal above resolves —
                // both see the same press, but picking a row this way and
                // being dismissed as "outside" would otherwise race.
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
      {supportsImageAttachment && !pickerOpen && (attachedImage || attachError) && (
        <div className="attach-preview">
          {attachedImage ? (
            <>
              <img
                src={`data:${attachedImage.mediaType};base64,${attachedImage.data}`}
                alt="Attached"
              />
              <button
                type="button"
                className="attach-remove"
                onClick={() => setAttachedImage(null)}
                aria-label="Remove attached image"
              >
                <Icon name="close" size={13} />
              </button>
            </>
          ) : (
            <span className="attach-error">{attachError}</span>
          )}
        </div>
      )}
      {supportsImageAttachment && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = ''; // lets the same file be picked again later
              if (file) void attach(file);
            }}
          />
          <button
            type="button"
            className="attach-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            aria-label="Attach an image"
          >
            <Icon name="attach" size={19} />
          </button>
        </>
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
        onPaste={supportsImageAttachment ? onPaste : undefined}
        placeholder="Type a prompt…"
        rows={1}
        aria-label="Prompt"
        enterKeyHint="enter"
      />
      {models.length > 0 && (
        <button
          type="button"
          className="model-chip"
          onClick={() => setModelPickerOpen((v) => !v)}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={modelPickerOpen}
          aria-label={`Model: ${currentModelLabel ?? 'unknown'}. Choose a different model.`}
          ref={modelChipRef}
        >
          <span>{currentModelLabel ?? '…'}</span>
          <Icon name="chevron-down" size={14} />
        </button>
      )}
      {/* Stop, not send, while a turn is in flight — one control instead of a
          separate "Stop generating" chip elsewhere on the page (it used to
          live in `.agent-strip`, disconnected from the box the user is
          actually looking at while typing the next thing). `text.length`
          never gates this in the busy state: stopping shouldn't require
          having typed anything. */}
      <button
        type="button"
        className={busy ? 'primary stop' : 'primary'}
        onClick={busy ? onInterrupt : send}
        disabled={busy ? disabled : disabled || (text.length === 0 && !attachedImage)}
        aria-label={busy ? 'Stop generating' : 'Send prompt'}
      >
        <Icon name={busy ? 'stop' : 'arrow-up'} size={busy ? 16 : 18} />
      </button>
    </div>
  );
}
