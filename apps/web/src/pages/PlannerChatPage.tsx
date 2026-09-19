import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentEvent,
  ModelInfo,
  PlannerChat,
  PlannerContextPreviewResponse,
  PlannerModel,
  PlannerToolApprovalChoice,
  PromptImage,
  SessionInfo,
  SlashCommandInfo,
} from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { Icon } from '../components/Icon.js';
import { Transcript } from '../components/Transcript.js';
import { PromptBox } from '../components/PromptBox.js';
import { applyEvent, applyEvents, emptyTranscript, type TranscriptState } from '../agent/transcript.js';

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
function toModelInfos(models: PlannerModel[]): ModelInfo[] {
  return models.map((m) => ({
    value: m.modelId,
    displayName: m.label,
    description: '',
    supportsEffort: false,
    supportedEffortLevels: [],
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
  if (event.kind === 'text_delta') return null;
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
  if (event.kind === 'commands_available') {
    return { key: `commands_available:${event.commands.map((c) => c.name).join(',')}`, ephemeral: true };
  }
  return null;
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
  const [chat, setChat] = useState<PlannerChat | null>(null);
  const [models, setModels] = useState<PlannerModel[]>([]);
  const [transcript, setTranscript] = useState<TranscriptState | null>(null);
  const [subagents, setSubagents] = useState<SessionInfo[]>([]);
  const [plannerSubagents, setPlannerSubagents] = useState<PlannerChat[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      const found = chats.find((c) => c.id === chatId) ?? null;
      setChat(found);
      setMissing(found === null);
      setModels(modelList);
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
    [chatId, refreshSubagents, isEventSeen, markEventSeen],
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
  const isChatBusy = sending || (chat?.busy ?? false) || (transcript?.busy ?? false);
  const disabled = isChatBusy || pending !== null;

  /** `PromptBox.onSend` is synchronous by contract (see its own props doc):
      a `true` return clears the composer immediately, matching how a real
      session's prompt clears on submit rather than waiting for a reply. */
  const handleSend = (content: string, image?: PromptImage): boolean => {
    const trimmed = content.trim();
    if ((!trimmed && !image) || isChatBusy || pending !== null) return false;

    // Handle slash commands without sending to LLM:
    if (!image && (trimmed === '/clear' || trimmed === '/reset')) {
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

    if (!image && trimmed === '/context') {
      togglePreview();
      return true;
    }

    if (!image && trimmed === '/mcp') {
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
    void (async () => {
      try {
        await api.sendPlannerMessage(chatId, { content: trimmed, image }, onStreamEvent);
        if (wasUntitled) {
          const { chats } = await api.listPlannerChats();
          setChat((prev) => chats.find((c) => c.id === chatId) ?? prev);
        }
      } catch (err) {
        onApiError(err);
        setError(
          err instanceof ApiError
            ? err.message
            : 'Could not reach Pocket Agent. Your message was not sent.',
        );
      } finally {
        setSending(false);
        void refreshSubagents();
      }
    })();
    return true;
  };

  const decide = (decision: PlannerToolApprovalChoice): void => {
    const pending = transcript?.pending[0];
    if (!pending || sending) return;
    setSending(true);
    setError(null);
    void (async () => {
      try {
        await api.resolvePlannerApproval(chatId, pending.id, decision, onStreamEvent);
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not record that decision.');
      } finally {
        setSending(false);
        void refreshSubagents();
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
          </>
        )}
      </div>

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

      {transcript === null ? <div className="spinner">Loading…</div> : <Transcript state={transcript} />}

      {pending && (
        <div className="planner-approval-card" role="alertdialog" aria-label="Tool approval">
          <p className="planner-approval-title">
            This agent wants to run <code>{pending.toolName}</code>
          </p>
          <pre className="planner-approval-args">{JSON.stringify(pending.input, null, 2)}</pre>
          <div className="planner-approval-actions">
            <button type="button" className="planner-btn" disabled={sending} onClick={() => decide('allow_once')}>
              Allow once
            </button>
            <button
              type="button"
              className="planner-btn"
              disabled={sending}
              onClick={() => decide('allow_workspace')}
            >
              Allow for this workspace
            </button>
            <button type="button" className="planner-btn" disabled={sending} onClick={() => decide('allow_global')}>
              Allow globally
            </button>
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
                <p className="planner-context-preview-window">
                  {contextPreview.window.inWindowMessages} of{' '}
                  {contextPreview.window.inWindowMessages + contextPreview.window.foldedMessages} transcript
                  messages are in context (window: last {contextPreview.window.windowLimit} turns, ~
                  {contextPreview.window.tokens} tokens)
                  {contextPreview.window.foldedMessages > 0 &&
                    ` — ${contextPreview.window.foldedMessages} older ones were folded into memory`}
                  .
                </p>
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

      <PromptBox
        sessionId={`planner_${chatId}`}
        onSend={handleSend}
        disabled={disabled}
        supportsImageAttachment={true}
        commands={PLANNER_SLASH_COMMANDS}
        models={toModelInfos(models)}
        currentModel={chat?.lastModelId ?? null}
        onSetModel={changeModel}
        busy={isChatBusy}
      />
    </div>
  );
}
