import { useCallback, useEffect, useState } from 'react';
import type {
  PlannerModel,
  PlannerSettingsDto,
  PlannerToolApprovalRow,
  PlannerToolInfo,
  PlannerWorkspace,
  TestPlannerModelResponse,
} from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { Icon } from '../components/Icon.js';

interface Props {
  onApiError: (error: unknown) => void;
  /** Present only on the phone route — see `CronJobsPage`'s identical prop for why. */
  onBack?: () => void;
}

/**
 * PA-6: settings for Pocket Agent — the LLM endpoint/API key, the model
 * catalog, agent management (rename, add, remove — see
 * `PocketAgentsSection` for where the chats themselves now live), and tool
 * safety controls. Chats moved to the home screen's own "Pocket Agents"
 * section per the reporter's feedback that they belonged there, not behind
 * a menu item — this page is purely configuration now, the same split
 * "Projects" already draws between browsing chats and managing folders.
 */
export function PlannerPage({ onApiError, onBack }: Props): JSX.Element {
  const [workspaces, setWorkspaces] = useState<PlannerWorkspace[] | null>(null);
  const [models, setModels] = useState<PlannerModel[] | null>(null);
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
  const [renamingAgent, setRenamingAgent] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [newAgentName, setNewAgentName] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [discoverMessage, setDiscoverMessage] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, TestPlannerModelResponse | 'testing'>>({});

  const load = useCallback(async () => {
    try {
      const [ws, mo, se, to, ap] = await Promise.all([
        api.listPlannerWorkspaces(),
        api.listPlannerModels(),
        api.getPlannerSettings(),
        api.listPlannerTools(),
        api.listPlannerToolApprovals(),
      ]);
      setWorkspaces(ws.workspaces);
      setModels(mo.models);
      setSettings(se);
      setBaseUrlInput(se.baseUrl ?? '');
      setTools(to.tools);
      setApprovals(ap.approvals);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load Pocket Agent settings.');
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

  /** Queries the configured endpoint's own `/models` and adds a row (label =
      id) for every one not already in the catalog — never touches or removes
      an existing row, so a model renamed locally never gets clobbered by
      re-running this. */
  const discoverModels = (): void => {
    setDiscovering(true);
    setDiscoverMessage(null);
    void (async () => {
      try {
        const { modelIds } = await api.discoverPlannerModels();
        const existingIds = new Set((models ?? []).map((m) => m.modelId));
        const toAdd = modelIds.filter((id) => !existingIds.has(id));
        for (const modelId of toAdd) {
          await api.createPlannerModel({ modelId, label: modelId });
        }
        await load();
        setDiscoverMessage(
          toAdd.length > 0
            ? `Added ${toAdd.length} new model${toAdd.length === 1 ? '' : 's'} (${modelIds.length} found, ${
                modelIds.length - toAdd.length
              } already configured).`
            : `No new models — all ${modelIds.length} found ${modelIds.length === 1 ? 'is' : 'are'} already configured.`,
        );
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not query models from the endpoint.');
      } finally {
        setDiscovering(false);
      }
    })();
  };

  /** Shared by the per-row "Test" button and "Test all" — a promise so
      "test all" can run every model concurrently and await the lot. */
  const runModelTest = async (id: string): Promise<void> => {
    setTestResults((prev) => ({ ...prev, [id]: 'testing' }));
    try {
      const result = await api.testPlannerModel(id);
      setTestResults((prev) => ({ ...prev, [id]: result }));
    } catch (err) {
      onApiError(err);
      setTestResults((prev) => ({
        ...prev,
        [id]: {
          ok: false,
          message: err instanceof ApiError ? err.message : 'Test failed.',
          latencyMs: 0,
        },
      }));
    }
  };

  const testModel = (id: string): void => {
    void runModelTest(id);
  };

  const testAllModels = (): void => {
    if (!models || models.length === 0) return;
    setTestingAll(true);
    void Promise.all(models.map((m) => runModelTest(m.id))).finally(() => setTestingAll(false));
  };

  const startRenameAgent = (ws: PlannerWorkspace): void => {
    setRenamingAgent(ws.id);
    setRenameValue(ws.name);
  };

  const saveRenameAgent = (): void => {
    const id = renamingAgent;
    const name = renameValue.trim();
    setRenamingAgent(null);
    if (!id || !name) return;
    void withBusy(() => api.renamePlannerWorkspace(id, name));
  };

  const addAgent = (): void => {
    const name = newAgentName.trim();
    if (!name) return;
    void withBusy(async () => {
      await api.createPlannerWorkspace(name);
      setNewAgentName('');
    });
  };

  const removeAgent = (id: string): void => {
    void withBusy(() => api.deletePlannerWorkspace(id));
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
          <h2>Pocket Agent settings</h2>
          <p className="planner-sub">
            LLM endpoint, models, agents, and tool safety. Chats themselves live in the "Pocket
            Agents" section on the home screen.
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
        <div className="planner-section-header">
          <h3>Models</h3>
          <div className="planner-section-actions">
            <button
              type="button"
              className="planner-btn"
              disabled={discovering || !settings?.baseUrl}
              onClick={discoverModels}
              title={settings?.baseUrl ? undefined : 'Set an endpoint URL first.'}
            >
              {discovering ? 'Querying…' : 'Query models'}
            </button>
            <button
              type="button"
              className="planner-btn"
              disabled={testingAll || !models || models.length === 0}
              onClick={testAllModels}
            >
              {testingAll ? 'Testing…' : 'Test all'}
            </button>
          </div>
        </div>
        {discoverMessage && <p className="planner-row-meta">{discoverMessage}</p>}
        {models?.length === 0 && (
          <p className="planner-row-meta">
            No models configured yet — add one below, or query the endpoint above.
          </p>
        )}
        {models?.map((m) => {
          const result = testResults[m.id];
          return (
            <div key={m.id} className="planner-model-row">
              <span>
                {m.label} <span className="planner-row-meta">({m.modelId})</span>
                {result === 'testing' && <span className="planner-row-meta"> — testing…</span>}
                {result && result !== 'testing' && (
                  <span className={result.ok ? 'planner-test-ok' : 'planner-test-fail'}>
                    {' '}
                    — {result.ok ? `OK (${result.latencyMs}ms)` : 'Failed'}: {result.message}
                  </span>
                )}
              </span>
              <div className="planner-row-actions">
                <button
                  type="button"
                  className="planner-btn"
                  disabled={result === 'testing' || testingAll}
                  onClick={() => testModel(m.id)}
                >
                  Test
                </button>
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
            </div>
          );
        })}
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

        <label className="planner-checkbox-row" style={{ marginBottom: 10 }}>
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

      <div className="planner-section">
        <h3>Agents</h3>
        <p className="planner-row-meta" style={{ marginBottom: 10 }}>
          Each agent has its own name, its own scratch directory, and its own chats — see "Pocket
          Agents" on the home screen. All agents share the LLM endpoint and models configured above.
        </p>
        {workspaces === null && <div className="spinner">Loading…</div>}
        {workspaces?.map((ws) => (
          <div key={ws.id} className="planner-model-row">
            {renamingAgent === ws.id ? (
              <input
                autoFocus
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={saveRenameAgent}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveRenameAgent();
                  if (e.key === 'Escape') setRenamingAgent(null);
                }}
              />
            ) : (
              <span>
                {ws.name}
                {ws.isDefault && <span className="planner-row-meta"> (default)</span>}
              </span>
            )}
            <div className="planner-inline">
              <button
                type="button"
                className="planner-btn"
                disabled={busy}
                onClick={() => startRenameAgent(ws)}
                aria-label={`Rename ${ws.name}`}
              >
                Rename
              </button>
              {!ws.isDefault && (
                <button
                  type="button"
                  className="planner-btn danger"
                  disabled={busy}
                  onClick={() => removeAgent(ws.id)}
                  aria-label={`Remove ${ws.name}`}
                >
                  <Icon name="trash" size={14} />
                </button>
              )}
            </div>
          </div>
        ))}
        <div className="planner-inline" style={{ marginTop: 10 }}>
          <input
            type="text"
            placeholder="New agent name"
            value={newAgentName}
            onChange={(e) => setNewAgentName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addAgent();
            }}
          />
          <button type="button" className="planner-btn" disabled={busy} onClick={addAgent}>
            <Icon name="plus" size={14} /> Add agent
          </button>
        </div>
      </div>
    </div>
  );
}
