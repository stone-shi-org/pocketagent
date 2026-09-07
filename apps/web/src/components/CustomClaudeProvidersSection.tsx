import { useCallback, useEffect, useState } from 'react';
import {
  DEEPSEEK_DEFAULTS,
  type CustomClaudeProviderKind,
  type CustomClaudeProviderSummary,
} from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { Icon } from './Icon.js';

interface Props {
  onApiError: (error: unknown) => void;
}

interface FormState {
  name: string;
  providerKind: CustomClaudeProviderKind;
  baseUrl: string;
  apiKey: string;
  models: string[];
  defaultModel: string;
  smallModel: string;
  allowUnattended: boolean;
}

function blankForm(): FormState {
  return {
    name: '',
    providerKind: 'deepseek',
    baseUrl: DEEPSEEK_DEFAULTS.baseUrl,
    apiKey: '',
    models: [...DEEPSEEK_DEFAULTS.models],
    defaultModel: DEEPSEEK_DEFAULTS.defaultModel,
    smallModel: DEEPSEEK_DEFAULTS.smallModel,
    allowUnattended: false,
  };
}

function formFor(provider: CustomClaudeProviderSummary): FormState {
  return {
    name: provider.name,
    providerKind: provider.providerKind,
    baseUrl: provider.baseUrl,
    // Always empty: there is no reveal endpoint, so the editor genuinely does
    // not have the stored key to prefill. Blank on save means "keep it".
    apiKey: '',
    models: [...provider.models],
    defaultModel: provider.defaultModel,
    smallModel: provider.smallModel ?? '',
    allowUnattended: provider.allowUnattended,
  };
}

/**
 * PA-28: manage the Claude Code provider variants, which used to be two
 * compiled-in entries configured through `POCKETAGENT_DEEPSEEK_*` /
 * `POCKETAGENT_OMNIROUTE_*` (PA-19).
 *
 * Unlike every other row on `SettingsPage`, this form has an explicit **Save**
 * rather than auto-saving on change — deliberately, and it is the same reasoning
 * that makes `PlannerAgentEditorPage` stop and confirm on its one directory
 * field while auto-saving the rest. A provider is not a preference: saving it
 * re-registers a live `AgentAdapter`, and the base URL, key and model ids in it
 * are what the *next spawned agent process* is pointed at. Auto-saving would
 * push a half-typed base URL into that adapter on every keystroke, and a
 * multi-field create has nothing to auto-save into in the first place.
 *
 * The API key is write-only end to end: it is a password input here, it is
 * never returned by any route, and there is no reveal action — editing a
 * provider re-enters the key or leaves the field blank to keep the stored one.
 */
