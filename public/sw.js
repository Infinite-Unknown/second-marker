/*
 * Second Marker service worker.
 * 1. Adds cross-origin isolation headers to this site's own responses, so the models can use
 *    several CPU threads on static hosts that cannot set headers (GitHub Pages).
 * 2. Keeps a copy of the app's own files, so the page also opens offline after one visit.
 * Requests to other sites (the model files) pass through untouched; the models are cached
 * separately by the model library.
 */
const CACHE = 'second-marker-app-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function isolate(response) {
  if (!response || response.status === 0 || response.type === 'opaque') return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE);
          cache.put(request, response.clone()).catch(() => {});
        }
        return isolate(response);
      } catch (err) {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return isolate(cached);
        throw err;
      }
    })(),
  );
});
