const CACHE = 'grooop-static-v5'
const STATIC = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-maskable.svg']

self.addEventListener('install', (event) => event.waitUntil(
  caches.open(CACHE).then((cache) => cache.addAll(STATIC)).then(() => self.skipWaiting()),
))
self.addEventListener('activate', (event) => event.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()),
))
self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.pathname.startsWith('/api/')) return
  if (url.origin !== self.location.origin) return
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(fetch(request).catch(async () => {
      const shell = await caches.match('/')
      if (!shell) {
        console.error('Offline application shell is missing from the static cache')
        throw new Error('offline-shell-missing')
      }
      return shell
    }))
    return
  }
  event.respondWith(caches.match(request).then(async (cached) => {
    if (cached) return cached
    const response = await fetch(request)
    if (response.ok && (
      STATIC.includes(url.pathname) ||
      url.pathname.startsWith('/assets/')
    )) {
      const cache = await caches.open(CACHE)
      await cache.put(request, response.clone())
    }
    return response
  }))
})
