// Medical History service worker
// - makes the app installable and opens it even with no internet (app shell only)
// - always tries the network first, so a new deploy shows up on the next open
// - never caches health data: API calls, Supabase and emergency pages go straight to the network
// - shows tablet reminders and opens the app when one is tapped

const CACHE = 'mh-shell-v1';
const SHELL = [
  '/', '/index.html', '/styles.css', '/config.js', '/app.js', '/features.js', '/scanner.js',
  '/download.html', '/manifest.webmanifest', '/favicon.png',
  '/assets/logo-primary.png', '/assets/icon-192.png', '/assets/icon-512.png', '/assets/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('mh-shell-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isShell = (url) => url.origin === self.location.origin
  && !url.pathname.startsWith('/api/')
  && !url.pathname.startsWith('/e/') && url.pathname !== '/e.html';

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!isShell(url)) return;                       // Supabase, Gemini, CDNs, API, emergency: untouched

  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? (url.pathname.startsWith('/download') ? '/download.html' : '/index.html') : req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const cache = await caches.open(CACHE);
      if (req.mode === 'navigate') {
        return (await cache.match(url.pathname.startsWith('/download') ? '/download.html' : '/index.html')) || (await cache.match('/')) || Response.error();
      }
      return (await cache.match(req, { ignoreSearch: true })) || Response.error();
    }
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((c) => new URL(c.url).origin === self.location.origin);
    if (open) { open.focus(); open.navigate('/#profile'); } else self.clients.openWindow('/#profile');
  })());
});
