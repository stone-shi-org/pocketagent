import { api } from '../api/client.js';
import { DEFAULT_HOST_ID } from '../api/host.js';

/**
 * Two notification paths, because they solve different problems:
 *
 *  1. The Notification API, fired from the page. Works whenever the tab is
 *     alive but hidden — switching apps on a phone, another tab on desktop.
 *     Cheap, no server involvement.
 *  2. Web Push, delivered by the browser's push service. The only thing that
 *     reaches you when the browser is closed entirely.
 *
 * Both need a secure context (HTTPS or localhost), and on iOS the site must be
 * installed to the home screen before push is allowed at all.
 */

let swRegistration: ServiceWorkerRegistration | null = null;

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window && window.isSecureContext;
}

export function pushSupported(): boolean {
  return (
    notificationsSupported() && 'serviceWorker' in navigator && 'PushManager' in window
  );
}

/** Ask once, without nagging: a denied permission is never re-requested. */
export async function ensureNotificationPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

/**
 * Deep link for a notification, carrying the host when it is not the default
 * one (PA-67).
 *
 * A local notification is raised by the pane that saw the event, so unlike a
 * *server-sent* push it knows exactly which machine it is about — and without
 * this, tapping "turn complete" for a session on `dev02` opened the same
 * session id on the default host, which is either the wrong transcript or
 * nothing at all. The default host stays bare, so single-host installs emit
 * byte-identical URLs.
 *
 * Server-sent push is deliberately **not** fixed here: the backend composes
 * that `url` itself and, behind a Hub, has no idea which host id the Hub filed
 * it under. Teaching it would mean the subscription recording a link prefix —
 * a protocol and server change that PA-67 raised as an open question rather
 * than assumed. Push subscriptions are per-origin anyway (one per browser, per
 * service worker), so they belong to the host that served this bundle.
 */
function sessionUrl(sessionId: string, hostId?: string): string {
  const session = `/s/${encodeURIComponent(sessionId)}`;
  if (hostId === undefined || hostId === DEFAULT_HOST_ID) return `/#${session}`;
  return `/#/h/${encodeURIComponent(hostId)}${session}`;
}

/** Fire a local notification for a pending approval, if the tab is hidden. */
export async function notifyApproval(
  title: string,
  sessionId: string,
  hostId?: string,
): Promise<void> {
  if (!notificationsSupported()) return;
  if (Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return;

  try {
    const registration = swRegistration ?? (await navigator.serviceWorker?.getRegistration());
    const options: NotificationOptions = {
      body: title,
      tag: `approval-${sessionId}`,
      // Approvals block the agent, so they should persist until acted on.
      requireInteraction: true,
      data: { url: sessionUrl(sessionId, hostId) },
    };
    if (registration) await registration.showNotification('PocketAgent — approval needed', options);
    else new Notification('PocketAgent — approval needed', options);
  } catch {
    // Notifications are a convenience; never let one break the session UI.
  }
}

/**
 * Fire a local notification when a turn finishes, if the tab is hidden.
 *
 * Unlike `notifyApproval`, nothing is blocked on this — the agent is simply
 * idle and ready for the next prompt — so it does not set
 * `requireInteraction`; the notification can be dismissed by the OS/browser
 * like any other passive alert instead of insisting on being acted on.
 */
export async function notifyTurnComplete(
  title: string,
  sessionId: string,
  hostId?: string,
): Promise<void> {
  if (!notificationsSupported()) return;
  if (Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return;

  try {
    const registration = swRegistration ?? (await navigator.serviceWorker?.getRegistration());
    const options: NotificationOptions = {
      body: `${title} finished and is waiting for your next prompt.`,
      tag: `turn-complete-${sessionId}`,
      data: { url: sessionUrl(sessionId, hostId) },
    };
    if (registration) await registration.showNotification('PocketAgent — turn complete', options);
    else new Notification('PocketAgent — turn complete', options);
  } catch {
    // Notifications are a convenience; never let one break the session UI.
  }
}

/**
 * Fire a local notification when a terminal session goes quiet, if the tab
 * is hidden.
 *
 * There is no structured end-of-turn event for a raw PTY — only the
 * classifier's advisory `idle` hint (see `terminal/classifier.ts`). It is
 * heuristic, so this is worded as an observation ("looks like") rather than a
 * claim, matching the server-side push sent for the same case.
 */
export async function notifyIdle(
  title: string,
  sessionId: string,
  hostId?: string,
): Promise<void> {
  if (!notificationsSupported()) return;
  if (Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return;

  try {
    const registration = swRegistration ?? (await navigator.serviceWorker?.getRegistration());
    const options: NotificationOptions = {
      body: `${title} looks like it's waiting for you.`,
      tag: `idle-${sessionId}`,
      data: { url: sessionUrl(sessionId, hostId) },
    };
    if (registration) await registration.showNotification('PocketAgent — session idle', options);
    else new Notification('PocketAgent — session idle', options);
  } catch {
    // Notifications are a convenience; never let one break the session UI.
  }
}

/**
 * Register the service worker and subscribe to Web Push.
 *
 * Returns a human-readable status so the UI can explain why it is unavailable
 * rather than silently doing nothing.
 */
export async function enablePush(): Promise<{ ok: boolean; reason?: string }> {
  if (!pushSupported()) {
    return {
      ok: false,
      reason: window.isSecureContext
        ? 'This browser does not support Web Push.'
        : 'Push needs HTTPS. Use Tailscale Serve, or a reverse proxy with TLS.',
    };
  }

  const permission = await ensureNotificationPermission();
  if (permission !== 'granted') return { ok: false, reason: 'Notification permission denied.' };

  try {
    swRegistration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    const { publicKey } = await api.pushPublicKey();
    if (!publicKey) return { ok: false, reason: 'Server has push disabled.' };

    const existing = await swRegistration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      }));

    await api.pushSubscribe(subscription.toJSON() as Record<string, unknown>);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'Subscription failed.' };
  }
}

export async function disablePush(): Promise<void> {
  try {
    const registration = swRegistration ?? (await navigator.serviceWorker?.getRegistration());
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      await api.pushUnsubscribe(subscription.endpoint).catch(() => undefined);
      await subscription.unsubscribe();
    }
  } catch {
    /* best effort */
  }
}

export async function pushEnabled(): Promise<boolean> {
  if (!pushSupported()) return false;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  return Boolean(subscription);
}

/** VAPID keys are base64url; PushManager wants raw bytes. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}
