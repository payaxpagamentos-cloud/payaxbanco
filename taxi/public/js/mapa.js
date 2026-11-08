import { api } from './api.js';
import { el } from './ui.js';

/**
 * Mapa das três páginas, com o provedor configurado no servidor:
 * - 'google': Google Maps (API JavaScript, com a chave da plataforma);
 * - 'osm': OpenStreetMap pelo Leaflet (global L, carregado de /vendor/leaflet).
 * As páginas usam só esta interface: on('click', fn), aoArrastar(fn), setView([lat, lng], zoom), getCenter(), linha(pontos)
 * e as funções camada() e enquadrar().
 */
let publico = null;
export const configPublica = async () => (publico ??= await api.get('/publico'));

/** Marcadores: descrição comum aos dois provedores (classe CSS do .pin e texto). */
export const ICONES = {
  carro: () => ({ classe: 'carro', texto: '🚕', tamanho: 34 }),
  ocupado: () => ({ classe: 'carro ocupado', texto: '🚕', tamanho: 34 }),
  origem: () => ({ classe: 'origem', texto: 'A', tamanho: 34 }),
  destino: () => ({ classe: 'destino', texto: 'B', tamanho: 34 }),
  eu: () => ({ classe: 'eu', texto: '', tamanho: 18 }),
};
const COR_ROTA = '#1C5FD4';
const pinoHtml = (i) => `<div class="pin ${i.classe}">${i.texto}</div>`;

export async function criarMapa(div, { zoom = 14 } = {}) {
  const cfg = await configPublica();
  try {
    return cfg.mapa.provedor === 'google' ? await mapaGoogle(div, cfg.mapa, zoom) : mapaLeaflet(div, cfg.mapa, zoom);
  } catch {
    div.append(el('div', { class: 'mapa-indisponivel' }, 'Mapa indisponível. Use a busca de endereços.'));
    return null;
  }
}

function mapaLeaflet(div, cfg, zoom) {
  if (!window.L) throw new Error('Leaflet indisponível');
  const L = window.L;
  const m = L.map(div, { zoomControl: false, attributionControl: true }).setView(cfg.centro, zoom);
  L.tileLayer(cfg.tiles, { maxZoom: 19, attribution: cfg.atribuicao }).addTo(m);
  L.control.zoom({ position: 'topright' }).addTo(m);
  // O painel de baixo muda de altura conforme a tela: o mapa acompanha o tamanho do contêiner.
  new ResizeObserver(() => m.invalidateSize()).observe(div);
  const icone = (i) => L.divIcon({ className: '', html: pinoHtml(i), iconSize: [i.tamanho, i.tamanho], iconAnchor: [i.tamanho / 2, i.tamanho / 2] });
  return {
    on: (evento, fn) => m.on(evento, (e) => fn({ latlng: { lat: e.latlng.lat, lng: e.latlng.lng } })),
    aoArrastar: (fn) => m.on('dragstart', fn),
    setView: (p, z) => m.setView(p, z),
    linha(pontos) {
      const pl = L.polyline(pontos, { color: COR_ROTA, weight: 7, opacity: 0.9 }).addTo(m);
      return { definir: (p) => pl.setLatLngs(p), remover: () => pl.remove() };
    },
    getCenter: () => { const c = m.getCenter(); return { lat: c.lat, lng: c.lng }; },
    getZoom: () => m.getZoom(),
    enquadrar: (pontos, zoomMax) => m.fitBounds(L.latLngBounds(pontos), { padding: [50, 50], maxZoom: zoomMax }),
    marcador(it) {
      const mk = L.marker([it.lat, it.lng], { icon: icone(it.icone), title: it.titulo ?? '' }).addTo(m);
      if (it.popup) mk.bindPopup(() => it.popup());
      return {
        mover: (lat, lng, ic) => { mk.setLatLng([lat, lng]); if (ic) mk.setIcon(icone(ic)); },
        remover: () => mk.remove(),
        posicao: () => [mk.getLatLng().lat, mk.getLatLng().lng],
      };
    },
  };
}

