import { useEffect, useState } from 'react';
import { Icon } from './Icon.js';
import { listHubTemplates } from '../api/hub.js';
import { locationToHash } from '../hooks/useHashRoute.js';
import { SectionCard } from '../pages/SettingsPage.js';

/**
 * The entry point to the Hub's config templates, on the Settings page (PA-70).
 *
 * Owns its own `SectionCard` rather than being placed inside one by
 * `SettingsPage`, because on a standalone install there must be no card at all
 * — an empty section titled "Config templates" on a machine with no Hub in
 * front of it is worse than nothing. Returning `null` from here is what makes
 * the whole thing disappear.
 *
 * The gate is one `GET /api/hub/templates`, not a second `useHostDirectory()`:
 * that hook owns polling timers and would double every host probe for as long
 * as Settings is open, and the answer this needs is narrower anyway — a
 * backend answers a JSON 404 for anything under `/api/` it does not know (its
 * not-found handler only serves the SPA shell *outside* `/api/`), so "the
 * request failed" and "there is no Hub" are the same thing here, exactly as
 * `hosts/directory.ts` argues for `/api/hub/hosts`.
 */
export function HubTemplatesSection(): JSX.Element | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    listHubTemplates()
      .then((templates) => {
        if (!cancelled) setCount(templates.length);
      })
      .catch(() => {
        // Deliberately silent: on a backend this is the expected answer, and
        // `onApiError` is not taken as a prop precisely so a 404 here can
        // never look like a problem with the page it is sitting on.
        if (!cancelled) setCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (count === null) return null;

  return (
    <SectionCard
      title="Config templates"
      icon="template"
      desc="Defined once on the Hub and instantiated onto any bound host. A template is a starting point, never a synced copy — editing one leaves already-provisioned hosts alone."
    >
      <div className="settings-row">
        <div className="settings-row-main">
          <div className="settings-row-info">
            <label className="settings-row-label">
              {count === 0 ? 'No templates yet' : `${count} template${count === 1 ? '' : 's'}`}
            </label>
            <p className="transport-hint">
              Pocket Agents, MCP registries, custom Claude providers, skills and the Pocket Agent
              LLM endpoint.
            </p>
          </div>
          <div className="settings-row-control">
            <button
              type="button"
              onClick={() => {
                // Host-less on purpose, which is why this builds the hash with
                // an explicit `null` rather than going through
                // `hashForCurrentHost`: the templates surface belongs to the
                // Hub, not to whichever backend this Settings page is showing,
                // and carrying `#/h/<id>/` into it would claim otherwise.
                window.location.hash = locationToHash({ name: 'hub-templates' }, null);
              }}
            >
              <Icon name="template" size={16} />
              Open templates
            </button>
          </div>
        </div>
      </div>
    </SectionCard>
  );
}
