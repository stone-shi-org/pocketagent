import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ANTIGRAVITY_OAUTH_PROVIDER_DISCLOSURE,
  CLAUDE_OAUTH_PROVIDER_DISCLOSURE,
  CODEX_OAUTH_PROVIDER_DISCLOSURE,
  DEEPSEEK_PROVIDER_DEFAULTS,
  OPENCODE_GO_PROVIDER_DEFAULTS,
  OPENCODE_ZEN_PROVIDER_DEFAULTS,
  defaultEndpointsForProviderKind,
  isApiKeyProviderKind,
  type ClaudeOAuthAuthorizeResponse,
  type ClaudeProviderUsageResponse,
  type CodexDeviceCodeStartResponse,
  type PlannerModel,
  type PlannerProvider,
  type PlannerProviderEndpoint,
  type PlannerProviderKind,
  type PlannerProviderTemplatePayload,
  type PlannerSettingsDto,
  type SettingsResponse,
  type TestPlannerEmbeddingResponse,
  type TestPlannerModelResponse,
  type UpdatePlannerModelRequest,
  type UpdateSettingsRequest,
} from '@pocketagent/protocol';
import { ApiError, type ApiClient } from '../api/client.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { GeminiLiveSettingsSection } from '../components/GeminiLiveSettingsSection.js';
import { Icon } from '../components/Icon.js';
import { useHostApi } from '../hosts/HostContext.js';
import { TtsPlaybackQueue } from '../audio/playback.js';
import { unlockAudioContext } from '../audio/audio-context.js';
import { exportPlannerProviderPayload } from '../agent/hub-template-export.js';
import { exportToJsonFile } from '../agent/json-transfer.js';
import { useJsonImport } from '../hooks/useJsonImport.js';

type RuntimeSettings = SettingsResponse['settings'];

const DEBOUNCE_MS = 500;

const ANTIGRAVITY_SUGGESTED_MODELS: readonly string[] = [
  'auto',
  'gemini-3.7-flash-high',
  'fable-5.1-high',
  'fable-5.1-low',
  'opus-5.5-thinking',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'gemini-3-flash',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
];

interface Props {
  onApiError: (error: unknown) => void;
  /** Present only on the phone route or tab strip close action. */
  onBack?: () => void;
}

/**
 * PA-132 / PA-148: "Providers and Models" settings page — consolidates the
 * Pocket Agent LLM providers and per-provider model catalogs, embeddings,
 * the self-hosted TTS/STT voice pipeline settings, and Gemini Live
 * configuration in one place.
 */
