/* global L */
/** Mapa geográfico (Leaflet) com os ativos da rede, as ligações do banco e os veículos. Sem pontos inventados. */
import { api } from './api.js';
import { el, rotulo, dataHora, desde, placa } from './ui.js';

let config = null;
async function configMapa() {
  config ??= (await api.get('/publico')).mapa;
  return config;
}

// Leaflet 1.9: o fim de uma transição de zoom pode chegar depois de o mapa ser removido (troca de tela no meio da animação).
if (typeof L !== 'undefined' && !L.Map.prototype._protegidoNetwork) {
  const fim = L.Map.prototype._onZoomTransitionEnd;
  L.Map.prototype._onZoomTransitionEnd = function protegido(...a) { if (this._mapPane && this._container?.isConnected !== false && this._loaded) fim.apply(this, a); };
  L.Map.prototype._protegidoNetwork = true;
}

const COR_STATUS = { operacional: '#19724e', atencao: '#d58b3a', indisponivel: '#cf5b55', nao_avaliado: '#9aa691' };

/*
 * A casinha do assinante. A cor diz o que fazer, não só o que é:
 *
 *   verde      no ar, nada a fazer
 *   vermelho   contrato ativo e SEM sessão: é defeito, é agora
 *   âmbar      cortado por inadimplência: estar fora do ar é o esperado, não chame técnico
 *   roxo       login não existe no concentrador: falta provisionar, não é queda
 *   azul       em implantação: ainda não deveria estar no ar
 *   cinza      o sistema não sabe (nunca leu, ou a leitura envelheceu)
 *
 * O IXC pinta de vermelho o cortado e o caído do mesmo jeito. São problemas opostos, e a equipe perde a
 * manhã atrás de um defeito que é só a cobrança funcionando.
 */
const SVG_CASA = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M12 3 2.5 11h2.7v9h5.3v-5.6h3v5.6h5.3v-9h2.7z"/></svg>';
const SVG_ALERTA = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M12 2 1 21h22zm0 6 7 12H5zm-1 4v4h2v-4zm0 5v2h2v-2z"/></svg>';

/**
 * Cria o mapa em `alvo`. Devolve { mapa, mostrarRede(dados, aoAbrir), mostrarFrota(veiculos, aoAbrir), destruir() }.
 * Se o Leaflet não carregar (sem rede para as imagens), mostra o aviso e a lista continua funcionando.
 */
