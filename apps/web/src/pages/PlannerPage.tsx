import { useCallback, useEffect, useState } from 'react';
import type { PlannerChat, PlannerModel, PlannerSettingsDto, PlannerWorkspace } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { Icon } from '../components/Icon.js';
import { formatRelative } from '../components/StatusBadge.js';

interface Props {
  onOpenChat: (chatId: string) => void;
  onApiError: (error: unknown) => void;
  /** Present only on the phone route — see `CronJobsPage`'s identical prop for why. */
  onBack?: () => void;
}

/**
 * PA-6, phase 2 (chat core): the planner's chat list, plus an inline LLM
 * endpoint / model setup so the feature is actually usable end to end
 * without a `curl`. A proper Settings-page section, and a chat page reusing
 * `Transcript`/`ApprovalSheet` once live streaming exists, are later phases
 * — see PA-6.
 */
export function PlannerPage({ onOpenChat, onApiError, onBack }: Props): JSX.Element {
  const [workspaces, setWorkspaces] = useState<PlannerWorkspace[] | null>(null);
  const [models, setModels] = useState<PlannerModel[] | null>(null);
  const [chats, setChats] = useState<PlannerChat[] | null>(null);
  const [settings, setSettings] = useState<PlannerSettingsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [baseUrlInput, setBaseUrlInput] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [revealedApiKey, setRevealedApiKey] = useState<string | null>(null);
  const [newModelId, setNewModelId] = useState('');
  const [newModelLabel, setNewModelLabel] = useState('');

  const load = useCallback(async () => {
    try {
      const [ws, mo, ch, se] = await Promise.all([
        api.listPlannerWorkspaces(),
        api.listPlannerModels(),
        api.listPlannerChats(),
        api.getPlannerSettings(),
      ]);
      setWorkspaces(ws.workspaces);
      setModels(mo.models);
      setChats(ch.chats);
      setSettings(se);
      setBaseUrlInput(se.baseUrl ?? '');
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load the planner.');
    }
  }, [onApiError]);

  useEffect(() => {
    void load();
  }, [load]);

  const withBusy = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await action();
        await load();
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'That did not work.');
      } finally {
        setBusy(false);
      }
    },
    [load, onApiError],
  );

  const saveEndpoint = (): void => {
    void withBusy(() => api.updatePlannerSettings({ baseUrl: baseUrlInput.trim() || null }));
  };

  const saveApiKey = (): void => {
    void withBusy(async () => {
      await api.updatePlannerSettings({ apiKey: apiKeyInput });
      setApiKeyInput('');
      setRevealedApiKey(null);
    });
  };

  const reveal = (): void => {
    void withBusy(async () => {
      const { apiKey } = await api.revealPlannerApiKey();
      setRevealedApiKey(apiKey);
    });
  };

  const addModel = (): void => {
    if (!newModelId.trim() || !newModelLabel.trim()) return;
    void withBusy(async () => {
      await api.createPlannerModel({ modelId: newModelId.trim(), label: newModelLabel.trim() });
      setNewModelId('');
      setNewModelLabel('');
    });
  };

  const removeModel = (id: string): void => {
    void withBusy(() => api.deletePlannerModel(id));
  };

  const newChat = (): void => {
    void withBusy(async () => {
      const chat = await api.createPlannerChat({});
      onOpenChat(chat.id);
    });
  };

  const removeChat = (id: string): void => {
    void withBusy(() => api.deletePlannerChat(id));
  };

  return (
    <div className="planner-page">
      <div className="planner-head">
        <div>
          <h2>Planner</h2>
          <p className="planner-sub">
            A chat backed by your own LLM endpoint, with tools to drive your other sessions
            (coming in a later phase).
          </p>
        </div>
        {onBack && (
          <button type="button" className="planner-btn" onClick={onBack}>
            Close
          </button>
        )}
      </div>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <div className="planner-section">
        <h3>LLM endpoint</h3>
        <div className="planner-field">
          <label htmlFor="planner-base-url">Base URL (OpenAI-compatible)</label>
          <input
            id="planner-base-url"
            type="text"
            placeholder="https://api.openai.com/v1"
            value={baseUrlInput}
            onChange={(e) => setBaseUrlInput(e.target.value)}
          />
        </div>
        <div className="planner-inline">
          <button type="button" className="planner-btn" disabled={busy} onClick={saveEndpoint}>
            Save endpoint
          </button>
          <span className="planner-row-meta">
            {settings?.baseUrl ? 'Configured' : 'Not configured'}
          </span>
        </div>

        <div className="planner-field" style={{ marginTop: 12 }}>
          <label htmlFor="planner-api-key">API key</label>
          <input
            id="planner-api-key"
            type="password"
            placeholder={settings?.hasApiKey ? '••••••••  (leave blank to keep)' : 'sk-…'}
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
          />
        </div>
        <div className="planner-inline">
          <button type="button" className="planner-btn" disabled={busy} onClick={saveApiKey}>
            Save key
          </button>
          <button
            type="button"
            className="planner-btn"
            disabled={busy || !settings?.hasApiKey}
            onClick={reveal}
          >
            Reveal
          </button>
          <span className="planner-row-meta">
            {settings?.hasApiKey ? 'A key is configured' : 'No key configured'}
          </span>
        </div>
        {revealedApiKey && (
          <p className="planner-row-meta" style={{ marginTop: 6, wordBreak: 'break-all' }}>
            {revealedApiKey}
          </p>
        )}
      </div>

      <div className="planner-section">
        <h3>Models</h3>
        {models?.length === 0 && (
          <p className="planner-row-meta">
            No models configured yet — add at least one to start a chat.
          </p>
        )}
        {models?.map((m) => (
          <div key={m.id} className="planner-model-row">
            <span>
              {m.label} <span className="planner-row-meta">({m.modelId})</span>
            </span>
            <button
              type="button"
              className="planner-btn danger"
              disabled={busy}
              onClick={() => removeModel(m.id)}
              aria-label={`Remove ${m.label}`}
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}
        <div className="planner-inline" style={{ marginTop: 10 }}>
          <input
            type="text"
            placeholder="Model id, e.g. gpt-4o-mini"
            value={newModelId}
            onChange={(e) => setNewModelId(e.target.value)}
          />
          <input
            type="text"
            placeholder="Label, e.g. Fast"
            value={newModelLabel}
            onChange={(e) => setNewModelLabel(e.target.value)}
          />
          <button type="button" className="planner-btn" disabled={busy} onClick={addModel}>
            <Icon name="plus" size={14} /> Add
          </button>
        </div>
      </div>

      <div className="planner-head" style={{ marginTop: 6 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Chats</h3>
        <button type="button" className="planner-new" disabled={busy} onClick={newChat}>
          <Icon name="compose" size={16} />
          New chat
        </button>
      </div>

      {chats === null && <div className="spinner">Loading…</div>}
      {chats?.length === 0 && (
        <div className="planner-empty">
          No planner chats yet. Start one with the button above — it will run in your{' '}
          {workspaces?.find((w) => w.isDefault)?.name ?? 'default'} workspace unless you pick another.
        </div>
      )}
      {chats?.map((chat) => (
        <div key={chat.id} className="planner-row">
          <button type="button" className="planner-main" onClick={() => onOpenChat(chat.id)}>
            <span className="planner-row-title">{chat.title ?? 'Untitled chat'}</span>
            <span className="planner-row-meta">
              {chat.workspaceName} · {formatRelative(chat.lastActivityAt)}
            </span>
          </button>
          <button
            type="button"
            className="planner-btn danger"
            disabled={busy}
            onClick={() => removeChat(chat.id)}
            aria-label="Delete chat"
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
