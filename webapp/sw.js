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
