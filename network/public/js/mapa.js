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
    destruir() {
      vivo = false;
      // Para animações de zoom em andamento antes de remover (evita erro ao trocar de tela no meio de um movimento).
      try { mapa.stop(); mapa.off(); grupo.clearLayers(); mapa.remove(); } catch { /* já removido */ }
    },
  };
}
