import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AgentInfo,
  ChatSummary,
  EffortLevel,
  HostInfo,
  ProjectInfo,
  WorkspaceEntry,
} from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { SelectorRow, type SelectorOption } from '../components/SelectorRow.js';
import { AddProject } from '../components/AddProject.js';
import { WorktreeDialog, type WorktreeChoice } from '../components/WorktreeDialog.js';
import { Icon } from '../components/Icon.js';
import { effortLabel } from '../components/PromptBox.js';
import { type Flavour, makeFlavour, parseFlavour } from '../agent/flavour.js';
import { flattenProjects } from '../agent/search.js';
import { resolveCurrentModel } from '../agent/transcript.js';
import { formatRelative } from '../components/StatusBadge.js';

interface Props {
  /** Preselects the workspace when composing from a project header. */
  initialCwd?: string;
  onBack: () => void;
  onCreated: (sessionId: string) => void;
  onApiError: (error: unknown) => void;
}

/** Last path segment, without pulling in a path polyfill for one line. */
function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

const NEW_CHAT = '__new__';
/** Sentinel option in the Workspace picker that opens `AddProject` instead of selecting a value. */
const ADD_WORKSPACE = '__add_workspace__';

/**
 * Start a chat: pick where it runs and what it runs, then create it.
 *
 * Everything is chosen before anything is created, so nothing is left behind if
 * you back out. There is no first-prompt box here — creating (or opening a
 * picked chat) hands off to the session page with nothing queued to send, the
 * same state any other chat is in the moment it goes idle waiting on you.
 */
