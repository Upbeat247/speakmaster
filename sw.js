// SpeakMaster service worker.
// Responsible for caching the app shell so it loads instantly and works offline.
// Bump VERSION on every deploy so the browser picks up the new service worker
// and invalidates the old cache.
const VERSION = 'v2.0.0-stage1';
const CACHE_NAME = `speakmaster-${VERSION}`;

// The bare minimum that must work offline: the app shell itself.
// Everything else (CDN scripts, fonts, etc.) is cached opportunistically
// the first time the user visits with a working connection.
const CORE_FILES = [
  './',
  './index.html'
];

// ---------------- INSTALL ----------------
// Pre-cache the app shell so the very first offline visit still works.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_FILES))
      .catch((err) => {
        // Don't block install if one of the files fails to fetch — stale-while-revalidate
        // will patch things up on the next online visit.
        console.warn('[SW] Pre-cache failed:', err);
      })
  );
  // Activate this worker immediately after install (we'll still wait for
  // the client to ack before taking control, via SKIP_WAITING messages).
});

// ---------------- ACTIVATE ----------------
// Clean up old caches from previous versions so we don't bloat storage.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith('speakmaster-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

// ---------------- FETCH ----------------
// Strategy: stale-while-revalidate for most GET requests. Serve from cache
// immediately if present, and refresh the cache in the background.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only cache GET. POSTs (e.g. Supabase mutations) must always go to network.
  if (request.method !== 'GET') return;

  // Never touch API/function calls — they must always hit the network.
  if (url.hostname.includes('supabase.co') ||
      url.hostname.includes('supabase.in') ||
      url.hostname.includes('openrouter.ai') ||
      url.pathname.startsWith('/.netlify/functions/')) {
    return; // Let the browser handle normally
  }

  // Skip non-http(s) requests (chrome-extension://, etc.)
  if (!url.protocol.startsWith('http')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cachedResponse = await cache.match(request);

    // Kick off a network fetch in the background to keep the cache fresh.
    const networkPromise = fetch(request)
      .then((networkResponse) => {
        // Only cache successful, non-opaque responses.
        if (networkResponse && networkResponse.status === 200 && networkResponse.type !== 'opaque') {
          cache.put(request, networkResponse.clone()).catch(() => {});
        }
        return networkResponse;
      })
      .catch(() => null); // Network unavailable

    // If we have a cached copy, serve it immediately and update in background.
    if (cachedResponse) {
      event.waitUntil(networkPromise);
      return cachedResponse;
    }

    // No cache hit — wait for the network.
    const networkResponse = await networkPromise;
    if (networkResponse) return networkResponse;

    // Network failed and we have no cache — return a minimal offline page for
    // navigation requests so the user isn't staring at a broken tab.
    if (request.mode === 'navigate') {
      return new Response(
        '<html><body style="font-family:sans-serif;padding:2rem;text-align:center">' +
        '<h1>Offline</h1><p>The app shell isn\'t cached yet. Connect to the internet and reload.</p></body></html>',
        { headers: { 'Content-Type': 'text/html' } }
      );
    }
    return new Response('', { status: 504 });
  })());
});

// ---------------- MESSAGES ----------------
// Clients can send SKIP_WAITING to activate an updated SW immediately.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
