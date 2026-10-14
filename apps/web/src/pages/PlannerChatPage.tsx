import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentEvent,
  DocFileEntry,
  DocWorkspace,
  DocWorkspaceExtractionProgress,
  EffortLevel,
  ModelInfo,
  PlannerChat,
  PlannerContextPreviewResponse,
  PlannerLiveProvider,
  PlannerModel,
  PlannerToolApprovalChoice,
  PromptImage,
  QueuedPromptSummary,
  SessionInfo,
  SlashCommandInfo,
  PlannerArtifact,
} from '@pocketagent/protocol';
import { plannerModelSupportsImages } from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { Icon } from '../components/Icon.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Transcript } from '../components/Transcript.js';
import { PromptBox } from '../components/PromptBox.js';
import { WorkspacePanel } from '../components/WorkspacePanel.js';
import { PlannerDirectoryPicker } from '../components/PlannerDirectoryPicker.js';
import { plannerPromptHistoryKey } from '../agent/prompt-history.js';
import { applyEvent, applyEvents, emptyTranscript, type TranscriptState } from '../agent/transcript.js';
import { useHostApi } from '../hosts/HostContext.js';
import { LiveListenController } from '../audio/live-listen.js';
import { TtsPlaybackQueue } from '../audio/playback.js';
import { unlockAudioContext } from '../audio/audio-context.js';
import { vadOptionsForSensitivity, type VadOptions } from '../audio/vad.js';
import { isSkipCommand } from '../audio/voice-commands.js';
import { judgeUtterance } from '../audio/utterance-harness.js';
import { MIC_CHANGE_EVENT } from '../audio/devices.js';
import { GeminiLiveController, type GeminiLiveState } from '../audio/gemini-live.js';
import { getGeminiLivePref, setGeminiLivePref } from '../agent/voice-prefs.js';
import { AttachmentHrefContext } from '../components/FileChips.js';




const PLANNER_SLASH_COMMANDS: SlashCommandInfo[] = [
  {
    name: 'clear',
    description: 'Clear the conversation history',
    argumentHint: '',
    aliases: ['reset'],
  },
  {
    name: 'context',
    description: 'Preview context window and memory candidates',
    argumentHint: '',
    aliases: [],
  },
  {
    // PA-121: summarize the history now rather than when the context fills.
    name: 'compact',
    description: 'Summarize the conversation so far to free up context',
    argumentHint: '[what to focus on]',
    aliases: [],
  },
  {
    name: 'mcp',
    description: 'List available MCP servers and tools',
    argumentHint: '',
    aliases: [],
  },
  {
    name: 'add',
    description: 'Add photo or file from this device',
    argumentHint: '<file/photo>',
    aliases: ['attach', 'photo', 'file'],
  },
];

const PLANNER_STARTER_PROMPTS = [
  'What tasks can you help me with?',
  'Review git status and recent changes',
  'Search open Jira issues',
  'Check system health and status',
];

interface Props {
  chatId: string;
  active?: boolean;
  onBack: () => void;
  onOpenSession?: (sessionId: string) => void;
  onOpenPlannerChat?: (chatId: string) => void;
  onApiError: (error: unknown) => void;
}

/**
 * `PlannerModel` (this feature's own catalog row) as the `ModelInfo` shape
 * `PromptBox`'s model picker already knows how to render — the same picker a
 * structured session's composer uses, not a second implementation. The
 * planner has no notion of "effort" (that is a Claude Agent SDK concept —
 * see `EffortLevel`'s own doc comment) and no per-model description of its
 * own, so those fields are filled with the same "not applicable" values a
 * backend that has no such concept already uses elsewhere in this union —
 * `description: ''` is falsy, so `PromptBox` simply renders no second line
 * for it, same as any other backend with nothing to say there.
 */
/**
 * The PA-96 disclosure, shown from the ⓘ beside the Gemini Live toggle
 * (PA-131) rather than as a standing banner.
 */
const GEMINI_LIVE_DISCLOSURE =
  'Live mode in this chat uses Gemini Live. While it is on, your voice, this conversation and tool results (such as files it reads and session output) are sent to Google. Gemini bills audio for as long as the mic is open.';
const GEMINI_LIVE_UNAVAILABLE =
  'This agent is set to use Gemini Live for live mode, but no usable Gemini API key is configured on this server, so live mode is unavailable here. Add one in Providers and Models.';

function toModelInfos(models: PlannerModel[]): ModelInfo[] {
  return models.map((m) => ({
    value: m.modelId,
    displayName: m.label,
    description: '',
    supportsEffort: m.supportsEffort !== false,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'],
  }));
}

interface EventKeyInfo {
  key: string;
  ephemeral: boolean;
}

/**
 * PA-76: generates a deduplication key for agent events when both the POST
 * stream (active turn) and GET SSE stream (observer) deliver events for the
 * same chat. `text_delta` is excluded from deduplication since it is only sent
 * on the active HTTP stream, not via SSE.
 *
 * Events with permanent IDs use permanent deduplication; un-id'd events
 * (notices, rate limits, model/effort changes) use ephemeral deduplication
 * with a short time-window so identical events across different turns are
 * not swallowed (R3).
 */
function eventKey(event: AgentEvent): EventKeyInfo | null {
  if (event.kind === 'text_delta' || event.kind === 'tts_audio') return null;
  if ('id' in event && typeof event.id === 'string' && event.id) {
    return { key: `${event.kind}:${event.id}`, ephemeral: false };
  }
  if (event.kind === 'turn_complete') {
    return {
      key: `turn_complete:${event.completedAt ?? `${event.durationMs}_${event.inputTokens}_${event.outputTokens}`}`,
      ephemeral: false,
    };
  }
  if (event.kind === 'notice') {
    return { key: `notice:${event.level}:${event.text}`, ephemeral: true };
  }
  if (event.kind === 'rate_limit') {
    return { key: `rate_limit:${event.provider}:${event.resetsAt ?? ''}:${event.limitType ?? ''}`, ephemeral: true };
  }
  if (event.kind === 'session_started') {
    return { key: `session_started:${event.agentSessionId ?? ''}:${event.model ?? ''}`, ephemeral: true };
  }
  if (event.kind === 'model_changed') {
    return { key: `model_changed:${event.model}`, ephemeral: true };
  }
  if (event.kind === 'effort_changed') {
    return { key: `effort_changed:${event.effort}`, ephemeral: true };
  }
  if (event.kind === 'thinking') {
    return { key: `thinking:${event.id}`, ephemeral: false };
  }
  if (event.kind === 'commands_available') {
    return { key: `commands_available:${event.commands.map((c) => c.name).join(',')}`, ephemeral: true };
  }
  return null;
}

const INLINE_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.txt',
  '.text',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.pdf',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
]);

