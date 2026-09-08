import { useCallback, useEffect, useState } from 'react';
import type { McpAuthKind, McpRegistrySummary, McpTransportKind, TestMcpRegistryResponse } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { Icon } from './Icon.js';

interface Props {
  onApiError: (error: unknown) => void;
  /** Called after a successful create/update/delete/test, so the parent's own
      `Tools` list (which merges in every registry's cached tools) reloads
      too — mirrors how every other mutation on this page already triggers
      `load()`. */
  onChanged: () => void;
}

interface FormState {
  name: string;
  transport: McpTransportKind;
  url: string;
  authKind: McpAuthKind;
  bearerToken: string;
  headerName: string;
  headerValue: string;
  enabled: boolean;
}

function blankForm(): FormState {
  return {
    name: '',
    transport: 'streamable_http',
    url: '',
    authKind: 'none',
    bearerToken: '',
    headerName: '',
    headerValue: '',
    enabled: true,
  };
}

function formFor(registry: McpRegistrySummary): FormState {
  return {
    name: registry.name,
    transport: registry.transport,
    url: registry.url,
    authKind: registry.authKind,
    // Always empty: there is no reveal endpoint, so the editor genuinely does
    // not have the stored secret to prefill. Blank on save means "keep it".
    bearerToken: '',
    headerName: registry.headerName ?? '',
    headerValue: '',
    enabled: registry.enabled,
  };
}

/**
 * PA-37: manage MCP (Model Context Protocol) registries — remote servers
 * whose tools join the planner's own tool-calling loop through the
 * `list_mcp_tools`/`call_mcp_tool` meta-tools.
 *
 * Follow-up (reporter: "Let's not list the mcp tool as separate tools to
 * allow/disallow. Let's just enable/disable mcp as whole for global or each
 * agent. So mcp list will add something to enable or disable [...]"):
 * individual MCP tools are **not** listed in the global "Tools" settings
 * section the way native tools are — this section instead owns the one
 * global on/off switch for MCP as a whole (`PlannerSettingsDto.mcpEnabled`);
 * the per-agent half of that same switch lives on each agent's own editor
 * page, in its own "MCP" section that can flip the switch but cannot touch
 * any registry's settings.
 *
 * Registry CRUD itself is modeled directly on `CustomClaudeProvidersSection`:
 * an explicit **Save** rather than autosave (this is a live connection
 * target, not a preference — a half-typed URL must never be pushed into a
 * real connection attempt on every keystroke), a password-style secret field
 * with no reveal, and blank-on-edit meaning "keep the stored value".
 */
