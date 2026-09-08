import { useCallback, useEffect, useState } from 'react';
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
} from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Icon } from '../components/Icon.js';
import { PlannerDirectoryPicker } from '../components/PlannerDirectoryPicker.js';
import { McpRegistriesSection } from '../components/McpRegistriesSection.js';
import { SkillsSection } from '../components/SkillsSection.js';

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

  /**
   * Queries the configured endpoint's own `/models` and *caches* the ids for
   * type-ahead — it deliberately adds nothing to the catalog (PA-6 round 7:
   * "Query model will only 'cache' the model, and don't add. This is to
   * provide user type ahead suggestion"). A provider can list hundreds of
   * models; adding them all made the catalog and every chat's model picker
   * unusable. Adding stays an explicit click on a suggestion, or the
   * id + label form below.
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
   * Adds one suggestion straight from the type-ahead list, labelled with its
   * own id — the label field is for a nickname, and requiring one before a
   * one-click add would defeat the point of the list.
   *
   * Deliberately leaves the typed filter alone: the id just added drops out
   * of `modelSuggestions` by itself (it is now configured), so "type gemin,
   * click three of them" works without retyping between each.
   */
  const addDiscoveredModel = (modelId: string): void => {
    void withBusy(() => api.createPlannerModel({ modelId, label: modelId }));
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
   * scroll. Empty input shows nothing — the list is a filter, not a browser.
   */
  const configuredModelIds = new Set((models ?? []).map((m) => m.modelId));
  const typedModelId = newModelId.trim().toLowerCase();
  const modelSuggestions =
    typedModelId.length === 0
      ? []
      : discoveredIds
          .filter((id) => !configuredModelIds.has(id) && id.toLowerCase().includes(typedModelId))
          .slice(0, 12);

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
                onClick={() => addDiscoveredModel(modelId)}
              >
                <Icon name="plus" size={13} /> {modelId}
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
        <h3>MCP servers</h3>
        <McpRegistriesSection onApiError={onApiError} onChanged={() => void load()} />
      </div>

      <div className="planner-section">
        <h3>Skills</h3>
        <SkillsSection onApiError={onApiError} onChanged={() => void load()} />
      </div>

      <div className="planner-section">
        <h3>Tools</h3>
        <p className="planner-row-meta" style={{ marginBottom: 10 }}>
          Every tool below is available to every agent by default. Turning one off here takes it
          away from every agent, regardless of that agent's own setting — use an agent's own editor
          to restrict a tool for just that one instead.
        </p>
        {tools.map((t) => (
          <label key={t.name} className="planner-checkbox-row" style={{ marginBottom: 6 }}>
            <input
              type="checkbox"
              checked={t.enabled}
              disabled={busy}
              onChange={(e) => toggleGlobalTool(t.name, e.target.checked)}
            />
            <span>
              <code>{t.name}</code>
              {t.readOnly && <span className="planner-row-meta"> (read-only)</span>}
              <br />
              <span className="planner-row-meta">{t.description}</span>
            </span>
          </label>
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
