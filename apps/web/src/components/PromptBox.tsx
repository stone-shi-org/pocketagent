import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import {
  LIMITS,
  type EffortLevel,
  type ModelInfo,
  type PromptImage,
  type SlashCommandInfo,
  type UploadAttachmentResponse,
} from '@pocketagent/protocol';
import { readImageFile } from '../agent/image-attachment.js';
import {
  fileAttachProblem,
  filesBlockSend,
  filesFromDataTransfer,
  readyAttachmentIds,
  routeAttachment,
  type PendingFile,
} from '../agent/file-attachment.js';
import { PendingFileChips } from './FileChips.js';
import { resolveCurrentModel } from '../agent/transcript.js';
import { getVoiceDirectSendPref } from '../agent/voice-prefs.js';
import type { RecordedUtterance } from '../audio/capture.js';
import { unlockAudioContext } from '../audio/audio-context.js';
import { AttachButton } from './AttachButton.js';
import { Icon } from './Icon.js';
import { MicButton, type MicButtonHandle } from './MicButton.js';
import { useAudioInputDevices } from '../audio/devices.js';
import { MicPicker } from './MicPicker.js';
import { appendPromptHistory, getPromptHistory } from '../agent/prompt-history.js';


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
  onSend: (text: string, image?: PromptImage, attachments?: string[]) => boolean;
  disabled: boolean;
  /**
   * PA-136: uploads one non-image file (`POST /api/attachments`) and resolves
   * with its id, which `onSend` then carries in `attachments`. Its presence is
   * what turns on files: the picker takes any type and several at once, and
   * paste and drag-and-drop take files too. The caller owns the request, for
   * the same reason `onTranscribeVoice` is a prop — this component never
   * talks to the API itself.
   */
  onUploadFile?: (file: File, signal: AbortSignal) => Promise<UploadAttachmentResponse>;
  /**
   * Shows the attach button (file picker + paste-an-image). Only the Claude
   * Agent SDK backend's `prompt()` actually understands an image content
   * block — `ws/index.ts` rejects one from any other backend outright — so
   * this defaults to hidden rather than showing an affordance that would
   * just error for every other agent and for terminal sessions.
   */
  supportsImageAttachment?: boolean;
  /**
   * PA-122: a line shown under an attached image's preview — the Pocket Agent
   * page uses it to say the selected model cannot read images, before the
   * message is sent rather than after. Sending still goes through: the image
   * is kept in the chat and reaches the model once a vision model is chosen.
   */
  attachmentNote?: string | null;
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
  /**
   * PA-122: while `busy`, also offer Send — beside Stop, not instead of it —
   * because this surface queues a message sent mid-turn (the Pocket Agent
   * chat delivers it after the current step). Callers whose agent cannot
   * take a message mid-turn leave it off and keep the plain Stop button.
   */
  queueWhileBusy?: boolean;
  /**
   * Scoped prompt history storage key (PA-119).
   * - Planner agent passes `plannerPromptHistoryKey()` (global).
   * - Code agent passes `codePromptHistoryKey(session.cwd)` (per-workspace).
   * When provided, previous commands are loaded from and saved to localStorage.
   */
  historyKey?: string;
  /**
   * PA-142: relative file paths in the attached document workspace for `@path`
   * mention autocomplete in the composer.
   */
  workspaceFiles?: readonly string[];
  /** @internal Test-only initial voice recording state (PA-138). */
  initialVoiceRecording?: boolean;
  /** @internal Test-only initial voice RMS level (PA-138). */
  initialVoiceLevel?: number;
  /** @internal Test-only initial voice transcribing state (PA-138). */
  initialTranscribing?: boolean;
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

const MENTION_TRIGGER = /(?:^|\s)@([^\s@]*)$/;

/** PA-142: trailing `@<fragment>` in the composer, or `null` when not mentioning a file. */
export function mentionFragment(text: string): string | null {
  return MENTION_TRIGGER.exec(text)?.[1] ?? null;
}

