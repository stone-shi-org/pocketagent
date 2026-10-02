import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_MCP_SCOPES,
  MCP_SCOPES,
  MCP_SERVER_PATH,
  type McpClientTokenSummary,
  type McpScope,
} from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { CopyButton } from './CopyButton.js';
import { useHostApi, useHostEndpoint } from '../hosts/HostContext.js';

interface Props {
  onApiError: (error: unknown) => void;
}

const SCOPE_TEXT: Record<McpScope, string> = {
  read: 'Read projects, sessions, transcripts, Pocket Agents, scheduled jobs and webhooks.',
  sessions: 'Start, prompt, wait on and stop coding-agent sessions.',
  planner: 'Create and message Pocket Agent chats.',
  admin: 'Add or remove project folders, create or delete worktrees, clear chats.',
};

/**
 * PA-118: tokens that let another agent call this server over MCP (`/mcp`).
 *
 * `HubsSection`'s shape with an "add" affordance, because unlike a hub
 * credential an MCP token *is* minted here, by a person, for a client they are
 * about to configure. What it shares with the Hubs list is the posture: the
 * server keeps only a digest, so a token is shown exactly once, and every row
 * can be revoked with effect on the very next request.
 *
 * The endpoint URL is composed from this browser's origin for the same reason
 * `SecretReveal` composes a webhook URL that way — the server does not know
 * its own external address — and with the same refusal for a host reached
 * through a Hub's path prefix: that origin is the Hub's, which does not accept
 * MCP tokens, so the panel asks for the backend's own address instead.
 */
export function McpClientsSection({ onApiError }: Props): JSX.Element {
  const api = useHostApi();
  const endpoint = useHostEndpoint();
  const [clients, setClients] = useState<McpClientTokenSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<McpScope[]>([...DEFAULT_MCP_SCOPES]);
  const [minted, setMinted] = useState<{ label: string; token: string } | null>(null);
  const [confirming, setConfirming] = useState<McpClientTokenSummary | null>(null);

  const remoteHost = endpoint.basePath !== '';
  const url = remoteHost ? `<address of ${endpoint.id}>${MCP_SERVER_PATH}` : `${window.location.origin}${MCP_SERVER_PATH}`;

  const load = useCallback(async () => {
    try {
      const res = await api.listMcpTokens();
      setClients(res.clients);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load MCP clients.');
    }
  }, [api, onApiError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(): Promise<void> {
    setBusy(true);
    try {
      const res = await api.createMcpToken({ label: label.trim(), scopes });
      setMinted({ label: res.client.label, token: res.token });
      setLabel('');
      setScopes([...DEFAULT_MCP_SCOPES]);
      await load();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not create that token.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(client: McpClientTokenSummary): Promise<void> {
    setBusy(true);
    try {
      await api.revokeMcpToken(client.id);
      setConfirming(null);
      if (minted?.label === client.label) setMinted(null);
      await load();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not revoke that token.');
    } finally {
      setBusy(false);
    }
  }

  const toggle = (scope: McpScope): void =>
    setScopes((current) => (current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope]));

  const claudeCommand = minted
    ? `claude mcp add --transport http pocketagent ${url} --header "Authorization: Bearer ${minted.token}"`
    : '';

  return (
    <>
      <p className="transport-hint" style={{ marginBottom: 10 }}>
        Another agent — Claude Code, Codex, a CI job — can use this machine over MCP at{' '}
        <code>{url}</code>: browse projects, start coding agents and Pocket Agents, and read their
        answers. Tool calls that need approval still wait for you here; an MCP client can see an
        approval but can never answer one.
      </p>
      {remoteHost && (
        <p className="transport-hint">
          This host is reached through a Hub, which does not accept MCP tokens. Point the client
          at the address <code>{endpoint.id}</code> itself is reachable on.
        </p>
      )}

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {minted && (
        <div className="settings-row settings-row-stacked" role="status">
          <div className="settings-row-info">
            <label className="settings-row-label">Token for {minted.label}</label>
            <p className="transport-hint">
              Shown once. Only a digest is stored, so it cannot be shown again — revoke and create a
              new one if it is lost.
            </p>
          </div>
          <div className="settings-row-control">
            <div className="endpoint-url">
              <code>{minted.token}</code>
              <CopyButton text={minted.token} label="Copy token" />
            </div>
            <div className="endpoint-url" style={{ marginTop: 8 }}>
              <code>{claudeCommand}</code>
              <CopyButton text={claudeCommand} label="Copy command" />
            </div>
          </div>
          <button type="button" className="planner-btn" onClick={() => setMinted(null)}>
            Done
          </button>
        </div>
      )}

      {clients === null ? (
        <div className="spinner">Loading…</div>
      ) : clients.length === 0 ? (
        <p className="planner-row-meta">No MCP clients.</p>
      ) : (
        clients.map((client) => (
          <div key={client.id} className="planner-model-row">
            <span>
              <strong>{client.label}</strong>
              <br />
              <span className="planner-row-meta">
                <code>{client.tokenPrefix}…</code> · {client.scopes.join(', ')}
                {client.scopes.includes('admin') ? ' (admin)' : ''}
              </span>
              <br />
              <span className="planner-row-meta">
                {client.lastSeenAt === null
                  ? 'Never used'
                  : `Last seen ${new Date(client.lastSeenAt).toLocaleString()}${
                      client.lastSeenIp === null ? '' : ` from ${client.lastSeenIp}`
                    }`}
                {client.liveSessions > 0 ? ` · ${client.liveSessions} live session${client.liveSessions === 1 ? '' : 's'}` : ''}
              </span>
            </span>
            <button type="button" className="planner-btn" disabled={busy} onClick={() => setConfirming(client)}>
              Revoke
            </button>
          </div>
        ))
      )}

      <div className="settings-row settings-row-stacked">
        <div className="settings-row-info">
          <label className="settings-row-label" htmlFor="mcp-client-label">
            New MCP client
          </label>
        </div>
        <div className="settings-row-control">
          <input
            id="mcp-client-label"
            className="settings-input"
            placeholder="Name, e.g. laptop claude"
            value={label}
            maxLength={80}
            onChange={(e) => setLabel(e.target.value)}
          />
          {MCP_SCOPES.map((scope) => (
            <label key={scope} className="planner-checkbox-row" style={{ marginTop: 6 }}>
              <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggle(scope)} />{' '}
              <strong>{scope}</strong> — {SCOPE_TEXT[scope]}
            </label>
          ))}
          {scopes.includes('admin') && (
            <p className="warn-callout" role="alert">
              Admin can add project folders, which lets every agent on this machine work in them.
            </p>
          )}
          <button
            type="button"
            className="planner-btn"
            style={{ marginTop: 8 }}
            disabled={busy || label.trim() === '' || scopes.length === 0}
            onClick={() => void create()}
          >
            Create token
          </button>
        </div>
      </div>

      {confirming && (
        <ConfirmDialog
          title={`Revoke ${confirming.label}?`}
          body={
            'That client stops reaching this server on its very next request. Sessions it started ' +
            'keep running and stay here for you to stop.'
          }
          confirmLabel="Revoke"
          busy={busy}
          onConfirm={() => void revoke(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </>
  );
}
