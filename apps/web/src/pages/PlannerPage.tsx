import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_PLANNER_STARTER_PROMPTS } from '@pocketagent/protocol';
import type {
  PlannerSettingsDto,
  PlannerStarterPrompt,
  PlannerToolApprovalRow,
  PlannerToolInfo,
  PlannerWorkspace,
  PocketAgentExportData,
  TestPlannerUrlFetchResponse,
  TestPlannerWebSearchResponse,
} from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Icon } from '../components/Icon.js';
import { PlannerDirectoryPicker } from '../components/PlannerDirectoryPicker.js';
import { McpRegistriesSection } from '../components/McpRegistriesSection.js';
import { SkillsSection } from '../components/SkillsSection.js';
import { StarterPromptsEditor } from '../components/StarterPromptsEditor.js';
import { useHostApi } from '../hosts/HostContext.js';
import { getToolShortDescription, groupToolsByCategory } from '../agent/planner-tools-metadata.js';
import { exportToJsonFile } from '../agent/json-transfer.js';
import { useJsonImport } from '../hooks/useJsonImport.js';

export { computeModelSuggestions, ModelLabelEditor } from './ProvidersAndModelsPage.js';

interface Props {
  onApiError: (error: unknown) => void;
  /** Present only on the phone route — see `CronJobsPage`'s identical prop for why. */
  onBack?: () => void;
  /** Opens an existing agent's own editor (`PlannerAgentEditorPage`) — name,
      default model, tool subset, directory. */
  onOpenAgent: (agentId: string) => void;
}

/**
 * PA-6 / PA-132: settings for Pocket Agent — agent management (rename, add,
 * remove — see `PocketAgentsSection` for where the chats themselves live),
 * global context instructions, embedding/search/fetch tool providers, MCP
 * servers, skills, and tool safety controls. The LLM endpoint, model catalog,
 * and Gemini Live moved to `ProvidersAndModelsPage` in PA-132.
 */
