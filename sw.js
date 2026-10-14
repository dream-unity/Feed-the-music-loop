/* Generated asset list and content revision are substituted by scripts/package.mjs. */
const REVISION = "__BUILD_REVISION__";
const ASSETS = [/* __BUILD_ASSETS__ */];
const PREFIX = `fml-shell-${encodeURIComponent(new URL(self.registration.scope).pathname)}-`;
const CACHE = PREFIX + REVISION;
const URLS = new Set(ASSETS.map(path => new URL(path, self.registration.scope).href));
const HOME = new URL('./index.html', self.registration.scope).href;

self.addEventListener('install', event => {
  // Atomic install: a partial new shell never replaces the working version.
  if (!ASSETS.length) return;
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll([...URLS])));
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
