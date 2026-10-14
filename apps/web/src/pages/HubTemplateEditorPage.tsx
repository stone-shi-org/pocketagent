import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  isSingletonKind,
  parseTemplatePayload,
  type HubHostEntry,
  type HubTemplate,
  type HubTemplateKind,
  type ProvisioningResult,
} from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import {
  createHubTemplate,
  deleteHubTemplate,
  instantiateHubTemplate,
  listHubHosts,
  listHubTemplates,
  updateHubTemplate,
} from '../api/hub.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Icon } from '../components/Icon.js';
import {
  draftFrom,
  emptyDraft,
  kindInfo,
  outcomeTone,
  parseTemplateId,
  payloadFrom,
  validateDraft,
  type TemplateDraft,
} from '../agent/hub-template-format.js';
import { BoolRow, SectionCard, SelectRow, TextRow } from './SettingsPage.js';
import { exportEnvelopeToHubTemplate, exportToJsonFile } from '../agent/json-transfer.js';
import { useJsonImport } from '../hooks/useJsonImport.js';

interface Props {
  /** An existing template's id, or `newTemplateId(kind)` for an unsaved one. */
  templateId: string;
  onApiError: (error: unknown) => void;
  /**
   * Called once a *new* template has been written, with the id it was given.
   *
   * Separate from `onDone` because creating one is not finishing with it:
   * instantiating requires a saved template (see `canInstantiate`), so
   * returning to the list after a create would send the operator straight back
   * in. The caller navigates to the real id, which also means a reload lands
   * on the template rather than on an empty `new:` form.
   */
  onCreated?: (templateId: string) => void;
  onDone: () => void;
  onBack?: () => void;
}

/**
 * One config template: its fields, and pushing it onto hosts (PA-70).
 *
 * Same prop contract and the same `SectionCard`/`TextRow` vocabulary as
 * `CronJobEditorPage`, including its explicit Save rather than
 * `SettingsPage`'s auto-save — a template is one coherent thing, and a
 * half-typed base URL must not become a revision that a host can then be sent.
 * That matters more here than it does for a cron job: every edit bumps
 * `revision`, which is what makes already-provisioned hosts read as stale, so
 * auto-saving each keystroke would mark a fleet stale a hundred times while
 * someone fixed a typo.
 *
 * There is no `GET /api/hub/templates/:id` — the list is the only read — so
 * this loads the list and picks its row out. One request either way, and it
 * keeps the Hub's route surface to the five things it actually needs.
 */