/** Carrega a API JavaScript do Google Maps uma única vez. */
let googleCarregando = null;
function carregarGoogle(chave) {
  googleCarregando ??= new Promise((resolve, reject) => {
    const nome = `__taxiGoogle${Date.now()}`;
    window[nome] = () => resolve(window.google);
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(chave)}&v=weekly&loading=async&libraries=marker&language=pt-BR&region=BR&callback=${nome}`;
    s.async = true;
    s.onerror = () => reject(new Error('Google Maps indisponível'));
    document.head.append(s);
  });
  return googleCarregando;
}

async function mapaGoogle(div, cfg, zoom) {
  const g = await carregarGoogle(cfg.google_chave);
  const { Map, InfoWindow } = await g.maps.importLibrary('maps');
  const { AdvancedMarkerElement } = await g.maps.importLibrary('marker');
  const m = new Map(div, {
    center: { lat: cfg.centro[0], lng: cfg.centro[1] }, zoom, mapId: cfg.google_map_id,
    disableDefaultUI: true, zoomControl: true, clickableIcons: false, gestureHandling: 'greedy',
  });
  let janela = null;
  const conteudo = (i) => { const d = document.createElement('div'); d.innerHTML = pinoHtml(i); d.style.transform = 'translateY(50%)'; return d; };
  return {
    on: (evento, fn) => m.addListener(evento, (e) => fn({ latlng: { lat: e.latLng.lat(), lng: e.latLng.lng() } })),
    aoArrastar: (fn) => m.addListener('dragstart', fn),
    setView: (p, z) => { m.setCenter({ lat: p[0], lng: p[1] }); if (z) m.setZoom(z); },
    linha(pontos) {
      const caminho = (p) => p.map(([lat, lng]) => ({ lat, lng }));
      const pl = new g.maps.Polyline({ path: caminho(pontos), map: m, strokeColor: COR_ROTA, strokeWeight: 7, strokeOpacity: 0.9 });
      return { definir: (p) => pl.setPath(caminho(p)), remover: () => pl.setMap(null) };
    },
    getCenter: () => { const c = m.getCenter(); return { lat: c.lat(), lng: c.lng() }; },
    getZoom: () => m.getZoom(),
    enquadrar(pontos, zoomMax) {
      const b = new g.maps.LatLngBounds();
      for (const [lat, lng] of pontos) b.extend({ lat, lng });
      m.fitBounds(b, 50);
      g.maps.event.addListenerOnce(m, 'idle', () => { if (m.getZoom() > zoomMax) m.setZoom(zoomMax); });
    },
    marcador(it) {
      const mk = new AdvancedMarkerElement({ map: m, position: { lat: it.lat, lng: it.lng }, content: conteudo(it.icone), title: it.titulo ?? '' });
      if (it.popup) {
        mk.addListener('click', () => {
          janela?.close();
          janela = new InfoWindow({ content: it.popup() });
          janela.open({ map: m, anchor: mk });
        });
      }
      return {
        mover: (lat, lng, ic) => { mk.position = { lat, lng }; if (ic) mk.content = conteudo(ic); },
        remover: () => { mk.map = null; },
        posicao: () => [mk.position.lat, mk.position.lng],
      };
    },
  };
}

/** Mantém um marcador por chave: cria, move ou remove conforme a lista atual. */
export function camada(mapa) {
  const marcadores = new Map();
  return {
    atualizar(itens) {
      if (!mapa) return;
      const vistos = new Set();
      for (const it of itens) {
        vistos.add(it.chave);
        const mk = marcadores.get(it.chave);
        if (mk) mk.mover(it.lat, it.lng, it.icone);
        else marcadores.set(it.chave, mapa.marcador(it));
      }
      for (const [k, mk] of marcadores) if (!vistos.has(k)) { mk.remover(); marcadores.delete(k); }
    },
    limpar() { this.atualizar([]); },
    pontos: () => [...marcadores.values()].map((mk) => mk.posicao()),
  };
}

/** Ajusta o zoom para mostrar todos os pontos ([lat, lng]). */
export function enquadrar(mapa, pontos, zoomMax = 16) {
  if (!mapa || !pontos.length) return;
  if (pontos.length === 1) return mapa.setView(pontos[0], Math.min(zoomMax, Math.max(mapa.getZoom(), 15)));
  mapa.enquadrar(pontos, zoomMax);
}

/** Posição atual do aparelho (rejeita se negada ou indisponível). */
export const minhaPosicao = () => new Promise((resolve, reject) => {
  if (!navigator.geolocation) return reject(new Error('Localização indisponível neste aparelho.'));
  navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
    () => reject(new Error('Não foi possível obter sua localização. Permita o acesso ou marque no mapa.')), { enableHighAccuracy: true, timeout: 10_000 });
});
