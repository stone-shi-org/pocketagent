import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_PLANNER_IDENTITY_PROMPT,
  type PlannerAgentMcpRegistryInfo,
  type PlannerAgentSkillInfo,
  type PlannerAgentToolInfo,
  type PlannerMemory,
  type PlannerMemoryTier,
  type PlannerModel,
  type PlannerProvider,
  type PlannerLiveProvider,
  type PlannerWorkspace,
  type PocketAgentExportData,
  type UpdatePlannerWorkspaceRequest,
} from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Icon } from '../components/Icon.js';
import { PlannerDirectoryPicker } from '../components/PlannerDirectoryPicker.js';
import { SkillExportDialog } from '../components/SkillExportDialog.js';
import { formatRelative } from '../components/StatusBadge.js';
import { useHostApi } from '../hosts/HostContext.js';
import { groupPlannerModelsByProvider, resolvePlannerModelSelection } from '../agent/planner-models.js';
import { getToolShortDescription, groupToolsByCategory } from '../agent/planner-tools-metadata.js';
import { exportToJsonFile } from '../agent/json-transfer.js';
import { useJsonImport } from '../hooks/useJsonImport.js';

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
  const api = useHostApi();
  const [agent, setAgent] = useState<PlannerWorkspace | null>(null);
  const [models, setModels] = useState<PlannerModel[]>([]);
  const [providers, setProviders] = useState<PlannerProvider[]>([]);
  const [tools, setTools] = useState<PlannerAgentToolInfo[] | null>(null);
  const [skills, setSkills] = useState<PlannerAgentSkillInfo[] | null>(null);
  const [exportingSkill, setExportingSkill] = useState<PlannerAgentSkillInfo | null>(null);
  const [mcpRegistries, setMcpRegistries] = useState<PlannerAgentMcpRegistryInfo[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [identityInput, setIdentityInput] = useState('');
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);
  const [pendingDirectory, setPendingDirectory] = useState<{ path: string; create: boolean } | null>(null);
  const [memoryTier, setMemoryTier] = useState<PlannerMemoryTier>('short');
  const [memories, setMemories] = useState<PlannerMemory[] | null>(null);
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editImportance, setEditImportance] = useState(3);
  // PA-96: whether each live-stream provider is configured on this server,
  // to decide whether the picker is worth showing at all.
  const [geminiAvailable, setGeminiAvailable] = useState(false);
  const [pipelineConfigured, setPipelineConfigured] = useState(false);

  const load = useCallback(async () => {
    try {
      const [
        { workspaces },
        { models: modelList },
        { providers: providerList },
        agentTools,
        agentSkills,
        agentMcpRegistries,
      ] = await Promise.all([
        api.listPlannerWorkspaces(),
        api.listPlannerModels(),
        api.listPlannerProviders().catch(() => ({ providers: [] as PlannerProvider[] })),
        api.listPlannerAgentTools(agentId),
        api.listPlannerAgentSkills(agentId),
        api.listPlannerAgentMcpRegistries(agentId),
      ]);
      const found = workspaces.find((w) => w.id === agentId) ?? null;
      setAgent(found);
      setNameInput(found?.name ?? '');
      setIdentityInput(found?.identityPrompt ?? '');
      setModels(modelList);
      setProviders(providerList);
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

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.getGeminiLiveSettings().catch(() => null), api.getSettings().catch(() => null)]).then(
      ([gemini, runtime]) => {
        if (cancelled) return;
        setGeminiAvailable(gemini?.available ?? false);
        setPipelineConfigured((runtime?.settings.liveSttUrl ?? '') !== '');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  /** PA-96: which live-stream implementation this agent's chats use. Trivially
      reversible; the disclosure that voice goes to Google is shown in the
      chat itself, on every visit, which is where it applies. */
  const setLiveProvider = (liveProvider: PlannerLiveProvider): void => {
    void withBusy(() => api.updatePlannerWorkspace(agentId, { liveProvider }));
  };

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

  // PA-45: this agent's own persona/capability text. Empty string saves as
  // `null` (clears it), the same "empty means unset" convention every other
  // nullable-text setting in this app uses — including the global "me"/
  // "tools" instructions on `PlannerPage`.
  const saveIdentity = (): void => {
    const trimmed = identityInput.trim();
    if (trimmed === (agent?.identityPrompt ?? '')) return;
    void withBusy(() => api.updatePlannerWorkspace(agentId, { identityPrompt: trimmed || null }));
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

  // PA-38 round 2: "a way from UI to 'promote' any skills to global in case
  // needed" — a workspace-local skill only, never a `source: 'global'` one
  // (the button is only ever rendered for the former). `withBusy` already
  // re-runs `load()`, which re-fetches this agent's own skills list, so the
  // promoted row flips from this agent's `sourceLabel` to "Global" without
  // any extra bookkeeping here.
  const promoteSkill = (skillId: string): void => {
    void withBusy(() => api.promotePlannerSkill(skillId));
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

  // Hooks must all run before the early returns below: the first render is the
  // loading one, so a hook placed after `if (!loaded) return` changes the hook
  // count between renders (React #310) and blanks the page.
  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  const handleExport = (): void => {
    if (!agent) return;
    const disabledTools = tools ? tools.filter((t) => !t.enabled).map((t) => t.name) : [];
    exportToJsonFile(
      'pocket-agent',
      {
        name: agent.name,
        defaultModelId: agent.defaultModelId,
        identityPrompt: agent.identityPrompt,
        memoryEnabled: agent.memoryEnabled,
        mcpEnabled: agent.mcpEnabled,
        disabledTools,
      },
      agent.name,
    );
  };

  const { trigger: triggerImport, fileInputProps } = useJsonImport<PocketAgentExportData>({
    expectedKind: 'pocket-agent',
    onSuccess: async ({ data: imported }) => {
      try {
        setError(null);
        setImportSuccess(null);
        setBusy(true);
        const patch: UpdatePlannerWorkspaceRequest = {
          name: imported.name,
          defaultModelId: imported.defaultModelId,
          identityPrompt: imported.identityPrompt,
          memoryEnabled: imported.memoryEnabled,
          mcpEnabled: imported.mcpEnabled,
        };
        await api.updatePlannerWorkspace(agentId, patch);
        if (imported.disabledTools && tools) {
          const disabledSet = new Set(imported.disabledTools);
          for (const t of tools) {
            const shouldEnable = !disabledSet.has(t.name);
            if (t.enabled !== shouldEnable) {
              await api.setPlannerAgentTool(agentId, { toolName: t.name, enabled: shouldEnable });
            }
          }
        }
        await load();
        setImportSuccess('Agent configuration imported successfully.');
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not import agent configuration.');
      } finally {
        setBusy(false);
      }
    },
    onError: (err) => {
      setError(err);
      setImportSuccess(null);
    },
  });

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
      <input {...fileInputProps} />
      <div className="planner-head">
        <div>
          <h2>{agent.name}</h2>
          <p className="planner-sub">
            This agent's own model, tools, and directory. Removing it lives on the agents list.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            type="button"
            className="planner-btn"
            onClick={handleExport}
            title="Export agent configuration to JSON"
          >
            <Icon name="download" size={14} />
            Export JSON
          </button>
          <button
            type="button"
            className="planner-btn"
            onClick={triggerImport}
            title="Import agent configuration from JSON"
          >
            <Icon name="upload" size={14} />
            Import JSON
          </button>
          <button type="button" className="planner-btn" onClick={onBack ?? onDone}>
            Done
          </button>
        </div>
      </div>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {importSuccess && (
        <div className="success-box" role="status">
          {importSuccess}
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
        <h3>Identity</h3>
        <p className="planner-row-meta" style={{ marginBottom: 10 }}>
          Who this agent is and what it's for — sent ahead of every turn as context, the same way
          the global "About you" and "Tools &amp; environment" text on the Pocket Agent settings
          page is. Blank until you write something; the grey text below is only a suggestion for
          the shape to fill in (e.g. "I am a release-notes specialist for the payments repo"), not
          a value that's already saved.
        </p>
        <textarea
          id="planner-agent-identity"
          value={identityInput}
          disabled={busy}
          onChange={(e) => setIdentityInput(e.target.value)}
          onBlur={saveIdentity}
          placeholder={DEFAULT_PLANNER_IDENTITY_PROMPT}
          rows={4}
          style={{ width: '100%', resize: 'vertical' }}
        />
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
          value={resolvePlannerModelSelection(models, agent.defaultModelId)}
          disabled={busy}
          onChange={(e) => setDefaultModel(e.target.value)}
          aria-label="Default model"
        >
          <option value="">Use global last-used model</option>
          {groupPlannerModelsByProvider(models, providers).map((group) =>
            group.provider ? (
              <optgroup key={group.provider.id} label={group.providerLabel}>
                {group.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {group.providerLabel} · {m.label} ({m.modelId})
                  </option>
                ))}
              </optgroup>
            ) : (
              group.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} ({m.modelId})
                </option>
              ))
            ),
          )}
        </select>
      </div>

      {(geminiAvailable || agent.liveProvider === 'gemini-live') && (
        // Shown once Gemini Live is configured (or this agent already uses
        // it, so it can always be switched back). With only the pipeline
        // there is nothing to choose between.
        <div className="planner-section">
          <h3>Live mode</h3>
          <p className="planner-row-meta" style={{ marginBottom: 10 }}>
            What answers when live mode is switched on in this agent’s chats. Gemini Live talks to you
            directly, with native barge-in, and calls this agent’s tools; your voice, the conversation
            and tool results then go to Google. Tool approvals still happen on screen here either way.
          </p>
          <select
            value={agent.liveProvider}
            disabled={busy}
            onChange={(e) => setLiveProvider(e.target.value as PlannerLiveProvider)}
            aria-label="Live mode provider"
          >
            <option value="pipeline">
              Own pipeline (live-stt + this agent’s model){pipelineConfigured ? '' : ' — not configured'}
            </option>
            <option value="gemini-live">Gemini Live{geminiAvailable ? '' : ' — no usable key'}</option>
          </select>
        </div>
      )}

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
          groupToolsByCategory(tools).map((group) => (
            <div key={group.category} className="planner-tool-group" style={{ marginBottom: 14 }}>
              <h4
                className="planner-tool-group-title"
                style={{
                  fontSize: '12.5px',
                  fontWeight: 600,
                  color: 'var(--text-dim)',
                  marginBottom: 6,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
                {group.category}
              </h4>
              {group.tools.map((t) => (
                <label key={t.name} className="planner-checkbox-row" style={{ marginBottom: 6 }} title={t.description}>
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
                    <span className="planner-row-meta"> — {getToolShortDescription(t.name, t.description)}</span>
                  </span>
                </label>
              ))}
            </div>
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
              <div className="planner-row-actions">
                {/* PA-55: the reverse of importing a project's skill, for any
                    skill this agent can see. A human action only. */}
                <button
                  type="button"
                  className="planner-btn"
                  disabled={busy}
                  onClick={() => setExportingSkill(s)}
                  title="Copy this skill into a project, so a coding-agent session there can load it."
                >
                  Export to project…
                </button>
                {s.source !== 'global' && (
                  <button
                    type="button"
                    className="planner-btn"
                    disabled={busy}
                    onClick={() => promoteSkill(s.id)}
                    title="Copy this skill into the global catalog, so every agent can load it."
                  >
                    Promote to global
                  </button>
                )}
              </div>
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

      {exportingSkill && (
        <SkillExportDialog
          skill={exportingSkill}
          onApiError={onApiError}
          onClose={() => setExportingSkill(null)}
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
