// Admin desktop notifications. This file must be served from the site root
// (/sw.js) so its scope covers /admin.html.

self.addEventListener('push', (event) => {
  let data = { title: 'Litix Support', body: 'New support activity.' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) { /* fall back to defaults above */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/assets/icon-192.png',
      badge: '/assets/favicon-48x48.png',
      data: { ticketId: data.ticketId || null },
      tag: data.ticketId ? `ticket-${data.ticketId}` : undefined,
    })
  );
});

// Clicking the OS notification focuses an already-open admin tab if there
// is one, otherwise opens a new one straight to the support section.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
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
