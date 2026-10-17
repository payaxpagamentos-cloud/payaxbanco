import { api } from './api.js';
import { el } from './ui.js';

/** Mapa Leaflet (global L, carregado de /vendor/leaflet) com a camada configurada no servidor. */
let publico = null;
export const configPublica = async () => (publico ??= await api.get('/publico'));

export async function criarMapa(div, { zoom = 14 } = {}) {
  const cfg = await configPublica();
  if (!window.L) {
    div.append(el('div', { class: 'mapa-indisponivel' }, 'Mapa indisponível. Use a busca de endereços.'));
    return null;
  }
  const mapa = window.L.map(div, { zoomControl: false, attributionControl: true }).setView(cfg.mapa.centro, zoom);
  window.L.tileLayer(cfg.mapa.tiles, { maxZoom: 19, attribution: cfg.mapa.atribuicao }).addTo(mapa);
  window.L.control.zoom({ position: 'topright' }).addTo(mapa);
  // O painel de baixo muda de altura conforme a tela: o mapa acompanha o tamanho do contêiner.
  new ResizeObserver(() => mapa.invalidateSize()).observe(div);
  return mapa;
}

const icone = (classe, texto = '') => window.L.divIcon({ className: '', html: `<div class="pin ${classe}">${texto}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] });
export const ICONES = {
  carro: () => icone('carro', '🚕'),
  ocupado: () => icone('carro ocupado', '🚕'),
  origem: () => icone('origem', 'A'),
  destino: () => icone('destino', 'B'),
  eu: () => window.L.divIcon({ className: '', html: '<div class="pin eu"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
};

/** Mantém um marcador por chave: cria, move ou remove conforme a lista atual. */
export function camada(mapa) {
  const marcadores = new Map();
  return {
    atualizar(itens) {
      if (!mapa) return;
      const vistos = new Set();
      for (const it of itens) {
        vistos.add(it.chave);
        const m = marcadores.get(it.chave);
        if (m) {
          m.setLatLng([it.lat, it.lng]);
          if (it.icone) m.setIcon(it.icone);
        } else {
          const novo = window.L.marker([it.lat, it.lng], { icon: it.icone, title: it.titulo ?? '' }).addTo(mapa);
          if (it.popup) novo.bindPopup(() => it.popup());
          marcadores.set(it.chave, novo);
        }
      }
      for (const [k, m] of marcadores) if (!vistos.has(k)) { m.remove(); marcadores.delete(k); }
    },
    limpar() { this.atualizar([]); },
    pontos: () => [...marcadores.values()].map((m) => m.getLatLng()),
  };
}

/** Ajusta o zoom para mostrar todos os pontos. */
export function enquadrar(mapa, pontos, zoomMax = 16) {
  if (!mapa || !pontos.length) return;
  if (pontos.length === 1) return mapa.setView(pontos[0], Math.min(zoomMax, Math.max(mapa.getZoom(), 15)));
  mapa.fitBounds(window.L.latLngBounds(pontos), { padding: [50, 50], maxZoom: zoomMax });
}

/** Posição atual do aparelho (rejeita se negada ou indisponível). */
export const minhaPosicao = () => new Promise((resolve, reject) => {
  if (!navigator.geolocation) return reject(new Error('Localização indisponível neste aparelho.'));
  navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
    () => reject(new Error('Não foi possível obter sua localização. Permita o acesso ou marque no mapa.')), { enableHighAccuracy: true, timeout: 10_000 });
});
