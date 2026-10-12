import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  PlannerEndpointTemplatePayload,
  PlannerModel,
  PlannerSettingsDto,
  SettingsResponse,
  TestPlannerEmbeddingResponse,
  TestPlannerModelResponse,
  UpdatePlannerModelRequest,
  UpdateSettingsRequest,
} from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { GeminiLiveSettingsSection } from '../components/GeminiLiveSettingsSection.js';
import { Icon } from '../components/Icon.js';
import { useHostApi } from '../hosts/HostContext.js';
import { TtsPlaybackQueue } from '../audio/playback.js';
import { unlockAudioContext } from '../audio/audio-context.js';
import { exportToJsonFile } from '../agent/json-transfer.js';
import { useJsonImport } from '../hooks/useJsonImport.js';

type RuntimeSettings = SettingsResponse['settings'];

const DEBOUNCE_MS = 500;

interface Props {
  onApiError: (error: unknown) => void;
  /** Present only on the phone route or tab strip close action. */
  onBack?: () => void;
}

/**
 * PA-132: "Providers and Models" settings page — consolidates the Pocket Agent
 * LLM endpoint and model catalog, the self-hosted TTS/STT voice pipeline
 * settings, and Gemini Live configuration in one place.
 */
export function ProvidersAndModelsPage({ onApiError, onBack }: Props): JSX.Element {
  const api = useHostApi();
  const [models, setModels] = useState<PlannerModel[] | null>(null);
  const [plannerSettings, setPlannerSettings] = useState<PlannerSettingsDto | null>(null);
  const [runtimeData, setRuntimeData] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingRuntime, setPendingRuntime] = useState<Set<string>>(new Set());
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Pocket Agent LLM endpoint & models state
  const [baseUrlInput, setBaseUrlInput] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [revealedApiKey, setRevealedApiKey] = useState<string | null>(null);
  const [newModelId, setNewModelId] = useState('');
  const [newModelLabel, setNewModelLabel] = useState('');
  const [newModelSupportsEffort, setNewModelSupportsEffort] = useState(true);
  const [suggestionsOpen, setSuggestionsOpen] = useState(true);
  const newModelLabelInputRef = useRef<HTMLInputElement | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverMessage, setDiscoverMessage] = useState<string | null>(null);
  const [discoveredIds, setDiscoveredIds] = useState<string[]>([]);
  const [confirmingDeleteAllModels, setConfirmingDeleteAllModels] = useState(false);
  const [testingAll, setTestingAll] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, TestPlannerModelResponse | 'testing'>>({});

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
      const [mo, se, rt] = await Promise.all([
        api.listPlannerModels(),
        api.getPlannerSettings(),
        api.getSettings(),
      ]);
      setModels(mo.models);
      setPlannerSettings(se);
      setBaseUrlInput(se.baseUrl ?? '');
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

  const setModelLimit = (id: string, patch: UpdatePlannerModelRequest): void => {
    void withBusy(async () => {
      await api.updatePlannerModel(id, patch);
      await load();
    });
  };

  const removeModel = (id: string): void => {
    void withBusy(() => api.deletePlannerModel(id));
  };

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

  const configuredModelIds = new Set((models ?? []).map((m) => m.modelId));
  const modelSuggestions = computeModelSuggestions(
    discoveredIds,
    configuredModelIds,
    newModelId,
    suggestionsOpen,
  );

  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  const handleExportEndpoint = (): void => {
    exportToJsonFile(
      'planner-endpoint',
      {
        baseUrl: baseUrlInput,
        models: (models ?? []).map(({ id: _id, sortOrder: _sortOrder, createdAt: _createdAt, ...model }) => model),
        embeddingBaseUrl: plannerSettings?.embeddingBaseUrl ?? null,
        embeddingModelId: plannerSettings?.embeddingModelId ?? null,
        webSearchBaseUrl: plannerSettings?.webSearchBaseUrl ?? null,
        urlFetchBaseUrl: plannerSettings?.urlFetchBaseUrl ?? null,
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

  const runtimeBusy = (key: string): boolean => pendingRuntime.has(key);
  const runtimeSettings = runtimeData?.settings;

  return (
    <div className="planner-page">
      <input {...endpointFileInputProps} />
      <div className="planner-head">
        <div>
          <h2>Providers and Models</h2>
          <p className="planner-sub">
            Pocket Agent LLM endpoint, model catalog, embeddings, TTS/STT voice pipeline, and Gemini Live.
          </p>
        </div>
        <div className="planner-head-actions">
          <button
            type="button"
            className="planner-btn icon-only"
            onClick={handleExportEndpoint}
            title="Export LLM endpoint and model settings to JSON"
            aria-label="Export LLM endpoint and model settings to JSON"
          >
            <Icon name="download" size={16} />
          </button>
          <button
            type="button"
            className="planner-btn icon-only"
            onClick={triggerImportEndpoint}
            title="Import LLM endpoint and model settings from JSON"
            aria-label="Import LLM endpoint and model settings from JSON"
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
                {plannerSettings?.baseUrl ? 'Configured' : 'Not configured'}
              </span>
            </div>

            <div className="planner-field" style={{ marginTop: 12 }}>
              <label htmlFor="planner-api-key">API key</label>
              <input
                id="planner-api-key"
                type="password"
                placeholder={plannerSettings?.hasApiKey ? '••••••••  (leave blank to keep)' : 'sk-…'}
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
                disabled={busy || !plannerSettings?.hasApiKey}
                onClick={reveal}
              >
                Reveal
              </button>
              <span className="planner-row-meta">
                {plannerSettings?.hasApiKey ? 'A key is configured' : 'No key configured'}
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
                  disabled={discovering || !plannerSettings?.baseUrl}
                  onClick={discoverModels}
                  title={plannerSettings?.baseUrl ? undefined : 'Set an endpoint URL first.'}
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
                      title={
                        m.supportsEffort !== false
                          ? 'Reasoning effort enabled (click to disable)'
                          : 'Reasoning effort disabled (click to enable)'
                      }
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
    </div>
  );
}

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
