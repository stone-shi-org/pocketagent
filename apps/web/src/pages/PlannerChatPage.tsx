import { useCallback, useEffect, useState } from 'react';
import type {
  ModelInfo,
  PlannerChat,
  PlannerModel,
  PlannerToolApprovalChoice,
  PlannerTranscriptEntry,
  PlannerTurnResult,
} from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { Icon } from '../components/Icon.js';
import { Transcript } from '../components/Transcript.js';
import { PromptBox } from '../components/PromptBox.js';
import { emptyTranscript, type TextItem, type TranscriptState } from '../agent/transcript.js';

interface Props {
  chatId: string;
  onBack: () => void;
  onApiError: (error: unknown) => void;
}

interface PendingApproval {
  approvalId: string;
  toolName: string;
  argsSummary: string;
}

/**
 * `PlannerTranscriptEntry[]` (one row per turn's user message or assistant
 * reply, persisted as JSONL — see `planner/transcript.ts`) rendered as the
 * same `TextItem[]` a structured session's own event stream produces, so
 * `Transcript` draws a planner chat exactly the way it draws every other
 * chat in this app: no bubbles, a user turn as a single-line sticky header
 * (stacking up to three deep — `Transcript.tsx`'s `STICKY_WINDOW`), an
 * assistant reply as plain markdown with a copy icon. Tool calls are not in
 * this list at all — they are deliberately not persisted to the transcript
 * (see `PlannerChatService`'s doc comment) — so a planner transcript only
 * ever contains `text` items, never `tool`/`thinking`/`turn` ones.
 */
function toTranscriptItems(entries: PlannerTranscriptEntry[]): TextItem[] {
  return entries.map((entry, i) => ({
    type: 'text',
    key: `${entry.role}_${i}_${entry.createdAt}`,
    role: entry.role,
    text: entry.content,
    streaming: false,
  }));
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
 * PA-6: one planner chat, rendered as an exact mirror of a structured
 * session's own chat UI (`Transcript` + `PromptBox`) per the reporter's
 * request — no separate bubble-based design. What is still planner-specific:
 *
 * - The turn loop is request/response, not a live token stream (see
 *   `llm-client.ts`'s doc comment) — a full assistant reply lands in one
 *   piece rather than filling in via `text_delta`, but it renders through
 *   the exact same `TextItem`/`Transcript` path either way. `state.busy`
 *   still drives the same "thinking" dots a structured session shows while
 *   waiting on its own turn.
 * - The approval card below is this page's own stand-in for `ApprovalSheet`
 *   — a mutating tool call with no remembered decision pauses the turn, and
 *   this renders the pause with the same "once / remember for this
 *   workspace / remember globally / deny" choices, resolved via
 *   `POST .../approvals/:id` (`planner/approval.ts`). Docked between the
 *   transcript and the composer rather than a draggable bottom sheet — the
 *   full `ApprovalSheet` treatment is future scope, not requested here.
 */
export function PlannerChatPage({ chatId, onBack, onApiError }: Props): JSX.Element {
  const [chat, setChat] = useState<PlannerChat | null>(null);
  const [models, setModels] = useState<PlannerModel[]>([]);
  const [entries, setEntries] = useState<PlannerTranscriptEntry[] | null>(null);
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ chats }, { models: modelList }, { entries: history }] = await Promise.all([
        api.listPlannerChats(),
        api.listPlannerModels(),
        api.plannerChatHistory(chatId),
      ]);
      setChat(chats.find((c) => c.id === chatId) ?? null);
      setModels(modelList);
      setEntries(history);
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

  /** Shared tail for both `sendPlannerMessage` and `resolvePlannerApproval`:
      either the turn is done (append the reply, stop waiting) or it paused
      again on a different tool call (show that one instead). */
  const applyTurn = (turn: PlannerTurnResult): void => {
    if (turn.status === 'completed') {
      setEntries((prev) => [...(prev ?? []), turn.assistantEntry]);
      setPending(null);
      setSending(false);
    } else {
      setPending({ approvalId: turn.approvalId, toolName: turn.toolName, argsSummary: turn.argsSummary });
      // Composer stays disabled (`sending`) while a decision is pending —
      // there is nothing to send until this turn is resolved one way or another.
    }
  };

  /** `PromptBox.onSend` is synchronous by contract (see its own props doc):
      a `true` return clears the composer immediately, matching how a real
      session's prompt clears on submit rather than waiting for a reply. */
  const handleSend = (content: string): boolean => {
    const trimmed = content.trim();
    if (!trimmed || sending) return false;
    setSending(true);
    setError(null);
    void (async () => {
      try {
        const { userEntry, turn } = await api.sendPlannerMessage(chatId, { content: trimmed });
        setEntries((prev) => [...(prev ?? []), userEntry]);
        applyTurn(turn);
      } catch (err) {
        onApiError(err);
        setError(
          err instanceof ApiError
            ? err.message
            : 'Could not reach Pocket Agent. Your message was not sent.',
        );
        setSending(false);
      }
    })();
    return true;
  };

  const decide = (decision: PlannerToolApprovalChoice): void => {
    if (!pending) return;
    const approvalId = pending.approvalId;
    void (async () => {
      try {
        const turn = await api.resolvePlannerApproval(chatId, approvalId, decision);
        applyTurn(turn);
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not record that decision.');
        setSending(false);
      }
    })();
  };

  const transcriptState: TranscriptState = {
    ...emptyTranscript(),
    items: entries === null ? [] : toTranscriptItems(entries),
    busy: sending && !pending,
  };

  return (
    <div className="planner-chat-page">
      <div className="planner-chat-header">
        <button type="button" className="planner-btn" onClick={onBack} aria-label="Back">
          <Icon name="chevron-left" size={16} />
        </button>
        <span className="planner-chat-title">{chat?.title ?? 'Untitled chat'}</span>
      </div>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {entries === null ? (
        <div className="spinner">Loading…</div>
      ) : (
        <Transcript state={transcriptState} />
      )}

      {pending && (
        <div className="planner-approval-card" role="alertdialog" aria-label="Tool approval">
          <p className="planner-approval-title">
            This agent wants to run <code>{pending.toolName}</code>
          </p>
          <pre className="planner-approval-args">{pending.argsSummary}</pre>
          <div className="planner-approval-actions">
            <button type="button" className="planner-btn" onClick={() => decide('allow_once')}>
              Allow once
            </button>
            <button type="button" className="planner-btn" onClick={() => decide('allow_workspace')}>
              Allow for this workspace
            </button>
            <button type="button" className="planner-btn" onClick={() => decide('allow_global')}>
              Allow globally
            </button>
            <button type="button" className="planner-btn danger" onClick={() => decide('deny')}>
              Deny
            </button>
          </div>
        </div>
      )}

      <PromptBox
        sessionId={`planner_${chatId}`}
        onSend={handleSend}
        disabled={sending || pending !== null}
        models={toModelInfos(models)}
        currentModel={chat?.lastModelId ?? null}
        onSetModel={changeModel}
        busy={sending && !pending}
      />
    </div>
  );
}
