import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import {
  LIMITS,
  type EffortLevel,
  type ModelInfo,
  type PromptImage,
  type SlashCommandInfo,
} from '@pocketagent/protocol';
import { readImageFile } from '../agent/image-attachment.js';
import { resolveCurrentModel } from '../agent/transcript.js';
import { getVoiceDirectSendPref } from '../agent/voice-prefs.js';
import type { RecordedUtterance } from '../audio/capture.js';
import { unlockAudioContext } from '../audio/audio-context.js';
import { AttachButton } from './AttachButton.js';
import { Icon } from './Icon.js';
import { MicButton, type MicButtonHandle } from './MicButton.js';
import { useAudioInputDevices } from '../audio/devices.js';
import { MicPicker } from './MicPicker.js';


const WAVE_BAR_PROFILES = [
  0.25, 0.35, 0.45, 0.6, 0.75, 0.85, 0.95, 1.0, 0.95, 0.85, 0.75, 0.6, 0.45, 0.35,
  0.3, 0.4, 0.55, 0.7, 0.85, 0.95, 1.0, 0.9, 0.8, 0.65, 0.5, 0.35, 0.25, 0.2,
];

export function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

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
  off: 'Off',
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
   * PA-85: a transient, informational message about what the utterance
   * harness just did — "Ignored — filler only (\"oh\")", "Parked for review
   * — low confidence (0.41)". Rendered distinctly from `liveListenError`,
   * because this is a normal outcome being disclosed rather than a fault: a
   * rejection nobody can see reads as a dead microphone.
   */
  liveListenNotice?: string | null;
  /**
   * PA-85: an utterance the harness parked instead of sending. Appended to
   * whatever is already in the box on every change of `seq`, reusing PA-82's
   * review-before-send affordance rather than inventing a second one.
   *
   * A monotonic-`seq` list rather than one slot, and consumed as a
   * high-water mark: the same borderline utterance said twice is appended
   * twice (the alternative silently swallows a repeat, which is precisely
   * what someone does when they think they were not heard), while a remount
   * re-appends nothing and two parks arriving in one render batch both land.
   */
  reviewText?: { items: { text: string; seq: number }[] } | null;
  /**
   * PA-83 #4: mirrors `TtsPlaybackQueue.isPlaying()` — true while the
   * agent's spoken reply is actually being read aloud. Swaps the
   * "Listening…" indicator for a "Speaking…" one with its own stop control
   * (see `onStopSpeaking`); the two never show at once, since barge-in
   * (speech detected while this is true) silences playback before the
   * endpointer would otherwise report speech.
   */
  isSpeaking?: boolean;
  /** Silences the talk-back only — distinct from `onInterrupt`, which stops
   *  the agent's whole turn. Only meaningful (and only rendered) while
   *  `isSpeaking`. */
  onStopSpeaking?: () => void;
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
   * PA-113: Whether reasoning/thinking is enabled.
   */
  thinking?: boolean;
  /**
   * PA-113: Toggle reasoning/thinking on or off.
   */
  onToggleThinking?: () => void;
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
  liveListenNotice = null,
  reviewText = null,
  isSpeaking = false,
  onStopSpeaking,
  commands = [],
  models = [],
  currentModel = null,
  onSetModel,
  effort = null,
  onSetEffort,
  thinking = true,
  onToggleThinking,
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
  const sentHistoryRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number>(-1);
  const draftBeforeHistoryRef = useRef<string>('');
  // Not persisted to sessionStorage like `text` — an attached image surviving
  // a reload but pointing at nothing the user can see again would be worse
  // than just losing the draft, since there would be no way to tell it was
  // still going to be sent.
  const [attachedImage, setAttachedImage] = useState<PromptImage | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [isVoiceRecording, setIsVoiceRecording] = useState(false);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [isOverDiscard, setIsOverDiscard] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const micButtonRef = useRef<MicButtonHandle>(null);
  const { devices: audioDevices, selectedDeviceId: selectedMicDeviceId, selectDevice: selectAudioDevice } =
    useAudioInputDevices();
  const [micPickerOpen, setMicPickerOpen] = useState(false);

  const currentMicLabel = useMemo(() => {
    if (!selectedMicDeviceId) return 'Default';
    const found = audioDevices.find((d) => d.deviceId === selectedMicDeviceId);
    return found ? found.label : 'Microphone';
  }, [selectedMicDeviceId, audioDevices]);

  /** Highest `reviewText` seq already appended — see the effect below. */
  const consumedReviewSeqRef = useRef(0);


  /**
   * PA-85: append utterances the harness parked for review.
   *
   * Deliberately does *not* focus the textarea, unlike
   * `handleVoiceRecorded`'s own review path: that one follows a deliberate
   * tap on the mic, whereas this one can fire at any moment in a hands-free
   * session, and popping the on-screen keyboard unasked is exactly the wrong
   * thing to do to someone who is not holding the phone.
   *
   * Two things this cannot do, both learned the hard way. It cannot key off
   * `seq` alone: `AgentPage` never clears `reviewText`, so a remount — a
   * desktop tab switch, or crossing the 900px/`pointer: fine` boundary that
   * swaps the whole shell — would re-run the effect with the same `seq` and
   * append the same utterance twice. And it cannot treat `seq` as a *signal*
   * to append one item: two parks resolving in one React batch collapse into
   * a single effect run carrying only the later `seq`, silently losing the
   * first — the exact failure the counter was supposed to prevent.
   *
   * So `seq` is a **high-water mark**: the effect appends every id above the
   * last one it consumed, and the ref survives re-render while the parked
   * items themselves are held by `AgentPage`. Nothing is lost and nothing is
   * duplicated, which is the whole promise of "parked, not dropped".
   */
  useEffect(() => {
    if (!reviewText) return;
    const pending = reviewText.items.filter((item) => item.seq > consumedReviewSeqRef.current);
    if (pending.length === 0) return;
    consumedReviewSeqRef.current = pending[pending.length - 1]!.seq;
    const incoming = pending
      .map((item) => item.text.trim())
      .filter(Boolean)
      .join(' ');
    if (!incoming) return;
    setText((prev) => (prev.trim() ? `${prev.trim()} ${incoming}` : incoming));
  }, [reviewText]);

  useEffect(() => {
    if (!isVoiceRecording) {
      setElapsedSeconds(0);
      return;
    }
    const timer = setInterval(() => {
      setElapsedSeconds((s) => s + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [isVoiceRecording]);

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
    if ((value.length === 0 && !attachedImage) || disabled || value.length > LIMITS.maxInputChars) return;
    void unlockAudioContext();
    if (onSend(value, attachedImage ?? undefined)) {
      if (value.trim()) {
        const trimmed = value.trim();
        sentHistoryRef.current = [
          ...sentHistoryRef.current.filter((h) => h !== trimmed),
          trimmed,
        ];
        historyIndexRef.current = -1;
        draftBeforeHistoryRef.current = '';
      }
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
   * The mic button's release/finish handler (PA-20, enhanced in PA-82): transcribe,
   * then either insert the text into the prompt box for review (default) or send
   * immediately if the direct-send setting is enabled.
   */
  async function handleVoiceRecorded(utterance: RecordedUtterance): Promise<void> {
    if (!onTranscribeVoice) return;
    setVoiceError(null);
    if (!utterance.audioBase64) {
      setVoiceError("Didn't catch that — speak while the mic is active.");
      return;
    }
    setIsTranscribing(true);
    let transcriptText: string;
    try {
      transcriptText = await onTranscribeVoice({ data: utterance.audioBase64, durationMs: utterance.durationMs });
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : 'Could not transcribe that recording.');
      return;
    } finally {
      setIsTranscribing(false);
    }
    const trimmed = transcriptText.trim();
    if (!trimmed) {
      setVoiceError("Didn't catch that — try again.");
      return;
    }
    if (getVoiceDirectSendPref()) {
      void unlockAudioContext();
      const fullText = text.trim() ? `${text.trim()} ${trimmed}` : trimmed;
      if (onSend(fullText, attachedImage ?? undefined)) {
        setText('');
        setAttachedImage(null);
      }
    } else {
      setText((prev) => (prev.trim() ? `${prev.trim()} ${trimmed}` : trimmed));
      setTimeout(() => {
        ref.current?.focus();
        if (ref.current) {
          const len = ref.current.value.length;
          ref.current.setSelectionRange(len, len);
        }
      }, 50);
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
    if (level !== null && level !== 'off' && thinking === false) {
      onToggleThinking?.();
    }
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
    // Guard against IME composition: Enter/Tab during IME conversion must not
    // send prompt or trigger slash command picker selection.
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }

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
    } else {
      // Prompt history recall when slash picker is closed
      if (event.key === 'ArrowUp') {
        const isAtStart =
          ref.current === null ||
          (ref.current.selectionStart === 0 && ref.current.selectionEnd === 0);
        if (isAtStart && sentHistoryRef.current.length > 0) {
          event.preventDefault();
          if (historyIndexRef.current === -1) {
            draftBeforeHistoryRef.current = text;
            historyIndexRef.current = sentHistoryRef.current.length - 1;
          } else if (historyIndexRef.current > 0) {
            historyIndexRef.current -= 1;
          }
          const recalled = sentHistoryRef.current[historyIndexRef.current];
          if (recalled !== undefined) {
            setText(recalled);
          }
          return;
        }
      }
      if (event.key === 'ArrowDown') {
        if (historyIndexRef.current >= 0) {
          event.preventDefault();
          if (historyIndexRef.current < sentHistoryRef.current.length - 1) {
            historyIndexRef.current += 1;
            const recalled = sentHistoryRef.current[historyIndexRef.current];
            if (recalled !== undefined) {
              setText(recalled);
            }
          } else {
            historyIndexRef.current = -1;
            setText(draftBeforeHistoryRef.current);
          }
          return;
        }
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
    <div className={isVoiceRecording ? 'promptbar recording' : 'promptbar'}>
      {micPickerOpen && (
        <MicPicker
          devices={audioDevices}
          selectedDeviceId={selectedMicDeviceId}
          onSelect={(id) => {
            selectAudioDevice(id);
          }}
          onClose={() => setMicPickerOpen(false)}
        />
      )}
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
      {!pickerOpen && !isVoiceRecording && (attachedImage || attachError || voiceError || liveListenError) && (
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
      {/* PA-91: keep the attach trigger mounted (disabled) while recording
          or transcribing so the mic button immediately beside it does not jump
          under the user's held finger or pointer. */}
      {supportsImageAttachment && (
        <AttachButton
          inputRef={fileInputRef}
          onFile={(file) => void attach(file)}
          disabled={disabled || isVoiceRecording || isTranscribing}
        />
      )}
      {/*
        PA-20 & PA-97: live stream component consolidated as a unified capsule
        taking the left part of the prompt box, perfectly aligned with the buttons
        and textarea baseline (no fragmented controls or sandwiched attach button).
        The broadcast icon button at the front acts as the active toggle to turn off.
      */}
      {!isVoiceRecording && !isTranscribing && supportsLiveListen && onSetLiveListen && liveListenActive && (
        <div className="live-listen-indicator" role="status" aria-live="polite">
          <button
            type="button"
            className="live-listen-btn active"
            onClick={() => onSetLiveListen(false)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMicPickerOpen((v) => !v);
            }}
            disabled={disabled}
            aria-pressed={true}
            aria-label="Turn off live listening"
            title="Turn off live listening"
          >
            <Icon name="live-listen" size={17} />
          </button>
          {isSpeaking ? (
            // PA-83 #4: while the reply is actually being read aloud, this
            // replaces the meter with a dedicated stop control — "otherwise
            // it talks very long" was the ticket's own complaint, and
            // waiting to detect the user's own speech (barge-in) is not the
            // only way to want it to stop.
            <>
              <span className="live-listen-status">Speaking…</span>
              {onStopSpeaking && (
                <button
                  type="button"
                  className="live-listen-stop-btn"
                  onClick={onStopSpeaking}
                  aria-label="Stop speaking"
                  title="Stop speaking"
                >
                  <Icon name="stop" size={13} />
                  <span>Stop</span>
                </button>
              )}
            </>
          ) : (
            <>
              <span className="live-listen-status">Listening…</span>
              <span className="live-listen-meter" aria-hidden="true">
                <span
                  className="live-listen-meter-fill"
                  style={{ transform: `scaleX(${Math.min(1, micLevel * 8)})` }}
                />
              </span>
              <button
                type="button"
                className="live-listen-mic-btn"
                onClick={() => setMicPickerOpen((v) => !v)}
                title={`Microphone: ${currentMicLabel}. Click to switch.`}
                aria-label={`Microphone: ${currentMicLabel}. Click to switch.`}
              >
                <Icon name="mic" size={12} />
                <span className="live-listen-mic-name">{currentMicLabel}</span>
                <Icon name="chevron-down" size={10} />
              </button>
            </>
          )}
          {/* PA-85: why the harness just ignored or parked something. Inside
              the indicator rather than in the error row above, because it is
              a normal outcome of listening, not a fault — and the indicator
              is the one element guaranteed to be on screen whenever
              live-listen is on. */}
          {liveListenNotice && <span className="live-listen-notice">{liveListenNotice}</span>}
        </div>
      )}
      {supportsVoiceInput && onTranscribeVoice && !liveListenActive && (
        <div className="mic-control-group">
          <MicButton
            key="mic-btn"
            ref={micButtonRef}
            onRecorded={(utterance) => void handleVoiceRecorded(utterance)}
            onError={setVoiceError}
            onRecordingChange={setIsVoiceRecording}
            onLevel={setVoiceLevel}
            onOverDiscardChange={setIsOverDiscard}
            disabled={disabled || isTranscribing}
            deviceId={selectedMicDeviceId}
            onContextMenu={(e) => {
              e.preventDefault();
              setMicPickerOpen((v) => !v);
            }}
          />
          <button
            type="button"
            className="mic-select-btn"
            onClick={() => setMicPickerOpen((v) => !v)}
            disabled={disabled || isVoiceRecording || isTranscribing}
            aria-label={`Microphone: ${currentMicLabel}. Choose microphone.`}
            title={`Microphone: ${currentMicLabel}. Choose microphone.`}
          >
            <Icon name="chevron-down" size={10} />
          </button>
        </div>
      )}
      {isVoiceRecording ? (
        <div className="promptbar-recording" role="status" aria-label="Recording audio">
          <span className="promptbar-recording-time">{formatElapsed(elapsedSeconds)}</span>
          <div
            className="promptbar-wave"
            aria-hidden="true"
            title="Click to finish recording"
            onClick={() => void micButtonRef.current?.stop()}
          >
            {WAVE_BAR_PROFILES.map((profile, index) => (
              <span
                key={index}
                className="promptbar-wave-bar"
                style={{
                  transform: `scaleY(${Math.min(1, Math.max(0.14, (voiceLevel * 7 + 0.12) * profile))})`,
                }}
              />
            ))}
          </div>
          <button
            type="button"
            className={isOverDiscard ? 'voice-discard-btn hovered' : 'voice-discard-btn'}
            onClick={() => void micButtonRef.current?.cancel()}
            aria-label="Cancel recording (discard)"
            title="Cancel recording (discard)"
          >
            <Icon name="stop" size={15} />
          </button>
        </div>
      ) : isTranscribing ? (
        <div className="promptbar-transcribing" role="status" aria-live="polite">
          <span className="live-listen-dot" aria-hidden="true" />
          <span>Transcribing voice…</span>
        </div>
      ) : (
        <>
          {supportsLiveListen && onSetLiveListen && !liveListenActive && (
            <button
              type="button"
              className="live-listen-btn"
              onClick={() => onSetLiveListen(true)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMicPickerOpen((v) => !v);
              }}
              disabled={disabled}
              aria-pressed={false}
              aria-label="Turn on live listening (hands-free)"
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
          {onToggleThinking && (
            <button
              type="button"
              className={`thinking-chip${thinking === false ? ' off' : ' on'}`}
              onClick={onToggleThinking}
              disabled={disabled}
              aria-pressed={thinking !== false}
              aria-label={thinking === false ? 'Thinking is off. Click to turn thinking on.' : 'Thinking is on. Click to turn thinking off.'}
              title={thinking === false ? 'Thinking: Off (click to turn on)' : `Thinking: On${effort ? ` (${effortLabel(effort)})` : ''} (click to turn off)`}
            >
              <Icon name="brain" size={14} />
              <span>{thinking === false ? 'Think Off' : effort ? effortLabel(effort) : 'Think On'}</span>
            </button>
          )}
          {text.length > 500 && (
            <span
              className={`char-counter${text.length > LIMITS.maxInputChars ? ' limit-exceeded' : text.length > LIMITS.maxInputChars * 0.9 ? ' limit-warning' : ''}`}
              aria-label={`${text.length} of ${LIMITS.maxInputChars} characters`}
            >
              {text.length > LIMITS.maxInputChars
                ? `${(text.length - LIMITS.maxInputChars).toLocaleString()} over limit`
                : `${text.length.toLocaleString()} / ${LIMITS.maxInputChars.toLocaleString()}`}
            </span>
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
            disabled={
              busy
                ? disabled
                : disabled ||
                  (text.length === 0 && !attachedImage) ||
                  text.length > LIMITS.maxInputChars
            }
            aria-label={busy ? 'Stop generating' : 'Send prompt'}
          >
            <Icon name={busy ? 'stop' : 'arrow-up'} size={busy ? 16 : 18} />
          </button>
        </>
      )}
    </div>
  );
}
