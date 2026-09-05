import { useCallback, useEffect, useState } from 'react';
import type {
  AgentEvent,
  ModelInfo,
  PlannerChat,
  PlannerModel,
  PlannerToolApprovalChoice,
} from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { Icon } from '../components/Icon.js';
import { Transcript } from '../components/Transcript.js';
import { PromptBox } from '../components/PromptBox.js';
import { applyEvent, applyEvents, emptyTranscript, type TranscriptState } from '../agent/transcript.js';

interface Props {
  chatId: string;
  onBack: () => void;
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
export function PlannerChatPage({ chatId, onBack, onApiError }: Props): JSX.Element {
  const [chat, setChat] = useState<PlannerChat | null>(null);
  const [models, setModels] = useState<PlannerModel[]>([]);
  const [transcript, setTranscript] = useState<TranscriptState | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState('');

  const load = useCallback(async () => {
    try {
      const [{ chats }, { models: modelList }, { events }] = await Promise.all([
        api.listPlannerChats(),
        api.listPlannerModels(),
        api.plannerChatHistory(chatId),
      ]);
      setChat(chats.find((c) => c.id === chatId) ?? null);
      setModels(modelList);
      setTranscript(applyEvents(emptyTranscript(), events));
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load this chat.');
    }
  }, [chatId, onApiError]);

  useEffect(() => {
    void load();
  }, [load]);

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
  const onStreamEvent = (event: AgentEvent): void => {
    setTranscript((prev) => applyEvent(prev ?? emptyTranscript(), event));
  };

  /** `PromptBox.onSend` is synchronous by contract (see its own props doc):
      a `true` return clears the composer immediately, matching how a real
      session's prompt clears on submit rather than waiting for a reply. */
  const handleSend = (content: string): boolean => {
    const trimmed = content.trim();
    if (!trimmed || sending) return false;
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
        await api.sendPlannerMessage(chatId, { content: trimmed }, onStreamEvent);
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
      }
    })();
  };

  const pending = transcript?.pending[0] ?? null;
  const disabled = sending || pending !== null;

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

      {error && (
        <div className="error-box" role="alert">
          {error}
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

      <PromptBox
        sessionId={`planner_${chatId}`}
        onSend={handleSend}
        disabled={disabled}
        models={toModelInfos(models)}
        currentModel={chat?.lastModelId ?? null}
        onSetModel={changeModel}
        busy={transcript?.busy ?? false}
      />
    </div>
  );
}
