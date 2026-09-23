/* TEST push-lab service worker: data messages are displayed here and nowhere else.
 * Updates use the browser's waiting lifecycle so an old tab keeps its matching worker. */

self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { payload = { data:{ body:event.data?.text() } }; }
  const data = payload.data || payload;
  const deliveryId = String(data.deliveryId || '');
  const url = deliveryId ? `/push-lab/?delivery=${encodeURIComponent(deliveryId)}` : '/push-lab/';
  event.waitUntil(self.registration.showNotification(`TEST · ${data.title || '미트박스 배송 알림'}`, {
    body:`TEST · ${data.body || '배송 상태가 변경되었습니다.'}`,
    tag:data.notificationId || `push-lab:${deliveryId}`,
    renotify:false,
    data:{ url, deliveryId },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const candidate = new URL(event.notification.data?.url || '/push-lab/', self.location.origin);
  const url = candidate.origin === self.location.origin && candidate.pathname.startsWith('/push-lab/') ? candidate.href : `${self.location.origin}/push-lab/`;
  event.waitUntil(self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(clients => {
    const current = clients.find(client => {
      const page = new URL(client.url);
      return page.origin === self.location.origin && ['/push-lab/', '/push-lab/index.html'].includes(page.pathname);
    });
    if (current) return current.navigate(url).then(page => page?.focus());
    return self.clients.openWindow(url);
  }));
});
