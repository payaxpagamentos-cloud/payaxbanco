/**
 * Mapa (Leaflet, global L carregado de vendor/leaflet) com a camada configurada no servidor (OpenStreetMap por padrão).
 * As telas usam só esta interface: veículos girados pelo curso, trajetos, cercas e pontos.
 */
import { api } from './api.js';
import { el, placa as fmtPlaca } from './ui.js';

let publico = null;
export const configPublica = async () => (publico ??= await api.get('/publico'));

export const COR_SITUACAO = { movimento: '#16A34A', ligado: '#D97706', parado: '#2563EB', sem_sinal: '#DC2626', sem_posicao: '#9CA3AF', sem_rastreador: '#9CA3AF' };
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Ícone do veículo: seta no sentido do curso (ou círculo, parado) na cor da situação, com a placa embaixo. */
function htmlVeiculo(v, selecionado) {
  const cor = COR_SITUACAO[v.situacao] ?? '#7C8392';
  const andando = v.situacao === 'movimento';
  const forma = andando
    ? `<svg viewBox="0 0 24 24" style="transform:rotate(${Number(v.curso) || 0}deg)"><path d="M12 2 20 21 12 16.5 4 21z" fill="${cor}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`
    : `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="${cor}" stroke="#fff" stroke-width="2.4"/>${v.bloqueado ? '<path d="M9 12h6" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>' : ''}</svg>`;
  return `<div class="veic${selecionado ? ' sel' : ''}">${forma}<span class="rot">${esc(fmtPlaca(v.placa))}</span></div>`;
}

export async function criarMapa(div, { zoom = 12 } = {}) {
  const cfg = await configPublica();
  if (!window.L) {
    div.append(el('div', { class: 'mapa-indisponivel' }, 'Mapa indisponível.'));
    return null;
  }
  const L = window.L;
  const m = L.map(div, { zoomControl: false, attributionControl: true }).setView(cfg.mapa.centro, zoom);
  L.tileLayer(cfg.mapa.tiles, { maxZoom: 19, attribution: cfg.mapa.atribuicao }).addTo(m);
  L.control.zoom({ position: 'topright' }).addTo(m);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(m);
  new ResizeObserver(() => m.invalidateSize()).observe(div);
  const icone = (v, sel) => L.divIcon({ className: '', html: htmlVeiculo(v, sel), iconSize: [30, 30], iconAnchor: [15, 15] });

  return {
    L: m,
    aoClicar: (fn) => m.on('click', (e) => fn({ lat: e.latlng.lat, lng: e.latlng.lng })),
    centro: () => { const c = m.getCenter(); return { lat: c.lat, lng: c.lng }; },
    ir: (lat, lng, z) => m.setView([lat, lng], z ?? Math.max(m.getZoom(), 15)),
    enquadrar(pontos, zoomMax = 16) {
      const p = pontos.filter((x) => x && Number.isFinite(x[0]) && Number.isFinite(x[1]));
      if (p.length === 1) m.setView(p[0], zoomMax);
      else if (p.length) m.fitBounds(L.latLngBounds(p), { padding: [40, 40], maxZoom: zoomMax });
    },
    /** Marcador de veículo; atualizar(v) move e redesenha (situação, curso, placa). */
    veiculo(v, { aoClicar } = {}) {
      let sel = false;
      let atual = v;
      const mk = L.marker([v.lat, v.lng], { icon: icone(v, sel), title: fmtPlaca(v.placa), zIndexOffset: 100 }).addTo(m);
      if (aoClicar) mk.on('click', () => aoClicar(atual));
      return {
        atualizar(novo) { atual = novo; mk.setLatLng([novo.lat, novo.lng]); mk.setIcon(icone(novo, sel)); },
        selecionar(s) { sel = s; mk.setIcon(icone(atual, sel)); mk.setZIndexOffset(s ? 1000 : 100); },
        remover: () => mk.remove(),
      };
    },
    /** Trajeto: linha (com uma cor por trecho de velocidade, se `cores` vier) e a camada para remover. */
    linha(pontos, { cor = '#2563EB', peso = 5 } = {}) {
      const pl = L.polyline(pontos, { color: cor, weight: peso, opacity: 0.9 }).addTo(m);
      return { remover: () => pl.remove(), definir: (p) => pl.setLatLngs(p) };
    },
    /** Ponto simples (início, fim, parada, alerta) com texto ao passar o mouse e conteúdo ao clicar. */
    ponto(lat, lng, { classe = '', texto = '', titulo = '', popup } = {}) {
      const mk = L.marker([lat, lng], { icon: L.divIcon({ className: '', html: `<div class="pino ${classe}">${esc(texto)}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
        title: titulo }).addTo(m);
      if (popup) mk.bindPopup(() => popup());
      return { remover: () => mk.remove(), mover: (a, b) => mk.setLatLng([a, b]) };
    },
    /** Cerca: círculo (lat, lng, raio_m) ou polígono (pontos). */
    cerca(c, { aoClicar } = {}) {
      const estilo = { color: c.cor || '#2563EB', weight: 2, fillOpacity: 0.08 };
      const camada = c.tipo === 'circulo' ? L.circle([c.lat, c.lng], { radius: c.raio_m, ...estilo }) : L.polygon(c.pontos, estilo);
      camada.addTo(m).bindTooltip(c.nome ?? '', { sticky: true });
      if (aoClicar) camada.on('click', () => aoClicar(c));
      return { remover: () => camada.remove(), limites: () => camada.getBounds() };
    },
    remover: () => m.remove(),
  };
}

/** Link para abrir o ponto no Google Maps (rota até o veículo pelo celular). */
export const linkGoogle = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
