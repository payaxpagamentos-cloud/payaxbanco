/**
 * Mapa (Leaflet, global L carregado de vendor/leaflet). O fundo é vetorial e moderno (MapLibre, estilo configurado no servidor,
 * OpenFreeMap por padrão), com um estilo para cada tema; sem WebGL no navegador, volta para a camada de imagens.
 * As telas usam só esta interface: veículos girados pelo curso, trajetos, cercas e pontos.
 */
import { api, BASE, sessao, qs } from './api.js';
import { el, icone, placa as fmtPlaca } from './ui.js';

let publico = null;
export const configPublica = async () => (publico ??= await api.get('/publico'));

export const COR_SITUACAO = { movimento: '#16A34A', ligado: '#D97706', parado: '#2563EB', sem_sinal: '#DC2626', sem_posicao: '#9CA3AF', sem_rastreador: '#9CA3AF' };
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Ícone do veículo: um carro pequeno visto de cima, na cor da situação, com a frente apontando para o curso (o rumo da última
 * posição, também quando parado) e a placa embaixo. Bloqueado: um cadeado vermelho no canto.
 */
function htmlVeiculo(v, selecionado) {
  const cor = COR_SITUACAO[v.situacao] ?? '#7C8392';
  const curso = Number(v.curso) || 0;
  const carro = `<svg class="carro" viewBox="0 0 32 32" style="transform:rotate(${curso}deg)" aria-hidden="true">`
    + '<rect x="7.6" y="10" width="2.2" height="3.2" rx="1" fill="#0B1A2E" opacity=".55"/><rect x="22.2" y="10" width="2.2" height="3.2" rx="1" fill="#0B1A2E" opacity=".55"/>'
    + `<rect x="9" y="3" width="14" height="26" rx="6" fill="${cor}" stroke="#fff" stroke-width="1.6"/>`
    + '<path d="M11.3 10.6Q16 8.4 20.7 10.6L19.8 14Q16 12.9 12.2 14Z" fill="#0B1A2E" opacity=".72"/>'
    + '<path d="M12.3 22.4Q16 23.4 19.7 22.4L20.3 25Q16 26.4 11.7 25Z" fill="#0B1A2E" opacity=".62"/>'
    + '<rect x="12.2" y="14.6" width="7.6" height="7.4" rx="1.6" fill="#fff" opacity=".2"/>'
    + '<circle cx="12.4" cy="4.9" r="1.1" fill="#FFF6C9"/><circle cx="19.6" cy="4.9" r="1.1" fill="#FFF6C9"/>'
    + '</svg>';
  const trava = v.bloqueado ? '<span class="trava" title="Bloqueado"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' : '';
  return `<div class="veic s-${esc(v.situacao)}${selecionado ? ' sel' : ''}">${carro}${trava}<span class="rot">${esc(fmtPlaca(v.placa))}</span></div>`;
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

// O mapa de ruas é o padrão (reto e exato; a foto de satélite sai inclinada em bairros com prédios altos). O satélite fica no botão,
// e a escolha fica lembrada no navegador.
const CHAVE_CAMADA_VERSAO = 'rastreador.camada.v2';
const lerCamada = () => {
  try {
    // A escolha antiga (de quando o satélite era o padrão) não vale mais: começa no mapa de ruas.
    return localStorage.getItem(CHAVE_CAMADA_VERSAO) === 'satelite' ? 'satelite' : 'mapa';
  } catch {
    return 'mapa';
  }
};

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

/** Reserva sem WebGL: camadas de imagens (ruas da Esri; satélite com os nomes por cima). */
function fundoImagens(L, cfg) {
  const s = cfg.mapa.satelite;
  return {
    mapa: L.tileLayer(cfg.mapa.tiles, { maxZoom: 20, maxNativeZoom: 19, subdomains: 'abcd' }),
    // detectRetina: em telas de alta densidade usa a foto um nível mais detalhada (fica nítida em vez de esticada).
    satelite: s?.tiles ? L.layerGroup([L.tileLayer(s.tiles, { maxZoom: 20, maxNativeZoom: 19, detectRetina: true }),
      ...s.rotulos.map((u) => L.tileLayer(u, { maxZoom: 20, maxNativeZoom: 19, detectRetina: true }))]) : null,
  };
}

/**
 * Mapas do Google (com a chave no servidor): ruas e satélite com os nomes por cima, em alta resolução. O Google exige o logo e
 * os créditos da área visível, que são atualizados quando o mapa para de mexer.
 */
function fundoGoogle(L, m, g) {
  const url = (tipo) => `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(g.sessoes[tipo])}&key=${encodeURIComponent(g.chave)}`;
  const camadas = {
    mapa: L.tileLayer(url('mapa'), { maxZoom: 21, maxNativeZoom: 21 }),
    satelite: L.tileLayer(url('satelite'), { maxZoom: 21, maxNativeZoom: 20 }),
  };
  m.setMaxZoom(21);
  const Logo = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd() {
      const img = L.DomUtil.create('img', 'logo-google');
      Object.assign(img, { src: 'https://maps.gstatic.com/mapfiles/api-3/images/google_white5.png', alt: 'Google' });
      return img;
    },
  });
  new Logo().addTo(m);
  let atual = null;
  let creditos = 'Google';
  let timer = null;
  const atualizarCreditos = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const b = m.getBounds();
      const q = new URLSearchParams({ session: g.sessoes[atual], key: g.chave, zoom: String(Math.round(m.getZoom())),
        north: b.getNorth().toFixed(5), south: b.getSouth().toFixed(5), east: b.getEast().toFixed(5), west: b.getWest().toFixed(5) });
      try {
        const r = await (await fetch(`https://tile.googleapis.com/tile/v1/viewport?${q}`)).json();
        m.attributionControl.removeAttribution(creditos);
        // O texto do Google já traz o ©; só traduz os termos.
        creditos = r.copyright ? r.copyright.replace(/Map data/g, 'Dados do mapa').replace(/Imagery/g, 'Imagens') : 'Google';
        m.attributionControl.addAttribution(creditos);
      } catch { /* mantém os créditos anteriores */ }
    }, 400);
  };
  m.on('moveend', atualizarCreditos);
  return {
    camadas,
    mostrar(tipo) {
      if (atual) m.removeLayer(camadas[atual]);
      atual = tipo;
      camadas[atual].addTo(m);
      atualizarCreditos();
    },
  };
}

