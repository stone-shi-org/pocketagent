import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  PlannerChat,
  PlannerModel,
  PlannerToolApprovalChoice,
  PlannerTranscriptEntry,
  PlannerTurnResult,
} from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { Icon } from '../components/Icon.js';

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
 * PA-6: one planner chat.
 *
 * Deliberately plain message bubbles rather than `Transcript`/`ToolCard` —
 * those are built for the `AgentEvent` live-streaming protocol a structured
 * session uses, and this chat is request/response for now (see
 * `llm-client.ts`'s doc comment). Reusing this app's real chat UI wholesale,
 * as the reporter asked for, is the target once a later phase gives the
 * planner the same event stream to render.
 *
 * The inline approval card (PA-6 phase 4) is this page's own, equally
 * deliberately plain, stand-in for `ApprovalSheet` — a mutating tool call
 * with no remembered decision pauses the turn and this page renders the
 * pause as a card in the message list, with the same "once / remember for
 * this workspace / remember globally / deny" choices as the real approval
 * sheet, resolved via `POST .../approvals/:id` (`planner/approval.ts`).
 */
export function PlannerChatPage({ chatId, onBack, onApiError }: Props): JSX.Element {
  const [chat, setChat] = useState<PlannerChat | null>(null);
  const [models, setModels] = useState<PlannerModel[]>([]);
  const [entries, setEntries] = useState<PlannerTranscriptEntry[] | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [entries, pending]);

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

  const send = (): void => {
    const content = input.trim();
    if (!content || sending) return;
    setSending(true);
    setError(null);
    void (async () => {
      try {
        const { userEntry, turn } = await api.sendPlannerMessage(chatId, { content });
        setEntries((prev) => [...(prev ?? []), userEntry]);
        setInput('');
        applyTurn(turn);
      } catch (err) {
        onApiError(err);
        setError(
          err instanceof ApiError
            ? err.message
            : 'Could not reach the planner. Your message was not sent.',
        );
        setSending(false);
      }
    })();
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

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="planner-chat-page">
      <div className="planner-chat-header">
        <button type="button" className="planner-btn" onClick={onBack} aria-label="Back">
          <Icon name="chevron-left" size={16} />
        </button>
        <span className="planner-chat-title">{chat?.title ?? 'Untitled chat'}</span>
        <select
          value={chat?.lastModelId ?? ''}
          onChange={(e) => changeModel(e.target.value)}
          aria-label="Model"
        >
          <option value="" disabled>
            Select a model…
          </option>
          {models.map((m) => (
            <option key={m.id} value={m.modelId}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <div className="planner-messages" ref={messagesRef}>
        {entries === null && <div className="spinner">Loading…</div>}
        {entries?.length === 0 && !pending && (
          <div className="planner-empty">Say something to get started.</div>
        )}
        {entries?.map((entry, i) => (
          <div
            key={i}
            className={`planner-message planner-message--${entry.role}`}
          >
            {entry.content}
          </div>
        ))}
        {sending && !pending && (
          <div className="planner-message planner-message--assistant">Thinking…</div>
        )}
        {pending && (
          <div className="planner-approval-card" role="alertdialog" aria-label="Tool approval">
            <p className="planner-approval-title">
              The planner wants to run <code>{pending.toolName}</code>
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
      </div>

      <div className="planner-composer">
        <textarea
          rows={1}
          placeholder="Message the planner…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={sending}
        />
        <button
          type="button"
          className="planner-new"
          disabled={sending || input.trim().length === 0}
          onClick={send}
          aria-label="Send"
        >
          <Icon name="arrow-up" size={16} />
        </button>
      </div>
    </div>
  );
}
