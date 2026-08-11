/**
 * PocketAgent service worker.
 *
 * Deliberately minimal: it exists to receive push messages and to focus the
 * right session when one is tapped. It caches nothing — the app is served from
 * your own machine, so an offline cache would only risk showing a stale UI
 * against a newer server.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'PocketAgent', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'PocketAgent';
  const options = {
    body: payload.body || '',
    tag: payload.tag || 'pocketagent',
    // An approval blocks the agent, so it should not auto-dismiss.
    requireInteraction: payload.requireInteraction !== false,
    data: { url: payload.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Reuse an existing tab when there is one; opening a second copy of a
      // terminal UI is disorienting.
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate(target).catch(() => undefined);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
