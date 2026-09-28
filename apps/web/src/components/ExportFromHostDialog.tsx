import { useCallback, useEffect, useState } from 'react';
import type { HubHostEntry, HubTemplateKind } from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { hostEndpoint } from '../api/host.js';
import { createHubTemplate, listHubHosts } from '../api/hub.js';
import { clientFor } from '../hosts/HostContext.js';
import { TEMPLATE_KINDS, kindInfo } from '../agent/hub-template-format.js';
import {
  fetchHostExportDraft,
  listHostExportableItems,
  type ExportableItem,
  type HostExportDraft,
} from '../agent/hub-template-export.js';
import { Icon } from './Icon.js';

interface Props {
  /** When non-null, the pre-selected host ID (e.g. from the current host's settings). */
  preselectedHostId?: string | null;
  onClose: () => void;
  /** Called with the newly created template ID once export succeeds. */
  onExported: (newTemplateId: string) => void;
  onApiError?: (err: unknown) => void;
}

/**
 * PA-109: modal dialog to export a host's existing configuration into a Hub template.
 */
export function ExportFromHostDialog({
  preselectedHostId,
  onClose,
  onExported,
  onApiError,
}: Props): JSX.Element {
  const [hubHosts, setHubHosts] = useState<HubHostEntry[] | null>(null);
  const [hostId, setHostId] = useState<string>('');
  const [kind, setKind] = useState<HubTemplateKind>('pocket-agent');
  const [items, setItems] = useState<ExportableItem[] | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string>('');
  const [name, setName] = useState('');
  const [nameCustomized, setNameCustomized] = useState(false);
  const [description, setDescription] = useState('');
  const [cachedDraft, setCachedDraft] = useState<HostExportDraft | null>(null);
  const [loadingItems, setLoadingItems] = useState(false);
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Close on Escape when not busy
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  // Load bound hosts on mount
  useEffect(() => {
    let cancelled = false;
    listHubHosts()
      .then((hosts) => {
        if (cancelled) return;
        setHubHosts(hosts);
        if (hosts.length > 0) {
          const match = preselectedHostId && hosts.find((h) => h.id === preselectedHostId);
          setHostId(match ? match.id : hosts[0]!.id);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        onApiError?.(err);
        setError(err instanceof ApiError ? err.message : 'Could not list Hub hosts.');
        setHubHosts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [preselectedHostId, onApiError]);

  const activeHost = hubHosts?.find((h) => h.id === hostId) ?? null;
  const hostLabel = activeHost?.label ?? hostId;

  // Load candidates whenever hostId or kind changes
  useEffect(() => {
    if (!hostId) return;
    let cancelled = false;
    setLoadingItems(true);
    setError(null);
    setItems(null);
    setSelectedItemId('');
    setCachedDraft(null);

    const client = clientFor(hostEndpoint(hostId, `/h/${hostId}`));
    listHostExportableItems(client, kind)
      .then((found) => {
        if (cancelled) return;
        setItems(found);
        if (found.length > 0) {
          setSelectedItemId(found[0]!.id);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? `Could not inspect host: ${err.message}`
            : 'Could not inspect host configuration.',
        );
        setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingItems(false);
      });

    return () => {
      cancelled = true;
    };
  }, [hostId, kind]);

  // Load draft details when selected item changes
  const loadDraft = useCallback(
    async (targetItemId: string | null) => {
      if (!hostId) return;
      setLoadingDraft(true);
      setError(null);
      try {
        const client = clientFor(hostEndpoint(hostId, `/h/${hostId}`));
        const draft = await fetchHostExportDraft(client, kind, targetItemId, hostLabel);
        setCachedDraft(draft);
        if (!nameCustomized) {
          setName(draft.defaultName);
        }
        setDescription(draft.defaultDescription);
      } catch (err) {
        setError(
          err instanceof Error
            ? `Could not load configuration details: ${err.message}`
            : 'Could not load configuration details.',
        );
        setCachedDraft(null);
      } finally {
        setLoadingDraft(false);
      }
    },
    [hostId, kind, hostLabel, nameCustomized],
  );

  useEffect(() => {
    if (!hostId) return;
    if (kind === 'planner-endpoint') {
      void loadDraft(null);
    } else if (selectedItemId) {
      void loadDraft(selectedItemId);
    } else {
      setCachedDraft(null);
    }
  }, [hostId, kind, selectedItemId, loadDraft]);

  const handleExport = async (): Promise<void> => {
    if (!cachedDraft) return;
    const finalName = name.trim() || cachedDraft.defaultName;
    if (!finalName) {
      setError('A template name is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createHubTemplate({
        name: finalName,
        description: description.trim(),
        kind,
        payload: cachedDraft.payload,
      });
      onExported(created.id);
      onClose();
    } catch (err) {
      onApiError?.(err);
      setError(err instanceof ApiError ? err.message : 'Could not create template on the Hub.');
    } finally {
      setBusy(false);
    }
  };

  const isSingleton = kind === 'planner-endpoint';
  const hasItems = items !== null && items.length > 0;
  const canExport = !busy && !loadingItems && !loadingDraft && cachedDraft !== null;

  return (
    <div
      className="dialog-backdrop"
      onClick={busy ? undefined : onClose}
      role="presentation"
    >
      <div
        className="dialog export-template-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Export setting to template"
      >
        <h2>
          <Icon name="template" size={20} />
          Export setting to template
        </h2>
        <p className="transport-hint">
          Extract a live configuration from a bound host and save it as a reusable Hub template.
          Templates never store credentials or API keys.
        </p>

        {error !== null && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}

        {hubHosts === null ? (
          <div className="spinner">Loading hosts…</div>
        ) : hubHosts.length === 0 ? (
          <div className="hub-tpl-empty">No bound hosts available to export from.</div>
        ) : (
          <div className="export-dialog-form">
            <div className="settings-row">
              <div className="settings-row-main">
                <div className="settings-row-info">
                  <label className="settings-row-label">Source Host</label>
                </div>
                <div className="settings-row-control">
                  <select
                    value={hostId}
                    disabled={busy || loadingDraft}
                    onChange={(e) => {
                      setHostId(e.target.value);
                      setNameCustomized(false);
                    }}
                  >
                    {hubHosts.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.label} ({h.id})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-main">
                <div className="settings-row-info">
                  <label className="settings-row-label">Configuration Kind</label>
                  <p className="transport-hint">{kindInfo(kind).blurb}</p>
                </div>
                <div className="settings-row-control">
                  <select
                    value={kind}
                    disabled={busy || loadingDraft}
                    onChange={(e) => {
                      setKind(e.target.value as HubTemplateKind);
                      setNameCustomized(false);
                    }}
                  >
                    {TEMPLATE_KINDS.map((info) => (
                      <option key={info.kind} value={info.kind}>
                        {info.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {!isSingleton && (
              <div className="settings-row">
                <div className="settings-row-main">
                  <div className="settings-row-info">
                    <label className="settings-row-label">Item to export</label>
                  </div>
                  <div className="settings-row-control">
                    {loadingItems ? (
                      <span className="spinner">Scanning host…</span>
                    ) : !hasItems ? (
                      <span className="transport-hint">
                        No {kindInfo(kind).label.toLowerCase()} items found on this host.
                      </span>
                    ) : (
                      <select
                        value={selectedItemId}
                        disabled={busy || loadingDraft}
                        onChange={(e) => {
                          setSelectedItemId(e.target.value);
                          setNameCustomized(false);
                        }}
                      >
                        {items?.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="settings-row">
              <div className="settings-row-main">
                <div className="settings-row-info">
                  <label className="settings-row-label">Template name</label>
                </div>
                <div className="settings-row-control">
                  <input
                    type="text"
                    value={name}
                    disabled={busy || loadingDraft || (!isSingleton && !hasItems)}
                    placeholder={cachedDraft?.defaultName || 'Template name'}
                    onChange={(e) => {
                      setName(e.target.value);
                      setNameCustomized(true);
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-main">
                <div className="settings-row-info">
                  <label className="settings-row-label">Description</label>
                </div>
                <div className="settings-row-control">
                  <input
                    type="text"
                    value={description}
                    disabled={busy || loadingDraft || (!isSingleton && !hasItems)}
                    placeholder="Optional description"
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="dialog-actions">
          <button
            type="button"
            className="planner-btn"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="cron-new"
            onClick={() => void handleExport()}
            disabled={!canExport}
          >
            {busy ? 'Exporting…' : 'Export template'}
          </button>
        </div>
      </div>
    </div>
  );
}