function isViewableInline(filename: string): boolean {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return false;
  return INLINE_EXTENSIONS.has(filename.slice(dot).toLowerCase());
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatArtifactDate(timestamp: number | string): string {
  try {
    const d = new Date(timestamp);
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(timestamp);
  }
}

/**
 * PA-6: one Pocket Agent chat, rendered as an exact mirror of a structured
 * session's own chat UI — literally the same `Transcript`/`PromptBox`
 * components, fed the same `AgentEvent` union through the same `applyEvent`
 * reducer, because the turn is now streamed rather than request/response.
 *
 * `api.sendPlannerMessage`/`resolvePlannerApproval` read a
 * `text/event-stream` response and call `onStreamEvent` for each event as it
 * arrives — a tool call's bar appears the moment the model decides to make
 * it, fills in with its result once that finishes, and the final reply
 * arrives token-by-token as `text_delta` events (parsed live from the
 * upstream provider's own SSE stream — see `llm-client.ts`'s doc comment)
 * before a final `text` event closes it out. The same `applyEvent` reducer a
 * structured session already uses handles both, so this needed no reducer
 * changes of its own. Only the completed `text` event is persisted
 * server-side — `text_delta` is transport, not history — so reopening this
 * chat replays the finished reply as one block rather than re-streaming it;
 * a tool call from three turns ago still renders as a real, expandable
 * `ToolCard`.
 *
 * The approval card below is this page's own, deliberately plain stand-in
 * for `ApprovalSheet` — driven by the exact same `TranscriptState.pending`
 * the real sheet reads, just with its own four choices (once / remember for
 * this workspace / remember globally / deny) instead of `ApprovalSheet`'s
 * two, since `PermissionDecision` has no workspace/global concept of its
 * own. A full drag/minimize `ApprovalSheet` mirror is future scope.
 */
export function PlannerChatPage({
  chatId,
  active = true,
  onBack,
  onOpenSession,
  onOpenPlannerChat,
  onApiError,
}: Props): JSX.Element {
  const api = useHostApi();
  const [chat, setChat] = useState<PlannerChat | null>(null);
  const [models, setModels] = useState<PlannerModel[]>([]);
  // PA-122: messages sent while the chat was busy, not yet delivered.
  const [queued, setQueued] = useState<QueuedPromptSummary[]>([]);
  const [transcript, setTranscript] = useState<TranscriptState | null>(null);
  const [subagents, setSubagents] = useState<SessionInfo[]>([]);
  const [plannerSubagents, setPlannerSubagents] = useState<PlannerChat[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // PA-128: Workspace artifacts side panel state
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [artifacts, setArtifacts] = useState<PlannerArtifact[]>([]);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [artifactsError, setArtifactsError] = useState<string | null>(null);
  const [pendingDeleteArtifact, setPendingDeleteArtifact] = useState<PlannerArtifact | null>(null);
  const [confirmCleanAll, setConfirmCleanAll] = useState(false);
  const [deletingArtifact, setDeletingArtifact] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [geminiLiveActive, setGeminiLiveActive] = useState(false);
  const [pipelineLiveActive, setPipelineLiveActive] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [liveListenError, setLiveListenError] = useState<string | null>(null);
  const [liveListenNotice, setLiveListenNotice] = useState<string | null>(null);
  const [reviewText, setReviewText] = useState<{ items: { text: string; seq: number }[] } | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  // PA-96: this chat's agent's live-stream provider, and whether Gemini Live
  // is usable on this server (a key is stored and decrypts).
  const [liveProvider, setLiveProvider] = useState<PlannerLiveProvider>('pipeline');
  const [geminiAvailable, setGeminiAvailable] = useState(false);
  const [geminiState, setGeminiState] = useState<GeminiLiveState>('stopped');
  const [geminiHeard, setGeminiHeard] = useState('');
  const [geminiSaid, setGeminiSaid] = useState('');
  const geminiRef = useRef<GeminiLiveController | null>(null);

  const reviewSeqRef = useRef(0);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showLiveListenNotice = useCallback((notice: string) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setLiveListenNotice(notice);
    noticeTimerRef.current = setTimeout(() => {
      setLiveListenNotice(null);
      noticeTimerRef.current = null;
    }, 4000);
  }, []);

  const vadOptionsRef = useRef<VadOptions | undefined>(undefined);
  const ttsQueueRef = useRef<TtsPlaybackQueue | null>(null);
  const sendAbortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      sendAbortControllerRef.current?.abort();
      sendAbortControllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const queue = new TtsPlaybackQueue((playing) => setIsSpeaking(playing));
    ttsQueueRef.current = queue;
    return () => {
      queue.stop();
      ttsQueueRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((res) => {
        if (cancelled) return;
        setVoiceEnabled(res.settings.liveSttUrl !== '');
        vadOptionsRef.current = vadOptionsForSensitivity(
          res.settings.voiceTurnSensitivity,
          res.settings.voiceTurnSilenceMs,
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api]);
  // PA-96: which live-stream implementation this chat's agent uses. Re-read
  // whenever the chat (and so possibly its agent) changes; a failure leaves
  // the default pipeline, which is what every agent had before this existed.
  const chatWorkspaceId = chat?.workspaceId ?? null;
  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.listPlannerWorkspaces(), api.getGeminiLiveSettings()])
      .then(([{ workspaces }, gemini]) => {
        if (cancelled) return;
        const agent = workspaces.find((w) => w.id === chatWorkspaceId);
        setLiveProvider(agent?.liveProvider ?? 'pipeline');
        setGeminiAvailable(gemini.available);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, chatWorkspaceId]);
  const geminiSelected = liveProvider === 'gemini-live';
  const [geminiInfoOpen, setGeminiInfoOpen] = useState(false);
  const geminiInfoRef = useRef<HTMLSpanElement | null>(null);
  // A tap anywhere outside the ⓘ closes its popover, the way a tooltip does.
  useEffect(() => {
    if (!geminiInfoOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!geminiInfoRef.current?.contains(e.target as Node)) setGeminiInfoOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [geminiInfoOpen]);
  /** Live mode on this page means Gemini Live, not the live-stt pipeline. */
  const geminiMode = geminiSelected && geminiAvailable;
  const geminiLive = geminiMode && geminiLiveActive;
  const isGeminiConfigured = geminiAvailable && geminiSelected;

  // PA-98: Restore saved Gemini Live preference if configured for this chat
  const restoredPrefRef = useRef(false);
  useEffect(() => {
    if (restoredPrefRef.current) return;
    if (geminiAvailable !== false && liveProvider !== null) {
      restoredPrefRef.current = true;
      if (geminiSelected && geminiAvailable && getGeminiLivePref(chatId)) {
        setGeminiLiveActive(true);
      }
    }
  }, [geminiAvailable, liveProvider, geminiSelected, chatId]);

  const seenPermanentKeys = useRef<Set<string>>(new Set());
  const seenEphemeralKeys = useRef<Map<string, number>>(new Map());
  const liveEventsBuffer = useRef<AgentEvent[]>([]);
  const loadingRef = useRef(false);
  const EPHEMERAL_DEDUPE_WINDOW_MS = 5000;

  const isEventSeen = useCallback((info: EventKeyInfo): boolean => {
    if (!info.ephemeral) {
      return seenPermanentKeys.current.has(info.key);
    }
    const lastSeen = seenEphemeralKeys.current.get(info.key);
    if (lastSeen === undefined) return false;
    return Date.now() - lastSeen < EPHEMERAL_DEDUPE_WINDOW_MS;
  }, []);

  const markEventSeen = useCallback((info: EventKeyInfo): void => {
    if (!info.ephemeral) {
      seenPermanentKeys.current.add(info.key);
    } else {
      seenEphemeralKeys.current.set(info.key, Date.now());
    }
  }, []);
  const [isDocumentVisible, setIsDocumentVisible] = useState(() =>
    typeof document !== 'undefined' ? document.visibilityState !== 'hidden' : true,
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibilityChange = () => {
      setIsDocumentVisible(document.visibilityState !== 'hidden');
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  const shouldStream = active && isDocumentVisible;
  // PA-36: this page had no "gone" detection at all before — a deleted chat
  // silently rendered as `chat === null` / "Untitled chat" with an empty
  // transcript, same failure shape `ChatPreviewPage`'s own `missing` state
  // exists to catch for a coding-agent conversation. `plannerChatHistory`
  // 404s once the chat's DB row is gone (`PlannerChatService.history` calls
  // `requireChat`), which is the reliable signal — `listPlannerChats()`
  // returns every chat with no pagination, so a chat missing from it is
  // never just "aged out of a poll window" the way a project conversation
  // can be.
  const [missing, setMissing] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState('');
  const [contextPreview, setContextPreview] = useState<PlannerContextPreviewResponse | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  // PA-59: which system-prompt sections are expanded past their one-line
  // collapsed view — a plain `Set` keyed by section id, mirroring `ToolCard`'s
  // own per-item `open` convention but for several independent rows in one
  // panel rather than one row's own single toggle.
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => new Set());
  const toggleSection = useCallback((id: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const refreshSubagents = useCallback(async () => {
    try {
      const { subagents: list, plannerChats: pList } = await api.listPlannerChatSubagents(chatId);
      setSubagents(list);
      setPlannerSubagents(pList ?? []);
    } catch {
      // ignore
    }
  }, [chatId]);

  const [docWorkspaces, setDocWorkspaces] = useState<DocWorkspace[]>([]);
  const [docWorkspaceEntries, setDocWorkspaceEntries] = useState<DocFileEntry[]>([]);
  const [docWorkspaceProgress, setDocWorkspaceProgress] = useState<DocWorkspaceExtractionProgress>({
    total: 0,
    completed: 0,
    extracting: 0,
    failed: 0,
    scanned: 0,
  });
  const [docWorkspaceLoading, setDocWorkspaceLoading] = useState(false);
  const [docWorkspaceError, setDocWorkspaceError] = useState<string | null>(null);
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);

  const attachedDocWorkspaceId = chat?.docWorkspaceId ?? null;
  const attachedDocWorkspace = useMemo(
    () =>
      attachedDocWorkspaceId
        ? docWorkspaces.find((w) => w.id === attachedDocWorkspaceId) ?? null
        : null,
    [docWorkspaces, attachedDocWorkspaceId],
  );

  const refreshDocWorkspaces = useCallback(async () => {
    try {
      const res = await api.listDocWorkspaces();
      setDocWorkspaces(res.workspaces);
    } catch {
      // ignore
    }
  }, [api]);

  const refreshDocWorkspaceFiles = useCallback(async () => {
    if (!attachedDocWorkspaceId) {
      setDocWorkspaceEntries([]);
      setDocWorkspaceProgress({ total: 0, completed: 0, extracting: 0, failed: 0, scanned: 0 });
      return;
    }
    setDocWorkspaceLoading(true);
    setDocWorkspaceError(null);
    try {
      const res = await api.listDocWorkspaceFiles(attachedDocWorkspaceId);
      setDocWorkspaceEntries(res.entries);
      setDocWorkspaceProgress(res.progress);
      setDocWorkspaces((prev) => {
        const exists = prev.some((w) => w.id === res.workspace.id);
        return exists ? prev.map((w) => (w.id === res.workspace.id ? res.workspace : w)) : [...prev, res.workspace];
      });
    } catch (err) {
      setDocWorkspaceError(err instanceof Error ? err.message : String(err));
    } finally {
      setDocWorkspaceLoading(false);
    }
  }, [api, attachedDocWorkspaceId]);

  useEffect(() => {
    void refreshDocWorkspaces();
  }, [refreshDocWorkspaces]);

  useEffect(() => {
    void refreshDocWorkspaceFiles();
  }, [refreshDocWorkspaceFiles]);

  // Poll while background document extraction is active
  useEffect(() => {
    if (!attachedDocWorkspaceId || docWorkspaceProgress.extracting === 0) return;
    const timer = setInterval(() => {
      void refreshDocWorkspaceFiles();
    }, 2500);
    return () => clearInterval(timer);
  }, [attachedDocWorkspaceId, docWorkspaceProgress.extracting, refreshDocWorkspaceFiles]);

  useEffect(() => {
    if (!workspaceMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!workspaceMenuRef.current?.contains(e.target as Node)) setWorkspaceMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [workspaceMenuOpen]);

  const handleAttachWorkspace = useCallback(
    async (nextWorkspaceId: string | null) => {
      setWorkspaceMenuOpen(false);
      try {
        const updated = await api.updatePlannerChat(chatId, { docWorkspaceId: nextWorkspaceId });
        setChat(updated);
        if (nextWorkspaceId) {
          setArtifactsOpen(false);
          setWorkspacePanelOpen(true);
        } else {
          setWorkspacePanelOpen(false);
        }
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not update chat workspace.');
      }
    },
    [api, chatId, onApiError],
  );

  const handleCreateAndAttachWorkspace = useCallback(
    async (pickedPath: string, opts?: { create?: boolean }) => {
      setWorkspacePickerOpen(false);
      try {
        const created = await api.createDocWorkspace({
          path: pickedPath,
          ...(opts?.create ? { createPath: true } : {}),
        });
        setDocWorkspaces((prev) => [...prev, created]);
        const updated = await api.updatePlannerChat(chatId, { docWorkspaceId: created.id });
        setChat(updated);
        setArtifactsOpen(false);
        setWorkspacePanelOpen(true);
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not create document workspace.');
      }
    },
    [api, chatId, onApiError],
  );

  const handleUseInChat = useCallback((relPath: string) => {
    const seq = ++reviewSeqRef.current;
    setReviewText((prev) => ({
      items: [...(prev?.items ?? []), { text: `@${relPath}`, seq }],
    }));
  }, []);

  const workspaceFilePaths = useMemo(
    () => docWorkspaceEntries.filter((e) => !e.isDir).map((e) => e.path),
    [docWorkspaceEntries],
  );

  const refreshArtifacts = useCallback(async () => {
    setArtifactsLoading(true);
    setArtifactsError(null);
    try {
      const res = await api.listPlannerChatArtifacts(chatId);
      setArtifacts(res.artifacts);
    } catch (err) {
      setArtifactsError(err instanceof Error ? err.message : String(err));
    } finally {
      setArtifactsLoading(false);
    }
  }, [api, chatId]);

  useEffect(() => {
    if (artifactsOpen) {
      void refreshArtifacts();
    }
  }, [artifactsOpen, refreshArtifacts]);

  // Pre-fetch artifacts count for badge even when panel is closed
  useEffect(() => {
    let cancelled = false;
    void api
      .listPlannerChatArtifacts(chatId)
      .then((res) => {
        if (!cancelled) setArtifacts(res.artifacts);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, chatId]);

  const toggleArtifacts = useCallback(() => {
    setArtifactsOpen((prev) => {
      if (!prev) setWorkspacePanelOpen(false);
      return !prev;
    });
  }, []);

  const toggleWorkspacePanel = useCallback(() => {
    setWorkspacePanelOpen((prev) => {
      if (!prev) setArtifactsOpen(false);
      return !prev;
    });
  }, []);

  const handleOpenArtifact = useCallback(
    (artifact: PlannerArtifact) => {
      const inline = isViewableInline(artifact.name);
      const url = api.plannerChatArtifactFileUrl(chatId, artifact.name, !inline);
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    [api, chatId],
  );

  const handleDownloadArtifact = useCallback(
    (artifact: PlannerArtifact) => {
      const url = api.plannerChatArtifactFileUrl(chatId, artifact.name, true);
      const a = document.createElement('a');
      a.href = url;
      a.download = artifact.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    },
    [api, chatId],
  );

  const handleDeleteArtifact = useCallback(async () => {
    if (!pendingDeleteArtifact) return;
    setDeletingArtifact(true);
    try {
      await api.deletePlannerChatArtifact(chatId, pendingDeleteArtifact.name);
      setPendingDeleteArtifact(null);
      await refreshArtifacts();
    } catch (err) {
      setArtifactsError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingArtifact(false);
    }
  }, [api, chatId, pendingDeleteArtifact, refreshArtifacts]);

  const handleCleanAllArtifacts = useCallback(async () => {
    setDeletingArtifact(true);
    try {
      await api.deleteAllPlannerChatArtifacts(chatId);
      setConfirmCleanAll(false);
      await refreshArtifacts();
    } catch (err) {
      setArtifactsError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingArtifact(false);
    }
  }, [api, chatId, refreshArtifacts]);

  const removeCodingSubagent = async (subagent: SessionInfo, e: React.MouseEvent): Promise<void> => {
    e.preventDefault();
    e.stopPropagation();
    try {
      setSubagents((prev) => prev.filter((s) => s.id !== subagent.id));
      await api.removeChat({ sessionId: subagent.id, conversationId: subagent.agentSessionId ?? undefined });
      if (subagent.status === 'running' || subagent.status === 'starting') {
        await api.deleteSession(subagent.id).catch(() => {});
      }
    } catch (err) {
      onApiError(err);
    } finally {
      void refreshSubagents();
    }
  };

  const removePlannerSubagent = async (subChatId: string, e: React.MouseEvent): Promise<void> => {
    e.preventDefault();
    e.stopPropagation();
    try {
      setPlannerSubagents((prev) => prev.filter((c) => c.id !== subChatId));
      await api.deletePlannerChat(subChatId);
    } catch (err) {
      onApiError(err);
    } finally {
      void refreshSubagents();
    }
  };

  const load = useCallback(async () => {
    loadingRef.current = true;
    liveEventsBuffer.current = [];
    try {
      const [{ chats }, { models: modelList }, { events }, subagentData] = await Promise.all([
        api.listPlannerChats(),
        api.listPlannerModels(),
        api.plannerChatHistory(chatId),
        api.listPlannerChatSubagents(chatId).catch(() => ({ subagents: [], plannerChats: [] })),
      ]);
      let found = chats.find((c) => c.id === chatId) ?? null;
      if (!found) {
        try {
          found = await api.getPlannerChat(chatId);
        } catch {
          // not found
        }
      }
      setChat(found);
      setMissing(found === null);
      setModels(modelList);
      setQueued(found?.queuedPrompts ?? []);
      seenPermanentKeys.current.clear();
      seenEphemeralKeys.current.clear();
      for (const ev of events) {
        const k = eventKey(ev);
        if (k) markEventSeen(k);
      }
      let baseTranscript = applyEvents(emptyTranscript(), events);
      // PA-76: Replay any live events that arrived via SSE while the history fetch was in flight
      const inFlight = liveEventsBuffer.current;
      liveEventsBuffer.current = [];
      for (const ev of inFlight) {
        const k = eventKey(ev);
        if (k) {
          if (isEventSeen(k)) continue;
          markEventSeen(k);
        }
        baseTranscript = applyEvent(baseTranscript, ev);
      }
      setTranscript(baseTranscript);
      setSubagents(subagentData.subagents ?? []);
      setPlannerSubagents(subagentData.plannerChats ?? []);
      setError(null);
    } catch (err) {
      onApiError(err);
      if (err instanceof ApiError && err.status === 404) {
        setMissing(true);
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not load this chat.');
      }
    } finally {
      loadingRef.current = false;
      liveEventsBuffer.current = [];
    }
  }, [chatId, onApiError, isEventSeen, markEventSeen]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!shouldStream) return;
    const timer = setInterval(() => void refreshSubagents(), 5000);
    return () => clearInterval(timer);
  }, [shouldStream, refreshSubagents]);

  // PA-36: closes this tab (desktop) or navigates back to the Pocket Agent
  // list (phone) as soon as the chat is confirmed gone — same auto-close
  // `SessionRoute`/`ChatPreviewPage` fire for a deleted session/conversation.
  // No manual click required, which is the fix for a tab restored from
  // `open-tabs-pref` after the owning chat was deleted.
  useEffect(() => {
    if (missing) onBack();
  }, [missing, onBack]);

  const changeModel = (modelId: string): void => {
    if (!modelId) return;
    void (async () => {
      try {
        const updated = await api.updatePlannerChat(chatId, { modelId });
        setChat(updated);
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not change the model.');
      }
    })();
  };

  const changeEffort = (effort: EffortLevel | null): void => {
    void (async () => {
      try {
        const updated = await api.updatePlannerChat(chatId, {
          effort,
          ...(effort !== null && effort !== 'off' ? { thinking: true } : {}),
        });
        setChat(updated);
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not change effort.');
      }
    })();
  };

  const toggleThinking = (): void => {
    const nextThinking = chat?.thinkingEnabled === false ? true : false;
    void (async () => {
      try {
        const updated = await api.updatePlannerChat(chatId, { thinking: nextThinking });
        setChat(updated);
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not toggle thinking.');
      }
    })();
  };

  const startEditingTitle = (): void => {
    setTitleInput(chat?.title ?? '');
    setEditingTitle(true);
  };

  /** Empty input clears the title back to "Untitled chat" rather than being
      rejected — the same "empty string means unset" convention this app's
      other nullable-text settings use, and it's a deliberate way back out of
      a bad auto-generated title if the user doesn't want to type a new one. */
  const saveTitle = (): void => {
    setEditingTitle(false);
    const trimmed = titleInput.trim();
    if (trimmed === (chat?.title ?? '')) return;
    void (async () => {
      try {
        const updated = await api.updatePlannerChat(chatId, { title: trimmed || null });
        setChat(updated);
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not rename this chat.');
      }
    })();
  };

  /** Folds one streamed event into the live transcript — same reducer a
      structured session's WebSocket events go through. */
  const onStreamEvent = useCallback(
    (event: AgentEvent): void => {
      if (event.kind === 'tts_audio') {
        ttsQueueRef.current?.enqueue(event.chunk.data, event.chunk.sampleRateHz);
        return;
      }
      // PA-122: a snapshot of the queue, not part of the transcript.
      if (event.kind === 'prompt_queue') {
        setQueued(event.prompts);
        return;
      }
      // PA-96: a call Gemini made was parked on approval and a human just
      // decided it. The resolution stream and the observer stream both carry
      // this event; the controller relays it once and ignores the repeat.
      if (event.kind === 'tool_result') {
        geminiRef.current?.relayApprovalOutcome(event.toolUseId, event.content, event.isError);
      }
      if (loadingRef.current) {
        liveEventsBuffer.current.push(event);
      }
      const key = eventKey(event);
      if (key) {
        if (isEventSeen(key)) return;
        markEventSeen(key);
      }
      setTranscript((prev) => applyEvent(prev ?? emptyTranscript(), event));
      if (event.kind === 'user_prompt') {
        setChat((prev) => (prev ? { ...prev, busy: true } : null));
      } else if (event.kind === 'turn_complete') {
        setSending(false);
        setChat((prev) => (prev ? { ...prev, busy: false } : null));
        void refreshSubagents();
        void refreshArtifacts();
        void refreshDocWorkspaceFiles();
        void (async () => {
          try {
            const { chats } = await api.listPlannerChats();
            const found = chats.find((c) => c.id === chatId);
            if (found) setChat(found);
          } catch {
            // ignore
          }
        })();
      }
    },
    [chatId, refreshSubagents, refreshArtifacts, refreshDocWorkspaceFiles, isEventSeen, markEventSeen],
  );

  useEffect(() => {
    if (!shouldStream) return;
    const unsubscribe = api.subscribePlannerChatEvents(chatId, onStreamEvent);
    return () => {
      unsubscribe();
    };
  }, [chatId, shouldStream, onStreamEvent]);

  // PA-76: Refetch chat and transcript when tab becomes active/visible again.
  const wasStreaming = useRef(shouldStream);
  useEffect(() => {
    if (shouldStream && !wasStreaming.current) {
      void load();
    }
    wasStreaming.current = shouldStream;
  }, [shouldStream, load]);

  const pending = transcript?.pending[0] ?? null;

  /** PA-136: files are uploaded as soon as they are attached. */
  const uploadFile = useCallback(
    (file: File, signal: AbortSignal) => api.uploadAttachment(file, signal),
    [api],
  );
  /** An upload lands under the workspace's `artifacts/`, or in the attached
      document workspace's inbox directory. */
  const attachmentHref = useCallback(
    (relPath: string): string | null => {
      if (relPath.startsWith('artifacts/')) {
        return api.plannerChatArtifactFileUrl(chatId, relPath.slice('artifacts/'.length), true);
      }
      if (attachedDocWorkspaceId) {
        return api.docWorkspaceFileDownloadUrl(attachedDocWorkspaceId, relPath, false);
      }
      return null;
    },
    [api, chatId, attachedDocWorkspaceId],
  );

  // PA-122: warn before sending an image to a model that cannot read it.
  const selectedModel = models.find((m) => m.modelId === chat?.lastModelId) ?? null;
  const imageNote =
    selectedModel && !plannerModelSupportsImages(selectedModel.modelId, selectedModel.supportsImages)
      ? `${selectedModel.label} cannot read images — it will see a note instead. Pick a vision model to have it look.`
      : null;
  const isChatBusy = sending || (chat?.busy ?? false) || (transcript?.busy ?? false);
  // PA-99: PromptBox manages its own busy state (swapping send into stop).
  // PA-122: no longer disabled while an approval is pending — a message typed
  // then is queued behind the approval, which still waits for its own answer.
  const disabled = false;

  /** PA-122: a message for a busy chat goes into its queue, and is read by
      the agent after its current step (or as the next turn). */
  const queueMessage = (content: string, image?: PromptImage, attachments?: string[]): boolean => {
    setError(null);
    void (async () => {
      try {
        const res = await api.queuePlannerPrompt(chatId, {
          content,
          image,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
          voiceMode: pipelineLiveActive,
        });
        setQueued(res.queuedPrompts);
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not queue your message. It was not sent.');
      }
    })();
    return true;
  };

  const cancelQueued = (promptId: string): void => {
    setQueued((prev) => prev.filter((q) => q.id !== promptId));
    void (async () => {
      try {
        await api.cancelQueuedPlannerPrompt(chatId, promptId);
      } catch (err) {
        onApiError(err);
        // Most likely delivered a moment ago; the next snapshot is the truth.
        if (!(err instanceof ApiError && err.status === 404)) {
          setError(err instanceof ApiError ? err.message : 'Could not cancel that message.');
        }
      }
    })();
  };

  /** `PromptBox.onSend` is synchronous by contract (see its own props doc):
      a `true` return clears the composer immediately, matching how a real
      session's prompt clears on submit rather than waiting for a reply. */
  const handleSend = (content: string, image?: PromptImage, attachments?: string[]): boolean => {
    const trimmed = content.trim();
    const files = attachments ?? [];
    // A message carrying anything is a message, never a slash command.
    const hasMedia = !!image || files.length > 0;
    // PA-96: one model drives the chat at a time — while Gemini Live is on, a
    // typed message is Gemini's to answer, and the server records it in the
    // transcript as if it had been heard.
    if (geminiLive) {
      if (pending !== null || !trimmed) return false;
      if (image) {
        setError('Images cannot be sent while Gemini Live is on. Turn live mode off to attach one.');
        return false;
      }
      if (files.length > 0) {
        setError('Files cannot be sent while Gemini Live is on. Turn live mode off to attach one.');
        return false;
      }
      if (!trimmed.startsWith('/')) {
        if (!geminiRef.current?.sendText(trimmed)) {
          setError('Gemini Live is still connecting. Try again in a moment.');
          return false;
        }
        return true;
      }
    }
    if (!trimmed && !hasMedia) return false;
    if (isChatBusy || pending !== null) {
      // Slash commands act on the chat now; they are not messages to queue.
      if (!hasMedia && trimmed.startsWith('/')) return false;
      return queueMessage(trimmed, image, files);
    }

    // Handle slash commands without sending to LLM:
    if (!hasMedia && (trimmed === '/clear' || trimmed === '/reset')) {
      void (async () => {
        try {
          await api.clearPlannerChatHistory(chatId);
          seenPermanentKeys.current.clear();
          seenEphemeralKeys.current.clear();
          setTranscript({
            ...emptyTranscript(),
            items: [
              {
                type: 'notice',
                key: `reset_${Date.now()}`,
                level: 'info',
                text: 'Conversation cleared.',
              },
            ],
          });
          setPreviewOpen(false);
          setContextPreview(null);
        } catch (err) {
          onApiError(err);
          setError(err instanceof ApiError ? err.message : 'Could not clear conversation history.');
        }
      })();
      return true;
    }

    if (!hasMedia && trimmed === '/context') {
      togglePreview();
      return true;
    }

    // PA-121: `/compact [focus]`. One LLM call; the divider it produces comes
    // back with the reloaded history.
    if (!hasMedia && (trimmed === '/compact' || trimmed.startsWith('/compact '))) {
      const focus = trimmed.slice('/compact'.length).trim();
      const note = (text: string, level: 'info' | 'warn'): void =>
        setTranscript((prev) => ({
          ...(prev ?? emptyTranscript()),
          items: [...(prev ?? emptyTranscript()).items, { type: 'notice', key: `compact_${Date.now()}`, level, text }],
        }));
      note('Summarizing the conversation…', 'info');
      void (async () => {
        try {
          const result = await api.compactPlannerChat(chatId, focus || null);
          await load();
          if (!result.compacted) note(result.message, 'warn');
          setContextPreview(null);
        } catch (err) {
          onApiError(err);
          setError(err instanceof ApiError ? err.message : 'Could not compact the conversation.');
        }
      })();
      return true;
    }

    if (!hasMedia && trimmed === '/mcp') {
      void (async () => {
        try {
          const regList = await api.listMcpRegistries();
          let text = '';
          if (regList.registries.length === 0) {
            text = 'No MCP registries are currently configured. Add one in Settings → MCP Registries.';
          } else {
            text =
              'Available MCP Registries:\n\n' +
              regList.registries
                .map((r) => {
                  const status = r.lastError
                    ? `[Error: ${r.lastError}]`
                    : r.enabled
                      ? '[Enabled]'
                      : '[Disabled]';
                  return `• ${r.name} (${r.url}) ${status} — ${r.toolCount} tool${r.toolCount === 1 ? '' : 's'}`;
                })
                .join('\n');
          }
          setTranscript((prev) =>
            applyEvent(prev ?? emptyTranscript(), {
              kind: 'command_output',
              id: crypto.randomUUID(),
              text,
            }),
          );
        } catch (err) {
          onApiError(err);
          setError(err instanceof ApiError ? err.message : 'Could not load MCP registries.');
        }
      })();
      return true;
    }

    setSending(true);
    setError(null);
    // The server auto-titles an untitled chat from its first prompt (see
    // `PlannerChatService.sendMessage`'s doc comment) — the turn's own
    // streamed events don't carry the chat row itself, so this is the one
    // spot that needs to notice "this was the first message" and re-fetch
    // afterward for the new title to show up without a manual reload.
    const wasUntitled = chat?.title == null;
    const controller = new AbortController();
    sendAbortControllerRef.current = controller;
    void (async () => {
      try {
        ttsQueueRef.current?.arm();
        await api.sendPlannerMessage(
          chatId,
          {
            content: trimmed,
            image,
            ...(files.length > 0 ? { attachments: files } : {}),
            voiceMode: pipelineLiveActive,
            effort: chat?.lastEffort ?? undefined,
            thinking: chat?.thinkingEnabled !== false,
          },
          onStreamEvent,
          controller.signal,
        );
        if (wasUntitled) {
          try {
            const updated = await api.getPlannerChat(chatId);
            setChat(updated);
          } catch {
            const { chats } = await api.listPlannerChats();
            setChat((prev) => chats.find((c) => c.id === chatId) ?? prev);
          }
        }
      } catch (err) {
        if (controller.signal.aborted || (err as Error)?.name === 'AbortError') return;
        // PA-122: a turn began on the server first (a subagent waking the
        // chat, say) — queue the message behind it instead of losing it.
        if (err instanceof ApiError && err.code === 'busy') {
          queueMessage(trimmed, image, files);
          return;
        }
        onApiError(err);
        setError(
          err instanceof ApiError
            ? err.message
            : 'Could not reach Pocket Agent. Your message was not sent.',
        );
      } finally {
        if (sendAbortControllerRef.current === controller) {
          sendAbortControllerRef.current = null;
        }
        setSending(false);
        void refreshSubagents();
        void refreshArtifacts();
      }
    })();
    return true;
  };

  const handleSendRef = useRef(handleSend);
  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);

  const handleToggleGeminiLive = useCallback(
    (enabled: boolean) => {
      if (!enabled) {
        ttsQueueRef.current?.stop();
        geminiRef.current?.stopSpeaking();
      } else {
        // Inside the click, so iOS lets the playback context start.
        void unlockAudioContext();
        if (geminiMode) GeminiLiveController.prime();
        // PA-98: Turn off self-made pipeline if user switches to Gemini Live
        setPipelineLiveActive(false);
      }
      setGeminiLiveActive(enabled);
      if (geminiSelected && geminiAvailable) {
        setGeminiLivePref(enabled, chatId);
      }
    },
    [geminiMode, geminiSelected, geminiAvailable, chatId],
  );

  const handleTogglePipelineLive = useCallback(
    (enabled: boolean) => {
      if (!enabled) {
        ttsQueueRef.current?.stop();
      } else {
        // Inside the click, so iOS lets the playback context start.
        void unlockAudioContext();
        // PA-98: Turn off Gemini Live if user switches to self-made pipeline
        setGeminiLiveActive(false);
        if (geminiSelected && geminiAvailable) {
          setGeminiLivePref(false, chatId);
        }
      }
      setPipelineLiveActive(enabled);
    },
    [geminiSelected, geminiAvailable, chatId],
  );

  const handleStopSpeaking = useCallback(() => {
    ttsQueueRef.current?.stop();
    geminiRef.current?.stopSpeaking();
  }, []);

  const handleInterrupt = useCallback(() => {
    sendAbortControllerRef.current?.abort();
    sendAbortControllerRef.current = null;
    ttsQueueRef.current?.stop();
    void api.interruptPlannerChat(chatId).catch((err) => {
      onApiError(err);
    });
    setSending(false);
  }, [api, chatId, onApiError]);

  const [micVersion, setMicVersion] = useState(0);
  useEffect(() => {
    const onMicChange = (): void => setMicVersion((v) => v + 1);
    if (typeof window !== 'undefined') {
      window.addEventListener(MIC_CHANGE_EVENT, onMicChange);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener(MIC_CHANGE_EVENT, onMicChange);
      }
    };
  }, []);

  // PA-96: Gemini Live replaces the whole pipeline below for an agent set to
  // it — no VAD, no utterance harness, no live-stt, no `<speak>` talk-back.
  useEffect(() => {
    if (!geminiLive || !shouldStream) return;
    let cancelled = false;
    const controller = new GeminiLiveController({
      chatId,
      api,
      onState: (state) => {
        if (!cancelled) setGeminiState(state);
      },
      onHeard: (text) => {
        if (!cancelled) setGeminiHeard(text);
      },
      onSaid: (text) => {
        if (!cancelled) setGeminiSaid(text);
      },
      onLevel: (level) => {
        if (!cancelled) setMicLevel(level);
      },
      onSpeaking: (speaking) => {
        if (!cancelled) setIsSpeaking(speaking);
      },
      onError: (message) => {
        if (cancelled) return;
        // A dead socket turns the mic indicator off (PA-83) rather than
        // leaving it looking like it is listening to nothing.
        setLiveListenError(message);
        setGeminiLiveActive(false);
      },
      onNotice: (message) => {
        if (cancelled) return;
        showLiveListenNotice(message);
        if (message.startsWith('Gemini Live turned off')) setGeminiLiveActive(false);
      },
    });
    geminiRef.current = controller;
    setLiveListenError(null);
    controller.start().catch((err: unknown) => {
      if (cancelled) return;
      setLiveListenError(err instanceof Error ? err.message : 'Could not start Gemini Live.');
      setGeminiLiveActive(false);
    });
    return () => {
      cancelled = true;
      if (geminiRef.current === controller) geminiRef.current = null;
      void controller.stop();
      setGeminiState('stopped');
      setGeminiHeard('');
      setGeminiSaid('');
      setMicLevel(0);
      setIsSpeaking(false);
    };
  }, [geminiLive, shouldStream, chatId, api, showLiveListenNotice, micVersion]);

  useEffect(() => {
    if (!pipelineLiveActive || !shouldStream) {
      if (!geminiLive) setMicLevel(0);
      return;
    }

    let controller: LiveListenController | null = null;
    let cancelled = false;

    const start = async () => {
      ttsQueueRef.current?.arm();
      const ctrl = new LiveListenController({
        vad: vadOptionsRef.current,
        onUtterance: (utterance) => {
          if (!utterance.audioBase64) {
            ttsQueueRef.current?.resume();
            return;
          }
          void (async () => {
            try {
              const { text, words, durationSec } = await api.transcribeVoice(chatId, {
                data: utterance.audioBase64,
                durationMs: utterance.durationMs,
              });
              const trimmed = text.trim();
              if (!trimmed) {
                ttsQueueRef.current?.resume();
                return;
              }
              if (isSkipCommand(trimmed)) {
                ttsQueueRef.current?.stop();
                return;
              }
              const judgement = judgeUtterance({
                text,
                ...(words ? { words } : {}),
                ...(durationSec !== undefined ? { durationSec } : {}),
                durationMs: utterance.durationMs,
                ...(utterance.voicedMs !== undefined ? { voicedMs: utterance.voicedMs } : {}),
              });
              if (judgement.verdict === 'drop') {
                ttsQueueRef.current?.resume();
                showLiveListenNotice(`Ignored — ${judgement.reason}`);
                return;
              }
              if (judgement.verdict === 'review') {
                if (ttsQueueRef.current?.isPaused() || ttsQueueRef.current?.isPlaying()) {
                  ttsQueueRef.current?.stop();
                }
                const seq = reviewSeqRef.current++;
                setReviewText((prev) => ({ items: [...(prev?.items ?? []), { text: trimmed, seq }] }));
                showLiveListenNotice(`Parked for review — ${judgement.reason}`);
                return;
              }
              if (ttsQueueRef.current?.isPaused() || ttsQueueRef.current?.isPlaying()) {
                ttsQueueRef.current?.stop();
              }
              handleSendRef.current(text);
            } catch (err) {
              ttsQueueRef.current?.resume();
              setLiveListenError(
                err instanceof Error ? err.message : 'Could not transcribe that recording.',
              );
            }
          })();
        },
        onSpeechStart: () => {
          if (!ttsQueueRef.current?.isPlaying()) return;
          ttsQueueRef.current?.pause();
        },
        onSpeechDiscarded: () => {
          ttsQueueRef.current?.resume();
          showLiveListenNotice('Ignored — too short or not sustained');
        },
        onLevel: setMicLevel,
        onError: (message) => {
          setLiveListenError(message);
          setPipelineLiveActive(false);
          setMicLevel(0);
          ttsQueueRef.current?.stop();
        },
      });

      try {
        await ctrl.start();
        if (cancelled) {
          await ctrl.stop();
          return;
        }
        controller = ctrl;
        setLiveListenError(null);
      } catch (err) {
        if (!cancelled) {
          setLiveListenError(err instanceof Error ? err.message : 'Could not start live listening.');
          setPipelineLiveActive(false);
        }
      }
    };

    void start();

    return () => {
      cancelled = true;
      if (controller) {
        void controller.stop();
        controller = null;
      }
      if (!geminiLive) setMicLevel(0);
    };
  }, [pipelineLiveActive, shouldStream, geminiLive, chatId, api, showLiveListenNotice, micVersion]);

  const decide = (decision: PlannerToolApprovalChoice): void => {
    const pending = transcript?.pending[0];
    if (!pending || sending) return;
    setSending(true);
    setError(null);
    void (async () => {
      try {
        // PA-96: see `GeminiLiveController.flushSpeech` — keeps what Gemini
        // said while waiting ahead of the result in the transcript.
        if (geminiRef.current?.hasParkedCalls()) await geminiRef.current.flushSpeech();
        await api.resolvePlannerApproval(chatId, pending.id, decision, onStreamEvent);
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not record that decision.');
      } finally {
        setSending(false);
        void refreshSubagents();
        void refreshArtifacts();
      }
    })();
  };

  /**
   * PA-29: fetches the read-only "what would the next turn see" preview —
   * which memories rank highest for this conversation right now and how
   * much of the transcript is in-window vs. already folded into memory —
   * without starting a turn or touching anything server-side. Toggles the
   * panel closed again on a second click without a re-fetch; opening it
   * again always re-fetches, since the ranking is only ever as fresh as the
   * conversation was when this was last clicked.
   */
  const togglePreview = (): void => {
    if (previewOpen) {
      setPreviewOpen(false);
      return;
    }
    setPreviewOpen(true);
    setPreviewLoading(true);
    void (async () => {
      try {
        const response = await api.plannerContextPreview(chatId);
        setContextPreview(response);
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not load the context preview.');
      } finally {
        setPreviewLoading(false);
      }
    })();
  };

  return (
    <div className="planner-chat-page">
      <div className="planner-chat-header">
        <button type="button" className="planner-btn" onClick={onBack} aria-label="Back">
          <Icon name="chevron-left" size={16} />
        </button>
        {editingTitle ? (
          <input
            autoFocus
            className="planner-chat-title-input"
            value={titleInput}
            placeholder="Untitled chat"
            onChange={(e) => setTitleInput(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setEditingTitle(false);
            }}
          />
        ) : (
          <>
            <span className="planner-chat-title">{chat?.title ?? 'Untitled chat'}</span>
            <button type="button" className="planner-btn" onClick={startEditingTitle} aria-label="Rename chat">
              <Icon name="edit" size={14} />
            </button>
            <div className="doc-workspace-header-control" ref={workspaceMenuRef}>
              {attachedDocWorkspace ? (
                <button
                  type="button"
                  className={`planner-btn planner-artifacts-toggle${workspacePanelOpen ? ' active' : ''}`}
                  onClick={toggleWorkspacePanel}
                  aria-label={workspacePanelOpen ? 'Close workspace panel' : 'Open workspace panel'}
                  title={`Workspace: ${attachedDocWorkspace.name} (${attachedDocWorkspace.path})`}
                >
                  <Icon name="folder" size={14} />
                  <span>{attachedDocWorkspace.name}</span>
                  {workspaceFilePaths.length > 0 && (
                    <span className="planner-artifacts-count">{workspaceFilePaths.length}</span>
                  )}
                </button>
              ) : null}
              <button
                type="button"
                className={`planner-btn${workspaceMenuOpen ? ' active' : ''}`}
                onClick={() => {
                  void refreshDocWorkspaces();
                  setWorkspaceMenuOpen((v) => !v);
                }}
                aria-label={attachedDocWorkspace ? 'Switch or detach workspace' : 'Attach workspace'}
                title={attachedDocWorkspace ? 'Switch or detach workspace' : 'Attach a document workspace folder'}
              >
                <Icon name="folder" size={14} />
                {!attachedDocWorkspace && <span>Workspace</span>}
                <Icon name="chevron-down" size={12} />
              </button>
              {workspaceMenuOpen && (
                <div className="model-picker doc-workspace-menu" role="menu" aria-label="Document workspaces">
                  {docWorkspaces.map((dw) => {
                    const isCurrent = dw.id === attachedDocWorkspaceId;
                    return (
                      <button
                        key={dw.id}
                        type="button"
                        role="menuitem"
                        className={isCurrent ? 'active' : ''}
                        onClick={() => void handleAttachWorkspace(dw.id)}
                      >
                        <span className="model-row">
                          <span className="model-name">{dw.name}</span>
                          {isCurrent && <Icon name="check" size={14} />}
                        </span>
                        <span className="model-desc">{dw.path}</span>
                      </button>
                    );
                  })}
                  <div className="model-picker-divider" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setWorkspaceMenuOpen(false);
                      setWorkspacePickerOpen(true);
                    }}
                  >
                    <span className="model-name">+ New workspace folder…</span>
                  </button>
                  {attachedDocWorkspaceId && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void handleAttachWorkspace(null)}
                    >
                      <span className="model-name">Detach workspace</span>
                    </button>
                  )}
                </div>
              )}
            </div>
            <button
              type="button"
              className={`planner-btn planner-artifacts-toggle${artifactsOpen ? ' active' : ''}`}
              onClick={toggleArtifacts}
              aria-label={artifactsOpen ? 'Close artifacts side panel' : 'Open artifacts side panel'}
              title="Artifacts generated in this workspace"
            >
              <Icon name="file" size={14} />
              <span>Artifacts</span>
              {artifacts.length > 0 && (
                <span className="planner-artifacts-count">{artifacts.length}</span>
              )}
            </button>
            <button
              type="button"
              className={`planner-btn gemini-live-toggle${geminiLive ? ' active' : ''}${!isGeminiConfigured ? ' disabled' : ''}`}
              disabled={!isGeminiConfigured}
              onClick={() => handleToggleGeminiLive(!geminiLiveActive)}
              aria-label={
                !geminiAvailable
                  ? 'Gemini Live is not configured (requires API key in Settings)'
                  : !geminiSelected
                    ? 'Gemini Live is not configured for this agent'
                    : geminiLive
                      ? 'Turn off Gemini Live'
                      : 'Turn on Gemini Live'
              }
              title={
                !geminiAvailable
                  ? 'Gemini Live is not configured on this server (add Gemini API key in Providers and Models)'
                  : !geminiSelected
                    ? 'Gemini Live is not enabled for this agent (select Gemini Live in agent settings)'
                    : geminiLive
                      ? 'Gemini Live is active (listening) — click to turn off'
                      : 'Gemini Live is configured — click to enable hands-free live mode'
              }
            >
              <Icon name="live-listen" size={14} />
              <span>Gemini Live</span>
              {geminiLive && <span className="live-listen-dot" aria-hidden="true" />}
            </button>
            {geminiSelected && (
              // PA-96 disclosure, on every visit to a chat whose agent uses
              // Gemini Live. Since PA-131 it is a standing ⓘ beside the toggle
              // rather than a banner: the text is one hover (desktop) or one tap
              // (a phone has no hover) away, and the button itself is always
              // there, which is what "on every visit" asks of it. Warning-coloured
              // when live mode is unavailable, so a disabled toggle never reads
              // as a broken one.
              <span className={`gemini-info${geminiInfoOpen ? ' open' : ''}`} ref={geminiInfoRef}>
                <button
                  type="button"
                  className={`planner-btn gemini-info-btn${geminiAvailable ? '' : ' warn'}`}
                  onClick={() => setGeminiInfoOpen((v) => !v)}
                  aria-expanded={geminiInfoOpen}
                  aria-describedby="gemini-live-disclosure"
                  aria-label="About Gemini Live in this chat"
                >
                  <Icon name="info" size={15} />
                </button>
                <span id="gemini-live-disclosure" className="gemini-info-pop" role="tooltip">
                  {geminiAvailable ? GEMINI_LIVE_DISCLOSURE : GEMINI_LIVE_UNAVAILABLE}
                </span>
              </span>
            )}
          </>
        )}
      </div>

      <div className="planner-chat-body">
        <div className="planner-chat-main">
          {chat?.parentChatId && (
        <div className="planner-parent-chat-banner" role="status">
          <Icon name="agent-generic" size={13} />
          <span>Spawned as a subagent by</span>
          <button
            type="button"
            className="planner-parent-chat-link"
            onClick={() => {
              if (onOpenPlannerChat) onOpenPlannerChat(chat.parentChatId!);
              else window.location.hash = `#/planner/${encodeURIComponent(chat.parentChatId!)}`;
            }}
          >
            parent chat
          </button>
        </div>
      )}

      {chat?.skipToolApprovalsEnabled === true && (
        // PA-10 disclosure. CLAUDE.md's first invariant requires that a session
        // running with approvals bypassed "say so persistently in the UI, not
        // just at the moment it was created" — this chat was created by an
        // unattended trigger whose skip-permissions toggle was on, so every
        // mutating tool call in it runs without asking. Rendered on every visit,
        // not once.
        <div className="warn-callout" role="status">
          Tool approvals are bypassed in this chat. It was started by a trigger
          configured to skip them, so its file and command tools run without asking.
        </div>
      )}

      {geminiLive && (
        <div className="planner-gemini-strip" role="status" aria-live="polite">
          <div className="planner-gemini-strip-state">
            Gemini Live ·{' '}
            {geminiState === 'live'
              ? 'listening'
              : geminiState === 'reconnecting'
                ? 'reconnecting…'
                : geminiState === 'connecting'
                  ? 'connecting…'
                  : 'off'}
          </div>
          {geminiHeard && (
            <p className="planner-gemini-strip-line">
              <span className="planner-gemini-strip-who">You</span> {geminiHeard}
            </p>
          )}
          {geminiSaid && (
            <p className="planner-gemini-strip-line">
              <span className="planner-gemini-strip-who">Gemini</span> {geminiSaid}
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {subagents.length + plannerSubagents.length > 0 && (
        <div className="planner-subagents-panel" aria-label="Subagents spawned by this chat">
          <div className="planner-subagents-header">
            <Icon name="agent-generic" size={13} />
            <span className="planner-subagents-title">Subagents</span>
            <span className="planner-subagents-count">{subagents.length + plannerSubagents.length}</span>
          </div>
          <div className="planner-subagents-list">
            {subagents.map((subagent) => {
              const live = subagent.status === 'running' || subagent.status === 'starting';
              return (
                <div key={subagent.id} className="planner-subagent-card-wrap">
                  <a
                    href={`#/s/${encodeURIComponent(subagent.id)}`}
                    className={`planner-subagent-card${live ? ' live' : ''}`}
                    onClick={(e) => {
                      e.preventDefault();
                      if (onOpenSession) {
                        onOpenSession(subagent.id);
                      } else {
                        window.location.hash = `#/s/${encodeURIComponent(subagent.id)}`;
                      }
                    }}
                    title={`${subagent.title} (${subagent.workspaceLabel || subagent.cwd})`}
                  >
                    <span className="planner-subagent-status">
                      {live ? (
                        <span className="live-dot" aria-label="running" />
                      ) : (
                        <span className="dead-dot" aria-label="finished" />
                      )}
                    </span>
                    <div className="planner-subagent-info">
                      <span className="planner-subagent-name">{subagent.title}</span>
                      <span className="planner-subagent-cwd">{subagent.workspaceLabel || subagent.cwd}</span>
                    </div>
                    <Icon name="chevron-right" size={12} className="planner-subagent-arrow" />
                  </a>
                  <button
                    type="button"
                    className="planner-subagent-card-remove"
                    onClick={(e) => removeCodingSubagent(subagent, e)}
                    aria-label={`Delete ${subagent.title}`}
                    title="Delete subagent"
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              );
            })}
            {plannerSubagents.map((subChat) => (
              <div key={subChat.id} className="planner-subagent-card-wrap">
                <a
                  href={`#/planner/${encodeURIComponent(subChat.id)}`}
                  className="planner-subagent-card"
                  onClick={(e) => {
                    e.preventDefault();
                    if (onOpenPlannerChat) {
                      onOpenPlannerChat(subChat.id);
                    } else {
                      window.location.hash = `#/planner/${encodeURIComponent(subChat.id)}`;
                    }
                  }}
                  title={`${subChat.title ?? 'Untitled chat'} (Pocket Agent · ${subChat.workspaceName})`}
                >
                  <span className="planner-subagent-status">
                    <Icon name="agent-generic" size={13} />
                  </span>
                  <div className="planner-subagent-info">
                    <span className="planner-subagent-name">{subChat.title ?? 'Untitled chat'}</span>
                    <span className="planner-subagent-cwd">Pocket Agent · {subChat.workspaceName}</span>
                  </div>
                  <Icon name="chevron-right" size={12} className="planner-subagent-arrow" />
                </a>
                <button
                  type="button"
                  className="planner-subagent-card-remove"
                  onClick={(e) => removePlannerSubagent(subChat.id, e)}
                  aria-label={`Delete ${subChat.title ?? 'Untitled chat'}`}
                  title="Delete subagent"
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {transcript === null ? (
        <div className="spinner">Loading…</div>
      ) : (
        <AttachmentHrefContext.Provider value={attachmentHref}>
          <Transcript
            state={transcript}
            starterPrompts={PLANNER_STARTER_PROMPTS}
            onSelectPrompt={(text) => void handleSend(text)}
          />
        </AttachmentHrefContext.Provider>
      )}

      {pending && (
        <div className="planner-approval-card" role="alertdialog" aria-label="Tool approval">
          <p className="planner-approval-title">
            This agent wants to run <code>{pending.displayName ?? pending.toolName}</code>
          </p>
          <pre className="planner-approval-args">{JSON.stringify(pending.input, null, 2)}</pre>
          <div className="planner-approval-actions">
            <button type="button" className="planner-btn" disabled={sending} onClick={() => decide('allow_once')}>
              Allow once
            </button>
            {/* PA-134: a target-scoped tool (a Hub dispatch) may be remembered
                for this agent and that host only, never globally; the server
                refuses the same choices this hides. Absent means both. */}
            {(pending.rememberScopes ?? ['workspace', 'global']).includes('workspace') && (
              <button
                type="button"
                className="planner-btn"
                disabled={sending}
                onClick={() => decide('allow_workspace')}
              >
                {pending.rememberScopes ? 'Allow for this agent and target' : 'Allow for this workspace'}
              </button>
            )}
            {(pending.rememberScopes ?? ['workspace', 'global']).includes('global') && (
              <button type="button" className="planner-btn" disabled={sending} onClick={() => decide('allow_global')}>
                Allow globally
              </button>
            )}
            <button type="button" className="planner-btn danger" disabled={sending} onClick={() => decide('deny')}>
              Deny
            </button>
          </div>
        </div>
      )}

      {previewOpen && (
        <div className="planner-context-preview">
          <div className="planner-context-preview-header">
            <span className="planner-context-preview-heading">
              <span className="planner-context-preview-title">Context Preview</span>
              {contextPreview && (
                <span className="planner-context-preview-total">~{contextPreview.totalTokens} tokens total</span>
              )}
            </span>
            <button
              type="button"
              className="planner-context-preview-close"
              onClick={() => setPreviewOpen(false)}
              aria-label="Close context preview"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
          {previewLoading ? (
            <div className="spinner">Loading…</div>
          ) : contextPreview ? (
            <>
              {contextPreview.systemPrompt.length > 0 && (
                <div className="planner-context-preview-group">
                  <p className="planner-context-preview-group-title">System prompt</p>
                  <ul className="planner-context-preview-sections">
                    {contextPreview.systemPrompt.map((section) => {
                      const expanded = expandedSections.has(section.id);
                      const firstLine = section.text.split('\n').find((line) => line.trim().length > 0) ?? section.text;
                      return (
                        <li key={section.id} className="planner-context-preview-section">
                          <button
                            type="button"
                            className="planner-context-preview-section-head"
                            onClick={() => toggleSection(section.id)}
                            aria-expanded={expanded}
                          >
                            <span className="chev" aria-hidden="true">
                              {expanded ? '▾' : '▸'}
                            </span>
                            <span className="planner-context-preview-section-label">{section.label}</span>
                            <span className="planner-context-preview-section-tokens">~{section.tokens} tokens</span>
                          </button>
                          {expanded ? (
                            <pre className="planner-context-preview-section-text expanded">{section.text}</pre>
                          ) : (
                            <p className="planner-context-preview-section-text">{firstLine}</p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              <div className="planner-context-preview-group">
                <p className="planner-context-preview-group-title">Conversation history</p>
                {contextPreview.budget?.compactionEnabled ? (
                  // PA-121: a token budget rather than a turn count.
                  <p className="planner-context-preview-window">
                    {contextPreview.window.inWindowMessages} of{' '}
                    {contextPreview.window.inWindowMessages + contextPreview.window.foldedMessages} transcript
                    messages are in context (~{contextPreview.window.tokens.toLocaleString()} tokens)
                    {contextPreview.budget.compactions > 0
                      ? ` — the rest is covered by a summary (compacted ${contextPreview.budget.compactions} time${
                          contextPreview.budget.compactions === 1 ? '' : 's'
                        })`
                      : ''}
                    .
                  </p>
                ) : (
                  <p className="planner-context-preview-window">
                    {contextPreview.window.inWindowMessages} of{' '}
                    {contextPreview.window.inWindowMessages + contextPreview.window.foldedMessages} transcript
                    messages are in context (window: last {contextPreview.window.windowLimit} turns, ~
                    {contextPreview.window.tokens} tokens)
                    {contextPreview.window.foldedMessages > 0 &&
                      ` — ${contextPreview.window.foldedMessages} older ones were folded into memory`}
                    .
                  </p>
                )}
                {contextPreview.budget && (
                  <p className="planner-context-preview-window">
                    About {contextPreview.totalTokens.toLocaleString()} of{' '}
                    {contextPreview.budget.contextWindow.toLocaleString()} tokens used
                    {contextPreview.budget.modelId ? ` (${contextPreview.budget.modelId}` : ' ('}
                    {contextPreview.budget.contextWindowSource === 'model'
                      ? ')'
                      : contextPreview.budget.contextWindowSource === 'known'
                        ? '; window assumed from the model name — set it under Providers and Models → Models)'
                        : '; window unknown, assumed — set it under Providers and Models → Models)'}
                    .{' '}
                    {contextPreview.budget.compactionEnabled
                      ? `Compacts automatically at about ${contextPreview.budget.thresholdTokens.toLocaleString()}; /compact does it now.`
                      : 'Automatic compaction is off.'}
                    {contextPreview.budget.spentUsd != null &&
                      ` Turns in this chat have cost about $${contextPreview.budget.spentUsd.toFixed(4)} (from the model prices in Providers and Models, or the provider's own figure).`}
                  </p>
                )}
              </div>

              <div className="planner-context-preview-group">
                <p className="planner-context-preview-group-title">Memory</p>
                {!contextPreview.memoryEnabled ? (
                  <p className="planner-context-preview-empty">Memory is turned off for this agent.</p>
                ) : contextPreview.candidates.length === 0 ? (
                  <p className="planner-context-preview-empty">No saved memories matched this conversation.</p>
                ) : (
                  <ul className="planner-context-preview-list">
                    {contextPreview.candidates.map((c) => (
                      <li
                        key={c.memory.id}
                        className={`planner-context-preview-item${c.selected ? ' selected' : ''}`}
                      >
                        <span className="planner-context-preview-score">{c.score.toFixed(2)}</span>
                        <span className="planner-context-preview-content">{c.memory.content}</span>
                        <span className="planner-context-preview-tokens">~{c.tokens} tokens</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="planner-context-preview-group">
                <p className="planner-context-preview-group-title">Tools</p>
                <p className="planner-context-preview-window">
                  {contextPreview.tools.enabledCount} tool{contextPreview.tools.enabledCount === 1 ? '' : 's'} enabled,
                  ~{contextPreview.tools.tokens} tokens of schema
                  {contextPreview.tools.mcpActive && ' — MCP active'}
                  {contextPreview.tools.skillsActive && ' — skills active'}.
                </p>
              </div>
            </>
          ) : null}
        </div>
      )}

      {queued.length > 0 && !geminiLive && (
        <div className="planner-queue" aria-live="polite">
          <p className="planner-queue-title">
            <Icon name="queue" size={14} />
            {pending !== null
              ? 'Waiting for your answer to the approval above, then sent:'
              : isChatBusy
                ? 'Sent after the current step:'
                : 'Sending…'}
          </p>
          {queued.map((q) => (
            <div key={q.id} className="planner-queue-item">
              <span className="planner-queue-text">
                {q.hasImage && <span className="planner-queue-image">image</span>}
                {q.attachmentNames?.map((name) => (
                  <span key={name} className="planner-queue-image">{name}</span>
                ))}
                {q.text}
              </span>
              <button
                type="button"
                className="planner-queue-cancel"
                onClick={() => cancelQueued(q.id)}
                aria-label="Cancel this queued message"
                title="Cancel — it will not be sent"
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <PromptBox
        sessionId={`planner_${chatId}`}
        historyKey={plannerPromptHistoryKey()}
        onSend={handleSend}
        disabled={disabled}
        supportsImageAttachment={true}
        attachmentNote={imageNote}
        onUploadFile={uploadFile}
        workspaceFiles={workspaceFilePaths}
        supportsVoiceInput={voiceEnabled}
        onTranscribeVoice={
          voiceEnabled
            ? (audio) => api.transcribeVoice(chatId, audio).then((res) => res.text)
            : undefined
        }
        // PA-98: Both Gemini Live (in header) and self-made live stream (in PromptBox)
        // are available so the user can pick whichever live experience they want.
        supportsLiveListen={voiceEnabled}
        liveListenActive={pipelineLiveActive}
        onSetLiveListen={handleTogglePipelineLive}
        micLevel={micLevel}
        liveListenError={liveListenError}
        liveListenNotice={liveListenNotice}
        reviewText={reviewText}
        isSpeaking={isSpeaking}
        onStopSpeaking={handleStopSpeaking}
        commands={PLANNER_SLASH_COMMANDS}
        models={toModelInfos(models)}
        currentModel={chat?.lastModelId ?? null}
        onSetModel={changeModel}
        effort={chat?.lastEffort ?? null}
        onSetEffort={changeEffort}
        thinking={chat?.thinkingEnabled !== false}
        onToggleThinking={toggleThinking}
        busy={geminiLive ? false : isChatBusy}
        queueWhileBusy={!geminiLive}
        onInterrupt={handleInterrupt}
      />
        </div>

        {workspacePanelOpen && attachedDocWorkspace && (
          <WorkspacePanel
            workspace={attachedDocWorkspace}
            entries={docWorkspaceEntries}
            progress={docWorkspaceProgress}
            loading={docWorkspaceLoading}
            error={docWorkspaceError}
            onRefresh={() => void refreshDocWorkspaceFiles()}
            onClose={() => setWorkspacePanelOpen(false)}
            onUseInChat={handleUseInChat}
            onWorkspaceUpdated={(updated) => {
              setDocWorkspaces((prev) => prev.map((w) => (w.id === updated.id ? updated : w)));
            }}
          />
        )}

        {artifactsOpen && (
          <>
            <div
              className="planner-artifacts-backdrop"
              onClick={() => setArtifactsOpen(false)}
              aria-hidden="true"
            />
            <aside className="planner-artifacts-panel" aria-label="Workspace artifacts side panel">
            <div className="planner-artifacts-header">
              <div className="planner-artifacts-title">
                <Icon name="file" size={15} />
                <span>Artifacts</span>
                <span className="planner-artifacts-badge">{artifacts.length}</span>
              </div>
              <div className="planner-artifacts-actions">
                {artifacts.length > 0 && (
                  <button
                    type="button"
                    className="planner-artifact-btn danger"
                    onClick={() => setConfirmCleanAll(true)}
                    disabled={artifactsLoading || deletingArtifact}
                    aria-label="Clean all artifacts"
                    title="Clean all artifacts"
                  >
                    <Icon name="trash" size={14} />
                  </button>
                )}
                <button
                  type="button"
                  className="planner-artifact-btn"
                  onClick={() => void refreshArtifacts()}
                  disabled={artifactsLoading}
                  aria-label="Refresh artifacts list"
                  title="Refresh artifacts"
                >
                  <Icon name="rotate" size={14} />
                </button>
                <button
                  type="button"
                  className="planner-artifact-btn"
                  onClick={() => setArtifactsOpen(false)}
                  aria-label="Close artifacts panel"
                  title="Close panel"
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            </div>

            {artifactsError && (
              <div className="planner-artifacts-error" role="alert">
                {artifactsError}
              </div>
            )}

            {artifactsLoading && artifacts.length === 0 ? (
              <div className="planner-artifacts-loading">Loading artifacts…</div>
            ) : artifacts.length === 0 ? (
              <div className="planner-artifacts-empty">
                <Icon name="folder" size={32} />
                <p className="planner-artifacts-empty-title">No artifacts yet</p>
                <p className="planner-artifacts-empty-desc">
                  Files and plans created by the agent in <code>artifacts/</code> will appear here.
                </p>
              </div>
            ) : (
              <ul className="planner-artifacts-list">
                {artifacts.map((artifact) => {
                  const inline = isViewableInline(artifact.name);
                  return (
                    <li key={artifact.name} className="planner-artifact-item">
                      <button
                        type="button"
                        className="planner-artifact-main"
                        onClick={() => handleOpenArtifact(artifact)}
                        title={inline ? `Open ${artifact.name} in new tab` : `Download ${artifact.name}`}
                      >
                        <span className="planner-artifact-icon">
                          <Icon name={inline ? 'file' : 'download'} size={15} />
                        </span>
                        <span className="planner-artifact-info">
                          <span className="planner-artifact-name">{artifact.name}</span>
                          <span className="planner-artifact-meta">
                            {formatFileSize(artifact.size)} · {formatArtifactDate(artifact.modifiedAt)}
                          </span>
                        </span>
                      </button>
                      <div className="planner-artifact-item-actions">
                        <button
                          type="button"
                          className="planner-artifact-btn"
                          onClick={() => handleDownloadArtifact(artifact)}
                          aria-label={`Download ${artifact.name}`}
                          title="Download file"
                        >
                          <Icon name="download" size={14} />
                        </button>
                        <button
                          type="button"
                          className="planner-artifact-btn danger"
                          onClick={() => setPendingDeleteArtifact(artifact)}
                          aria-label={`Delete ${artifact.name}`}
                          title="Delete file"
                        >
                          <Icon name="trash" size={14} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>
        </>
      )}
    </div>

      {workspacePickerOpen && (
        <PlannerDirectoryPicker
          onPick={(selectedPath, opts) => void handleCreateAndAttachWorkspace(selectedPath, opts)}
          onClose={() => setWorkspacePickerOpen(false)}
          onApiError={onApiError}
        />
      )}

      {pendingDeleteArtifact && (
        <ConfirmDialog
          title="Delete artifact?"
          body={`Are you sure you want to delete "${pendingDeleteArtifact.name}"? This cannot be undone.`}
          confirmLabel={deletingArtifact ? 'Deleting…' : 'Delete'}
          danger={true}
          busy={deletingArtifact}
          onConfirm={() => void handleDeleteArtifact()}
          onCancel={() => setPendingDeleteArtifact(null)}
        />
      )}

      {confirmCleanAll && (
        <ConfirmDialog
          title="Clean all artifacts?"
          body={`Are you sure you want to delete all ${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'} in this workspace? This cannot be undone.`}
          confirmLabel={deletingArtifact ? 'Cleaning…' : 'Clean all'}
          danger={true}
          busy={deletingArtifact}
          onConfirm={() => void handleCleanAllArtifacts()}
          onCancel={() => setConfirmCleanAll(false)}
        />
      )}
    </div>
  );
}
