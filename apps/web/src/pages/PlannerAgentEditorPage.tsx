import { useCallback, useEffect, useState } from 'react';
import type { PlannerAgentToolInfo, PlannerModel, PlannerWorkspace } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { PlannerDirectoryPicker } from '../components/PlannerDirectoryPicker.js';

interface Props {
  /** Always an existing agent's id — creating a new one is still
      `PlannerPage`'s own quick inline form, not this page. */
  agentId: string;
  onApiError: (error: unknown) => void;
  onDone: () => void;
  onBack?: () => void;
}

/**
 * One agent's own configuration, pulled out of `PlannerPage`'s inline rows
 * into its own page (PA-6 round 5: "once user click edit, it will open a
 * new page of agent configure, you can change name, models, tools
 * available, workspace directory, etc"). `PlannerPage`'s Agents list keeps
 * only name/path plus Edit (here) and Delete (its own confirm dialog,
 * staying in the list rather than moving here).
 *
 * Every field auto-saves on change, the same "no explicit Save button"
 * convention `PlannerPage`'s own settings already use — except the
 * directory, which pauses on a `ConfirmDialog` first: repointing an agent
 * is the one change here with a real, easy-to-miss consequence (see
 * `PlannerWorkspaceRegistry.setPath`'s doc comment), so it gets a deliberate
 * second step the others don't need.
 */
export function PlannerAgentEditorPage({ agentId, onApiError, onDone, onBack }: Props): JSX.Element {
  const [agent, setAgent] = useState<PlannerWorkspace | null>(null);
  const [models, setModels] = useState<PlannerModel[]>([]);
  const [tools, setTools] = useState<PlannerAgentToolInfo[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);
  const [pendingDirectory, setPendingDirectory] = useState<{ path: string; create: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ workspaces }, { models: modelList }, agentTools] = await Promise.all([
        api.listPlannerWorkspaces(),
        api.listPlannerModels(),
        api.listPlannerAgentTools(agentId),
      ]);
      const found = workspaces.find((w) => w.id === agentId) ?? null;
      setAgent(found);
      setNameInput(found?.name ?? '');
      setModels(modelList);
      setTools(agentTools.tools);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load this agent.');
    } finally {
      setLoaded(true);
    }
  }, [agentId, onApiError]);

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

  const saveName = (): void => {
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === agent?.name) return;
    void withBusy(() => api.updatePlannerWorkspace(agentId, { name: trimmed }));
  };

  const setDefaultModel = (modelId: string): void => {
    void withBusy(() => api.updatePlannerWorkspace(agentId, { defaultModelId: modelId || null }));
  };

  const toggleTool = (toolName: string, enabled: boolean): void => {
    void withBusy(() => api.setPlannerAgentTool(agentId, { toolName, enabled }));
  };

  const pickDirectory = (path: string, opts?: { create?: boolean }): void => {
    setPendingDirectory({ path, create: opts?.create ?? false });
    setShowDirectoryPicker(false);
  };

  const confirmDirectoryChange = (): void => {
    if (!pendingDirectory) return;
    void withBusy(() =>
      api.updatePlannerWorkspace(agentId, { path: pendingDirectory.path, createPath: pendingDirectory.create }),
    );
    setPendingDirectory(null);
  };

  if (!loaded) {
    return (
      <div className="planner-page">
        <div className="spinner">Loading…</div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="planner-page">
        <div className="planner-head">
          <h2>Agent not found</h2>
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
      </div>
    );
  }

  return (
    <div className="planner-page">
      <div className="planner-head">
        <div>
          <h2>{agent.name}</h2>
          <p className="planner-sub">
            This agent's own model, tools, and directory. Removing it lives on the agents list.
          </p>
        </div>
        <button type="button" className="planner-btn" onClick={onBack ?? onDone}>
          Done
        </button>
      </div>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <div className="planner-section">
        <h3>Name</h3>
        <div className="planner-inline">
          <input
            id="planner-agent-name"
            type="text"
            value={nameInput}
            disabled={busy}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
        </div>
      </div>

      <div className="planner-section">
        <h3>Directory</h3>
        <p className="planner-row-meta" style={{ marginBottom: 10, wordBreak: 'break-all' }}>
          <code>{agent.path}</code>
        </p>
        <button type="button" className="planner-btn" disabled={busy} onClick={() => setShowDirectoryPicker(true)}>
          Change directory…
        </button>
      </div>

      <div className="planner-section">
        <h3>Default model</h3>
        <p className="planner-row-meta" style={{ marginBottom: 10 }}>
          Seeds a new chat created in this agent. Existing chats keep whatever model they already
          picked.
        </p>
        <select
          value={agent.defaultModelId ?? ''}
          disabled={busy}
          onChange={(e) => setDefaultModel(e.target.value)}
          aria-label="Default model"
        >
          <option value="">Use global last-used model</option>
          {models.map((m) => (
            <option key={m.id} value={m.modelId}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <div className="planner-section">
        <h3>Tools</h3>
        <p className="planner-row-meta" style={{ marginBottom: 10 }}>
          Restrict what this agent alone can call. A tool turned off in the global "Tools" settings
          section is unavailable here too — its checkbox is greyed out rather than let you flip it
          back on for just this agent.
        </p>
        {tools === null ? (
          <div className="spinner">Loading…</div>
        ) : (
          tools.map((t) => (
            <label key={t.name} className="planner-checkbox-row" style={{ marginBottom: 6 }}>
              <input
                type="checkbox"
                checked={t.enabled}
                disabled={busy || t.disabledGlobally}
                onChange={(e) => toggleTool(t.name, e.target.checked)}
              />
              <span>
                <code>{t.name}</code>
                {t.readOnly && <span className="planner-row-meta"> (read-only)</span>}
                {t.disabledGlobally && <span className="planner-row-meta"> — disabled globally</span>}
                <br />
                <span className="planner-row-meta">{t.description}</span>
              </span>
            </label>
          ))
        )}
      </div>

      {showDirectoryPicker && (
        <PlannerDirectoryPicker
          onClose={() => setShowDirectoryPicker(false)}
          onPick={pickDirectory}
          onApiError={onApiError}
        />
      )}

      {pendingDirectory && (
        <ConfirmDialog
          title="Change this agent's directory?"
          body={
            `This agent will start reading and writing under ${pendingDirectory.path} from now on. ` +
            "Chats it already has keep their history right where it is, on disk, under the directory " +
            "you're moving away from — but this agent will no longer show it, since it only looks at " +
            "wherever it's currently pointed. Nothing is deleted."
          }
          confirmLabel={busy ? 'Changing…' : 'Change directory'}
          busy={busy}
          onConfirm={confirmDirectoryChange}
          onCancel={() => setPendingDirectory(null)}
        />
      )}
    </div>
  );
}
