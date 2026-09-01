import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AgentInfo,
  CronWorktreeMode,
  JiraWebhookFilter,
  ProjectInfo,
  Webhook,
  WebhookConversationMode,
  WebhookDelivery,
  WebhookDeliveryCounts,
  WorkspaceEntry,
} from '@pocketagent/protocol';
import {
  DEFAULT_JIRA_PROMPT_TEMPLATE,
  JIRA_TEMPLATE_VARS,
  WEBHOOK_SLUG_RE,
} from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { Icon } from '../components/Icon.js';
import { SecretReveal } from '../components/SecretReveal.js';
import { SelectRowNative } from '../components/SelectRowNative.js';
import { formatRelative } from '../components/StatusBadge.js';
import { flattenProjects } from '../agent/search.js';
import { NumberRow, SectionCard, TextRow } from './SettingsPage.js';

interface Props {
  /** `'new'` for an unsaved webhook. */
  webhookId: string;
  onApiError: (error: unknown) => void;
  onOpenSession: (sessionId: string) => void;
  onOpenChat: (conversationId: string) => void;
  onDone: () => void;
  onBack?: () => void;
}

/** Jira's own event names, as they appear in its webhook admin screen. */
const EVENT_CHOICES = [
  { value: 'jira:issue_created', label: 'created' },
  { value: 'jira:issue_updated', label: 'updated' },
  { value: 'jira:issue_deleted', label: 'deleted' },
  { value: 'comment_created', label: 'comment added' },
  { value: 'comment_updated', label: 'comment edited' },
];

/** Statuses that mean "this delivery never became a run". */
const DID_NOT_RUN = new Set(['filtered', 'duplicate', 'throttled', 'skipped', 'rejected', 'invalid']);

const csvToList = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

/**
 * The webhook editor, plus that webhook's delivery history.
 *
 * Built from `SettingsPage`'s card-and-row vocabulary for the same reason
 * `CronJobEditorPage` is: this is the same kind of "grouped settings with help
 * text", and a parallel set of look-alike classes is how a page ends up looking
 * like it wandered in from a different app.
 *
 * Explicit Save, like the cron editor — a half-typed filter must never become a
 * live trigger. One deliberate difference: on **create** this page does not
 * navigate away, because the response carries the secret and the next thing the
 * user has to do is paste it into Jira.
 */
