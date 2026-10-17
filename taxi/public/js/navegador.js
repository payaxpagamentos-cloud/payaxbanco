import { api } from './api.js';
import { el, limpar, minutos, toast } from './ui.js';
import { criarMapa, camada, ICONES, enquadrar } from './mapa.js';

/**
 * Navegador do motorista, dentro do app: rota pelas ruas desenhada no mapa, a próxima manobra com a distância,
 * instruções por voz em português, recálculo quando sai do caminho, tempo restante e horário de chegada.
 * A posição vem do app do motorista (GPS, ou toque no mapa quando o GPS está indisponível).
 */
const FORA_DA_ROTA_M = 45; // distância da linha da rota a partir da qual recalcula
const AVISO_LONGE_M = 400; // primeiro aviso por voz antes da manobra
const AVISO_PERTO_M = 60; // aviso "agora"
const CHEGOU_M = 30;

// Geometria em metros (aproximação plana, suficiente para distâncias urbanas).
const R = 6_371_000;
const rad = (g) => (g * Math.PI) / 180;
function emMetros(ref) {
  const kx = R * Math.cos(rad(ref[0]));
  return ([lat, lng]) => [rad(lng - ref[1]) * kx, rad(lat - ref[0]) * R];
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Prepara a rota: distâncias acumuladas da linha e o ponto (em metros ao longo da rota) de cada manobra. */
function preparar(rota) {
  const proj = emMetros(rota.geometria[0]);
  const pts = rota.geometria.map(proj);
  const acum = [0];
  for (let i = 1; i < pts.length; i++) acum.push(acum[i - 1] + dist(pts[i - 1], pts[i]));
  const total = acum.at(-1) || rota.distancia_m;
  const naRota = (p) => {
    const q = proj(p);
    let melhor = { desvio: Infinity, s: 0 };
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      const seg = dist(a, b) || 1e-9;
      const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / (seg * seg)));
      const d = dist(q, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      if (d < melhor.desvio) melhor = { desvio: d, s: acum[i - 1] + t * seg };
    }
    return melhor;
  };
  const passos = rota.passos.map((p, i) => ({ ...p, s: i === 0 ? 0 : naRota(p.local).s }));
  return { ...rota, total, naRota, passos };
}

const textoDistancia = (m) => (m >= 1000 ? `${(m / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`);
const falaDistancia = (m) => (m >= 1000 ? `${(m / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} quilômetros` : `${Math.round(m / 50) * 50 || 50} metros`);

