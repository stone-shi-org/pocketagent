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
  /** When non-null, pre-select this template kind. */
  initialKind?: HubTemplateKind;
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
  initialKind,
  onClose,
  onExported,
  onApiError,
}: Props): JSX.Element {
  const [hubHosts, setHubHosts] = useState<HubHostEntry[] | null>(null);
  const [hostId, setHostId] = useState<string>('');
  const [kind, setKind] = useState<HubTemplateKind>(initialKind ?? 'pocket-agent');
  const [items, setItems] = useState<ExportableItem[] | null>(null);
  const [exportAll, setExportAll] = useState(false);
  const [selectedMcpIds, setSelectedMcpIds] = useState<Set<string>>(new Set());
  const [selectedItemId, setSelectedItemId] = useState<string>('');
  const [name, setName] = useState('');
  const [nameCustomized, setNameCustomized] = useState(false);
  const [description, setDescription] = useState('');
  const [cachedDraft, setCachedDraft] = useState<HostExportDraft | null>(null);
  const [loadingItems, setLoadingItems] = useState(false);
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
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
    setSelectedMcpIds(new Set());
    setCachedDraft(null);

    const client = clientFor(hostEndpoint(hostId, `/h/${hostId}`));
    listHostExportableItems(client, kind)
      .then((found) => {
        if (cancelled) return;
        setItems(found);
        if (found.length > 0) {
          setSelectedItemId(found[0]!.id);
          if (kind === 'mcp-registry') {
            setSelectedMcpIds(new Set(found.map((i) => i.id)));
            if (!nameCustomized) {
              setName(found.length === 1 ? found[0]!.label : `${hostLabel} MCP Registries`);
            }
          }
        } else {
          setExportAll(false);
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
  }, [hostId, kind, hostLabel, nameCustomized]);

  // Load draft details when selected item changes (for single item kinds)
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
    if (!hostId || kind === 'mcp-registry') return;
    if (kind === 'planner-endpoint') {
      void loadDraft(null);
    } else if (!exportAll && selectedItemId) {
      void loadDraft(selectedItemId);
    } else {
      setCachedDraft(null);
    }
  }, [hostId, kind, selectedItemId, exportAll, loadDraft]);

  const handleExport = async (): Promise<void> => {
    if (!hostId) return;
    setBusy(true);
    setError(null);
    setExportProgress(null);

    try {
      const client = clientFor(hostEndpoint(hostId, `/h/${hostId}`));

      // PA-111: Bundled MCP export into ONE template
      if (kind === 'mcp-registry') {
        const idsToExport = Array.from(selectedMcpIds);
        if (idsToExport.length === 0) {
          setError('Select at least one MCP registry to export.');
          setBusy(false);
          return;
        }
        const drafts: HostExportDraft[] = [];
        for (let i = 0; i < idsToExport.length; i++) {
          const id = idsToExport[i]!;
          const item = items?.find((it) => it.id === id);
          setExportProgress(`Exporting ${i + 1} of ${idsToExport.length}: ${item?.label ?? id}…`);
          const draft = await fetchHostExportDraft(client, 'mcp-registry', id, hostLabel);
          drafts.push(draft);
        }
        const defaultTplName =
          idsToExport.length === 1 ? drafts[0]!.defaultName : `${hostLabel} MCP Registries`;
        const finalName = (name.trim() || defaultTplName).slice(0, 128);
        const finalDescription = (
          description.trim() ||
          (idsToExport.length === 1 ? drafts[0]!.defaultDescription : `Exported from ${hostLabel}`)
        ).slice(0, 2000);

        const payload =
          drafts.length === 1
            ? drafts[0]!.payload
            : { registries: drafts.map((d) => d.payload) };

        const created = await createHubTemplate({
          name: finalName,
          description: finalDescription,
          kind: 'mcp-registry',
          payload,
        });
        onExported(created.id);
        onClose();
        return;
      }

      // Non-MCP multi-item export (creates N individual templates)
      if (exportAll && items && items.length > 0) {
        const createdIds: string[] = [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i]!;
          setExportProgress(`Exporting ${i + 1} of ${items.length}: ${item.label}…`);
          const draft = await fetchHostExportDraft(client, kind, item.id, hostLabel);
          const finalName = draft.defaultName.slice(0, 128);
          const finalDescription = (
            description.trim() || draft.defaultDescription
          ).slice(0, 2000);
          const created = await createHubTemplate({
            name: finalName,
            description: finalDescription,
            kind,
            payload: draft.payload,
          });
          createdIds.push(created.id);
        }
        if (createdIds.length > 0) {
          onExported(createdIds[0]!);
        }
        onClose();
        return;
      }

      // Single item export:
      const draft =
        cachedDraft ??
        (await fetchHostExportDraft(client, kind, selectedItemId || null, hostLabel));
      const finalName = (name.trim() || draft.defaultName).slice(0, 128);
      if (!finalName) {
        setError('A template name is required.');
        setBusy(false);
        return;
      }
      const created = await createHubTemplate({
        name: finalName,
        description: (nameCustomized ? description.trim() : draft.defaultDescription).slice(0, 2000),
        kind,
        payload: draft.payload,
      });
      onExported(created.id);
      onClose();
    } catch (err) {
      onApiError?.(err);
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not export template.',
      );
    } finally {
      setBusy(false);
      setExportProgress(null);
    }
  };

  const isSingleton = kind === 'planner-endpoint';
  const hasItems = items !== null && items.length > 0;
  const canExport =
    !busy &&
    !loadingItems &&
    (kind === 'mcp-registry'
      ? hasItems && selectedMcpIds.size > 0
      : exportAll
        ? hasItems
        : !loadingDraft && cachedDraft !== null);

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
                      const nextKind = e.target.value as HubTemplateKind;
                      setKind(nextKind);
                      setNameCustomized(false);
                      setExportAll(false);
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

            {kind === 'mcp-registry' ? (
              <div className="settings-row settings-row-stacked">
                <div className="export-mcp-selection-header">
                  <label className="settings-row-label">
                    MCP registries to include ({selectedMcpIds.size} of {items?.length ?? 0} selected)
                  </label>
                  {hasItems && items.length > 1 && (
                    <div className="export-mcp-selection-actions">
                      <button
                        type="button"
                        className="export-mcp-link-btn"
                        disabled={busy}
                        onClick={() => {
                          const allIds = new Set(items.map((i) => i.id));
                          setSelectedMcpIds(allIds);
                          if (!nameCustomized) {
                            setName(`${hostLabel} MCP Registries`);
                          }
                        }}
                      >
                        Select all
                      </button>
                      <span aria-hidden="true">·</span>
                      <button
                        type="button"
                        className="export-mcp-link-btn"
                        disabled={busy}
                        onClick={() => setSelectedMcpIds(new Set())}
                      >
                        Deselect all
                      </button>
                    </div>
                  )}
                </div>
                {loadingItems ? (
                  <span className="spinner">Scanning host…</span>
                ) : !hasItems ? (
                  <span className="transport-hint">No MCP registries found on this host.</span>
                ) : (
                  <div className="export-mcp-selection-list">
                    {items.map((item) => (
                      <label key={item.id} className="hub-tpl-hostpick-row">
                        <input
                          type="checkbox"
                          checked={selectedMcpIds.has(item.id)}
                          disabled={busy}
                          onChange={(e) => {
                            const next = new Set(selectedMcpIds);
                            if (e.target.checked) next.add(item.id);
                            else next.delete(item.id);
                            setSelectedMcpIds(next);
                            if (!nameCustomized) {
                              if (next.size === 1) {
                                const single = items.find((i) => next.has(i.id));
                                setName(single ? single.label : '');
                              } else {
                                setName(`${hostLabel} MCP Registries`);
                              }
                            }
                          }}
                        />
                        <span className="hub-tpl-hostpick-label">
                          <strong>{item.label}</strong>
                          {item.description && <span className="hub-tpl-meta"> — {item.description}</span>}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <>
                {!isSingleton && hasItems && items.length > 1 && (
                  <div className="settings-row">
                    <div className="settings-row-main">
                      <div className="settings-row-info">
                        <label className="settings-row-label">Scope</label>
                      </div>
                      <div className="settings-row-control">
                        <div className="planner-inline" style={{ display: 'flex', gap: 16 }}>
                          <label className="planner-radio-row" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                            <input
                              type="radio"
                              name="exportScope"
                              checked={exportAll}
                              disabled={busy || loadingDraft}
                              onChange={() => setExportAll(true)}
                            />
                            <span>All {items.length} items</span>
                          </label>
                          <label className="planner-radio-row" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                            <input
                              type="radio"
                              name="exportScope"
                              checked={!exportAll}
                              disabled={busy || loadingDraft}
                              onChange={() => setExportAll(false)}
                            />
                            <span>Specific item</span>
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {exportAll ? (
                  <div className="settings-row settings-row-stacked">
                    <label className="settings-row-label">Templates to create</label>
                    <p className="transport-hint">
                      Will create {items?.length ?? 0} template{(items?.length ?? 0) === 1 ? '' : 's'}:{' '}
                      <strong>{items?.map((i) => i.label).join(', ')}</strong>.
                      Each template will be named after its corresponding item.
                    </p>
                  </div>
                ) : !isSingleton ? (
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
                ) : null}
              </>
            )}

            {(kind === 'mcp-registry' || !exportAll) && (
              <div className="settings-row">
                <div className="settings-row-main">
                  <div className="settings-row-info">
                    <label className="settings-row-label">Template name</label>
                  </div>
                  <div className="settings-row-control">
                    <input
                      type="text"
                      value={name}
                      disabled={busy || (!isSingleton && !hasItems) || (kind !== 'mcp-registry' && loadingDraft)}
                      placeholder={
                        kind === 'mcp-registry'
                          ? selectedMcpIds.size === 1
                            ? items?.find((i) => selectedMcpIds.has(i.id))?.label || 'Template name'
                            : `${hostLabel} MCP Registries`
                          : cachedDraft?.defaultName || 'Template name'
                      }
                      onChange={(e) => {
                        setName(e.target.value);
                        setNameCustomized(true);
                      }}
                    />
                  </div>
                </div>
              </div>
            )}

            <div className="settings-row">
              <div className="settings-row-main">
                <div className="settings-row-info">
                  <label className="settings-row-label">Description</label>
                  {kind !== 'mcp-registry' && exportAll && (
                    <p className="transport-hint">
                      Optional shared description. Leave empty to use each item's description.
                    </p>
                  )}
                </div>
                <div className="settings-row-control">
                  <input
                    type="text"
                    value={description}
                    disabled={busy || (!isSingleton && !hasItems) || (kind !== 'mcp-registry' && !exportAll && loadingDraft)}
                    placeholder={
                      kind === 'mcp-registry' || exportAll
                        ? `Optional shared description (defaults to "Exported from ${hostLabel}")`
                        : 'Optional description'
                    }
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
            {busy
              ? (exportProgress ?? 'Exporting…')
              : kind === 'mcp-registry'
                ? selectedMcpIds.size > 1
                  ? `Export 1 template (${selectedMcpIds.size} MCP registries)`
                  : 'Export template'
                : exportAll
                  ? `Export all ${items?.length ?? 0} templates`
                  : 'Export template'}
          </button>
        </div>
      </div>
    </div>
  );
}
