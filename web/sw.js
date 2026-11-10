// App-shell cache: network first so deploys show up at once, cache as the
// offline fallback. Flat data is not handled here; Firestore keeps its own
// offline copy.
const CACHE = 'flatapp-shell-v3';
const SHELL = [
  './', 'style.css', 'app.js', 'store.js', 'schedule.js', 'push.js', 'firebase-config.js',
  'vendor/firebase-app.js', 'vendor/firebase-firestore.js',
  'manifest.webmanifest', 'icon.svg', 'icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match('./')))
  );
});

// Reminders arrive as FCM data messages: { data: { title, body } }.
self.addEventListener('push', (e) => {
  let payload = {};
  try { payload = e.data.json(); } catch { /* not JSON: show the generic text */ }
  const message = payload.data ?? payload.notification ?? {};
  e.waitUntil(self.registration.showNotification(message.title || 'Flatapp', {
    body: message.body || 'You have chores waiting.',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: 'flatapp-reminder', // a newer reminder replaces the older one
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((open) => (
      open.length ? open[0].focus() : self.clients.openWindow('./')
    ))
  );
});
