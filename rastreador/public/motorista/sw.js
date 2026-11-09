/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/
// Avisos no celular do motorista: mostra a notificação que o servidor mandou e abre o app ao tocar.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { titulo: 'Rastreador', texto: e.data?.text() ?? '' }; }
  e.waitUntil(self.registration.showNotification(d.titulo || 'Rastreador', {
    body: d.texto || '', icon: '../img/favicon.svg', badge: '../img/favicon.svg', tag: d.titulo, renotify: true, data: { url: './' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
    const aberto = lista.find((c) => c.url.includes('/motorista/'));
    return aberto ? aberto.focus() : self.clients.openWindow(e.notification.data?.url || './');
  }));
});