export function HubTemplateEditorPage({
  templateId,
  onApiError,
  onCreated,
  onDone,
  onBack,
}: Props): JSX.Element {
  const parsedId = useMemo(() => parseTemplateId(templateId), [templateId]);
  const isNew = parsedId.mode === 'new';

  const [template, setTemplate] = useState<HubTemplate | null>(null);
  const [kind, setKind] = useState<HubTemplateKind>(
    parsedId.mode === 'new' ? parsedId.kind : 'pocket-agent',
  );
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [draft, setDraft] = useState<TemplateDraft>(emptyDraft);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // ---- The instantiate flow ------------------------------------------------
  /**
   * The Hub's own registry rows, which are what `hostIds` names.
   *
   * Not `useHostDirectory().hosts`: those carry the *routing* id, which for
   * the default host is the bare-root `local` rather than the id the Hub knows
   * that machine by — see `listHubHosts`. Picking targets from the wrong id
   * space is the kind of mistake that typechecks and then fails on exactly one
   * host.
   */
  const [hubHosts, setHubHosts] = useState<HubHostEntry[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  /**
   * The filled secret holes, for this run only.
   *
   * Component state and nothing else: never `localStorage`, never a form with
   * an `autoComplete` the browser would offer to remember, and cleared the
   * moment a run resolves either way. The Hub has no column one could go in
   * (see `SecretHole`), so a copy kept here would be the only durable one.
   */
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [overwrite, setOverwrite] = useState(false);
  const [confirmingRun, setConfirmingRun] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ProvisioningResult[] | null>(null);

  const info = kindInfo(kind);
  /** A singleton kind replaces host-wide config, so it is never a create. */
  const singleton = isSingletonKind(kind);

  const hydrate = useCallback((row: HubTemplate) => {
    setTemplate(row);
    setKind(row.kind);
    setName(row.name);
    setDescription(row.description);
    // `payload` is `unknown` on the wire on purpose — its shape is decided by
    // `kind` — so it goes through the same `parseTemplatePayload` the Hub's own
    // routes use rather than being cast into a draft.
    const spec = parseTemplatePayload(row.kind, row.payload, row.name);
    if (!spec.ok) {
      setError(`This template's payload could not be read: ${spec.message}`);
      return;
    }
    setDraft(draftFrom(spec.value));
  }, []);

  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    listHubTemplates()
      .then((all) => {
        if (cancelled) return;
        const row = all.find((candidate) => candidate.id === templateId);
        if (!row) {
          setError('No such template. It may have been deleted from another browser.');
          return;
        }
        hydrate(row);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not load this template.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isNew, templateId, hydrate, onApiError]);

  useEffect(() => {
    let cancelled = false;
    void listHubHosts()
      .then((rows) => {
        if (!cancelled) setHubHosts(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        onApiError(err);
        setError('Could not read the Hub’s host list, so there is nothing to provision onto.');
      });
    return () => {
      cancelled = true;
    };
  }, [onApiError]);

  const set = <K extends keyof TemplateDraft>(key: K, value: TemplateDraft[K]): void =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  /**
   * Whether the form still matches what the Hub holds.
   *
   * Compared on the serialized payload rather than on the draft, because the
   * draft is text and the payload is the thing that gets sent: a trailing
   * newline in the model list is not an edit. This gates instantiation, since
   * the Hub provisions the *stored* revision and `template.secretHoles`
   * describes the stored payload — asking for the holes of an unsaved edit and
   * then sending the old payload is the kind of quiet mismatch that ends in a
   * host configured with neither.
   */
  const dirty = useMemo(() => {
    if (template === null) return true;
    return (
      name.trim() !== template.name ||
      description !== template.description ||
      JSON.stringify(payloadFrom(kind, draft)) !== JSON.stringify(template.payload)
    );
  }, [template, name, description, kind, draft]);

  const holes = template?.secretHoles ?? [];
  const missingRequired = holes.filter(
    (hole) => hole.required && (secrets[hole.key] ?? '').trim() === '',
  );
  const canInstantiate =
    template !== null && !dirty && targets.length > 0 && missingRequired.length === 0 && !running;

  const save = async (): Promise<void> => {
    if (busy) return;
    if (name.trim() === '') {
      setError('Give the template a name.');
      return;
    }
    // Validated through `parseTemplatePayload` — the same function the Hub's
    // own route calls — rather than field by field here, so the editor cannot
    // accept something the Hub then refuses.
    const validation = validateDraft(kind, draft);
    if (!validation.ok) {
      setError(validation.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (template === null) {
        const created = await createHubTemplate({
          kind,
          name: name.trim(),
          description,
          payload: payloadFrom(kind, draft),
        });
        hydrate(created);
        if (onCreated) onCreated(created.id);
      } else {
        hydrate(
          await updateHubTemplate(template.id, {
            name: name.trim(),
            description,
            payload: payloadFrom(kind, draft),
          }),
        );
      }
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not save the template.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (template === null) return;
    setBusy(true);
    try {
      await deleteHubTemplate(template.id);
      onDone();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not delete the template.');
      setBusy(false);
    }
  };

  const run = async (): Promise<void> => {
    if (template === null) return;
    setConfirmingRun(false);
    setRunning(true);
    setError(null);
    try {
      const filled = Object.fromEntries(
        Object.entries(secrets).filter(([, value]) => value !== ''),
      );
      setResults(
        await instantiateHubTemplate(template.id, {
          hostIds: targets,
          ...(Object.keys(filled).length > 0 ? { secrets: filled } : {}),
          // A singleton always overwrites, so it never sends `false` — the
          // Hub refuses it outright in that case, which would read as a bug
          // in a UI that had just shown an overwrite confirmation.
          overwrite: singleton || overwrite,
        }),
      );
      // Re-read so the ledger rows and staleness markers below reflect the run.
      const all = await listHubTemplates();
      const row = all.find((candidate) => candidate.id === template.id);
      if (row) setTemplate(row);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'The provisioning run failed to start.');
    } finally {
      // Cleared on failure too: a run that errored mid-way may still have
      // written to some hosts, and the next attempt must re-collect the
      // credential rather than silently reusing one left in a form.
      setSecrets({});
      setRunning(false);
    }
  };

  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  const handleExport = (): void => {
    const payload = payloadFrom(kind, draft);
    exportToJsonFile(
      'hub-template',
      {
        kind,
        name,
        description,
        payload,
      },
      name,
    );
  };

  const { trigger: triggerImport, fileInputProps } = useJsonImport({
    expectedKind: undefined,
    onSuccess: ({ envelope }) => {
      const tpl = exportEnvelopeToHubTemplate(envelope);
      if (!tpl) {
        setError(
          `Cannot import: Hub templates only support Pocket Agents, LLM Endpoints, Skills, MCP Registries, and Claude Providers. This file contains a "${envelope.kind}" export.`,
        );
        setImportSuccess(null);
        return;
      }
      if (tpl.kind !== kind) {
        setError(
          `Cannot import: this template is for "${kindInfo(kind).label}", but the file is for "${kindInfo(tpl.kind).label}".`,
        );
        setImportSuccess(null);
        return;
      }
      const parsed = parseTemplatePayload(kind, tpl.payload, tpl.name);
      if (!parsed.ok) {
        setError(`Invalid template payload: ${parsed.message}`);
        setImportSuccess(null);
        return;
      }
      setName(tpl.name);
      if (tpl.description !== undefined) setDescription(tpl.description);
      setDraft(draftFrom(parsed.value));
      setError(null);
      setImportSuccess('Template configuration imported into draft.');
    },
    onError: (err) => {
      setError(err);
      setImportSuccess(null);
    },
  });

  const body = loading ? (
    <div className="settings-page">
      <div className="spinner">Loading…</div>
    </div>
  ) : (
    <div className="settings-page">
      <input {...fileInputProps} />
      {error !== null && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {importSuccess !== null && (
        <div className="success-box" role="status">
          {importSuccess}
        </div>
      )}

      <div className="settings-header">
        <div className="settings-header-icon">
          <Icon name="template" size={26} />
        </div>
        <div className="settings-header-title">
          <h1>{isNew && template === null ? `New ${info.label.toLowerCase()} template` : name || 'Template'}</h1>
          <p className="settings-header-sub">
            {info.label}
            {template !== null && ` · r${template.revision}`}
            {' — '}
            {info.blurb}
          </p>
        </div>
        <div className="settings-header-actions" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            type="button"
            className="settings-close-btn"
            onClick={handleExport}
            title="Export template to JSON file"
          >
            <Icon name="download" size={14} />
            Export JSON
          </button>
          <button
            type="button"
            className="settings-close-btn"
            onClick={triggerImport}
            title="Import template from JSON file"
          >
            <Icon name="upload" size={14} />
            Import JSON
          </button>
        </div>
      </div>

      {info.disclosure !== null && (
        <div className="warn-callout" role="note">
          {info.disclosure}
        </div>
      )}

      <SectionCard title="Template" icon="folder">
        <TextRow
          label="Name"
          value={name}
          busy={busy}
          placeholder="Release-notes agent"
          help="The Hub's own name for this template. It is not sent to a host."
          onChange={setName}
        />
        <TextRow
          label="Notes"
          value={description}
          busy={busy}
          multiline
          rows={2}
          placeholder="Why this exists, and which machines should have it."
          onChange={setDescription}
        />
      </SectionCard>

      <KindFields kind={kind} draft={draft} busy={busy} set={set} />

      <div className="cron-save-bar">
        <button type="button" className="primary" disabled={busy || !dirty} onClick={() => void save()}>
          {template === null ? 'Create template' : dirty ? 'Save changes' : 'Saved'}
        </button>
        {template !== null && dirty && (
          <span className="transport-hint">
            Editing bumps the revision; hosts that already have this template keep what they were
            sent and read as stale.
          </span>
        )}
        {template !== null &&
          (confirmingDelete ? (
            <button
              type="button"
              className="danger primary-danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              Really delete? Provisioned hosts keep theirs.
            </button>
          ) : (
            <button type="button" className="danger" onClick={() => setConfirmingDelete(true)}>
              <Icon name="trash" size={16} />
              Delete
            </button>
          ))}
      </div>

      <SectionCard
        title="Instantiate"
        icon="laptop"
        desc="Writes this template onto the hosts you pick, one at a time, and reports what happened to each."
      >
        {template === null ? (
          <p className="transport-hint">Save the template first — provisioning sends the stored revision.</p>
        ) : (
          <>
            {dirty && (
              <div className="warn-callout" role="alert">
                There are unsaved changes. Provisioning sends the revision the Hub has stored
                (r{template.revision}), so save first or your edits will not be the thing that
                lands.
              </div>
            )}

            <div className="settings-row settings-row-stacked">
              <div className="settings-row-info">
                <label className="settings-row-label">Hosts</label>
                <p className="transport-hint">
                  Each is provisioned in turn and gets its own result. One host being down does
                  not stop the others.
                </p>
              </div>
              <div className="hub-tpl-hostpick">
                {hubHosts.length === 0 && (
                  <p className="transport-hint">This Hub has no registered hosts yet.</p>
                )}
                {hubHosts.map((host) => {
                  const entry = template.provisionings.find((row) => row.hostId === host.id);
                  /* An offline or unbound host is still selectable: the Hub
                     reports a per-host outcome either way, and hiding it would
                     leave "why is dev02 not in the list" unanswered. */
                  const dot = host.enabled && host.status.online ? 'host-dot' : 'host-dot offline';
                  return (
                    <label key={host.id} className="hub-tpl-hostpick-row">
                      <input
                        type="checkbox"
                        checked={targets.includes(host.id)}
                        disabled={running}
                        onChange={(e) =>
                          setTargets((prev) =>
                            e.target.checked
                              ? [...prev, host.id]
                              : prev.filter((id) => id !== host.id),
                          )
                        }
                      />
                      <span className="hub-tpl-hostpick-label">
                        <span className={dot} aria-hidden="true" />
                        {host.label}
                        {!host.enabled && <span className="hub-tpl-meta"> disabled in the Hub</span>}
                        {host.boundAt === null && (
                          <span className="hub-tpl-meta"> not bound — no credential yet</span>
                        )}
                        {entry !== undefined && (
                          <span className="hub-tpl-meta">
                            {' '}
                            already provisioned at r{entry.templateRevision}
                            {entry.stale && ' (stale)'}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            {holes.length > 0 && (
              <div className="settings-row settings-row-stacked">
                <div className="settings-row-info">
                  <label className="settings-row-label">Credentials for this run</label>
                  <p className="transport-hint">
                    The Hub stores none of these. They are used for this run, sent to each host
                    you picked, and forgotten — so you will be asked again the next time you
                    provision this template.
                  </p>
                </div>
                {holes.map((hole) => (
                  <div key={hole.key} className="hub-tpl-hole">
                    <label className="settings-row-label" htmlFor={`hole-${hole.key}`}>
                      {hole.label}
                      {!hole.required && <span className="settings-unit">(optional)</span>}
                    </label>
                    <input
                      id={`hole-${hole.key}`}
                      type="password"
                      className="settings-input"
                      // Off rather than a `new-password` hint: this is not the
                      // browser's credential to keep, and a saved-password
                      // prompt for a key the Hub deliberately does not store
                      // would be the wrong promise to make.
                      autoComplete="off"
                      spellCheck={false}
                      value={secrets[hole.key] ?? ''}
                      disabled={running}
                      onChange={(e) =>
                        setSecrets((prev) => ({ ...prev, [hole.key]: e.target.value }))
                      }
                    />
                    <p className="transport-hint">{hole.description}</p>
                  </div>
                ))}
              </div>
            )}

            {singleton ? (
              /* No checkbox: there is no non-overwriting reading of this kind,
                 so the confirmation is mandatory rather than opt-in and the
                 dialog below is what carries it. */
              <div className="warn-callout" role="alert">
                This kind always overwrites — it replaces the selected hosts’ existing Pocket
                Agent endpoint rather than adding anything — so you will be asked to confirm.
              </div>
            ) : (
              <BoolRow
                label="Replace what this Hub already put there"
                checked={overwrite}
                busy={running}
                help={
                  overwrite
                    ? 'A host this Hub has already provisioned will have that resource replaced with this revision. A resource created by hand on the host is never touched — that is reported as a conflict instead.'
                    : 'A host this Hub has already provisioned is skipped and nothing is written to it.'
                }
                onChange={setOverwrite}
              />
            )}

            <div className="cron-save-bar">
              <button
                type="button"
                className="primary"
                disabled={!canInstantiate}
                onClick={() => {
                  // Confirmed rather than immediate whenever something
                  // existing can be replaced — which for a singleton kind is
                  // always, including the first run on a host.
                  if (singleton || overwrite) setConfirmingRun(true);
                  else void run();
                }}
              >
                <Icon name="play" size={16} />
                {running ? 'Provisioning…' : `Instantiate on ${targets.length || 'no'} host${targets.length === 1 ? '' : 's'}`}
              </button>
              {missingRequired.length > 0 && (
                <span className="transport-hint">
                  Fill {missingRequired.map((hole) => hole.label).join(', ')} first.
                </span>
              )}
            </div>

            {results !== null && (
              <div className="hub-tpl-results">
                {results.map((result) => (
                  <div key={result.hostId} className="hub-tpl-result">
                    <div className="hub-tpl-result-head">
                      <strong>{result.hostLabel}</strong>
                      <span className={`hub-tpl-outcome hub-tpl-outcome--${outcomeTone(result.outcome)}`}>
                        {result.outcome}
                      </span>
                    </div>
                    <p className="transport-hint">{result.message}</p>
                    {result.items.length > 0 && (
                      <ul className="hub-tpl-items">
                        {result.items.map((item, index) => (
                          /* Keyed by index: an item is a report line, not an
                             entity, and two can legitimately share a label. */
                          <li key={index} className={item.ok ? 'ok' : 'warn'}>
                            <Icon name={item.ok ? 'check' : 'close'} size={14} />
                            {item.label} — {item.message}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </SectionCard>

      {confirmingRun && (
        <ConfirmDialog
          title={singleton ? 'Replace host-wide settings?' : 'Replace what is already there?'}
          body={
            singleton
              ? `This repoints the Pocket Agent LLM endpoint on ${targets.length} host${targets.length === 1 ? '' : 's'}. Every existing Pocket Agent chat on ${targets.length === 1 ? 'that machine' : 'those machines'} will talk to this endpoint instead of its current one.`
              : `On any of the ${targets.length} selected host${targets.length === 1 ? '' : 's'} this Hub has already provisioned, the resource it created will be replaced with r${template?.revision}. Anything created by hand on a host is left alone and reported as a conflict.`
          }
          confirmLabel="Provision"
          busy={running}
          onConfirm={() => void run()}
          onCancel={() => setConfirmingRun(false)}
        />
      )}
    </div>
  );

  if (!onBack) return body;
  return (
    <div className="app">
      <header className="home-bar">
        <button type="button" className="round-btn" onClick={onBack} aria-label="Back">
          <Icon name="chevron-left" size={20} />
        </button>
        <div className="home-title">
          <strong>{name || info.label}</strong>
        </div>
      </header>
      {body}
    </div>
  );
}

/**
 * The kind-specific half of the form.
 *
 * One component with a `switch` rather than five sibling components, because
 * every branch is the same `SectionCard` + rows vocabulary and the interesting
 * content is *which* fields a kind has — a reader comparing two kinds should
 * be able to do it by scrolling, not by opening two files. What is deliberately
 * absent is as load-bearing as what is here: a Pocket Agent template has no
 * directory field, because a planner workspace's path is host-specific by
 * construction and pointing an agent at an operator-chosen directory hands its
 * tools full read/write/delete trust over it (see `PocketAgentTemplatePayload`).
 */
function KindFields({
  kind,
  draft,
  busy,
  set,
}: {
  kind: HubTemplateKind;
  draft: TemplateDraft;
  busy: boolean;
  set: <K extends keyof TemplateDraft>(key: K, value: TemplateDraft[K]) => void;
}): JSX.Element {
  switch (kind) {
    case 'pocket-agent':
      return (
        <SectionCard
          title="Pocket Agent"
          icon="agents"
          desc="Created on each host in its own app-owned scratch directory under that host's data root."
        >
          <TextRow
            label="Agent name"
            value={draft.name}
            busy={busy}
            placeholder="Release notes"
            onChange={(v) => set('name', v)}
          />
          <TextRow
            label="Default model"
            value={draft.defaultModelId}
            busy={busy}
            placeholder="the host's own last-used model"
            help="The provider's model name, not a host-minted model id — which is why it travels. A host whose endpoint does not offer it is reported as a mismatch."
            onChange={(v) => set('defaultModelId', v)}
          />
          <TextRow
            label="Identity prompt"
            value={draft.identityPrompt}
            busy={busy}
            multiline
            rows={4}
            placeholder="You write release notes from merged pull requests…"
            onChange={(v) => set('identityPrompt', v)}
          />
          <BoolRow
            label="Memory"
            checked={draft.memoryEnabled}
            busy={busy}
            onChange={(v) => set('memoryEnabled', v)}
          />
          <BoolRow
            label="MCP"
            checked={draft.mcpEnabled}
            busy={busy}
            onChange={(v) => set('mcpEnabled', v)}
          />
          <TextRow
            label="Tools to turn off"
            value={draft.disabledTools}
            busy={busy}
            multiline
            rows={3}
            mono
            placeholder={'exec_command\nrmdir'}
            help="One tool name per line. Everything else stays enabled, so a tool added to a host's catalog later is on there without this template mentioning it. A name a host has never heard of is reported as one skipped item, with the agent still created."
            onChange={(v) => set('disabledTools', v)}
          />
        </SectionCard>
      );

    case 'mcp-registry':
      if (draft.isBundle && draft.mcpRegistries && draft.mcpRegistries.length > 1) {
        return (
          <SectionCard
            title={`MCP registries (${draft.mcpRegistries.length} bundled)`}
            icon="link"
            desc="This template bundles multiple MCP registries. Instantiating it configures all of them on the receiving host."
          >
            <div className="hub-discovered">
              {draft.mcpRegistries.map((reg, idx) => (
                <div key={idx} className="hub-row-card">
                  <div className="hub-row-icon">
                    <Icon name="link" size={18} />
                  </div>
                  <div className="hub-row-main">
                    <strong>{reg.name}</strong>
                    <span className="hub-mono">{reg.url}</span>
                    <span className="hub-muted">
                      Transport: {reg.transport} · Auth: {reg.authKind}
                      {reg.headerName ? ` (${reg.headerName})` : ''} · {reg.enabled ? 'Enabled' : 'Disabled'}
                      {reg.description ? ` — ${reg.description}` : ''}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>
        );
      }
      return (
        <SectionCard title="MCP registry" icon="link">
          <TextRow
            label="Name"
            value={draft.name}
            busy={busy}
            placeholder="Atlassian"
            onChange={(v) => set('name', v)}
          />
          <TextRow
            label="URL"
            value={draft.url}
            busy={busy}
            mono
            placeholder="https://mcp.example.com/mcp"
            onChange={(v) => set('url', v)}
          />
          <SelectRow
            label="Transport"
            value={draft.transport}
            busy={busy}
            options={[
              { value: 'streamable_http', label: 'Streamable HTTP' },
              { value: 'sse', label: 'SSE' },
            ]}
            onChange={(v) => set('transport', v as TemplateDraft['transport'])}
          />
          <SelectRow
            label="Authentication"
            value={draft.authKind}
            busy={busy}
            options={[
              { value: 'none', label: 'None' },
              { value: 'bearer', label: 'Bearer token' },
              { value: 'header', label: 'Custom header' },
            ]}
            help="The header *name* is configuration and travels with the template; the value is a secret and is asked for per host."
            onChange={(v) => set('authKind', v as TemplateDraft['authKind'])}
          />
          {draft.authKind === 'header' && (
            <TextRow
              label="Header name"
              value={draft.headerName}
              busy={busy}
              mono
              placeholder="X-Api-Key"
              onChange={(v) => set('headerName', v)}
            />
          )}
          <TextRow
            label="Description"
            value={draft.description}
            busy={busy}
            multiline
            rows={2}
            onChange={(v) => set('description', v)}
          />
          <BoolRow
            label="Enabled on the host"
            checked={draft.enabled}
            busy={busy}
            onChange={(v) => set('enabled', v)}
          />
        </SectionCard>
      );

    case 'claude-provider':
      return (
        <SectionCard
          title="Custom Claude provider"
          icon="code"
          desc="The same claude binary, pointed at another Anthropic-compatible endpoint."
        >
          <TextRow
            label="Name"
            value={draft.name}
            busy={busy}
            placeholder="DeepSeek"
            onChange={(v) => set('name', v)}
          />
          <SelectRow
            label="Kind"
            value={draft.providerKind}
            busy={busy}
            options={[
              { value: 'claude-compatible', label: 'Anthropic-compatible gateway' },
              { value: 'deepseek', label: 'DeepSeek' },
            ]}
            onChange={(v) => set('providerKind', v as TemplateDraft['providerKind'])}
          />
          <TextRow
            label="Base URL"
            value={draft.baseUrl}
            busy={busy}
            mono
            placeholder="https://api.deepseek.com/anthropic"
            onChange={(v) => set('baseUrl', v)}
          />
          <TextRow
            label="Models"
            value={draft.models}
            busy={busy}
            multiline
            rows={3}
            mono
            help="One model id per line. This list replaces what the CLI reports, which is Anthropic's catalog whatever the base URL is."
            onChange={(v) => set('models', v)}
          />
          <TextRow
            label="Default model"
            value={draft.defaultModel}
            busy={busy}
            mono
            onChange={(v) => set('defaultModel', v)}
          />
          <TextRow
            label="Small/fast model"
            value={draft.smallModel}
            busy={busy}
            mono
            placeholder="optional"
            onChange={(v) => set('smallModel', v)}
          />
          <BoolRow
            label="Allow unattended use"
            checked={draft.allowUnattended}
            busy={busy}
            help="Off by default, and this is the one field here that grants something: it lets this provider run scheduled jobs and inbound webhooks on every host you instantiate it on."
            onChange={(v) => set('allowUnattended', v)}
          />
          {draft.allowUnattended && (
            <div className="warn-callout" role="alert">
              With this on, the provider may be selected for scheduled jobs and inbound webhooks —
              work that runs with nobody watching, against a third-party endpoint, with prompts
              and repository contents going to it.
            </div>
          )}
        </SectionCard>
      );

    case 'skill':
      return (
        <SectionCard
          title="Skill"
          icon="compose"
          desc="Added to the receiving host's global skill catalog as global:<slug>."
        >
          <TextRow
            label="Slug"
            value={draft.slug}
            busy={busy}
            mono
            placeholder="release-notes"
            help="Lowercase letters, digits and hyphens. Carried explicitly rather than derived per host, because it is how the Hub finds again what it provisioned."
            onChange={(v) => set('slug', v)}
          />
          <TextRow
            label="Name"
            value={draft.name}
            busy={busy}
            placeholder="Release notes"
            onChange={(v) => set('name', v)}
          />
          <TextRow
            label="Description"
            value={draft.description}
            busy={busy}
            multiline
            rows={2}
            help="What the agent reads to decide whether this skill applies."
            onChange={(v) => set('description', v)}
          />
          <TextRow
            label="SKILL.md body"
            value={draft.body}
            busy={busy}
            multiline
            rows={12}
            mono
            help="One SKILL.md, and only that — auxiliary files in a skill directory are not carried by a template."
            onChange={(v) => set('body', v)}
          />
        </SectionCard>
      );

    case 'planner-provider':
      return (
        <SectionCard
          title="Pocket Agent provider"
          icon="shield"
          desc="An OpenAI-compatible Pocket Agent LLM provider and its model catalog."
        >
          <TextRow
            label="Provider label"
            value={draft.name}
            busy={busy}
            placeholder="OpenRouter"
            onChange={(v) => set('name', v)}
          />
          <TextRow
            label="Base URL"
            value={draft.baseUrl}
            busy={busy}
            mono
            placeholder="https://openrouter.ai/api/v1"
            onChange={(v) => set('baseUrl', v)}
          />
          <TextRow
            label="Models"
            value={draft.models}
            busy={busy}
            multiline
            rows={4}
            mono
            placeholder={'gpt-4.1-mini | Fast\ngpt-4.1'}
            help="One per line, as `model-id` or `model-id | label`. The label defaults to the id."
            onChange={(v) => set('models', v)}
          />
          <BoolRow
            label="Allow unattended use"
            checked={draft.allowUnattended}
            busy={busy}
            help="Off by default. Carried on the provider for phase 2 unattended gating."
            onChange={(v) => set('allowUnattended', v)}
          />
        </SectionCard>
      );
  }
}
