import { api, BASE, ErroApi, absoluto } from './api.js';
import { el, icone, relogio, duracao, toast, modal, acao, nomeDoAparelho, etiquetaIdade, QUALIDADES, LINHAS_QUALIDADE } from './ui.js';
import { temPonteAndroid, criarVideoTizen, tocarNoAndroidTV } from './motor-nativo.js';
import { vigiarReproducao } from './vigia.js';

/**
 * Player da PLAY TECH VIP: canais ao vivo (HLS pelo hls.js, com reserva para o HLS nativo do Safari)
 * e conteúdo sob demanda (MP4 com Range). Controles próprios, legendas, qualidade, telas simultâneas
 * e "continuar assistindo" salvo de tempo em tempo.
 */

/**
 * Tela cheia, com os três caminhos que existem — nessa ordem.
 *
 * O iPhone é o motivo deste código todo. Lá o `requestFullscreen` de um elemento qualquer
 * simplesmente não existe: o Safari do iPhone só abre tela cheia no próprio <video>, por
 * `webkitEnterFullscreen()`. (No iPad e no Android o jeito padrão funciona normalmente.) O bug
 * do WebKit segue aberto desde 2022. Como a nossa caixa do player é uma <div>, o botão caía
 * direto no "seu navegador não deixou" — que era verdade, mas inútil para quem só queria ver a
 * TV em tela cheia.
 *
 * Preço do caminho do iPhone: a Apple assume os controles e os nossos somem enquanto durar a
 * tela cheia. É assim em qualquer aplicativo de streaming no iPhone; não há outro caminho.
 */
export const naTelaCheia = (video) => Boolean(
  document.fullscreenElement ?? document.webkitFullscreenElement ?? video?.webkitDisplayingFullscreen,
);

export async function alternarTelaCheia(caixa, video) {
  if (naTelaCheia(video)) {
    if (document.exitFullscreen && document.fullscreenElement) return document.exitFullscreen();
    if (document.webkitExitFullscreen && document.webkitFullscreenElement) return document.webkitExitFullscreen();
    if (video?.webkitDisplayingFullscreen) return video.webkitExitFullscreen?.();
    return undefined;
  }
  // 1. O jeito padrão: Android, computador, iPad, TV.
  if (caixa.requestFullscreen) {
    try { return await caixa.requestFullscreen({ navigationUI: 'hide' }); } catch { /* tenta o próximo */ }
  }
  // 2. Safari antigo de computador.
  if (caixa.webkitRequestFullscreen) {
    try { return caixa.webkitRequestFullscreen(); } catch { /* tenta o próximo */ }
  }
  // 3. iPhone: só o <video> vai a tela cheia, e só depois de ter lido o cabeçalho do vídeo.
  if (video?.webkitEnterFullscreen && video.readyState >= 1) {
    try { return video.webkitEnterFullscreen(); } catch { /* acabaram os caminhos */ }
  }
  toast(video?.webkitEnterFullscreen
    ? 'A tela cheia abre assim que o vídeo começar. Tente de novo em um instante.'
    : 'Seu navegador não deixou abrir em tela cheia.', true);
  return undefined;
}

let Hls = null;
const carregarHls = async () => {
  if (Hls !== null) return Hls;
  try {
    const mod = await import(`${BASE}/vendor/hls/hls.mjs`);
    Hls = mod.default ?? mod.Hls ?? null;
  } catch {
    Hls = null;
  }
  return Hls;
};

const PASSO = 10;