export function ComposerPage({ initialCwd, onBack, onCreated, onApiError }: Props): JSX.Element {
  const [host, setHost] = useState<HostInfo | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [cwd, setCwd] = useState(initialCwd ?? '');
  const [flavour, setFlavour] = useState<Flavour | ''>('');
  const [resumeId, setResumeId] = useState<string>(NEW_CHAT);
  /** 'main' is today's behaviour: run in the workspace directory as-is. Only
      meaningful for a fresh chat — resuming always runs where the original did. */
  const [worktreeMode, setWorktreeMode] = useState<'main' | 'new'>('main');
  const [branchMode, setBranchMode] = useState<'new' | 'current'>('new');
  const [branchName, setBranchName] = useState('');
  const [worktreeDialogOpen, setWorktreeDialogOpen] = useState(false);
  const [showAddWorkspace, setShowAddWorkspace] = useState(false);
  /**
   * Model/effort for a brand-new chat, pre-filled from `AgentInfo.defaultModel`/
   * `defaultEffort` — the per-agent "last observed live" cache (see
   * `agent_defaults` in db/index.ts), since nothing about model choice is
   * knowable before a session exists to ask. `effort: null` means "the
   * model's own default", same meaning as everywhere else this type is used.
   */
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<EffortLevel | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Sourced from /api/projects rather than /api/conversations so that this
    // row shows exactly what the home screen shows: live sessions included,
    // and anything the user removed or hid left out.
    Promise.all([api.listHosts(), api.listWorkspaces(), api.listAgents(), api.listProjects()])
      .then(([h, w, a, p]) => {
        if (cancelled) return;
        setHost(h.hosts[0] ?? null);
        setWorkspaces(w.workspaces);
        setAgents(a.agents);
        setProjects(p.projects);

        setCwd((prev) => prev || w.workspaces[0]?.path || '');
        const preferred = a.agents.find((x) => x.available) ?? a.agents[0];
        if (preferred) setFlavour(makeFlavour(preferred.id, preferred.defaultTransport));
      })
      .catch((err) => {
        if (cancelled) return;
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not load options.');
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [onApiError]);

  // A conversation belongs to one directory, so changing directory invalidates
  // the chosen one rather than silently resuming something from elsewhere.
  useEffect(() => setResumeId(NEW_CHAT), [cwd]);

  // A worktree/branch choice is scoped to whichever directory was selected
  // when it was made; switching to a different project should not silently
  // carry it over to one that may not even be a git repo.
  useEffect(() => {
    setWorktreeMode('main');
    setBranchMode('new');
    setBranchName('');
  }, [cwd]);

  const hostOptions: SelectorOption[] = host
    ? [{ value: host.id, label: host.name, detail: host.online ? 'online' : 'unreachable' }]
    : [];

  // A root's `name` is its full path, which is unreadable on a phone. Show the
  // basename and keep the path as the detail line, where it disambiguates two
  // roots that happen to end in the same folder name.
  const workspaceOptions: SelectorOption[] = [
    ...workspaces.map((w) => ({
      value: w.path,
      label: w.isRoot ? basename(w.path) : w.name,
      detail: w.isRoot ? w.path : w.isGitRepo ? 'git' : undefined,
    })),
    // Browsing to (or creating) a folder is one modal away rather than a trip
    // back to the Projects page — that used to be the only way to widen this
    // list before starting a chat.
    { value: ADD_WORKSPACE, label: 'Add workspace…', detail: 'browse or create a folder' },
  ];

  const flavourOptions: SelectorOption[] = useMemo(
    () =>
      agents.flatMap((agent) =>
        agent.transports.map((transport) => ({
          value: makeFlavour(agent.id, transport),
          label: `${agent.displayName} · ${transport === 'structured' ? 'native' : 'terminal'}`,
          detail: !agent.available
            ? 'not installed'
            : transport === 'structured'
              ? 'chat, tool cards, tap to approve'
              : 'exact CLI, keystrokes',
          disabled: !agent.available,
        })),
      ),
    [agents],
  );

  /**
   * The fourth row: start something new, or pick up something already here.
   *
   * "Here" means the chosen directory *or anything under it*, because choosing a
   * workspace root and being told there is nothing to resume — while every
   * project inside it is full of chats — is simply wrong. A chat carries its own
   * directory, so picking one from a subdirectory runs it where it belongs
   * rather than where the row above happens to point.
   */
  // A folded worktree is still a real, addressable directory (see
  // `flattenProjects`) — flattening first is what lets a worktree nested
  // under the chosen folder still show up in `here`, and lets `project` below
  // resolve even when `cwd` itself is a worktree rather than a top-level row.
  const flatProjects = useMemo(() => flattenProjects(projects), [projects]);

  const here = useMemo(() => {
    if (!cwd) return [];
    const out: { chat: ChatSummary; cwd: string; label: string }[] = [];
    for (const project of flatProjects) {
      if (project.cwd !== cwd && !project.cwd.startsWith(`${cwd}/`)) continue;
      for (const chat of project.chats) {
        // A finished chat with no transcript has nothing to continue from.
        if (!chat.live && !chat.conversationId) continue;
        out.push({
          chat,
          cwd: project.cwd,
          label: project.cwd === cwd ? '' : project.name,
        });
      }
    }
    return out.sort((a, b) => b.chat.updatedAt - a.chat.updatedAt);
  }, [flatProjects, cwd]);

  const project = useMemo(() => flatProjects.find((p) => p.cwd === cwd) ?? null, [flatProjects, cwd]);
  const branch = project?.gitBranch ?? null;
  const isGitRepo = project?.isGitRepo ?? false;

  // Summarised into one line for the row; the picking itself happens in
  // WorktreeDialog, which is where all three of these are actually chosen.
  const worktreeSummary =
    worktreeMode === 'main'
      ? branch
        ? `Main — ${branch}`
        : 'Main'
      : branchMode === 'new'
        ? branchName.trim()
          ? `New worktree — ${branchName.trim()}`
          : 'New worktree…'
        : `New worktree — off ${branch ?? 'current tip'}`;

  const resumeOptions: SelectorOption[] = [
    { value: NEW_CHAT, label: branch ? `New chat · ${branch}` : 'New chat' },
    ...here.map(({ chat, label }) => ({
      value: chat.id,
      label: chat.title,
      detail: [
        chat.live ? 'running now' : formatRelative(chat.updatedAt),
        label,
      ]
        .filter(Boolean)
        .join(' · '),
    })),
  ];

  const picked = here.find((h) => h.chat.id === resumeId);

  const { agentId, transport } = parseFlavour(flavour);
  // A picked chat always resumes as whatever agent it already is — the
  // "Agent" row above is only consulted for a brand new chat. Falling back to
  // the row's own selection here used to mean picking a finished, say, `agy`
  // chat and sending would resume it as Claude (or whatever the row happened
  // to show), because `submit` below sent `agentId` unconditionally with
  // `picked.chat.conversationId` as `resumeAgentSessionId` — an agent
  // resuming a different agent's conversation id, which cannot work.
  const effectiveAgentId = picked ? picked.chat.agent : agentId;
  const startingWorktree = !picked && isGitRepo && worktreeMode === 'new';
  const canSend =
    !busy &&
    !!cwd &&
    !!effectiveAgentId &&
    !(startingWorktree && branchMode === 'new' && !branchName.trim());

  // Whether the chat about to be opened runs the structured transport — one
  // of three different things depending on what's picked in the "Chat" row
  // above:
  //  - joining an already-live chat: whatever transport it is already running as
  //  - resuming a finished one: always forced to `structured` (see below)
  //  - starting fresh: whatever the "Agent" row's flavour says
  // Only used to gate the model/effort pickers below, which only apply to a
  // brand-new structured chat.
  const willBeStructured = picked?.chat.live
    ? picked.chat.transport === 'structured'
    : picked?.chat.conversationId
      ? true
      : transport === 'structured';

  // Model/effort only matter for a brand-new chat — a picked chat (live or
  // resumed) always keeps whatever it was already using, same reasoning as
  // `effectiveAgentId` above.
  //
  // Every structured backend reports `AgentInfo.cachedModels` (all five
  // normalize `models_available`/`model_changed`/`effort_changed` into the
  // same events `SessionManager.wire` caches from), and as of PA-50
  // `SessionManager.create` threads a cached/explicit model into every one of
  // them (effort too, for the three — `claude`/`codex`/`pi` — with a real
  // per-turn effort switch; see `showEffortPicker` below). So the model
  // picker's gate is just "does this agent have a catalog to show" —
  // `cachedModels.length` alone, same as `showModelPicker` already checks.
  const selectedAgent = !picked ? (agents.find((a) => a.id === agentId) ?? null) : null;
  // `model` holds a picker `value` (e.g. `'sonnet'`), but `AgentInfo.defaultModel`
  // is the *resolved* wire id Claude's `session_started` actually reports (e.g.
  // `'claude-sonnet-5'`) — same mismatch `resolveCurrentModel`'s doc comment
  // describes for the live composer, so this reuses it rather than a plain
  // `.find(m => m.value === model)` that would never match the cached default.
  const selectedModelInfo = selectedAgent ? resolveCurrentModel(selectedAgent.cachedModels, model) : null;
  const showModelPicker = !picked && willBeStructured && !!selectedAgent?.cachedModels.length;
  const showEffortPicker = showModelPicker && selectedModelInfo?.supportsEffort === true;

  // Re-seed from this agent's cached defaults whenever the "Agent" row
  // changes — including on initial load, once `agents` itself has arrived.
  useEffect(() => {
    if (!selectedAgent) {
      setModel('');
      setEffort(null);
      return;
    }
    const resolved = resolveCurrentModel(selectedAgent.cachedModels, selectedAgent.defaultModel);
    setModel(resolved?.value ?? '');
    setEffort(selectedAgent.defaultEffort ?? null);
  }, [selectedAgent]);

  const submit = useCallback(async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      // Already running: just open it. Starting a second process against the
      // same conversation is the one thing resuming exists to avoid.
      if (picked?.chat.live && picked.chat.sessionId) {
        onCreated(picked.chat.sessionId);
        return;
      }

      // A resumed chat runs where it was, not where the row above points; a
      // fresh chat starting a new worktree runs there instead of the plain
      // workspace directory. Worktree creation gets its own try/catch and its
      // own message, since a failure here is a different problem (a git
      // mutation that didn't happen) from a failure to start the session.
      let targetCwd = picked?.cwd ?? cwd;
      if (startingWorktree) {
        try {
          targetCwd = (
            await api.createWorktree({
              cwd,
              branchMode,
              ...(branchMode === 'new' ? { branchName } : {}),
            })
          ).cwd;
        } catch (err) {
          onApiError(err);
          setError(err instanceof ApiError ? err.message : 'Could not create the worktree.');
          setBusy(false);
          return;
        }
      }

      const resumeFrom = picked?.chat.conversationId ?? null;
      const session = await api.createSession({
        agent: effectiveAgentId,
        cwd: targetCwd,
        cols: 80,
        rows: 24,
        // Resuming is only meaningful over the structured transport, which is
        // what owns the conversation.
        transport: resumeFrom ? 'structured' : (transport as 'terminal' | 'structured'),
        ...(resumeFrom ? { resumeAgentSessionId: resumeFrom, forkSession: false } : {}),
        // Only a brand-new chat has a model/effort choice to make (see
        // `showModelPicker`) — a resumed or already-live chat keeps whatever
        // it was already running, so nothing is sent for either.
        ...(!picked && model ? { model } : {}),
        ...(!picked && showEffortPicker ? { effort } : {}),
      });
      onCreated(session.id);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not start the chat.');
      setBusy(false);
    }
  }, [
    canSend,
    effectiveAgentId,
    cwd,
    transport,
    picked,
    startingWorktree,
    branchMode,
    branchName,
    model,
    effort,
    showEffortPicker,
    onCreated,
    onApiError,
  ]);

  return (
    <div className="app composer-page">
      <header className="home-bar">
        <button type="button" className="round-btn" onClick={onBack} aria-label="Back">
          <Icon name="chevron-left" size={20} />
        </button>
      </header>

      <div className="composer-body">
        {loading ? (
          <div className="spinner">Loading…</div>
        ) : (
          <div className="selector-stack">
            <SelectorRow
              icon="terminal"
              label="Host"
              ariaLabel="Host"
              value={host?.id ?? ''}
              options={hostOptions}
              onChange={() => {
                /* one host until a front server registers others */
              }}
            />
            {/* With zero workspaces, `workspaceOptions` holds only the sentinel
                — SelectorRow collapses a single-option row into a no-op tap
                (the right call for e.g. the one-host row), which would make
                this the one place a first-run user could never get past. */}
            {workspaces.length === 0 ? (
              <button
                type="button"
                className="selector-row"
                onClick={() => setShowAddWorkspace(true)}
                aria-label="Workspace: add a folder to get started"
                data-selector="Workspace"
              >
                <Icon name="folder" className="leading" />
                <span className="selector-value">Add a workspace…</span>
                <Icon name="stepper" className="stepper" />
              </button>
            ) : (
              <SelectorRow
                icon="folder"
                label="Workspace"
                ariaLabel="Workspace"
                value={cwd}
                options={workspaceOptions}
                onChange={(v) => (v === ADD_WORKSPACE ? setShowAddWorkspace(true) : setCwd(v))}
              />
            )}
            {/* A picked chat always resumes as whatever agent it already is
                (see `effectiveAgentId`) — this row only matters for a brand
                new chat, so it is hidden rather than left showing a choice
                that submitting would silently ignore. */}
            {!picked && (
              <SelectorRow
                icon="laptop"
                label="Agent"
                ariaLabel="Agent and interface"
                value={flavour}
                options={flavourOptions}
                onChange={(v) => setFlavour(v as Flavour)}
              />
            )}
            {/* Hidden until this agent has actually run once — there is no
                way to enumerate its models without a live session (the SDK
                cannot report a catalog from an idle process), so an agent
                nobody has used yet just starts on its own default, same as
                before this row existed. */}
            {showModelPicker && selectedAgent && (
              <SelectorRow
                icon="laptop"
                label="Model"
                ariaLabel="Model"
                value={model}
                options={selectedAgent.cachedModels.map((m) => ({
                  value: m.value,
                  label: m.displayName,
                }))}
                onChange={(v) => {
                  setModel(v);
                  const info = selectedAgent.cachedModels.find((m) => m.value === v);
                  // Effort vocab is per-model; carry the current pick forward
                  // only if the newly chosen model still recognizes it.
                  setEffort((prev) =>
                    info?.supportsEffort && prev && info.supportedEffortLevels.includes(prev)
                      ? prev
                      : null,
                  );
                }}
              />
            )}
            {showEffortPicker && selectedModelInfo && (
              <SelectorRow
                icon="laptop"
                label="Effort"
                ariaLabel="Effort"
                value={effort ?? ''}
                options={[
                  { value: '', label: "Model's default" },
                  ...selectedModelInfo.supportedEffortLevels.map((level) => ({
                    value: level,
                    label: effortLabel(level),
                  })),
                ]}
                onChange={(v) => setEffort(v === '' ? null : v)}
              />
            )}
            <SelectorRow
              icon="branch"
              label="Chat"
              ariaLabel="New chat or a conversation to resume"
              value={resumeId}
              options={resumeOptions}
              onChange={setResumeId}
            />
            {!picked && isGitRepo && (
              <button
                type="button"
                className="selector-row"
                onClick={() => setWorktreeDialogOpen(true)}
                aria-label={`Worktree: ${worktreeSummary}`}
                aria-haspopup="dialog"
                data-selector="Worktree"
              >
                <Icon name="branch" className="leading" />
                <span className="selector-value">{worktreeSummary}</span>
                <Icon name="stepper" className="stepper" />
              </button>
            )}
          </div>
        )}
      </div>

      {showAddWorkspace && (
        <AddProject
          onClose={() => setShowAddWorkspace(false)}
          onAdded={(path) => {
            setCwd(path);
            api
              .listWorkspaces()
              .then((w) => setWorkspaces(w.workspaces))
              .catch(onApiError);
          }}
          onApiError={onApiError}
        />
      )}

      {worktreeDialogOpen && (
        <WorktreeDialog
          branch={branch}
          initial={{ mode: worktreeMode, branchMode, branchName }}
          onCancel={() => setWorktreeDialogOpen(false)}
          onConfirm={(choice: WorktreeChoice) => {
            setWorktreeMode(choice.mode);
            setBranchMode(choice.branchMode);
            setBranchName(choice.branchName);
            setWorktreeDialogOpen(false);
          }}
        />
      )}

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {picked && (
        <p className="composer-note">
          {picked.chat.live
            ? 'Already running — this opens the live session.'
            : `Resuming as ${picked.chat.agentDisplayName} — a new branch; the original transcript is left untouched.`}
        </p>
      )}

      <div className="composer-dock">
        {/* No first-prompt box: the session is created (or joined) empty and
            ready for input, same as tapping into any other chat. */}
        <button
          type="button"
          className="primary composer-submit"
          onClick={() => void submit()}
          disabled={!canSend}
          aria-label={picked ? 'Open chat' : 'Create chat'}
        >
          {busy ? '…' : picked ? 'Open' : 'Create chat'}
        </button>
      </div>
    </div>
  );
}