/** PA-142: matches workspace file paths against `@<fragment>`. */
export function filterWorkspaceFiles(
  files: readonly string[],
  fragment: string,
  max = MAX_PICKER_RESULTS,
): string[] {
  const needle = fragment.toLowerCase();
  if (!needle) return files.slice(0, max);
  const starts: string[] = [];
  const contains: string[] = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    if (lower.startsWith(needle) || base.startsWith(needle)) {
      starts.push(file);
    } else if (lower.includes(needle)) {
      contains.push(file);
    }
  }
  return [...starts, ...contains].slice(0, max);
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
  onUploadFile,
  supportsImageAttachment = false,
  attachmentNote = null,
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
  queueWhileBusy = false,
  onInterrupt,
  historyKey,
  workspaceFiles = [],
  initialVoiceRecording = false,
  initialVoiceLevel = 0,
  initialTranscribing = false,
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
  const sentHistoryRef = useRef<string[]>(
    historyKey ? getPromptHistory(historyKey) : [],
  );
  const historyIndexRef = useRef<number>(-1);
  const draftBeforeHistoryRef = useRef<string>('');

  useEffect(() => {
    if (historyKey) {
      sentHistoryRef.current = getPromptHistory(historyKey);
    }
    historyIndexRef.current = -1;
    draftBeforeHistoryRef.current = '';
  }, [historyKey]);
  // Not persisted to sessionStorage like `text` — an attached image surviving
  // a reload but pointing at nothing the user can see again would be worse
  // than just losing the draft, since there would be no way to tell it was
  // still going to be sent.
  const [attachedImage, setAttachedImage] = useState<PromptImage | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  // PA-136: files, uploaded as soon as they are attached so Send is not a
  // long wait. Not persisted either, for the same reason as the image.
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const pendingFilesRef = useRef<PendingFile[]>([]);
  pendingFilesRef.current = pendingFiles;
  const uploadControllers = useRef(new Map<string, AbortController>());
  const [dragActive, setDragActive] = useState(false);
  const supportsFiles = onUploadFile !== undefined;
  const canAttach = supportsImageAttachment || supportsFiles;
  const fileBlock = filesBlockSend(pendingFiles);
  const hasAttachment = attachedImage !== null || pendingFiles.length > 0;

  // An upload still running when the composer goes away has nobody to hand
  // its id to.
  useEffect(() => {
    const controllers = uploadControllers.current;
    return () => {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    };
  }, []);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [isVoiceRecording, setIsVoiceRecording] = useState(initialVoiceRecording);
  const [voiceLevel, setVoiceLevel] = useState(initialVoiceLevel);
  const [isOverDiscard, setIsOverDiscard] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(initialTranscribing);
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

  const mFrag = mentionFragment(text);
  const filteredMentions = useMemo(
    () => (mFrag === null || workspaceFiles.length === 0 ? [] : filterWorkspaceFiles(workspaceFiles, mFrag)),
    [workspaceFiles, mFrag],
  );
  const mentionOpen = !dismissed && !pickerOpen && filteredMentions.length > 0;
  const activePickerLen = pickerOpen ? filtered.length : mentionOpen ? filteredMentions.length : 0;

  // Re-clamp rather than reset to 0 on every keystroke — arrow-key selection
  // survives the list narrowing as long as the index is still in range.
  useEffect(() => {
    setSelected((prev) => Math.min(prev, Math.max(activePickerLen - 1, 0)));
  }, [activePickerLen]);

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

  /** What `onSend` is handed for the files: ready ids, or nothing. */
  function sendableIds(): string[] | undefined {
    const ids = readyAttachmentIds(pendingFiles);
    return ids.length > 0 ? ids : undefined;
  }

  function clearAttachments(): void {
    setAttachedImage(null);
    setPendingFiles([]);
    uploadControllers.current.clear();
  }

  function send(): void {
    const value = text;
    if ((value.length === 0 && !hasAttachment) || disabled || value.length > LIMITS.maxInputChars) return;
    if (fileBlock !== null) {
      setAttachError(
        fileBlock === 'uploading'
          ? 'Still uploading — it will be ready to send in a moment.'
          : 'A file failed to upload. Remove it, or attach it again, before sending.',
      );
      return;
    }
    void unlockAudioContext();
    if (onSend(value, attachedImage ?? undefined, sendableIds())) {
      if (value.trim()) {
        const trimmed = value.trim();
        if (historyKey) {
          sentHistoryRef.current = appendPromptHistory(historyKey, trimmed);
        } else {
          sentHistoryRef.current = [
            ...sentHistoryRef.current.filter((h) => h !== trimmed),
            trimmed,
          ];
        }
        historyIndexRef.current = -1;
        draftBeforeHistoryRef.current = '';
      }
      setText('');
      clearAttachments();
    }
  }

  /**
   * Shared by the attach button's picker, paste and drag-and-drop. Each file
   * goes inline (the first supported image, exactly as before PA-136) or is
   * uploaded as a file. One at a time, so "is there already an inline image"
   * is answered by the previous file rather than a stale render.
   */
  async function attachAll(files: readonly File[]): Promise<void> {
    setAttachError(null);
    let hasInlineImage = attachedImage !== null;
    for (const file of files) {
      const route = routeAttachment(file, { hasInlineImage, supportsFiles });
      if (route === null) {
        setAttachError('Only JPEG, PNG, GIF or WebP images can be attached here.');
        continue;
      }
      if (route === 'inline-image') {
        try {
          setAttachedImage(await readImageFile(file));
          hasInlineImage = true;
          continue;
        } catch (err) {
          // An image this browser cannot shrink or decode still has a home
          // when files are supported: it goes up as a file instead.
          if (!supportsFiles) {
            setAttachError(err instanceof Error ? err.message : 'Could not attach that image.');
            continue;
          }
        }
      }
      uploadFile(file);
    }
  }

  function uploadFile(file: File): void {
    if (!onUploadFile) return;
    const problem = fileAttachProblem(file, pendingFilesRef.current.length);
    if (problem) {
      setAttachError(problem);
      return;
    }
    const localId = `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const entry: PendingFile = {
      localId,
      name: file.name || 'file',
      size: file.size,
      mediaType: file.type || 'application/octet-stream',
      state: 'uploading',
    };
    pendingFilesRef.current = [...pendingFilesRef.current, entry];
    setPendingFiles(pendingFilesRef.current);
    const controller = new AbortController();
    uploadControllers.current.set(localId, controller);
    const update = (patch: Partial<PendingFile>): void =>
      setPendingFiles((prev) => prev.map((f) => (f.localId === localId ? { ...f, ...patch } : f)));
    onUploadFile(file, controller.signal).then(
      (res) => {
        if (controller.signal.aborted) return;
        uploadControllers.current.delete(localId);
        update({ state: 'ready', attachmentId: res.attachmentId, name: res.name });
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        uploadControllers.current.delete(localId);
        const message = err instanceof Error ? err.message : 'Upload failed.';
        update({ state: 'error', error: message });
        setAttachError(`Could not upload “${entry.name}”: ${message}`);
      },
    );
  }

  function removeFile(localId: string): void {
    uploadControllers.current.get(localId)?.abort();
    uploadControllers.current.delete(localId);
    setPendingFiles((prev) => prev.filter((f) => f.localId !== localId));
    setAttachError(null);
  }

  function attach(file: File): void {
    void attachAll([file]);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>): void {
    if (!canAttach || disabled || !Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (!dragActive) setDragActive(true);
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>): void {
    // Leaving for one of this element's own children is not leaving.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragActive(false);
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    if (!canAttach || disabled) return;
    const files = filesFromDataTransfer(event.dataTransfer);
    setDragActive(false);
    if (files.length === 0) return;
    event.preventDefault();
    void attachAll(files);
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
      if (fileBlock !== null) {
        // Never send past a file still uploading (or failed): park the
        // transcript in the box instead, where Send will pick it all up.
        setText(fullText);
        return;
      }
      if (onSend(fullText, attachedImage ?? undefined, sendableIds())) {
        if (fullText.trim()) {
          const finalTrimmed = fullText.trim();
          if (historyKey) {
            sentHistoryRef.current = appendPromptHistory(historyKey, finalTrimmed);
          } else {
            sentHistoryRef.current = [
              ...sentHistoryRef.current.filter((h) => h !== finalTrimmed),
              finalTrimmed,
            ];
          }
          historyIndexRef.current = -1;
          draftBeforeHistoryRef.current = '';
        }
        setText('');
        clearAttachments();
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
    if (supportsFiles) {
      // PA-136: any file on the clipboard (a copied PDF in Finder, say), not
      // just an image. A plain text paste carries none and is left alone.
      const files = filesFromDataTransfer(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      void attachAll(files);
      return;
    }
    const item = Array.from(event.clipboardData.items).find((i) => i.type.startsWith('image/'));
    if (!item) return; // an ordinary text paste — let the browser handle it
    const file = item.getAsFile();
    if (!file) return;
    // A pasted image is not also text, so nothing here competes with a normal
    // paste — but prevent it anyway in case the OS also puts a filename or a
    // data URL on the clipboard as a text fallback.
    event.preventDefault();
    attach(file);
  }

  function pick(command: SlashCommandInfo): void {
    if (command.name === 'add' && canAttach) {
      setText('');
      setDismissed(true);
      fileInputRef.current?.click();
      return;
    }
    setText(`/${command.name} `);
    setDismissed(false);
    ref.current?.focus();
  }

  function pickMention(filePath: string): void {
    setText((prev) => prev.replace(/(^|\s)@[^\s@]*$/, `$1@${filePath} `));
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
  const modelPickerVisible = modelPickerOpen && !pickerOpen && !mentionOpen && models.length > 0;

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
    } else if (mentionOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelected((i) => (i + 1) % filteredMentions.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelected((i) => (i - 1 + filteredMentions.length) % filteredMentions.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const chosen = filteredMentions[selected] ?? filteredMentions[0];
        if (chosen) pickMention(chosen);
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
        const inHistory = historyIndexRef.current !== -1;
        if ((isAtStart || inHistory) && sentHistoryRef.current.length > 0) {
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
            setTimeout(() => {
              if (ref.current) {
                const len = ref.current.value.length;
                ref.current.setSelectionRange(len, len);
              }
            }, 0);
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
              setTimeout(() => {
                if (ref.current) {
                  const len = ref.current.value.length;
                  ref.current.setSelectionRange(len, len);
                }
              }, 0);
            }
          } else {
            historyIndexRef.current = -1;
            setText(draftBeforeHistoryRef.current);
            setTimeout(() => {
              if (ref.current) {
                const len = ref.current.value.length;
                ref.current.setSelectionRange(len, len);
              }
            }, 0);
          }
          return;
        }
      }
      if (event.key === 'Escape' && historyIndexRef.current >= 0) {
        event.preventDefault();
        historyIndexRef.current = -1;
        setText(draftBeforeHistoryRef.current);
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
    <div
      className={`${isVoiceRecording ? 'promptbar recording' : isTranscribing ? 'promptbar transcribing' : 'promptbar'}${dragActive ? ' drag-active' : ''}`}
      onDragOver={canAttach ? onDragOver : undefined}
      onDragLeave={canAttach ? onDragLeave : undefined}
      onDrop={canAttach ? onDrop : undefined}
    >
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
          {models.map((model, idx) => {
            const isCurrent = model.value === currentModelInfo?.value;
            const showGroupHeader = Boolean(model.group && model.group !== models[idx - 1]?.group);
            return (
              <Fragment key={model.value}>
                {showGroupHeader && (
                  <div className="model-picker-divider" role="separator">
                    {model.group}
                  </div>
                )}
                <button
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
              </Fragment>
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
      {mentionOpen && (
        <div className="slash-picker mention-picker" role="listbox" aria-label="Workspace files">
          {filteredMentions.map((filePath, index) => (
            <button
              key={filePath}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              type="button"
              role="option"
              aria-selected={index === selected}
              className={index === selected ? 'active' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                pickMention(filePath);
              }}
            >
              <span className="cmd-name">@{filePath}</span>
            </button>
          ))}
        </div>
      )}
      {!pickerOpen && !mentionOpen && !isVoiceRecording && (hasAttachment || attachError || voiceError || liveListenError) && (
        // One stack above the bar, so file chips and an image preview (or an
        // error) sit one above the other instead of on top of each other.
        <div className="attach-stack">
          {pendingFiles.length > 0 && <PendingFileChips files={pendingFiles} onRemove={removeFile} />}
          {(attachedImage || attachError || voiceError || liveListenError) && (
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
                  {attachmentNote && <span className="attach-note">{attachmentNote}</span>}
                  {/* PA-136: an image no longer hides a file error behind it. */}
                  {attachError && <span className="attach-error">{attachError}</span>}
                </>
              ) : (
                <span className="attach-error">{attachError ?? voiceError ?? liveListenError}</span>
              )}
            </div>
          )}
        </div>
      )}
      {!isVoiceRecording && !isTranscribing && (
        <div className="promptbar-input-row">
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setDismissed(false);
              setModelPickerOpen(false);
              historyIndexRef.current = -1;
            }}
            onKeyDown={onKeyDown}
            onPaste={canAttach ? onPaste : undefined}
            placeholder="Type a prompt…"
            rows={1}
            aria-label="Prompt"
            enterKeyHint="enter"
          />
        </div>
      )}
      <div className="promptbar-tools-row">
        <div className="promptbar-tools-left">
          {/* PA-91 & PA-138: keep the attach trigger and mic control group
              mounted at the exact same React tree path while recording or
              transcribing so MicButton never unmounts (which would cancel the
              active PushToTalkRecorder, clear micButtonRef, and lose pointer
              capture) and never jumps under the user's held finger. */}
          {canAttach && (
            <AttachButton
              inputRef={fileInputRef}
              onFiles={(files) => void attachAll(files)}
              anyFile={supportsFiles}
              disabled={disabled || isVoiceRecording || isTranscribing}
            />
          )}
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
          {!isVoiceRecording && !isTranscribing && supportsLiveListen && onSetLiveListen && !liveListenActive && (
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
        </div>
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
          <div className="promptbar-tools-right">
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
            {busy && queueWhileBusy && (text.trim().length > 0 || hasAttachment) && (
              <button
                type="button"
                className="primary queue"
                onClick={send}
                disabled={disabled || text.length > LIMITS.maxInputChars || fileBlock !== null}
                aria-label="Send after the current step"
                title="Send after the current step — the agent reads it before its next move"
              >
                <Icon name="arrow-up" size={18} />
              </button>
            )}
            <button
              type="button"
              className={busy ? 'primary stop' : 'primary'}
              onClick={busy ? onInterrupt : send}
              disabled={
                busy
                  ? disabled
                  : disabled ||
                    (text.length === 0 && !hasAttachment) ||
                    text.length > LIMITS.maxInputChars ||
                    fileBlock !== null
              }
              aria-label={busy ? 'Stop generating' : 'Send prompt'}
            >
              <Icon name={busy ? 'stop' : 'arrow-up'} size={busy ? 16 : 18} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
