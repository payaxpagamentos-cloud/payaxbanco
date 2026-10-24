/**
 * Mapa (Leaflet, global L carregado de vendor/leaflet). O fundo é vetorial e moderno (MapLibre, estilo configurado no servidor,
 * OpenFreeMap por padrão), com um estilo para cada tema; sem WebGL no navegador, volta para a camada de imagens.
 * As telas usam só esta interface: veículos girados pelo curso, trajetos, cercas e pontos.
 */
import { api, BASE, sessao, qs } from './api.js';
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

/** Estilos vetoriais (JSON) carregados uma vez por página. */
const estilos = new Map();
const lerEstilo = (url) => {
  if (!estilos.has(url)) estilos.set(url, fetch(url).then((r) => { if (!r.ok) throw new Error(`Estilo ${r.status}`); return r.json(); }));
  return estilos.get(url);
};

const CHAVE_CAMADA = 'rastreador.camada';
// Satélite é o padrão (como o modo satélite dos aplicativos de mapa); a escolha fica lembrada no navegador.
const lerCamada = () => { try { return localStorage.getItem(CHAVE_CAMADA) === 'mapa' ? 'mapa' : 'satelite'; } catch { return 'satelite'; } };

/**
 * Fundo vetorial: um só mapa (MapLibre) que troca de estilo entre Mapa (claro moderno ou escuro, pelo tema) e Satélite híbrido.
 * Devolve null se o navegador não tiver WebGL ou o estilo não carregar.
 */
async function fundoVetorial(L, cfg) {
  if (!cfg.mapa.estilo) return null;
  try {
    await carregarVetorial();
    const [claro, escuro] = await Promise.all([lerEstilo(cfg.mapa.estilo), lerEstilo(cfg.mapa.estilo_escuro)]);
    const { modernizar, hibrido } = await import('./estilo-mapa.js');
    const mapaClaro = cfg.mapa.estilo_padrao ? modernizar(claro) : claro;
    const satelite = cfg.mapa.satelite?.tiles ? hibrido(claro, cfg.mapa.satelite) : null;
    const estilo = (modo) => (modo === 'satelite' && satelite ? satelite : temaEscuro() ? escuro : mapaClaro);
    return { estilo, temSatelite: Boolean(satelite), criar: (modo) => L.maplibreGL({ style: estilo(modo), attributionControl: false }) };
  } catch {
    return null;
  }
}

/** Reserva sem WebGL: camadas de imagens (ruas do CARTO; satélite com os nomes por cima). */
function fundoImagens(L, cfg) {
  const s = cfg.mapa.satelite;
  return {
    mapa: L.tileLayer(cfg.mapa.tiles, { maxZoom: 20, maxNativeZoom: 19, subdomains: 'abcd' }),
    satelite: s?.tiles ? L.layerGroup([L.tileLayer(s.tiles, { maxZoom: 20, maxNativeZoom: 19 }), ...s.rotulos.map((u) => L.tileLayer(u, { maxZoom: 20, maxNativeZoom: 19 }))]) : null,
  };
}