export function PlannerPage({ onApiError, onBack, onOpenAgent }: Props): JSX.Element {
  const api = useHostApi();
  const [workspaces, setWorkspaces] = useState<PlannerWorkspace[] | null>(null);
  const [settings, setSettings] = useState<PlannerSettingsDto | null>(null);
  const [tools, setTools] = useState<PlannerToolInfo[]>([]);
  const [approvals, setApprovals] = useState<PlannerToolApprovalRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // PA-31: the web_search/url_fetch tools' own providers.
  const [webSearchBaseUrlInput, setWebSearchBaseUrlInput] = useState('');
  const [webSearchApiKeyInput, setWebSearchApiKeyInput] = useState('');
  const [urlFetchBaseUrlInput, setUrlFetchBaseUrlInput] = useState('');
  const [urlFetchApiKeyInput, setUrlFetchApiKeyInput] = useState('');
  const [testingWebSearch, setTestingWebSearch] = useState(false);
  const [webSearchTestResult, setWebSearchTestResult] = useState<TestPlannerWebSearchResponse | null>(null);
  const [testingUrlFetch, setTestingUrlFetch] = useState(false);
  const [urlFetchTestResult, setUrlFetchTestResult] = useState<TestPlannerUrlFetchResponse | null>(null);
  const [newApprovalScope, setNewApprovalScope] = useState<'global' | 'workspace'>('global');
  const [newApprovalWorkspaceId, setNewApprovalWorkspaceId] = useState('');
  const [newApprovalTool, setNewApprovalTool] = useState('');
  const [newApprovalDecision, setNewApprovalDecision] = useState<'allow' | 'deny'>('deny');
  const [newAgentName, setNewAgentName] = useState('');
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);
  const [newAgentPath, setNewAgentPath] = useState<{ path: string; create: boolean } | null>(null);
  const [confirmingDeleteAgent, setConfirmingDeleteAgent] = useState<PlannerWorkspace | null>(null);
  // PA-45: the global "me"/"tools" context instructions, folded into every
  // agent's turn — see `PlannerSettingsDto.meInstruction`'s doc comment.
  const [meInstructionInput, setMeInstructionInput] = useState('');
  const [toolsInstructionInput, setToolsInstructionInput] = useState('');
  // Mirrors `meInstructionInput`'s local-state-plus-save-on-blur shape —
  // see `PlannerSettingsDto.maxToolIterations`'s doc comment.
  const [maxToolIterationsInput, setMaxToolIterationsInput] = useState('20');
  // PA-74: see `PlannerSettingsDto.maxSubagentSpawnsPerTurn`'s doc comment.
  const [maxSubagentSpawnsPerTurnInput, setMaxSubagentSpawnsPerTurnInput] = useState('3');
  // PA-95: see `PlannerSettingsDto.commandTimeoutSeconds`'s doc comment.
  const [commandTimeoutSecondsInput, setCommandTimeoutSecondsInput] = useState('300');
  // PA-121: see `PlannerSettingsDto.llmIdleTimeoutSeconds` / `.compactionEnabled`.
  const [llmIdleTimeoutSecondsInput, setLlmIdleTimeoutSecondsInput] = useState('300');
  const [compactionReserveTokensInput, setCompactionReserveTokensInput] = useState('16384');
  const [compactionKeepRecentTokensInput, setCompactionKeepRecentTokensInput] = useState('20000');
  // PA-137: see `PlannerSettingsDto.attachmentInlineTextMaxBytes`.
  const [inlineTextKbInput, setInlineTextKbInput] = useState('32');
  const [inlineExtractTokensInput, setInlineExtractTokensInput] = useState('8000');

  const load = useCallback(async () => {
    try {
      const [ws, se, to, ap] = await Promise.all([
        api.listPlannerWorkspaces(),
        api.getPlannerSettings(),
        api.listPlannerTools(),
        api.listPlannerToolApprovals(),
      ]);
      setWorkspaces(ws.workspaces);
      setSettings(se);
      setWebSearchBaseUrlInput(se.webSearchBaseUrl ?? '');
      setUrlFetchBaseUrlInput(se.urlFetchBaseUrl ?? '');
      setMeInstructionInput(se.meInstruction ?? '');
      setToolsInstructionInput(se.toolsInstruction ?? '');
      setMaxToolIterationsInput(String(se.maxToolIterations));
      setMaxSubagentSpawnsPerTurnInput(String(se.maxSubagentSpawnsPerTurn ?? 3));
      setCommandTimeoutSecondsInput(String(se.commandTimeoutSeconds ?? 300));
      setLlmIdleTimeoutSecondsInput(String(se.llmIdleTimeoutSeconds ?? 300));
      setCompactionReserveTokensInput(String(se.compactionReserveTokens ?? 16384));
      setCompactionKeepRecentTokensInput(String(se.compactionKeepRecentTokens ?? 20000));
      setInlineTextKbInput(String(Math.round((se.attachmentInlineTextMaxBytes ?? 32768) / 1024)));
      setInlineExtractTokensInput(String(se.attachmentInlineExtractMaxTokens ?? 8000));
      setTools(to.tools);
      setApprovals(ap.approvals);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load Pocket Agent settings.');
    }
  }, [api, onApiError]);

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

  // PA-45 (reporter: "add 'me' instruction ... whenever agent need have
  // context of myself" / "add 'tools' instruction, for environment
  // settings"): global, not per-agent — folded into every agent's turn
  // alongside that agent's own `identityPrompt` (see
  // `buildPersonaSystemMessage`). Empty string saves as `null`.
  const saveMeInstruction = (): void => {
    void withBusy(() => api.updatePlannerSettings({ meInstruction: meInstructionInput.trim() || null }));
  };

  // The global starter chips. `null` resets to the built-in defaults.
  const saveStarterPrompts = (starterPrompts: PlannerStarterPrompt[] | null): void => {
    void withBusy(() => api.updatePlannerSettings({ starterPrompts }));
  };

  const saveToolsInstruction = (): void => {
    void withBusy(() =>
      api.updatePlannerSettings({ toolsInstruction: toolsInstructionInput.trim() || null }),
    );
  };

  // How many tool-call iterations one turn may make before it gives up
  // rather than looping forever — see `PlannerSettingsDto.maxToolIterations`'s
  // doc comment. Clamped client-side to the same `[1, 200]` range the server
  // schema enforces so a bad value never round-trips as a 400; an unparsable
  // or out-of-range value falls back to the last known-good setting instead
  // of silently sending something the server would reject.
  const saveMaxToolIterations = (): void => {
    const parsed = Number(maxToolIterationsInput);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
      setMaxToolIterationsInput(String(settings?.maxToolIterations ?? 20));
      return;
    }
    void withBusy(() => api.updatePlannerSettings({ maxToolIterations: parsed }));
  };

  // PA-74: How many subagents a single turn may spawn before refusing further
  // spawns — see `PlannerSettingsDto.maxSubagentSpawnsPerTurn`'s doc comment.
  // Clamped client-side to `[1, 50]`.
  const saveMaxSubagentSpawnsPerTurn = (): void => {
    const parsed = Number(maxSubagentSpawnsPerTurnInput);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
      setMaxSubagentSpawnsPerTurnInput(String(settings?.maxSubagentSpawnsPerTurn ?? 3));
      return;
    }
    void withBusy(() => api.updatePlannerSettings({ maxSubagentSpawnsPerTurn: parsed }));
  };

  // PA-95: How many seconds a planner shell command (bash/exec_command) may run
  // before being killed — see `PlannerSettingsDto.commandTimeoutSeconds`'s doc comment.
  // Clamped client-side to `[1, 3600]`.
  const saveCommandTimeoutSeconds = (): void => {
    const parsed = Number(commandTimeoutSecondsInput);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3600) {
      setCommandTimeoutSecondsInput(String(settings?.commandTimeoutSeconds ?? 300));
      return;
    }
    void withBusy(() => api.updatePlannerSettings({ commandTimeoutSeconds: parsed }));
  };

  // PA-121: the LLM stream idle timeout and the two compaction budgets — the
  // same clamp-client-side-or-revert shape as the three fields above, with
  // each field's range taken from the server schema.
  const saveBoundedInt = (
    raw: string,
    min: number,
    max: number,
    revert: () => void,
    patch: (n: number) => Parameters<typeof api.updatePlannerSettings>[0],
  ): void => {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      revert();
      return;
    }
    void withBusy(() => api.updatePlannerSettings(patch(parsed)));
  };
  const saveLlmIdleTimeoutSeconds = (): void =>
    saveBoundedInt(
      llmIdleTimeoutSecondsInput,
      0,
      3600,
      () => setLlmIdleTimeoutSecondsInput(String(settings?.llmIdleTimeoutSeconds ?? 300)),
      (n) => ({ llmIdleTimeoutSeconds: n }),
    );
  const saveCompactionReserveTokens = (): void =>
    saveBoundedInt(
      compactionReserveTokensInput,
      1024,
      1_000_000,
      () => setCompactionReserveTokensInput(String(settings?.compactionReserveTokens ?? 16384)),
      (n) => ({ compactionReserveTokens: n }),
    );
  const saveCompactionKeepRecentTokens = (): void =>
    saveBoundedInt(
      compactionKeepRecentTokensInput,
      1024,
      1_000_000,
      () => setCompactionKeepRecentTokensInput(String(settings?.compactionKeepRecentTokens ?? 20000)),
      (n) => ({ compactionKeepRecentTokens: n }),
    );
  // PA-137: the text cap is edited in KB and saved in bytes.
  const saveInlineTextKb = (): void =>
    saveBoundedInt(
      inlineTextKbInput,
      0,
      256,
      () => setInlineTextKbInput(String(Math.round((settings?.attachmentInlineTextMaxBytes ?? 32768) / 1024))),
      (n) => ({ attachmentInlineTextMaxBytes: n * 1024 }),
    );
  const saveInlineExtractTokens = (): void =>
    saveBoundedInt(
      inlineExtractTokensInput,
      0,
      64_000,
      () => setInlineExtractTokensInput(String(settings?.attachmentInlineExtractMaxTokens ?? 8000)),
      (n) => ({ attachmentInlineExtractMaxTokens: n }),
    );
  const setCompactionEnabled = (enabled: boolean): void => {
    void withBusy(() => api.updatePlannerSettings({ compactionEnabled: enabled }));
  };

  /**
   * PA-31: `web_search`'s own provider — off by default and inert until
   * both a base URL is saved and the switch is on, mirroring
   * `CreateCronJobRequest.skipPermissions`'s "consequential default is an
   * explicit, separate act" reasoning. No reveal button, unlike the chat/
   * embedding keys: this key is never shown back once saved, the same
   * posture `CustomClaudeProvidersSection` takes for its own key.
   */
  const saveWebSearchEndpoint = (): void => {
    void withBusy(() => api.updatePlannerSettings({ webSearchBaseUrl: webSearchBaseUrlInput.trim() || null }));
  };

  const saveWebSearchApiKey = (): void => {
    void withBusy(async () => {
      await api.updatePlannerSettings({ webSearchApiKey: webSearchApiKeyInput });
      setWebSearchApiKeyInput('');
    });
  };

  const setWebSearchEnabled = (enabled: boolean): void => {
    void withBusy(() => api.updatePlannerSettings({ webSearchEnabled: enabled }));
  };

  /** `url_fetch`'s own provider — same shape, one layer down; deliberately
      a separate provider from `web_search`'s (a search index and a
      page-fetch/scrape service are different products). */
  const saveUrlFetchEndpoint = (): void => {
    void withBusy(() => api.updatePlannerSettings({ urlFetchBaseUrl: urlFetchBaseUrlInput.trim() || null }));
  };

  const saveUrlFetchApiKey = (): void => {
    void withBusy(async () => {
      await api.updatePlannerSettings({ urlFetchApiKey: urlFetchApiKeyInput });
      setUrlFetchApiKeyInput('');
    });
  };

  const setUrlFetchEnabled = (enabled: boolean): void => {
    void withBusy(() => api.updatePlannerSettings({ urlFetchEnabled: enabled }));
  };

  /** PA-31 (reporter: "let's add test button to run a test search and test
      fetch"): mirrors `testEmbeddings` exactly — round-trips one canned
      request through the server, which reuses the *exact* helper the real
      tool call goes through, so a green result here is a genuine guarantee
      the tool itself will work. */
  const testWebSearch = (): void => {
    setTestingWebSearch(true);
    setWebSearchTestResult(null);
    void (async () => {
      try {
        setWebSearchTestResult(await api.testPlannerWebSearch());
      } catch (err) {
        onApiError(err);
        setWebSearchTestResult({
          ok: false,
          message: err instanceof ApiError ? err.message : 'Test failed.',
          latencyMs: 0,
        });
      } finally {
        setTestingWebSearch(false);
      }
    })();
  };

  const testUrlFetch = (): void => {
    setTestingUrlFetch(true);
    setUrlFetchTestResult(null);
    void (async () => {
      try {
        setUrlFetchTestResult(await api.testPlannerUrlFetch());
      } catch (err) {
        onApiError(err);
        setUrlFetchTestResult({
          ok: false,
          message: err instanceof ApiError ? err.message : 'Test failed.',
          latencyMs: 0,
        });
      } finally {
        setTestingUrlFetch(false);
      }
    })();
  };

  const addAgent = (): void => {
    const name = newAgentName.trim();
    if (!name) return;
    void withBusy(async () => {
      await api.createPlannerWorkspace(
        name,
        newAgentPath ? { path: newAgentPath.path, createPath: newAgentPath.create } : undefined,
      );
      setNewAgentName('');
      setNewAgentPath(null);
    });
  };

  /** Called from `PlannerDirectoryPicker` — just records the choice, since
      the agent isn't created until "Add agent" is pressed (the name field
      might still be empty). */
  const pickAgentDirectory = (path: string, opts?: { create?: boolean }): void => {
    setNewAgentPath({ path, create: opts?.create ?? false });
    setShowDirectoryPicker(false);
  };

  const confirmRemoveAgent = (): void => {
    const ws = confirmingDeleteAgent;
    setConfirmingDeleteAgent(null);
    if (!ws) return;
    // Never deletes the underlying directory or its chats' transcripts —
    // same "removing never deletes" discipline as everywhere else in this
    // app; only the agent row itself goes away.
    void withBusy(() => api.deletePlannerWorkspace(ws.id));
  };

  const setYolo = (yoloEnabled: boolean): void => {
    void withBusy(() => api.updatePlannerSettings({ yoloEnabled }));
  };

  /** The global on/off switch (PA-6 round 5) — off here means off for every
      agent, regardless of that agent's own per-tool setting. */
  const toggleGlobalTool = (name: string, enabled: boolean): void => {
    void withBusy(() => api.setPlannerToolEnabled(name, { enabled }));
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

  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  const { trigger: triggerImportAgent, fileInputProps: agentFileInputProps } =
    useJsonImport<PocketAgentExportData>({
      expectedKind: 'pocket-agent',
      onSuccess: async ({ data: imported }) => {
        try {
          setError(null);
          setImportSuccess(null);
          setBusy(true);
          const created = await api.createPlannerWorkspace(imported.name);
          await api.updatePlannerWorkspace(created.id, {
            defaultModelId: imported.defaultModelId,
            identityPrompt: imported.identityPrompt,
            memoryEnabled: imported.memoryEnabled,
            mcpEnabled: imported.mcpEnabled,
          });
          if (imported.disabledTools && imported.disabledTools.length > 0) {
            const disabledSet = new Set(imported.disabledTools);
            const { tools: agentTools } = await api.listPlannerAgentTools(created.id);
            for (const t of agentTools) {
              if (disabledSet.has(t.name) && t.enabled) {
                await api.setPlannerAgentTool(created.id, { toolName: t.name, enabled: false });
              }
            }
          }
          await load();
          setImportSuccess(`Agent "${created.name}" imported successfully.`);
        } catch (err) {
          setError(err instanceof ApiError ? err.message : 'Could not import agent.');
        } finally {
          setBusy(false);
        }
      },
      onError: (err) => {
        setError(err);
        setImportSuccess(null);
      },
    });

  const exportAgent = async (ws: PlannerWorkspace): Promise<void> => {
    try {
      let disabledTools: string[] = [];
      try {
        const res = await api.listPlannerAgentTools(ws.id);
        disabledTools = res.tools.filter((t) => !t.enabled).map((t) => t.name);
      } catch {
        // fallback to empty if list fails
      }
      exportToJsonFile(
        'pocket-agent',
        {
          name: ws.name,
          defaultModelId: ws.defaultModelId,
          identityPrompt: ws.identityPrompt,
          memoryEnabled: ws.memoryEnabled,
          mcpEnabled: ws.mcpEnabled,
          disabledTools,
        },
        ws.name,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not export agent.');
    }
  };

  return (
    <div className="planner-page">
      <input {...agentFileInputProps} />
      <div className="planner-head">
        <div>
          <h2>Pocket Agent settings</h2>
          <p className="planner-sub">
            Agents, instructions, tools, and tool safety. Providers and models (chat, embeddings,
            TTS/STT, Gemini Live) live in "Providers and Models"; chats live in the "Pocket Agents"
            section on the home screen.
          </p>
        </div>
        {onBack && (
          <div className="planner-head-actions">
            <button type="button" className="planner-btn" onClick={onBack}>
              Close
            </button>
          </div>
        )}
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

      <div className="planner-grid">
        <div className="planner-col">
          <div className="planner-section">
            <h3>Agents</h3>
            <p className="planner-row-meta" style={{ marginBottom: 10 }}>
              Each agent has its own name, model, tool subset, and directory — see "Pocket Agents" on
              the home screen for its chats. Open one to configure it.
            </p>
            {workspaces === null && <div className="spinner">Loading…</div>}
            {workspaces?.map((ws) => (
              <div key={ws.id} className="planner-model-row">
                <span>
                  {ws.name}
                  {ws.isDefault && <span className="planner-row-meta"> (default)</span>}
                  <br />
                  <span className="planner-row-meta" title={ws.path}>
                    {ws.path}
                  </span>
                </span>
                <div className="planner-row-actions">
                  <button
                    type="button"
                    className="planner-btn"
                    onClick={() => void exportAgent(ws)}
                    title={`Export ${ws.name} to JSON`}
                    aria-label={`Export ${ws.name} to JSON`}
                  >
                    <Icon name="download" size={14} />
                  </button>
                  <button type="button" className="planner-btn" onClick={() => onOpenAgent(ws.id)}>
                    Edit
                  </button>
                  {!ws.isDefault && (
                    <button
                      type="button"
                      className="planner-btn danger"
                      disabled={busy}
                      onClick={() => setConfirmingDeleteAgent(ws)}
                      aria-label={`Delete ${ws.name}`}
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
              <button
                type="button"
                className="planner-btn icon-only"
                disabled={busy}
                onClick={triggerImportAgent}
                title="Import agent from a JSON file"
                aria-label="Import agent from a JSON file"
              >
                <Icon name="upload" size={16} />
              </button>
            </div>
            {newAgentPath ? (
              <p className="planner-row-meta" style={{ marginTop: 6 }}>
                Directory: <code title={newAgentPath.path}>{newAgentPath.path}</code>
                {newAgentPath.create && ' (will be created)'} —{' '}
                <button type="button" className="planner-link-btn" onClick={() => setNewAgentPath(null)}>
                  use an app-created scratch folder instead
                </button>
              </p>
            ) : (
              <p className="planner-row-meta" style={{ marginTop: 6 }}>
                Defaults to an app-created scratch folder —{' '}
                <button type="button" className="planner-link-btn" onClick={() => setShowDirectoryPicker(true)}>
                  pick an existing directory instead
                </button>
              </p>
            )}
          </div>

          <div className="planner-section">
            <h3>About you</h3>
            <p className="planner-row-meta" style={{ marginBottom: 10 }}>
              Sent to every agent alongside its own Identity text (set per agent, in that agent's own
              editor page) — your name, email, Jira username, or anything else an agent should know
              about who it's talking to.
            </p>
            <textarea
              id="planner-me-instruction"
              value={meInstructionInput}
              disabled={busy}
              onChange={(e) => setMeInstructionInput(e.target.value)}
              onBlur={saveMeInstruction}
              rows={3}
              style={{ width: '100%', resize: 'vertical' }}
            />
          </div>

          <div className="planner-section">
            <h3>Tools &amp; environment</h3>
            <p className="planner-row-meta" style={{ marginBottom: 10 }}>
              Also sent to every agent — SSH key paths, URLs for things you reference by name, which
              environment variable is used for what. Anything an agent would otherwise have to guess
              about your setup.
            </p>
            <textarea
              id="planner-tools-instruction"
              value={toolsInstructionInput}
              disabled={busy}
              onChange={(e) => setToolsInstructionInput(e.target.value)}
              onBlur={saveToolsInstruction}
              rows={3}
              style={{ width: '100%', resize: 'vertical' }}
            />
          </div>

          <div className="planner-section">
            <h3>Starter chips</h3>
            <p className="planner-row-meta" style={{ marginBottom: 10 }}>
              Shown in every agent's empty chat, unless that agent has its own list (in its editor
              page). The chip shows the short label; tapping it sends the prompt.
            </p>
            <StarterPromptsEditor
              idPrefix="planner-global-starter"
              value={settings?.starterPrompts ?? DEFAULT_PLANNER_STARTER_PROMPTS}
              busy={busy || settings === null}
              onSave={saveStarterPrompts}
            />
            <button
              type="button"
              className="planner-link-btn"
              style={{ marginTop: 8 }}
              disabled={busy}
              onClick={() => saveStarterPrompts(null)}
            >
              Reset to defaults
            </button>
          </div>

          <div className="planner-section">
            <h3>Web search</h3>
            <p className="planner-row-meta" style={{ marginBottom: 10 }}>
              Powers the <code>web_search</code> tool, via a <code>v1/search</code>-style endpoint. Off by
              default and inert until a base URL is saved <em>and</em> this switch is on.
            </p>
            <label className="planner-checkbox-row" style={{ marginBottom: 10 }}>
              <input
                type="checkbox"
                checked={settings?.webSearchEnabled ?? false}
                onChange={(e) => setWebSearchEnabled(e.target.checked)}
              />
              <span>Enable the web_search tool</span>
            </label>
            <div className="planner-field">
              <label htmlFor="planner-web-search-base-url">Base URL</label>
              <input
                id="planner-web-search-base-url"
                type="text"
                placeholder="https://omniroute.example.com"
                value={webSearchBaseUrlInput}
                onChange={(e) => setWebSearchBaseUrlInput(e.target.value)}
              />
            </div>
            <div className="planner-inline">
              <button type="button" className="planner-btn" disabled={busy} onClick={saveWebSearchEndpoint}>
                Save endpoint
              </button>
              <span className="planner-row-meta">
                {settings?.webSearchBaseUrl ? 'Configured' : 'Not configured'}
              </span>
            </div>
            <div className="planner-field" style={{ marginTop: 12 }}>
              <label htmlFor="planner-web-search-api-key">API key</label>
              <input
                id="planner-web-search-api-key"
                type="password"
                placeholder={settings?.webSearchHasApiKey ? '••••••••  (leave blank to keep)' : 'sk-…'}
                value={webSearchApiKeyInput}
                onChange={(e) => setWebSearchApiKeyInput(e.target.value)}
              />
            </div>
            <div className="planner-inline">
              <button type="button" className="planner-btn" disabled={busy} onClick={saveWebSearchApiKey}>
                Save key
              </button>
              <span className="planner-row-meta">
                {settings?.webSearchHasApiKey ? 'A key is configured' : 'No key configured'}
              </span>
            </div>
            <div className="planner-inline" style={{ marginTop: 12 }}>
              <button
                type="button"
                className="planner-btn"
                disabled={testingWebSearch || !settings?.webSearchEnabled || !settings?.webSearchBaseUrl}
                onClick={testWebSearch}
                title={settings?.webSearchEnabled && settings?.webSearchBaseUrl ? undefined : 'Enable it and set a base URL first.'}
              >
                {testingWebSearch ? 'Testing…' : 'Test search'}
              </button>
            </div>
            {webSearchTestResult && (
              <p className={webSearchTestResult.ok ? 'planner-test-ok' : 'planner-test-fail'}>
                {webSearchTestResult.ok
                  ? `OK (${webSearchTestResult.latencyMs}ms): ${webSearchTestResult.message}`
                  : `Failed: ${webSearchTestResult.message}`}
              </p>
            )}
          </div>

          <div className="planner-section">
            <h3>URL fetch</h3>
            <p className="planner-row-meta" style={{ marginBottom: 10 }}>
              Powers the <code>url_fetch</code> tool, via a Firecrawl-style <code>v1/scrape</code> endpoint.
              Deliberately a separate provider from web search above — a search index and a
              page-fetch/scrape service are different products. A key is optional: some deployments (e.g.
              a self-hosted Firecrawl instance) need none.
            </p>
            <label className="planner-checkbox-row" style={{ marginBottom: 10 }}>
              <input
                type="checkbox"
                checked={settings?.urlFetchEnabled ?? false}
                onChange={(e) => setUrlFetchEnabled(e.target.checked)}
              />
              <span>Enable the url_fetch tool</span>
            </label>
            <div className="planner-field">
              <label htmlFor="planner-url-fetch-base-url">Base URL</label>
              <input
                id="planner-url-fetch-base-url"
                type="text"
                placeholder="https://firecrawl.example.com"
                value={urlFetchBaseUrlInput}
                onChange={(e) => setUrlFetchBaseUrlInput(e.target.value)}
              />
            </div>
            <div className="planner-inline">
              <button type="button" className="planner-btn" disabled={busy} onClick={saveUrlFetchEndpoint}>
                Save endpoint
              </button>
              <span className="planner-row-meta">
                {settings?.urlFetchBaseUrl ? 'Configured' : 'Not configured'}
              </span>
            </div>
            <div className="planner-field" style={{ marginTop: 12 }}>
              <label htmlFor="planner-url-fetch-api-key">API key (optional)</label>
              <input
                id="planner-url-fetch-api-key"
                type="password"
                placeholder={settings?.urlFetchHasApiKey ? '••••••••  (leave blank to keep)' : 'leave blank if none'}
                value={urlFetchApiKeyInput}
                onChange={(e) => setUrlFetchApiKeyInput(e.target.value)}
              />
            </div>
            <div className="planner-inline">
              <button type="button" className="planner-btn" disabled={busy} onClick={saveUrlFetchApiKey}>
                Save key
              </button>
              <span className="planner-row-meta">
                {settings?.urlFetchHasApiKey ? 'A key is configured' : 'No key configured'}
              </span>
            </div>
            <div className="planner-inline" style={{ marginTop: 12 }}>
              <button
                type="button"
                className="planner-btn"
                disabled={testingUrlFetch || !settings?.urlFetchEnabled || !settings?.urlFetchBaseUrl}
                onClick={testUrlFetch}
                title={settings?.urlFetchEnabled && settings?.urlFetchBaseUrl ? undefined : 'Enable it and set a base URL first.'}
              >
                {testingUrlFetch ? 'Testing…' : 'Test fetch'}
              </button>
            </div>
            {urlFetchTestResult && (
              <p className={urlFetchTestResult.ok ? 'planner-test-ok' : 'planner-test-fail'}>
                {urlFetchTestResult.ok
                  ? `OK (${urlFetchTestResult.latencyMs}ms): ${urlFetchTestResult.message}`
                  : `Failed: ${urlFetchTestResult.message}`}
              </p>
            )}
          </div>

          <div className="planner-section">
            <h3>MCP servers</h3>
            <McpRegistriesSection onApiError={onApiError} onChanged={() => void load()} />
          </div>

          <div className="planner-section">
            <h3>Skills</h3>
            <SkillsSection onApiError={onApiError} onChanged={() => void load()} />
          </div>
        </div>

        <div className="planner-col">
          <div className="planner-section">
            <h3>Tools</h3>
            <p className="planner-row-meta" style={{ marginBottom: 10 }}>
              Every tool below is available to every agent by default. Turning one off here takes it
              away from every agent, regardless of that agent's own setting — use an agent's own editor
              to restrict a tool for just that one instead.
            </p>
            {groupToolsByCategory(tools).map((group) => (
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
                      disabled={busy}
                      onChange={(e) => toggleGlobalTool(t.name, e.target.checked)}
                    />
                    <span>
                      <code>{t.name}</code>
                      {t.readOnly && <span className="planner-row-meta"> (read-only)</span>}
                      <span className="planner-row-meta"> — {getToolShortDescription(t.name, t.description)}</span>
                    </span>
                  </label>
                ))}
              </div>
            ))}
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

            <div className="planner-field" style={{ marginTop: 14, maxWidth: 160 }}>
              <label htmlFor="planner-max-tool-iterations">Max tool calls per turn</label>
              <input
                id="planner-max-tool-iterations"
                type="number"
                min={1}
                max={200}
                step={1}
                value={maxToolIterationsInput}
                disabled={busy}
                onChange={(e) => setMaxToolIterationsInput(e.target.value)}
                onBlur={saveMaxToolIterations}
              />
            </div>
            <p className="planner-row-meta" style={{ marginTop: 4 }}>
              If a single turn makes this many tool-call round-trips without reaching a final answer,
              it gives up rather than looping forever. Counted across the whole turn, including any
              time spent paused for approval.
            </p>

            <div className="planner-field" style={{ marginTop: 14, maxWidth: 160 }}>
              <label htmlFor="planner-max-subagent-spawns-per-turn">Max subagent spawns per turn</label>
              <input
                id="planner-max-subagent-spawns-per-turn"
                type="number"
                min={1}
                max={50}
                step={1}
                value={maxSubagentSpawnsPerTurnInput}
                disabled={busy}
                onChange={(e) => setMaxSubagentSpawnsPerTurnInput(e.target.value)}
                onBlur={saveMaxSubagentSpawnsPerTurn}
              />
            </div>
            <p className="planner-row-meta" style={{ marginTop: 4 }}>
              Maximum subagents (Pocket Agent chats or coding agents) a single turn may spawn before
              refusing further spawns. Stops a runaway or confused agent from repeatedly spawning subagents.
            </p>

            <div className="planner-field" style={{ marginTop: 14, maxWidth: 160 }}>
              <label htmlFor="planner-command-timeout-seconds">Command timeout (seconds)</label>
              <input
                id="planner-command-timeout-seconds"
                type="number"
                min={1}
                max={3600}
                step={1}
                value={commandTimeoutSecondsInput}
                disabled={busy}
                onChange={(e) => setCommandTimeoutSecondsInput(e.target.value)}
                onBlur={saveCommandTimeoutSeconds}
              />
            </div>
            <p className="planner-row-meta" style={{ marginTop: 4 }}>
              Maximum duration (in seconds) a planner shell command (bash/exec_command) may run before
              being killed. Default is 300s (5 minutes).
            </p>

            <div className="planner-field" style={{ marginTop: 14, maxWidth: 160 }}>
              <label htmlFor="planner-llm-idle-timeout-seconds">LLM idle timeout (seconds)</label>
              <input
                id="planner-llm-idle-timeout-seconds"
                type="number"
                min={0}
                max={3600}
                step={1}
                value={llmIdleTimeoutSecondsInput}
                disabled={busy}
                onChange={(e) => setLlmIdleTimeoutSecondsInput(e.target.value)}
                onBlur={saveLlmIdleTimeoutSeconds}
              />
            </div>
            <p className="planner-row-meta" style={{ marginTop: 4 }}>
              A reply from the LLM endpoint that sends nothing for this long is abandoned, and retried if
              nothing had arrived yet. Rate limits, 5xx errors and dropped connections are retried
              automatically up to 3 times. 0 turns the idle timeout off.
            </p>

            <h3 style={{ marginTop: 14 }}>Context</h3>
            <label className="planner-checkbox-row" style={{ marginBottom: 10 }}>
              <input
                type="checkbox"
                checked={settings?.compactionEnabled ?? true}
                disabled={busy}
                onChange={(e) => setCompactionEnabled(e.target.checked)}
              />
              <span>
                <strong>Compact long chats</strong> — when a chat nears its model's context window, the
                older part is summarized by the model and later turns send that summary instead. The chat
                history itself is kept in full. Type <code>/compact</code> in a chat to do it now.
              </span>
            </label>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div className="planner-field" style={{ maxWidth: 180 }}>
                <label htmlFor="planner-compaction-reserve-tokens">Reserve (tokens)</label>
                <input
                  id="planner-compaction-reserve-tokens"
                  type="number"
                  min={1024}
                  max={1000000}
                  step={1024}
                  value={compactionReserveTokensInput}
                  disabled={busy || settings?.compactionEnabled === false}
                  onChange={(e) => setCompactionReserveTokensInput(e.target.value)}
                  onBlur={saveCompactionReserveTokens}
                />
              </div>
              <div className="planner-field" style={{ maxWidth: 180 }}>
                <label htmlFor="planner-compaction-keep-recent-tokens">Keep recent (tokens)</label>
                <input
                  id="planner-compaction-keep-recent-tokens"
                  type="number"
                  min={1024}
                  max={1000000}
                  step={1024}
                  value={compactionKeepRecentTokensInput}
                  disabled={busy || settings?.compactionEnabled === false}
                  onChange={(e) => setCompactionKeepRecentTokensInput(e.target.value)}
                  onBlur={saveCompactionKeepRecentTokens}
                />
              </div>
            </div>
            <p className="planner-row-meta" style={{ marginTop: 4 }}>
              Compaction runs once fewer than <em>Reserve</em> tokens of the model&apos;s context window
              would be left free; the most recent <em>Keep recent</em> tokens of the chat are kept word for
              word. Each model&apos;s context window is set on its row in &quot;Providers and Models&quot;.
            </p>

            <h3 style={{ marginTop: 14 }}>Attached files</h3>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div className="planner-field" style={{ maxWidth: 180 }}>
                <label htmlFor="planner-inline-text-kb">Inline text files up to (KB)</label>
                <input
                  id="planner-inline-text-kb"
                  type="number"
                  min={0}
                  max={256}
                  value={inlineTextKbInput}
                  disabled={busy}
                  onChange={(e) => setInlineTextKbInput(e.target.value)}
                  onBlur={saveInlineTextKb}
                />
              </div>
              <div className="planner-field" style={{ maxWidth: 180 }}>
                <label htmlFor="planner-inline-extract-tokens">Inline document text up to (tokens)</label>
                <input
                  id="planner-inline-extract-tokens"
                  type="number"
                  min={0}
                  max={64000}
                  step={1000}
                  value={inlineExtractTokensInput}
                  disabled={busy}
                  onChange={(e) => setInlineExtractTokensInput(e.target.value)}
                  onBlur={saveInlineExtractTokens}
                />
              </div>
            </div>
            <p className="planner-row-meta" style={{ marginTop: 4 }}>
              A text file (Markdown, CSV, JSON, code…) this small goes into the message itself, marked as
              data, so the agent can answer without opening it. A PDF, Word, Excel or PowerPoint file has
              its text extracted when it is attached; an extract this small goes in too, and a bigger one is
              saved beside the file for the agent to read in pages. 0 never inlines. Content is left out
              when a chat is too close to its model&apos;s context window, and the agent is told so.
            </p>

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
        </div>
      </div>

      {showDirectoryPicker && (
        <PlannerDirectoryPicker
          onClose={() => setShowDirectoryPicker(false)}
          onPick={pickAgentDirectory}
          onApiError={onApiError}
        />
      )}

      {confirmingDeleteAgent && (
        <ConfirmDialog
          title={`Delete "${confirmingDeleteAgent.name}"?`}
          body="Its chats and directory are not deleted — only the agent row itself goes away. This can't be undone from here."
          confirmLabel={busy ? 'Deleting…' : 'Delete'}
          busy={busy}
          onConfirm={confirmRemoveAgent}
          onCancel={() => setConfirmingDeleteAgent(null)}
        />
      )}
    </div>
  );
}
