import { useCallback, useEffect, useState } from 'react';
import type { HubHostEntry, HubTemplate } from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { deleteHubTemplate, listHubHosts, listHubTemplates } from '../api/hub.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { ExportFromHostDialog } from '../components/ExportFromHostDialog.js';
import { Icon } from '../components/Icon.js';
import { formatRelative } from '../components/StatusBadge.js';
import {
  TEMPLATE_KINDS,
  kindInfo,
  newTemplateId,
  outcomeTone,
} from '../agent/hub-template-format.js';

interface Props {
  /** Opens one template's editor. `newTemplateId(kind)` for an unsaved one. */
  onOpenTemplate: (templateId: string) => void;
  onApiError: (error: unknown) => void;
  /** Present only on the phone route, which has no chrome of its own. */
  onBack?: () => void;
}

/**
 * Every config template this Hub holds (PA-70).
 *
 * Rendered only where `useHostDirectory().source === 'hub'` — its callers gate
 * on that — because a backend has no template API and no business having one:
 * a template describes something to *send* to a machine, and a backend is the
 * machine. That gate is also what keeps a standalone install's UI byte-identical
 * to the pre-PA-70 one.
 *
 * No poll timer, deliberately unlike `CronJobsPage`: nothing here changes
 * without this browser having done it — there is no scheduler, no reconciliation
 * loop and no drift correction, so the only thing that can make this list stale
 * is another operator, and a 5 s poll of a page that is usually read once is
 * not worth the requests. The staleness that *is* shown (`entry.stale`) is a
 * property of the rows themselves and travels with them.
 */
