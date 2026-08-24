import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { AgentPage } from './AgentPage.js';
import { TerminalPage } from './TerminalPage.js';

/**
 * Pick the renderer for a session.
 *
 * The transport is a property of the session, not of the URL, so this resolves
 * it once and then hands off. A short loading state is better than guessing and
 * mounting the wrong UI, which would clear the wrong kind of buffer.
 */
export function SessionRoute({
  sessionId,
  onBack,
  onApiError,
  onResumed,
}: {
  sessionId: string;
  onBack: () => void;
  onApiError: (error: unknown) => void;
  onResumed: (sessionId: string) => void;
}): JSX.Element {
  const [transport, setTransport] = useState<'terminal' | 'structured' | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTransport(null);
    setMissing(false);
    api
      .getSession(sessionId)
      .then((info) => {
        if (!cancelled) setTransport(info.transport);
      })
      .catch((err) => {
        if (cancelled) return;
        onApiError(err);
        setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, onApiError]);

  if (missing) {
    return (
      <div className="app">
        <div className="empty">
          This session no longer exists.
          <br />
          <button type="button" onClick={onBack} style={{ marginTop: 16 }}>
            Back to sessions
          </button>
        </div>
      </div>
    );
  }
  if (transport === null) return <div className="spinner">Opening session…</div>;
  if (transport === 'structured') {
    return (
      <AgentPage sessionId={sessionId} onBack={onBack} onApiError={onApiError} onResumed={onResumed} />
    );
  }
  return (
    <TerminalPage sessionId={sessionId} onBack={onBack} onApiError={onApiError} onResumed={onResumed} />
  );
}
