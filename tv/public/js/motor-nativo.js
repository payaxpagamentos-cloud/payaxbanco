/**
 * Motores de vídeo nativos da TV.
 *
 * Nas Smart TVs, o melhor decodificador é o do próprio aparelho:
 *  - Samsung (Tizen): AVPlay, o player nativo do sistema. Aqui ele é embrulhado num objeto que
 *    imita a parte da API do <video> que o nosso player usa — assim o resto do código não muda.
 *  - Android TV (TCL, Google TV): o app nativo abre o ExoPlayer em tela cheia; a página só avisa
 *    o que tocar e recebe de volta onde parou.
 *  - LG (webOS) e as demais: o próprio <video> já é o pipeline nativo do aparelho.
 */

/** O app nativo do Android TV está por perto? */
export const temPonteAndroid = () => Boolean(window.PlayTVNative?.tocar);

/** A TV Samsung expõe o player nativo? (só dentro do app empacotado, com webapis.js carregado) */
export const temAvplay = () => Boolean(window.webapis?.avplay);

/**
 * Embrulha o AVPlay com a cara de um <video>: play, pause, currentTime, duration, volume,
 * eventos e tudo o mais que o nosso player usa. Devolve null quando não é uma Samsung.
 */
export function criarVideoTizen() {
  if (!temAvplay()) return null;
  const avplay = window.webapis.avplay;

  const objeto = document.createElement('object');
  objeto.setAttribute('type', 'application/avplayer');
  objeto.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;background:#000';

  const ouvintes = new Map();
  const emitir = (nome) => (ouvintes.get(nome) ?? []).forEach((fn) => { try { fn({ type: nome }); } catch { /* segue */ } });

  let pausado = true;
  let duracaoMs = 0;
  let pronto = false;
  let relogio = null;
  let fonte = '';
  let volume = 1;
  let mudo = false;

  const ajustarTela = () => {
    const r = objeto.getBoundingClientRect();
    try {
      avplay.setDisplayRect(Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height));
    } catch { /* a tela ainda não foi medida */ }
  };

  const comecarRelogio = () => {
    clearInterval(relogio);
    relogio = setInterval(() => { if (!pausado) emitir('timeupdate'); }, 500);
  };

  const preparar = () => {
    try {
      avplay.open(fonte);
      avplay.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
      ajustarTela();
      avplay.setListener({
        onbufferingstart: () => emitir('waiting'),
        onbufferingcomplete: () => emitir('playing'),
        onstreamcompleted: () => { pausado = true; emitir('ended'); },
        oncurrentplaytime: () => emitir('timeupdate'),
        onerror: () => emitir('error'),
      });
      avplay.prepareAsync(() => {
        pronto = true;
        try { duracaoMs = avplay.getDuration(); } catch { duracaoMs = 0; }
        emitir('loadedmetadata');
        avplay.play();
        pausado = false;
        emitir('play');
        comecarRelogio();
      }, () => emitir('error'));
    } catch {
      emitir('error');
    }
  };

  const face = {
    // ---- cara de elemento
    tagName: 'OBJECT',
    nativo: 'avplay',
    elemento: objeto,
    style: objeto.style,
    classList: objeto.classList,
    append: () => {},            // legendas do AVPlay seguem outro caminho (ver README dos apps)
    setAttribute: (k, v) => objeto.setAttribute(k, v),
    getBoundingClientRect: () => objeto.getBoundingClientRect(),
    canPlayType: () => 'probably',
    requestPictureInPicture: () => Promise.reject(new Error('sem janela flutuante na TV')),

    // ---- estado
    get paused() { return pausado; },
    get currentTime() {
      try { return (avplay.getCurrentTime() || 0) / 1000; } catch { return 0; }
    },
    set currentTime(s) {
      const alvo = Math.max(0, Math.round(s * 1000));
      try { avplay.seekTo(alvo); } catch { /* fora do alcance */ }
    },
    get duration() { return duracaoMs ? duracaoMs / 1000 : Number.POSITIVE_INFINITY; },
    get buffered() { return { length: 0, end: () => 0 }; },
    get seekable() {
      return duracaoMs ? { length: 1, end: () => duracaoMs / 1000 } : { length: 0, end: () => 0 };
    },
    get videoWidth() { return pronto ? 1920 : 0; },
    get error() { return null; },
    get textTracks() { return []; },
    playbackRate: 1,
    get volume() { return volume; },
    set volume(v) {
      volume = Math.min(1, Math.max(0, v));
      try { window.tizen?.tvaudiocontrol?.setVolume(Math.round(volume * 100)); } catch { /* sem controle de volume */ }
      emitir('volumechange');
    },
    get muted() { return mudo; },
    set muted(m) {
      mudo = Boolean(m);
      try { window.tizen?.tvaudiocontrol?.setMute(mudo); } catch { /* sem controle de volume */ }
      emitir('volumechange');
    },
    get src() { return fonte; },
    set src(url) {
      fonte = url;
      preparar();
    },

    // ---- comandos
    play() {
      try {
        if (!pronto) preparar();
        else avplay.play();
        pausado = false;
        emitir('play');
        comecarRelogio();
      } catch { emitir('error'); }
      return Promise.resolve();
    },
    pause() {
      try { avplay.pause(); } catch { /* já parado */ }
      pausado = true;
      emitir('pause');
    },
    load() {},
    removeAttribute() {},

    // ---- eventos
    addEventListener(nome, fn) {
      if (!ouvintes.has(nome)) ouvintes.set(nome, []);
      ouvintes.get(nome).push(fn);
    },
    removeEventListener(nome, fn) {
      ouvintes.set(nome, (ouvintes.get(nome) ?? []).filter((x) => x !== fn));
    },

    /** Encerra o player nativo e devolve a tela. */
    destruir() {
      clearInterval(relogio);
      try { avplay.stop(); avplay.close(); } catch { /* já fechado */ }
    },
  };

  window.addEventListener('resize', ajustarTela);
  return face;
}

/**
 * Entrega a reprodução ao app nativo do Android TV (ExoPlayer em tela cheia).
 * Resolve quando o app devolve o controle, com os segundos assistidos.
 */
export function tocarNoAndroidTV({ url, titulo, subtitulo, aoVivo, posicao = 0, sessaoId = null }) {
  return new Promise((resolve) => {
    window.playtvNativoEvento = (evento) => {
      const e = typeof evento === 'string' ? JSON.parse(evento) : evento;
      if (e?.tipo === 'progresso') window.dispatchEvent(new CustomEvent('tv:progresso-nativo', { detail: e }));
      if (e?.tipo === 'fim') {
        window.playtvNativoEvento = null;
        resolve({ segundos: Number(e.segundos) || 0, concluido: Boolean(e.concluido) });
      }
    };
    window.PlayTVNative.tocar(JSON.stringify({ url, titulo, subtitulo: subtitulo ?? '', aoVivo: Boolean(aoVivo), posicao, sessaoId }));
  });
}
