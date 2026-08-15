import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AgentInfo,
  ChatSummary,
  HostInfo,
  ProjectInfo,
  PromptImage,
  WorkspaceEntry,
} from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { SelectorRow, type SelectorOption } from '../components/SelectorRow.js';
import { AttachButton } from '../components/AttachButton.js';
import { Icon } from '../components/Icon.js';
import { readImageFile } from '../agent/image-attachment.js';
import { setPendingPrompt } from '../agent/pending-prompt.js';
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

/** `claude:structured` — one selector row covers both choices. */
type Flavour = `${string}:${'terminal' | 'structured'}`;

const NEW_CHAT = '__new__';

/**
 * Start a chat: pick where it runs and what it runs, type the first prompt.
 *
 * Everything is chosen before anything is created, so nothing is left behind if
 * you back out. The prompt is handed to the session page rather than sent from
 * here, because the socket that will carry it does not exist yet.
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
  const [prompt, setPrompt] = useState('');
  const [attachedImage, setAttachedImage] = useState<PromptImage | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);

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
        if (preferred) setFlavour(`${preferred.id}:${preferred.defaultTransport}` as Flavour);
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
  const workspaceOptions: SelectorOption[] = workspaces.map((w) => ({
    value: w.path,
    label: w.isRoot ? basename(w.path) : w.name,
    detail: w.isRoot ? w.path : w.isGitRepo ? 'git' : undefined,
  }));

  const flavourOptions: SelectorOption[] = useMemo(
    () =>
      agents.flatMap((agent) =>
        agent.transports.map((transport) => ({
          value: `${agent.id}:${transport}`,
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
  const here = useMemo(() => {
    if (!cwd) return [];
    const out: { chat: ChatSummary; cwd: string; label: string }[] = [];
    for (const project of projects) {
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
  }, [projects, cwd]);

  const project = useMemo(() => projects.find((p) => p.cwd === cwd) ?? null, [projects, cwd]);
  const branch = project?.gitBranch ?? null;
  const isGitRepo = project?.isGitRepo ?? false;

  const worktreeOptions: SelectorOption[] = [
    { value: 'main', label: branch ? `Main — ${branch}` : 'Main' },
    { value: 'new', label: 'New worktree…' },
  ];
  const branchModeOptions: SelectorOption[] = [
    { value: 'new', label: 'New branch' },
    { value: 'current', label: branch ? `Current (${branch})` : 'Current' },
  ];

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

  const [agentId, transport] = flavour ? (flavour.split(':') as [string, 'terminal' | 'structured']) : ['', ''];
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
    (prompt.trim().length > 0 || !!attachedImage) &&
    !(startingWorktree && branchMode === 'new' && !branchName.trim());

  // Only the Claude Agent SDK backend's structured transport understands an
  // image content block (see `ws/index.ts`'s `instanceof StructuredSession`
  // check) — the attach button has to know what this composer is *actually*
  // about to create, which is one of three different things depending on
  // what's picked in the "Chat" row above:
  //  - joining an already-live chat: whatever transport it is already running as
  //  - resuming a finished one: always forced to `structured` (see below)
  //  - starting fresh: whatever the "Agent" row's flavour says
  const willBeStructured = picked?.chat.live
    ? picked.chat.transport === 'structured'
    : picked?.chat.conversationId
      ? true
      : transport === 'structured';
  const supportsImageAttachment = willBeStructured;

  const submit = useCallback(async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      // Already running: join it and hand it the prompt. Starting a second
      // process against the same conversation is the one thing resuming exists
      // to avoid.
      if (picked?.chat.live && picked.chat.sessionId) {
        setPendingPrompt(picked.chat.sessionId, prompt, attachedImage ?? undefined);
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
      });
      setPendingPrompt(session.id, prompt, attachedImage ?? undefined);
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
    prompt,
    attachedImage,
    onCreated,
    onApiError,
  ]);

  async function attach(file: File): Promise<void> {
    setAttachError(null);
    try {
      setAttachedImage(await readImageFile(file));
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : 'Could not attach that image.');
    }
  }

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
            <SelectorRow
              icon="folder"
              label="Workspace"
              ariaLabel="Workspace"
              value={cwd}
              options={workspaceOptions}
              onChange={setCwd}
            />
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
            <SelectorRow
              icon="branch"
              label="Chat"
              ariaLabel="New chat or a conversation to resume"
              value={resumeId}
              options={resumeOptions}
              onChange={setResumeId}
            />
            {!picked && isGitRepo && (
              <SelectorRow
                icon="branch"
                label="Worktree"
                ariaLabel="Run in the main checkout or a new worktree"
                value={worktreeMode}
                options={worktreeOptions}
                onChange={(v) => setWorktreeMode(v as 'main' | 'new')}
              />
            )}
            {startingWorktree && (
              <SelectorRow
                icon="branch"
                label="Branch"
                ariaLabel="New branch, or a new one off the current tip"
                value={branchMode}
                options={branchModeOptions}
                onChange={(v) => setBranchMode(v as 'new' | 'current')}
              />
            )}
          </div>
        )}
      </div>

      {startingWorktree && branchMode === 'new' && (
        <div className="field">
          <label htmlFor="composer-branch-name">Branch name</label>
          <input
            id="composer-branch-name"
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            placeholder="feature/my-branch"
          />
        </div>
      )}

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {picked && (
        <p className="composer-note">
          {picked.chat.live
            ? 'Already running — your prompt goes to that session.'
            : `Resuming as ${picked.chat.agentDisplayName} — a new branch; the original transcript is left untouched.`}
        </p>
      )}

      {startingWorktree && branchMode === 'current' && (
        <p className="composer-note">
          Git can&rsquo;t check {branch ?? 'the current branch'} out in two worktrees at once, so
          this creates a new branch from its current tip instead.
        </p>
      )}

      {startingWorktree && (
        <p className="composer-note">
          New worktree at <code>.worktrees/</code> inside this project.
        </p>
      )}

      <div className="composer-dock">
        {supportsImageAttachment && (attachedImage || attachError) && (
          <div className="attach-preview">
            {attachedImage ? (
              <>
                <img
                  src={`data:${attachedImage.mediaType};base64,${attachedImage.data}`}
                  alt="Attached"
                />
                <button
                  type="button"
                  className="attach-remove"
                  onClick={() => setAttachedImage(null)}
                  aria-label="Remove attached image"
                >
                  <Icon name="close" size={13} />
                </button>
              </>
            ) : (
              <span className="attach-error">{attachError}</span>
            )}
          </div>
        )}
        <textarea
          className="composer-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline. Phones show a Return key
            // either way, so the modifier is the only signal available.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={host ? `Work on ${host.name}` : 'Work on…'}
          rows={2}
          aria-label="First prompt"
        />
        <div className="composer-actions">
          {supportsImageAttachment && <AttachButton onFile={(file) => void attach(file)} />}
          {/* Flexible spacer: with nothing to attach, this is the whole row
              (the rows above already say what will run); with the attach
              button present, it's what still pushes send to the right. */}
          <span className="composer-hint" />
          <button
            type="button"
            className="send-btn"
            onClick={() => void submit()}
            disabled={!canSend}
            aria-label="Start chat"
          >
            {busy ? '…' : <Icon name="arrow-up" size={19} />}
          </button>
        </div>
      </div>
    </div>
  );
}
