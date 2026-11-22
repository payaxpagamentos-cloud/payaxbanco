/*
 * Vai Mídia — service worker do player da TV.
 *
 * Guarda na TV a página do player, o script, o estilo, as fontes e os ícones. Assim, se a TV for
 * desligada e ligada sem internet, o player abre mesmo assim e passa os anúncios que já estão
 * guardados (os arquivos dos anúncios o próprio player guarda, em outro cache, que este não toca).
 *
 * Estratégia: primeiro a internet (a TV sempre pega a versão nova quando dá); sem internet, o que
 * está guardado. A API não passa por aqui: dados e anúncios são com o player.
 */
const CACHE = 'vaimidia-player-pagina';
// /midia/tv/sw.js → /midia (o sistema pode estar em outro caminho base).
const BASE = self.location.pathname.replace(/\/tv\/sw\.js$/, '');
const GUARDAR = [`${BASE}/tv/`, `${BASE}/fonts/`, `${BASE}/img/`];

// Ao instalar, guarda já a página do player e os arquivos que ela usa: a primeira abertura acontece
// antes de o service worker existir, então nada dela passou por aqui.
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      const resp = await fetch(`${BASE}/tv/`, { cache: 'no-store' });
      if (!resp.ok) return;
      const html = await resp.clone().text();
      await cache.put(`${BASE}/tv/`, resp);
      // O script e o estilo vêm com o carimbo da versão no endereço (tv.css?v=…, player.js?v=…).
      const arquivos = [...html.matchAll(/(?:href|src)="([^"]+\.(?:css|js)\?v=[^"]+)"/g)].map((m) => `${BASE}/tv/${m[1]}`);
      arquivos.push(`${BASE}/fonts/opensans-600.woff2`, `${BASE}/fonts/opensans-700.woff2`, `${BASE}/fonts/opensans-800.woff2`, `${BASE}/img/favicon.svg`);
      await Promise.all(arquivos.map((u) => cache.add(u).catch(() => {})));
    } catch { /* sem internet agora: guarda na próxima vez */ }
  })());
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  // Endereço curto da TV (tv.dominio/ → redireciona para o player): sem internet, abre o player guardado.
  const raizDaTv = req.mode === 'navigate' && url.pathname === '/' && self.location.hostname.startsWith('tv.');
  if (!raizDaTv && !GUARDAR.some((p) => url.pathname.startsWith(p))) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const resp = await fetch(req);
      // Guarda a página do player e os arquivos dela (o redirecionamento da raiz não é guardado).
      if (resp.ok && resp.type === 'basic' && !raizDaTv) await cache.put(req, resp.clone());
      return resp;
    } catch (erro) {
      // Sem internet: a página (qualquer endereço dela) sai do que foi guardado por último.
      const pagina = req.mode === 'navigate';
      const achado = await cache.match(pagina ? `${BASE}/tv/` : req, { ignoreSearch: pagina });
      if (achado) return achado;
      throw erro;
    }
  })());
});