/** Abre a tela cheia de reprodução. Devolve uma promessa que resolve quando o player fecha. */
export async function tocar({ tipo, canal_id: canalId, titulo_id: tituloId, episodio_id: episodioId, aoFechar, aoTrocar }) {
  let dados;
  try {
    dados = await api.post('/play/abrir', { tipo, canal_id: canalId, titulo_id: tituloId, episodio_id: episodioId, dispositivo: nomeDoAparelho() });
  } catch (err) {
    // 409 com as telas em uso: o assinante decide qual parar.
    if (err instanceof ErroApi && err.status === 409 && err.detalhes?.em_uso) {
      const liberar = await modal('Telas em uso', (fechar) => [
        el('p', { class: 'mudo' }, err.message),
        el('div', { class: 'coluna', style: 'margin:12px 0' }, err.detalhes.em_uso.map((t) => el('div', { class: 'cartao fundo linha entre' },
          el('div', {}, el('strong', {}, t.o_que ?? 'Assistindo'), el('div', { class: 'pequeno mudo' }, t.dispositivo ?? 'Aparelho não informado')),
          el('span', { class: 'etiqueta' }, 'em uso')))),
        el('div', { class: 'linha fim' },
          el('button', { class: 'btn vazio', onclick: () => fechar(false) }, 'Deixar como está'),
          el('button', { class: 'btn primario', onclick: () => fechar(true) }, 'Parar as outras e assistir aqui')),
      ]);
      if (!liberar) return null;
      await api.post('/conta/telas/encerrar', {});
      return tocar({ tipo, canal_id: canalId, titulo_id: tituloId, episodio_id: episodioId, aoFechar, aoTrocar });
    }
    throw err;
  }

  // Canal que vem pelo player oficial da emissora: não é o nosso <video>, é o player dela.
  if (dados.fonte.tipo === 'embed') return tocarNoPlayerDaEmissora(dados, { aoFechar });

  // Dentro do app nativo da Android TV (TCL, Google TV), quem toca é o ExoPlayer do aparelho.
  if (temPonteAndroid()) return tocarNativoAndroid(dados, { aoFechar });

  const aoVivo = Boolean(dados.ao_vivo);
  // Na Samsung, o motor é o AVPlay (player nativo do sistema); nos demais, o <video> do navegador,
  // que nas Smart TVs já é o decodificador do aparelho.
  const video = criarVideoTizen() ?? el('video', { playsinline: true, autoplay: true, preload: 'auto' });
  video.setAttribute('x-webkit-airplay', 'allow');
  let hls = null;
  let fechado = false;
  let pararPing = null;
  let esconder = null;
  let menuAberto = null;

  // ---------- Montagem da tela ----------
  const titulo = el('h2', {}, dados.info.titulo);
  const subtitulo = el('div', { class: 'sub' }, dados.info.subtitulo ?? '');
  const rotuloQualidade = (q) => QUALIDADES[q] ?? String(q ?? '').toUpperCase();
  const seloQualidade = dados.fonte.qualidade
    ? el('span', { class: `etiqueta qualidade${dados.fonte.qualidade === '4k' ? ' ultra' : ''}` }, rotuloQualidade(dados.fonte.qualidade))
    : null;
  const selos = el('div', { class: 'linha', style: 'margin-top:6px' },
    aoVivo ? el('span', { class: 'etiqueta vivo' }, 'AO VIVO') : null,
    dados.info.classificacao !== undefined ? etiquetaIdade(dados.info.classificacao) : null,
    seloQualidade);
  // Aqui havia um selo "PLAY CDN". Saiu: ele aparecia em todos os canais, sempre, porque todos
  // passam pelos nossos servidores — etiqueta que nunca muda não informa nada, e "CDN" não quer
  // dizer nada para quem assiste. A operação vê a mesma informação no painel, em português.


  const btn = (nomeIcone, rotulo, fn, extra = '') => {
    const b = el('button', { class: `pbtn ${extra}`, title: rotulo, 'aria-label': rotulo }, icone(nomeIcone));
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(b); });
    return b;
  };

  const feito = el('div', { class: 'feito', style: 'width:0' });
  const buffer = el('div', { class: 'buffer', style: 'width:0' });
  const bolinha = el('div', { class: 'bolinha', style: 'left:0' });
  const trilho = el('div', { class: `trilho${aoVivo ? ' vivo' : ''}`, role: 'slider', 'aria-label': 'Posição', tabindex: '0' },
    el('div', { class: 'fundo' }, buffer, feito), bolinha);
  const agora = el('span', { class: 'relogio' }, '0:00');
  const total = el('span', { class: 'relogio' }, aoVivo ? 'ao vivo' : '0:00');

  const btnTocar = btn('tocar', 'Tocar ou pausar (espaço)', () => alternar(), 'grande');
  const btnSom = btn('som', 'Som (M)', () => { video.muted = !video.muted; });
  const faixaVolume = el('input', { type: 'range', min: '0', max: '1', step: '0.02', value: '1', 'aria-label': 'Volume' });
  faixaVolume.addEventListener('input', () => { video.volume = Number(faixaVolume.value); video.muted = Number(faixaVolume.value) === 0; });
  faixaVolume.addEventListener('click', (e) => e.stopPropagation());

  const btnLegenda = dados.legendas?.length ? btn('legenda', 'Legendas (C)', (b) => menuLegendas(b)) : null;
  const btnQualidade = btn('engrenagem', 'Qualidade', (b) => menuQualidade(b));
  const btnPip = document.pictureInPictureEnabled ? btn('pip', 'Janela flutuante', async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch { toast('A janela flutuante não está disponível aqui.', true); }
  }) : null;
  const btnTela = btn('tela', 'Tela cheia (F)', () => telaCheia());
  const btnProximo = dados.proximo_episodio ? btn('proximo', 'Próximo episódio', () => irParaProximo()) : null;
  const btnVivo = aoVivo ? el('button', { class: 'btn pequeno vazio', onclick: (e) => { e.stopPropagation(); voltarAoVivo(); } }, 'Voltar ao vivo') : null;

  const avisoCentro = el('div', { class: 'centro-aviso' }, el('div', { class: 'rodinha' }));
  const caixaErro = el('div', { class: 'erro-caixa oculto' });
  const caixaProximo = el('div', { class: 'proximo oculto' });

  const cobertura = el('div', { class: 'cobertura' },
    el('div', { class: 'p-topo' },
      btn('voltar', 'Voltar (Esc)', () => fechar(), ''),
      el('div', { class: 'info' }, titulo, subtitulo, selos),
      dados.download ? el('a', { class: 'btn pequeno vazio', href: dados.download, download: '', onclick: (e) => e.stopPropagation() }, icone('baixar'), 'Baixar') : null),
    el('div', { class: 'p-base' },
      el('div', { class: 'tempo-barra' }, agora, trilho, total),
      el('div', { class: 'botoes' },
        btnTocar,
        aoVivo ? null : btn('voltar10', 'Voltar 10 segundos (←)', () => pular(-PASSO)),
        aoVivo ? null : btn('avancar10', 'Avançar 10 segundos (→)', () => pular(PASSO)),
        btnProximo,
        el('div', { class: 'volume' }, btnSom, faixaVolume),
        btnVivo,
        el('div', { class: 'espaco' }),
        btnLegenda,
        btnQualidade,
        btnPip,
        btnTela)));

  const caixa = el('div', { class: 'player' }, video.elemento ?? video, cobertura, avisoCentro, caixaErro, caixaProximo);
  document.body.append(caixa);
  document.body.style.overflow = 'hidden';
  // Teclas de mídia do controle remoto e botão Voltar da TV.
  window.playtechvipPlayer = {
    fechar: () => fechar(),
    alternar: () => alternar(),
    tocar: () => video.play().catch(() => {}),
    pausar: () => video.pause(),
    parar: () => fechar(),
    avancar: () => pular(30),
    voltar: () => pular(-30),
  };

  // ---------- Fonte do vídeo ----------
  const semSuporteNativo = () => !video.canPlayType('application/vnd.apple.mpegurl');

  /**
   * O navegador diz que toca HLS sozinho — mas disse a verdade?
   *
   * `canPlayType('application/vnd.apple.mpegurl')` é pergunta de resposta frouxa: o Chrome
   * responde "maybe" sem saber tocar HLS, e nesse caso o player ia pelo caminho nativo e ficava
   * na tela preta. Em vez de adivinhar pelo nome do navegador, a plataforma confere o fato: se
   * em alguns segundos o vídeo não carregou nem o cabeçalho, o suporte nativo era conversa e o
   * hls.js assume. Quem fala a verdade (Safari, iPhone) não é penalizado — lá carrega antes
   * disso e nada acontece.
   */
  let conferindoNativo = false;
  function conferirSuporteNativo() {
    if (dados.fonte.tipo !== 'hls' || video.nativo === 'avplay' || conferindoNativo) return;
    conferindoNativo = true;
    setTimeout(async () => {
      conferindoNativo = false;
      if (fechado || hls || video.readyState >= 1) return;
      const H = await carregarHls();
      if (!H?.isSupported()) return;      // sem hls.js não há para onde cair: fica como está
      usarHls(H);
    }, 6000);
  }

  function usarHls(H) {
    // Se o caminho nativo já tinha posto um `src`, ele precisa sair antes: hls.js alimenta o
    // vídeo por MSE, e os dois disputando o mesmo elemento dão tela preta sem erro nenhum.
    if (video.getAttribute('src')) { video.removeAttribute('src'); video.load?.(); }
    hls = new H({ lowLatencyMode: aoVivo, backBufferLength: aoVivo ? 30 : 90, enableWorker: true, maxBufferLength: 20 });
    hls.on(H.Events.ERROR, (_e, info) => {
      if (!info.fatal) return;
      // Erro fatal de rede ou de mídia não é motivo para desistir: canal ao vivo cai e volta o
      // tempo todo. Mas também não pode virar laço apertado — `startLoad()` chamado sem parar
      // martela o servidor e nunca sai do lugar. Quem conta as tentativas e espera entre elas é
      // o vigia, que vale para os dois motores.
      if (info.type === H.ErrorTypes.NETWORK_ERROR || info.type === H.ErrorTypes.MEDIA_ERROR) {
        vigia.forcar();
        return;
      }
      mostrarErro('Não conseguimos manter a transmissão. Tente abrir de novo.');
    });
    hls.on(H.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    hls.loadSource(absoluto(dados.fonte.url));
    hls.attachMedia(video);
  }

  async function ligarFonte() {
    // O AVPlay toca HLS e MP4 direto, sem hls.js.
    if (video.nativo === 'avplay') {
      video.src = absoluto(dados.fonte.url);
      return;
    }
    if (dados.fonte.tipo === 'hls' && semSuporteNativo()) {
      const H = await carregarHls();
      if (H?.isSupported()) { usarHls(H); return; }
    }
    video.src = absoluto(dados.fonte.url);
    video.play().catch(() => {});
    conferirSuporteNativo();
  }

  // ---------- Vigia da reprodução: nada pode ficar travado ----------
  // A lógica (detectar parada, subir o remédio, esperar entre tentativas) mora em vigia.js, para
  // poder ser testada com um <video> e um HLS de verdade. Aqui ficam só os remédios, que
  // dependem do motor: no iPhone não há hls.js, então os passos 2 e 3 caem direto no último.

  /** Refaz a fonte do zero, guardando onde estava. É o último recurso, e o único do iPhone. */
  async function religarFonte() {
    const posicao = video.currentTime;
    try { hls?.destroy(); } catch { /* segue */ }
    hls = null;
    try { video.removeAttribute('src'); video.load?.(); } catch { /* segue */ }
    await ligarFonte();
    if (!aoVivo && posicao > 1) {
      video.addEventListener('loadedmetadata', () => {
        try { video.currentTime = posicao; } catch { /* o arquivo ainda não aceitou o salto */ }
      }, { once: true });
    }
    video.play().catch(() => {});
  }

  const vigia = vigiarReproducao(video, {
    aoVivo,
    remedios: [
      // 1. Empurrão: no ao vivo, de volta para a ponta; no sob demanda, meio segundo à frente.
      () => {
        const s = video.seekable;
        const fim = s?.length ? s.end(s.length - 1) : null;
        try { video.currentTime = aoVivo && fim !== null ? Math.max(0, fim - 1) : video.currentTime + 0.5; } catch { /* ainda não dá */ }
        video.play().catch(() => {});
      },
      // 2 e 3. A recuperação do próprio hls.js, quando é ele quem está tocando.
      () => (hls ? hls.recoverMediaError() : religarFonte()),
      () => { if (!hls) return religarFonte(); hls.stopLoad(); hls.startLoad(); return undefined; },
      // 4 em diante: refazer a fonte inteira.
      () => religarFonte(),
    ],
    aoMudar: ({ estado, passo }) => {
      if (estado === 'voltou') { avisoCentro.classList.add('oculto'); avisoCentro.replaceChildren(el('div', { class: 'rodinha' })); return; }
      if (estado === 'desistiu') { mostrarErro('A reprodução parou e não voltou. Tente de novo em instantes.'); return; }
      avisoCentro.classList.remove('oculto');
      // Depois de algumas tentativas, dizer o que está havendo: rodinha muda por um minuto é o
      // que faz a pessoa achar que o aplicativo morreu.
      if (passo >= 3) {
        avisoCentro.replaceChildren(el('div', { class: 'rodinha' }),
          el('div', { class: 'pequeno mudo', style: 'margin-top:12px;text-align:center' }, 'Reconectando…'));
      }
    },
  });


  // ---------- Controles ----------
  const alternar = () => { if (video.paused) video.play().catch(() => {}); else video.pause(); };
  const pular = (s) => { if (!aoVivo && Number.isFinite(video.duration)) video.currentTime = Math.min(video.duration - 0.5, Math.max(0, video.currentTime + s)); };
  const voltarAoVivo = () => {
    const fim = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : null;
    if (fim) video.currentTime = fim - 1;
    video.play().catch(() => {});
  };
  const elVideo = () => (video.elemento ?? video);
  async function telaCheia() { await alternarTelaCheia(caixa, elVideo()); }
  const marcarBotao = () => btnTela.replaceChildren(icone(naTelaCheia(elVideo()) ? 'telaSair' : 'tela'));
  // No iPhone quem muda de estado é o <video>, não o documento: sem ouvir os eventos dele, o
  // ícone ficaria mentindo depois de sair da tela cheia pelo player da Apple.
  for (const evento of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(evento, marcarBotao);
  }
  for (const evento of ['webkitbeginfullscreen', 'webkitendfullscreen']) {
    elVideo()?.addEventListener?.(evento, marcarBotao);
  }

  const fecharMenu = () => { menuAberto?.remove(); menuAberto = null; };
  function abrirMenu(titulo2, itens) {
    fecharMenu();
    const m = el('div', { class: 'menu-flutuante', onclick: (e) => e.stopPropagation() }, el('h4', {}, titulo2),
      itens.map(({ rotulo, detalhe, ligado, fn }) => el('button', { class: ligado ? 'on' : '', onclick: () => { fn(); fecharMenu(); } },
        el('span', {}, rotulo), detalhe ? el('span', { class: 'mini mudo' }, detalhe) : ligado ? icone('certo', 15) : null)));
    caixa.append(m);
    menuAberto = m;
  }

  const LEMBRETE = 'playtechvip.qualidade';

  /** Troca a versão do arquivo (SD, HD, Full HD, 4K) continuando de onde parou. */
  function trocarVersao(item) {
    if (!item?.url || item.bloqueada || item.atual) return;
    const posicao = video.currentTime;
    const tocando = !video.paused;
    avisoCentro.classList.remove('oculto');
    const retomar = () => {
      try { video.currentTime = posicao; } catch { /* o arquivo ainda não aceitou o salto */ }
      if (tocando) video.play().catch(() => {});
      avisoCentro.classList.add('oculto');
    };
    video.addEventListener('loadedmetadata', retomar, { once: true });
    video.src = absoluto(item.url);
    video.load?.();
    for (const q of dados.qualidades ?? []) q.atual = q === item;
    dados.fonte.qualidade = item.qualidade;
    dados.fonte.url = item.url;
    if (seloQualidade) {
      seloQualidade.textContent = rotuloQualidade(item.qualidade);
      seloQualidade.classList.toggle('ultra', item.qualidade === '4k');
    }
    try { localStorage.setItem(LEMBRETE, item.qualidade); } catch { /* navegador sem armazenamento */ }
    toast(`Qualidade: ${item.rotulo ?? rotuloQualidade(item.qualidade)}`);
  }

  /** Na abertura, respeita a qualidade que o assinante escolheu da última vez. */
  function aplicarPreferencia() {
    let preferida = null;
    try { preferida = localStorage.getItem(LEMBRETE); } catch { /* sem armazenamento */ }
    const alvo = (dados.qualidades ?? []).find((q) => q.qualidade === preferida && !q.bloqueada && !q.atual);
    if (alvo) {
      dados.fonte.qualidade = alvo.qualidade;
      dados.fonte.url = alvo.url;
      for (const q of dados.qualidades) q.atual = q === alvo;
      if (seloQualidade) {
        seloQualidade.textContent = rotuloQualidade(alvo.qualidade);
        seloQualidade.classList.toggle('ultra', alvo.qualidade === '4k');
      }
    }
  }

  function menuQualidade() {
    const itens = [];
    const versoes = dados.qualidades ?? [];
    if (!hls?.levels?.length && versoes.length) {
      // Sob demanda: cada versão é um arquivo próprio, do 4K ao SD.
      for (const q of versoes) {
        const linhas = q.linha ?? LINHAS_QUALIDADE[q.qualidade] ?? '';
        itens.push({
          rotulo: q.rotulo ?? rotuloQualidade(q.qualidade),
          detalhe: q.bloqueada ? 'plano superior' : [linhas, q.largura && q.altura ? `${q.largura}×${q.altura}` : null].filter(Boolean).join(' · '),
          ligado: Boolean(q.atual),
          fn: () => (q.bloqueada
            ? toast('Seu plano não inclui esta qualidade. Veja os planos em Minha conta.', true)
            : trocarVersao(q)),
        });
      }
    } else if (hls?.levels?.length) {
      itens.push({ rotulo: 'Automática', detalhe: hls.autoLevelEnabled && hls.currentLevel >= 0 ? `${hls.levels[hls.currentLevel]?.height}p` : null,
        ligado: hls.autoLevelEnabled, fn: () => { hls.currentLevel = -1; } });
      hls.levels.forEach((n, i) => itens.push({
        rotulo: `${n.height}p`,
        detalhe: n.bitrate ? `${Math.round(n.bitrate / 1000)} kbps` : null,
        ligado: !hls.autoLevelEnabled && hls.currentLevel === i,
        fn: () => { hls.currentLevel = i; },
      }));
    } else {
      itens.push({ rotulo: rotuloQualidade(dados.fonte.qualidade) || 'Qualidade do arquivo', detalhe: 'versão única', ligado: true, fn: () => {} });
    }
    itens.push({ rotulo: 'Velocidade normal', ligado: video.playbackRate === 1, fn: () => { video.playbackRate = 1; } });
    for (const r of [1.25, 1.5, 2]) itens.push({ rotulo: `Velocidade ${String(r).replace('.', ',')}×`, ligado: video.playbackRate === r, fn: () => { video.playbackRate = r; } });
    abrirMenu('Qualidade e velocidade', itens);
  }

  function menuLegendas() {
    const faixas = [...video.textTracks];
    const itens = [{ rotulo: 'Desligadas', ligado: faixas.every((f) => f.mode !== 'showing'), fn: () => faixas.forEach((f) => { f.mode = 'disabled'; }) }];
    faixas.forEach((f, i) => itens.push({
      rotulo: f.label || f.language || `Legenda ${i + 1}`,
      ligado: f.mode === 'showing',
      fn: () => faixas.forEach((x, j) => { x.mode = j === i ? 'showing' : 'disabled'; }),
    }));
    abrirMenu('Legendas', itens);
  }

  for (const l of dados.legendas ?? []) {
    const faixa = el('track', { kind: 'subtitles', label: l.rotulo, srclang: l.idioma, src: absoluto(l.url), ...(l.padrao ? { default: true } : {}) });
    video.append(faixa);
  }

  // ---------- Barra de tempo ----------
  const duracaoAtual = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration
    : (video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0));

  function pintarTempo() {
    const d = duracaoAtual();
    const p = d ? Math.min(100, (video.currentTime / d) * 100) : 0;
    feito.style.width = `${p}%`;
    bolinha.style.left = `${p}%`;
    if (video.buffered.length) buffer.style.width = `${Math.min(100, (video.buffered.end(video.buffered.length - 1) / (d || 1)) * 100)}%`;
    agora.textContent = aoVivo ? relogio(video.currentTime) : relogio(video.currentTime);
    if (!aoVivo) total.textContent = relogio(d);
    trilho.setAttribute('aria-valuetext', `${relogio(video.currentTime)} de ${aoVivo ? 'ao vivo' : relogio(d)}`);
  }

  const posicaoDoClique = (e) => {
    const r = trilho.getBoundingClientRect();
    const x = (e.touches?.[0]?.clientX ?? e.clientX) - r.left;
    return Math.min(1, Math.max(0, x / r.width));
  };
  let arrastando = false;
  const buscar = (e) => {
    const d = duracaoAtual();
    if (!d) return;
    video.currentTime = posicaoDoClique(e) * d;
    pintarTempo();
  };
  trilho.addEventListener('pointerdown', (e) => { e.stopPropagation(); arrastando = true; trilho.setPointerCapture(e.pointerId); buscar(e); });
  trilho.addEventListener('pointermove', (e) => { if (arrastando) buscar(e); });
  trilho.addEventListener('pointerup', () => { arrastando = false; });
  trilho.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { pular(-PASSO); e.preventDefault(); }
    if (e.key === 'ArrowRight') { pular(PASSO); e.preventDefault(); }
  });

  // ---------- Eventos do vídeo ----------
  video.addEventListener('timeupdate', pintarTempo);
  video.addEventListener('progress', pintarTempo);
  video.addEventListener('loadedmetadata', () => {
    pintarTempo();
    if (dados.retomar_s > 0 && !aoVivo) {
      video.currentTime = dados.retomar_s;
      toast(`Retomando de ${duracao(dados.retomar_s)}`);
    }
  });
  video.addEventListener('play', () => { btnTocar.replaceChildren(icone('pausar')); avisoCentro.classList.add('oculto'); });
  video.addEventListener('pause', () => { btnTocar.replaceChildren(icone('tocar')); mostrarControles(); salvar(); });
  video.addEventListener('waiting', () => avisoCentro.classList.remove('oculto'));
  video.addEventListener('playing', () => avisoCentro.classList.add('oculto'));
  video.addEventListener('volumechange', () => {
    btnSom.replaceChildren(icone(video.muted || video.volume === 0 ? 'mudo' : 'som'));
    faixaVolume.value = String(video.muted ? 0 : video.volume);
  });
  video.addEventListener('error', () => {
    // Canal ao vivo não ganha tela de erro no primeiro tropeço: a origem cai e volta, e o vigia
    // reconecta sozinho. Só depois de insistir é que vale avisar — e, no ao vivo, nem aí.
    if (aoVivo || !vigia.desistiu) { vigia.forcar(); return; }
    mostrarErro('Não conseguimos tocar este vídeo.');
  });
  video.addEventListener('ended', () => {
    salvar();
    if (dados.proximo_episodio) oferecerProximo();
    else fechar();
  });

  function mostrarErro(msg) {
    avisoCentro.classList.add('oculto');
    caixaErro.classList.remove('oculto');
    caixaErro.replaceChildren(el('div', { class: 'cartao', style: 'max-width:440px;text-align:center' },
      el('h2', {}, 'Não foi possível assistir'),
      el('p', { class: 'mudo' }, msg),
      el('div', { class: 'linha', style: 'justify-content:center' },
        el('button', { class: 'btn primario', onclick: () => { caixaErro.classList.add('oculto'); vigia.rearmar(); religarFonte(); } }, 'Tentar de novo'),
        el('button', { class: 'btn vazio', onclick: () => fechar() }, 'Voltar'))));
  }

  // ---------- Próximo episódio ----------
  function oferecerProximo() {
    const p = dados.proximo_episodio;
    let restam = 8;
    const contador = el('strong', {}, `${restam}s`);
    const t = setInterval(() => {
      restam -= 1;
      contador.textContent = `${restam}s`;
      if (restam <= 0) { clearInterval(t); irParaProximo(); }
    }, 1000);
    caixaProximo.classList.remove('oculto');
    caixaProximo.replaceChildren(
      el('div', { class: 'pequeno mudo' }, 'A seguir'),
      el('strong', {}, `T${p.temporada} E${p.numero} · ${p.nome}`),
      el('div', { class: 'linha entre', style: 'margin-top:10px' },
        el('button', { class: 'btn vazio pequeno', onclick: () => { clearInterval(t); caixaProximo.classList.add('oculto'); } }, 'Agora não'),
        el('button', { class: 'btn primario pequeno', onclick: () => { clearInterval(t); irParaProximo(); } }, 'Assistir ', contador)));
  }

  async function irParaProximo() {
    const p = dados.proximo_episodio;
    if (!p) return;
    await fechar({ silencioso: true });
    const saida = await tocar({ tipo: 'episodio', titulo_id: dados.info.titulo_id, episodio_id: p.id, aoFechar, aoTrocar });
    aoTrocar?.(saida);
  }

  // ---------- Sinal de vida e progresso ----------
  let ultimoSalvo = 0;
  const salvar = async () => {
    if (fechado || aoVivo || !dados.info.titulo_id) return;
    const pos = Math.floor(video.currentTime);
    if (Math.abs(pos - ultimoSalvo) < 5) return;
    ultimoSalvo = pos;
    try {
      await api.post('/play/ping', { sessao_id: dados.sessao_id, segundos: Math.floor(video.currentTime), posicao: pos, duracao: Math.floor(duracaoAtual()), qualidade: dados.fonte.qualidade ?? null });
    } catch { /* tenta no próximo ciclo */ }
  };

  const ping = async () => {
    if (fechado) return;
    try {
      await api.post('/play/ping', {
        sessao_id: dados.sessao_id,
        segundos: Math.floor(aoVivo ? (Date.now() - inicio) / 1000 : video.currentTime),
        ...(aoVivo || !dados.info.titulo_id ? {} : { posicao: Math.floor(video.currentTime), duracao: Math.floor(duracaoAtual()) }),
      });
    } catch (err) {
      if (err.status === 409) {
        fechar({ silencioso: true });
        toast('Esta tela foi encerrada em outro aparelho.', true);
      }
    }
  };
  const inicio = Date.now();
  pararPing = setInterval(ping, 30_000);
  const pararSalvar = setInterval(salvar, 15_000);

  // ---------- Esconder controles ----------
  function mostrarControles() {
    caixa.classList.remove('limpo');
    clearTimeout(esconder);
    esconder = setTimeout(() => { if (!video.paused && !menuAberto) caixa.classList.add('limpo'); }, 3500);
  }
  caixa.addEventListener('pointermove', mostrarControles);
  caixa.addEventListener('click', (e) => {
    if (menuAberto) return fecharMenu();
    if (e.target === video || e.target === cobertura) return alternar();
    return undefined;
  });
  video.addEventListener('dblclick', () => telaCheia());
  mostrarControles();
  if (document.body.classList.contains('tv')) requestAnimationFrame(() => btnTocar.focus({ preventScroll: true }));

  // ---------- Teclado ----------
  const teclas = (e) => {
    // A tecla pode vir do controle remoto (evento disparado no documento, sem elemento alvo).
    if (e.target.matches?.('input, textarea, select')) return;
    const mapa = {
      ' ': () => alternar(), k: () => alternar(), ArrowLeft: () => pular(-PASSO), ArrowRight: () => pular(PASSO),
      j: () => pular(-30), l: () => pular(30), f: () => telaCheia(), m: () => { video.muted = !video.muted; },
      c: () => (dados.legendas?.length ? menuLegendas() : null),
      ArrowUp: () => { video.volume = Math.min(1, video.volume + 0.1); video.muted = false; },
      ArrowDown: () => { video.volume = Math.max(0, video.volume - 0.1); },
      Escape: () => (document.fullscreenElement ? document.exitFullscreen() : fechar()),
    };
    const fn = mapa[e.key] ?? (/^[0-9]$/.test(e.key) && !aoVivo
      ? () => { const d = duracaoAtual(); if (d) video.currentTime = (Number(e.key) / 10) * d; }
      : null);
    if (!fn) return;
    e.preventDefault();
    mostrarControles();
    fn();
  };
  document.addEventListener('keydown', teclas);

  // ---------- Fechar ----------
  let resolverFim;
  const fim = new Promise((r) => { resolverFim = r; });

  async function fechar({ silencioso = false } = {}) {
    if (fechado) return;
    fechado = true;
    clearInterval(pararPing);
    clearInterval(pararSalvar);
    vigia.parar();
    clearTimeout(esconder);
    document.removeEventListener('keydown', teclas);
    if (!aoVivo && dados.info.titulo_id && video.currentTime > 5) {
      try {
        await api.post('/play/ping', { sessao_id: dados.sessao_id, segundos: Math.floor(video.currentTime), posicao: Math.floor(video.currentTime), duracao: Math.floor(duracaoAtual()) });
      } catch { /* segue */ }
    }
    try { await api.post('/play/fechar', { sessao_id: dados.sessao_id, motivo: 'fim' }); } catch { /* segue */ }
    try { hls?.destroy(); } catch { /* segue */ }
    video.pause();
    video.destruir?.();
    video.removeAttribute('src');
    video.load();
    if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch { /* segue */ } }
    caixa.remove();
    document.body.style.overflow = '';
    window.playtechvipPlayer = null;
    if (!silencioso) aoFechar?.();
    resolverFim({ titulo_id: dados.info.titulo_id ?? null });
  }

  aplicarPreferencia();
  await ligarFonte();
  return fim;
}

