import { useCallback, useEffect, useState } from 'react';
import type { BrowserInfo, BrowserTreeEntry } from '@pocketagent/protocol';
import { Icon } from './Icon.js';
import { DEFAULT_HOST_ID } from '../api/host.js';
import { locationToHash, parseLocation } from '../hooks/useHashRoute.js';
import { useHostApi, useHostEndpoint } from '../hosts/HostContext.js';

/**
 * PA-178: the way into a chat's shared browser from its header.
 *
 * The link is built from *this page's* host, not from whatever host the URL
 * currently names: on the desktop a tab for one machine can sit beside the
 * sidebar showing another, and opening the wrong machine's browser would show
 * a person somebody else's logins. A bare URL on the default host stays bare.
 */
export function browserHashFor(endpointId: string, browserId: string): string {
  const current = parseLocation(window.location.hash).hostId;
  const hostId =
    current === endpointId || (current === null && endpointId === DEFAULT_HOST_ID) ? current : endpointId;
  return locationToHash({ name: 'browser', browserId }, hostId);
}

/** Which shared browser this chat uses; null where none can exist. Re-read when `refreshKey` changes. */
export function useBrowserScope(
  query: { sessionId: string } | { plannerChatId: string },
  refreshKey: unknown = null,
): BrowserInfo | null {
  const api = useHostApi();
  const [browser, setBrowser] = useState<BrowserInfo | null>(null);
  const key = 'sessionId' in query ? `s:${query.sessionId}` : `p:${query.plannerChatId}`;
  useEffect(() => {
    let cancelled = false;
    api
      .browserScope(query)
      .then((res) => {
        if (!cancelled) setBrowser(res.browser);
      })
      .catch(() => {
        // An older host without the route, or no browser: no button.
        if (!cancelled) setBrowser(null);
      });
    return () => {
      cancelled = true;
    };
    // `query` is fully described by `key`, so it is not a dependency itself.
  }, [api, key, refreshKey]);
  return browser;
}

export function useOpenBrowser(): (browserId: string) => void {
  const endpoint = useHostEndpoint();
  return useCallback(
    (browserId: string) => {
      window.location.hash = browserHashFor(endpoint.id, browserId);
    },
    [endpoint.id],
  );
}

interface Props {
  browser: BrowserInfo;
  className?: string;
}

/** "Browser" in a chat header: shown when this chat has a shared browser; marked while it runs. */
export function BrowserButton({ browser, className = 'planner-btn' }: Props): JSX.Element {
  const open = useOpenBrowser();
  const running = browser.state === 'running';
  return (
    <button
      type="button"
      className={`${className} browser-btn${running ? ' running' : ''}`}
      onClick={() => open(browser.id)}
      title={running ? 'The shared browser is running — watch or drive it' : 'Open the shared browser (keeps logins)'}
    >
      Browser{running ? ' ●' : ''}
    </button>
  );
}

/** A Pocket Agent's browser id — the server's `pocketBrowserId`, which the client can compute. */
export function pocketBrowserIdFor(workspaceId: string): string {
  return `pocket-${workspaceId}`;
}

/**
 * A running shared browser as a row in the home screen's tree, under the
 * project folder or Pocket Agent it belongs to: the globe, with a dot on it
 * for its state (amber while an agent waits for a person in it).
 */
export function BrowserTreeRow({ entry }: { entry: BrowserTreeEntry }): JSX.Element {
  const open = useOpenBrowser();
  const waiting = entry.pendingHelp > 0;
  const status = waiting ? 'needs you' : entry.state === 'running' ? 'running' : entry.state === 'starting' ? 'starting…' : 'stopping…';
  return (
    <div className="chat-line cron-line browser-line">
      <button
        type="button"
        className="chat-row cron-job-row browser-tree-row"
        onClick={() => open(entry.id)}
        title={`${entry.label}'s shared browser — ${status}`}
      >
        <span className="chat-title">
          <span className="cron-icon-wrap">
            <Icon name="globe" size={15} className="cron-badge-icon" />
            <span
              className={`cron-dot browser-dot browser-dot--${waiting ? 'waiting' : entry.state}`}
              role="img"
              aria-label={`Browser ${status}`}
            />
          </span>
          Browser
        </span>
        <span className={`cron-line-when${waiting ? ' browser-needs-you' : ''}`}>{status}</span>
      </button>
    </div>
  );
}
