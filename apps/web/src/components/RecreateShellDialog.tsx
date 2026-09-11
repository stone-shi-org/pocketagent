import { useEffect, useState } from 'react';
import { ApiError } from '../api/client.js';

/**
 * Derives the tmux session name behind an adopted shell session.
 *
 * Prefers the explicit `adoptSessionName` recorded on the session row. When
 * missing (e.g. older session rows before the column was populated), parses
 * the session's title (`"<cmd> · <name>"`, e.g. `"zsh · feature-infra"`),
 * falling back to the title itself.
 */
export function extractTmuxSessionName(chat: {
  adoptSessionName?: string | null;
  title: string;
}): string {
  const explicit = chat.adoptSessionName?.trim();
  if (explicit) return explicit;
  const parts = chat.title.split(' · ');
  if (parts.length > 1) {
    const name = parts.slice(1).join(' · ').trim();
    if (name) return name;
  }
  return chat.title.trim();
}

/**
 * Whether an API error from `api.createSession({ adoptTargetId })` indicates
 * that the target tmux session is no longer present on the server.
 */
export function isMissingAdoptTargetError(err: unknown): boolean {
  if (err instanceof ApiError) {
    return (
      err.status === 404 ||
      err.code === 'not_found' ||
      err.code === 'adoption_disabled'
    );
  }
  return false;
}

export interface RecreateShellDialogProps {
  sessionName: string;
  cwd: string;
  cwdLabel?: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

/**
 * Confirmation dialog shown when a user attempts to re-attach to an adopted
 * tmux shell session whose underlying tmux session has vanished (e.g. after
 * server/host restart or kill-session).
 */
export function RecreateShellDialog({
  sessionName,
  cwd,
  cwdLabel,
  onClose,
  onConfirm,
}: RecreateShellDialogProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not recreate tmux session.');
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()} role="presentation">
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Recreate Tmux Session"
      >
        <h2>Recreate tmux session</h2>
        <p className="transport-hint">
          The tmux session <strong>&ldquo;{sessionName}&rdquo;</strong> is no longer running on this host (it may have ended or the server was restarted).
        </p>
        <p className="transport-hint">
          Would you like to recreate it with the same name in <code>{cwdLabel || cwd}</code> and attach?
        </p>

        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}

        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void handleConfirm()}
            disabled={busy}
          >
            {busy ? 'Recreating…' : 'Recreate & Attach'}
          </button>
        </div>
      </div>
    </div>
  );
}
