// caches NOTHING, on purpose. the fetch handler is only here
// because the install prompt won't show up without one.
// the app is useless without the local stack (LLM, php, sqlite),
// so a cached shell would just render a broken Jun offline.
// caching static assets here would also fight the ?v= cache-buster
// convention in index.html/app.js, and that's what actually
// versions this app's files.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => (
    list.length ? list[0].focus() : self.clients.openWindow('./')
  )));
});
