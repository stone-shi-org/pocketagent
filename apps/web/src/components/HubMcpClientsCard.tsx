import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_HUB_MCP_SCOPES,
  HUB_MCP_SCOPES,
  MCP_SERVER_PATH,
  type HubMcpAttachState,
  type HubMcpClientToken,
  type HubMcpScope,
} from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import {
  createHubMcpToken,
  getHubMcpAttach,
  listHubMcpTokens,
  revokeHubMcpToken,
  setHubMcpAttach,
  updateHubMcpToken,
} from '../api/hub.js';
import type { HostRecord } from '../hosts/host-status.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { CopyButton } from './CopyButton.js';
import { Icon } from './Icon.js';

/**
 * PA-169: Hub MCP client tokens — one MCP entry that lets a coding agent
 * (Claude Code, Codex, any MCP client) reach every host behind this Hub and
 * pick one itself by passing `host`.
 *
 * Modelled on the backend's `McpClientsSection`: the Hub keeps only a digest,
 * so a token is shown once, and every row is revocable with effect on its very
 * next call. What is new is the host list. A coding agent's own permission
 * prompt is tool-wide ("always allow dispatch" is every host), and a
 * skip-permissions session has none, so the allowlist is the per-host control
 * — enforced by the Hub, whatever the client does.
 *
 * The address is prefilled from this browser's origin and editable, for the
 * reason `FleetAgentCard` gives: the Hub cannot know the address an agent on
 * another machine reaches it by. Talks only to the Hub origin (`api/hub.ts`).
 */

interface Props {
  hosts: readonly HostRecord[];
  onApiError: (error: unknown) => void;
}

const SCOPE_TEXT: Record<HubMcpScope, string> = {
  read: 'List hosts and what they can run, pending approvals, and the read-only fleet views.',
  dispatch: 'Start coding-agent and Pocket Agent work on a host, and wait for it.',
  admin: 'Change webhooks, scheduled jobs, providers and Pocket Agent settings on hosts.',
};

