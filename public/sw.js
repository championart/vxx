/* VIDXX service worker: web push notifications only (no offline caching). */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = { title: 'VIDXX', body: event.data ? event.data.text() : '' }; }
  const title = String(d.title || 'VIDXX').slice(0, 80);
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = wins.filter(c => c.visibilityState === 'visible');
    wins.forEach(c => c.postMessage({ type: 'vidxx-push' }));   // open pages play the message sound
    if (visible.length) return;                                 // the person is looking at the app: no banner needed
    await self.registration.showNotification(title, {
    body: String(d.body || '').slice(0, 140),
    icon: 'icon-192.png',
    badge: 'badge-96.png',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: typeof d.url === 'string' ? d.url : '' }
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const hash = (event.notification.data && event.notification.data.url) || '';
  const target = new URL(self.registration.scope);
  if (/^#\/[A-Za-z0-9/_-]*$/.test(hash)) target.hash = hash;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(target.origin)) {
        await c.focus();
        if ('navigate' in c) { try { await c.navigate(target.href); } catch (_) { /* ignore */ } }
        return;
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
