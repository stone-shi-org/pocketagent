import { useCallback, useEffect, useState } from 'react';
import { isTerminalStatus, type AdoptableTarget, type SessionInfo } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';

const REFRESH_MS = 4000;

interface Props {
  onClose: () => void;
  onCreated: (sessionId: string) => void;
  onApiError: (error: unknown) => void;
}

export function ShellDialog({ onClose, onCreated, onApiError }: Props): JSX.Element {
  const [targets, setTargets] = useState<AdoptableTarget[] | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ targets: adoptable }, { sessions: currentSessions }] = await Promise.all([
        api.listAdoptable(true),
        api.listSessions(),
      ]);
      setTargets(adoptable);
      setSessions(currentSessions);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load tmux sessions.');
      setTargets([]);
    }
  }, [onApiError]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const attach = async (target: AdoptableTarget) => {
    setBusyId(target.id);
    try {
      const created = await api.createSession({
        agent: 'shell',
        cwd: target.cwd,
        cols: target.cols,
        rows: target.rows,
        transport: 'terminal',
        adoptTargetId: target.id,
      });
      onCreated(created.id);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not attach to tmux session.');
      setBusyId(null);
    }
  };

  const detachSession = async (sessionId: string) => {
    setBusyId(sessionId);
    try {
      await api.deleteSession(sessionId);
      await load();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not detach tmux session.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose} role="presentation">
      <div
        className="dialog shell-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Running Tmux Sessions"
      >
        <h2>Running Tmux Sessions</h2>
        <p className="transport-hint">
          Select any running tmux session on this host to attach to it. Attaching mirrors your
          terminal without stopping your work.
        </p>

        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}

        {targets === null && <div className="spinner">Loading tmux sessions…</div>}

        {targets?.length === 0 && (
          <div className="empty">No running tmux sessions found on this machine.</div>
        )}

        {targets && targets.length > 0 && (
          <div className="pick-list">
            {targets.map((target) => {
              // Matched on the pane's own stable id, not a substring of the
              // title: a title match could cross-match a differently-named
              // pane (or miss a truncated one), which is what let this
              // dialog think a pane was not yet attached when it actually
              // was, and offer "Attach" again instead of "Detach".
              //
              // `isTerminalStatus` (not a hand-rolled exclusion list) is
              // what actually matters here: 'interrupted' — what an adopted
              // session that was running when the server restarted gets
              // marked as, since it's a direct-backend process and can never
              // survive one — was missing from an earlier, narrower check.
              // That stale, already-dead row still matched as "attached",
              // so the dialog kept showing "Detach" for a target nothing was
              // actually attached to, and clicking it was a server-side
              // no-op (terminating an already-finished session does
              // nothing) — "always Detach, no effect" from the outside.
              const attachedSession = sessions?.find(
                (s) => s.adopted && s.adoptTargetId === target.id && !isTerminalStatus(s.status),
              );

              return (
                <div key={target.id} className="hidden-row">
                  <div className="pick-main">
                    <div className="pick-title">
                      <strong>{target.sessionName}</strong>
                      <span style={{ opacity: 0.7, marginLeft: 6 }}>
                        ({target.windowIndex}.{target.paneIndex}
                        {target.title ? ` · ${target.title}` : ''})
                      </span>
                    </div>
                    <div className="pick-detail">
                      {target.command} · {target.workspaceLabel || target.cwd} · {target.cols}×
                      {target.rows}
                      {target.attachedClients > 0 ? ` · ${target.attachedClients} clients` : ''}
                    </div>
                  </div>

                  {attachedSession ? (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void detachSession(attachedSession.id)}
                      disabled={busyId !== null}
                    >
                      {busyId === attachedSession.id ? 'Detaching…' : 'Detach'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void attach(target)}
                      disabled={busyId !== null}
                    >
                      {busyId === target.id ? 'Attaching…' : 'Attach'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