export function WebhookEditorPage({
  webhookId,
  onApiError,
  onOpenSession,
  onOpenChat,
  onDone,
  onBack,
}: Props): JSX.Element {
  /** Flips to the saved id after a create, without a remount. */
  const [savedId, setSavedId] = useState<string | null>(null);
  const id = savedId ?? webhookId;
  const isNew = id === 'new';

  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [counts, setCounts] = useState<WebhookDeliveryCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showNoise, setShowNoise] = useState(false);

  /** Non-null only right after a create or a reveal. */
  const [secret, setSecret] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [deliveryPath, setDeliveryPath] = useState<string | null>(null);
  const [firstDeliveryAt, setFirstDeliveryAt] = useState<number | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  // ---- The form -------------------------------------------------------------
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [authMode, setAuthMode] = useState<'hmac' | 'bearer'>('hmac');
  const [cwd, setCwd] = useState('');
  const [agent, setAgent] = useState('claude');
  const [promptTemplate, setPromptTemplate] = useState(DEFAULT_JIRA_PROMPT_TEMPLATE);
  const [worktreeMode, setWorktreeMode] = useState<CronWorktreeMode>('new-branch');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [conversationMode, setConversationMode] = useState<WebhookConversationMode>('per-delivery');
  const [overlapPolicy, setOverlapPolicy] = useState<'skip' | 'allow'>('skip');
  const [maxConcurrent, setMaxConcurrent] = useState(2);
  const [debounceSeconds, setDebounceSeconds] = useState(10);
  const [storePayloads, setStorePayloads] = useState(true);

  // ---- The filter -----------------------------------------------------------
  const [events, setEvents] = useState<string[]>(['jira:issue_created']);
  const [projectKeys, setProjectKeys] = useState('');
  const [issueTypes, setIssueTypes] = useState('');
  const [assignees, setAssignees] = useState('');
  const [changedFields, setChangedFields] = useState('');
  const [labels, setLabels] = useState('');
  const [labelMode, setLabelMode] = useState<'any' | 'all'>('any');

  // ---- Per-project routing ----------------------------------------------------
  // `id` is a client-only key for React's benefit; it never reaches the server.
  const [projectMap, setProjectMap] = useState<{ id: string; projectKey: string; cwd: string }[]>(
    [],
  );

  const loadDeliveries = useCallback(async () => {
    if (isNew) return;
    try {
      const res = await api.listWebhookDeliveries(id);
      setDeliveries(res.deliveries);
      setCounts(res.counts);
      const earliest = res.deliveries.at(-1);
      setFirstDeliveryAt(earliest?.receivedAt ?? null);
    } catch (err) {
      onApiError(err);
    }
  }, [id, isNew, onApiError]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.listAgents(),
      api.listWorkspaces(),
      api.listProjects().catch(() => ({ projects: [] as ProjectInfo[] })),
      isNew ? Promise.resolve(null) : api.getWebhook(id),
    ])
      .then(([a, w, p, hook]) => {
        if (cancelled) return;
        setAgents(a.agents);
        setWorkspaces(w.workspaces);
        setProjects(p.projects);

        if (hook) {
          hydrate(hook);
        } else {
          setCwd(w.workspaces[0]?.path ?? '');
          const structured = a.agents.find(
            (x) => x.transports.includes('structured') && x.available,
          );
          setAgent(structured?.id ?? 'claude');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not load this webhook.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };

    function hydrate(hook: Webhook): void {
      setName(hook.name);
      setSlug(hook.slug);
      setEnabled(hook.enabled);
      setAuthMode(hook.authMode);
      setCwd(hook.cwd);
      setAgent(hook.agent);
      setPromptTemplate(hook.promptTemplate);
      setWorktreeMode(hook.worktreeMode);
      setModel(hook.model ?? '');
      setEffort(hook.effort ?? '');
      setSkipPermissions(hook.skipPermissionsEnabled);
      setConversationMode(hook.conversationMode);
      setOverlapPolicy(hook.overlapPolicy);
      setMaxConcurrent(hook.maxConcurrent);
      setDebounceSeconds(hook.debounceSeconds);
      setStorePayloads(hook.storePayloads);
      setDeliveryPath(hook.deliveryPath);
      const f = hook.config.filter;
      setEvents(f.events ?? []);
      setProjectKeys((f.projectKeys ?? []).join(', '));
      setIssueTypes((f.issueTypes ?? []).join(', '));
      setAssignees((f.assignees ?? []).join(', '));
      setChangedFields((f.changedFields ?? []).join(', '));
      setLabels((f.labels ?? []).join(', '));
      setLabelMode(f.labelMode ?? 'any');
      setProjectMap(
        hook.config.projectMap.map((e) => ({
          id: crypto.randomUUID(),
          projectKey: e.projectKey,
          cwd: e.cwd,
        })),
      );
    }
  }, [id, isNew, onApiError]);

  useEffect(() => {
    void loadDeliveries();
  }, [loadDeliveries]);

  const structuredAgents = agents.filter((a) => a.transports.includes('structured'));
  const selectedAgent = agents.find((a) => a.id === agent) ?? null;

  const flatProjects = useMemo(() => flattenProjects(projects), [projects]);
  const dirOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: { value: string; label: string }[] = [];
    for (const w of workspaces) {
      if (seen.has(w.path)) continue;
      seen.add(w.path);
      out.push({ value: w.path, label: w.path });
    }
    for (const p of flatProjects) {
      if (seen.has(p.cwd) || p.cwd === 'virtual:shell') continue;
      seen.add(p.cwd);
      out.push({ value: p.cwd, label: p.workspaceLabel || p.name });
    }
    return out;
  }, [workspaces, flatProjects]);

  /**
   * Whether the chosen directory is a git repository.
   *
   * Load-bearing rather than cosmetic: a worktree mode in a non-repo directory
   * fails on the *first delivery* with "Not a git repository", which is a
   * confusing way to discover the problem — the webhook looked fine when it was
   * saved. Checked from whichever source knows about this path.
   */
  const selectedIsRepo = useMemo(() => {
    const ws = workspaces.find((w) => w.path === cwd);
    if (ws !== undefined) return ws.isGitRepo;
    const proj = flatProjects.find((p) => p.cwd === cwd);
    // Unknown means "do not nag": a directory neither list knows about is not
    // evidence that it is not a repo.
    return proj?.isGitRepo ?? true;
  }, [cwd, workspaces, flatProjects]);

  useEffect(() => {
    // Fall back rather than letting the user save something that cannot work.
    if (!selectedIsRepo && worktreeMode !== 'none') setWorktreeMode('none');
  }, [selectedIsRepo, worktreeMode]);

  const filter = useMemo((): JiraWebhookFilter => {
    const f: JiraWebhookFilter = {};
    if (events.length > 0) f.events = events;
    const pk = csvToList(projectKeys).map((k) => k.toUpperCase());
    if (pk.length > 0) f.projectKeys = pk;
    const it = csvToList(issueTypes);
    if (it.length > 0) f.issueTypes = it;
    const asn = csvToList(assignees);
    if (asn.length > 0) f.assignees = asn;
    const cf = csvToList(changedFields);
    if (cf.length > 0) f.changedFields = cf;
    const lb = csvToList(labels);
    if (lb.length > 0) {
      f.labels = lb;
      f.labelMode = labelMode;
    }
    return f;
  }, [events, projectKeys, issueTypes, assignees, changedFields, labels, labelMode]);

  /** Empty means "match everything", which is the footgun of the whole form. */
  const filterIsEmpty = Object.keys(filter).length === 0;

  const addProjectRoute = (): void => {
    setProjectMap((prev) => [...prev, { id: crypto.randomUUID(), projectKey: '', cwd }]);
  };
  const removeProjectRoute = (id: string): void => {
    setProjectMap((prev) => prev.filter((r) => r.id !== id));
  };
  const updateProjectRoute = (
    id: string,
    patch: Partial<{ projectKey: string; cwd: string }>,
  ): void => {
    setProjectMap((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  /** Blank rows are dropped rather than rejected — a half-filled-in row while typing is not an error. */
  const cleanedProjectMap = useMemo(
    () =>
      projectMap
        .map((r) => ({ projectKey: r.projectKey.trim().toUpperCase(), cwd: r.cwd }))
        .filter((r) => r.projectKey !== '' && r.cwd !== ''),
    [projectMap],
  );

  /** The one thing Save must refuse — mirrors the route's own duplicate check. */
  const projectMapDuplicate = useMemo(() => {
    const seen = new Set<string>();
    for (const r of cleanedProjectMap) {
      if (seen.has(r.projectKey)) return r.projectKey;
      seen.add(r.projectKey);
    }
    return null;
  }, [cleanedProjectMap]);

  const slugProblem =
    slug.trim() === '' ? null : WEBHOOK_SLUG_RE.test(slug.trim()) ? null : 'Lowercase letters, digits and dashes only.';

  const save = async (): Promise<void> => {
    if (busy) return;
    if (name.trim() === '') {
      setError('Give the webhook a name.');
      return;
    }
    if (promptTemplate.trim() === '') {
      setError('A webhook needs a prompt template.');
      return;
    }
    if (slugProblem !== null) {
      setError(slugProblem);
      return;
    }
    if (projectMapDuplicate !== null) {
      setError(`Project "${projectMapDuplicate}" is mapped more than once.`);
      return;
    }
    setBusy(true);
    setError(null);

    const common = {
      name: name.trim(),
      enabled,
      config: { type: 'jira' as const, filter, projectMap: cleanedProjectMap },
      authMode,
      cwd,
      agent,
      promptTemplate,
      worktreeMode,
      conversationMode,
      overlapPolicy,
      maxConcurrent,
      debounceSeconds,
      storePayloads,
      skipPermissions,
    };

    try {
      if (isNew) {
        const created = await api.createWebhook({
          ...common,
          ...(slug.trim() !== '' ? { slug: slug.trim() } : {}),
          // On create an empty field is left absent so the agent's cached
          // default applies — distinct from the explicit `null` a PATCH sends.
          ...(model.trim() !== '' ? { model: model.trim() } : {}),
          ...(effort.trim() !== '' ? { effort: effort.trim() } : {}),
        });
        // Stay on the page: the response carries the secret, and pasting it into
        // Jira is the next thing the user has to do. Navigating away — which is
        // what the cron editor does on save — would drop it.
        //
        // The hash is rewritten with `replaceState` rather than by navigating,
        // and the distinction is the whole trick: `replaceState` fires no
        // `hashchange`, so `useHashRoute` keeps reporting `'new'` and this
        // component is not remounted by its `key` — the secret survives. But a
        // reload, a share, or a back-button press now lands on the real webhook
        // instead of an empty "new" form.
        window.history.replaceState(
          null,
          '',
          `#/hooks/${encodeURIComponent(created.webhook.id)}`,
        );
        setSavedId(created.webhook.id);
        setSlug(created.webhook.slug);
        setDeliveryPath(created.webhook.deliveryPath);
        setSecret(created.secret);
        setToken(created.token ?? null);
      } else {
        const updated = await api.updateWebhook(id, {
          ...common,
          ...(slug.trim() !== '' ? { slug: slug.trim() } : {}),
          // Explicit `null`: an emptied field means "clear it", and an omitted
          // key would silently keep the old value.
          model: model.trim() === '' ? null : model.trim(),
          effort: effort.trim() === '' ? null : effort.trim(),
        });
        setDeliveryPath(updated.deliveryPath);
      }
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not save the webhook.');
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.sendTestDelivery(id);
      await loadDeliveries();
      if (res.sessionId) onOpenSession(res.sessionId);
      else if (res.reason) setError(`Test delivery: ${res.status} — ${res.reason}`);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not send a test delivery.');
    } finally {
      setBusy(false);
    }
  };

  const runPreview = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await api.previewWebhookPrompt(id, { promptTemplate });
      setPreview(
        res.filteredReason !== null
          ? `${res.prompt}\n\n--- This payload would NOT run: ${res.filteredReason}`
          : res.prompt,
      );
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not render a preview.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.deleteWebhook(id);
      onDone();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not delete the webhook.');
      setBusy(false);
    }
  };

  const openDelivery = (d: WebhookDelivery): void => {
    // The same three-tier rule the cron run list uses: prefer the session, since
    // `GET /api/sessions/:id/history` resolves for every agent, live or
    // finished. The conversation id is the fallback for when the session row has
    // been pruned, and only resolves for claude.
    if (d.sessionId) onOpenSession(d.sessionId);
    else if (d.agentSessionId) onOpenChat(d.agentSessionId);
  };

  const insertVar = (varName: string): void => {
    setPromptTemplate((prev) => `${prev}{{${varName}}}`);
  };

  const visibleDeliveries = showNoise
    ? deliveries
    : deliveries.filter((d) => !DID_NOT_RUN.has(d.status));

  const body = loading ? (
    <div className="settings-page">
      <div className="spinner">Loading…</div>
    </div>
  ) : (
    <div className="settings-page">
      {error !== null && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <div className="settings-header">
        <div className="settings-header-icon">
          <Icon name="webhook" size={26} />
        </div>
        <div className="settings-header-title">
          <h1>{isNew ? 'New webhook' : name || 'Webhook'}</h1>
          <p className="settings-header-sub">
            Starts an agent when Jira sends a matching issue event.
          </p>
        </div>
      </div>

      <SectionCard title="Webhook" icon="webhook">
        <TextRow label="Name" value={name} busy={busy} placeholder="Triage new bugs" onChange={setName} />
        <TextRow
          label="Path"
          value={slug}
          busy={busy}
          mono
          placeholder={isNew ? 'left blank: generated from the name' : ''}
          help={
            slugProblem ??
            'The last part of the URL Jira posts to. Lowercase letters, digits and dashes.'
          }
          onChange={setSlug}
        />
        {/* Kept even with one option: the section's shape does not change when a
            second type lands, and the row documents that this is a dimension. */}
        <SelectRowNative
          busy={busy}
          label="Trigger"
          value="jira"
          options={[{ value: 'jira', label: 'Jira issue events' }]}
          onChange={() => undefined}
        />
        <SelectRowNative
          busy={busy}
          label="Authentication"
          value={authMode}
          options={[
            { value: 'hmac', label: 'Signature (recommended)' },
            { value: 'bearer', label: 'Bearer token' },
          ]}
          help={
            authMode === 'hmac'
              ? 'Jira signs each request with the secret. Only a sender holding the secret can produce a valid body.'
              : 'A token in a header. It proves who sent the request but nothing about the payload, and it lands in every proxy log along the way.'
          }
          onChange={(v) => setAuthMode(v as 'hmac' | 'bearer')}
        />
        {authMode === 'bearer' && (
          <div className="warn-callout" role="alert">
            A bearer token authenticates nothing about the body: anyone holding it can send any
            payload at all. Prefer a signature unless the sender cannot produce one.
          </div>
        )}
        <div className="settings-row">
          <div className="settings-row-main">
            <div className="settings-row-info">
              <label className="settings-row-label">Enabled</label>
              <p className="transport-hint">
                When off, the URL answers exactly as if it did not exist, so nothing can tell
                whether the webhook is paused or gone.
              </p>
            </div>
            <div className="settings-row-control">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={busy}
                  onChange={(e) => setEnabled(e.target.checked)}
                  aria-label="Enabled"
                />
                <span className="switch-track" />
              </label>
            </div>
          </div>
        </div>
      </SectionCard>

      {!isNew && deliveryPath !== null && (
        <SectionCard title="Endpoint" icon="link">
          <SecretReveal
            deliveryPath={deliveryPath}
            secret={secret}
            token={token}
            authMode={authMode}
            firstDeliveryAt={firstDeliveryAt}
            onReveal={async () => {
              const res = await api.revealWebhookSecret(id);
              setSecret(res.secret);
              setToken(res.token ?? null);
            }}
            onRotate={async () => {
              const res = await api.rotateWebhookSecret(id);
              setSecret(res.secret);
              setToken(res.token ?? null);
            }}
          />
          {/* The accurate description of what was just built, on the screen
              where it was built — not in the README. */}
          <p className="transport-hint">
            Anyone who can reach this URL and knows the secret can start an agent on this machine
            {skipPermissions ? ', with every tool approval bypassed.' : '.'}
          </p>
        </SectionCard>
      )}

      <SectionCard
        title="Which deliveries run"
        icon="folder"
        desc="Every field left empty means “match anything”."
      >
        <div className="settings-row settings-row-stacked">
          <div className="settings-row-info">
            <label className="settings-row-label">Events</label>
            <p className="transport-hint">
              Pick from the dropdown to add one; empty matches every event Jira can send.
            </p>
          </div>
          <select
            className="settings-select"
            value=""
            disabled={busy || events.length >= EVENT_CHOICES.length}
            aria-label="Add a Jira event"
            onChange={(e) => {
              const value = e.target.value;
              if (value === '') return;
              setEvents((prev) => (prev.includes(value) ? prev : [...prev, value]));
            }}
          >
            <option value="">
              {events.length >= EVENT_CHOICES.length ? 'All events added' : 'Add an event…'}
            </option>
            {EVENT_CHOICES.filter((choice) => !events.includes(choice.value)).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
          {events.length > 0 && (
            <div className="chip-list" role="list" aria-label="Selected events">
              {events.map((value) => {
                const choice = EVENT_CHOICES.find((c) => c.value === value);
                return (
                  <span key={value} className="chip chip-removable" role="listitem">
                    {choice?.label ?? value}
                    <button
                      type="button"
                      className="chip-remove-btn"
                      disabled={busy}
                      aria-label={`Remove ${choice?.label ?? value}`}
                      onClick={() => setEvents((prev) => prev.filter((e) => e !== value))}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
        </div>
        <TextRow
          label="Project keys"
          value={projectKeys}
          busy={busy}
          mono
          placeholder="ENG, PLAT"
          help="Comma-separated. Empty matches every project."
          onChange={setProjectKeys}
        />
        <TextRow
          label="Issue types"
          value={issueTypes}
          busy={busy}
          placeholder="Bug, Incident"
          help="Comma-separated. Empty matches every type."
          onChange={setIssueTypes}
        />
        <TextRow
          label="Assignee"
          value={assignees}
          busy={busy}
          placeholder="Grace Hopper"
          help="Comma-separated display names. Empty matches any assignee, including unassigned."
          onChange={setAssignees}
        />
        <TextRow
          label="Required labels"
          value={labels}
          busy={busy}
          placeholder="agent-ready"
          help="Worth more than every other control here: it narrows the trigger from “anyone who can comment on a ticket” to “anyone who can label this project”."
          onChange={setLabels}
        />
        {csvToList(labels).length > 1 && (
          <SelectRowNative
            busy={busy}
            label="Label match"
            value={labelMode}
            options={[
              { value: 'any', label: 'Any one of them' },
              { value: 'all', label: 'All of them' },
            ]}
            onChange={(v) => setLabelMode(v as 'any' | 'all')}
          />
        )}
        {events.includes('jira:issue_updated') && (
          <TextRow
            label="Changed field"
            value={changedFields}
            busy={busy}
            placeholder="status, assignee"
            help="Read from the event’s changelog, so this can never match an issue being created — a creation has no changelog."
            onChange={setChangedFields}
          />
        )}
        {filterIsEmpty && (
          <div className="warn-callout" role="alert">
            Nothing is filtered. This will start an agent for every issue event in every project
            the Jira user can see.
          </div>
        )}
      </SectionCard>

      <SectionCard title="Prompt" icon="compose">
        <TextRow
          label="Prompt template"
          value={promptTemplate}
          busy={busy}
          multiline
          rows={10}
          onChange={setPromptTemplate}
        />
        <div className="settings-row settings-row-stacked">
          <div className="settings-row-info">
            <label className="settings-row-label">Insert a value</label>
            <p className="transport-hint">
              Text written by a Jira user is wrapped in markers and labelled as data, not
              instructions. Keep that shape.
            </p>
          </div>
          {/* Rendered from the same array the server renderer iterates, so a
              variable that exists in one but not the other is impossible. */}
          <div className="toggle-chip-group">
            {JIRA_TEMPLATE_VARS.map((v) => (
              <button
                key={v.name}
                type="button"
                className="toggle-chip compact"
                disabled={busy}
                title={`${v.description} e.g. ${v.example}`}
                onClick={() => insertVar(v.name)}
              >
                {v.name}
              </button>
            ))}
          </div>
        </div>
        {!isNew && (
          <>
            <div className="secret-actions">
              <button type="button" disabled={busy} onClick={() => void runPreview()}>
                Preview
              </button>
              {preview !== null && (
                <button type="button" onClick={() => setPreview(null)}>
                  Hide
                </button>
              )}
            </div>
            {preview !== null && <pre className="hook-preview">{preview}</pre>}
          </>
        )}
      </SectionCard>

      <SectionCard title="Conversation" icon="terminal">
        <SelectRowNative
          busy={busy}
          label="Each delivery"
          value={conversationMode}
          options={[
            { value: 'per-delivery', label: 'Starts a fresh chat' },
            { value: 'per-issue', label: 'Continues one chat per issue' },
          ]}
          help={
            conversationMode === 'per-delivery'
              ? 'Every event is a cold start: the agent re-reads the issue each time and knows nothing about earlier events.'
              : 'The agent keeps the issue’s history, at the cost of a transcript that grows for as long as people keep editing that ticket.'
          }
          onChange={(v) => setConversationMode(v as WebhookConversationMode)}
        />
        {conversationMode === 'per-issue' && (
          <NumberRow
            label="Wait before starting"
            unit="seconds"
            value={debounceSeconds}
            min={0}
            max={3600}
            busy={busy}
            help="Collapses a burst of edits on one issue into a single run. A bulk edit otherwise appends one turn per changed field."
            onChange={setDebounceSeconds}
          />
        )}
        <SelectRowNative
          busy={busy}
          label="If a run is already going"
          value={overlapPolicy}
          options={[
            { value: 'skip', label: 'Skip the new delivery' },
            { value: 'allow', label: 'Start it anyway' },
          ]}
          onChange={(v) => setOverlapPolicy(v as 'skip' | 'allow')}
        />
      </SectionCard>

      <SectionCard title="Project & agent" icon="folder">
        <SelectRowNative
          busy={busy}
          label="Project"
          value={cwd}
          options={dirOptions}
          onChange={setCwd}
        />
        <SelectRowNative
          busy={busy}
          label="Agent"
          value={agent}
          options={structuredAgents.map((a) => ({
            value: a.id,
            label: a.available ? a.displayName : `${a.displayName} (not installed)`,
          }))}
          onChange={setAgent}
        />
        <SelectRowNative
          busy={busy || !selectedIsRepo}
          label="Working copy"
          value={worktreeMode}
          options={
            selectedIsRepo
              ? [
                  { value: 'new-branch', label: 'A new worktree per delivery' },
                  { value: 'current-branch', label: 'A worktree on the current branch' },
                  { value: 'none', label: 'The project directory itself' },
                ]
              : [{ value: 'none', label: 'The project directory itself' }]
          }
          help={
            !selectedIsRepo
              ? 'This directory is not a git repository, so there is no worktree to make. Without one, the agent works directly in the folder itself.'
              : worktreeMode === 'none'
                ? 'The agent works directly in your checkout. A prompt built partly from someone else’s Jira text will be editing the tree you are working in.'
                : 'Per-delivery worktrees are never cleaned up automatically — deleting one would destroy the output it produced. A busy Jira project can create hundreds.'
          }
          onChange={(v) => setWorktreeMode(v as CronWorktreeMode)}
        />
        {!selectedIsRepo && skipPermissions && (
          // The one containment boundary is unavailable here, and the approval
          // toggle is off, so say so rather than letting the two combine quietly.
          <div className="warn-callout" role="alert">
            With no worktree and approvals bypassed, an agent driven by someone else’s Jira text
            will edit this folder directly, unsupervised.
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Route by Jira project"
        icon="folder"
        desc="Leave empty to always use the project above. Once you add a row, a delivery for a project that isn’t listed here is filtered instead of falling back to it."
      >
        {projectMap.length === 0 && (
          <p className="transport-hint">
            No per-project routing. Every delivery runs in the project selected above.
          </p>
        )}
        {projectMap.map((row) => (
          <div key={row.id} className="settings-row settings-row-stacked">
            <div className="project-map-row">
              <input
                type="text"
                className="settings-input mono project-map-key"
                value={row.projectKey}
                placeholder="ENG"
                disabled={busy}
                spellCheck={false}
                aria-label="Jira project key"
                onChange={(e) => updateProjectRoute(row.id, { projectKey: e.target.value })}
              />
              <select
                className="settings-select project-map-dir"
                value={row.cwd}
                disabled={busy}
                aria-label="Directory"
                onChange={(e) => updateProjectRoute(row.id, { cwd: e.target.value })}
              >
                <option value="" disabled>
                  Choose a directory
                </option>
                {dirOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="round-btn project-map-remove"
                disabled={busy}
                aria-label={`Remove the ${row.projectKey || 'blank'} mapping`}
                onClick={() => removeProjectRoute(row.id)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          </div>
        ))}
        <button type="button" disabled={busy} onClick={addProjectRoute}>
          <Icon name="plus" size={16} />
          Add project
        </button>
        {projectMapDuplicate !== null && (
          <div className="warn-callout" role="alert">
            Project &quot;{projectMapDuplicate}&quot; is mapped more than once.
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Model & effort"
        icon="code"
        desc="Free text — each agent has its own vocabulary."
      >
        <TextRow
          label="Model"
          value={model}
          busy={busy}
          placeholder={selectedAgent?.defaultModel ?? "the agent's default"}
          listId="webhook-model-options"
          onChange={setModel}
        >
          {/* `id` is document-global and `cron-model-options` may be mounted in
              the same document on desktop. */}
          <datalist id="webhook-model-options">
            {(selectedAgent?.cachedModels ?? []).map((m) => (
              <option key={m.value} value={m.value}>
                {m.displayName}
              </option>
            ))}
          </datalist>
        </TextRow>
        <TextRow
          label="Effort"
          value={effort}
          busy={busy}
          placeholder={selectedAgent?.defaultEffort ?? "the model's default"}
          onChange={setEffort}
        />
      </SectionCard>

      <SectionCard title="Approvals" icon="shield">
        <div className="settings-row">
          <div className="settings-row-main">
            <div className="settings-row-info">
              <label className="settings-row-label">Skip tool approvals</label>
              <p className="transport-hint">
                {skipPermissions
                  ? 'Every tool call runs immediately, unattended.'
                  : 'Approvals go to the browser. A delivery that needs one waits — indefinitely — until you answer it, and you get a notification.'}
              </p>
            </div>
            <div className="settings-row-control">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={skipPermissions}
                  disabled={busy}
                  onChange={(e) => setSkipPermissions(e.target.checked)}
                  aria-label="Skip tool approvals"
                />
                <span className="switch-track" />
              </label>
            </div>
          </div>
        </div>
        {skipPermissions && (
          // Stronger than the cron editor's warning, and the difference is
          // material: a cron job's prompt is written by the operator, this one
          // is built partly from text an outsider typed into a ticket.
          <div className="warn-callout" role="alert">
            This webhook will run with every tool approval bypassed, on a prompt built partly from
            text someone else wrote in Jira. It will edit files and run commands without asking.
            Consider a per-delivery worktree and a required label.
          </div>
        )}
        <NumberRow
          label="Deliveries running at once"
          value={maxConcurrent}
          min={1}
          max={10}
          busy={busy}
          help="Over this, a delivery is recorded and dropped rather than queued. Webhook runs are also capped globally so two session slots always stay free for you."
          onChange={setMaxConcurrent}
        />
        <div className="settings-row">
          <div className="settings-row-main">
            <div className="settings-row-info">
              <label className="settings-row-label">Keep payloads</label>
              <p className="transport-hint">
                Stores each delivery&rsquo;s JSON so a filter or template can be debugged. Bounded,
                and secret-shaped fields are removed before saving.
              </p>
            </div>
            <div className="settings-row-control">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={storePayloads}
                  disabled={busy}
                  onChange={(e) => setStorePayloads(e.target.checked)}
                  aria-label="Keep payloads"
                />
                <span className="switch-track" />
              </label>
            </div>
          </div>
        </div>
      </SectionCard>

      <div className="cron-save-bar">
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
          {isNew ? 'Create webhook' : 'Save changes'}
        </button>
        {!isNew && (
          <>
            <button type="button" disabled={busy} onClick={() => void sendTest()}>
              <Icon name="play" size={16} />
              Send test delivery
            </button>
            {confirmingDelete ? (
              <button
                type="button"
                className="danger primary-danger"
                disabled={busy}
                onClick={() => void remove()}
              >
                Really delete? Deliveries are kept.
              </button>
            ) : (
              <button type="button" className="danger" onClick={() => setConfirmingDelete(true)}>
                <Icon name="trash" size={16} />
                Delete
              </button>
            )}
          </>
        )}
      </div>

      {!isNew && (
        <SectionCard title="Deliveries" icon="terminal">
          {counts !== null && counts.total > 0 && (
            <p className="transport-hint">
              {counts.total} received · {counts.ran} ran · {counts.filtered} filtered ·{' '}
              {counts.rejected} rejected{' '}
              <button type="button" className="linkish" onClick={() => setShowNoise((v) => !v)}>
                {showNoise ? 'Hide' : 'Show'} the ones that did not run
              </button>
            </p>
          )}
          {visibleDeliveries.length === 0 ? (
            <p className="transport-hint">
              {deliveries.length === 0
                ? 'No deliveries yet. Until one arrives, nothing confirms Jira can reach this server.'
                : 'No deliveries have started a run.'}
            </p>
          ) : (
            visibleDeliveries.map((d) => {
              const openable = d.sessionId !== null || d.agentSessionId !== null;
              return (
                <button
                  key={d.id}
                  type="button"
                  className={`cron-run-row${DID_NOT_RUN.has(d.status) ? ' inert' : ''}`}
                  disabled={!openable}
                  onClick={() => openDelivery(d)}
                  title={
                    openable
                      ? 'Open this delivery’s transcript'
                      : (d.reason ?? 'No transcript available')
                  }
                >
                  <span className="cron-run-row-main">
                    <span className={`cron-status cron-status--${d.status}`}>{d.status}</span>
                    <span className="cron-run-when">
                      {d.issueKey ?? d.event ?? 'delivery'}
                      {' · '}
                      {formatRelative(d.receivedAt)}
                      {d.trigger === 'test' && ' · test'}
                      {d.skipPermissionsEnabled && ' · bypassed'}
                    </span>
                  </span>
                  {d.reason !== null && <span className="delivery-reason">{d.reason}</span>}
                  {d.error !== null && <span className="cron-run-error">{d.error}</span>}
                </button>
              );
            })
          )}
        </SectionCard>
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
        <strong>{isNew ? 'New webhook' : name || 'Webhook'}</strong>
      </header>
      {body}
    </div>
  );
}
