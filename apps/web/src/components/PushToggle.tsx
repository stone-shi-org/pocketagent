import { useEffect, useState } from 'react';
import { disablePush, enablePush, pushEnabled, pushSupported } from '../agent/notifications.js';
import { Icon } from './Icon.js';

/**
 * Opt-in control for approval notifications.
 *
 * Deliberately explicit rather than auto-subscribing: a notification permission
 * prompt on first load is hostile, and push only earns its keep once you are
 * actually leaving agents running while you walk away.
 */
export function PushToggle({ compact = false }: { compact?: boolean } = {}): JSX.Element | null {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    void pushEnabled().then(setOn);
  }, []);

  if (!pushSupported()) return null;

  async function toggle(): Promise<void> {
    setBusy(true);
    setReason(null);
    try {
      if (on) {
        await disablePush();
        setOn(false);
      } else {
        const result = await enablePush();
        setOn(result.ok);
        if (!result.ok) setReason(result.reason ?? 'Could not enable notifications.');
      }
    } finally {
      setBusy(false);
    }
  }

  // In the home dock there is no room for a labelled button, and the state is
  // legible from the glyph alone.
  if (compact) {
    return (
      <button
        type="button"
        className="round-btn"
        onClick={() => void toggle()}
        disabled={busy}
        aria-pressed={on}
        aria-label={on ? 'Approval alerts on' : 'Approval alerts off'}
        title={reason ?? (on ? 'Approval alerts on' : 'Approval alerts off')}
      >
        <Icon name={on ? 'bell' : 'bell-off'} size={20} />
      </button>
    );
  }

  return (
    <>
      <button type="button" onClick={() => void toggle()} disabled={busy}>
        {on ? '🔔 Alerts on' : '🔕 Alerts off'}
      </button>
      {reason && <div className="transport-hint">{reason}</div>}
    </>
  );
}