export async function criarMapa(alvo) {
  const cfg = await configMapa();
  if (typeof L === 'undefined') {
    alvo.replaceChildren(el('div', { class: 'vazio' }, el('strong', {}, 'Mapa indisponível'), 'Use a lista abaixo do mapa.'));
    return { mostrarRede() {}, mostrarFrota() {}, focar() {}, destruir() {} };
  }
  const reduzir = window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('sem-efeitos');
  const mapa = L.map(alvo, { zoomControl: true, attributionControl: true, scrollWheelZoom: false, zoomAnimation: !reduzir, markerZoomAnimation: !reduzir, fadeAnimation: !reduzir })
    .setView(cfg.centro, 13);
  L.tileLayer(cfg.tiles, { maxZoom: 19, attribution: cfg.atribuicao }).addTo(mapa);
  mapa.on('focus', () => mapa.scrollWheelZoom.enable());
  mapa.on('blur', () => mapa.scrollWheelZoom.disable());
  const camadaLinhas = L.layerGroup().addTo(mapa);
  const grupo = L.markerClusterGroup ? L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 40 }) : L.layerGroup();
  grupo.addTo(mapa);
  const marcadores = new Map();
  let vivo = true;

  const enquadrar = (pontos) => {
    if (pontos.length === 1) mapa.setView(pontos[0], 16);
    else if (pontos.length > 1) mapa.fitBounds(L.latLngBounds(pontos), { padding: [30, 30], maxZoom: 16 });
  };
  const limpar = () => { grupo.clearLayers(); camadaLinhas.clearLayers(); marcadores.clear(); };

  return {
    mapa,
    mostrarRede({ ativos, ligacoes }, aoAbrir) {
      if (!vivo) return;
      limpar();
      for (const l of ligacoes) {
        L.polyline([[l.origem_lat, l.origem_lng], [l.destino_lat, l.destino_lng]], { color: '#6f9f7c', weight: 4, opacity: 0.8, className: 'ligacao-rede' }).addTo(camadaLinhas);
      }
      for (const a of ativos) {
        const icon = L.divIcon({ className: '', html: `<div class="pino ${a.tipo === 'pop' ? 'pop ' : ''}${a.status_operacional}"></div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
        const m = L.marker([a.lat, a.lng], { icon, title: `${a.codigo} · ${rotulo('statusAtivo', a.status_operacional)}`, keyboard: true, alt: a.codigo });
        const popup = el('div', {}, el('strong', {}, a.codigo), el('div', {}, `${rotulo('tipoAtivo', a.tipo)}${a.bairro ? ` · ${a.bairro}` : ''}`),
          el('div', { style: `color:${COR_STATUS[a.status_operacional]}` }, `${rotulo('statusAtivo', a.status_operacional)} (${rotulo('origemStatus', a.status_origem)})`),
          a.portas ? el('div', {}, `${a.portas.ocupadas}/${a.portas.total} portas ocupadas`) : null,
          aoAbrir ? el('button', { class: 'botao pequeno', style: 'margin-top:8px', onclick: () => aoAbrir(a) }, 'Abrir detalhe') : null);
        m.bindPopup(popup);
        grupo.addLayer(m);
        marcadores.set(`a${a.id}`, m);
      }
      enquadrar(ativos.map((a) => [a.lat, a.lng]));
    },
    mostrarFrota(veiculos, aoAbrir) {
      if (!vivo) return;
      limpar();
      const com = veiculos.filter((v) => v.lat !== null && v.lat !== undefined);
      for (const v of com) {
        const icon = L.divIcon({ className: '', html: `<div class="pino veiculo ${v.situacao}"></div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
        const m = L.marker([v.lat, v.lng], { icon, title: `${placa(v.placa)} · ${rotulo('situacaoRastreio', v.situacao)}`, keyboard: true, alt: v.placa });
        m.bindPopup(el('div', {}, el('strong', {}, `${placa(v.placa)} · ${v.modelo}`), el('div', {}, rotulo('situacaoRastreio', v.situacao)),
          el('div', {}, `Posição de ${dataHora(v.observado_em)} (${desde(v.observado_em)})`), el('div', {}, `Ignição: ${v.ignicao}`),
          v.velocidade_kmh !== null ? el('div', {}, `${Math.round(v.velocidade_kmh)} km/h`) : null,
          aoAbrir ? el('button', { class: 'botao pequeno', style: 'margin-top:8px', onclick: () => aoAbrir(v) }, 'Abrir veículo') : null));
        grupo.addLayer(m);
        marcadores.set(`v${v.id}`, m);
      }
      enquadrar(com.map((v) => [v.lat, v.lng]));
    },
    trajeto(pontos) {
      if (!vivo) return;
      camadaLinhas.clearLayers();
      if (!pontos.length) return;
      const linha = L.polyline(pontos.map((p) => [p.lat, p.lng]), { color: '#19724e', weight: 4 }).addTo(camadaLinhas);
      L.circleMarker([pontos[0].lat, pontos[0].lng], { radius: 6, color: '#19724e', fillOpacity: 1 }).bindTooltip(`Início ${dataHora(pontos[0].observado_em)}`).addTo(camadaLinhas);
      L.circleMarker([pontos.at(-1).lat, pontos.at(-1).lng], { radius: 6, color: '#15261e', fillOpacity: 1 }).bindTooltip(`Fim ${dataHora(pontos.at(-1).observado_em)}`).addTo(camadaLinhas);
      mapa.fitBounds(linha.getBounds(), { padding: [30, 30] });
    },
    focar(chave) {
      if (!vivo) return;
      const m = marcadores.get(chave);
      if (!m) return;
      if (grupo.zoomToShowLayer) grupo.zoomToShowLayer(m, () => m.openPopup());
      else { mapa.setView(m.getLatLng(), 17); m.openPopup(); }
    },
    /**
     * Casinhas dos assinantes. `aoAbrir(ponto)` recebe o ponto clicado.
     * Devolve quantas foram de fato desenhadas — a tela compara com o total e avisa a diferença.
     */
    mostrarPanorama(pontos, { aoAbrir = null, enquadrarAgora = true } = {}) {
      if (!vivo) return 0;
      grupo.clearLayers();
      marcadores.clear();
      for (const p of pontos) {
        const icon = L.divIcon({
          className: '',
          html: `<div class="casa ${p.estado}${p.atencao ? ' atencao' : ''}">${SVG_CASA}</div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        });
        const m = L.marker([p.lat, p.lng], { icon, title: `${p.assinante_nome} · ${p.estado}`, keyboard: true, alt: p.assinante_nome });
        m.on('click', () => aoAbrir?.(p));
        m.on('keydown', (e) => { if (e.originalEvent?.key === 'Enter') aoAbrir?.(p); });
        grupo.addLayer(m);
        marcadores.set(`c${p.contrato_id}`, m);
      }
      if (enquadrarAgora) enquadrar(pontos.map((p) => [p.lat, p.lng]));
      return pontos.length;
    },

    /** Camadas de apoio: caixas ópticas e chamados abertos, cada uma ligável à parte. */
    camadasApoio({ rede: ativos = [], chamados: oss = [] }, { aoAbrirAtivo = null, aoAbrirChamado = null } = {}) {
      if (!vivo) return { rede: null, chamados: null };
      const camadaRede = L.layerGroup();
      for (const a of ativos) {
        const icon = L.divIcon({ className: '', html: `<div class="pino ${a.tipo === 'pop' ? 'pop ' : ''}${a.status_operacional}"></div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
        const m = L.marker([a.lat, a.lng], { icon, title: a.codigo, keyboard: true, alt: a.codigo });
        m.bindPopup(el('div', {}, el('strong', {}, a.codigo),
          el('div', {}, `${rotulo('tipoAtivo', a.tipo)}${a.bairro ? ` · ${a.bairro}` : ''}`),
          a.portas ? el('div', {}, `${a.portas.livre ?? 0} porta(s) livre(s) de ${a.portas.total}`) : el('div', { class: 'fraco' }, 'Sem portas cadastradas'),
          aoAbrirAtivo ? el('button', { class: 'botao pequeno', style: 'margin-top:8px', onclick: () => aoAbrirAtivo(a) }, 'Abrir na rede') : null));
        camadaRede.addLayer(m);
      }
      const camadaOs = L.layerGroup();
      for (const c of oss) {
        const icon = L.divIcon({ className: '', html: `<div class="pino chamado ${c.prioridade}">${SVG_ALERTA}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
        const m = L.marker([c.lat, c.lng], { icon, title: `OS ${c.numero}`, keyboard: true, alt: `OS ${c.numero}` });
        m.bindPopup(el('div', {}, el('strong', {}, `OS ${c.numero}`), el('div', {}, rotulo('tipoChamado', c.tipo)),
          el('div', {}, rotulo('statusChamado', c.status)), c.tecnico_nome ? el('div', {}, c.tecnico_nome) : null,
          aoAbrirChamado ? el('button', { class: 'botao pequeno', style: 'margin-top:8px', onclick: () => aoAbrirChamado(c) }, 'Abrir chamado') : null));
        camadaOs.addLayer(m);
      }
      return { rede: camadaRede, chamados: camadaOs };
    },

    alternarCamada(camada, ligada) {
      if (!vivo || !camada) return;
      if (ligada) camada.addTo(mapa);
      else mapa.removeLayer(camada);
    },

    /**
     * Desenho de área à mão, sem biblioteca de desenho: clique põe vértice, o traço acompanha o cursor,
     * duplo clique (ou o botão) fecha. São trinta linhas — não vale carregar mais um script por isso.
     */
    desenhar({ aoFechar }) {
      if (!vivo) return () => {};
      const pontos = [];
      let previa = null;
      let linha = null;
      const marcas = L.layerGroup().addTo(mapa);
      alvo.classList.add('desenhando');
      const redesenhar = (ate = null) => {
        const todos = ate ? [...pontos, ate] : pontos;
        if (linha) linha.remove();
        if (todos.length >= 2) {
          linha = (todos.length >= 3 ? L.polygon(todos, { color: '#19724e', weight: 2, fillOpacity: 0.12, dashArray: '6 4' })
            : L.polyline(todos, { color: '#19724e', weight: 2, dashArray: '6 4' })).addTo(mapa);
        }
      };
      const clique = (e) => {
        pontos.push([e.latlng.lat, e.latlng.lng]);
        L.circleMarker(e.latlng, { radius: 4, color: '#19724e', fillColor: '#fff', fillOpacity: 1, weight: 2 }).addTo(marcas);
        redesenhar();
      };
      const mover = (e) => { if (pontos.length) { previa = e.latlng; redesenhar([e.latlng.lat, e.latlng.lng]); } };
      const encerrar = (cancelado = false) => {
        mapa.off('click', clique); mapa.off('mousemove', mover); mapa.off('dblclick', fechar);
        mapa.doubleClickZoom.enable();
        alvo.classList.remove('desenhando');
        marcas.remove();
        if (linha) linha.remove();
        return cancelado || pontos.length < 3 ? null : pontos.map(([lat, lng]) => ({ lat, lng }));
      };
      const fechar = () => {
        const area = encerrar(false);
        if (area) {
          camadaLinhas.clearLayers();
          L.polygon(area.map((p) => [p.lat, p.lng]), { color: '#19724e', weight: 2, fillOpacity: 0.12 }).addTo(camadaLinhas);
        }
        aoFechar(area);
      };
      mapa.doubleClickZoom.disable();
      mapa.on('click', clique);
      mapa.on('mousemove', mover);
      mapa.on('dblclick', fechar);
      void previa;
      return { concluir: fechar, cancelar: () => { encerrar(true); aoFechar(null); } };
    },

    limparArea() { if (vivo) camadaLinhas.clearLayers(); },

    /**
     * Mapa de calor como GRADE de células clicáveis, não como borrão.
     * Uma mancha degradê sugere uma precisão que o dado não tem; a célula diz "sete quedas, quatro
     * assinantes" e pode ser aberta para ver quais.
     */
    mostrarCalor(celulas, aoAbrirCelula) {
      if (!vivo) return;
      camadaLinhas.clearLayers();
      for (const c of celulas) {
        const r = L.rectangle([[c.sul, c.oeste], [c.norte, c.leste]], {
          color: '#cf5b55',
          weight: 1,
          opacity: 0.45 + c.intensidade * 0.35,
          fillOpacity: 0.12 + c.intensidade * 0.45,
          className: 'celula-calor',
        }).addTo(camadaLinhas);
        r.bindTooltip(`${c.quedas} queda(s) · ${c.assinantes} assinante(s)`, { direction: 'top' });
        if (aoAbrirCelula) r.on('click', () => aoAbrirCelula(c));
      }
      const todos = celulas.flatMap((c) => [[c.sul, c.oeste], [c.norte, c.leste]]);
      if (todos.length) mapa.fitBounds(L.latLngBounds(todos), { padding: [30, 30], maxZoom: 15 });
    },

    enquadrar,

    destruir() {
      vivo = false;
      // Para animações de zoom em andamento antes de remover (evita erro ao trocar de tela no meio de um movimento).
      try { mapa.stop(); mapa.off(); grupo.clearLayers(); mapa.remove(); } catch { /* já removido */ }
    },
  };
}
