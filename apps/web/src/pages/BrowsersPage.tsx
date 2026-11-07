import { useCallback, useEffect, useState } from 'react';
import type { BrowserInfo, BrowserListResponse } from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Icon } from '../components/Icon.js';
import { useHostApi } from '../hosts/HostContext.js';

/**
 * PA-178: every shared browser on this host — one per project folder and one
 * per Pocket Agent — with its state, and the way into each one's live view.
 *
 * A browser does not need to be running to be listed: opening it starts it,
 * and its profile (the logins) is kept either way. Stop and Clear data are the
 * same confirmed actions the viewer offers.
 */

interface Props {
  onBack: () => void;
  onOpen: (browserId: string) => void;
  onApiError: (error: unknown) => void;
}

const POLL_MS = 5_000;

function stateLabel(b: BrowserInfo): string {
  if (b.pendingHelp > 0) return 'Waiting for you';
  switch (b.state) {
    case 'running':
      return b.viewers > 0 ? 'Running · being viewed' : 'Running';
    case 'starting':
      return 'Starting…';
    case 'stopping':
      return 'Stopping…';
    default:
      return b.hasProfile ? 'Stopped · logins kept' : 'Not used yet';
  }
}

export function BrowsersPage({ onBack, onOpen, onApiError }: Props): JSX.Element {
  const api = useHostApi();
  const [data, setData] = useState<BrowserListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState<BrowserInfo | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await api.listBrowsers());
      setError(null);
    } catch (err) {
      // An older host has no such route: say so rather than failing loudly.
      if (err instanceof ApiError && err.status === 404) setError('This host does not support shared browsers yet.');
      else onApiError(err);
    }
  }, [api, onApiError]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const run = async (id: string, action: () => Promise<unknown>): Promise<void> => {
    setBusyId(id);
    try {
      await action();
      await refresh();
    } catch (err) {
      onApiError(err);
    } finally {
      setBusyId(null);
    }
  };

  const browsers = [...(data?.browsers ?? [])].sort((a, b) => {
    // What needs a person first, then what is running, then by kind and name.
    const rank = (x: BrowserInfo): number => (x.pendingHelp > 0 ? 0 : x.state === 'running' ? 1 : 2);
    return rank(a) - rank(b) || a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label);
  });

  return (
    <div className="settings-page browsers-page">
      <header className="topbar">
        <button type="button" className="round-btn" onClick={onBack} aria-label="Back">
          <Icon name="chevron-left" size={20} />
        </button>
        <div className="title">
          <strong>Browsers</strong>
          <span>Shared browsers agents sign in with</span>
        </div>
      </header>

      <div className="browsers-body">
        {error && <p className="muted">{error}</p>}
        {data && !data.available && (
          <p className="browser-note">{data.unavailableReason ?? 'No browser is installed on this host.'}</p>
        )}
        {data?.available && data.sandbox === false && (
          <p className="muted">
            The renderer sandbox is off on this host (no unprivileged user namespaces), as with playwright-cli.
          </p>
        )}
        {data?.available && (
          <ul className="browsers-list">
            {browsers.map((b) => (
              <li key={b.id} className={b.pendingHelp > 0 ? 'browsers-row needs-you' : 'browsers-row'}>
                <div className="browsers-row-main">
                  <strong>{b.label}</strong>
                  <span className="muted">
                    {b.kind === 'pocket' ? 'Pocket Agent' : 'Project'} · {stateLabel(b)}
                    {b.state === 'running' && b.tabs.length > 0
                      ? ` · ${b.tabs.length} tab${b.tabs.length === 1 ? '' : 's'}`
                      : ''}
                  </span>
                </div>
                <div className="browsers-row-actions">
                  <button type="button" className="primary" onClick={() => onOpen(b.id)}>
                    Open
                  </button>
                  {b.state === 'running' && (
                    <button
                      type="button"
                      disabled={busyId === b.id || b.pendingHelp > 0}
                      title={b.pendingHelp > 0 ? 'An agent is waiting for help in this browser' : undefined}
                      onClick={() => void run(b.id, () => api.stopBrowser(b.id))}
                    >
                      Stop
                    </button>
                  )}
                  {b.hasProfile && (
                    <button
                      type="button"
                      className="link-btn danger"
                      disabled={busyId === b.id || b.pendingHelp > 0}
                      onClick={() => setConfirmClear(b)}
                    >
                      Clear data…
                    </button>
                  )}
                </div>
              </li>
            ))}
            {browsers.length === 0 && <li className="muted">No project folders or Pocket Agents yet.</li>}
          </ul>
        )}
      </div>

      {confirmClear && (
        <ConfirmDialog
          title="Clear browser data?"
          body={`This stops ${confirmClear.label}'s browser and deletes every login, cookie and saved page data in it. Agents will have to be signed in again.`}
          confirmLabel="Clear data"
          busy={busyId === confirmClear.id}
          onConfirm={() => {
            const target = confirmClear;
            void run(target.id, async () => {
              if (target.state === 'running') await api.stopBrowser(target.id);
              await api.clearBrowserData(target.id);
            }).then(() => setConfirmClear(null));
          }}
          onCancel={() => setConfirmClear(null)}
        />
      )}
    </div>
  );
}