/** Fundo do mapa e o botão Mapa / Satélite. */
async function fundo(L, m, div, cfg) {
  const vetor = await fundoVetorial(L, cfg);
  const temSatelite = vetor ? vetor.temSatelite : Boolean(cfg.mapa.satelite?.tiles);
  let atual = temSatelite ? lerCamada() : 'mapa';
  const creditos = { mapa: vetor ? cfg.mapa.atribuicao_vetorial : cfg.mapa.atribuicao, satelite: [cfg.mapa.satelite?.atribuicao, vetor ? cfg.mapa.atribuicao_vetorial : null].filter(Boolean).join(' · ') };
  let trocar;
  if (vetor) {
    const camada = vetor.criar(atual).addTo(m);
    const aplicar = () => camada.getMaplibreMap()?.setStyle(vetor.estilo(atual));
    trocar = (novo) => { atual = novo; aplicar(); };
    // No modo Mapa, o estilo acompanha o tema (claro ou escuro).
    new MutationObserver(() => { if (atual === 'mapa') aplicar(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-tema'] });
  } else {
    div.classList.add('mapa-raster');
    const camadas = fundoImagens(L, cfg);
    camadas[atual].addTo(m);
    trocar = (novo) => { m.removeLayer(camadas[atual]); atual = novo; camadas[atual].addTo(m); };
  }
  m.attributionControl.addAttribution(creditos[atual]);
  div.classList.toggle('mapa-satelite', atual === 'satelite');
  if (!temSatelite) return;
  const Seletor = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const caixa = L.DomUtil.create('div', 'seletor-camada');
      L.DomEvent.disableClickPropagation(caixa);
      const botoes = ['satelite', 'mapa'].map((k) => {
        const b = L.DomUtil.create('button', k === atual ? 'on' : '', caixa);
        b.type = 'button';
        b.textContent = k === 'mapa' ? 'Mapa' : 'Satélite';
        b.title = k === 'mapa' ? 'Mapa de ruas' : 'Imagem de satélite com os nomes de bairros, ruas e lugares';
        b.addEventListener('click', () => {
          if (k === atual) return;
          m.attributionControl.removeAttribution(creditos[atual]);
          trocar(k);
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

/** Endereço de um ponto (painel do veículo), guardado por ~10 m para não perguntar de novo a cada atualização. */
const enderecos = new Map();
export function enderecoDe(lat, lng) {
  const chave = `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;
  if (!enderecos.has(chave)) enderecos.set(chave, api.get(`/geo/endereco${qs({ lat, lng })}`).catch(() => { enderecos.delete(chave); return null; }));
  return enderecos.get(chave);
}

/**
 * Campo de busca de endereços no mapa (rua e número, bairro, cidade ou nome de um lugar): leva o mapa até o resultado
 * e marca o ponto. Só para quem está logado.
 */
function campoBusca(L, m) {
  let marca = null;
  let timer = null;
  let ultima = '';
  const Busca = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const caixa = L.DomUtil.create('div', 'busca-mapa');
      L.DomEvent.disableClickPropagation(caixa);
      L.DomEvent.disableScrollPropagation(caixa);
      const campo = L.DomUtil.create('input', '', caixa);
      Object.assign(campo, { type: 'search', placeholder: 'Buscar endereço ou lugar', autocomplete: 'off' });
      campo.setAttribute('aria-label', 'Buscar endereço ou lugar no mapa');
      const lista = L.DomUtil.create('div', 'resultados oculto', caixa);
      const fechar = () => lista.classList.add('oculto');
      const ir = (r) => {
        fechar();
        campo.value = r.nome;
        marca?.remove();
        marca = L.marker([r.lat, r.lng], { icon: L.divIcon({ className: '', html: '<div class="pino-busca"></div>', iconSize: [26, 34], iconAnchor: [13, 32] }) })
          .addTo(m).bindPopup(() => el('div', {}, el('strong', {}, r.nome), r.endereco ? el('div', {}, r.endereco) : null, r.cep ? el('div', { class: 'pequeno' }, `CEP ${r.cep}`) : null,
            el('a', { href: linkGoogle(r.lat, r.lng), target: '_blank', rel: 'noopener', class: 'pequeno' }, 'Abrir no Google Maps'))).openPopup();
        m.setView([r.lat, r.lng], 18);
      };
      const mostrar = (rs) => {
        lista.replaceChildren(...(rs.length ? rs.map((r) => {
          const b = el('button', { type: 'button' }, el('strong', {}, r.nome), r.endereco ? el('span', {}, r.endereco) : null);
          b.addEventListener('click', () => ir(r));
          return b;
        }) : [el('div', { class: 'vazio' }, 'Nenhum endereço encontrado.')]));
        lista.classList.remove('oculto');
      };
      const procurar = async () => {
        const q = campo.value.trim();
        if (q.length < 3) return fechar();
        if (q === ultima) return lista.classList.remove('oculto');
        ultima = q;
        const c = m.getCenter();
        try {
          const rs = await api.get(`/geo/buscar${qs({ q, lat: c.lat.toFixed(4), lng: c.lng.toFixed(4) })}`);
          if (campo.value.trim() === q) mostrar(rs);
        } catch (err) {
          lista.replaceChildren(el('div', { class: 'vazio' }, err.message));
          lista.classList.remove('oculto');
        }
      };
      campo.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(procurar, 450); });
      campo.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); ultima = ''; procurar().then(() => lista.querySelector('button')?.click()); }
        if (e.key === 'Escape') { fechar(); campo.value = ''; ultima = ''; marca?.remove(); marca = null; }
      });
      campo.addEventListener('focus', () => { if (lista.children.length && campo.value.trim().length >= 3) lista.classList.remove('oculto'); });
      m.on('click', fechar);
      return caixa;
    },
  });
  new Busca().addTo(m);
}

export async function criarMapa(div, { zoom = 12, busca = true } = {}) {
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
  if (busca && cfg.busca && sessao.get()?.token) campoBusca(L, m);
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
