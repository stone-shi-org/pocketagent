import { useCallback, useEffect, useState } from 'react';
import type {
  PlannerChat,
  PlannerModel,
  PlannerSettingsDto,
  PlannerToolApprovalRow,
  PlannerToolInfo,
  PlannerWorkspace,
} from '@pocketagent/protocol';
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
 * PA-6: the planner's chat list, plus an inline LLM endpoint / model setup
 * and tool-safety controls (phase 5) so the feature is actually usable end
 * to end without a `curl`. A proper Settings-page section, and a chat page
 * reusing `Transcript`/`ApprovalSheet` once live streaming exists, are later
 * refinements — see PA-6.
 */
export function PlannerPage({ onOpenChat, onApiError, onBack }: Props): JSX.Element {
  const [workspaces, setWorkspaces] = useState<PlannerWorkspace[] | null>(null);
  const [models, setModels] = useState<PlannerModel[] | null>(null);
  const [chats, setChats] = useState<PlannerChat[] | null>(null);
  const [settings, setSettings] = useState<PlannerSettingsDto | null>(null);
  const [tools, setTools] = useState<PlannerToolInfo[]>([]);
  const [approvals, setApprovals] = useState<PlannerToolApprovalRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [baseUrlInput, setBaseUrlInput] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [revealedApiKey, setRevealedApiKey] = useState<string | null>(null);
  const [newModelId, setNewModelId] = useState('');
  const [newModelLabel, setNewModelLabel] = useState('');
  const [newApprovalScope, setNewApprovalScope] = useState<'global' | 'workspace'>('global');
  const [newApprovalWorkspaceId, setNewApprovalWorkspaceId] = useState('');
  const [newApprovalTool, setNewApprovalTool] = useState('');
  const [newApprovalDecision, setNewApprovalDecision] = useState<'allow' | 'deny'>('deny');

  const load = useCallback(async () => {
    try {
      const [ws, mo, ch, se, to, ap] = await Promise.all([
        api.listPlannerWorkspaces(),
        api.listPlannerModels(),
        api.listPlannerChats(),
        api.getPlannerSettings(),
        api.listPlannerTools(),
        api.listPlannerToolApprovals(),
      ]);
      setWorkspaces(ws.workspaces);
      setModels(mo.models);
      setChats(ch.chats);
      setSettings(se);
      setBaseUrlInput(se.baseUrl ?? '');
      setTools(to.tools);
      setApprovals(ap.approvals);
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

  const setYolo = (yoloEnabled: boolean): void => {
    void withBusy(() => api.updatePlannerSettings({ yoloEnabled }));
  };

  const addApproval = (): void => {
    if (!newApprovalTool) return;
    if (newApprovalScope === 'workspace' && !newApprovalWorkspaceId) return;
    void withBusy(async () => {
      await api.setPlannerToolApproval({
        scope: newApprovalScope,
        toolName: newApprovalTool,
        decision: newApprovalDecision,
        ...(newApprovalScope === 'workspace' ? { workspaceId: newApprovalWorkspaceId } : {}),
      });
      setNewApprovalTool('');
    });
  };

  const removeApproval = (id: string): void => {
    void withBusy(() => api.deletePlannerToolApproval(id));
  };

  const workspaceName = (id: string | null): string =>
    (id && workspaces?.find((w) => w.id === id)?.name) || (id ? '(deleted workspace)' : '');

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

      <div className="planner-section">
        <h3>Tool safety</h3>
        <p className="planner-row-meta" style={{ marginBottom: 10 }}>
          Read-only tools (listing workspaces/sessions, reading files/output) never ask. Tools that
          change something — sending an instruction, writing files, running a command — ask every
          time unless remembered below, or unless yolo mode is on.
        </p>

        <label className="planner-inline" style={{ marginBottom: 10 }}>
          <input
            type="checkbox"
            checked={settings?.yoloEnabled ?? false}
            onChange={(e) => setYolo(e.target.checked)}
          />
          <span>
            <strong>Yolo mode</strong> — skip approval for every tool call, always. This bypasses the
            safety net entirely; only turn it on if you mean it.
          </span>
        </label>
        {settings?.yoloEnabled && (
          <div className="error-box" role="alert">
            Yolo mode is ON. Every mutating tool call runs immediately, with no approval and nothing
            remembered.
          </div>
        )}

        <h3 style={{ marginTop: 14 }}>Remembered decisions</h3>
        {approvals.length === 0 && (
          <p className="planner-row-meta">Nothing remembered yet — decisions made in a chat, or added here, show up in this list.</p>
        )}
        {approvals.map((a) => (
          <div key={a.id} className="planner-model-row">
            <span>
              <strong>{a.decision}</strong> {a.toolName} —{' '}
              {a.scope === 'global' ? 'globally' : `workspace: ${workspaceName(a.workspaceId)}`}
            </span>
            <button
              type="button"
              className="planner-btn danger"
              disabled={busy}
              onClick={() => removeApproval(a.id)}
              aria-label="Forget this decision"
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}
        <div className="planner-inline" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <select value={newApprovalScope} onChange={(e) => setNewApprovalScope(e.target.value as 'global' | 'workspace')}>
            <option value="global">Globally</option>
            <option value="workspace">One workspace</option>
          </select>
          {newApprovalScope === 'workspace' && (
            <select value={newApprovalWorkspaceId} onChange={(e) => setNewApprovalWorkspaceId(e.target.value)}>
              <option value="">Select a workspace…</option>
              {workspaces?.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
          <select value={newApprovalTool} onChange={(e) => setNewApprovalTool(e.target.value)}>
            <option value="">Select a tool…</option>
            {tools
              .filter((t) => !t.readOnly)
              .map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
          </select>
          <select value={newApprovalDecision} onChange={(e) => setNewApprovalDecision(e.target.value as 'allow' | 'deny')}>
            <option value="deny">Always deny</option>
            <option value="allow">Always allow</option>
          </select>
          <button type="button" className="planner-btn" disabled={busy} onClick={addApproval}>
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
