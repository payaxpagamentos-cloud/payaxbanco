/**
 * Mapa (Leaflet, global L carregado de vendor/leaflet). O fundo é vetorial e moderno (MapLibre, estilo configurado no servidor,
 * OpenFreeMap por padrão), com um estilo para cada tema; sem WebGL no navegador, volta para a camada de imagens.
 * As telas usam só esta interface: veículos girados pelo curso, trajetos, cercas e pontos.
 */
import { api, BASE } from './api.js';
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

/** Carrega o MapLibre (módulo) e a ponte com o Leaflet, uma única vez. */
let vetorial = null;
function carregarVetorial() {
  vetorial ??= (async () => {
    const tela = document.createElement('canvas');
    if (!(tela.getContext('webgl2') || tela.getContext('webgl'))) throw new Error('Sem WebGL');
    document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `${BASE}/vendor/maplibre/maplibre-gl.css` }));
    window.maplibregl = await import(`${BASE}/vendor/maplibre/maplibre-gl.mjs`);
    await new Promise((ok, falha) => document.head.append(Object.assign(document.createElement('script'), { src: `${BASE}/vendor/maplibre-leaflet.js`, onload: ok, onerror: falha })));
  })();
  return vetorial;
}
const temaEscuro = () => document.documentElement.dataset.tema === 'escuro';

/** Camada do mapa de ruas: vetorial (troca de estilo junto com o tema) ou, se não der, a camada de imagens. */
async function camadaRuas(L, div, cfg) {
  if (cfg.mapa.estilo) {
    try {
      await carregarVetorial();
      const estilo = () => (temaEscuro() ? cfg.mapa.estilo_escuro : cfg.mapa.estilo);
      // Os créditos do rodapé são controlados aqui (trocam com a camada); o MapLibre não põe os dele.
      const camada = L.maplibreGL({ style: estilo(), attributionControl: false });
      let atual = estilo();
      new MutationObserver(() => {
        if (estilo() !== atual && camada.getMaplibreMap()) { atual = estilo(); camada.getMaplibreMap().setStyle(atual); }
      }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-tema'] });
      return camada;
    } catch { /* sem WebGL ou sem acesso ao estilo: usa as imagens */ }
  }
  div.classList.add('mapa-raster');
  return L.tileLayer(cfg.mapa.tiles, { maxZoom: 20, maxNativeZoom: 19, subdomains: 'abcd' });
}

/** Satélite: a imagem e, por cima, os nomes de ruas e lugares (como o modo híbrido dos aplicativos de mapa). */
function camadaSatelite(L, cfg) {
  const s = cfg.mapa.satelite;
  return L.layerGroup([
    L.tileLayer(s.tiles, { maxZoom: 20, maxNativeZoom: 19 }),
    ...s.rotulos.map((u) => L.tileLayer(u, { maxZoom: 20, maxNativeZoom: 19 })),
  ]);
}

const CHAVE_CAMADA = 'rastreador.camada';
const lerCamada = () => { try { return localStorage.getItem(CHAVE_CAMADA) === 'satelite' ? 'satelite' : 'mapa'; } catch { return 'mapa'; } };

/** Fundo do mapa e o botão Mapa / Satélite (a escolha fica lembrada neste navegador). */
async function fundo(L, m, div, cfg) {
  const camadas = { mapa: await camadaRuas(L, div, cfg), satelite: cfg.mapa.satelite?.tiles ? camadaSatelite(L, cfg) : null };
  // Créditos de cada fundo no rodapé (trocados junto com a camada).
  const creditos = { mapa: div.classList.contains('mapa-raster') ? cfg.mapa.atribuicao : cfg.mapa.atribuicao_vetorial, satelite: cfg.mapa.satelite?.atribuicao };
  let atual = camadas.satelite ? lerCamada() : 'mapa';
  camadas[atual].addTo(m);
  m.attributionControl.addAttribution(creditos[atual]);
  div.classList.toggle('mapa-satelite', atual === 'satelite');
  if (!camadas.satelite) return;
  const Seletor = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const caixa = L.DomUtil.create('div', 'seletor-camada');
      L.DomEvent.disableClickPropagation(caixa);
      const botoes = ['mapa', 'satelite'].map((k) => {
        const b = L.DomUtil.create('button', k === atual ? 'on' : '', caixa);
        b.type = 'button';
        b.textContent = k === 'mapa' ? 'Mapa' : 'Satélite';
        b.title = k === 'mapa' ? 'Mapa de ruas' : 'Imagem de satélite com os nomes das ruas';
        b.addEventListener('click', () => {
          if (k === atual) return;
          m.removeLayer(camadas[atual]);
          m.attributionControl.removeAttribution(creditos[atual]);
          atual = k;
          camadas[atual].addTo(m);
          m.attributionControl.addAttribution(creditos[atual]);
          div.classList.toggle('mapa-satelite', atual === 'satelite');
          for (const x of botoes) x.classList.toggle('on', x === b);
          try { localStorage.setItem(CHAVE_CAMADA, atual); } catch { /* sem armazenamento: só nesta tela */ }
        });
        return b;
      });
      return caixa;
    },
  });
  new Seletor().addTo(m);
}

export async function criarMapa(div, { zoom = 12 } = {}) {
  const cfg = await configPublica();
  if (!window.L) {
    div.append(el('div', { class: 'mapa-indisponivel' }, 'Mapa indisponível.'));
    return null;
  }
  const L = window.L;
  // Até o zoom 20 (rua e quarteirão); a roda do mouse anda de meio em meio nível para aproximar com mais precisão.
  const m = L.map(div, { zoomControl: false, attributionControl: true, maxZoom: 20, zoomSnap: 0.5, wheelPxPerZoomLevel: 90 }).setView(cfg.mapa.centro, zoom);
  // Rodapé só com os créditos do mapa (sem o prefixo padrão do Leaflet, que traz uma bandeira).
  m.attributionControl.setPrefix(false);
  await fundo(L, m, div, cfg);
  L.control.zoom({ position: 'topright' }).addTo(m);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(m);
  new ResizeObserver(() => m.invalidateSize()).observe(div);
  const icone = (v, sel) => L.divIcon({ className: '', html: htmlVeiculo(v, sel), iconSize: [30, 30], iconAnchor: [15, 15] });

  return {
    L: m,
    aoClicar: (fn) => m.on('click', (e) => fn({ lat: e.latlng.lat, lng: e.latlng.lng })),
    centro: () => { const c = m.getCenter(); return { lat: c.lat, lng: c.lng }; },
    // Ao escolher um veículo, vai direto para o zoom de rua (17), sem afastar se já estiver mais perto.
    ir: (lat, lng, z) => m.setView([lat, lng], z ?? Math.max(m.getZoom(), 17)),
    enquadrar(pontos, zoomMax = 17) {
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