/**
 * Reprodução dentro do app nativo da Android TV: o ExoPlayer do aparelho abre em tela cheia,
 * com os controles nativos. A página continua cuidando da sessão (telas simultâneas) e de
 * guardar onde o assinante parou.
 */
async function tocarNativoAndroid(dados, { aoFechar }) {
  const aoVivo = Boolean(dados.ao_vivo);
  let ultimaPosicao = dados.retomar_s ?? 0;

  const anotarProgresso = (e) => {
    const segundos = Number(e.detail?.segundos) || 0;
    ultimaPosicao = segundos;
    if (!aoVivo && dados.info.titulo_id) {
      api.post('/play/ping', {
        sessao_id: dados.sessao_id,
        segundos,
        posicao: segundos,
        duracao: Math.round(Number(e.detail?.duracao) || dados.fonte.duracao_s || 0),
      }).catch(() => {});
    } else {
      api.post('/play/ping', { sessao_id: dados.sessao_id, segundos }).catch(() => {});
    }
  };
  window.addEventListener('tv:progresso-nativo', anotarProgresso);

  try {
    const fim = await tocarNoAndroidTV({
      url: absoluto(dados.fonte.url),
      titulo: dados.info.titulo,
      subtitulo: dados.info.subtitulo,
      aoVivo,
      posicao: dados.retomar_s ?? 0,
      sessaoId: dados.sessao_id,
    });
    ultimaPosicao = fim.segundos || ultimaPosicao;
  } finally {
    window.removeEventListener('tv:progresso-nativo', anotarProgresso);
    if (!aoVivo && dados.info.titulo_id && ultimaPosicao > 5) {
      await api.post('/play/ping', {
        sessao_id: dados.sessao_id,
        segundos: Math.round(ultimaPosicao),
        posicao: Math.round(ultimaPosicao),
        duracao: Math.round(dados.fonte.duracao_s || 0),
      }).catch(() => {});
    }
    await api.post('/play/fechar', { sessao_id: dados.sessao_id, motivo: 'fim' }).catch(() => {});
    aoFechar?.();
  }
  return { titulo_id: dados.info.titulo_id ?? null };
}