/** Carrega um script uma única vez. */
const scripts = new Map();
function carregarScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((ok, falha) => {
      const s = document.createElement('script');
      Object.assign(s, { src, async: true, onload: ok, onerror: () => falha(new Error(`Não carregou ${src}`)) });
      document.head.append(s);
    }));
  }
  return scripts.get(src);
}

// Se o Google recusar a chave (limite da demonstração, chave errada), a página volta ao mapa gratuito até fechar a aba.
const CHAVE_GOOGLE_FALHOU = 'rastreador.googleFalhou';
const googleFalhou = () => { try { return sessionStorage.getItem(CHAVE_GOOGLE_FALHOU) === '1'; } catch { return false; } };

/**
 * Google Maps direto no navegador (Maps JavaScript API, como a chave de demonstração): ruas e satélite com os nomes (híbrido),
 * desenhados pelo próprio Google dentro do Leaflet, com o logo e os créditos dele.
 */
async function fundoGoogleJs(L, m, chave) {
  window.gm_authFailure = () => {
    try { sessionStorage.setItem(CHAVE_GOOGLE_FALHOU, '1'); } catch { /* sem armazenamento */ }
    console.warn('Google Maps recusou a chave: usando o mapa gratuito.');
    location.reload();
  };
  const q = new URLSearchParams({ key: chave, v: 'weekly', language: 'pt-BR', region: 'BR', loading: 'async', callback: '__rastreadorGoogle' });
  const pronto = new Promise((ok, falha) => {
    window.__rastreadorGoogle = ok;
    setTimeout(() => falha(new Error('Google Maps não respondeu')), 12000);
  });
  await Promise.all([carregarScript(`https://maps.googleapis.com/maps/api/js?${q}`).then(() => pronto), carregarScript(`${BASE}/vendor/googlemutant.js`)]);
  m.setMaxZoom(21);
  const camadas = {
    mapa: L.gridLayer.googleMutant({ type: 'roadmap', maxZoom: 21 }),
    satelite: L.gridLayer.googleMutant({ type: 'hybrid', maxZoom: 21 }),
  };
  let atual = null;
  return {
    mostrar(tipo) {
      if (atual) m.removeLayer(camadas[atual]);
      atual = tipo;
      camadas[atual].addTo(m);
    },
  };
}

/** Fundo do mapa e o botão Mapa / Satélite. */
async function fundo(L, m, div, cfg) {
  if (!cfg.google && cfg.google_js && !googleFalhou()) {
    try {
      const g = await fundoGoogleJs(L, m, cfg.google_js);
      let atual = lerCamada();
      g.mostrar(atual);
      div.classList.toggle('mapa-satelite', atual === 'satelite');
      return seletorCamada(L, m, () => atual, (novo) => { atual = novo; g.mostrar(novo); div.classList.toggle('mapa-satelite', novo === 'satelite'); });
    } catch (e) {
      console.warn('Google Maps indisponível, usando o mapa gratuito:', e.message);
    }
  }
  if (cfg.google) {
    const g = fundoGoogle(L, m, cfg.google);
    let atual = lerCamada();
    g.mostrar(atual);
    div.classList.toggle('mapa-satelite', atual === 'satelite');
    return seletorCamada(L, m, () => atual, (novo) => { atual = novo; g.mostrar(novo); div.classList.toggle('mapa-satelite', novo === 'satelite'); });
  }
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
  seletorCamada(L, m, () => atual, (k) => {
    m.attributionControl.removeAttribution(creditos[atual]);
    trocar(k);
    m.attributionControl.addAttribution(creditos[atual]);
    div.classList.toggle('mapa-satelite', atual === 'satelite');
  });
}

