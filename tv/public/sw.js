/**
 * Service worker da PLAY TECH VIP — o que faz o app instalado no celular abrir rápido
 * e não ficar em branco quando a rede oscila.
 *
 * Regras:
 *  - API (`/api/…`): sempre rede. Token, catálogo e reprodução nunca saem do cache.
 *  - Artes (capas e logos): mostra a guardada na hora e atualiza por trás.
 *  - Páginas: tenta a rede e, sem rede, abre a última versão guardada.
 *  - Arquivos do app (css, js, fontes, ícones): guardados na instalação.
 *  - Vídeo nunca é guardado (são arquivos grandes e com link assinado de curta validade).
 *
 * Ao publicar uma versão nova do app, mude VERSAO: o navegador troca tudo na próxima abertura.
 */

const VERSAO = 'v9';
const CASCA = `playtechvip-casca-${VERSAO}`;
const ARTES = `playtechvip-artes-${VERSAO}`;
const ARTES_MAX = 150;

const BASE = new URL('./', self.location).pathname;
const arquivo = (caminho) => new URL(caminho, self.location).pathname;

const DO_APP = [
  './',
  './index.html',
  './app.webmanifest',
  './privacidade.html',
  './termos.html',
  './css/tv.css',
  './fonts/manrope.woff2',
  './img/favicon.svg',
  './img/icone-192.png',
  './img/icone-512.png',
  // TODOS os módulos do app do assinante. A lista é conferida por teste (test/pwa.test.js):
  // módulo novo que não entre aqui faz o app instalado abrir em branco sem rede, porque o
  // primeiro `import` dele falha e derruba a cadeia inteira. Já aconteceu — faltavam sete.
  // Os `admin*` ficam de fora de propósito: o painel é outra página e não funciona sem rede.
  ...['api', 'app', 'autoplay', 'cartazes-demo', 'cartoes', 'conta', 'entrada', 'envio',
    'excluir-conta', 'instalar', 'login-icones', 'mascotes', 'motor-nativo', 'perfis',
    'player', 'titulo', 'tv', 'ui', 'vigia', 'vitrine']
    .map((n) => `./js/${n}.js`),
].map(arquivo);

self.addEventListener('install', (evento) => {
  evento.waitUntil((async () => {
    const cache = await caches.open(CASCA);
    // addAll falha inteiro se um arquivo faltar: guarda um a um para a instalação não quebrar.
    await Promise.all(DO_APP.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil((async () => {
    const nomes = await caches.keys();
    await Promise.all(nomes.filter((n) => n.startsWith('playtechvip-') && n !== CASCA && n !== ARTES).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

/** Mantém o cache de artes num tamanho razoável (as mais antigas saem primeiro). */
async function aparar(nome, maximo) {
  const cache = await caches.open(nome);
  const chaves = await cache.keys();
  if (chaves.length <= maximo) return;
  await Promise.all(chaves.slice(0, chaves.length - maximo).map((k) => cache.delete(k)));
}

self.addEventListener('fetch', (evento) => {
  const req = evento.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const caminho = url.pathname;
  const api = caminho.startsWith(`${BASE}api/`);

  // Artes: responde do cache e busca a versão nova por trás.
  if (api && caminho.startsWith(`${BASE}api/arte/`)) {
    evento.respondWith((async () => {
      const cache = await caches.open(ARTES);
      const guardada = await cache.match(req);
      const rede = fetch(req).then((r) => {
        if (r.ok) cache.put(req, r.clone()).then(() => aparar(ARTES, ARTES_MAX));
        return r;
      }).catch(() => guardada);
      return guardada ?? rede;
    })());
    return;
  }

  // Resto da API, vídeo e listas ao vivo: rede, sempre.
  if (api) return;

  // Páginas: rede primeiro, cache como rede de segurança.
  if (req.mode === 'navigate') {
    evento.respondWith((async () => {
      try {
        return await fetch(req);
      } catch {
        const cache = await caches.open(CASCA);
        return (await cache.match(req)) ?? (await cache.match(arquivo('./'))) ?? Response.error();
      }
    })());
    return;
  }

  // Folhas de estilo e scripts: REDE PRIMEIRO, com o cache só como rede de segurança.
  //
  // Eles não levam versão no nome, então, servidos do cache primeiro, uma atualização só
  // aparecia na abertura seguinte — e o painel, que não tinha o service worker registrado,
  // podia ficar com o visual antigo para sempre. Foi o que aconteceu: o painel veio novo pela
  // rede e o CSS veio velho do cache, misturando as duas versões na mesma tela.
  //
  // O custo é uma ida à rede por arquivo; como o servidor manda "no-cache" com ETag nesses
  // arquivos, a resposta costuma ser um 304 sem corpo.
  if (req.destination === 'style' || req.destination === 'script') {
    evento.respondWith((async () => {
      const cache = await caches.open(CASCA);
      try {
        const r = await fetch(req);
        if (r.ok && r.type === 'basic') cache.put(req, r.clone());
        return r;
      } catch {
        return (await cache.match(req)) ?? Response.error();
      }
    })());
    return;
  }

  // Fonte, ícone e o resto do app: cache primeiro, atualizando por trás. Esses mudam pouco,
  // e a troca de VERSAO já limpa o cache antigo quando mudam de verdade.
  evento.respondWith((async () => {
    const cache = await caches.open(CASCA);
    const guardado = await cache.match(req);
    const rede = fetch(req).then((r) => {
      if (r.ok && r.type === 'basic') cache.put(req, r.clone());
      return r;
    }).catch(() => guardado);
    return guardado ?? rede;
  })());
});

// A página avisa quando quer assumir a versão nova sem esperar o próximo start.
self.addEventListener('message', (evento) => {
  if (evento.data === 'assumir') self.skipWaiting();
});
