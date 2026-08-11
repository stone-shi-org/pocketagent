import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentInfo, ConversationInfo, HostInfo, WorkspaceEntry } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { SelectorRow, type SelectorOption } from '../components/SelectorRow.js';
import { Icon } from '../components/Icon.js';
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
  const [conversations, setConversations] = useState<ConversationInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [cwd, setCwd] = useState(initialCwd ?? '');
  const [flavour, setFlavour] = useState<Flavour | ''>('');
  const [resumeId, setResumeId] = useState<string>(NEW_CHAT);
  const [prompt, setPrompt] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.listHosts(), api.listWorkspaces(), api.listAgents(), api.listConversations()])
      .then(([h, w, a, c]) => {
        if (cancelled) return;
        setHost(h.hosts[0] ?? null);
        setWorkspaces(w.workspaces);
        setAgents(a.agents);
        setConversations(c.conversations);

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
   * The fourth row doubles as branch display and resume picker: for a new chat
   * it shows the checked-out branch, and the alternatives are the conversations
   * already recorded in this directory.
   */
  const here = useMemo(
    () => conversations.filter((c) => c.cwd === cwd),
    [conversations, cwd],
  );
  const branch = useMemo(
    () => here.find((c) => c.gitBranch)?.gitBranch ?? null,
    [here],
  );
  const resumeOptions: SelectorOption[] = [
    { value: NEW_CHAT, label: branch ? `New chat · ${branch}` : 'New chat' },
    ...here.map((c) => ({
      value: c.id,
      label: c.title,
      detail: `${formatRelative(c.updatedAt)}${c.probablyLive ? ' · in use now' : ''}`,
    })),
  ];

  const [agentId, transport] = flavour ? (flavour.split(':') as [string, 'terminal' | 'structured']) : ['', ''];
  const resuming = resumeId !== NEW_CHAT;
  const canSend = !busy && !!cwd && !!agentId && prompt.trim().length > 0;

  const submit = useCallback(async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      const session = await api.createSession({
        agent: agentId,
        cwd,
        cols: 80,
        rows: 24,
        // Resuming is only meaningful over the structured transport, which is
        // what owns the conversation.
        transport: resuming ? 'structured' : (transport as 'terminal' | 'structured'),
        ...(resuming ? { resumeAgentSessionId: resumeId, forkSession: true } : {}),
      });
      setPendingPrompt(session.id, prompt);
      onCreated(session.id);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not start the chat.');
      setBusy(false);
    }
  }, [canSend, agentId, cwd, transport, resuming, resumeId, prompt, onCreated, onApiError]);

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
            <SelectorRow
              icon="laptop"
              label="Agent"
              ariaLabel="Agent and interface"
              value={flavour}
              options={flavourOptions}
              onChange={(v) => setFlavour(v as Flavour)}
            />
            <SelectorRow
              icon="branch"
              label="Chat"
              ariaLabel="New chat or a conversation to resume"
              value={resumeId}
              options={resumeOptions}
              onChange={setResumeId}
            />
          </div>
        )}
      </div>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {resuming && (
        <p className="composer-note">
          Resuming as a new branch — the original transcript is left untouched.
        </p>
      )}

      <div className="composer-dock">
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
          {/* Deliberately empty: the rows above already say what will run. */}
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
