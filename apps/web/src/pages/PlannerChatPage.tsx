import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlannerChat, PlannerModel, PlannerTranscriptEntry } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { Icon } from '../components/Icon.js';

interface Props {
  chatId: string;
  onBack: () => void;
  onApiError: (error: unknown) => void;
}

/**
 * PA-6, phase 2 (chat core): one planner chat.
 *
 * Deliberately plain message bubbles rather than `Transcript`/`ToolCard` —
 * those are built for the `AgentEvent` live-streaming protocol a structured
 * session uses, and this chat is request/response for now (see
 * `llm-client.ts`'s doc comment). Reusing this app's real chat UI wholesale,
 * as the reporter asked for, is the target once a later phase gives the
 * planner the same event stream to render.
 */
export function PlannerChatPage({ chatId, onBack, onApiError }: Props): JSX.Element {
  const [chat, setChat] = useState<PlannerChat | null>(null);
  const [models, setModels] = useState<PlannerModel[]>([]);
  const [entries, setEntries] = useState<PlannerTranscriptEntry[] | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
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
  }, [entries]);

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

  const send = (): void => {
    const content = input.trim();
    if (!content || sending) return;
    setSending(true);
    setError(null);
    void (async () => {
      try {
        const { userEntry, assistantEntry } = await api.sendPlannerMessage(chatId, { content });
        setEntries((prev) => [...(prev ?? []), userEntry, assistantEntry]);
        setInput('');
      } catch (err) {
        onApiError(err);
        setError(
          err instanceof ApiError
            ? err.message
            : 'Could not reach the planner. Your message was not sent.',
        );
      } finally {
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
        {entries?.length === 0 && (
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
        {sending && (
          <div className="planner-message planner-message--assistant">Thinking…</div>
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