export function ProvidersAndModelsPage({ onApiError, onBack }: Props): JSX.Element {
  const api = useHostApi();
  const [providers, setProviders] = useState<PlannerProvider[] | null>(null);
  const [hasLocalAgyAuth, setHasLocalAgyAuth] = useState(false);
  const [models, setModels] = useState<PlannerModel[] | null>(null);
  const [plannerSettings, setPlannerSettings] = useState<PlannerSettingsDto | null>(null);
  const [runtimeData, setRuntimeData] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingRuntime, setPendingRuntime] = useState<Set<string>>(new Set());
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Add new provider state
  const [addingProvider, setAddingProvider] = useState(false);
  const [newProviderKind, setNewProviderKind] = useState<PlannerProviderKind>('openai-compatible');
  const [newProviderLabel, setNewProviderLabel] = useState('');
  const [newProviderBaseUrl, setNewProviderBaseUrl] = useState('');
  const [newProviderApiKey, setNewProviderApiKey] = useState('');
  const [newProviderEndpoints, setNewProviderEndpoints] = useState<PlannerProviderEndpoint[]>([
    'openai',
  ]);
  const [newProviderSetupToken, setNewProviderSetupToken] = useState('');
  const [newProviderCodexAuthMode, setNewProviderCodexAuthMode] = useState<'device-code' | 'cli-readonly'>('device-code');
  const [newProviderAntigravityAuthMode, setNewProviderAntigravityAuthMode] = useState<'cli-import' | 'oauth'>('cli-import');
  const [confirmingDeleteProvider, setConfirmingDeleteProvider] = useState<PlannerProvider | null>(null);
  const [confirmingDeleteAllForProvider, setConfirmingDeleteAllForProvider] = useState<PlannerProvider | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestPlannerModelResponse | 'testing'>>({});
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null);
  const [draggingProviderId, setDraggingProviderId] = useState<string | null>(null);
  const [dragOverProviderId, setDragOverProviderId] = useState<string | null>(null);

  // Embeddings state (PA-29, PA-132)
  const [embeddingBaseUrlInput, setEmbeddingBaseUrlInput] = useState('');
  const [embeddingApiKeyInput, setEmbeddingApiKeyInput] = useState('');
  const [revealedEmbeddingApiKey, setRevealedEmbeddingApiKey] = useState<string | null>(null);
  const [embeddingModelIdInput, setEmbeddingModelIdInput] = useState('');
  const [testingEmbeddings, setTestingEmbeddings] = useState(false);
  const [embeddingTestResult, setEmbeddingTestResult] = useState<TestPlannerEmbeddingResponse | null>(null);

  // Voice (STT / TTS) state
  const [voiceModels, setVoiceModels] = useState<{ asr: string[]; tts: string[] }>({ asr: [], tts: [] });
  const [testingStt, setTestingStt] = useState(false);
  const [sttResult, setSttResult] = useState<{ ok: boolean; message: string; durationMs?: number } | null>(null);
  const [testingTts, setTestingTts] = useState(false);
  const [playingTts, setPlayingTts] = useState(false);
  const [ttsResult, setTtsResult] = useState<{ ok: boolean; message: string; durationMs?: number } | null>(null);
  const ttsPlaybackRef = useRef<TtsPlaybackQueue | null>(null);

  const load = useCallback(async () => {
    try {
      const [pr, mo, se, rt] = await Promise.all([
        api.listPlannerProviders(),
        api.listPlannerModels(),
        api.getPlannerSettings(),
        api.getSettings(),
      ]);
      setProviders(pr.providers);
      setHasLocalAgyAuth(Boolean(pr.hasLocalAgyAuth));
      setModels(mo.models);
      setPlannerSettings(se);
      setEmbeddingBaseUrlInput(se.embeddingBaseUrl ?? '');
      setEmbeddingModelIdInput(se.embeddingModelId ?? '');
      setRevealedEmbeddingApiKey(null);
      setEmbeddingTestResult(null);
      setRuntimeData(rt);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load Providers and Models settings.');
    }
  }, [api, onApiError]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!runtimeData?.settings.liveSttUrl) {
      setVoiceModels({ asr: [], tts: [] });
      return;
    }
    let cancelled = false;
    api
      .listVoiceModels()
      .then((res) => {
        if (cancelled) return;
        const asr = res.models.filter((m) => m.type === 'asr').map((m) => m.id);
        const tts = res.models.filter((m) => m.type === 'tts').map((m) => m.id);
        setVoiceModels({ asr, tts });
      })
      .catch(() => {
        // Fallback gracefully if live-stt is unreachable
      });
    return () => {
      cancelled = true;
    };
  }, [api, runtimeData?.settings.liveSttUrl]);

  useEffect(() => {
    return () => {
      ttsPlaybackRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    const timers = debounceTimers.current;
    return () => {
      for (const t of Object.values(timers)) clearTimeout(t);
    };
  }, []);

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

  const saveRuntime = useCallback(
    async (patch: UpdateSettingsRequest, keys: string[]) => {
      setPendingRuntime((prev) => new Set([...prev, ...keys]));
      try {
        const res = await api.updateSettings(patch);
        setRuntimeData(res);
        setError(null);
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not save.');
        void load();
      } finally {
        setPendingRuntime((prev) => {
          const next = new Set(prev);
          for (const k of keys) next.delete(k);
          return next;
        });
      }
    },
    [api, onApiError, load],
  );

  const saveRuntimeNow = useCallback(
    (key: keyof UpdateSettingsRequest, value: unknown) => {
      setRuntimeData((prev) =>
        prev ? ({ ...prev, settings: { ...prev.settings, [key]: value } as RuntimeSettings }) : prev,
      );
      void saveRuntime({ [key]: value } as UpdateSettingsRequest, [key]);
    },
    [saveRuntime],
  );

  const saveRuntimeDebounced = useCallback(
    (key: keyof UpdateSettingsRequest, value: unknown) => {
      setRuntimeData((prev) =>
        prev ? ({ ...prev, settings: { ...prev.settings, [key]: value } as RuntimeSettings }) : prev,
      );
      const timers = debounceTimers.current;
      const existing = timers[key as string];
      if (existing) clearTimeout(existing);
      timers[key as string] = setTimeout(() => {
        void saveRuntime({ [key]: value } as UpdateSettingsRequest, [key]);
      }, DEBOUNCE_MS);
    },
    [saveRuntime],
  );

  const runTestStt = async (): Promise<void> => {
    if (!runtimeData?.settings.liveSttUrl) return;
    setTestingStt(true);
    setSttResult(null);
    try {
      const res = await api.testVoiceStt({
        liveSttUrl: runtimeData.settings.liveSttUrl,
        model: runtimeData.settings.liveSttModel || undefined,
      });
      setSttResult({ ok: true, message: res.transcript, durationMs: res.durationMs });
    } catch (err) {
      setSttResult({
        ok: false,
        message: err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'STT test failed',
      });
    } finally {
      setTestingStt(false);
    }
  };

  const runTestTts = async (): Promise<void> => {
    if (!runtimeData?.settings.liveSttUrl) return;
    void unlockAudioContext();
    setTestingTts(true);
    setTtsResult(null);
    try {
      const res = await api.testVoiceTts({
        liveSttUrl: runtimeData.settings.liveSttUrl,
        model: runtimeData.settings.liveSttTtsModel || undefined,
      });
      setTtsResult({
        ok: true,
        message: `Playing audio (${res.sampleRateHz}Hz)`,
        durationMs: res.durationMs,
      });
      ttsPlaybackRef.current?.stop();
      const queue = new TtsPlaybackQueue((playing) => setPlayingTts(playing));
      ttsPlaybackRef.current = queue;
      queue.enqueue(res.audio, res.sampleRateHz);
    } catch (err) {
      setTtsResult({
        ok: false,
        message: err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'TTS test failed',
      });
    } finally {
      setTestingTts(false);
    }
  };

  const createProvider = (): void => {
    const label = newProviderLabel.trim();
    const baseUrl = newProviderBaseUrl.trim();
    const apiKey = newProviderApiKey.trim();
    const setupToken = newProviderSetupToken.trim();
    if (!label) {
      setError('Provider label is required.');
      return;
    }
    if (newProviderKind === 'openai-compatible' && !baseUrl) {
      setError('Base URL is required for API endpoint providers.');
      return;
    }
    void withBusy(async () => {
      if (newProviderKind === 'claude-oauth') {
        await api.createPlannerProvider({
          label,
          kind: 'claude-oauth',
          ...(baseUrl.length > 0 ? { baseUrl } : {}),
          ...(setupToken.length > 0 ? { setupToken } : {}),
        });
      } else if (newProviderKind === 'codex-oauth') {
        await api.createPlannerProvider({
          label,
          kind: 'codex-oauth',
          authMode: newProviderCodexAuthMode,
          ...(baseUrl.length > 0 ? { baseUrl } : {}),
        });
      } else if (newProviderKind === 'antigravity-oauth') {
        await api.createPlannerProvider({
          label,
          kind: 'antigravity-oauth',
          authMode: hasLocalAgyAuth ? newProviderAntigravityAuthMode : 'oauth',
          ...(baseUrl.length > 0 ? { baseUrl } : {}),
        });
      } else {
        await api.createPlannerProvider({
          label,
          kind: newProviderKind,
          ...(baseUrl.length > 0 ? { baseUrl } : {}),
          ...(apiKey.length > 0 ? { apiKey } : {}),
          endpoints: newProviderEndpoints.length > 0
            ? newProviderEndpoints
            : defaultEndpointsForProviderKind(newProviderKind),
        });
      }
      setNewProviderLabel('');
      setNewProviderBaseUrl('');
      setNewProviderApiKey('');
      setNewProviderEndpoints(['openai']);
      setNewProviderSetupToken('');
      setNewProviderCodexAuthMode('device-code');
      setNewProviderAntigravityAuthMode(hasLocalAgyAuth ? 'cli-import' : 'oauth');
      setNewProviderKind('openai-compatible');
      setAddingProvider(false);
    });
  };

  const confirmDeleteProvider = (): void => {
    const target = confirmingDeleteProvider;
    if (!target) return;
    setConfirmingDeleteProvider(null);
    void withBusy(async () => {
      await api.deletePlannerProvider(target.id);
    });
  };

  /**
   * PA-29 / PA-132: the embedding provider's own settings — deliberately a separate
   * base URL/API key/model from the chat endpoint.
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

  const setModelLimit = (id: string, patch: UpdatePlannerModelRequest): void => {
    void withBusy(async () => {
      await api.updatePlannerModel(id, patch);
      await load();
    });
  };

  const removeModel = (id: string): void => {
    void withBusy(() => api.deletePlannerModel(id));
  };

  const confirmDeleteAllModels = (): void => {
    const target = confirmingDeleteAllForProvider;
    setConfirmingDeleteAllForProvider(null);
    if (!target) return;
    void withBusy(async () => {
      await api.deleteAllPlannerModels(target.id);
      setTestResults({});
    });
  };

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

  const testAllProviderModels = (providerId: string, providerModels: PlannerModel[]): void => {
    if (providerModels.length === 0) return;
    setTestingProviderId(providerId);
    void Promise.all(providerModels.map((m) => runModelTest(m.id))).finally(() =>
      setTestingProviderId(null),
    );
  };

  const handleReorderProviders = useCallback(
    (orderedIds: string[]) => {
      const currentProviders = providers ?? [];
      const map = new Map(currentProviders.map((p) => [p.id, p]));
      const next: PlannerProvider[] = [];
      for (const id of orderedIds) {
        const p = map.get(id);
        if (p) next.push(p);
      }
      for (const p of currentProviders) {
        if (!orderedIds.includes(p.id)) next.push(p);
      }
      setProviders(next);

      void (async () => {
        try {
          await api.reorderPlannerProviders(orderedIds);
        } catch (err) {
          onApiError(err);
          setError(err instanceof ApiError ? err.message : 'Could not reorder providers.');
          await load();
        }
      })();
    },
    [api, providers, onApiError, load],
  );

  const handleMoveProvider = useCallback(
    (providerId: string, direction: 'up' | 'down') => {
      const currentProviders = providers ?? [];
      const idx = currentProviders.findIndex((p) => p.id === providerId);
      if (idx === -1) return;
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= currentProviders.length) return;
      const next = [...currentProviders];
      const [moved] = next.splice(idx, 1);
      if (!moved) return;
      next.splice(targetIdx, 0, moved);
      handleReorderProviders(next.map((p) => p.id));
    },
    [providers, handleReorderProviders],
  );

  const handleReorderModels = useCallback(
    (providerId: string, orderedModelIds: string[]) => {
      const currentModels = models ?? [];
      const providerModels = currentModels.filter(
        (m) =>
          m.providerId === providerId ||
          (!m.providerId && (providers ?? [])[0]?.id === providerId),
      );
      const providerModelMap = new Map(providerModels.map((m) => [m.id, m]));
      const reorderedForProvider: PlannerModel[] = [];
      for (const id of orderedModelIds) {
        const m = providerModelMap.get(id);
        if (m) reorderedForProvider.push(m);
      }
      for (const m of providerModels) {
        if (!orderedModelIds.includes(m.id)) reorderedForProvider.push(m);
      }

      let idx = 0;
      const nextModels: PlannerModel[] = currentModels.map((m) => {
        if (
          m.providerId === providerId ||
          (!m.providerId && (providers ?? [])[0]?.id === providerId)
        ) {
          const replacement = reorderedForProvider[idx++];
          return replacement ?? m;
        }
        return m;
      });
      setModels(nextModels);

      void (async () => {
        try {
          await api.reorderPlannerProviderModels(providerId, orderedModelIds);
        } catch (err) {
          onApiError(err);
          setError(err instanceof ApiError ? err.message : 'Could not reorder models.');
          await load();
        }
      })();
    },
    [api, models, providers, onApiError, load],
  );

  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  const handleExportProvider = (provider: PlannerProvider): void => {
    try {
      const payload = exportPlannerProviderPayload(provider, models ?? []);
      exportToJsonFile('planner-provider', payload, provider.label);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not export provider.');
    }
  };

  const { trigger: triggerImportProvider, fileInputProps: providerFileInputProps } =
    useJsonImport<PlannerProviderTemplatePayload>({
      expectedKind: 'planner-provider',
      onSuccess: async ({ data: imported }) => {
        try {
          setError(null);
          setImportSuccess(null);
          setBusy(true);
          const currentProviders = providers ?? [];
          // Match an existing provider with the same label + baseUrl, or an
          // unconfigured Default provider when importing "Default".
          const existingProvider =
            currentProviders.find(
              (p) => p.label === imported.label && p.baseUrl === imported.baseUrl,
            ) ??
            (imported.label === 'Default'
              ? currentProviders.find((p) => p.label === 'Default' && !p.baseUrl)
              : undefined);
          const targetProvider = existingProvider
            ? await api.updatePlannerProvider(existingProvider.id, {
                label: imported.label,
                baseUrl: imported.baseUrl,
                allowUnattended: imported.allowUnattended,
                ...(imported.endpoints !== undefined ? { endpoints: imported.endpoints } : {}),
              })
            : await api.createPlannerProvider({
                label: imported.label,
                kind: imported.kind ?? 'openai-compatible',
                baseUrl: imported.baseUrl,
                allowUnattended: imported.allowUnattended,
                ...(imported.endpoints !== undefined ? { endpoints: imported.endpoints } : {}),
              });
          const existingModelIds = new Set(
            (models ?? [])
              .filter((m) => m.providerId === targetProvider.id)
              .map((m) => m.modelId),
          );
          for (const m of imported.models) {
            if (!existingModelIds.has(m.modelId)) {
              await api.createPlannerModel({
                ...m,
                providerId: targetProvider.id,
              });
            }
          }
          await load();
          setImportSuccess(`Pocket Agent provider "${targetProvider.label}" imported successfully.`);
        } catch (err) {
          setError(err instanceof ApiError ? err.message : 'Could not import provider settings.');
        } finally {
          setBusy(false);
        }
      },
      onError: (err) => {
        setError(err);
        setImportSuccess(null);
      },
    });

  const runtimeBusy = (key: string): boolean => pendingRuntime.has(key);
  const runtimeSettings = runtimeData?.settings;
  const exportableProvider = (providers ?? []).find(
    (p) => isApiKeyProviderKind(p.kind) && p.baseUrl.trim().length > 0,
  );

  return (
    <div className="planner-page">
      <input {...providerFileInputProps} />
      <div className="planner-head">
        <div>
          <h2>Providers and Models</h2>
          <p className="planner-sub">
            Pocket Agent LLM providers and model catalogs, embeddings, TTS/STT voice pipeline, and Gemini Live.
          </p>
        </div>
        <div className="planner-head-actions">
          <button
            type="button"
            className="planner-btn icon-only"
            disabled={!exportableProvider || !exportableProvider.baseUrl}
            onClick={() => exportableProvider && handleExportProvider(exportableProvider)}
            title="Export Pocket Agent provider and models to JSON"
            aria-label="Export Pocket Agent provider and models to JSON"
          >
            <Icon name="download" size={16} />
          </button>
          <button
            type="button"
            className="planner-btn icon-only"
            onClick={triggerImportProvider}
            title="Import Pocket Agent provider and models from JSON"
            aria-label="Import Pocket Agent provider and models from JSON"
          >
            <Icon name="upload" size={16} />
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
            <div className="planner-section-header">
              <h3>Pocket Agent Providers</h3>
              <div className="planner-section-actions">
                <button
                  type="button"
                  className="planner-btn"
                  disabled={busy}
                  onClick={() => setAddingProvider((v) => !v)}
                >
                  <Icon name="plus" size={14} /> {addingProvider ? 'Cancel' : 'Add provider'}
                </button>
              </div>
            </div>
            <p className="planner-row-meta" style={{ marginBottom: 10 }}>
              Configure one or more OpenAI-compatible LLM providers (for example a local vLLM and
              OpenRouter side by side), a Claude subscription provider (setup-token / OAuth), a
              Codex (ChatGPT) subscription provider (device-code / <code>~/.codex/auth.json</code>),
              or an Antigravity (Google) subscription provider (signed-in <code>agy</code> CLI /
              Google OAuth). Each provider has its own encrypted credential and model catalog.
            </p>

            {(addingProvider || (providers !== null && providers.length === 0)) && (
              <div className="planner-provider-add-form" style={{ marginBottom: 16 }}>
                <h4>New provider</h4>
                <div className="planner-field">
                  <label htmlFor="new-provider-kind">Kind</label>
                  <select
                    id="new-provider-kind"
                    value={newProviderKind}
                    disabled={busy}
                    onChange={(e) => {
                      const nextKind = e.target.value as PlannerProviderKind;
                      setNewProviderKind(nextKind);
                      setNewProviderEndpoints(defaultEndpointsForProviderKind(nextKind));
                      if (nextKind === 'deepseek') {
                        if (!newProviderLabel.trim()) {
                          setNewProviderLabel('DeepSeek');
                        }
                        setNewProviderBaseUrl(DEEPSEEK_PROVIDER_DEFAULTS.baseUrl);
                      } else if (nextKind === 'opencode-zen') {
                        if (!newProviderLabel.trim()) {
                          setNewProviderLabel('OpenCode Zen');
                        }
                        setNewProviderBaseUrl(OPENCODE_ZEN_PROVIDER_DEFAULTS.baseUrl);
                      } else if (nextKind === 'opencode-go') {
                        if (!newProviderLabel.trim()) {
                          setNewProviderLabel('OpenCode Go');
                        }
                        setNewProviderBaseUrl(OPENCODE_GO_PROVIDER_DEFAULTS.baseUrl);
                      } else if (nextKind === 'claude-oauth' && !newProviderLabel.trim()) {
                        setNewProviderLabel('Claude Subscription');
                      } else if (nextKind === 'codex-oauth' && !newProviderLabel.trim()) {
                        setNewProviderLabel('Codex Subscription');
                      } else if (nextKind === 'antigravity-oauth') {
                        if (!newProviderLabel.trim()) {
                          setNewProviderLabel('Antigravity Subscription');
                        }
                        setNewProviderAntigravityAuthMode(hasLocalAgyAuth ? 'cli-import' : 'oauth');
                      }
                    }}
                  >
                    <option value="openai-compatible">API endpoint (OpenAI / Anthropic compatible)</option>
                    <option value="deepseek">DeepSeek (OpenAI + Anthropic)</option>
                    <option value="opencode-zen">OpenCode Zen (OpenAI + Anthropic)</option>
                    <option value="opencode-go">OpenCode Go (OpenAI + Anthropic)</option>
                    <option value="claude-oauth">Claude subscription (setup-token / OAuth)</option>
                    <option value="codex-oauth">Codex (ChatGPT) subscription (device-code / ~/.codex/auth.json)</option>
                    <option value="antigravity-oauth">Antigravity (Google) subscription (signed-in agy CLI / Google OAuth)</option>
                  </select>
                </div>
                <div className="planner-field" style={{ marginTop: 8 }}>
                  <label htmlFor="new-provider-label">Label</label>
                  <input
                    id="new-provider-label"
                    type="text"
                    placeholder={
                      newProviderKind === 'deepseek'
                        ? 'e.g. DeepSeek'
                        : newProviderKind === 'opencode-zen'
                          ? 'e.g. OpenCode Zen'
                          : newProviderKind === 'opencode-go'
                            ? 'e.g. OpenCode Go'
                            : newProviderKind === 'claude-oauth'
                              ? 'e.g. Claude Subscription'
                              : newProviderKind === 'codex-oauth'
                                ? 'e.g. Codex Subscription'
                                : newProviderKind === 'antigravity-oauth'
                                  ? 'e.g. Antigravity Subscription'
                                  : 'e.g. OpenRouter, OmniRoute, Anthropic API, Local vLLM'
                    }
                    value={newProviderLabel}
                    disabled={busy}
                    onChange={(e) => setNewProviderLabel(e.target.value)}
                  />
                </div>
                {newProviderKind === 'claude-oauth' ? (
                  <>
                    <div className="warn-callout" role="note" style={{ marginTop: 8 }}>
                      {CLAUDE_OAUTH_PROVIDER_DISCLOSURE}
                    </div>
                    <div className="planner-field" style={{ marginTop: 8 }}>
                      <label htmlFor="new-provider-setup-token">
                        Setup token from <code>claude setup-token</code> (recommended, optional on create)
                      </label>
                      <input
                        id="new-provider-setup-token"
                        type="password"
                        autoComplete="off"
                        placeholder="Paste token from claude setup-token (validated live before saving, or leave blank to use OAuth)"
                        value={newProviderSetupToken}
                        disabled={busy}
                        onChange={(e) => setNewProviderSetupToken(e.target.value)}
                      />
                      <span className="planner-row-meta">
                        Run <code>claude setup-token</code> in a terminal to mint an inference-only token
                        (~1 year, no refresh token, no conflict with the <code>claude</code> CLI&apos;s own
                        login). Or leave blank and sign in via OAuth after creating the provider.
                      </span>
                    </div>
                  </>
                ) : newProviderKind === 'codex-oauth' ? (
                  <>
                    <div className="warn-callout" role="note" style={{ marginTop: 8 }}>
                      {CODEX_OAUTH_PROVIDER_DISCLOSURE}
                    </div>
                    <div className="planner-field" style={{ marginTop: 8 }}>
                      <label htmlFor="new-provider-codex-auth-mode">Credential source</label>
                      <select
                        id="new-provider-codex-auth-mode"
                        value={newProviderCodexAuthMode}
                        disabled={busy}
                        onChange={(e) =>
                          setNewProviderCodexAuthMode(e.target.value as 'device-code' | 'cli-readonly')
                        }
                      >
                        <option value="device-code">
                          Device-code login (sign in at auth.openai.com/codex/device after creating)
                        </option>
                        <option value="cli-readonly">
                          Read ~/.codex/auth.json read-only (re-read on every request, never modified)
                        </option>
                      </select>
                      <span className="planner-row-meta">
                        Device-code login stores encrypted credentials in PocketAgent and rotates refresh
                        tokens automatically (~5 minutes before expiry). Read-only CLI mode reads{' '}
                        <code>~/.codex/auth.json</code> on every request without ever writing or refreshing
                        that file.
                      </span>
                    </div>
                  </>
                ) : newProviderKind === 'antigravity-oauth' ? (
                  <>
                    <div className="warn-callout" role="note" style={{ marginTop: 8 }}>
                      {ANTIGRAVITY_OAUTH_PROVIDER_DISCLOSURE}
                    </div>
                    <div className="planner-field" style={{ marginTop: 8 }}>
                      <label htmlFor="new-provider-antigravity-auth-mode">Credential source</label>
                      <select
                        id="new-provider-antigravity-auth-mode"
                        value={hasLocalAgyAuth ? newProviderAntigravityAuthMode : 'oauth'}
                        disabled={busy}
                        onChange={(e) =>
                          setNewProviderAntigravityAuthMode(e.target.value as 'cli-import' | 'oauth')
                        }
                      >
                        {hasLocalAgyAuth && (
                          <option value="cli-import">
                            Use the signed-in Antigravity CLI (~/.gemini/antigravity-cli/antigravity-oauth-token)
                          </option>
                        )}
                        <option value="oauth">
                          Sign in with Google OAuth (paste loopback redirect URL after creating)
                        </option>
                      </select>
                      <span className="planner-row-meta">
                        {hasLocalAgyAuth
                          ? 'Reuses the signed-in agy CLI refresh token on this host (strictly read-only — never modifies the CLI token file) and refreshes PocketAgent’s own encrypted access token.'
                          : 'No local ~/.gemini/antigravity-cli/antigravity-oauth-token found on this host — sign in with Google OAuth after creating the provider.'}
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="planner-field" style={{ marginTop: 8 }}>
                      <label htmlFor="new-provider-base-url">Base URL</label>
                      <input
                        id="new-provider-base-url"
                        type="text"
                        placeholder={
                          newProviderKind === 'deepseek'
                            ? DEEPSEEK_PROVIDER_DEFAULTS.baseUrl
                            : newProviderKind === 'opencode-zen'
                              ? OPENCODE_ZEN_PROVIDER_DEFAULTS.baseUrl
                              : newProviderKind === 'opencode-go'
                                ? OPENCODE_GO_PROVIDER_DEFAULTS.baseUrl
                                : newProviderEndpoints.includes('anthropic') &&
                                    !newProviderEndpoints.includes('openai')
                                  ? 'https://api.anthropic.com'
                                  : 'https://openrouter.ai/api/v1'
                        }
                        value={newProviderBaseUrl}
                        disabled={busy}
                        onChange={(e) => setNewProviderBaseUrl(e.target.value)}
                      />
                    </div>
                    <div className="planner-field" style={{ marginTop: 8 }}>
                      <label>Endpoints</label>
                      <div className="planner-inline" style={{ gap: 16, flexWrap: 'wrap' }}>
                        <label className="planner-inline-checkbox">
                          <input
                            type="checkbox"
                            checked={newProviderEndpoints.includes('openai')}
                            disabled={busy}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setNewProviderEndpoints((prev) => {
                                if (checked) {
                                  return prev.includes('openai') ? prev : ['openai', ...prev];
                                }
                                const next = prev.filter((ep) => ep !== 'openai');
                                return next.length > 0 ? next : prev;
                              });
                            }}
                          />
                          <span>OpenAI (<code>/v1/chat/completions</code>)</span>
                        </label>
                        <label className="planner-inline-checkbox">
                          <input
                            type="checkbox"
                            checked={newProviderEndpoints.includes('anthropic')}
                            disabled={busy}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setNewProviderEndpoints((prev) => {
                                if (checked) {
                                  return prev.includes('anthropic') ? prev : [...prev, 'anthropic'];
                                }
                                const next = prev.filter((ep) => ep !== 'anthropic');
                                return next.length > 0 ? next : prev;
                              });
                            }}
                          />
                          <span>Anthropic (<code>/v1/messages</code>)</span>
                        </label>
                      </div>
                      <span className="planner-row-meta">
                        Pocket Agent uses OpenAI unless only Anthropic is checked. Providers with Anthropic
                        checked are also selectable in Custom Claude.
                      </span>
                    </div>
                    <div className="planner-field" style={{ marginTop: 8 }}>
                      <label htmlFor="new-provider-api-key">API key (optional, write-only)</label>
                      <input
                        id="new-provider-api-key"
                        type="password"
                        autoComplete="off"
                        placeholder="sk-…"
                        value={newProviderApiKey}
                        disabled={busy}
                        onChange={(e) => setNewProviderApiKey(e.target.value)}
                      />
                    </div>
                  </>
                )}
                <div className="planner-inline" style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    className="planner-btn"
                    disabled={
                      busy ||
                      !newProviderLabel.trim() ||
                      (newProviderKind === 'openai-compatible' && !newProviderBaseUrl.trim())
                    }
                    onClick={createProvider}
                  >
                    Create provider
                  </button>
                </div>
              </div>
            )}
          </div>

          {providers?.map((provider, idx) => {
            const providerModels = (models ?? []).filter(
              (m) => m.providerId === provider.id || (!m.providerId && idx === 0),
            );
            return (
              <PlannerProviderSection
                key={provider.id}
                api={api}
                provider={provider}
                hasLocalAgyAuth={hasLocalAgyAuth}
                models={providerModels}
                busy={busy}
                testingAll={testingProviderId === provider.id}
                testResults={testResults}
                isDragging={draggingProviderId === provider.id}
                isDragOver={dragOverProviderId === provider.id}
                onDragStartProvider={(e) => {
                  e.dataTransfer.setData('text/plain', provider.id);
                  e.dataTransfer.setData('application/x-pocketagent-provider-id', provider.id);
                  e.dataTransfer.effectAllowed = 'move';
                  setDraggingProviderId(provider.id);
                }}
                onDragOverProvider={(e) => {
                  if (Array.from(e.dataTransfer.types).includes('application/x-pocketagent-provider-id')) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (dragOverProviderId !== provider.id) {
                      setDragOverProviderId(provider.id);
                    }
                  }
                }}
                onDragLeaveProvider={() => {
                  if (dragOverProviderId === provider.id) {
                    setDragOverProviderId(null);
                  }
                }}
                onDropProvider={(e) => {
                  e.preventDefault();
                  const sourceProviderId = e.dataTransfer.getData('application/x-pocketagent-provider-id');
                  setDraggingProviderId(null);
                  setDragOverProviderId(null);
                  if (!sourceProviderId || sourceProviderId === provider.id) return;
                  const currentProviders = providers ?? [];
                  const sourceIdx = currentProviders.findIndex((p) => p.id === sourceProviderId);
                  const targetIdx = currentProviders.findIndex((p) => p.id === provider.id);
                  if (sourceIdx === -1 || targetIdx === -1) return;
                  const next = [...currentProviders];
                  const [moved] = next.splice(sourceIdx, 1);
                  if (!moved) return;
                  next.splice(targetIdx, 0, moved);
                  handleReorderProviders(next.map((p) => p.id));
                }}
                onDragEndProvider={() => {
                  setDraggingProviderId(null);
                  setDragOverProviderId(null);
                }}
                onMoveProviderUp={() => handleMoveProvider(provider.id, 'up')}
                onMoveProviderDown={() => handleMoveProvider(provider.id, 'down')}
                onReorderModels={handleReorderModels}
                onSaveProvider={(patch) =>
                  withBusy(() => api.updatePlannerProvider(provider.id, patch))
                }
                onReload={load}
                onDeleteProvider={() => setConfirmingDeleteProvider(provider)}
                onExportProvider={() => handleExportProvider(provider)}
                onDiscoverModels={() => api.discoverPlannerProviderModels(provider.id)}
                onAddModel={(input) =>
                  withBusy(() =>
                    api.createPlannerModel({
                      providerId: provider.id,
                      modelId: input.modelId,
                      label: input.label,
                      supportsEffort: input.supportsEffort,
                    }),
                  )
                }
                onSetModelLimit={setModelLimit}
                onRemoveModel={removeModel}
                onDeleteAllModels={() => setConfirmingDeleteAllForProvider(provider)}
                onTestModel={testModel}
                onTestAllModels={() => testAllProviderModels(provider.id, providerModels)}
                onApiError={onApiError}
                onError={setError}
              />
            );
          })}
        </div>

        <div className="planner-col">
          <div className="planner-section">
            <h3>Embeddings</h3>
            <p className="planner-row-meta" style={{ marginBottom: 10 }}>
              A separate provider from the chat endpoint — its own base URL, API key, and
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
                {plannerSettings?.embeddingBaseUrl ? 'Configured' : 'Not configured'}
              </span>
            </div>

            <div className="planner-field" style={{ marginTop: 12 }}>
              <label htmlFor="planner-embedding-api-key">API key</label>
              <input
                id="planner-embedding-api-key"
                type="password"
                placeholder={plannerSettings?.embeddingHasApiKey ? '••••••••  (leave blank to keep)' : 'sk-…'}
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
                disabled={busy || !plannerSettings?.embeddingHasApiKey}
                onClick={revealEmbeddingKey}
              >
                Reveal
              </button>
              <span className="planner-row-meta">
                {plannerSettings?.embeddingHasApiKey ? 'A key is configured' : 'No key configured'}
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
                disabled={testingEmbeddings || !plannerSettings?.embeddingBaseUrl || !plannerSettings?.embeddingModelId}
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
            <h3>TTS / STT</h3>
            <p className="planner-row-meta" style={{ marginBottom: 10 }}>
              Self-hosted live-stt service used for push-to-talk transcription, live-listen voice turns,
              and spoken-summary talk-back across sessions and Pocket Agents.
            </p>
            {!runtimeSettings ? (
              <div className="spinner">Loading…</div>
            ) : (
              <div>
                <TextRow
                  label="Live STT URL"
                  help="Base URL of the self-hosted live-stt service's HTTP admin port (PA-20). Reachable only from this server, never the browser. Blank hides the voice-input mic button entirely."
                  placeholder="http://10.100.0.50:8000"
                  value={runtimeSettings.liveSttUrl}
                  busy={runtimeBusy('liveSttUrl')}
                  onChange={(v) => saveRuntimeDebounced('liveSttUrl', v)}
                />
                <TextRow
                  label="STT Model"
                  help="Model name for Speech-to-Text (e.g. whisper-large-v3-turbo-q8_0, realtime_eou_120m-v1). Blank uses live-stt's configured default model."
                  placeholder="realtime_eou_120m-v1 (default)"
                  value={runtimeSettings.liveSttModel}
                  busy={runtimeBusy('liveSttModel')}
                  listId="stt-models-list"
                  onChange={(v) => saveRuntimeDebounced('liveSttModel', v)}
                >
                  <datalist id="stt-models-list">
                    {voiceModels.asr.map((id) => (
                      <option key={id} value={id} />
                    ))}
                  </datalist>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
                    <button
                      type="button"
                      className="planner-btn"
                      disabled={testingStt || !runtimeSettings.liveSttUrl}
                      onClick={() => void runTestStt()}
                    >
                      {testingStt ? 'Testing STT…' : 'Test STT'}
                    </button>
                    {sttResult && (
                      <span
                        className={sttResult.ok ? 'planner-test-ok' : 'planner-test-fail'}
                        style={{ fontSize: '13px' }}
                      >
                        {sttResult.ok
                          ? `✓ (${sttResult.durationMs}ms): "${sttResult.message}"`
                          : `✗ ${sttResult.message}`}
                      </span>
                    )}
                  </div>
                </TextRow>
                <TextRow
                  label="TTS Model"
                  help="Model name for Text-to-Speech (e.g. kokoro-82m-v1, piper-en-us). Blank uses live-stt's configured default model."
                  placeholder="kokoro-82m-v1 (default)"
                  value={runtimeSettings.liveSttTtsModel}
                  busy={runtimeBusy('liveSttTtsModel')}
                  listId="tts-models-list"
                  onChange={(v) => saveRuntimeDebounced('liveSttTtsModel', v)}
                >
                  <datalist id="tts-models-list">
                    {voiceModels.tts.map((id) => (
                      <option key={id} value={id} />
                    ))}
                  </datalist>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
                    <button
                      type="button"
                      className="planner-btn"
                      disabled={testingTts || playingTts || !runtimeSettings.liveSttUrl}
                      onClick={() => void runTestTts()}
                    >
                      {testingTts ? 'Testing TTS…' : playingTts ? 'Playing…' : 'Test TTS'}
                    </button>
                    {ttsResult && (
                      <span
                        className={ttsResult.ok ? 'planner-test-ok' : 'planner-test-fail'}
                        style={{ fontSize: '13px' }}
                      >
                        {ttsResult.ok
                          ? `✓ (${ttsResult.durationMs}ms): ${ttsResult.message}`
                          : `✗ ${ttsResult.message}`}
                      </span>
                    )}
                  </div>
                </TextRow>
                <NumberRow
                  label="Live-listen sensitivity"
                  help="1 (least sensitive — needs louder, clearer speech) to 10 (most sensitive — picks up quieter speech). 5 is the original, unconfigurable default."
                  value={runtimeSettings.voiceTurnSensitivity}
                  min={1}
                  max={10}
                  busy={runtimeBusy('voiceTurnSensitivity')}
                  onChange={(v) => saveRuntimeDebounced('voiceTurnSensitivity', v)}
                />
                <NumberRow
                  label="Live-listen silence before turn ends"
                  unit="ms"
                  help="How long the mic must stay quiet before live-listen mode treats what you said as finished and sends it. Lower ends a turn sooner but risks cutting off a mid-sentence pause."
                  value={runtimeSettings.voiceTurnSilenceMs}
                  min={200}
                  max={3000}
                  busy={runtimeBusy('voiceTurnSilenceMs')}
                  onChange={(v) => saveRuntimeDebounced('voiceTurnSilenceMs', v)}
                />
                <BoolRow
                  label="Spoken summary for talk-back"
                  help="Asks the agent to open a voice turn with a short, spoken-friendly summary that talk-back reads instead of the written reply. Code blocks, file paths and URLs are left out of speech either way — turning this off only stops the request being added to your prompt."
                  checked={runtimeSettings.voiceSpokenSummaryEnabled}
                  busy={runtimeBusy('voiceSpokenSummaryEnabled')}
                  onChange={(v) => saveRuntimeNow('voiceSpokenSummaryEnabled', v)}
                />
              </div>
            )}
          </div>

          <GeminiLiveSettingsSection onApiError={onApiError} />
        </div>
      </div>

      {confirmingDeleteProvider && (
        <ConfirmDialog
          title={`Delete provider "${confirmingDeleteProvider.label}"?`}
          body="Deleting a provider also deletes all models attached to it."
          confirmLabel={busy ? 'Deleting…' : 'Delete provider'}
          busy={busy}
          onConfirm={confirmDeleteProvider}
          onCancel={() => setConfirmingDeleteProvider(null)}
        />
      )}

      {confirmingDeleteAllForProvider && (
        <ConfirmDialog
          title={`Delete all models for "${confirmingDeleteAllForProvider.label}"?`}
          body="This only empties this provider's model catalog. Chats and agents keep whatever model reference they already had."
          confirmLabel={busy ? 'Deleting…' : 'Delete all'}
          busy={busy}
          onConfirm={confirmDeleteAllModels}
          onCancel={() => setConfirmingDeleteAllForProvider(null)}
        />
      )}
    </div>
  );
}

export interface PlannerProviderSectionProps {
  api: ApiClient;
  provider: PlannerProvider;
  hasLocalAgyAuth: boolean;
  models: PlannerModel[];
  busy: boolean;
  testingAll: boolean;
  testResults: Record<string, TestPlannerModelResponse | 'testing'>;
  initialExpanded?: boolean;
  initialModelsExpanded?: boolean;
  isDragging?: boolean;
  isDragOver?: boolean;
  onDragStartProvider?: (e: React.DragEvent) => void;
  onDragOverProvider?: (e: React.DragEvent) => void;
  onDragLeaveProvider?: (e: React.DragEvent) => void;
  onDropProvider?: (e: React.DragEvent) => void;
  onDragEndProvider?: (e: React.DragEvent) => void;
  onMoveProviderUp?: () => void;
  onMoveProviderDown?: () => void;
  onReorderModels?: (providerId: string, orderedModelIds: string[]) => void;
  onSaveProvider: (patch: {
    label?: string;
    baseUrl?: string;
    apiKey?: string;
    endpoints?: PlannerProviderEndpoint[];
    setupToken?: string;
    authMode?: 'device-code' | 'cli-readonly' | 'cli-import' | 'oauth';
    clearApiKey?: boolean;
    allowUnattended?: boolean;
  }) => void;
  onReload: () => Promise<void>;
  onDeleteProvider: () => void;
  onExportProvider: () => void;
  onDiscoverModels: () => Promise<{ modelIds: string[] }>;
  onAddModel: (input: { modelId: string; label: string; supportsEffort: boolean }) => void;
  onSetModelLimit: (id: string, patch: UpdatePlannerModelRequest) => void;
  onRemoveModel: (id: string) => void;
  onDeleteAllModels: () => void;
  onTestModel: (id: string) => void;
  onTestAllModels: () => void;
  onApiError: (error: unknown) => void;
  onError: (message: string | null) => void;
}

export function PlannerProviderSection({
  api,
  provider,
  hasLocalAgyAuth,
  models,
  busy,
  testingAll,
  testResults,
  initialExpanded = true,
  initialModelsExpanded = true,
  isDragging = false,
  isDragOver = false,
  onDragStartProvider,
  onDragOverProvider,
  onDragLeaveProvider,
  onDropProvider,
  onDragEndProvider,
  onMoveProviderUp,
  onMoveProviderDown,
  onReorderModels,
  onSaveProvider,
  onReload,
  onDeleteProvider,
  onExportProvider,
  onDiscoverModels,
  onAddModel,
  onSetModelLimit,
  onRemoveModel,
  onDeleteAllModels,
  onTestModel,
  onTestAllModels,
  onApiError,
  onError,
}: PlannerProviderSectionProps): JSX.Element {
  const sectionRef = useRef<HTMLDivElement | null>(null);
  const [draggingModelId, setDraggingModelId] = useState<string | null>(null);
  const [dragOverModelId, setDragOverModelId] = useState<string | null>(null);

  const handleMoveModel = (modelId: string, direction: 'up' | 'down') => {
    const idx = models.findIndex((m) => m.id === modelId);
    if (idx === -1) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= models.length) return;
    const next = [...models];
    const [moved] = next.splice(idx, 1);
    if (!moved) return;
    next.splice(targetIdx, 0, moved);
    onReorderModels?.(provider.id, next.map((m) => m.id));
  };
  const isClaudeOAuth = provider.kind === 'claude-oauth';
  const isCodexOAuth = provider.kind === 'codex-oauth';
  const isAntigravityOAuth = provider.kind === 'antigravity-oauth';
  const isSubscriptionOAuth = isClaudeOAuth || isCodexOAuth || isAntigravityOAuth;
  const [providerExpanded, setProviderExpanded] = useState(initialExpanded);
  const [modelsExpanded, setModelsExpanded] = useState(initialModelsExpanded);
  const [labelInput, setLabelInput] = useState(provider.label);
  const [baseUrlInput, setBaseUrlInput] = useState(provider.baseUrl);
  const [endpointsInput, setEndpointsInput] = useState<PlannerProviderEndpoint[]>(
    provider.endpoints?.length
      ? provider.endpoints
      : defaultEndpointsForProviderKind(provider.kind),
  );
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [setupTokenInput, setSetupTokenInput] = useState('');
  const [oauthAuthorize, setOauthAuthorize] = useState<ClaudeOAuthAuthorizeResponse | null>(null);
  const [oauthCodeInput, setOauthCodeInput] = useState('');
  const [oauthBusy, setOauthBusy] = useState(false);
  const [importingAgyCli, setImportingAgyCli] = useState(false);
  const [codexDeviceSession, setCodexDeviceSession] = useState<{
    deviceAuthId: string;
    userCode: string;
    verificationUri: string;
    intervalSec: number;
    mode: 'server' | 'browser';
    fallbackReason: string | null;
  } | null>(null);
  const [codexDeviceBusy, setCodexDeviceBusy] = useState(false);
  const codexPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const codexPollCancelledRef = useRef(false);
  const [usage, setUsage] = useState<ClaudeProviderUsageResponse | null>(null);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [newModelId, setNewModelId] = useState('');
  const [newModelLabel, setNewModelLabel] = useState('');
  const [newModelSupportsEffort, setNewModelSupportsEffort] = useState(true);
  const [suggestionsOpen, setSuggestionsOpen] = useState(true);
  const newModelLabelInputRef = useRef<HTMLInputElement | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverMessage, setDiscoverMessage] = useState<string | null>(null);
  const [discoveredIds, setDiscoveredIds] = useState<string[]>(() => {
    if (isAntigravityOAuth) return [...ANTIGRAVITY_SUGGESTED_MODELS];
    if (provider.kind === 'deepseek') return [...DEEPSEEK_PROVIDER_DEFAULTS.defaultModels];
    if (provider.kind === 'opencode-zen') return [...OPENCODE_ZEN_PROVIDER_DEFAULTS.defaultModels];
    if (provider.kind === 'opencode-go') return [...OPENCODE_GO_PROVIDER_DEFAULTS.defaultModels];
    return [];
  });

  useEffect(() => {
    setLabelInput(provider.label);
    setBaseUrlInput(provider.baseUrl);
    setEndpointsInput(
      provider.endpoints?.length
        ? provider.endpoints
        : defaultEndpointsForProviderKind(provider.kind),
    );
  }, [provider.label, provider.baseUrl, provider.endpoints, provider.kind]);

  useEffect(() => {
    return () => {
      codexPollCancelledRef.current = true;
      if (codexPollTimerRef.current) clearTimeout(codexPollTimerRef.current);
    };
  }, []);

  const stopCodexDevicePolling = (): void => {
    codexPollCancelledRef.current = true;
    if (codexPollTimerRef.current) {
      clearTimeout(codexPollTimerRef.current);
      codexPollTimerRef.current = null;
    }
    setCodexDeviceSession(null);
    setCodexDeviceBusy(false);
  };

  const saveProvider = (): void => {
    const trimmedLabel = labelInput.trim();
    const trimmedBaseUrl = baseUrlInput.trim();
    const trimmedKey = apiKeyInput.trim();
    const trimmedSetupToken = setupTokenInput.trim();
    if (!trimmedLabel || (!isSubscriptionOAuth && !trimmedBaseUrl)) {
      onError(
        isSubscriptionOAuth
          ? 'Provider label is required.'
          : 'Provider label and base URL are required.',
      );
      return;
    }
    onSaveProvider({
      label: trimmedLabel,
      ...(trimmedBaseUrl.length > 0 ? { baseUrl: trimmedBaseUrl } : {}),
      ...(!isSubscriptionOAuth && trimmedKey.length > 0 ? { apiKey: trimmedKey } : {}),
      ...(!isSubscriptionOAuth && endpointsInput.length > 0 ? { endpoints: endpointsInput } : {}),
      ...(isClaudeOAuth && trimmedSetupToken.length > 0 ? { setupToken: trimmedSetupToken } : {}),
    });
    setApiKeyInput('');
    setSetupTokenInput('');
  };

  const toggleEndpoint = (endpoint: PlannerProviderEndpoint, checked: boolean): void => {
    const next: PlannerProviderEndpoint[] = checked
      ? endpointsInput.includes(endpoint)
        ? endpointsInput
        : endpoint === 'openai'
          ? ['openai', ...endpointsInput]
          : [...endpointsInput, 'anthropic']
      : endpointsInput.filter((ep) => ep !== endpoint);
    if (next.length === 0) return;
    setEndpointsInput(next);
    onSaveProvider({ endpoints: next });
  };

  const clearApiKey = (): void => {
    stopCodexDevicePolling();
    onSaveProvider({ clearApiKey: true });
    setApiKeyInput('');
    setSetupTokenInput('');
    setUsage(null);
  };

  const toggleAllowUnattended = (next: boolean): void => {
    onSaveProvider({ allowUnattended: next });
  };

  const startOAuth = (): void => {
    setOauthBusy(true);
    onError(null);
    void (async () => {
      try {
        const res = await api.authorizeClaudePlannerProvider(provider.id);
        setOauthAuthorize(res);
        setOauthCodeInput('');
        window.open(res.authorizeUrl, '_blank', 'noopener,noreferrer');
      } catch (err) {
        onApiError(err);
        onError(
          err instanceof ApiError
            ? err.message
            : `Could not start ${isAntigravityOAuth ? 'Google' : 'Claude'} OAuth sign-in.`,
        );
      } finally {
        setOauthBusy(false);
      }
    })();
  };

  const completeOAuth = (): void => {
    if (!oauthAuthorize || !oauthCodeInput.trim()) return;
    setOauthBusy(true);
    onError(null);
    void (async () => {
      try {
        await api.exchangeClaudePlannerProvider(provider.id, {
          state: oauthAuthorize.state,
          code: oauthCodeInput.trim(),
        });
        setOauthAuthorize(null);
        setOauthCodeInput('');
        await onReload();
      } catch (err) {
        onApiError(err);
        onError(
          err instanceof ApiError
            ? err.message
            : `Could not complete ${isAntigravityOAuth ? 'Google' : 'Claude'} OAuth sign-in.`,
        );
      } finally {
        setOauthBusy(false);
      }
    })();
  };

  const importLocalAgyCli = (): void => {
    setImportingAgyCli(true);
    onError(null);
    void (async () => {
      try {
        await api.importAntigravityPlannerProviderCli(provider.id);
        setOauthAuthorize(null);
        await onReload();
      } catch (err) {
        onApiError(err);
        onError(
          err instanceof ApiError
            ? err.message
            : 'Could not import the local Antigravity CLI login.',
        );
      } finally {
        setImportingAgyCli(false);
      }
    })();
  };

  const startCodexDeviceLogin = (): void => {
    stopCodexDevicePolling();
    codexPollCancelledRef.current = false;
    setCodexDeviceBusy(true);
    onError(null);
    void (async () => {
      try {
        const startRes: CodexDeviceCodeStartResponse = await api.startCodexPlannerProviderDeviceFlow(
          provider.id,
        );
        let deviceAuthId = startRes.deviceAuthId ?? '';
        let userCode = startRes.userCode ?? '';
        let intervalSec = startRes.intervalSec || 5;
        const verificationUri = startRes.verificationUri;
        let mode: 'server' | 'browser' = startRes.mode;

        if (mode === 'browser' || !deviceAuthId || !userCode) {
          mode = 'browser';
          const browserRes = await fetch('https://auth.openai.com/api/accounts/deviceauth/usercode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ client_id: startRes.clientId }),
          });
          if (!browserRes.ok) {
            throw new Error(`Browser device-code request failed (${browserRes.status}).`);
          }
          const browserData = (await browserRes.json()) as {
            device_auth_id?: string;
            user_code?: string;
            usercode?: string;
            interval?: string | number;
          };
          deviceAuthId = browserData.device_auth_id ?? '';
          userCode = browserData.user_code ?? browserData.usercode ?? '';
          const parsedInt = Number.parseInt(String(browserData.interval ?? '5'), 10);
          if (Number.isFinite(parsedInt) && parsedInt > 0) intervalSec = parsedInt;
          if (!deviceAuthId || !userCode) {
            throw new Error('auth.openai.com did not return a device_auth_id and user_code.');
          }
        }

        if (codexPollCancelledRef.current) return;
        setCodexDeviceSession({
          deviceAuthId,
          userCode,
          verificationUri,
          intervalSec,
          mode,
          fallbackReason: startRes.fallbackReason ?? null,
        });
        window.open(verificationUri, '_blank', 'noopener,noreferrer');

        const pollOnce = async (): Promise<void> => {
          if (codexPollCancelledRef.current) return;
          try {
            if (mode === 'server') {
              const pollRes = await api.pollCodexPlannerProviderDeviceFlow(provider.id, {
                deviceAuthId,
                userCode,
              });
              if (codexPollCancelledRef.current) return;
              if (pollRes.status === 'completed') {
                stopCodexDevicePolling();
                await onReload();
                return;
              }
            } else {
              const tokenPoll = await fetch('https://auth.openai.com/api/accounts/deviceauth/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
              });
              if (codexPollCancelledRef.current) return;
              if (tokenPoll.ok) {
                const pollJson = (await tokenPoll.json()) as {
                  authorization_code?: string;
                  code_verifier?: string;
                };
                if (pollJson.authorization_code && pollJson.code_verifier) {
                  await api.completeCodexPlannerProviderDeviceFlow(provider.id, {
                    authorizationCode: pollJson.authorization_code,
                    codeVerifier: pollJson.code_verifier,
                  });
                  stopCodexDevicePolling();
                  await onReload();
                  return;
                }
              } else if (tokenPoll.status !== 403 && tokenPoll.status !== 404) {
                throw new Error(`Device-code polling failed (${tokenPoll.status}).`);
              }
            }
          } catch (pollErr) {
            if (codexPollCancelledRef.current) return;
            stopCodexDevicePolling();
            onApiError(pollErr);
            onError(
              pollErr instanceof ApiError
                ? pollErr.message
                : pollErr instanceof Error
                  ? pollErr.message
                  : 'Codex device-code sign-in failed.',
            );
            return;
          }
          if (!codexPollCancelledRef.current) {
            codexPollTimerRef.current = setTimeout(() => {
              void pollOnce();
            }, intervalSec * 1000);
          }
        };

        codexPollTimerRef.current = setTimeout(() => {
          void pollOnce();
        }, intervalSec * 1000);
      } catch (err) {
        stopCodexDevicePolling();
        onApiError(err);
        onError(
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Could not start Codex device-code sign-in.',
        );
      } finally {
        setCodexDeviceBusy(false);
      }
    })();
  };

  const loadUsage = (): void => {
    setLoadingUsage(true);
    void (async () => {
      try {
        const res = await api.getClaudePlannerProviderUsage(provider.id);
        setUsage(res);
      } catch (err) {
        onApiError(err);
        onError(err instanceof ApiError ? err.message : 'Could not read subscription usage.');
      } finally {
        setLoadingUsage(false);
      }
    })();
  };

  const addModel = (): void => {
    const trimmedId = newModelId.trim();
    const trimmedLabel = newModelLabel.trim() || trimmedId;
    if (!trimmedId) return;
    onAddModel({
      modelId: trimmedId,
      label: trimmedLabel,
      supportsEffort: newModelSupportsEffort,
    });
    setNewModelId('');
    setNewModelLabel('');
    setNewModelSupportsEffort(true);
    setSuggestionsOpen(false);
  };

  const discoverModels = (): void => {
    setDiscovering(true);
    setDiscoverMessage(null);
    void (async () => {
      try {
        const { modelIds } = await onDiscoverModels();
        setDiscoveredIds(modelIds);
        setDiscoverMessage(
          modelIds.length > 0
            ? `${modelIds.length} model${modelIds.length === 1 ? '' : 's'} available — start typing an id below to pick one.`
            : 'The endpoint listed no models.',
        );
      } catch (err) {
        onApiError(err);
        onError(err instanceof ApiError ? err.message : 'Could not query models from the endpoint.');
      } finally {
        setDiscovering(false);
      }
    })();
  };

  const selectDiscoveredModel = (modelId: string): void => {
    setNewModelId(modelId);
    setSuggestionsOpen(false);
    newModelLabelInputRef.current?.focus();
  };

  const configuredModelIds = new Set(models.map((m) => m.modelId));
  const modelSuggestions = computeModelSuggestions(
    discoveredIds,
    configuredModelIds,
    newModelId,
    suggestionsOpen,
  );

  const statusSummary = provider.keyUnreadable
    ? 'Credential unreadable'
    : isClaudeOAuth
      ? provider.authMode === 'setup-token'
        ? 'Signed in via setup-token'
        : provider.authMode === 'oauth'
          ? 'Signed in via OAuth'
          : provider.hasApiKey
            ? 'Credential configured'
            : 'Not signed in'
      : isCodexOAuth
        ? provider.authMode === 'cli-readonly'
          ? provider.hasApiKey
            ? 'Reading ~/.codex/auth.json'
            : 'Token missing or expired'
          : provider.authMode === 'device-code' && provider.hasApiKey
            ? 'Signed in via device-code'
            : 'Not signed in'
        : isAntigravityOAuth
          ? provider.authMode === 'cli-import' && provider.hasApiKey
            ? 'Using signed-in Antigravity CLI'
            : provider.authMode === 'oauth' && provider.hasApiKey
              ? 'Signed in via Google OAuth'
              : 'Not signed in'
          : `${provider.baseUrl ? 'Endpoint configured' : 'Endpoint not configured'} · ${
              provider.hasApiKey ? 'API key set' : 'No API key'
            }`;

  return (
    <div
      ref={sectionRef}
      className={`planner-section${isDragging ? ' is-dragging' : ''}${isDragOver ? ' drag-over' : ''}`}
      data-provider-id={provider.id}
      onDragOver={onDragOverProvider}
      onDragLeave={onDragLeaveProvider}
      onDrop={onDropProvider}
    >
      <div className="planner-section-header">
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, flexWrap: 'wrap' }}>
          <span
            className="planner-drag-handle"
            role="button"
            tabIndex={0}
            aria-label={`Drag to reorder provider ${provider.label}`}
            title="Drag to reorder"
            draggable={!busy}
            onDragStart={(e) => {
              if (sectionRef.current && e.dataTransfer.setDragImage) {
                e.dataTransfer.setDragImage(sectionRef.current, 20, 20);
              }
              onDragStartProvider?.(e);
            }}
            onDragEnd={onDragEndProvider}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                onMoveProviderUp?.();
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                onMoveProviderDown?.();
              }
            }}
          >
            <Icon name="grip" size={14} />
          </span>
          <button
            type="button"
            className="planner-collapsible-toggle"
            onClick={() => setProviderExpanded((v) => !v)}
            aria-expanded={providerExpanded}
            aria-label={`${providerExpanded ? 'Collapse' : 'Expand'} provider ${provider.label}`}
          >
            <Icon name={providerExpanded ? 'chevron-down' : 'chevron-right'} size={14} />
            <h3>
              {provider.label}{' '}
              <span className="planner-row-meta" style={{ fontWeight: 400 }}>
                ({provider.kind})
              </span>
            </h3>
            <span className="planner-row-meta">
              · {models.length} model{models.length === 1 ? '' : 's'}
              {!providerExpanded ? ` · ${statusSummary}` : ''}
            </span>
          </button>
        </div>
        <div className="planner-section-actions">
          {!isSubscriptionOAuth && (
            <button
              type="button"
              className="planner-btn icon-only"
              disabled={busy || !provider.baseUrl}
              onClick={onExportProvider}
              title={`Export "${provider.label}" provider and models to JSON`}
              aria-label={`Export "${provider.label}" provider and models to JSON`}
            >
              <Icon name="download" size={14} />
            </button>
          )}
          <button
            type="button"
            className="planner-btn danger"
            disabled={busy}
            onClick={onDeleteProvider}
            aria-label={`Delete provider ${provider.label}`}
          >
            <Icon name="trash" size={14} /> Delete provider
          </button>
        </div>
      </div>

      {providerExpanded && (
        <div className="planner-provider-body" style={{ marginTop: 10 }}>
      {provider.providerDisclosure && (
        <div className="warn-callout" role="note" style={{ marginBottom: 10 }}>
          {provider.providerDisclosure}
        </div>
      )}

      {provider.keyUnreadable && (
        <div className="error-box" role="alert" style={{ marginBottom: 10 }}>
          The stored credential for this provider cannot be decrypted with the current{' '}
          <code>POCKETAGENT_SETTINGS_ENC_KEY</code>. Enter a new credential below and save to replace it.
        </div>
      )}
      {provider.lastError && (
        <p className="planner-test-fail" style={{ marginBottom: 8 }}>
          Last error: {provider.lastError}
        </p>
      )}

      <div className="planner-field">
        <label htmlFor={`provider-label-${provider.id}`}>Label</label>
        <input
          id={`provider-label-${provider.id}`}
          type="text"
          placeholder="Default"
          value={labelInput}
          disabled={busy}
          onChange={(e) => setLabelInput(e.target.value)}
        />
      </div>

      {isClaudeOAuth ? (
        <>
          <div className="planner-field" style={{ marginTop: 8 }}>
            <label htmlFor={`provider-setup-token-${provider.id}`}>
              Setup token from <code>claude setup-token</code> (recommended, write-only)
            </label>
            <input
              id={`provider-setup-token-${provider.id}`}
              type="password"
              autoComplete="off"
              placeholder={
                provider.hasApiKey
                  ? '••••••••  (leave blank to keep current credential)'
                  : 'Paste token from claude setup-token…'
              }
              value={setupTokenInput}
              disabled={busy}
              onChange={(e) => setSetupTokenInput(e.target.value)}
            />
            <span className="planner-row-meta">
              Paste a token from <code>claude setup-token</code> (~1 year,
              inference-only, no refresh token — never conflicts with the <code>claude</code> CLI&apos;s own
              login). Validated with one live request before saving.
            </span>
          </div>

          <div className="planner-inline" style={{ marginTop: 8, flexWrap: 'wrap', gap: 8 }}>
            <button type="button" className="planner-btn" disabled={busy} onClick={saveProvider}>
              {setupTokenInput.trim() ? 'Verify & save setup token' : 'Save provider'}
            </button>
            <button
              type="button"
              className="planner-btn"
              disabled={busy || oauthBusy}
              onClick={startOAuth}
            >
              {oauthBusy && !oauthAuthorize ? 'Starting OAuth…' : 'Sign in with OAuth (copy-paste)'}
            </button>
            {provider.hasApiKey && (
              <>
                <button
                  type="button"
                  className="planner-btn"
                  disabled={busy || loadingUsage}
                  onClick={loadUsage}
                >
                  {loadingUsage ? 'Checking usage…' : 'Check 5h / 7d usage'}
                </button>
                <button type="button" className="planner-btn danger" disabled={busy} onClick={clearApiKey}>
                  Sign out
                </button>
              </>
            )}
            <span className="planner-row-meta">
              {provider.keyUnreadable
                ? 'Credential unreadable'
                : provider.authMode === 'setup-token'
                  ? 'Signed in via setup-token'
                  : provider.authMode === 'oauth'
                    ? `Signed in via OAuth${provider.accountEmail ? ` · ${provider.accountEmail}` : ''}${
                        provider.organizationName ? ` (${provider.organizationName})` : ''
                      }${provider.rateLimitTier ? ` · ${provider.rateLimitTier}` : ''}`
                    : provider.hasApiKey
                      ? 'Credential configured'
                      : 'Not signed in'}
            </span>
          </div>

          {oauthAuthorize && (
            <div className="planner-provider-add-form" style={{ marginTop: 10 }}>
              <p className="planner-row-meta" style={{ marginBottom: 6 }}>
                1. Authorize in the browser tab that opened (or{' '}
                <a href={oauthAuthorize.authorizeUrl} target="_blank" rel="noreferrer">
                  open authorization link
                </a>
                ).
                <br />
                2. Copy the <code>code#state</code> shown on the callback page and paste it below:
              </p>
              <div className="planner-inline" style={{ gap: 8 }}>
                <input
                  type="text"
                  placeholder="Paste code#state from callback page"
                  value={oauthCodeInput}
                  disabled={oauthBusy}
                  onChange={(e) => setOauthCodeInput(e.target.value)}
                />
                <button
                  type="button"
                  className="planner-btn"
                  disabled={oauthBusy || !oauthCodeInput.trim()}
                  onClick={completeOAuth}
                >
                  {oauthBusy ? 'Exchanging…' : 'Complete sign-in'}
                </button>
                <button
                  type="button"
                  className="planner-btn"
                  disabled={oauthBusy}
                  onClick={() => {
                    setOauthAuthorize(null);
                    setOauthCodeInput('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {usage && (
            <div className="planner-row-meta" style={{ marginTop: 8 }}>
              {usage.available && usage.windows.length > 0 ? (
                <span>
                  {usage.windows.map((w, idx) => (
                    <span key={w.label}>
                      {idx > 0 ? ' · ' : ''}
                      {w.label}: {Math.round(w.percentUsed)}% used
                      {w.resetsAt
                        ? ` (resets ${new Date(w.resetsAt).toLocaleString()})`
                        : ''}
                    </span>
                  ))}
                </span>
              ) : (
                <span>
                  Usage windows unavailable:{' '}
                  {usage.error ?? 'Not supported for this token.'}
                </span>
              )}
            </div>
          )}

          <div style={{ marginTop: 10 }}>
            <label className="planner-inline-checkbox">
              <input
                type="checkbox"
                checked={provider.allowUnattended}
                disabled={busy}
                onChange={(e) => toggleAllowUnattended(e.target.checked)}
              />
              <span>
                Allow unattended runs (scheduled jobs, inbound webhooks, and MCP-started chats)
              </span>
            </label>
          </div>
        </>
      ) : isCodexOAuth ? (
        <>
          <div className="planner-inline" style={{ marginTop: 8, flexWrap: 'wrap', gap: 8 }}>
            <button type="button" className="planner-btn" disabled={busy} onClick={saveProvider}>
              Save provider
            </button>
            <button
              type="button"
              className="planner-btn"
              disabled={busy || codexDeviceBusy}
              onClick={startCodexDeviceLogin}
            >
              {codexDeviceBusy
                ? 'Starting device login…'
                : codexDeviceSession
                  ? 'Restart device-code login'
                  : 'Sign in with device code'}
            </button>
            <button
              type="button"
              className="planner-btn"
              disabled={busy}
              onClick={() =>
                onSaveProvider({
                  authMode: provider.authMode === 'cli-readonly' ? 'device-code' : 'cli-readonly',
                })
              }
            >
              {provider.authMode === 'cli-readonly'
                ? 'Switch to device-code mode'
                : 'Use ~/.codex/auth.json (read-only)'}
            </button>
            {provider.hasApiKey && (
              <>
                <button
                  type="button"
                  className="planner-btn"
                  disabled={busy || loadingUsage}
                  onClick={loadUsage}
                >
                  {loadingUsage ? 'Checking usage…' : 'Check 5h / 7d usage'}
                </button>
                <button type="button" className="planner-btn danger" disabled={busy} onClick={clearApiKey}>
                  Sign out
                </button>
              </>
            )}
            <span className="planner-row-meta">
              {provider.keyUnreadable
                ? 'Credential unreadable'
                : provider.authMode === 'cli-readonly'
                  ? `Reading ~/.codex/auth.json (read-only)${
                      provider.accountEmail
                        ? ` · ${provider.accountEmail}`
                        : provider.accountId
                          ? ` · ${provider.accountId}`
                          : ''
                    }${provider.planType ? ` · ${provider.planType}` : ''}${
                      provider.hasApiKey ? '' : ' · token missing or expired (run codex once to refresh)'
                    }`
                  : provider.authMode === 'device-code' && provider.hasApiKey
                    ? `Signed in via device-code${
                        provider.accountEmail
                          ? ` · ${provider.accountEmail}`
                          : provider.accountId
                            ? ` · ${provider.accountId}`
                            : ''
                      }${provider.organizationName ? ` (${provider.organizationName})` : ''}${
                        provider.planType ? ` · ${provider.planType}` : ''
                      }`
                    : 'Not signed in'}
            </span>
          </div>

          {codexDeviceSession && (
            <div className="planner-provider-add-form" style={{ marginTop: 10 }}>
              {codexDeviceSession.fallbackReason && (
                <p className="planner-row-meta" style={{ marginBottom: 6 }}>
                  {codexDeviceSession.fallbackReason}
                </p>
              )}
              <p className="planner-row-meta" style={{ marginBottom: 6 }}>
                1. Open{' '}
                <a href={codexDeviceSession.verificationUri} target="_blank" rel="noreferrer">
                  {codexDeviceSession.verificationUri}
                </a>{' '}
                and enter this device code:
              </p>
              <div className="planner-inline" style={{ gap: 8, alignItems: 'center' }}>
                <code style={{ fontSize: 16, fontWeight: 600, letterSpacing: '0.08em' }}>
                  {codexDeviceSession.userCode}
                </code>
                <button
                  type="button"
                  className="planner-btn"
                  onClick={() => void navigator.clipboard?.writeText(codexDeviceSession.userCode)}
                >
                  Copy code
                </button>
                <button type="button" className="planner-btn" onClick={stopCodexDevicePolling}>
                  Cancel
                </button>
                <span className="planner-row-meta">
                  Waiting for authorization (polling every {codexDeviceSession.intervalSec}s)…
                </span>
              </div>
            </div>
          )}

          {usage && (
            <div className="planner-row-meta" style={{ marginTop: 8 }}>
              {usage.available && usage.windows.length > 0 ? (
                <span>
                  {usage.windows.map((w, idx) => (
                    <span key={w.label}>
                      {idx > 0 ? ' · ' : ''}
                      {w.label}: {Math.round(w.percentUsed)}% used
                      {w.resetsAt
                        ? ` (resets ${new Date(w.resetsAt).toLocaleString()})`
                        : ''}
                    </span>
                  ))}
                </span>
              ) : (
                <span>
                  Usage windows unavailable:{' '}
                  {usage.error ?? 'Not supported for this token.'}
                </span>
              )}
            </div>
          )}

          <div style={{ marginTop: 10 }}>
            <label className="planner-inline-checkbox">
              <input
                type="checkbox"
                checked={provider.allowUnattended}
                disabled={busy}
                onChange={(e) => toggleAllowUnattended(e.target.checked)}
              />
              <span>
                Allow unattended runs (scheduled jobs, inbound webhooks, and MCP-started chats)
              </span>
            </label>
          </div>
        </>
      ) : isAntigravityOAuth ? (
        <>
          <div className="planner-inline" style={{ marginTop: 8, flexWrap: 'wrap', gap: 8 }}>
            <button type="button" className="planner-btn" disabled={busy} onClick={saveProvider}>
              Save provider
            </button>
            {hasLocalAgyAuth && (
              <button
                type="button"
                className="planner-btn"
                disabled={busy || importingAgyCli}
                onClick={importLocalAgyCli}
              >
                {importingAgyCli
                  ? 'Importing agy CLI login…'
                  : 'Use the signed-in Antigravity CLI'}
              </button>
            )}
            <button
              type="button"
              className="planner-btn"
              disabled={busy || oauthBusy}
              onClick={startOAuth}
            >
              {oauthBusy && !oauthAuthorize
                ? 'Starting Google OAuth…'
                : 'Sign in with Google OAuth (copy-paste)'}
            </button>
            {provider.hasApiKey && (
              <>
                <button
                  type="button"
                  className="planner-btn"
                  disabled={busy || loadingUsage}
                  onClick={loadUsage}
                >
                  {loadingUsage ? 'Checking quota…' : 'Check quota'}
                </button>
                <button type="button" className="planner-btn danger" disabled={busy} onClick={clearApiKey}>
                  Sign out
                </button>
              </>
            )}
            <span className="planner-row-meta">
              {provider.keyUnreadable
                ? 'Credential unreadable'
                : provider.authMode === 'cli-import' && provider.hasApiKey
                  ? `Using signed-in Antigravity CLI${
                      provider.accountEmail ? ` · ${provider.accountEmail}` : ''
                    }${provider.accountId ? ` (${provider.accountId})` : ''}${
                      provider.planType ? ` · ${provider.planType}` : ''
                    }`
                  : provider.authMode === 'oauth' && provider.hasApiKey
                    ? `Signed in via Google OAuth${
                        provider.accountEmail ? ` · ${provider.accountEmail}` : ''
                      }${provider.accountId ? ` (${provider.accountId})` : ''}${
                        provider.planType ? ` · ${provider.planType}` : ''
                      }`
                    : 'Not signed in'}
            </span>
          </div>

          {oauthAuthorize && (
            <div className="planner-provider-add-form" style={{ marginTop: 10 }}>
              <p className="planner-row-meta" style={{ marginBottom: 6 }}>
                1. Authorize in the Google sign-in tab that opened (or{' '}
                <a href={oauthAuthorize.authorizeUrl} target="_blank" rel="noreferrer">
                  open authorization link
                </a>
                ).
                <br />
                2. After consenting, Google redirects to <code>http://127.0.0.1:.../oauth-callback?code=...&amp;state=...</code>. Copy that full redirect URL from your browser&apos;s address bar and paste it below:
              </p>
              <div className="planner-inline" style={{ gap: 8 }}>
                <input
                  type="text"
                  placeholder="Paste full http://127.0.0.1:.../oauth-callback?code=...&state=... URL"
                  value={oauthCodeInput}
                  disabled={oauthBusy}
                  onChange={(e) => setOauthCodeInput(e.target.value)}
                />
                <button
                  type="button"
                  className="planner-btn"
                  disabled={oauthBusy || !oauthCodeInput.trim()}
                  onClick={completeOAuth}
                >
                  {oauthBusy ? 'Exchanging…' : 'Complete sign-in'}
                </button>
                <button
                  type="button"
                  className="planner-btn"
                  disabled={oauthBusy}
                  onClick={() => {
                    setOauthAuthorize(null);
                    setOauthCodeInput('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {usage && (
            <div className="planner-row-meta" style={{ marginTop: 8 }}>
              {usage.available && usage.windows.length > 0 ? (
                <span>
                  {usage.windows.map((w, idx) => (
                    <span key={w.label}>
                      {idx > 0 ? ' · ' : ''}
                      {w.label}: {Math.round(w.percentUsed)}% used
                      {w.resetsAt
                        ? ` (resets ${new Date(w.resetsAt).toLocaleString()})`
                        : ''}
                    </span>
                  ))}
                </span>
              ) : (
                <span>
                  Quota windows unavailable:{' '}
                  {usage.error ?? 'Not supported for this token.'}
                </span>
              )}
            </div>
          )}

          <div style={{ marginTop: 10 }}>
            <label className="planner-inline-checkbox">
              <input
                type="checkbox"
                checked={provider.allowUnattended}
                disabled={busy}
                onChange={(e) => toggleAllowUnattended(e.target.checked)}
              />
              <span>
                Allow unattended runs (scheduled jobs, inbound webhooks, and MCP-started chats)
              </span>
            </label>
          </div>
        </>
      ) : (
        <>
          <div className="planner-field" style={{ marginTop: 8 }}>
            <label htmlFor={`provider-base-url-${provider.id}`}>Base URL</label>
            <input
              id={`provider-base-url-${provider.id}`}
              type="text"
              placeholder={
                provider.kind === 'deepseek'
                  ? DEEPSEEK_PROVIDER_DEFAULTS.baseUrl
                  : provider.kind === 'opencode-zen'
                    ? OPENCODE_ZEN_PROVIDER_DEFAULTS.baseUrl
                    : provider.kind === 'opencode-go'
                      ? OPENCODE_GO_PROVIDER_DEFAULTS.baseUrl
                      : endpointsInput.includes('anthropic') && !endpointsInput.includes('openai')
                        ? 'https://api.anthropic.com'
                        : 'https://api.openai.com/v1'
              }
              value={baseUrlInput}
              disabled={busy}
              onChange={(e) => setBaseUrlInput(e.target.value)}
            />
          </div>

          <div className="planner-field" style={{ marginTop: 8 }}>
            <label>Endpoints</label>
            <div className="planner-inline" style={{ gap: 16, flexWrap: 'wrap' }}>
              <label className="planner-inline-checkbox">
                <input
                  type="checkbox"
                  checked={endpointsInput.includes('openai')}
                  disabled={busy}
                  onChange={(e) => toggleEndpoint('openai', e.target.checked)}
                />
                <span>OpenAI (<code>/v1/chat/completions</code>)</span>
              </label>
              <label className="planner-inline-checkbox">
                <input
                  type="checkbox"
                  checked={endpointsInput.includes('anthropic')}
                  disabled={busy}
                  onChange={(e) => toggleEndpoint('anthropic', e.target.checked)}
                />
                <span>Anthropic (<code>/v1/messages</code>)</span>
              </label>
            </div>
            <span className="planner-row-meta">
              Pocket Agent uses OpenAI unless only Anthropic is checked. Providers with Anthropic
              checked are also selectable in Custom Claude.
            </span>
          </div>

          <div className="planner-field" style={{ marginTop: 8 }}>
            <label htmlFor={`provider-api-key-${provider.id}`}>API key (write-only)</label>
            <input
              id={`provider-api-key-${provider.id}`}
              type="password"
              autoComplete="off"
              placeholder={provider.hasApiKey ? '••••••••  (leave blank to keep)' : 'sk-…'}
              value={apiKeyInput}
              disabled={busy}
              onChange={(e) => setApiKeyInput(e.target.value)}
            />
          </div>

          <div className="planner-inline" style={{ marginTop: 8 }}>
            <button type="button" className="planner-btn" disabled={busy} onClick={saveProvider}>
              Save provider
            </button>
            {provider.hasApiKey && (
              <button type="button" className="planner-btn" disabled={busy} onClick={clearApiKey}>
                Clear key
              </button>
            )}
            <span className="planner-row-meta">
              {provider.baseUrl ? 'Endpoint configured' : 'Endpoint not configured'} ·{' '}
              {provider.keyUnreadable
                ? 'Key unreadable'
                : provider.hasApiKey
                  ? 'API key set'
                  : 'No API key'}
            </span>
          </div>
        </>
      )}

      <div className="planner-provider-models">
        <div className="planner-section-header">
          <button
            type="button"
            className="planner-collapsible-toggle"
            onClick={() => setModelsExpanded((v) => !v)}
            aria-expanded={modelsExpanded}
            aria-label={`${modelsExpanded ? 'Collapse' : 'Expand'} models for ${provider.label}`}
          >
            <Icon name={modelsExpanded ? 'chevron-down' : 'chevron-right'} size={14} />
            <h4>
              Models{' '}
              <span className="planner-row-meta" style={{ fontWeight: 400 }}>
                ({models.length})
              </span>
            </h4>
          </button>
          <div className="planner-section-actions">
            <button
              type="button"
              className="planner-btn"
              disabled={discovering || (isSubscriptionOAuth ? !provider.hasApiKey : !provider.baseUrl)}
              onClick={() => {
                setModelsExpanded(true);
                discoverModels();
              }}
              title={
                isClaudeOAuth
                  ? provider.hasApiKey
                    ? undefined
                    : 'Sign in with a setup token or OAuth first.'
                  : isCodexOAuth
                    ? provider.hasApiKey
                      ? undefined
                      : 'Sign in with device code or enable ~/.codex/auth.json read-only mode first.'
                    : isAntigravityOAuth
                      ? provider.hasApiKey
                        ? undefined
                        : 'Use the signed-in Antigravity CLI or sign in with Google OAuth first.'
                      : provider.baseUrl
                        ? undefined
                        : 'Save a base URL on this provider first.'
              }
            >
              {discovering ? 'Querying…' : 'Query models'}
            </button>
            <button
              type="button"
              className="planner-btn"
              disabled={testingAll || models.length === 0}
              onClick={onTestAllModels}
            >
              {testingAll ? 'Testing…' : 'Test all'}
            </button>
            <button
              type="button"
              className="planner-btn danger"
              disabled={busy || models.length === 0}
              onClick={onDeleteAllModels}
            >
              Delete all
            </button>
          </div>
        </div>

        {modelsExpanded && (
          <div style={{ marginTop: 8 }}>
            {discoverMessage && <p className="planner-row-meta">{discoverMessage}</p>}
            {models.length === 0 && (
              <p className="planner-row-meta">
                No models configured for this provider yet — query the endpoint above, then pick from
                the suggestions as you type an id below.
              </p>
            )}

            {models.map((m) => (
              <PlannerModelRow
                key={m.id}
                model={m}
                isCodexOAuth={isCodexOAuth}
                busy={busy}
                testingAll={testingAll}
                testResult={testResults[m.id]}
                isDragging={draggingModelId === m.id}
                isDragOver={dragOverModelId === m.id}
                onDragStartModel={(e) => {
                  e.dataTransfer.setData('text/plain', m.id);
                  e.dataTransfer.setData('application/x-pocketagent-model-id', m.id);
                  e.dataTransfer.setData('application/x-pocketagent-model-provider-id', provider.id);
                  e.dataTransfer.effectAllowed = 'move';
                  setDraggingModelId(m.id);
                }}
                onDragOverModel={(e) => {
                  if (Array.from(e.dataTransfer.types).includes('application/x-pocketagent-model-id')) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (dragOverModelId !== m.id) {
                      setDragOverModelId(m.id);
                    }
                  }
                }}
                onDragLeaveModel={() => {
                  if (dragOverModelId === m.id) {
                    setDragOverModelId(null);
                  }
                }}
                onDropModel={(e) => {
                  e.preventDefault();
                  const sourceModelId = e.dataTransfer.getData('application/x-pocketagent-model-id');
                  const sourceProviderId = e.dataTransfer.getData('application/x-pocketagent-model-provider-id');
                  setDraggingModelId(null);
                  setDragOverModelId(null);

                  if (sourceProviderId !== provider.id || !sourceModelId || sourceModelId === m.id) {
                    return;
                  }

                  const sourceIdx = models.findIndex((item) => item.id === sourceModelId);
                  const targetIdx = models.findIndex((item) => item.id === m.id);
                  if (sourceIdx === -1 || targetIdx === -1) return;

                  const next = [...models];
                  const [moved] = next.splice(sourceIdx, 1);
                  if (!moved) return;
                  next.splice(targetIdx, 0, moved);
                  onReorderModels?.(provider.id, next.map((item) => item.id));
                }}
                onDragEndModel={() => {
                  setDraggingModelId(null);
                  setDragOverModelId(null);
                }}
                onMoveModelUp={() => handleMoveModel(m.id, 'up')}
                onMoveModelDown={() => handleMoveModel(m.id, 'down')}
                onSave={(patch) => onSetModelLimit(m.id, patch)}
                onTest={() => onTestModel(m.id)}
                onRemove={() => onRemoveModel(m.id)}
                onError={onError}
              />
            ))}

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
              <label
                className="planner-inline-checkbox"
                title="Allow configuring reasoning effort for this model"
              >
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
        )}
      </div>
        </div>
      )}
    </div>
  );
}

export interface PlannerModelRowProps {
  model: PlannerModel;
  isCodexOAuth?: boolean;
  busy: boolean;
  testingAll?: boolean;
  testResult?: TestPlannerModelResponse | 'testing';
  initialEditing?: boolean;
  isDragging?: boolean;
  isDragOver?: boolean;
  onDragStartModel?: (e: React.DragEvent) => void;
  onDragOverModel?: (e: React.DragEvent) => void;
  onDragLeaveModel?: (e: React.DragEvent) => void;
  onDropModel?: (e: React.DragEvent) => void;
  onDragEndModel?: (e: React.DragEvent) => void;
  onMoveModelUp?: () => void;
  onMoveModelDown?: () => void;
  onSave: (patch: UpdatePlannerModelRequest) => void;
  onTest: () => void;
  onRemove: () => void;
  onError?: (message: string | null) => void;
}

/**
 * PA-152: compact one-line model row showing only the model display name,
 * model id, and Edit / Test / Remove actions. Clicking Edit expands a detail
 * form with Save / Cancel for reasoning effort, token limits, caching,
 * multimodal flags, and pricing.
 */
export function PlannerModelRow({
  model,
  isCodexOAuth = false,
  busy,
  testingAll = false,
  testResult,
  initialEditing = false,
  isDragging = false,
  isDragOver = false,
  onDragStartModel,
  onDragOverModel,
  onDragLeaveModel,
  onDropModel,
  onDragEndModel,
  onMoveModelUp,
  onMoveModelDown,
  onSave,
  onTest,
  onRemove,
  onError,
}: PlannerModelRowProps): JSX.Element {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [editing, setEditing] = useState(initialEditing);
  const [labelDraft, setLabelDraft] = useState(model.label);
  const [supportsEffortDraft, setSupportsEffortDraft] = useState(model.supportsEffort !== false);
  const [contextWindowDraft, setContextWindowDraft] = useState(
    model.contextWindow != null ? String(model.contextWindow) : '',
  );
  const [maxOutputTokensDraft, setMaxOutputTokensDraft] = useState(
    model.maxOutputTokens != null ? String(model.maxOutputTokens) : '',
  );
  const [promptCachingDraft, setPromptCachingDraft] = useState<'auto' | 'on' | 'off'>(
    model.promptCaching == null ? 'auto' : model.promptCaching ? 'on' : 'off',
  );
  const [supportsImagesDraft, setSupportsImagesDraft] = useState<'auto' | 'on' | 'off'>(
    model.supportsImages == null ? 'auto' : model.supportsImages ? 'on' : 'off',
  );
  const [supportsPdfDraft, setSupportsPdfDraft] = useState<'on' | 'off'>(
    model.supportsPdf === true ? 'on' : 'off',
  );
  const [inputPriceDraft, setInputPriceDraft] = useState(
    model.inputPricePerMTok != null ? String(model.inputPricePerMTok) : '',
  );
  const [outputPriceDraft, setOutputPriceDraft] = useState(
    model.outputPricePerMTok != null ? String(model.outputPricePerMTok) : '',
  );
  const [cacheReadPriceDraft, setCacheReadPriceDraft] = useState(
    model.cacheReadPricePerMTok != null ? String(model.cacheReadPricePerMTok) : '',
  );
  const [cacheWritePriceDraft, setCacheWritePriceDraft] = useState(
    model.cacheWritePricePerMTok != null ? String(model.cacheWritePricePerMTok) : '',
  );

  const resetDrafts = useCallback(() => {
    setLabelDraft(model.label);
    setSupportsEffortDraft(model.supportsEffort !== false);
    setContextWindowDraft(model.contextWindow != null ? String(model.contextWindow) : '');
    setMaxOutputTokensDraft(model.maxOutputTokens != null ? String(model.maxOutputTokens) : '');
    setPromptCachingDraft(model.promptCaching == null ? 'auto' : model.promptCaching ? 'on' : 'off');
    setSupportsImagesDraft(model.supportsImages == null ? 'auto' : model.supportsImages ? 'on' : 'off');
    setSupportsPdfDraft(model.supportsPdf === true ? 'on' : 'off');
    setInputPriceDraft(model.inputPricePerMTok != null ? String(model.inputPricePerMTok) : '');
    setOutputPriceDraft(model.outputPricePerMTok != null ? String(model.outputPricePerMTok) : '');
    setCacheReadPriceDraft(model.cacheReadPricePerMTok != null ? String(model.cacheReadPricePerMTok) : '');
    setCacheWritePriceDraft(model.cacheWritePricePerMTok != null ? String(model.cacheWritePricePerMTok) : '');
  }, [model]);

  useEffect(() => {
    if (!editing) {
      resetDrafts();
    }
  }, [editing, resetDrafts]);

  const openEdit = (): void => {
    resetDrafts();
    setEditing(true);
  };

  const cancelEdit = (): void => {
    resetDrafts();
    setEditing(false);
  };

  const saveEdit = (): void => {
    const trimmedLabel = labelDraft.trim();
    if (!trimmedLabel || trimmedLabel.length > 128) {
      onError?.('Model name must be between 1 and 128 characters.');
      return;
    }

    const parseTokenLimit = (
      raw: string,
      fieldName: string,
    ): { ok: true; value: number | null } | { ok: false; error: string } => {
      const trimmed = raw.trim();
      if (!trimmed) return { ok: true, value: null };
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 10_000_000) {
        return {
          ok: false,
          error: `${fieldName} must be an integer between 1024 and 10,000,000.`,
        };
      }
      return { ok: true, value: parsed };
    };

    const parsePrice = (
      raw: string,
      fieldName: string,
    ): { ok: true; value: number | null } | { ok: false; error: string } => {
      const trimmed = raw.trim();
      if (!trimmed) return { ok: true, value: null };
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10_000) {
        return {
          ok: false,
          error: `${fieldName} must be between 0 and 10,000.`,
        };
      }
      return { ok: true, value: parsed };
    };

    const ctxRes = parseTokenLimit(contextWindowDraft, 'Context window');
    if (!ctxRes.ok) {
      onError?.(ctxRes.error);
      return;
    }
    const maxOutRes = isCodexOAuth
      ? { ok: true as const, value: model.maxOutputTokens ?? null }
      : parseTokenLimit(maxOutputTokensDraft, 'Max output tokens');
    if (!maxOutRes.ok) {
      onError?.(maxOutRes.error);
      return;
    }
    const inPriceRes = parsePrice(inputPriceDraft, 'Input price');
    if (!inPriceRes.ok) {
      onError?.(inPriceRes.error);
      return;
    }
    const outPriceRes = parsePrice(outputPriceDraft, 'Output price');
    if (!outPriceRes.ok) {
      onError?.(outPriceRes.error);
      return;
    }
    const cacheReadRes = parsePrice(cacheReadPriceDraft, 'Cache read price');
    if (!cacheReadRes.ok) {
      onError?.(cacheReadRes.error);
      return;
    }
    const cacheWriteRes = parsePrice(cacheWritePriceDraft, 'Cache write price');
    if (!cacheWriteRes.ok) {
      onError?.(cacheWriteRes.error);
      return;
    }

    onError?.(null);
    setEditing(false);
    onSave({
      label: trimmedLabel,
      supportsEffort: supportsEffortDraft,
      contextWindow: ctxRes.value,
      ...(!isCodexOAuth ? { maxOutputTokens: maxOutRes.value } : {}),
      promptCaching: promptCachingDraft === 'auto' ? null : promptCachingDraft === 'on',
      supportsImages: supportsImagesDraft === 'auto' ? null : supportsImagesDraft === 'on',
      supportsPdf: supportsPdfDraft === 'on' ? true : model.supportsPdf == null ? null : false,
      inputPricePerMTok: inPriceRes.value,
      outputPricePerMTok: outPriceRes.value,
      cacheReadPricePerMTok: cacheReadRes.value,
      cacheWritePricePerMTok: cacheWriteRes.value,
    });
  };

  return (
    <div
      ref={rowRef}
      className={`planner-model-item${isDragging ? ' is-dragging' : ''}${isDragOver ? ' drag-over' : ''}`}
      data-model-id={model.id}
      onDragOver={onDragOverModel}
      onDragLeave={onDragLeaveModel}
      onDrop={onDropModel}
    >
      <div className="planner-model-row">
        <span className="planner-model-summary">
          <span
            className="planner-drag-handle"
            role="button"
            tabIndex={0}
            aria-label={`Drag to reorder model ${model.label}`}
            title="Drag to reorder"
            draggable={!busy}
            onDragStart={(e) => {
              if (rowRef.current && e.dataTransfer.setDragImage) {
                e.dataTransfer.setDragImage(rowRef.current, 20, 20);
              }
              onDragStartModel?.(e);
            }}
            onDragEnd={onDragEndModel}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                onMoveModelUp?.();
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                onMoveModelDown?.();
              }
            }}
          >
            <Icon name="grip" size={14} />
          </span>
          <span className="planner-model-name">{model.label}</span>{' '}
          <span className="planner-row-meta">({model.modelId})</span>
          {testResult === 'testing' && <span className="planner-row-meta"> — testing…</span>}
          {testResult && testResult !== 'testing' && (
            <span className={testResult.ok ? 'planner-test-ok' : 'planner-test-fail'}>
              {' '}
              — {testResult.ok ? `OK (${testResult.latencyMs}ms)` : 'Failed'}: {testResult.message}
            </span>
          )}
        </span>
        <div className="planner-row-actions">
          <button
            type="button"
            className={`planner-btn${editing ? ' active' : ''}`}
            disabled={busy}
            onClick={() => (editing ? cancelEdit() : openEdit())}
            aria-expanded={editing}
            aria-label={`Edit ${model.label}`}
            title={`Edit ${model.label}`}
          >
            <Icon name="edit" size={14} /> Edit
          </button>
          <button
            type="button"
            className="planner-btn"
            disabled={testResult === 'testing' || testingAll}
            onClick={onTest}
          >
            Test
          </button>
          <button
            type="button"
            className="planner-btn danger"
            disabled={busy}
            onClick={onRemove}
            aria-label={`Remove ${model.label}`}
            title={`Remove ${model.label}`}
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>

      {editing && (
        <div className="planner-model-detail" role="region" aria-label={`Edit ${model.label} details`}>
          <div className="planner-model-detail-grid">
            <label className="planner-model-limit">
              <span>Name</span>
              <input
                type="text"
                className="planner-model-name-input"
                aria-label={`Model name for ${model.modelId}`}
                value={labelDraft}
                maxLength={128}
                disabled={busy}
                onChange={(e) => setLabelDraft(e.target.value)}
              />
            </label>
            <label
              className="planner-inline-checkbox"
              title="Allow configuring reasoning effort for this model"
            >
              <input
                type="checkbox"
                checked={supportsEffortDraft}
                disabled={busy}
                onChange={(e) => setSupportsEffortDraft(e.target.checked)}
              />
              <span>Reasoning effort</span>
            </label>
            <label
              className="planner-model-limit"
              title="Context window in tokens. Empty = worked out from the model name (128k if unknown)."
            >
              <span>Context</span>
              <input
                type="number"
                min={1024}
                step={1024}
                placeholder="auto"
                value={contextWindowDraft}
                disabled={busy}
                onChange={(e) => setContextWindowDraft(e.target.value)}
              />
            </label>
            {!isCodexOAuth && (
              <label
                className="planner-model-limit"
                title="Output limit in tokens, sent as max_tokens. Empty = not sent."
              >
                <span>Max out</span>
                <input
                  type="number"
                  min={1024}
                  step={1024}
                  placeholder="auto"
                  value={maxOutputTokensDraft}
                  disabled={busy}
                  onChange={(e) => setMaxOutputTokensDraft(e.target.value)}
                />
              </label>
            )}
            <label
              className="planner-model-limit"
              title="Prompt caching: send Anthropic cache_control markers. Auto = on for Claude models only, since strict OpenAI-compatible servers reject the field. Cached token counts are shown whenever the provider reports them, whatever this says."
            >
              <span>Cache</span>
              <select
                value={promptCachingDraft}
                disabled={busy}
                onChange={(e) => setPromptCachingDraft(e.target.value as 'auto' | 'on' | 'off')}
              >
                <option value="auto">Auto</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </label>
            <label
              className="planner-model-limit"
              title="Whether this model can read attached images. Auto = yes, unless it is a known text-only model. When off, each image is replaced by a short note in what the model is sent; the chat keeps the image."
            >
              <span>Images</span>
              <select
                value={supportsImagesDraft}
                disabled={busy}
                onChange={(e) => setSupportsImagesDraft(e.target.value as 'auto' | 'on' | 'off')}
              >
                <option value="auto">Auto</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </label>
            <label
              className="planner-model-limit"
              title="Whether to send an attached PDF itself (as an OpenAI file part) beside its extracted text. Off by default: most OpenAI-compatible servers reject PDF input. If the server refuses one, the turn continues with the text only."
            >
              <span>PDFs</span>
              <select
                value={supportsPdfDraft}
                disabled={busy}
                onChange={(e) => setSupportsPdfDraft(e.target.value as 'on' | 'off')}
              >
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </label>
          </div>

          <div
            className="planner-model-prices"
            title="USD per million tokens, used to show each turn's cost. Optional — with no input and output price a turn shows no cost. An empty cache price is charged at the input price. A cost the provider reports itself is used instead."
          >
            <label className="planner-model-limit">
              <span>$ in</span>
              <input
                type="number"
                min={0}
                step="any"
                placeholder="—"
                value={inputPriceDraft}
                disabled={busy}
                onChange={(e) => setInputPriceDraft(e.target.value)}
              />
            </label>
            <label className="planner-model-limit">
              <span>out</span>
              <input
                type="number"
                min={0}
                step="any"
                placeholder="—"
                value={outputPriceDraft}
                disabled={busy}
                onChange={(e) => setOutputPriceDraft(e.target.value)}
              />
            </label>
            <label className="planner-model-limit">
              <span>cache read</span>
              <input
                type="number"
                min={0}
                step="any"
                placeholder="—"
                value={cacheReadPriceDraft}
                disabled={busy}
                onChange={(e) => setCacheReadPriceDraft(e.target.value)}
              />
            </label>
            <label className="planner-model-limit">
              <span>cache write</span>
              <input
                type="number"
                min={0}
                step="any"
                placeholder="—"
                value={cacheWritePriceDraft}
                disabled={busy}
                onChange={(e) => setCacheWritePriceDraft(e.target.value)}
              />
            </label>
            <span className="planner-row-meta">per 1M tokens</span>
          </div>

          <div className="planner-inline planner-model-detail-actions">
            <button
              type="button"
              className="planner-btn"
              disabled={busy || !labelDraft.trim()}
              onClick={saveEdit}
            >
              Save
            </button>
            <button type="button" className="planner-btn" disabled={busy} onClick={cancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
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

function TextRow({
  label,
  help,
  placeholder,
  value,
  busy,
  listId,
  children,
  onChange,
}: {
  label: string;
  help?: string;
  placeholder?: string;
  value: string;
  busy: boolean;
  listId?: string;
  children?: ReactNode;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <div className="settings-row settings-row-stacked">
      <div className="settings-row-info">
        <label className="settings-row-label">{label}</label>
      </div>
      <div className="settings-row-control">
        <input
          type="text"
          className="settings-input"
          value={value}
          placeholder={placeholder}
          disabled={busy}
          list={listId}
          onChange={(e) => onChange(e.target.value)}
        />
        {children}
      </div>
      {help && <p className="transport-hint">{help}</p>}
    </div>
  );
}

function NumberRow({
  label,
  help,
  unit,
  value,
  min,
  max,
  step,
  busy,
  onChange,
}: {
  label: string;
  help?: string;
  unit?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  busy: boolean;
  onChange: (value: number) => void;
}): JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row-main">
        <div className="settings-row-info">
          <label className="settings-row-label">
            {label}
            {unit && <span className="settings-unit">({unit})</span>}
          </label>
          {help && <p className="transport-hint">{help}</p>}
        </div>
        <div className="settings-row-control settings-number-control">
          <input
            type="number"
            className="settings-input settings-number-input"
            value={value}
            min={min}
            max={max}
            step={step ?? 1}
            disabled={busy}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, Math.round(n))));
            }}
          />
        </div>
      </div>
    </div>
  );
}

function BoolRow({
  label,
  help,
  checked,
  busy,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  busy: boolean;
  onChange: (value: boolean) => void;
}): JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row-main">
        <div className="settings-row-info">
          <label className="settings-row-label">{label}</label>
          {help && <p className="transport-hint">{help}</p>}
        </div>
        <div className="settings-row-control">
          <label className="switch">
            <input
              type="checkbox"
              checked={checked}
              disabled={busy}
              onChange={(e) => onChange(e.target.checked)}
            />
            <span className="switch-track" />
          </label>
        </div>
      </div>
    </div>
  );
}
