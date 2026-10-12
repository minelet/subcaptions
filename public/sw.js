// Combined service worker, served from the site root (/sw.js).
// 1) Monetag ad network (must stay as provided by Monetag for verification/Multitag).
// 2) Admin desktop notifications for Litix support tickets.

// ---- Monetag ----
self.options = {
    "domain": "5gvci.com",
    "zoneId": 12011946
}
self.lary = ""
importScripts('https://5gvci.com/act/files/service-worker.min.js?r=sw')

// ---- Litix admin notifications ----
self.addEventListener('push', (event) => {
  let data = null;
  try {
    if (event.data) data = event.data.json();
  } catch (e) { /* not our payload */ }
  // Only handle pushes sent by our own server (they always carry a ticketId).
  // Anything else belongs to the ad network's handler above.
  if (!data || typeof data !== 'object' || !data.ticketId) return;

  const title = data.title || 'Litix Support';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || 'New support activity.',
      icon: '/assets/icon-192.png',
      badge: '/assets/favicon-48x48.png',
      data: { ticketId: data.ticketId },
      tag: `ticket-${data.ticketId}`,
    })
  );
});

// Clicking one of our notifications focuses an already-open admin tab if
// there is one, otherwise opens a new one straight to the support section.
self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  if (!n || !n.data || !n.data.ticketId) return; // not ours; let the ad script handle it
  n.close();
  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientsList) {
      if (client.url.includes('/admin.html')) {
        client.focus();
        return;
      }
    }
    await self.clients.openWindow('/admin.html');
  })());
});