/**
 * Canal com fonte "embed": a PLAY TECH VIP abre o player público da própria emissora dentro da tela,
 * com os anúncios dela — por isso aqui não há controles nossos
 * (quem manda no vídeo é o player da emissora). A tela continua contando para o limite do plano.
 */
function tocarNoPlayerDaEmissora(dados, { aoFechar }) {
  let fechado = false;
  const quadro = el('iframe', {
    src: dados.fonte.url,
    allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
    allowfullscreen: true,
    referrerpolicy: 'origin-when-cross-origin',
    style: 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#000',
    title: dados.info.titulo,
  });

  const caixa = el('div', { class: 'player' }, quadro,
    el('div', { class: 'cobertura', style: 'background:linear-gradient(180deg, rgba(0,0,0,.8), transparent 18%);justify-content:flex-start;pointer-events:none' },
      el('div', { class: 'p-topo', style: 'pointer-events:auto' },
        (() => {
          const b = el('button', { class: 'pbtn', title: 'Voltar (Esc)', 'aria-label': 'Voltar' }, icone('voltar'));
          b.addEventListener('click', () => fechar());
          return b;
        })(),
        el('div', { class: 'info' },
          el('h2', {}, dados.info.titulo),
          el('div', { class: 'sub' }, dados.info.subtitulo ?? 'Ao vivo'),
          el('div', { class: 'linha', style: 'margin-top:6px' },
            el('span', { class: 'etiqueta vivo' }, 'AO VIVO'),
            dados.info.classificacao !== undefined ? etiquetaIdade(dados.info.classificacao) : null,
            el('span', { class: 'etiqueta', title: 'A transmissão é do player oficial da emissora' }, 'Player da emissora'))),
        (() => {
          const b = el('button', { class: 'btn pequeno vazio' }, icone('tela'), 'Tela cheia');
          // Aqui o conteúdo é o player da emissora dentro de um quadro: não há <video> nosso
          // para mandar a tela cheia, então no iPhone o botão de tela cheia é o da emissora.
          b.addEventListener('click', () => alternarTelaCheia(caixa, null));
          return b;
        })())));

  document.body.append(caixa);
  document.body.style.overflow = 'hidden';
  window.playtechvipPlayer = { fechar: () => fechar(), alternar: () => {}, parar: () => fechar() };

  const inicio = Date.now();
  const ping = setInterval(async () => {
    if (fechado) return;
    try {
      await api.post('/play/ping', { sessao_id: dados.sessao_id, segundos: Math.floor((Date.now() - inicio) / 1000) });
    } catch (err) {
      if (err.status === 409) { fechar(); toast('Esta tela foi encerrada em outro aparelho.', true); }
    }
  }, 30_000);

  const teclas = (e) => { if (e.key === 'Escape' && !document.fullscreenElement) fechar(); };
  document.addEventListener('keydown', teclas);

  let resolverFim;
  const fim = new Promise((r) => { resolverFim = r; });
  async function fechar() {
    if (fechado) return;
    fechado = true;
    clearInterval(ping);
    document.removeEventListener('keydown', teclas);
    try { await api.post('/play/fechar', { sessao_id: dados.sessao_id, motivo: 'fim' }); } catch { /* segue */ }
    if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch { /* segue */ } }
    caixa.remove();
    document.body.style.overflow = '';
    window.playtechvipPlayer = null;
    aoFechar?.();
    resolverFim({ titulo_id: null });
  }
  return fim;
}

/** Botão "Assistir" pronto, com o tratamento de erro padrão. */
export function botaoAssistir(rotulo, alvo, { classe = 'btn primario grande', aoFechar } = {}) {
  const b = el('button', { class: classe }, icone('tocar'), rotulo);
  b.addEventListener('click', () => acao(b, () => tocar({ ...alvo, aoFechar })));
  return b;
}