export function HubMcpClientsCard({ hosts, onApiError }: Props): JSX.Element {
  const [tokens, setTokens] = useState<HubMcpClientToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<HubMcpScope[]>([...DEFAULT_HUB_MCP_SCOPES]);
  const [allHosts, setAllHosts] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [hubUrl, setHubUrl] = useState<string>(() => window.location.origin);
  const [minted, setMinted] = useState<{ label: string; token: string } | null>(null);
  const [confirming, setConfirming] = useState<HubMcpClientToken | null>(null);
  const [editing, setEditing] = useState<{ id: string; scopes: HubMcpScope[]; hosts: string[] | null } | null>(null);

  const hostIds = hosts
    .map((host) => ({ id: host.hubHostId ?? host.endpoint.id, label: host.label }))
    .filter((host, i, all) => all.findIndex((h) => h.id === host.id) === i);
  const labelOf = (id: string): string => hostIds.find((h) => h.id === id)?.label ?? id;

  const [attach, setAttach] = useState<HubMcpAttachState | null>(null);
  const [confirmAttach, setConfirmAttach] = useState<'enable' | 'disable' | null>(null);

  const load = useCallback(async () => {
    try {
      const [res, attachState] = await Promise.all([listHubMcpTokens(), getHubMcpAttach()]);
      setTokens(res.tokens);
      setAttach(attachState);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load MCP clients.');
    }
  }, [onApiError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<void>, failure: string): Promise<void> {
    setBusy(true);
    try {
      await action();
      await load();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : failure);
    } finally {
      setBusy(false);
    }
  }

  const create = () =>
    run(async () => {
      const res = await createHubMcpToken({ label: label.trim(), scopes, hosts: allHosts ? null : picked });
      setMinted({ label: res.client.label, token: res.token });
      setLabel('');
      setScopes([...DEFAULT_HUB_MCP_SCOPES]);
      setAllHosts(true);
      setPicked([]);
    }, 'Could not create that token.');

  const toggle = <T,>(list: T[], value: T): T[] => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  const url = `${hubUrl.replace(/\/+$/, '')}${MCP_SERVER_PATH}`;
  const snippet = minted
    ? JSON.stringify(
        { mcpServers: { fleet: { type: 'http', url, headers: { Authorization: `Bearer ${minted.token}` } } } },
        null,
        2,
      )
    : '';
  const claudeCommand = minted
    ? `claude mcp add --transport http fleet ${url} --header "Authorization: Bearer ${minted.token}"`
    : '';

  return (
    <section className="hub-section" aria-labelledby="hub-mcp-clients-heading">
      <h2 id="hub-mcp-clients-heading">MCP clients</h2>
      <div className="hub-row-card fleet-card">
        <Icon name="mcp" size={20} className="hub-row-icon" />
        <div className="hub-row-main">
          <strong>
            {tokens === null
              ? 'Fleet MCP endpoint'
              : tokens.length === 0
                ? 'No client tokens'
                : `${tokens.length} client token${tokens.length === 1 ? '' : 's'}`}
          </strong>
          <span>
            A coding agent can use every host behind this Hub through one MCP entry, <code>{url}</code>: list
            hosts, see what each can run, and start work on the one it picks. Approvals on a host still wait for
            a person there. An MCP client can see an approval but can never answer one.
          </span>
          <label className="fleet-field" htmlFor="hub-mcp-url">
            <span>Hub address the client will use</span>
            <input
              id="hub-mcp-url"
              type="url"
              className="settings-input"
              value={hubUrl}
              onChange={(e) => setHubUrl(e.target.value)}
              spellCheck={false}
              aria-describedby="hub-mcp-url-hint"
            />
          </label>
          <span id="hub-mcp-url-hint" className="hub-muted">
            Prefilled with this browser’s address. Change it if the agent reaches the Hub by another name.
          </span>

          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}

          {minted && (
            <div className="hub-card-subsection" role="status">
              <strong className="hub-card-subsection-title">Token for {minted.label}</strong>
              <p className="transport-hint">
                Shown once. Only a digest is stored, so it cannot be shown again. Revoke it and create a new one
                if it is lost.
              </p>
              <div className="settings-row-control">
                <div className="endpoint-url">
                  <code>{minted.token}</code>
                  <CopyButton text={minted.token} label="Copy token" />
                </div>
                <div className="endpoint-url" style={{ marginTop: 8 }}>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                    <code>{snippet}</code>
                  </pre>
                  <CopyButton text={snippet} label="Copy config" />
                </div>
                <div className="endpoint-url" style={{ marginTop: 8 }}>
                  <code>{claudeCommand}</code>
                  <CopyButton text={claudeCommand} label="Copy command" />
                </div>
              </div>
              <div>
                <button type="button" className="planner-btn" onClick={() => setMinted(null)}>
                  Done
                </button>
              </div>
            </div>
          )}

          <div className="hub-card-subsection">
            {tokens === null ? (
              <div className="spinner">Loading…</div>
            ) : tokens.length === 0 ? (
              <p className="planner-row-meta" style={{ margin: 0 }}>No MCP clients.</p>
            ) : (
              tokens.map((token) => (
                <div key={token.id} className="planner-model-row">
                  <span>
                    <strong>{token.label}</strong>
                    {token.kind === 'coordinator' && <span className="planner-row-meta"> · Fleet agent</span>}
                    <br />
                    <span className="planner-row-meta">
                      <code>{token.tokenPrefix}…</code> · {token.scopes.join(', ')}
                      {token.scopes.includes('admin') ? ' (admin)' : ''} ·{' '}
                      {token.hosts === null ? 'every host' : token.hosts.map(labelOf).join(', ')}
                    </span>
                    <br />
                    <span className="planner-row-meta">
                      {token.lastSeenAt === null
                        ? 'Never used'
                        : `Last seen ${new Date(token.lastSeenAt).toLocaleString()}`}
                    </span>
                    {editing?.id === token.id && (
                      <span style={{ display: 'block', marginTop: 6 }}>
                        <div className="hub-checkbox-inline">
                          {HUB_MCP_SCOPES.map((scope) => (
                            <label key={scope} className="planner-checkbox-row">
                              <input
                                type="checkbox"
                                checked={editing.scopes.includes(scope)}
                                onChange={() => setEditing({ ...editing, scopes: toggle(editing.scopes, scope) })}
                              />{' '}
                              <strong>{scope}</strong>
                            </label>
                          ))}
                        </div>
                        <div className="hub-checkbox-inline" style={{ marginTop: 6 }}>
                          <label className="planner-checkbox-row">
                            <input
                              type="checkbox"
                              checked={editing.hosts === null}
                              onChange={() =>
                                setEditing({ ...editing, hosts: editing.hosts === null ? [] : null })
                              }
                            />{' '}
                            Every host
                          </label>
                          {editing.hosts !== null &&
                            hostIds.map((host) => (
                              <label key={host.id} className="planner-checkbox-row">
                                <input
                                  type="checkbox"
                                  checked={editing.hosts?.includes(host.id) ?? false}
                                  onChange={() =>
                                    setEditing({ ...editing, hosts: toggle(editing.hosts ?? [], host.id) })
                                  }
                                />{' '}
                                {host.label}
                              </label>
                            ))}
                        </div>
                        <span style={{ display: 'inline-flex', gap: 6, marginTop: 6 }}>
                          <button
                            type="button"
                            className="planner-btn"
                            disabled={
                              busy ||
                              editing.scopes.length === 0 ||
                              (editing.hosts !== null && editing.hosts.length === 0)
                            }
                            onClick={() =>
                              void run(async () => {
                                await updateHubMcpToken(token.id, {
                                  scopes: editing.scopes,
                                  hosts: editing.hosts,
                                });
                                setEditing(null);
                              }, 'Could not change that token.')
                            }
                          >
                            Save
                          </button>
                          <button type="button" className="planner-btn" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                        </span>
                      </span>
                    )}
                  </span>
                  {token.kind === 'client' ? (
                    <span className="planner-row-actions">
                      <button
                        type="button"
                        className="planner-btn"
                        disabled={busy}
                        onClick={() =>
                          setEditing({
                            id: token.id,
                            scopes: [...token.scopes],
                            hosts: token.hosts === null ? null : [...token.hosts],
                          })
                        }
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="planner-btn"
                        disabled={busy}
                        onClick={() => setConfirming(token)}
                      >
                        Revoke
                      </button>
                    </span>
                  ) : (
                    <span className="planner-row-meta">Managed by the Fleet agent</span>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="hub-card-subsection">
            <label className="fleet-field" htmlFor="hub-mcp-client-label">
              <span>New MCP client</span>
              <input
                id="hub-mcp-client-label"
                type="text"
                className="settings-input"
                placeholder="Name, e.g. laptop claude"
                value={label}
                maxLength={80}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            {HUB_MCP_SCOPES.map((scope) => (
              <label key={scope} className="planner-checkbox-row" style={{ marginTop: 4 }}>
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={() => setScopes(toggle(scopes, scope))}
                />{' '}
                <span>
                  <strong>{scope}</strong>: {SCOPE_TEXT[scope]}
                </span>
              </label>
            ))}
            {scopes.includes('admin') && (
              <p className="warn-callout" role="alert">
                Admin can change webhooks, scheduled jobs and providers on every host this token reaches.
              </p>
            )}
            <div className="hub-checkbox-inline" style={{ marginTop: 6 }}>
              <label className="planner-checkbox-row">
                <input type="checkbox" checked={allHosts} onChange={() => setAllHosts(!allHosts)} /> Every host,
                including ones added later
              </label>
              {!allHosts &&
                (hostIds.length === 0 ? (
                  <span className="planner-row-meta">No hosts registered yet.</span>
                ) : (
                  hostIds.map((host) => (
                    <label key={host.id} className="planner-checkbox-row">
                      <input
                        type="checkbox"
                        checked={picked.includes(host.id)}
                        onChange={() => setPicked(toggle(picked, host.id))}
                      />{' '}
                      {host.label}
                    </label>
                  ))
                ))}
            </div>
            {scopes.includes('dispatch') && allHosts && (
              <p className="transport-hint">
                A coding agent’s own “always allow” covers every host. Pick hosts here to limit where this one
                can start work.
              </p>
            )}
            <div>
              <button
                type="button"
                className="planner-btn"
                style={{ marginTop: 4 }}
                disabled={busy || label.trim() === '' || scopes.length === 0 || (!allHosts && picked.length === 0)}
                onClick={() => void create()}
              >
                Create token
              </button>
            </div>
          </div>

          <div className="hub-card-subsection">
            <strong className="hub-card-subsection-title">Attach to sessions on hosts</strong>
            <p className="transport-hint" style={{ marginTop: 0 }}>
              Lets a person starting a Claude chat on a host tick “Attach Fleet MCP”, so that chat’s agent can
              use these tools too. Each host gets its own token (read and dispatch, never admin), handed over
              once and stored encrypted there. Work the Hub dispatches never gets it, so a dispatched session
              cannot dispatch onward.
            </p>
            {attach?.enabled &&
              attach.hosts.map((host) => (
                <p key={host.hostId} className="planner-row-meta" style={{ margin: 0 }}>
                  {host.label}:{' '}
                  {host.state === 'attached'
                    ? `offered (${host.tokenPrefix ?? ''}…)`
                    : host.state === 'failed'
                      ? `not offered: ${host.message ?? 'unknown error'}`
                      : 'not offered'}
                </p>
              ))}
            <div>
              <button
                type="button"
                className="planner-btn"
                disabled={busy || attach === null}
                onClick={() => setConfirmAttach(attach?.enabled ? 'disable' : 'enable')}
              >
                {attach?.enabled ? 'Stop offering' : 'Offer to sessions'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {confirmAttach && (
        <ConfirmDialog
          title={confirmAttach === 'enable' ? 'Offer Fleet MCP to sessions?' : 'Stop offering Fleet MCP?'}
          body={
            confirmAttach === 'enable'
              ? `Every bound host gets a token for ${url}, stored encrypted on that host. Nothing is attached until ` +
                'someone starting a chat there asks for it.'
              : 'Every host’s token is revoked now. Sessions that already have it lose the Fleet tools on their next call.'
          }
          confirmLabel={confirmAttach === 'enable' ? 'Offer' : 'Stop offering'}
          busy={busy}
          onConfirm={() =>
            void run(async () => {
              setAttach(await setHubMcpAttach(confirmAttach === 'enable', hubUrl.replace(/\/+$/, '')));
              setConfirmAttach(null);
            }, 'Could not change that.')
          }
          onCancel={() => setConfirmAttach(null)}
        />
      )}

      {confirming && (
        <ConfirmDialog
          title={`Revoke ${confirming.label}?`}
          body={
            'That client stops reaching the Hub on its very next call. Work it already started on a host keeps ' +
            'running there for you to stop.'
          }
          confirmLabel="Revoke"
          busy={busy}
          onConfirm={() =>
            void run(async () => {
              await revokeHubMcpToken(confirming.id);
              if (minted?.label === confirming.label) setMinted(null);
              setConfirming(null);
            }, 'Could not revoke that token.')
          }
          onCancel={() => setConfirming(null)}
        />
      )}
    </section>
  );
}