export function CustomClaudeProvidersSection({ onApiError }: Props): JSX.Element {
  const [providers, setProviders] = useState<CustomClaudeProviderSummary[] | null>(null);
  const [encryptionAvailable, setEncryptionAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** `null` = closed, `'new'` = create, otherwise the id being edited. */
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(blankForm);
  const [confirmingDelete, setConfirmingDelete] = useState<CustomClaudeProviderSummary | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      const res = await api.listCustomClaudeProviders();
      setProviders(res.providers);
      setEncryptionAvailable(res.encryptionAvailable);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load custom Claude providers.');
    }
  }, [onApiError]);

  useEffect(() => {
    void load();
  }, [load]);

  function patch(next: Partial<FormState>): void {
    setForm((prev) => ({ ...prev, ...next }));
  }

  /**
   * Switching kind prefills, but only ever *forward* into an untouched form —
   * a user who has typed their own gateway URL must not lose it because they
   * clicked the wrong radio and clicked back.
   */
  function pickKind(kind: CustomClaudeProviderKind): void {
    if (kind === 'deepseek' && form.baseUrl.trim().length === 0) {
      patch({
        providerKind: kind,
        baseUrl: DEEPSEEK_DEFAULTS.baseUrl,
        models: [...DEEPSEEK_DEFAULTS.models],
        defaultModel: DEEPSEEK_DEFAULTS.defaultModel,
        smallModel: DEEPSEEK_DEFAULTS.smallModel,
      });
      return;
    }
    patch({ providerKind: kind });
  }

  function openCreate(): void {
    setForm(blankForm());
    setEditing('new');
    setError(null);
  }

  function openEdit(provider: CustomClaudeProviderSummary): void {
    setForm(formFor(provider));
    setEditing(provider.id);
    setError(null);
  }

  const models = form.models.map((m) => m.trim()).filter(Boolean);
  const problem = ((): string | null => {
    if (form.name.trim().length === 0) return 'A name is required.';
    if (form.baseUrl.trim().length === 0) return 'A base URL is required.';
    if (models.length === 0) return 'At least one model id is required.';
    if (!models.includes(form.defaultModel.trim())) {
      return 'The default model must be one of the models listed above.';
    }
    if (form.smallModel.trim() && !models.includes(form.smallModel.trim())) {
      return 'The small model must be one of the models listed above.';
    }
    // Only on create: on edit, blank means "keep the stored key".
    if (editing === 'new' && form.apiKey.trim().length === 0) return 'An API key is required.';
    return null;
  })();

  async function save(): Promise<void> {
    if (problem !== null || editing === null) return;
    setBusy(true);
    try {
      const common = {
        name: form.name.trim(),
        providerKind: form.providerKind,
        baseUrl: form.baseUrl.trim(),
        models,
        defaultModel: form.defaultModel.trim(),
        smallModel: form.smallModel.trim() || null,
        allowUnattended: form.allowUnattended,
      };
      if (editing === 'new') {
        await api.createCustomClaudeProvider({ ...common, apiKey: form.apiKey });
      } else {
        await api.updateCustomClaudeProvider(editing, {
          ...common,
          // Omitted entirely when blank, so the server's "keep the stored key"
          // path is taken rather than relying on it to re-check for emptiness.
          ...(form.apiKey.trim() ? { apiKey: form.apiKey } : {}),
        });
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
        Claude Code, pointed at a third-party Anthropic-compatible endpoint. It is the same{' '}
        <code>claude</code> binary with a different base URL, so a conversation rate-limited on
        Anthropic can be continued here and lands in the same transcript. Cost figures shown in a
        session of one of these are computed with Anthropic pricing and will be wrong.
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
        <p className="planner-row-meta">No custom providers yet.</p>
      ) : (
        providers.map((p) => (
          <div key={p.id} className="planner-model-row">
            <span>
              <strong>{p.name}</strong>{' '}
              <span className="planner-row-meta">
                ({p.providerKind === 'deepseek' ? 'DeepSeek' : 'Claude-compatible'})
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
        ))
      )}

      {editing === null ? (
        <div className="planner-inline" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="planner-btn"
            disabled={busy || !encryptionAvailable}
            onClick={openCreate}
          >
            Add provider
          </button>
        </div>
      ) : (
        <div className="planner-section" style={{ marginTop: 12 }}>
          <h3>{editing === 'new' ? 'New provider' : 'Edit provider'}</h3>

          <div className="planner-field">
            <label htmlFor="ccp-kind">Provider</label>
            <select
              id="ccp-kind"
              value={form.providerKind}
              disabled={busy}
              onChange={(e) => pickKind(e.target.value as CustomClaudeProviderKind)}
            >
              <option value="deepseek">DeepSeek</option>
              <option value="claude-compatible">Other Anthropic-compatible endpoint</option>
            </select>
            <p className="planner-row-meta">
              Only affects the suggestions below — nothing about how the session runs depends on it.
            </p>
          </div>

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
            <label htmlFor="ccp-base-url">Base URL</label>
            <input
              id="ccp-base-url"
              type="text"
              placeholder={DEEPSEEK_DEFAULTS.baseUrl}
              value={form.baseUrl}
              disabled={busy}
              onChange={(e) => patch({ baseUrl: e.target.value })}
            />
            <p className="planner-row-meta">
              Bare origin — no <code>/v1</code> or <code>/messages</code>. Claude Code appends its
              own path.
            </p>
          </div>

          <div className="planner-field">
            <label htmlFor="ccp-api-key">API key</label>
            <input
              id="ccp-api-key"
              type="password"
              autoComplete="new-password"
              placeholder={editing === 'new' ? 'sk-…' : '••••••••  (leave blank to keep)'}
              value={form.apiKey}
              disabled={busy}
              onChange={(e) => patch({ apiKey: e.target.value })}
            />
            <p className="planner-row-meta">
              Stored encrypted, and never sent back to this page — there is no reveal. To change it,
              type a new one; leave it blank to keep the stored key.
            </p>
          </div>

          <div className="planner-field">
            <label>Models</label>
            {form.models.map((model, i) => (
              // Index-keyed on purpose: these rows are positional free text with
              // no stable id of their own, and a value-keyed list would remount
              // (and lose focus in) the input being typed into the moment two
              // rows briefly matched.
              <div key={i} className="planner-inline" style={{ marginBottom: 6 }}>
                <input
                  type="text"
                  placeholder="model-id"
                  value={model}
                  disabled={busy}
                  onChange={(e) =>
                    patch({ models: form.models.map((m, j) => (j === i ? e.target.value : m)) })
                  }
                />
                <button
                  type="button"
                  className="planner-btn danger"
                  disabled={busy || form.models.length === 1}
                  aria-label="Remove this model"
                  onClick={() => patch({ models: form.models.filter((_, j) => j !== i) })}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="planner-btn"
              disabled={busy}
              onClick={() => patch({ models: [...form.models, ''] })}
            >
              Add model
            </button>
            <p className="planner-row-meta">
              Take these from the provider&apos;s own <code>/models</code>. Claude Code reports
              Anthropic&apos;s catalog whatever the base URL says, so this list replaces it rather
              than adding to it — a guessed id yields a picker entry the endpoint rejects.
            </p>
          </div>

          <div className="planner-field">
            <label htmlFor="ccp-default-model">Default model</label>
            <select
              id="ccp-default-model"
              value={form.defaultModel}
              disabled={busy}
              onChange={(e) => patch({ defaultModel: e.target.value })}
            >
              {!models.includes(form.defaultModel.trim()) && <option value="">Choose a model…</option>}
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          <div className="planner-field">
            <label htmlFor="ccp-small-model">Small model</label>
            <select
              id="ccp-small-model"
              value={form.smallModel}
              disabled={busy}
              onChange={(e) => patch({ smallModel: e.target.value })}
            >
              <option value="">Same as the default model</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <p className="planner-row-meta">
              Used for conversation titles and compaction summaries, which run constantly. If the
              endpoint does not know the id, those fail mid-session rather than at start.
            </p>
          </div>

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
              {busy ? 'Saving…' : 'Save provider'}
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
            'The stored API key is deleted with it. Chats already started on this provider keep ' +
            'their transcripts — they just can no longer be continued on it.'
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
