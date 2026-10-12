self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'Taxi Koblížek', body: event.data?.text() ?? '' }
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Taxi Koblížek', {
    body: data.body || '',
    icon: '/taxi-koblizek-logo.png',
    badge: '/taxi-koblizek-logo.png',
    tag: data.tag,
    renotify: Boolean(data.tag),
    data: { url: data.url || '/' },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => client.url === targetUrl) ?? clients[0]
    if (existing) return existing.focus()
    return self.clients.openWindow(targetUrl)
  }))
})