/** Botão Satélite / Mapa no canto do mapa; a escolha fica lembrada no navegador. */
function seletorCamada(L, m, atual, trocar) {
  const Seletor = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const caixa = L.DomUtil.create('div', 'seletor-camada');
      L.DomEvent.disableClickPropagation(caixa);
      const botoes = ['mapa', 'satelite'].map((k) => {
        const b = L.DomUtil.create('button', k === atual() ? 'on' : '', caixa);
        b.type = 'button';
        b.textContent = k === 'mapa' ? 'Mapa' : 'Satélite';
        b.title = k === 'mapa' ? 'Mapa de ruas' : 'Imagem de satélite com os nomes de bairros, ruas e lugares';
        b.addEventListener('click', () => {
          if (k === atual()) return;
          trocar(k);
          for (const x of botoes) x.classList.toggle('on', x === b);
          try { localStorage.setItem(CHAVE_CAMADA_VERSAO, k); } catch { /* sem armazenamento: só nesta tela */ }
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
  telaCheia(L, m, div);
  L.control.zoom({ position: 'topright' }).addTo(m);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(m);
  new ResizeObserver(() => m.invalidateSize()).observe(div);
  const icone = (v, sel) => L.divIcon({ className: '', html: htmlVeiculo(v, sel), iconSize: [30, 30], iconAnchor: [15, 15] });

  return {
    L: m,
    aoClicar: (fn) => m.on('click', (e) => fn({ lat: e.latlng.lat, lng: e.latlng.lng })),
    centro: () => { const c = m.getCenter(); return { lat: c.lat, lng: c.lng }; },
    // Ao escolher um veículo, vai direto para o zoom de rua (17), sem afastar se já estiver mais perto.
    // `cobertoEmbaixo`: altura (px) coberta por um painel na parte de baixo; o ponto fica no meio do que sobra.
    ir: (lat, lng, z, { cobertoEmbaixo = 0 } = {}) => {
      m.setView([lat, lng], z ?? Math.max(m.getZoom(), 17), { animate: false });
      if (cobertoEmbaixo) m.panBy([0, cobertoEmbaixo / 2], { animate: false });
    },
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

/**
 * Botão de tela cheia: o mapa (com a busca, o botão Satélite / Mapa e a faixa do veículo) ocupa a tela inteira, para analisar os
 * arredores. Esc ou o mesmo botão voltam. Onde o navegador não deixa (iPhone), o mapa cobre a página.
 */
function telaCheia(L, m, div) {
  const alvo = div.closest('.area-mapa') || div.parentElement;
  const Cheia = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const caixa = L.DomUtil.create('div', 'leaflet-bar botao-tela-cheia');
      const b = L.DomUtil.create('a', '', caixa);
      Object.assign(b, { href: '#', role: 'button' });
      const desenhar = () => {
        const cheia = document.fullscreenElement === alvo || alvo.classList.contains('mapa-cheio');
        b.replaceChildren(icone(cheia ? 'reduzir' : 'expandir'));
        b.title = cheia ? 'Sair da tela cheia (Esc)' : 'Abrir o mapa em tela cheia';
        b.setAttribute('aria-label', b.title);
      };
      L.DomEvent.on(b, 'click', (e) => {
        L.DomEvent.preventDefault(e);
        L.DomEvent.stopPropagation(e);
        if (document.fullscreenElement === alvo) document.exitFullscreen();
        else if (alvo.classList.contains('mapa-cheio')) alvo.classList.remove('mapa-cheio');
        else if (alvo.requestFullscreen) alvo.requestFullscreen().catch(() => alvo.classList.add('mapa-cheio'));
        else alvo.classList.add('mapa-cheio');
        setTimeout(() => { m.invalidateSize(); desenhar(); }, 150);
      });
      document.addEventListener('fullscreenchange', () => { m.invalidateSize(); desenhar(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && alvo.classList.contains('mapa-cheio')) { alvo.classList.remove('mapa-cheio'); m.invalidateSize(); desenhar(); } });
      desenhar();
      return caixa;
    },
  });
  new Cheia().addTo(m);
}

/** Links para o próprio Google Maps (gratuitos, sem chave): o ponto, o Street View e a rota até lá. */
export const linkGoogle = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
export const linkStreetView = (lat, lng) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;
export const linkRota = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
