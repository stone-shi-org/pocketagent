import { useCallback, useEffect, useState } from 'react';
import {
  DEEPSEEK_PROVIDER_DEFAULTS,
  OPENCODE_GO_PROVIDER_DEFAULTS,
  OPENCODE_ZEN_PROVIDER_DEFAULTS,
  defaultEndpointsForProviderKind,
  isApiKeyProviderKind,
  type CustomClaudeProviderSummary,
  type PlannerModel,
  type PlannerProvider,
} from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { Icon } from './Icon.js';
import { useHostApi } from '../hosts/HostContext.js';

interface Props {
  onApiError: (error: unknown) => void;
}

interface FormState {
  name: string;
  providerId: string;
  defaultModel: string;
  smallModel: string;
  allowUnattended: boolean;
  supportsEffort: boolean;
}

function modelsForPlannerProvider(
  provider: PlannerProvider | undefined,
  allModels: PlannerModel[],
  fallbackModels?: string[],
): { modelId: string; label: string }[] {
  if (!provider) {
    return (fallbackModels ?? []).map((id) => ({ modelId: id, label: id }));
  }
  const configured = allModels.filter(
    (m) => m.providerId === provider.id || (!m.providerId && provider.id === 'default'),
  );
  if (configured.length > 0) {
    return configured.map((m) => ({
      modelId: m.modelId,
      label: m.label && m.label !== m.modelId ? `${m.label} (${m.modelId})` : m.modelId,
    }));
  }
  if (provider.kind === 'deepseek') {
    return DEEPSEEK_PROVIDER_DEFAULTS.defaultModels.map((id) => ({ modelId: id, label: id }));
  }
  if (provider.kind === 'opencode-zen') {
    return OPENCODE_ZEN_PROVIDER_DEFAULTS.defaultModels.map((id) => ({ modelId: id, label: id }));
  }
  if (provider.kind === 'opencode-go') {
    return OPENCODE_GO_PROVIDER_DEFAULTS.defaultModels.map((id) => ({ modelId: id, label: id }));
  }
  return (fallbackModels ?? []).map((id) => ({ modelId: id, label: id }));
}

/**
 * PA-28 / PA-154: manage Custom Claude variants.
 *
 * Each Custom Claude entry picks an Anthropic-enabled (`endpoints` includes
 * `'anthropic'`) API-key provider configured under **Providers and Models**,
 * automatically lists that provider's supported models for selecting the
 * default and small/fast models, and spawns the `claude` CLI against that
 * provider's Anthropic `/v1/messages` endpoint and encrypted API key.
 */
