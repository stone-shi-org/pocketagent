import { useEffect } from 'react';

interface Props {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Most callers are a destructive "stop/terminate", so red is the default. */
  danger?: boolean;
  /** Disables both buttons and Escape/backdrop-dismiss while the action is in flight. */
  busy?: boolean;
  /**
   * Renders only the confirm button, for a purely informational
   * acknowledgement (e.g. "this worktree has uncommitted changes") rather
   * than an actual yes/no choice. Escape still calls `onCancel` so a keyboard
   * user can dismiss it the same way; `onConfirm` and `onCancel` are expected
   * to be the same close-the-dialog callback in that case.
   */
  hideCancel?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Replaces `window.confirm` with a dialog that matches the rest of the app —
 * a browser confirm cannot be styled and looks foreign next to `SettingsPage`
 * and `RunningSessions`, which already use this exact `.dialog`/`.confirm-body`
 * shape for the same "are you sure" moment (see the skip-permissions confirm in
 * `SettingsPage`). `role="alertdialog"` rather than `dialog` is the one
 * difference from those, since this one is always a yes/no interruption.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = true,
  busy = false,
  hideCancel = false,
  onConfirm,
  onCancel,
}: Props): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);

  return (
    <div className="dialog-backdrop" onClick={busy ? undefined : onCancel} role="presentation">
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
      >
        <h2>{title}</h2>
        <p className="confirm-body">{body}</p>
        <div className="dialog-actions">
          {!hideCancel && (
            <button type="button" onClick={onCancel} disabled={busy}>
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            className={danger ? 'danger primary-danger' : 'primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