export function McpRegistriesSection({ onApiError, onChanged }: Props): JSX.Element {
  const [registries, setRegistries] = useState<McpRegistrySummary[] | null>(null);
  const [encryptionAvailable, setEncryptionAvailable] = useState(true);
  const [mcpEnabled, setMcpEnabledState] = useState(true);
  const [togglingMcpEnabled, setTogglingMcpEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** `null` = closed, `'new'` = create, otherwise the id being edited. */
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(blankForm);
  const [confirmingDelete, setConfirmingDelete] = useState<McpRegistrySummary | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestMcpRegistryResponse | 'testing'>>({});

  const load = useCallback(async () => {
    try {
      const [registriesRes, settings] = await Promise.all([api.listMcpRegistries(), api.getPlannerSettings()]);
      setRegistries(registriesRes.registries);
      setEncryptionAvailable(registriesRes.encryptionAvailable);
      setMcpEnabledState(settings.mcpEnabled);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load MCP registries.');
    }
  }, [onApiError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleMcpEnabled(next: boolean): Promise<void> {
    setTogglingMcpEnabled(true);
    try {
      const settings = await api.updatePlannerSettings({ mcpEnabled: next });
      setMcpEnabledState(settings.mcpEnabled);
      onChanged();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not update the MCP switch.');
    } finally {
      setTogglingMcpEnabled(false);
    }
  }

  function patch(next: Partial<FormState>): void {
    setForm((prev) => ({ ...prev, ...next }));
  }

  function openCreate(): void {
    setForm(blankForm());
    setEditing('new');
    setError(null);
  }

  function openEdit(registry: McpRegistrySummary): void {
    setForm(formFor(registry));
    setEditing(registry.id);
    setError(null);
  }

  const problem = ((): string | null => {
    if (form.name.trim().length === 0) return 'A name is required.';
    if (form.url.trim().length === 0) return 'A URL is required.';
    if (form.authKind === 'bearer' && editing === 'new' && form.bearerToken.trim().length === 0) {
      return 'A bearer token is required.';
    }
    if (form.authKind === 'header') {
      if (form.headerName.trim().length === 0) return 'A header name is required.';
      if (editing === 'new' && form.headerValue.trim().length === 0) return 'A header value is required.';
    }
    return null;
  })();

  async function save(): Promise<void> {
    if (problem !== null || editing === null) return;
    setBusy(true);
    try {
      const common = {
        name: form.name.trim(),
        transport: form.transport,
        url: form.url.trim(),
        authKind: form.authKind,
        enabled: form.enabled,
        ...(form.authKind === 'header' ? { headerName: form.headerName.trim() } : {}),
      };
      if (editing === 'new') {
        await api.createMcpRegistry({
          ...common,
          ...(form.authKind === 'bearer' ? { bearerToken: form.bearerToken } : {}),
          ...(form.authKind === 'header' ? { headerValue: form.headerValue } : {}),
        });
      } else {
        await api.updateMcpRegistry(editing, {
          ...common,
          // Omitted entirely when blank, so the server's "keep the stored
          // secret" path is taken rather than relying on it to re-check.
          ...(form.authKind === 'bearer' && form.bearerToken.trim() ? { bearerToken: form.bearerToken } : {}),
          ...(form.authKind === 'header' && form.headerValue.trim() ? { headerValue: form.headerValue } : {}),
        });
      }
      setEditing(null);
      await load();
      onChanged();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not save the MCP registry.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(registry: McpRegistrySummary): Promise<void> {
    setBusy(true);
    try {
      await api.deleteMcpRegistry(registry.id);
      setConfirmingDelete(null);
      if (editing === registry.id) setEditing(null);
      await load();
      onChanged();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not delete the MCP registry.');
    } finally {
      setBusy(false);
    }
  }

  // PA-37 follow-up round two: a quick inline toggle for the registry's own
  // *global* switch — "we can globally disable bamboo mcp but allow Jira
  // mcp" — right on the row, rather than requiring Edit -> uncheck Enabled
  // -> Save for what is otherwise a one-field, no-secret-touching change.
  async function toggleRegistryEnabled(registry: McpRegistrySummary, enabled: boolean): Promise<void> {
    setBusy(true);
    try {
      await api.updateMcpRegistry(registry.id, { enabled });
      await load();
      onChanged();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not update the registry.');
    } finally {
      setBusy(false);
    }
  }

  async function test(registry: McpRegistrySummary, refresh: boolean): Promise<void> {
    setTestResults((prev) => ({ ...prev, [registry.id]: 'testing' }));
    try {
      const result = refresh ? await api.refreshMcpRegistryTools(registry.id) : await api.testMcpRegistry(registry.id);
      setTestResults((prev) => ({ ...prev, [registry.id]: result }));
      await load();
      onChanged();
    } catch (err) {
      onApiError(err);
      setTestResults((prev) => ({
        ...prev,
        [registry.id]: { ok: false, message: err instanceof ApiError ? err.message : 'Test failed.', latencyMs: 0, toolCount: null },
      }));
    }
  }

  return (
    <>
      <p className="transport-hint" style={{ marginBottom: 10 }}>
        Remote MCP (Model Context Protocol) servers. Their tools are not listed individually — an
        agent either has MCP access or it doesn't, switched on below globally and per agent (each
        agent's own editor page has its own "MCP" section with just this one switch — it cannot
        change what a registry is). A new registry is connected to once immediately on save; if
        that fails (a wrong URL, an unreachable host), it's still saved so you can fix it and use
        "Test connection" to retry.
      </p>

      <label className="planner-checkbox-row" style={{ marginBottom: 14 }}>
        <input
          type="checkbox"
          checked={mcpEnabled}
          disabled={togglingMcpEnabled}
          onChange={(e) => void toggleMcpEnabled(e.target.checked)}
        />
        <span>
          <strong>Enable MCP</strong> — the global switch. Off hides every registry's tools from
          every agent, even one with its own per-agent switch on, and even a fully configured,
          reachable registry.
        </span>
      </label>

      {!encryptionAvailable && (
        <div className="warn-callout" role="alert">
          Set <code>POCKETAGENT_SETTINGS_ENC_KEY</code> in <code>.env</code> and restart to enable
          bearer/header auth for an MCP registry — a token is stored encrypted, and there is no key to
          encrypt it with yet. A registry with no auth still works.
        </div>
      )}

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {registries === null ? (
        <div className="spinner">Loading…</div>
      ) : registries.length === 0 ? (
        <p className="planner-row-meta">No MCP registries yet.</p>
      ) : (
        registries.map((r) => {
          const result = testResults[r.id];
          return (
            <div key={r.id} className="planner-model-row">
              <span>
                <label className="planner-checkbox-row" style={{ display: 'inline-flex', marginRight: 8 }}>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    disabled={busy}
                    aria-label={`Enable ${r.name} globally`}
                    onChange={(e) => void toggleRegistryEnabled(r, e.target.checked)}
                  />
                </label>
                <strong>{r.name}</strong>{' '}
                <span className="planner-row-meta">
                  ({r.transport === 'streamable_http' ? 'Streamable HTTP' : 'HTTP+SSE'})
                </span>
                {!r.enabled && <span className="settings-badge">Disabled</span>}
                <br />
                <span className="planner-row-meta" style={{ wordBreak: 'break-all' }}>
                  {r.url}
                </span>
                <br />
                <span className="planner-row-meta">
                  {r.lastConnectedAt
                    ? `${r.toolCount} tool(s), last connected ${new Date(r.lastConnectedAt).toLocaleString()}`
                    : 'Never connected'}
                  {r.lastError && ` — last error: ${r.lastError}`}
                </span>
                {result && result !== 'testing' && (
                  <>
                    <br />
                    <span className="planner-row-meta">
                      {result.ok ? '✓' : '✗'} {result.message} ({result.latencyMs}ms)
                    </span>
                  </>
                )}
              </span>
              <div className="planner-row-actions">
                <button
                  type="button"
                  className="planner-btn"
                  disabled={busy || result === 'testing'}
                  onClick={() => void test(r, false)}
                >
                  {result === 'testing' ? 'Testing…' : 'Test connection'}
                </button>
                <button
                  type="button"
                  className="planner-btn"
                  disabled={busy || result === 'testing'}
                  onClick={() => void test(r, true)}
                >
                  Refresh tools
                </button>
                <button type="button" className="planner-btn" disabled={busy} onClick={() => openEdit(r)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="planner-btn danger"
                  disabled={busy}
                  onClick={() => setConfirmingDelete(r)}
                  aria-label={`Delete ${r.name}`}
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
          <button type="button" className="planner-btn" disabled={busy} onClick={openCreate}>
            Add MCP registry
          </button>
        </div>
      ) : (
        <div className="planner-section" style={{ marginTop: 12 }}>
          <h3>{editing === 'new' ? 'New MCP registry' : 'Edit MCP registry'}</h3>

          <div className="planner-field">
            <label htmlFor="mcp-name">Name</label>
            <input
              id="mcp-name"
              type="text"
              placeholder="Jira MCP"
              value={form.name}
              disabled={busy}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </div>

          <div className="planner-field">
            <label htmlFor="mcp-transport">Transport</label>
            <select
              id="mcp-transport"
              value={form.transport}
              disabled={busy}
              onChange={(e) => patch({ transport: e.target.value as McpTransportKind })}
            >
              <option value="streamable_http">Streamable HTTP (recommended)</option>
              <option value="sse">HTTP + SSE (legacy)</option>
            </select>
          </div>

          <div className="planner-field">
            <label htmlFor="mcp-url">URL</label>
            <input
              id="mcp-url"
              type="text"
              placeholder="https://mcp.example.com/jira"
              value={form.url}
              disabled={busy}
              onChange={(e) => patch({ url: e.target.value })}
            />
          </div>

          <div className="planner-field">
            <label htmlFor="mcp-auth">Authentication</label>
            <select
              id="mcp-auth"
              value={form.authKind}
              disabled={busy}
              onChange={(e) => patch({ authKind: e.target.value as McpAuthKind })}
            >
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="header">Custom header</option>
            </select>
          </div>

          {form.authKind === 'bearer' && (
            <div className="planner-field">
              <label htmlFor="mcp-bearer">Bearer token</label>
              <input
                id="mcp-bearer"
                type="password"
                autoComplete="new-password"
                placeholder={editing === 'new' ? 'token…' : '••••••••  (leave blank to keep)'}
                value={form.bearerToken}
                disabled={busy || !encryptionAvailable}
                onChange={(e) => patch({ bearerToken: e.target.value })}
              />
              <p className="planner-row-meta">
                Sent as <code>Authorization: Bearer &lt;token&gt;</code>. Stored encrypted, never sent
                back to this page.
              </p>
            </div>
          )}

          {form.authKind === 'header' && (
            <>
              <div className="planner-field">
                <label htmlFor="mcp-header-name">Header name</label>
                <input
                  id="mcp-header-name"
                  type="text"
                  placeholder="X-API-Key"
                  value={form.headerName}
                  disabled={busy || !encryptionAvailable}
                  onChange={(e) => patch({ headerName: e.target.value })}
                />
              </div>
              <div className="planner-field">
                <label htmlFor="mcp-header-value">Header value</label>
                <input
                  id="mcp-header-value"
                  type="password"
                  autoComplete="new-password"
                  placeholder={editing === 'new' ? 'value…' : '••••••••  (leave blank to keep)'}
                  value={form.headerValue}
                  disabled={busy || !encryptionAvailable}
                  onChange={(e) => patch({ headerValue: e.target.value })}
                />
                <p className="planner-row-meta">Stored encrypted, never sent back to this page.</p>
              </div>
            </>
          )}

          <label className="planner-checkbox-row" style={{ margin: '10px 0' }}>
            <input
              type="checkbox"
              checked={form.enabled}
              disabled={busy}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            <span>
              <strong>Enabled</strong> — off hides every one of this registry's tools from every agent
              without deleting it or its stored secret.
            </span>
          </label>

          {problem !== null && <p className="planner-row-meta">{problem}</p>}

          <div className="planner-inline" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="planner-btn"
              disabled={busy || problem !== null}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Save registry'}
            </button>
            <button type="button" className="planner-btn" disabled={busy} onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {confirmingDelete && (
        <ConfirmDialog
          title={`Delete ${confirmingDelete.name}?`}
          body={
            'The stored secret is deleted with it, along with any per-agent or global enable/disable ' +
            'decisions recorded for its tools.'
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
