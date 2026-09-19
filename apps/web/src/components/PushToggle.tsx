import { useEffect, useState } from 'react';
import { disablePush, enablePush, pushEnabled, pushSupported } from '../agent/notifications.js';
import { api } from '../api/client.js';
import { Icon } from './Icon.js';

/**
 * Opt-in control for approval notifications.
 *
 * Deliberately explicit rather than auto-subscribing: a notification permission
 * prompt on first load is hostile, and push only earns its keep once you are
 * actually leaving agents running while you walk away.
 *
 * PA-73: When connected through a Hub, checks per-host stream status so any
 * host whose notifications cannot be delivered is visible rather than silently
 * dropped.
 */
export function PushToggle({ compact = false }: { compact?: boolean } = {}): JSX.Element | null {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [hostWarning, setHostWarning] = useState<string | null>(null);

  async function checkHostHealth(): Promise<void> {
    try {
      const status = await api.pushStatus();
      if (status.hosts) {
        const offline = Object.entries(status.hosts).filter(([_, h]) => !h.ok);
        if (offline.length > 0) {
          setHostWarning(
            `Notifications offline for: ${offline.map(([id, h]) => `${id} (${h.reason ?? h.status})`).join(', ')}`,
          );
          return;
        }
      }
      setHostWarning(null);
    } catch {
      /* best effort */
    }
  }

  useEffect(() => {
    void pushEnabled().then((enabled) => {
      setOn(enabled);
      if (enabled) void checkHostHealth();
    });
  }, []);

  if (!pushSupported()) return null;

  async function toggle(): Promise<void> {
    setBusy(true);
    setReason(null);
    try {
      if (on) {
        await disablePush();
        setOn(false);
        setHostWarning(null);
      } else {
        const result = await enablePush();
        setOn(result.ok);
        if (!result.ok) {
          setReason(result.reason ?? 'Could not enable notifications.');
        } else {
          await checkHostHealth();
        }
      }
    } finally {
      setBusy(false);
    }
  }

  const tooltip = hostWarning ?? reason ?? (on ? 'Approval alerts on' : 'Approval alerts off');

  // In the home dock there is no room for a labelled button, and the state is
  // legible from the glyph alone.
  if (compact) {
    return (
      <button
        type="button"
        className={`round-btn${hostWarning ? ' text-warning' : ''}`}
        onClick={() => void toggle()}
        disabled={busy}
        aria-pressed={on}
        aria-label={tooltip}
        title={tooltip}
      >
        <Icon name={hostWarning ? 'bell-off' : on ? 'bell' : 'bell-off'} size={20} />
      </button>
    );
  }

  return (
    <>
      <button type="button" onClick={() => void toggle()} disabled={busy}>
        {on ? '🔔 Alerts on' : '🔕 Alerts off'}
      </button>
      {hostWarning && <div className="transport-hint" style={{ color: 'var(--amber, #f59e0b)' }}>⚠️ {hostWarning}</div>}
      {reason && <div className="transport-hint">{reason}</div>}
    </>
  );
}
