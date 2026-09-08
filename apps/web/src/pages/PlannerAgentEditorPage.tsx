import { useCallback, useEffect, useState } from 'react';
import type {
  PlannerAgentMcpRegistryInfo,
  PlannerAgentSkillInfo,
  PlannerAgentToolInfo,
  PlannerMemory,
  PlannerMemoryTier,
  PlannerModel,
  PlannerWorkspace,
} from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { PlannerDirectoryPicker } from '../components/PlannerDirectoryPicker.js';
import { formatRelative } from '../components/StatusBadge.js';

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
  const [skills, setSkills] = useState<PlannerAgentSkillInfo[] | null>(null);
  const [mcpRegistries, setMcpRegistries] = useState<PlannerAgentMcpRegistryInfo[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);
  const [pendingDirectory, setPendingDirectory] = useState<{ path: string; create: boolean } | null>(null);
  const [memoryTier, setMemoryTier] = useState<PlannerMemoryTier>('short');
  const [memories, setMemories] = useState<PlannerMemory[] | null>(null);
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editImportance, setEditImportance] = useState(3);

  const load = useCallback(async () => {
    try {
      const [{ workspaces }, { models: modelList }, agentTools, agentSkills, agentMcpRegistries] =
        await Promise.all([
          api.listPlannerWorkspaces(),
          api.listPlannerModels(),
          api.listPlannerAgentTools(agentId),
          api.listPlannerAgentSkills(agentId),
          api.listPlannerAgentMcpRegistries(agentId),
        ]);
      const found = workspaces.find((w) => w.id === agentId) ?? null;
      setAgent(found);
      setNameInput(found?.name ?? '');
      setModels(modelList);
      setTools(agentTools.tools);
      setSkills(agentSkills.skills);
      setMcpRegistries(agentMcpRegistries.registries);
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

  /** PA-29 phase 4: this agent's own memories, one tier at a time — kept
      separate from `load` above so switching tiers doesn't re-fetch the
      model/tool catalogs, and so a memory edit/delete can refresh just this
      list without re-fetching everything else on the page. */
  const loadMemories = useCallback(
    async (tier: PlannerMemoryTier) => {
      try {
        const { memories: list } = await api.listPlannerMemories(agentId, tier);
        setMemories(list);
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not load memories.');
      }
    },
    [agentId, onApiError],
  );

  useEffect(() => {
    void loadMemories(memoryTier);
  }, [loadMemories, memoryTier]);

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

  const toggleSkill = (skillId: string, enabled: boolean): void => {
    void withBusy(() => api.setPlannerAgentSkill(agentId, { skillId, enabled }));
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

  // Trivially reversible (unlike the directory change above), so this is a
  // plain toggle with no `ConfirmDialog` — the standing disclosure text
  // rendered below whenever it's off is what CLAUDE.md's own "disclosed
  // persistently, not just at creation" invariant asks for instead.
  const toggleMemoryEnabled = (enabled: boolean): void => {
    void withBusy(() => api.updatePlannerWorkspace(agentId, { memoryEnabled: enabled }));
  };

  // PA-37 follow-up: this agent's own half of the whole-MCP on/off switch —
  // same trivially-reversible, no-confirmation posture as memory above. This
  // is the *only* MCP-related control on this page by design (reporter:
  // "can't change setting, but has enable/disable") — a registry's url/auth
  // stay a global, operator-only resource, edited only from the settings
  // page's own "MCP servers" section.
  const toggleMcpEnabled = (enabled: boolean): void => {
    void withBusy(() => api.updatePlannerWorkspace(agentId, { mcpEnabled: enabled }));
  };

  // PA-37 follow-up round two: per-registry, still per agent — "we can
  // globally disable bamboo mcp but allow Jira mcp. Same concept for per
  // agent base... enable/disable all AND separate enable/disable for each
  // mcp." Same `withBusy` posture as every other toggle on this page.
  const toggleMcpRegistry = (registryId: string, enabled: boolean): void => {
    void withBusy(() => api.setPlannerAgentMcpRegistry(agentId, { registryId, enabled }));
  };

  const startEditMemory = (memory: PlannerMemory): void => {
    setEditingMemoryId(memory.id);
    setEditContent(memory.content);
    setEditImportance(memory.importance);
  };

  const cancelEditMemory = (): void => {
    setEditingMemoryId(null);
  };

  const saveEditMemory = (): void => {
    const id = editingMemoryId;
    if (!id) return;
    void (async () => {
      setBusy(true);
      try {
        await api.updatePlannerMemory(id, { content: editContent, importance: editImportance });
        setEditingMemoryId(null);
        await loadMemories(memoryTier);
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not save that memory.');
      } finally {
        setBusy(false);
      }
    })();
  };

  const deleteMemory = (id: string): void => {
    void (async () => {
      setBusy(true);
      try {
        await api.deletePlannerMemory(id);
        if (editingMemoryId === id) setEditingMemoryId(null);
        await loadMemories(memoryTier);
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not delete that memory.');
      } finally {
        setBusy(false);
      }
    })();
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

      <div className="planner-section">
        <h3>Skills</h3>
        <p className="planner-row-meta" style={{ marginBottom: 10 }}>
          Restrict which skills this agent alone can load with <code>use_skill</code> — includes
          every global skill plus this agent's own <code>.skills/</code> directory. A skill
          turned off in the global "Skills" settings section is unavailable here too, same as a
          globally disabled tool.
        </p>
        {skills === null ? (
          <div className="spinner">Loading…</div>
        ) : skills.length === 0 ? (
          <p className="planner-row-meta">No skills available yet.</p>
        ) : (
          skills.map((s) => (
            <label key={s.id} className="planner-checkbox-row" style={{ marginBottom: 6 }}>
              <input
                type="checkbox"
                checked={s.enabled}
                disabled={busy || s.disabledGlobally}
                onChange={(e) => toggleSkill(s.id, e.target.checked)}
              />
              <span>
                <strong>{s.name}</strong>{' '}
                <span className="planner-row-meta">({s.sourceLabel})</span>
                {s.disabledGlobally && <span className="planner-row-meta"> — disabled globally</span>}
                <br />
                <span className="planner-row-meta">{s.description}</span>
              </span>
            </label>
          ))
        )}
      </div>

      <div className="planner-section">
        <h3>MCP</h3>
        <p className="planner-row-meta" style={{ marginBottom: 10 }}>
          Whether this agent may use MCP registries, as a whole and one at a time. A registry's own
          settings (url, auth, which servers exist) are managed globally from the Pocket Agent
          settings page's "MCP servers" section, not here — this section only ever enables or
          disables, never configures.
        </p>
        <label className="planner-checkbox-row" style={{ marginBottom: 10 }}>
          <input
            type="checkbox"
            checked={agent.mcpEnabled}
            disabled={busy}
            onChange={(e) => toggleMcpEnabled(e.target.checked)}
          />
          <span>Enable MCP for this agent</span>
        </label>
        {agent.mcpEnabled && (
          <>
            <p className="planner-row-meta" style={{ marginBottom: 8 }}>
              Restrict which MCP registries this agent alone can reach. A registry turned off
              globally on the settings page is unavailable here too, same as a globally disabled
              tool or skill.
            </p>
            {mcpRegistries === null ? (
              <div className="spinner">Loading…</div>
            ) : mcpRegistries.length === 0 ? (
              <p className="planner-row-meta">No MCP registries configured yet.</p>
            ) : (
              mcpRegistries.map((r) => (
                <label key={r.id} className="planner-checkbox-row" style={{ marginBottom: 6 }}>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    disabled={busy || r.disabledGlobally}
                    onChange={(e) => toggleMcpRegistry(r.id, e.target.checked)}
                  />
                  <span>
                    <strong>{r.name}</strong>
                    {r.disabledGlobally && <span className="planner-row-meta"> — disabled globally</span>}
                  </span>
                </label>
              ))
            )}
          </>
        )}
      </div>

      <div className="planner-section">
        <h3>Memory</h3>
        <label className="planner-checkbox-row" style={{ marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={agent.memoryEnabled}
            disabled={busy}
            onChange={(e) => toggleMemoryEnabled(e.target.checked)}
          />
          <span>Remember things across turns and chats</span>
        </label>
        {!agent.memoryEnabled && (
          <p className="planner-row-meta" style={{ marginBottom: 10 }}>
            Off: this agent will not fold anything into memory, rank memories into a turn, or run
            consolidation. Nothing already saved is deleted — turning this back on picks up right
            where it left off.
          </p>
        )}
        <p className="planner-row-meta" style={{ marginBottom: 10 }}>
          Last consolidated:{' '}
          {agent.lastConsolidatedAt ? formatRelative(agent.lastConsolidatedAt) : 'never yet'}
        </p>

        <div className="segmented" style={{ maxWidth: 220 }}>
          <button
            type="button"
            className={memoryTier === 'short' ? 'active' : ''}
            onClick={() => setMemoryTier('short')}
          >
            Short-term
          </button>
          <button
            type="button"
            className={memoryTier === 'long' ? 'active' : ''}
            onClick={() => setMemoryTier('long')}
          >
            Long-term
          </button>
        </div>

        {memories === null ? (
          <div className="spinner">Loading…</div>
        ) : memories.length === 0 ? (
          <p className="planner-row-meta">No {memoryTier === 'short' ? 'short-term' : 'long-term'} memories yet.</p>
        ) : (
          memories.map((memory) => (
            <div key={memory.id} className="planner-model-row" style={{ alignItems: 'flex-start' }}>
              {editingMemoryId === memory.id ? (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <textarea
                    value={editContent}
                    disabled={busy}
                    onChange={(e) => setEditContent(e.target.value)}
                    rows={3}
                    style={{ width: '100%', resize: 'vertical' }}
                  />
                  <div className="planner-inline">
                    <label className="planner-row-meta" htmlFor={`memory-importance-${memory.id}`}>
                      Importance
                    </label>
                    <select
                      id={`memory-importance-${memory.id}`}
                      value={editImportance}
                      disabled={busy}
                      onChange={(e) => setEditImportance(Number(e.target.value))}
                    >
                      {[1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                    <button type="button" className="planner-btn" disabled={busy} onClick={saveEditMemory}>
                      Save
                    </button>
                    <button type="button" className="planner-btn" disabled={busy} onClick={cancelEditMemory}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ overflowWrap: 'anywhere' }}>
                      {memory.content.length > 240 ? `${memory.content.slice(0, 240)}…` : memory.content}
                    </div>
                    <p className="planner-row-meta" style={{ margin: '4px 0 0' }}>
                      Importance {memory.importance} · created {formatRelative(memory.createdAt)} · last
                      accessed {formatRelative(memory.lastAccessedAt)}
                    </p>
                  </div>
                  <div className="planner-row-actions">
                    <button type="button" className="planner-btn" disabled={busy} onClick={() => startEditMemory(memory)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="planner-btn danger"
                      disabled={busy}
                      onClick={() => deleteMemory(memory.id)}
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
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
