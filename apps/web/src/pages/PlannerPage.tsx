import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  PlannerModel,
  PlannerSettingsDto,
  PlannerToolApprovalRow,
  PlannerToolInfo,
  PlannerWorkspace,
  TestPlannerEmbeddingResponse,
  TestPlannerModelResponse,
  TestPlannerUrlFetchResponse,
  TestPlannerWebSearchResponse,
  PlannerEndpointTemplatePayload,
  PocketAgentExportData,
  UpdatePlannerModelRequest,
} from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Icon } from '../components/Icon.js';
import { PlannerDirectoryPicker } from '../components/PlannerDirectoryPicker.js';
import { McpRegistriesSection } from '../components/McpRegistriesSection.js';
import { SkillsSection } from '../components/SkillsSection.js';
import { useHostApi } from '../hosts/HostContext.js';
import { GeminiLiveSettingsSection } from '../components/GeminiLiveSettingsSection.js';
import { getToolShortDescription, groupToolsByCategory } from '../agent/planner-tools-metadata.js';
import { exportToJsonFile } from '../agent/json-transfer.js';
import { useJsonImport } from '../hooks/useJsonImport.js';

interface Props {
  onApiError: (error: unknown) => void;
  /** Present only on the phone route — see `CronJobsPage`'s identical prop for why. */
  onBack?: () => void;
  /** Opens an existing agent's own editor (`PlannerAgentEditorPage`) — name,
      default model, tool subset, directory. */
  onOpenAgent: (agentId: string) => void;
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
export function PlannerPage({ onApiError, onBack, onOpenAgent }: Props): JSX.Element {
  const api = useHostApi();
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
  const [embeddingBaseUrlInput, setEmbeddingBaseUrlInput] = useState('');
  const [embeddingApiKeyInput, setEmbeddingApiKeyInput] = useState('');
  const [revealedEmbeddingApiKey, setRevealedEmbeddingApiKey] = useState<string | null>(null);
  const [embeddingModelIdInput, setEmbeddingModelIdInput] = useState('');
  const [testingEmbeddings, setTestingEmbeddings] = useState(false);
  const [embeddingTestResult, setEmbeddingTestResult] = useState<TestPlannerEmbeddingResponse | null>(null);
  // PA-31: the web_search/url_fetch tools' own providers.
  const [webSearchBaseUrlInput, setWebSearchBaseUrlInput] = useState('');
  const [webSearchApiKeyInput, setWebSearchApiKeyInput] = useState('');
  const [urlFetchBaseUrlInput, setUrlFetchBaseUrlInput] = useState('');
  const [urlFetchApiKeyInput, setUrlFetchApiKeyInput] = useState('');
  const [testingWebSearch, setTestingWebSearch] = useState(false);
  const [webSearchTestResult, setWebSearchTestResult] = useState<TestPlannerWebSearchResponse | null>(null);
  const [testingUrlFetch, setTestingUrlFetch] = useState(false);
  const [urlFetchTestResult, setUrlFetchTestResult] = useState<TestPlannerUrlFetchResponse | null>(null);
  const [newModelId, setNewModelId] = useState('');
  const [newModelLabel, setNewModelLabel] = useState('');
  const [newModelSupportsEffort, setNewModelSupportsEffort] = useState(true);
  const [suggestionsOpen, setSuggestionsOpen] = useState(true);
  const newModelLabelInputRef = useRef<HTMLInputElement | null>(null);
  const [newApprovalScope, setNewApprovalScope] = useState<'global' | 'workspace'>('global');
  const [newApprovalWorkspaceId, setNewApprovalWorkspaceId] = useState('');
  const [newApprovalTool, setNewApprovalTool] = useState('');
  const [newApprovalDecision, setNewApprovalDecision] = useState<'allow' | 'deny'>('deny');
  const [newAgentName, setNewAgentName] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [discoverMessage, setDiscoverMessage] = useState<string | null>(null);
  /** Model ids the endpoint reported, cached for type-ahead only — see
      `discoverModels`. Deliberately not persisted: it is a suggestion list,
      and a stale one is worse than one click to refresh it. */
  const [discoveredIds, setDiscoveredIds] = useState<string[]>([]);
  const [confirmingDeleteAllModels, setConfirmingDeleteAllModels] = useState(false);
  const [testingAll, setTestingAll] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, TestPlannerModelResponse | 'testing'>>({});
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
      setEmbeddingBaseUrlInput(se.embeddingBaseUrl ?? '');
      setEmbeddingModelIdInput(se.embeddingModelId ?? '');
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

  // PA-45 (reporter: "add 'me' instruction ... whenever agent need have
  // context of myself" / "add 'tools' instruction, for environment
  // settings"): global, not per-agent — folded into every agent's turn
  // alongside that agent's own `identityPrompt` (see
  // `buildPersonaSystemMessage`). Empty string saves as `null`, same "empty
  // means unset" convention as `saveEndpoint` above.
  const saveMeInstruction = (): void => {
    void withBusy(() => api.updatePlannerSettings({ meInstruction: meInstructionInput.trim() || null }));
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
  const setCompactionEnabled = (enabled: boolean): void => {
    void withBusy(() => api.updatePlannerSettings({ compactionEnabled: enabled }));
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

  /**
   * PA-29: the embedding provider's own settings — deliberately a separate
   * base URL/API key/model from the chat endpoint above, per the approved
   * design ("Embedding need own setting with url, api key, model"). Mirrors
   * `saveEndpoint`/`saveApiKey`/`reveal` exactly, one layer down.
   */
  const saveEmbeddingEndpoint = (): void => {
    void withBusy(() =>
      api.updatePlannerSettings({ embeddingBaseUrl: embeddingBaseUrlInput.trim() || null }),
    );
  };

  const saveEmbeddingApiKey = (): void => {
    void withBusy(async () => {
      await api.updatePlannerSettings({ embeddingApiKey: embeddingApiKeyInput });
      setEmbeddingApiKeyInput('');
      setRevealedEmbeddingApiKey(null);
    });
  };

  const revealEmbeddingKey = (): void => {
    void withBusy(async () => {
      const { apiKey } = await api.revealPlannerEmbeddingApiKey();
      setRevealedEmbeddingApiKey(apiKey);
    });
  };

  const saveEmbeddingModelId = (): void => {
    void withBusy(() =>
      api.updatePlannerSettings({ embeddingModelId: embeddingModelIdInput.trim() || null }),
    );
  };

  const testEmbeddings = (): void => {
    setTestingEmbeddings(true);
    setEmbeddingTestResult(null);
    void (async () => {
      try {
        const result = await api.testPlannerEmbeddings();
        setEmbeddingTestResult(result);
      } catch (err) {
        onApiError(err);
        setEmbeddingTestResult({
          ok: false,
          message: err instanceof ApiError ? err.message : 'Test failed.',
          dims: 0,
          latencyMs: 0,
        });
      } finally {
        setTestingEmbeddings(false);
      }
    })();
  };

  /**
   * PA-31: `web_search`'s own provider — off by default and inert until
   * both a base URL is saved and the switch is on, mirroring
   * `CreateCronJobRequest.skipPermissions`'s "consequential default is an
   * explicit, separate act" reasoning. No reveal button, unlike the chat/
   * embedding keys above: this key is never shown back once saved, the
   * same posture `CustomClaudeProvidersSection` takes for its own key.
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

  const addModel = (): void => {
    const trimmedId = newModelId.trim();
    const trimmedLabel = newModelLabel.trim() || trimmedId;
    if (!trimmedId) return;
    void withBusy(async () => {
      await api.createPlannerModel({
        modelId: trimmedId,
        label: trimmedLabel,
        supportsEffort: newModelSupportsEffort,
      });
      setNewModelId('');
      setNewModelLabel('');
      setNewModelSupportsEffort(true);
      setSuggestionsOpen(false);
    });
  };

  const toggleModelEffort = (id: string, current: boolean): void => {
    void withBusy(async () => {
      await api.updatePlannerModel(id, { supportsEffort: !current });
      await load();
    });
  };

  // PA-121: a model's context window / output limit; `null` = not set.
  // PA-122: the same path carries prompt caching, prices and image support.
  // PA-129: also carries `label` updates from `ModelLabelEditor`.
  const setModelLimit = (id: string, patch: UpdatePlannerModelRequest): void => {
    void withBusy(async () => {
      await api.updatePlannerModel(id, patch);
      await load();
    });
  };

  const removeModel = (id: string): void => {
    void withBusy(() => api.deletePlannerModel(id));
  };

  /**
   * Queries the configured endpoint's own `/models` and *caches* the ids for
   * type-ahead — it deliberately adds nothing to the catalog (PA-6 round 7:
   * "Query model will only 'cache' the model, and don't add. This is to
   * provide user type ahead suggestion"). A provider can list hundreds of
   * models; adding them all made the catalog and every chat's model picker
   * unusable. Adding stays an explicit action via the id + label form below.
   */
  const discoverModels = (): void => {
    setDiscovering(true);
    setDiscoverMessage(null);
    void (async () => {
      try {
        const { modelIds } = await api.discoverPlannerModels();
        setDiscoveredIds(modelIds);
        setDiscoverMessage(
          modelIds.length > 0
            ? `${modelIds.length} model${modelIds.length === 1 ? '' : 's'} available — start typing an id below to pick one.`
            : 'The endpoint listed no models.',
        );
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not query models from the endpoint.');
      } finally {
        setDiscovering(false);
      }
    })();
  };

  /**
   * PA-129: fills the model-id input from a type-ahead suggestion and moves
   * focus to the label input so the user has the chance to enter a label
   * before clicking Add, rather than immediately creating the model with its
   * raw id as the label.
   */
  const selectDiscoveredModel = (modelId: string): void => {
    setNewModelId(modelId);
    setSuggestionsOpen(false);
    newModelLabelInputRef.current?.focus();
  };

  const confirmDeleteAllModels = (): void => {
    setConfirmingDeleteAllModels(false);
    void withBusy(async () => {
      await api.deleteAllPlannerModels();
      setTestResults({});
    });
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

  /**
   * Type-ahead matches for whatever is typed in the model-id field: cached
   * ids that contain it, minus ones already in the catalog, capped so a
   * provider listing hundreds of models can't turn this into an endless
   * scroll. Empty input (or a dismissed list after picking a suggestion)
   * shows nothing — the list is a filter, not a browser.
   */
  const configuredModelIds = new Set((models ?? []).map((m) => m.modelId));
  const modelSuggestions = computeModelSuggestions(
    discoveredIds,
    configuredModelIds,
    newModelId,
    suggestionsOpen,
  );

  const workspaceName = (id: string | null): string =>
    (id && workspaces?.find((w) => w.id === id)?.name) || (id ? '(deleted workspace)' : '');

  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  const handleExportEndpoint = (): void => {
    exportToJsonFile(
      'planner-endpoint',
      {
        baseUrl: baseUrlInput,
        // PA-122: each model's settings travel with it, not just its name.
        models: (models ?? []).map(({ id: _id, sortOrder: _sortOrder, createdAt: _createdAt, ...model }) => model),
        embeddingBaseUrl: embeddingBaseUrlInput || null,
        embeddingModelId: embeddingModelIdInput || null,
        webSearchBaseUrl: webSearchBaseUrlInput || null,
        urlFetchBaseUrl: urlFetchBaseUrlInput || null,
      },
      'planner-endpoint',
    );
  };

  const { trigger: triggerImportEndpoint, fileInputProps: endpointFileInputProps } =
    useJsonImport<PlannerEndpointTemplatePayload>({
      expectedKind: 'planner-endpoint',
      onSuccess: async ({ data: imported }) => {
        try {
          setError(null);
          setImportSuccess(null);
          setBusy(true);
          await api.updatePlannerSettings({
            baseUrl: imported.baseUrl,
            embeddingBaseUrl: imported.embeddingBaseUrl,
            embeddingModelId: imported.embeddingModelId,
            webSearchBaseUrl: imported.webSearchBaseUrl,
            urlFetchBaseUrl: imported.urlFetchBaseUrl,
          });
          const existingModelIds = new Set((models ?? []).map((m) => m.modelId));
          for (const m of imported.models) {
            if (!existingModelIds.has(m.modelId)) {
              await api.createPlannerModel(m);
            }
          }
          await load();
          setImportSuccess('LLM endpoint and model settings imported successfully.');
        } catch (err) {
          setError(err instanceof ApiError ? err.message : 'Could not import endpoint settings.');
        } finally {
          setBusy(false);
        }
      },
      onError: (err) => {
        setError(err);
        setImportSuccess(null);
      },
    });

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
      <input {...endpointFileInputProps} />
      <input {...agentFileInputProps} />
      <div className="planner-head">
        <div>
          <h2>Pocket Agent settings</h2>
          <p className="planner-sub">
            LLM endpoint, models, agents, and tool safety. Chats themselves live in the "Pocket
            Agents" section on the home screen.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            type="button"
            className="planner-btn"
            onClick={handleExportEndpoint}
            title="Export LLM endpoint and model settings to JSON"
          >
            <Icon name="download" size={14} />
            Export endpoint JSON
          </button>
          <button
            type="button"
            className="planner-btn"
            onClick={triggerImportEndpoint}
            title="Import LLM endpoint and model settings from JSON"
          >
            <Icon name="upload" size={14} />
            Import endpoint JSON
          </button>
          {onBack && (
            <button type="button" className="planner-btn" onClick={onBack}>
              Close
            </button>
          )}
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

      <div className="planner-grid">
        <div className="planner-col">
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
            <button
              type="button"
              className="planner-btn danger"
              disabled={busy || !models || models.length === 0}
              onClick={() => setConfirmingDeleteAllModels(true)}
            >
              Delete all
            </button>
          </div>
        </div>
        {discoverMessage && <p className="planner-row-meta">{discoverMessage}</p>}
        {models?.length === 0 && (
          <p className="planner-row-meta">
            No models configured yet — query the endpoint above, then pick from the suggestions as
            you type an id below.
          </p>
        )}
        {models?.map((m) => {
          const result = testResults[m.id];
          return (
            <div key={m.id} className="planner-model-row">
              <span>
                <ModelLabelEditor
                  label={m.label}
                  modelId={m.modelId}
                  disabled={busy}
                  onSave={(nextLabel) => setModelLimit(m.id, { label: nextLabel })}
                />{' '}
                <span className="planner-row-meta">({m.modelId})</span>
                <button
                  type="button"
                  className={`planner-badge-btn${m.supportsEffort !== false ? ' active' : ''}`}
                  onClick={() => toggleModelEffort(m.id, m.supportsEffort !== false)}
                  title={m.supportsEffort !== false ? 'Reasoning effort enabled (click to disable)' : 'Reasoning effort disabled (click to enable)'}
                >
                  <Icon name="brain" size={12} />
                  <span>{m.supportsEffort !== false ? 'Effort on' : 'Effort off'}</span>
                </button>
                <ModelLimitInput
                  label="Context"
                  title="Context window in tokens. Empty = worked out from the model name (128k if unknown)."
                  value={m.contextWindow ?? null}
                  disabled={busy}
                  onSave={(v) => setModelLimit(m.id, { contextWindow: v })}
                />
                <ModelLimitInput
                  label="Max out"
                  title="Output limit in tokens, sent as max_tokens. Empty = not sent."
                  value={m.maxOutputTokens ?? null}
                  disabled={busy}
                  onSave={(v) => setModelLimit(m.id, { maxOutputTokens: v })}
                />
                <TriStateSelect
                  label="Cache"
                  title="Prompt caching: send Anthropic cache_control markers. Auto = on for Claude models only, since strict OpenAI-compatible servers reject the field. Cached token counts are shown whenever the provider reports them, whatever this says."
                  value={m.promptCaching ?? null}
                  disabled={busy}
                  onSave={(v) => setModelLimit(m.id, { promptCaching: v })}
                />
                <TriStateSelect
                  label="Images"
                  title="Whether this model can read attached images. Auto = yes, unless it is a known text-only model. When off, each image is replaced by a short note in what the model is sent; the chat keeps the image."
                  value={m.supportsImages ?? null}
                  disabled={busy}
                  onSave={(v) => setModelLimit(m.id, { supportsImages: v })}
                />
                <span
                  className="planner-model-prices"
                  title="USD per million tokens, used to show each turn's cost. Optional — with no input and output price a turn shows no cost. An empty cache price is charged at the input price. A cost the provider reports itself is used instead."
                >
                  <PriceInput
                    label="$ in"
                    value={m.inputPricePerMTok ?? null}
                    disabled={busy}
                    onSave={(v) => setModelLimit(m.id, { inputPricePerMTok: v })}
                  />
                  <PriceInput
                    label="out"
                    value={m.outputPricePerMTok ?? null}
                    disabled={busy}
                    onSave={(v) => setModelLimit(m.id, { outputPricePerMTok: v })}
                  />
                  <PriceInput
                    label="cache read"
                    value={m.cacheReadPricePerMTok ?? null}
                    disabled={busy}
                    onSave={(v) => setModelLimit(m.id, { cacheReadPricePerMTok: v })}
                  />
                  <PriceInput
                    label="cache write"
                    value={m.cacheWritePricePerMTok ?? null}
                    disabled={busy}
                    onSave={(v) => setModelLimit(m.id, { cacheWritePricePerMTok: v })}
                  />
                  <span className="planner-row-meta">per 1M tokens</span>
                </span>
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
            onChange={(e) => {
              setNewModelId(e.target.value);
              setSuggestionsOpen(true);
            }}
            onFocus={() => setSuggestionsOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addModel();
            }}
          />
          <input
            ref={newModelLabelInputRef}
            type="text"
            placeholder="Label, e.g. Fast"
            value={newModelLabel}
            onChange={(e) => setNewModelLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addModel();
            }}
          />
          <label className="planner-inline-checkbox" title="Allow configuring reasoning effort for this model">
            <input
              type="checkbox"
              checked={newModelSupportsEffort}
              onChange={(e) => setNewModelSupportsEffort(e.target.checked)}
            />
            <span>Reasoning effort</span>
          </label>
          <button type="button" className="planner-btn" disabled={busy} onClick={addModel}>
            <Icon name="plus" size={14} /> Add
          </button>
        </div>
        {modelSuggestions.length > 0 && (
          <div className="planner-suggestions" role="listbox" aria-label="Matching models">
            {modelSuggestions.map((modelId) => (
              <button
                key={modelId}
                type="button"
                role="option"
                aria-selected={false}
                className="planner-suggestion"
                disabled={busy}
                onClick={() => selectDiscoveredModel(modelId)}
              >
                {modelId}
              </button>
            ))}
          </div>
        )}
        {newModelId.trim().length > 0 && discoveredIds.length === 0 && (
          <p className="planner-row-meta" style={{ marginTop: 6 }}>
            Query the endpoint above to get suggestions, or type a full id and a label and press Add.
          </p>
        )}
      </div>

      <div className="planner-section">
        <h3>Embeddings</h3>
        <p className="planner-row-meta" style={{ marginBottom: 10 }}>
          A separate provider from the chat endpoint above — its own base URL, API key, and
          model, since an embedding service is often deployed somewhere else entirely. Optional:
          the memory system works lexically without this; configuring it adds semantic ranking
          on top.
        </p>
        <div className="planner-field">
          <label htmlFor="planner-embedding-base-url">Base URL (OpenAI-compatible)</label>
          <input
            id="planner-embedding-base-url"
            type="text"
            placeholder="https://api.openai.com/v1"
            value={embeddingBaseUrlInput}
            onChange={(e) => setEmbeddingBaseUrlInput(e.target.value)}
          />
        </div>
        <div className="planner-inline">
          <button type="button" className="planner-btn" disabled={busy} onClick={saveEmbeddingEndpoint}>
            Save endpoint
          </button>
          <span className="planner-row-meta">
            {settings?.embeddingBaseUrl ? 'Configured' : 'Not configured'}
          </span>
        </div>

        <div className="planner-field" style={{ marginTop: 12 }}>
          <label htmlFor="planner-embedding-api-key">API key</label>
          <input
            id="planner-embedding-api-key"
            type="password"
            placeholder={settings?.embeddingHasApiKey ? '••••••••  (leave blank to keep)' : 'sk-…'}
            value={embeddingApiKeyInput}
            onChange={(e) => setEmbeddingApiKeyInput(e.target.value)}
          />
        </div>
        <div className="planner-inline">
          <button type="button" className="planner-btn" disabled={busy} onClick={saveEmbeddingApiKey}>
            Save key
          </button>
          <button
            type="button"
            className="planner-btn"
            disabled={busy || !settings?.embeddingHasApiKey}
            onClick={revealEmbeddingKey}
          >
            Reveal
          </button>
          <span className="planner-row-meta">
            {settings?.embeddingHasApiKey ? 'A key is configured' : 'No key configured'}
          </span>
        </div>
        {revealedEmbeddingApiKey && (
          <p className="planner-row-meta" style={{ marginTop: 6, wordBreak: 'break-all' }}>
            {revealedEmbeddingApiKey}
          </p>
        )}

        <div className="planner-field" style={{ marginTop: 12 }}>
          <label htmlFor="planner-embedding-model-id">Model id</label>
          <input
            id="planner-embedding-model-id"
            type="text"
            placeholder="text-embedding-3-small"
            value={embeddingModelIdInput}
            onChange={(e) => setEmbeddingModelIdInput(e.target.value)}
          />
        </div>
        <div className="planner-inline">
          <button type="button" className="planner-btn" disabled={busy} onClick={saveEmbeddingModelId}>
            Save model
          </button>
          <button
            type="button"
            className="planner-btn"
            disabled={testingEmbeddings || !settings?.embeddingBaseUrl || !settings?.embeddingModelId}
            onClick={testEmbeddings}
          >
            {testingEmbeddings ? 'Testing…' : 'Test embeddings'}
          </button>
        </div>
        {embeddingTestResult && (
          <p className={embeddingTestResult.ok ? 'planner-test-ok' : 'planner-test-fail'}>
            {embeddingTestResult.ok
              ? `OK (${embeddingTestResult.latencyMs}ms, ${embeddingTestResult.dims} dims): ${embeddingTestResult.message}`
              : `Failed: ${embeddingTestResult.message}`}
          </p>
        )}
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

      <GeminiLiveSettingsSection onApiError={onApiError} />

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
    </div>

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
            className="planner-btn"
            disabled={busy}
            onClick={triggerImportAgent}
            title="Import agent from a JSON file"
          >
            <Icon name="upload" size={14} /> Import agent
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
          word. Each model&apos;s context window is set on its row under Models.
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

      <div className="planner-section">
        <h3>MCP servers</h3>
        <McpRegistriesSection onApiError={onApiError} onChanged={() => void load()} />
      </div>

      <div className="planner-section">
        <h3>Skills</h3>
        <SkillsSection onApiError={onApiError} onChanged={() => void load()} />
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

      {confirmingDeleteAllModels && (
        <ConfirmDialog
          title={`Delete all ${models?.length ?? 0} models?`}
          body="This only empties the catalog you pick from. Chats and agents keep whatever model they already had — the id is just a string the endpoint either accepts or doesn't."
          confirmLabel={busy ? 'Deleting…' : 'Delete all'}
          busy={busy}
          onConfirm={confirmDeleteAllModels}
          onCancel={() => setConfirmingDeleteAllModels(false)}
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

/**
 * PA-121: one of a model row's token limits, edited inline and saved on blur.
 * Empty means "not set" (the server then works it out); anything outside the
 * server's `[1024, 10 000 000]` range reverts rather than round-tripping as a
 * 400.
 */
/** PA-122: one per-million-token price; empty = not set. */
function PriceInput({
  label,
  value,
  disabled,
  onSave,
}: {
  label: string;
  value: number | null;
  disabled: boolean;
  onSave: (value: number | null) => void;
}): JSX.Element {
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => {
    setText(value === null ? '' : String(value));
  }, [value]);
  const commit = (): void => {
    const trimmed = text.trim();
    if (trimmed === '') {
      if (value !== null) onSave(null);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10_000) {
      setText(value === null ? '' : String(value));
      return;
    }
    if (parsed !== value) onSave(parsed);
  };
  return (
    <label className="planner-model-limit">
      <span>{label}</span>
      <input
        type="number"
        min={0}
        step="any"
        placeholder="—"
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
      />
    </label>
  );
}

/** PA-122: Auto / On / Off for a nullable per-model boolean. */
function TriStateSelect({
  label,
  title,
  value,
  disabled,
  onSave,
}: {
  label: string;
  title: string;
  value: boolean | null;
  disabled: boolean;
  onSave: (value: boolean | null) => void;
}): JSX.Element {
  const current = value === null ? 'auto' : value ? 'on' : 'off';
  return (
    <label className="planner-model-limit" title={title}>
      <span>{label}</span>
      <select
        value={current}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value === 'auto' ? null : e.target.value === 'on';
          if (next !== value) onSave(next);
        }}
      >
        <option value="auto">Auto</option>
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    </label>
  );
}

function ModelLimitInput({
  label,
  title,
  value,
  disabled,
  onSave,
}: {
  label: string;
  title: string;
  value: number | null;
  disabled: boolean;
  onSave: (value: number | null) => void;
}): JSX.Element {
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => {
    setText(value === null ? '' : String(value));
  }, [value]);
  const commit = (): void => {
    const trimmed = text.trim();
    if (trimmed === '') {
      if (value !== null) onSave(null);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 10_000_000) {
      setText(value === null ? '' : String(value));
      return;
    }
    if (parsed !== value) onSave(parsed);
  };
  return (
    <label className="planner-model-limit" title={title}>
      <span>{label}</span>
      <input
        type="number"
        min={1024}
        step={1024}
        placeholder="auto"
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
      />
    </label>
  );
}

/**
 * PA-129: type-ahead matches for whatever is typed in the model-id field.
 * Selecting a suggestion fills the model-id input (and closes the list via
 * `suggestionsOpen = false`) so the user can enter a friendly label before
 * clicking Add, instead of immediately creating the model with `label = id`.
 */
export function computeModelSuggestions(
  discoveredIds: readonly string[],
  configuredModelIds: ReadonlySet<string>,
  typedInput: string,
  suggestionsOpen = true,
): string[] {
  if (!suggestionsOpen) return [];
  const typedModelId = typedInput.trim().toLowerCase();
  if (typedModelId.length === 0) return [];
  return discoveredIds
    .filter((id) => !configuredModelIds.has(id) && id.toLowerCase().includes(typedModelId))
    .slice(0, 12);
}

/**
 * PA-129: a model row's display label, with an inline edit toggle so a typo
 * or nickname tweak does not require deleting and re-creating the model.
 */
export function ModelLabelEditor({
  label,
  modelId,
  disabled,
  initialEditing = false,
  onSave,
}: {
  label: string;
  modelId: string;
  disabled: boolean;
  initialEditing?: boolean;
  onSave: (label: string) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(initialEditing);
  const [text, setText] = useState(label);

  useEffect(() => {
    if (!editing) {
      setText(label);
    }
  }, [label, editing]);

  const startEditing = (): void => {
    setText(label);
    setEditing(true);
  };

  const commit = (): void => {
    setEditing(false);
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 128 || trimmed === label) {
      setText(label);
      return;
    }
    onSave(trimmed);
  };

  const cancel = (): void => {
    setText(label);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        type="text"
        autoFocus
        className="planner-model-label-input"
        aria-label={`Edit label for ${modelId}`}
        value={text}
        maxLength={128}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
      />
    );
  }

  return (
    <>
      <span>{label}</span>
      <button
        type="button"
        className="planner-model-label-edit"
        disabled={disabled}
        onClick={startEditing}
        aria-label={`Edit label for ${label}`}
        title="Edit label"
      >
        <Icon name="edit" size={13} />
      </button>
    </>
  );
}