export function HubTemplatesPage({ onOpenTemplate, onApiError, onBack }: Props): JSX.Element {
  const [templates, setTemplates] = useState<HubTemplate[] | null>(null);
  /**
   * The Hub's registry, for turning a ledger row's `hostId` into the label an
   * operator recognises — see `listHubHosts` for why it is read from the Hub
   * rather than from `useHostDirectory()`. A label that has not arrived yet
   * falls back to the id, so the list never waits on this.
   */
  const [hubHosts, setHubHosts] = useState<HubHostEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [choosingKind, setChoosingKind] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<HubTemplate | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setTemplates(await listHubTemplates());
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load templates.');
      setTemplates([]);
    }
  }, [onApiError]);

  useEffect(() => {
    void load();
    // Errors are ignored on purpose: a missing label degrades to the host id,
    // which is legible, and failing the whole page over it would be worse.
    void listHubHosts()
      .then(setHubHosts)
      .catch(() => undefined);
  }, [load]);

  const labelFor = (hostId: string): string =>
    hubHosts.find((host) => host.id === hostId)?.label ?? hostId;

  const remove = async (template: HubTemplate): Promise<void> => {
    setBusy(true);
    try {
      await deleteHubTemplate(template.id);
      setConfirmDelete(null);
      await load();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not delete that template.');
    } finally {
      setBusy(false);
    }
  };

  const content = (
    <div className="hub-tpl-page">
      <div className="hub-tpl-head">
        <div>
          <h2>Config templates</h2>
          <p className="hub-tpl-sub">
            Define a Pocket Agent, an MCP registry, a provider, a skill or an LLM endpoint once,
            then instantiate it onto any bound host. A template is a starting point, not a synced
            copy: editing one never touches a host that already has it.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            className="round-btn plain"
            onClick={() => setExporting(true)}
            title="Export template from a bound host"
          >
            <Icon name="template" size={16} />
            Export from host…
          </button>
          <button type="button" className="cron-new" onClick={() => setChoosingKind((v) => !v)}>
            <Icon name="plus" size={18} />
            New template
          </button>
        </div>
      </div>

      {error !== null && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {choosingKind && (
        /* The kind is chosen here rather than in the editor because it cannot
           be changed afterwards — `UpdateHubTemplateRequest` has no `kind` —
           so it is the one field that has to precede the form. */
        <div className="hub-tpl-kinds">
          {TEMPLATE_KINDS.map((info) => (
            <button
              key={info.kind}
              type="button"
              className="hub-tpl-kind"
              onClick={() => onOpenTemplate(newTemplateId(info.kind))}
            >
              <span className="hub-tpl-kind-name">{info.label}</span>
              <span className="hub-tpl-kind-blurb">{info.blurb}</span>
            </button>
          ))}
        </div>
      )}

      {templates === null && <div className="spinner">Loading…</div>}
      {templates?.length === 0 && !choosingKind && (
        <div className="hub-tpl-empty">
          No templates yet. One describes a piece of configuration — an agent, a provider, a skill
          — that you want on more than one machine.
        </div>
      )}

      {templates?.map((template) => (
        <div key={template.id} className="hub-tpl-row">
          <button
            type="button"
            className="hub-tpl-main"
            onClick={() => onOpenTemplate(template.id)}
          >
            <span className="hub-tpl-title">
              <Icon name="template" size={17} className="hub-tpl-row-icon" />
              {template.name}
            </span>
            <span className="hub-tpl-meta">
              {kindInfo(template.kind).label}
              {' · '}
              {/* The revision is what the staleness markers below compare
                  against, so it is shown rather than left implicit. */}
              <span className="hub-tpl-rev">r{template.revision}</span>
              {' · edited '}
              {formatRelative(template.updatedAt)}
            </span>
            {template.description !== '' && (
              <span className="hub-tpl-meta">{template.description}</span>
            )}
            <span className="hub-tpl-hosts">
              {template.provisionings.length === 0 ? (
                <span className="hub-tpl-host dim">Not on any host yet</span>
              ) : (
                template.provisionings.map((entry) => (
                  <span key={entry.hostId} className="hub-tpl-host">
                    {labelFor(entry.hostId)}
                    <span className={`hub-tpl-outcome hub-tpl-outcome--${outcomeTone(entry.lastResult)}`}>
                      {entry.lastResult}
                    </span>
                    <span className="hub-tpl-rev">r{entry.templateRevision}</span>
                    {entry.stale && (
                      /* The whole of "editing a template does not silently
                         change a provisioned host": the difference is
                         displayed and never acted on. */
                      <span className="hub-tpl-stale" title={`This host has r${entry.templateRevision}; the template is r${template.revision}. Re-provision to send the newer one.`}>
                        stale
                      </span>
                    )}
                  </span>
                ))
              )}
            </span>
          </button>
          <div className="hub-tpl-actions">
            <button
              type="button"
              className="round-btn plain"
              onClick={() => setConfirmDelete(template)}
              aria-label={`Delete ${template.name}`}
              title="Delete this template"
            >
              <Icon name="trash" size={16} />
            </button>
          </div>
        </div>
      ))}

      {confirmDelete !== null && (
        <ConfirmDialog
          title={`Delete “${confirmDelete.name}”?`}
          body={
            confirmDelete.provisionings.length === 0
              ? 'This removes the template from the Hub. It has not been instantiated anywhere.'
              : `This removes the template from the Hub only. What it already wrote to ${confirmDelete.provisionings
                  .map((entry) => labelFor(entry.hostId))
                  .join(', ')} stays in place on those hosts, and the Hub will no longer have any record of having put it there.`
          }
          confirmLabel="Delete template"
          busy={busy}
          onConfirm={() => void remove(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {exporting && (
        <ExportFromHostDialog
          onClose={() => setExporting(false)}
          onExported={(newId) => {
            setExporting(false);
            onOpenTemplate(newId);
          }}
          onApiError={onApiError}
        />
      )}
    </div>
  );

  if (!onBack) return content;
  return (
    <div className="app">
      <header className="home-bar">
        <button type="button" className="round-btn" onClick={onBack} aria-label="Back">
          <Icon name="chevron-left" size={20} />
        </button>
        <div className="home-title">
          <strong>Config templates</strong>
        </div>
      </header>
      {content}
    </div>
  );
}
