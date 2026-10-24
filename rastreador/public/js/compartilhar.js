/** Página pública do link de localização: mostra o veículo no mapa e atualiza sozinha até o link expirar. */
import { api } from './api.js';
import { el, limpar, dataHora, desde, kmh, placa, TIPOS_VEICULO } from './ui.js';
import { criarMapa, linkGoogle } from './mapa.js';

const codigo = location.hash.slice(1);
const info = document.getElementById('info');
let mapa = null;
let marcador = null;
let parar = false;

async function atualizar() {
  if (parar) return;
  let v;
  try {
    v = await api.get(`/publico/compartilhado/${encodeURIComponent(codigo)}`);
  } catch (err) {
    parar = true;
    limpar(info, el('h2', {}, 'Link indisponível'), el('p', { class: 'mudo' }, err.status === 404 ? 'Este link expirou ou foi cancelado.' : err.message));
    return;
  }
  document.title = `${placa(v.placa)} · Localização`;
  const temPosicao = v.lat !== null;
  const situacao = !temPosicao ? 'sem_posicao' : (v.velocidade_kmh ?? 0) >= 3 ? 'movimento' : v.ignicao === 1 ? 'ligado' : 'parado';
  const dado = { ...v, situacao, id: 1 };
  if (mapa && temPosicao) {
    if (marcador) marcador.atualizar(dado);
    else { marcador = mapa.veiculo(dado); mapa.ir(v.lat, v.lng, 16); }
  }
  limpar(info,
    el('div', { class: 'linha entre' }, el('h2', { style: 'margin:0' }, placa(v.placa)), el('span', { class: 'pequeno mudo' }, v.empresa)),
    el('div', { class: 'pequeno mudo' }, v.descricao ?? TIPOS_VEICULO[v.tipo]),
    temPosicao ? el('p', { style: 'margin:8px 0 4px' }, `${situacao === 'movimento' ? `Em movimento a ${kmh(v.velocidade_kmh)}` : 'Parado'} · atualizado ${desde(v.posicao_em)} (${dataHora(v.posicao_em)})`)
      : el('p', {}, 'Aguardando a primeira posição.'),
    el('div', { class: 'linha entre' }, el('span', { class: 'pequeno fraco' }, `Link válido até ${dataHora(v.expira_em)}`),
      temPosicao ? el('a', { class: 'btn pequeno primario', href: linkGoogle(v.lat, v.lng), target: '_blank', rel: 'noopener' }, 'Abrir no Google Maps') : null));
}

(async () => {
  if (!codigo) {
    limpar(info, el('h2', {}, 'Link inválido'));
    return;
  }
  mapa = await criarMapa(document.getElementById('mapa'), { zoom: 15 });
  await atualizar();
  setInterval(() => { if (document.visibilityState === 'visible') atualizar(); }, 15_000);
})();
