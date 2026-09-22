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
import { resolveCurrentModel } from '../agent/transcript.js';
import type { RecordedUtterance } from '../audio/capture.js';
import { AttachButton } from './AttachButton.js';
import { Icon } from './Icon.js';
import { MicButton } from './MicButton.js';

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

/** Exported for `ComposerPage`, which shows the same effort picker pre-session. */
export function effortLabel(level: EffortLevel): string {
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
   * Shows the push-to-talk mic button (PA-20 Phase 1). Gated on the server
   * having a `liveSttUrl` configured (`RuntimeSettings.liveSttUrl !== ''` —
   * editable from Settings, not an env var) — unlike `supportsImageAttachment`,
   * this is not backend-specific: any transport can submit a transcribed
   * prompt, since it goes through the same `onSend` a typed message already
   * uses. Requires `onTranscribeVoice` to actually do anything; the two are
   * separate props (rather than inferring one from the other) so a caller
   * that supports voice but has no session yet (nothing to transcribe
   * *into*) can pass neither, the same "undefined means omit the
   * affordance" convention `commands`/`models` already use.
   */
  supportsVoiceInput?: boolean;
  /**
   * Sends one recorded utterance to `POST /api/sessions/:id/voice/transcribe`
   * and resolves with the transcript. `PromptBox` itself never calls the API
   * client directly — same separation `onSend`/`onSetModel` already keep —
   * so the caller (`AgentPage`) owns the actual network call and can decide
   * how to surface a mid-flight auth/connectivity failure consistently with
   * everything else it already handles.
   */
  onTranscribeVoice?: (audio: { data: string; durationMs: number }) => Promise<string>;
  /**
   * Shows the live-listen toggle (PA-20 Phase 2) — the "no button, the app
   * just listens" mode. Unlike `supportsVoiceInput`, this genuinely is
   * structured-only: barge-in needs `interrupt` and talk-back needs
   * `text_delta`, neither of which a terminal session has. Off by default,
   * every session, every time — this mode removes push-to-talk's implicit
   * privacy guarantee (mic can't be listening unless a finger is down), so
   * nothing about it may ever default to on.
   */
  supportsLiveListen?: boolean;
  /**
   * The session's *actual* current live-listen state — mirrors
   * `SessionInfo.voiceModeEnabled`/the `voice_mode_changed` push, not local
   * component state, so two tabs open on the same chat and a page reload
   * never show a stale toggle. `AgentPage` owns starting/stopping the real
   * `LiveListenController` and sending the `voice_mode` WS message; this
   * component only reflects the result, the same read-only relationship
   * `currentModel` already has to the model picker.
   */
  liveListenActive?: boolean;
  /** Flips the toggle. `AgentPage` decides whether to actually honor it
   *  (e.g. a mic-permission denial keeps the toggle off and reports why via
   *  `onVoiceError` below). */
  onSetLiveListen?: (enabled: boolean) => void;
  /** Live RMS energy while listening, for the ticket's one "listening" UI
   *  affordance — an audio-level meter, deliberately not live captions or
   *  word-by-word partials. `undefined`/`0` while not actively capturing. */
  micLevel?: number;
  /** A live-listen-specific failure (mic revoked mid-session, browser
   *  unsupported), reported by `AgentPage` since that's what owns the
   *  actual `LiveListenController` instance and can observe it async —
   *  same naming convention `attachError` uses for a message prop, not a
   *  callback, despite the neighboring `onX` callback props. */
  liveListenError?: string | null;
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
  supportsVoiceInput = false,
  onTranscribeVoice,
  supportsLiveListen = false,
  liveListenActive = false,
  onSetLiveListen,
  micLevel = 0,
  liveListenError = null,
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
  // Same "don't persist across a reload" reasoning as `attachError` — a
  // transcription failure is only meaningful right after it happens.
  const [voiceError, setVoiceError] = useState<string | null>(null);
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

  /**
   * The mic button's release handler: transcribe, then submit exactly like a
   * typed message — no local `text` state involved, so a voice prompt never
   * flickers through the textarea on its way out. An empty/whitespace-only
   * transcript (silence, or the utterance was too short for whisper to hear
   * anything) is treated as a soft failure rather than sending a blank
   * prompt no one meant to submit.
   */
  async function handleVoiceRecorded(utterance: RecordedUtterance): Promise<void> {
    if (!onTranscribeVoice) return;
    setVoiceError(null);
    let text: string;
    try {
      text = await onTranscribeVoice({ data: utterance.audioBase64, durationMs: utterance.durationMs });
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : 'Could not transcribe that recording.');
      return;
    }
    if (!text.trim()) {
      setVoiceError("Didn't catch that — try again.");
      return;
    }
    onSend(text);
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
    if (command.name === 'add' && supportsImageAttachment) {
      setText('');
      setDismissed(true);
      fileInputRef.current?.click();
      return;
    }
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

  // The model this session is actually on — or, once the list has caught up
  // with `session_started`/`models_available` but no explicit selection has
  // been confirmed yet (agy never reports one in `init` — see
  // `resolveCurrentModel`'s doc comment), the first available choice. Both
  // the chip's own label and the picker's highlighted row read from this, so
  // they never disagree about what "current" means.
  const currentModelInfo = resolveCurrentModel(models, currentModel);
  const currentModelLabel = currentModelInfo?.displayName ?? null;
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
          {models.map((model) => {
            const isCurrent = model.value === currentModelInfo?.value;
            return (
              <button
                key={model.value}
                type="button"
                role="option"
                aria-selected={isCurrent}
                className={isCurrent ? 'active' : ''}
                onMouseDown={(e) => {
                  // mousedown (not click) so this fires before the document-level
                  // pointerdown-based outside-click dismissal above resolves —
                  // both see the same press, but picking a row this way and
                  // being dismissed as "outside" would otherwise race.
                  e.preventDefault();
                  pickModel(model);
                }}
              >
                <span className="model-row">
                  <span className="model-name">{model.displayName}</span>
                  {/* The `.active` background alone reads as "hovered" at a
                      glance on a phone, where there is no hover state to
                      contrast it against — a checkmark is the one indicator
                      that survives on a static screenshot too. */}
                  {isCurrent && <Icon name="check" size={14} />}
                </span>
                {model.description && <span className="model-desc">{model.description}</span>}
              </button>
            );
          })}
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
      {!pickerOpen && (attachedImage || attachError || voiceError || liveListenError) && (
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
            <span className="attach-error">{attachError ?? voiceError ?? liveListenError}</span>
          )}
        </div>
      )}
      {/*
        PA-20's persistent "mic is live" indicator: rendered inline, always,
        whenever this session's live-listen mode is actually on — never only
        transiently (e.g. tucked inside the picker-gated preview above,
        which a slash-command picker would hide). This mode removes
        push-to-talk's implicit privacy guarantee (mic can't be listening
        unless a finger is down), so the UI has to make that trade-off
        honest on every render, not just at the moment the toggle was
        clicked. The level meter is deliberately the *only* extra feedback —
        no live captions, no partials, per the ticket.
      */}
      {liveListenActive && (
        <div className="live-listen-indicator" role="status" aria-live="polite">
          <span className="live-listen-dot" aria-hidden="true" />
          <span>Listening…</span>
          <span className="live-listen-meter" aria-hidden="true">
            <span
              className="live-listen-meter-fill"
              style={{ transform: `scaleX(${Math.min(1, micLevel * 8)})` }}
            />
          </span>
        </div>
      )}
      {supportsImageAttachment && (
        <AttachButton inputRef={fileInputRef} onFile={(file) => void attach(file)} disabled={disabled} />
      )}
      {supportsVoiceInput && onTranscribeVoice && !liveListenActive && (
        <MicButton
          onRecorded={(utterance) => void handleVoiceRecorded(utterance)}
          onError={setVoiceError}
          disabled={disabled}
        />
      )}
      {supportsLiveListen && onSetLiveListen && (
        <button
          type="button"
          className={liveListenActive ? 'live-listen-btn active' : 'live-listen-btn'}
          onClick={() => onSetLiveListen(!liveListenActive)}
          disabled={disabled}
          aria-pressed={liveListenActive}
          aria-label={liveListenActive ? 'Turn off live listening' : 'Turn on live listening (hands-free)'}
        >
          <Icon name="live-listen" size={19} />
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
