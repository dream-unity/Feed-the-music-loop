/* Generated asset list and content revision are substituted by scripts/package.mjs. */
const REVISION = "__BUILD_REVISION__";
const ASSETS = [/* __BUILD_ASSETS__ */];
const INTEGRITY = {/* __BUILD_INTEGRITY__ */};
const PREFIX = `fml-shell-${encodeURIComponent(new URL(self.registration.scope).pathname)}-`;
const CACHE = PREFIX + REVISION;
const URLS = new Set(ASSETS.map(path => new URL(path, self.registration.scope).href));
const HOME = new URL('./index.html', self.registration.scope).href;

self.addEventListener('install', event => {
  // Atomic install: a partial new shell never replaces the working version.
  if (!ASSETS.length || ASSETS.some(path => !/^sha256-[A-Za-z0-9+/]{43}=$/.test(INTEGRITY[path] || ''))) {
    // A branch-root publish may briefly serve this development template.
    // It must never activate over a complete cached studio and erase it.
    event.waitUntil(Promise.reject(new Error('The offline studio requires a packaged build.')));
    return;
  }
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      // A new namespace alone does not bypass the browser's HTTP cache. Fetch
      // fresh bytes and verify the exact package so staggered CDN updates cannot
      // install a mixture of incompatible app modules under a new revision.
      const requests = ASSETS.map(path => new Request(new URL(path, self.registration.scope), { cache: 'reload', integrity: INTEGRITY[path] }));
      await cache.addAll(requests);
    } catch (error) {
      // This revision never became active; retain every prior working shell.
      await caches.delete(CACHE).catch(() => {});
      throw error;
    }
  })());
  // Never skipWaiting: an update must not replace modules during a recording.
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)))));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || !ASSETS.length) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  const target = request.mode === 'navigate' ? HOME : url.href;
  if (!URLS.has(target)) return;
  // Only the allowlisted app shell is cached. Audio stays in project storage.
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(target)) || fetch(request)));
});
