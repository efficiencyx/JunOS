// Deliberately caches nothing. The fetch handler exists only because install
// prompts require one - the app is useless without the local stack (LLM, php,
// sqlite), so a cached shell would just render a broken Jun offline. Caching
// static assets here would also fight the ?v= cache-buster convention in
// index.html/app.js, which is what actually versions this app's files.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