export function CustomClaudeProvidersSection({ onApiError }: Props): JSX.Element {
  const api = useHostApi();
  const [providers, setProviders] = useState<CustomClaudeProviderSummary[] | null>(null);
  const [plannerProviders, setPlannerProviders] = useState<PlannerProvider[]>([]);
  const [plannerModels, setPlannerModels] = useState<PlannerModel[]>([]);
  const [encryptionAvailable, setEncryptionAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** `null` = closed, `'new'` = create, otherwise the id being edited. */
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>({
    name: '',
    providerId: '',
    defaultModel: '',
    smallModel: '',
    allowUnattended: false,
    supportsEffort: true,
  });
  const [confirmingDelete, setConfirmingDelete] = useState<CustomClaudeProviderSummary | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      const [customRes, plannerProvRes, plannerModRes] = await Promise.all([
        api.listCustomClaudeProviders(),
        api.listPlannerProviders(),
        api.listPlannerModels(),
      ]);
      setProviders(customRes.providers);
      setEncryptionAvailable(customRes.encryptionAvailable);
      setPlannerProviders(plannerProvRes.providers ?? []);
      setPlannerModels(plannerModRes.models ?? []);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load custom Claude providers.');
    }
  }, [api, onApiError]);

  useEffect(() => {
    void load();
  }, [load]);

  const anthropicProviders = plannerProviders.filter((p) => {
    if (!isApiKeyProviderKind(p.kind)) return false;
    const endpoints = p.endpoints?.length
      ? p.endpoints
      : defaultEndpointsForProviderKind(p.kind);
    return endpoints.includes('anthropic');
  });

  function patch(next: Partial<FormState>): void {
    setForm((prev) => ({ ...prev, ...next }));
  }

  function selectPlannerProvider(nextProviderId: string): void {
    const selected = anthropicProviders.find((p) => p.id === nextProviderId);
    const available = modelsForPlannerProvider(selected, plannerModels);
    const firstModel = available[0]?.modelId ?? '';
    const secondModel =
      selected?.kind === 'deepseek' && available.length > 1 ? (available[1]?.modelId ?? '') : '';
    setForm((prev) => ({
      ...prev,
      providerId: nextProviderId,
      name:
        prev.name.trim().length === 0 && selected
          ? `Claude Code (${selected.label})`
          : prev.name,
      defaultModel: available.some((m) => m.modelId === prev.defaultModel)
        ? prev.defaultModel
        : firstModel,
      smallModel:
        prev.smallModel && available.some((m) => m.modelId === prev.smallModel)
          ? prev.smallModel
          : secondModel,
    }));
  }

  function openCreate(): void {
    const firstProvider = anthropicProviders[0];
    const available = modelsForPlannerProvider(firstProvider, plannerModels);
    const firstModel = available[0]?.modelId ?? '';
    const secondModel =
      firstProvider?.kind === 'deepseek' && available.length > 1
        ? (available[1]?.modelId ?? '')
        : '';
    setForm({
      name: firstProvider ? `Claude Code (${firstProvider.label})` : '',
      providerId: firstProvider?.id ?? '',
      defaultModel: firstModel,
      smallModel: secondModel,
      allowUnattended: false,
      supportsEffort: true,
    });
    setEditing('new');
    setError(null);
  }

  function openEdit(provider: CustomClaudeProviderSummary): void {
    const matchedProviderId =
      provider.providerId ??
      anthropicProviders.find((p) => p.baseUrl === provider.baseUrl)?.id ??
      '';
    setForm({
      name: provider.name,
      providerId: matchedProviderId,
      defaultModel: provider.defaultModel,
      smallModel: provider.smallModel ?? '',
      allowUnattended: provider.allowUnattended,
      supportsEffort: provider.supportsEffort !== false,
    });
    setEditing(provider.id);
    setError(null);
  }

  const editingProvider =
    editing && editing !== 'new'
      ? (providers ?? []).find((p) => p.id === editing)
      : undefined;
  const selectedPlannerProvider = anthropicProviders.find((p) => p.id === form.providerId);
  const availableModels = modelsForPlannerProvider(
    selectedPlannerProvider,
    plannerModels,
    editingProvider?.models,
  );
  const availableModelIds = availableModels.map((m) => m.modelId);

  const problem = ((): string | null => {
    if (form.name.trim().length === 0) return 'A name is required.';
    if (!form.providerId.trim()) {
      return 'Select an Anthropic-enabled provider from Providers and Models.';
    }
    if (!selectedPlannerProvider) {
      return 'Selected provider is not found or does not have the Anthropic endpoint enabled.';
    }
    if (!selectedPlannerProvider.hasApiKey) {
      return `Provider "${selectedPlannerProvider.label}" does not have an API key configured yet. Set its API key in Providers and Models first.`;
    }
    if (availableModelIds.length === 0) {
      return `Provider "${selectedPlannerProvider.label}" has no models configured yet. Add models to it in Providers and Models first.`;
    }
    if (!form.defaultModel.trim() || !availableModelIds.includes(form.defaultModel.trim())) {
      return 'Choose a default model from the provider’s model list.';
    }
    if (form.smallModel.trim() && !availableModelIds.includes(form.smallModel.trim())) {
      return 'The small model must be one of the provider’s models.';
    }
    return null;
  })();

  async function save(): Promise<void> {
    if (problem !== null || editing === null) return;
    setBusy(true);
    try {
      const payload = {
        name: form.name.trim(),
        providerId: form.providerId.trim(),
        defaultModel: form.defaultModel.trim(),
        smallModel: form.smallModel.trim() || null,
        allowUnattended: form.allowUnattended,
        supportsEffort: form.supportsEffort,
      };
      if (editing === 'new') {
        await api.createCustomClaudeProvider(payload);
      } else {
        await api.updateCustomClaudeProvider(editing, payload);
      }
      setEditing(null);
      await load();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not save the provider.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(provider: CustomClaudeProviderSummary): Promise<void> {
    setBusy(true);
    try {
      await api.deleteCustomClaudeProvider(provider.id);
      setConfirmingDelete(null);
      if (editing === provider.id) setEditing(null);
      await load();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not delete the provider.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="transport-hint" style={{ marginBottom: 10 }}>
        Claude Code, pointed at any Anthropic-enabled provider from{' '}
        <strong>Providers and Models</strong>. Pick a provider with the{' '}
        <code>Anthropic (/v1/messages)</code> endpoint checked (such as DeepSeek, OpenCode Zen,
        OpenCode Go, OmniRoute, or any Anthropic-compatible gateway) and choose from its models.
      </p>

      {!encryptionAvailable && (
        <div className="warn-callout" role="alert">
          Set <code>POCKETAGENT_SETTINGS_ENC_KEY</code> in <code>.env</code> and restart to enable
          custom Claude providers — an API key is stored encrypted, and there is no key to encrypt
          it with yet. Generate one with{' '}
          <code>node -e &quot;console.log(require(&apos;crypto&apos;).randomBytes(32).toString(&apos;base64&apos;))&quot;</code>.
        </div>
      )}

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {providers === null ? (
        <div className="spinner">Loading…</div>
      ) : providers.length === 0 ? (
        <p className="planner-row-meta">No custom Claude configurations yet.</p>
      ) : (
        providers.map((p) => {
          const linked = p.providerId
            ? plannerProviders.find((pp) => pp.id === p.providerId)
            : undefined;
          return (
            <div key={p.id} className="planner-model-row">
              <span>
                <strong>{p.name}</strong>{' '}
                <span className="planner-row-meta">
                  ({linked ? linked.label : p.providerKind === 'deepseek' ? 'DeepSeek' : 'Anthropic endpoint'})
                </span>
                {p.allowUnattended && <span className="settings-badge">Unattended use allowed</span>}
                <br />
                <span className="planner-row-meta" style={{ wordBreak: 'break-all' }}>
                  {p.baseUrl} — {p.defaultModel}
                </span>
              </span>
              <div className="planner-row-actions">
                <button
                  type="button"
                  className="planner-btn"
                  disabled={busy}
                  onClick={() => openEdit(p)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="planner-btn danger"
                  disabled={busy}
                  onClick={() => setConfirmingDelete(p)}
                  aria-label={`Delete ${p.name}`}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </div>
          );
        })
      )}

      {editing === null ? (
        <div className="planner-inline" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="planner-btn"
            disabled={busy || !encryptionAvailable}
            onClick={openCreate}
          >
            Add custom Claude
          </button>
        </div>
      ) : (
        <div className="planner-section" style={{ marginTop: 12 }}>
          <h3>{editing === 'new' ? 'New custom Claude' : 'Edit custom Claude'}</h3>

          {anthropicProviders.length === 0 && (
            <div className="warn-callout" role="note" style={{ marginBottom: 10 }}>
              No Anthropic-enabled providers found. Open <strong>Providers and Models</strong>,
              create or edit a provider (e.g. DeepSeek, OpenCode Zen, OpenCode Go, or an API
              endpoint), and check the <code>Anthropic (/v1/messages)</code> endpoint checkbox.
            </div>
          )}

          <div className="planner-field">
            <label htmlFor="ccp-name">Name</label>
            <input
              id="ccp-name"
              type="text"
              placeholder="Claude Code (DeepSeek)"
              value={form.name}
              disabled={busy}
              onChange={(e) => patch({ name: e.target.value })}
            />
            <p className="planner-row-meta">Shown wherever an agent is named.</p>
          </div>

          <div className="planner-field">
            <label htmlFor="ccp-provider">Provider (Anthropic-enabled)</label>
            <select
              id="ccp-provider"
              value={form.providerId}
              disabled={busy}
              onChange={(e) => selectPlannerProvider(e.target.value)}
            >
              <option value="">Choose an Anthropic-enabled provider…</option>
              {anthropicProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({p.kind})
                </option>
              ))}
            </select>
            <p className="planner-row-meta">
              Lists providers from <strong>Providers and Models</strong> that have the{' '}
              <code>Anthropic (/v1/messages)</code> endpoint enabled.
            </p>
          </div>

          <div className="planner-field">
            <label htmlFor="ccp-default-model">Default model</label>
            <select
              id="ccp-default-model"
              value={form.defaultModel}
              disabled={busy || availableModels.length === 0}
              onChange={(e) => patch({ defaultModel: e.target.value })}
            >
              {!availableModelIds.includes(form.defaultModel.trim()) && (
                <option value="">Choose a model…</option>
              )}
              {availableModels.map((m) => (
                <option key={m.modelId} value={m.modelId}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <div className="planner-field">
            <label htmlFor="ccp-small-model">Small model</label>
            <select
              id="ccp-small-model"
              value={form.smallModel}
              disabled={busy || availableModels.length === 0}
              onChange={(e) => patch({ smallModel: e.target.value })}
            >
              <option value="">Same as the default model</option>
              {availableModels.map((m) => (
                <option key={m.modelId} value={m.modelId}>
                  {m.label}
                </option>
              ))}
            </select>
            <p className="planner-row-meta">
              Used for conversation titles and compaction summaries.
            </p>
          </div>

          <label className="planner-checkbox-row" style={{ marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={form.supportsEffort}
              disabled={busy}
              onChange={(e) => patch({ supportsEffort: e.target.checked })}
            />
            <span>
              <strong>Support reasoning effort &amp; thinking</strong> — enable thinking on/off and
              reasoning effort controls (low, medium, high, extra high) for models on this provider.
            </span>
          </label>

          <label className="planner-checkbox-row" style={{ marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={form.allowUnattended}
              disabled={busy}
              onChange={(e) => patch({ allowUnattended: e.target.checked })}
            />
            <span>
              <strong>Allow unattended use</strong> — let scheduled jobs and inbound webhooks run on
              this provider.
            </span>
          </label>
          {form.allowUnattended && (
            <div className="warn-callout" role="alert">
              A timer, or a stranger&apos;s Jira edit, will send this repository&apos;s contents to
              this third-party endpoint with nobody watching. Leave this off unless you mean it.
            </div>
          )}

          {problem !== null && <p className="planner-row-meta">{problem}</p>}

          <div className="planner-inline" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="planner-btn"
              disabled={busy || problem !== null}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Save custom Claude'}
            </button>
            <button
              type="button"
              className="planner-btn"
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {confirmingDelete && (
        <ConfirmDialog
          title={`Delete ${confirmingDelete.name}?`}
          body={
            'Chats already started on this custom Claude configuration keep their transcripts — ' +
            'they just can no longer be continued on it.'
          }
          confirmLabel="Delete"
          busy={busy}
          onConfirm={() => void remove(confirmingDelete)}
          onCancel={() => setConfirmingDelete(null)}
        />
      )}
    </>
  );
}