function falar(texto) {
  try {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(texto);
    u.lang = 'pt-BR';
    const voz = speechSynthesis.getVoices().find((v) => v.lang?.toLowerCase().startsWith('pt'));
    if (voz) u.voice = voz;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch { /* sem voz neste aparelho */ }
}

/**
 * Abre o navegador até `destino` ({ lat, lng, nome }).
 * `posicao()` devolve a última posição conhecida; `assinar(fn)` recebe as novas posições e devolve a função para parar;
 * `aoTocarMapa` (opcional) recebe o ponto tocado no mapa (posição manual sem GPS).
 */
export async function abrirNavegador({ destino, posicao, assinar, aoTocarMapa }) {
  let voz = true;
  try { voz = localStorage.getItem('taxi.navegador.voz') !== '0'; } catch { /* padrão: com voz */ }
  const faixa = el('div', { class: 'nav-faixa' }, el('div', { class: 'nav-seta' }, '↑'), el('div', { class: 'nav-texto' }, el('div', { class: 'nav-dist' }, '…'), el('div', { class: 'nav-instr' }, 'Calculando a rota…')));
  const depois = el('div', { class: 'nav-depois oculto' });
  const resumo = el('div', { class: 'nav-resumo' }, '—');
  const divMapa = el('div', { class: 'mapa' });
  const botaoVoz = el('button', { class: 'btn pequeno', 'aria-pressed': String(voz) }, voz ? '🔊 Voz' : '🔇 Voz');
  const centralizar = el('button', { class: 'btn pequeno oculto' }, '◎ Centralizar');
  const sair = el('button', { class: 'btn pequeno escuro' }, 'Sair');
  const externo = (rot, href) => el('a', { class: 'btn pequeno', href, target: '_blank', rel: 'noopener' }, rot);
  const tela = el('div', { class: 'navegador', role: 'dialog', 'aria-label': `Navegação até ${destino.nome}` },
    el('div', { class: 'nav-topo' }, faixa, depois),
    el('div', { class: 'app-mapa' }, divMapa),
    el('div', { class: 'nav-base' }, el('div', { class: 'linha entre' }, el('div', { style: 'min-width:0' }, el('div', { class: 'pequeno mudo nav-nome' }, destino.nome), resumo), sair),
      el('div', { class: 'linha', style: 'margin-top:8px' }, botaoVoz, centralizar,
        externo('Google Maps', `https://www.google.com/maps/dir/?api=1&destination=${destino.lat},${destino.lng}&travelmode=driving&dir_action=navigate`),
        externo('Waze', `https://waze.com/ul?ll=${destino.lat},${destino.lng}&navigate=yes`))));
  document.body.append(tela);

  // Tela acesa durante a navegação (quando o aparelho permite).
  let travaTela = null;
  try { travaTela = await navigator.wakeLock?.request('screen'); } catch { /* sem trava de tela */ }

  const mapa = await criarMapa(divMapa, { zoom: 16 });
  const linha = mapa?.linha([]);
  const marcas = camada(mapa);
  let seguir = true;
  mapa?.aoArrastar(() => { seguir = false; centralizar.classList.remove('oculto'); });
  if (aoTocarMapa) mapa?.on('click', (e) => aoTocarMapa(e.latlng));

  let rota = null;
  let carregando = false;
  let ultimoRecalculo = 0;
  let foraSeguidas = 0;
  let avisados = new Set();
  let chegou = false;
  let nova = null;

  const desenharResumo = (restante) => {
    const s = rota.duracao_s * (restante / rota.total);
    const chegada = new Date(Date.now() + s * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    resumo.textContent = `${minutos(s)} · ${textoDistancia(restante)} · chegada ${chegada}`;
  };

  async function calcular(p, motivo) {
    if (carregando) return;
    carregando = true;
    ultimoRecalculo = Date.now();
    try {
      rota = preparar(await api.get(`/motorista/rota?lat=${p.lat}&lng=${p.lng}&dlat=${destino.lat}&dlng=${destino.lng}`));
      linha?.definir(rota.geometria);
      avisados = new Set();
      foraSeguidas = 0;
      if (motivo === 'recalculo') { toast('Rota recalculada.'); if (voz) falar('Recalculando a rota.'); }
      if (!motivo) enquadrar(mapa, [[p.lat, p.lng], [destino.lat, destino.lng]], 17);
      atualizar(p);
    } catch (err) {
      limpar(faixa.querySelector('.nav-instr'), err.message);
    } finally {
      carregando = false;
    }
  }

  function atualizar(p) {
    marcas.atualizar([{ chave: 'eu', lat: p.lat, lng: p.lng, icone: ICONES.eu() }, { chave: 'destino', lat: destino.lat, lng: destino.lng, icone: ICONES.destino() }]);
    if (seguir && rota) mapa?.setView([p.lat, p.lng], 17);
    if (!rota || chegou) return;
    const { desvio, s } = rota.naRota([p.lat, p.lng]);
    if (desvio > FORA_DA_ROTA_M) {
      foraSeguidas++;
      const espera = 8000 - (Date.now() - ultimoRecalculo);
      // Fora da rota em duas leituras seguidas: recalcula (no máximo a cada 8 s; parado fora da rota, tenta de novo ao fim da espera).
      if (foraSeguidas >= 2 && espera <= 0) calcular(p, 'recalculo');
      else if (foraSeguidas >= 2) { clearTimeout(nova); nova = setTimeout(() => atualizar(posicao() ?? p), espera + 50); }
    } else foraSeguidas = 0;
    const restante = Math.max(0, rota.total - s);
    if (restante <= CHEGOU_M) {
      chegou = true;
      limpar(faixa.querySelector('.nav-seta'), '🏁');
      limpar(faixa.querySelector('.nav-dist'), 'Você chegou');
      limpar(faixa.querySelector('.nav-instr'), destino.nome);
      depois.classList.add('oculto');
      resumo.textContent = 'No destino';
      if (voz) falar('Você chegou ao destino.');
      return;
    }
    // Próxima manobra: a primeira ainda à frente na rota.
    const i = rota.passos.findIndex((x, k) => k > 0 && x.s > s + 3);
    const prox = rota.passos[i === -1 ? rota.passos.length - 1 : i];
    const falta = Math.max(0, prox.s - s);
    limpar(faixa.querySelector('.nav-seta'), prox.seta);
    limpar(faixa.querySelector('.nav-dist'), textoDistancia(falta));
    limpar(faixa.querySelector('.nav-instr'), prox.instrucao);
    const seguinte = i === -1 ? null : rota.passos[i + 1];
    if (seguinte && seguinte.s - prox.s < 200) { limpar(depois, `Depois: ${seguinte.seta} ${seguinte.instrucao}`); depois.classList.remove('oculto'); } else depois.classList.add('oculto');
    desenharResumo(restante);
    if (voz) {
      if (falta <= AVISO_PERTO_M && !avisados.has(`${i}:perto`)) { avisados.add(`${i}:perto`); avisados.add(`${i}:longe`); falar(prox.instrucao); }
      else if (falta <= AVISO_LONGE_M && falta > AVISO_PERTO_M * 2 && !avisados.has(`${i}:longe`)) { avisados.add(`${i}:longe`); falar(`Em ${falaDistancia(falta)}, ${prox.instrucao.charAt(0).toLowerCase()}${prox.instrucao.slice(1)}.`); }
    }
  }

  botaoVoz.addEventListener('click', () => {
    voz = !voz;
    botaoVoz.textContent = voz ? '🔊 Voz' : '🔇 Voz';
    botaoVoz.setAttribute('aria-pressed', String(voz));
    try { localStorage.setItem('taxi.navegador.voz', voz ? '1' : '0'); } catch { /* ignora */ }
    if (!voz) try { speechSynthesis.cancel(); } catch { /* ignora */ }
  });
  centralizar.addEventListener('click', () => { seguir = true; centralizar.classList.add('oculto'); const p = posicao(); if (p) mapa?.setView([p.lat, p.lng], 17); });

  const parar = assinar((p) => atualizar(p));
  const fechar = () => {
    parar();
    clearTimeout(nova);
    try { speechSynthesis.cancel(); } catch { /* ignora */ }
    try { travaTela?.release(); } catch { /* ignora */ }
    tela.remove();
  };
  sair.addEventListener('click', fechar);

  const inicio = posicao();
  if (inicio) calcular(inicio);
  else {
    limpar(faixa.querySelector('.nav-instr'), 'Aguardando sua localização (ou toque no mapa).');
    const esperar = assinar((p) => { esperar(); calcular(p); });
  }
  return { fechar };
}
