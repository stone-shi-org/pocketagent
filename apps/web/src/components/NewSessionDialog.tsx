import { useEffect, useMemo, useState } from 'react';
import type {
  AdoptableTarget,
  AgentInfo,
  ConversationInfo,
  ProjectInfo,
  SessionTransport,
  WorkspaceEntry,
} from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { flattenProjects } from '../agent/search.js';
import { formatRelative } from './StatusBadge.js';

interface Props {
  onCreated: (sessionId: string) => void;
  onCancel: () => void;
  onApiError: (error: unknown) => void;
}

type Mode = 'new' | 'resume' | 'adopt';

export function NewSessionDialog({ onCreated, onCancel, onApiError }: Props): JSX.Element {
  const [mode, setMode] = useState<Mode>('new');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [conversations, setConversations] = useState<ConversationInfo[]>([]);
  const [adoptable, setAdoptable] = useState<AdoptableTarget[]>([]);
  const [adoptEnabled, setAdoptEnabled] = useState(false);
  /** Only fetched for its `gitBranch` field, to label the "Main" and "Current" worktree options. */
  const [projects, setProjects] = useState<ProjectInfo[]>([]);

  const [agent, setAgent] = useState('');
  const [cwd, setCwd] = useState('');
  const [transport, setTransport] = useState<SessionTransport>('terminal');
  /** Off by default. Only meaningful for an agent that reports
      `supportsSkipPermissions`; reset whenever a different agent is picked so
      the choice never silently carries over to one that ignores it. */
  const [skipPermissions, setSkipPermissions] = useState(false);

  /** 'main' is today's behaviour: run in the project directory as-is. */
  const [worktreeMode, setWorktreeMode] = useState<'main' | 'new'>('main');
  const [branchMode, setBranchMode] = useState<'new' | 'current'>('new');
  const [branchName, setBranchName] = useState('');

  /** Set while a resume or adopt needs an extra, explicit confirmation. */
  const [confirming, setConfirming] = useState<
    { kind: 'resume-inplace'; conversation: ConversationInfo } | { kind: 'adopt'; target: AdoptableTarget } | null
  >(null);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.listAgents(),
      api.listWorkspaces(),
      api.listConversations().catch(() => ({ conversations: [] })),
      api.listAdoptable().catch(() => ({ enabled: false, targets: [] })),
      api.listProjects().catch(() => ({ projects: [] as ProjectInfo[] })),
    ])
      .then(([a, w, c, ad, p]) => {
        if (cancelled) return;
        setAgents(a.agents);
        setWorkspaces(w.workspaces);
        setConversations(c.conversations);
        setAdoptable(ad.targets);
        setAdoptEnabled(ad.enabled);
        setProjects(p.projects);
        const initial = a.agents.find((x) => x.available) ?? a.agents[0];
        setAgent(initial?.id ?? '');
        setTransport(initial?.defaultTransport ?? 'terminal');
        setCwd(w.workspaces[0]?.path ?? '');
      })
      .catch((err) => {
        if (cancelled) return;
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Failed to load options.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onApiError]);

  const selected = agents.find((a) => a.id === agent) ?? null;
  const selectedWorkspace = workspaces.find((w) => w.path === cwd) ?? null;
  // A workspace root can itself be a linked worktree of another added root,
  // in which case `ProjectService.list` folds it under that root's card
  // rather than listing it as its own top-level entry — flatten first so its
  // `gitBranch` is still found by cwd (see `flattenProjects`).
  const flatProjects = useMemo(() => flattenProjects(projects), [projects]);
  const branchLabel = useMemo(
    () => flatProjects.find((p) => p.cwd === cwd)?.gitBranch ?? null,
    [flatProjects, cwd],
  );

  // A worktree/branch choice is scoped to whichever directory was selected
  // when it was made; switching to a different project should not silently
  // carry it over to one that may not even be a git repo.
  useEffect(() => {
    setWorktreeMode('main');
    setBranchMode('new');
    setBranchName('');
  }, [cwd]);

  async function submit(body: Parameters<typeof api.createSession>[0]): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await api.createSession(body);
      onCreated(session.id);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not start the session.');
    } finally {
      setBusy(false);
    }
  }

  const startFresh = async (): Promise<void> => {
    let targetCwd = cwd;
    if (worktreeMode === 'new') {
      setBusy(true);
      setError(null);
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
    return submit({ agent, cwd: targetCwd, cols: 80, rows: 24, transport, skipPermissions });
  };

  /** Fork is the default: it never touches the original transcript. */
  const resume = (conversation: ConversationInfo, fork: boolean): Promise<void> =>
    submit({
      agent: 'claude',
      cwd: conversation.cwd,
      cols: 80,
      rows: 24,
      transport: 'structured',
      resumeAgentSessionId: conversation.id,
      forkSession: fork,
      title: conversation.title,
    });

  const adopt = (target: AdoptableTarget): Promise<void> =>
    submit({
      agent: 'shell',
      cwd: target.cwd,
      cols: target.cols,
      rows: target.rows,
      transport: 'terminal',
      adoptTargetId: target.id,
    });

  return (
    <div className="dialog-backdrop" onClick={onCancel} role="presentation">
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="New session"
      >
        {confirming ? (
          <ConfirmStep
            confirming={confirming}
            busy={busy}
            onBack={() => setConfirming(null)}
            onConfirm={() => {
              const c = confirming;
              setConfirming(null);
              if (c.kind === 'resume-inplace') void resume(c.conversation, false);
              else void adopt(c.target);
            }}
          />
        ) : (
          <>
            <div className="mode-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'new'}
                className={mode === 'new' ? 'active' : ''}
                onClick={() => setMode('new')}
              >
                New
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'resume'}
                className={mode === 'resume' ? 'active' : ''}
                onClick={() => setMode('resume')}
              >
                Resume{conversations.length > 0 ? ` (${conversations.length})` : ''}
              </button>
              {adoptEnabled && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'adopt'}
                  className={mode === 'adopt' ? 'active' : ''}
                  onClick={() => setMode('adopt')}
                >
                  Attach{adoptable.length > 0 ? ` (${adoptable.length})` : ''}
                </button>
              )}
            </div>

            {error && (
              <div className="error-box" role="alert">
                {error}
              </div>
            )}

            {loading && <div className="spinner">Loading…</div>}

            {!loading && mode === 'new' && (
              <>
                <div className="field">
                  <label htmlFor="agent">Agent</label>
                  <select
                    id="agent"
                    value={agent}
                    onChange={(e) => {
                      setAgent(e.target.value);
                      const next = agents.find((x) => x.id === e.target.value);
                      if (next) setTransport(next.defaultTransport);
                      setSkipPermissions(false);
                    }}
                  >
                    {agents.map((a) => (
                      <option key={a.id} value={a.id} disabled={!a.available}>
                        {a.displayName}
                        {a.available ? '' : ' (not installed)'}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label htmlFor="cwd">Workspace</label>
                  <select id="cwd" value={cwd} onChange={(e) => setCwd(e.target.value)}>
                    {workspaces.map((w) => (
                      <option key={w.path} value={w.path}>
                        {w.isRoot ? w.name : `  ${w.name}`}
                        {w.isGitRepo ? '  ·  git' : ''}
                      </option>
                    ))}
                  </select>
                </div>

                {selectedWorkspace?.isGitRepo && (
                  <div className="field">
                    <label htmlFor="worktree">Worktree</label>
                    <select
                      id="worktree"
                      value={worktreeMode}
                      onChange={(e) => setWorktreeMode(e.target.value as 'main' | 'new')}
                    >
                      <option value="main">Main{branchLabel ? ` — ${branchLabel}` : ''}</option>
                      <option value="new">New worktree…</option>
                    </select>
                  </div>
                )}

                {selectedWorkspace?.isGitRepo && worktreeMode === 'new' && (
                  <>
                    <div className="field">
                      <label htmlFor="branch-mode">Branch</label>
                      <select
                        id="branch-mode"
                        value={branchMode}
                        onChange={(e) => setBranchMode(e.target.value as 'new' | 'current')}
                      >
                        <option value="new">New branch</option>
                        <option value="current">Current{branchLabel ? ` (${branchLabel})` : ''}</option>
                      </select>
                    </div>
                    {branchMode === 'new' ? (
                      <div className="field">
                        <label htmlFor="branch-name">Branch name</label>
                        <input
                          id="branch-name"
                          value={branchName}
                          onChange={(e) => setBranchName(e.target.value)}
                          placeholder="feature/my-branch"
                        />
                      </div>
                    ) : (
                      <p className="transport-hint">
                        Git cannot check {branchLabel ?? 'the current branch'} out in two
                        worktrees at once, so this creates a new branch from its current tip
                        instead — a real, committable branch, just not named{' '}
                        {branchLabel ?? 'the same'}.
                      </p>
                    )}
                    <p className="transport-hint">
                      New worktree at <code>.worktrees/</code> inside this project.
                    </p>
                  </>
                )}

                {selected && selected.transports.length > 1 && (
                  <>
                    <div className="field">
                      <label htmlFor="transport">Interface</label>
                      <select
                        id="transport"
                        value={transport}
                        onChange={(e) => setTransport(e.target.value as SessionTransport)}
                      >
                        {selected.transports.includes('structured') && (
                          <option value="structured">Native — chat, tool cards, tap to approve</option>
                        )}
                        {selected.transports.includes('terminal') && (
                          <option value="terminal">Terminal — exact CLI, keyboard input</option>
                        )}
                      </select>
                    </div>
                    <p className="transport-hint">
                      {transport === 'structured'
                        ? 'Renders the agent natively and turns approvals into buttons.'
                        : 'A real terminal: exact fidelity, answered with keystrokes.'}
                    </p>
                  </>
                )}

                {selected?.forcesSkipPermissions ? (
                  <div className="field checkbox-row">
                    <p className="warn-note danger-note">
                      {selected.displayName} has no approval gate in this mode — every tool call
                      runs immediately, unattended. This cannot be turned off; it is a limit of
                      how the CLI's headless mode works, not a setting.
                    </p>
                  </div>
                ) : (
                  selected?.supportsSkipPermissions && (
                    <div className="field checkbox-row">
                      <label>
                        <input
                          type="checkbox"
                          checked={skipPermissions}
                          onChange={(e) => setSkipPermissions(e.target.checked)}
                        />
                        Skip approvals for this session
                      </label>
                      <p className="warn-note danger-note">
                        Off by default. Every tool call runs immediately, unattended — nothing is
                        routed to you for approval. Only turn this on for a session you trust
                        completely, e.g. one running in a throwaway directory.
                      </p>
                    </div>
                  )
                )}

                {workspaces.length === 0 && (
                  <p className="warn-note">
                    No workspaces are configured. Set POCKETAGENT_WORKSPACE_ROOTS and restart.
                  </p>
                )}

                <div className="dialog-actions">
                  <button type="button" onClick={onCancel} disabled={busy}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void startFresh()}
                    disabled={
                      busy ||
                      !agent ||
                      !cwd ||
                      (worktreeMode === 'new' && branchMode === 'new' && !branchName.trim())
                    }
                  >
                    {busy ? 'Starting…' : worktreeMode === 'new' ? 'Create & start' : 'Start'}
                  </button>
                </div>
              </>
            )}

            {!loading && mode === 'resume' && (
              <ResumeList
                conversations={conversations}
                busy={busy}
                onFork={(c) => void resume(c, true)}
                onInPlace={(c) => setConfirming({ kind: 'resume-inplace', conversation: c })}
                onCancel={onCancel}
              />
            )}

            {!loading && mode === 'adopt' && (
              <AdoptList
                targets={adoptable}
                busy={busy}
                onPick={(t) => setConfirming({ kind: 'adopt', target: t })}
                onCancel={onCancel}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ResumeList({
  conversations,
  busy,
  onFork,
  onInPlace,
  onCancel,
}: {
  conversations: ConversationInfo[];
  busy: boolean;
  onFork: (c: ConversationInfo) => void;
  onInPlace: (c: ConversationInfo) => void;
  onCancel: () => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (conversations.length === 0) {
    return (
      <>
        <div className="empty">
          No past conversations found inside your workspace roots.
          <br />
          Start one here or at a terminal, and it will show up.
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Close
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <p className="transport-hint">
        Picks up a Claude Code conversation from disk — including ones you started at a
        terminal. Resuming branches by default, so the original transcript is never altered.
      </p>

      <div className="pick-list">
        {conversations.map((c) => (
          <div key={c.id} className="pick-row">
            <button
              type="button"
              className="pick-main"
              onClick={() => setExpanded(expanded === c.id ? null : c.id)}
            >
              <div className="pick-title">
                {c.probablyLive && <span className="live-dot" title="in use right now" />}
                {c.title}
              </div>
              <div className="pick-detail">
                {c.workspaceLabel}
                {c.gitBranch ? ` · ${c.gitBranch}` : ''} · {formatRelative(c.updatedAt)} ·{' '}
                {c.messageCount} msgs
              </div>
              {/* Untitled conversations fall back to their opening prompt, which
                  is often also the last one — no point printing it twice. */}
              {c.lastPrompt && !c.lastPrompt.startsWith(c.title) && (
                <div className="pick-preview">{c.lastPrompt}</div>
              )}
              {c.directoryBusy && (
                <div className="pick-warn">
                  {c.probablyLive
                    ? 'A Claude session is running here now — this is probably it.'
                    : 'A Claude session is running in this directory.'}
                </div>
              )}
            </button>

            {expanded === c.id && (
              <div className="pick-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => onFork(c)}
                  disabled={busy}
                >
                  Resume as new branch
                </button>
                <button type="button" onClick={() => onInPlace(c)} disabled={busy}>
                  Continue in place…
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="dialog-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </>
  );
}

function AdoptList({
  targets,
  busy,
  onPick,
  onCancel,
}: {
  targets: AdoptableTarget[];
  busy: boolean;
  onPick: (t: AdoptableTarget) => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <>
      <p className="transport-hint">
        Attaches to a tmux pane you started yourself, mirroring it here. Your terminal keeps
        working; closing this session only detaches.
      </p>

      {targets.length === 0 ? (
        <div className="empty">
          No panes found inside your workspace roots on that tmux socket.
        </div>
      ) : (
        <div className="pick-list">
          {targets.map((t) => (
            <button
              key={t.id}
              type="button"
              className="pick-row pick-main"
              onClick={() => onPick(t)}
              disabled={busy}
            >
              <div className="pick-title">
                {t.command} · {t.sessionName}:{t.windowIndex}.{t.paneIndex}
              </div>
              <div className="pick-detail">
                {t.workspaceLabel} · {t.cols}×{t.rows}
                {t.attachedClients > 0 ? ` · ${t.attachedClients} viewer(s)` : ''}
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="dialog-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </>
  );
}

/**
 * The confirm step exists because both of these actions reach outside
 * PocketAgent's own world — one writes into a transcript another process owns,
 * the other joins a terminal someone is sitting at. Neither should be a
 * single tap.
 */
function ConfirmStep({
  confirming,
  busy,
  onBack,
  onConfirm,
}: {
  confirming:
    | { kind: 'resume-inplace'; conversation: ConversationInfo }
    | { kind: 'adopt'; target: AdoptableTarget };
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const inPlace = confirming.kind === 'resume-inplace';

  return (
    <>
      <h2>{inPlace ? 'Continue in place?' : 'Attach to this pane?'}</h2>

      {inPlace ? (
        <>
          <p className="confirm-body">
            This appends to <strong>{confirming.conversation.title}</strong>&rsquo;s existing
            transcript instead of branching.
          </p>
          {confirming.conversation.directoryBusy && (
            <div className="error-box">
              A Claude session is running in this directory right now. If it is this
              conversation, both processes will append to the same file and neither will see
              the other&rsquo;s turns — and both will be editing the same working tree.
            </div>
          )}
          <p className="confirm-body dim">
            Safe when the original has finished. Choose &ldquo;Resume as new branch&rdquo;
            otherwise.
          </p>
        </>
      ) : (
        <>
          <p className="confirm-body">
            Mirrors <strong>{confirming.target.sessionName}</strong> (
            {confirming.target.command}) from your own tmux server.
          </p>
          <ul className="confirm-list">
            <li>
              <strong>Your terminal will resize.</strong> tmux sizes a window to its most
              recent client, so this view&rsquo;s dimensions win while attached. PocketAgent
              joins at the current {confirming.target.cols}×{confirming.target.rows} and will
              not resize on its own.
            </li>
            <li>
              <strong>Your tmux prefix is live.</strong> This is your server, with your
              config, so keys sent from here can drive tmux itself.
            </li>
            <li>
              Closing the session here <strong>detaches only</strong> — your pane keeps
              running.
            </li>
          </ul>
        </>
      )}

      <div className="dialog-actions">
        <button type="button" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button
          type="button"
          className={inPlace ? 'danger primary-danger' : 'primary'}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? 'Starting…' : inPlace ? 'Continue in place' : 'Attach'}
        </button>
      </div>
    </>
  );
}
