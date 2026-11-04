/**
 * Telefone do painel (WebRTC): botão no canto inferior direito que abre o teclado para ligar, e o aviso de
 * ligação recebida no meio da tela, com toque. Com o painel minimizado ou em outra aba, o navegador mostra uma
 * notificação do sistema; clicar nela traz o painel de volta para atender.
 *
 * Registra o ramal ligado ao usuário (Configurações > Usuários) no Asterisk pelo WSS configurado no servidor.
 */
import { api, BASE } from './api.js';
import { el, limpar, icone, toast, telefone as formatarTelefone } from './ui.js';

const TECLAS = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];

let atual = null; // telefone ativo (um por página)

/** Carrega a biblioteca SIP só quando o telefone é usado. */
function carregarJsSip() {
  if (window.JsSIP) return Promise.resolve(window.JsSIP);
  return new Promise((ok, falha) => {
    const s = document.createElement('script');
    s.src = `${BASE}/vendor/jssip.min.js`;
    s.onload = () => (window.JsSIP ? ok(window.JsSIP) : falha(new Error('Biblioteca do telefone não carregou.')));
    s.onerror = () => falha(new Error('Biblioteca do telefone não carregou.'));
    document.head.append(s);
  });
}

/** Toque de chamada gerado no navegador (425 Hz, 1 s tocando e 4 s em silêncio, como no Brasil). */
function criarToque() {
  let ctx = null;
  let timer = null;
  const tocarUmaVez = () => {
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const ganho = ctx.createGain();
    osc.frequency.value = 425;
    ganho.gain.setValueAtTime(0.0001, ctx.currentTime);
    ganho.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.03);
    ganho.gain.setValueAtTime(0.18, ctx.currentTime + 0.95);
    ganho.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1);
    osc.connect(ganho).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 1.05);
  };
  return {
    iniciar() {
      try {
        ctx = ctx ?? new (window.AudioContext || window.webkitAudioContext)();
        ctx.resume?.();
      } catch { ctx = null; }
      tocarUmaVez();
      clearInterval(timer);
      timer = setInterval(tocarUmaVez, 5000);
    },
    parar() { clearInterval(timer); timer = null; },
  };
}

/** Título da aba piscando enquanto toca (aparece na barra de tarefas com o navegador minimizado). */
function criarPisca() {
  let timer = null;
  let original = '';
  return {
    iniciar(texto) {
      if (timer) return;
      original = document.title;
      let on = false;
      timer = setInterval(() => { on = !on; document.title = on ? texto : original; }, 1000);
    },
    parar() { if (timer) { clearInterval(timer); timer = null; document.title = original; } },
  };
}

const segundos = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const numeroDaUri = (uri) => String(uri?.user ?? '').replace(/^\+/, '');

/** Inicia o telefone do usuário da empresa. Devolve a função que o desliga (ao sair). */
export function iniciarTelefone({ empresaId }) {
  if (atual?.empresaId === empresaId) return atual.parar;
  atual?.parar();

  const estado = { cfg: null, ua: null, sessao: null, situacao: 'carregando', numero: '', chamada: null, inicio: null, mudo: false, teclado: false };
  const toque = criarToque();
  const pisca = criarPisca();
  const audio = el('audio', { autoplay: true });
  let notificacao = null;
  let relogio = null;

  // ---------- Elementos fixos (fora da área redesenhada pelas telas) ----------
  const ponto = el('span', { class: 'ponto' });
  const botao = el('button', { class: 'telefone-botao', type: 'button', title: 'Telefone', 'aria-label': 'Abrir o telefone' }, icone('chamadas'), ponto);
  const painel = el('section', { class: 'telefone-painel oculto', role: 'dialog', 'aria-label': 'Telefone' });
  const chamada = el('div', { class: 'telefone-chamada oculto', role: 'alertdialog', 'aria-live': 'assertive' });
  const raiz = el('div', { class: 'telefone' }, painel, botao, audio);
  document.body.append(raiz, chamada);
  botao.addEventListener('click', () => {
    painel.classList.toggle('oculto');
    if (!painel.classList.contains('oculto')) {
      desenhar();
      painel.querySelector('input.numero')?.focus();
    }
  });

  const pcConfig = () => ({ iceServers: estado.cfg.stun.length ? [{ urls: estado.cfg.stun }] : [] });
  const situacaoTexto = { carregando: 'Conectando…', online: 'Online', offline: 'Desconectado', erro: 'Falha no registro', desligado: 'Indisponível' };

  // ---------- Desenho do painel ----------
  function desenhar() {
    ponto.className = `ponto ${estado.sessao ? 'em-chamada' : estado.situacao}`;
    botao.classList.toggle('em-chamada', Boolean(estado.sessao && estado.chamada?.atendida));
    if (painel.classList.contains('oculto')) return;
    const r = estado.cfg?.ramal;
    const topo = el('header', {},
      el('div', {}, el('strong', {}, r ? `Ramal ${r.numero}` : 'Telefone'), el('div', { class: 'pequeno mudo' }, r ? r.nome : '')),
      el('span', { class: `situacao ${{ online: 'ok', erro: 'erro', offline: 'erro' }[estado.situacao] ?? ''}` }, situacaoTexto[estado.situacao] ?? ''),
      el('button', { class: 'icone-btn', type: 'button', title: 'Fechar', onclick: () => painel.classList.add('oculto') }, '×'));

    let corpo;
    if (estado.situacao === 'desligado') {
      corpo = el('p', { class: 'mudo pequeno', style: 'margin:8px 0' }, estado.motivo);
    } else if (estado.sessao) {
      corpo = telaEmChamada();
    } else {
      corpo = telaDiscar();
    }
    const aviso = 'Notification' in window && Notification.permission === 'default' && estado.situacao !== 'desligado'
      ? el('button', { class: 'telefone-aviso', type: 'button', onclick: async () => { await Notification.requestPermission(); desenhar(); } },
        'Ativar aviso de ligação com o painel minimizado')
      : null;
    limpar(painel, topo, aviso, corpo);
  }

  function teclado(aoTeclar) {
    return el('div', { class: 'teclado' }, TECLAS.map(([d, letras]) => el('button', { type: 'button', class: 'tecla', onclick: () => aoTeclar(d) },
      el('span', {}, d), el('small', {}, letras || ' '))));
  }

  function telaDiscar() {
    const entrada = el('input', { class: 'numero', inputmode: 'tel', autocomplete: 'off', placeholder: 'Digite o número', value: estado.numero, 'aria-label': 'Número' });
    entrada.addEventListener('input', () => { estado.numero = entrada.value.replace(/[^\d*#+]/g, ''); entrada.value = estado.numero; });
    entrada.addEventListener('keydown', (e) => { if (e.key === 'Enter') ligar(); });
    const apagar = el('button', { type: 'button', class: 'icone-btn', title: 'Apagar', onclick: () => { estado.numero = estado.numero.slice(0, -1); entrada.value = estado.numero; entrada.focus(); } }, '⌫');
    return el('div', { class: 'discar' },
      el('div', { class: 'visor' }, entrada, apagar),
      teclado((d) => { estado.numero += d; entrada.value = estado.numero; entrada.focus(); }),
      el('button', { type: 'button', class: 'acao-ligar', title: 'Ligar', disabled: estado.situacao !== 'online', onclick: ligar }, icone('chamadas')),
      estado.situacao !== 'online' && estado.situacao !== 'carregando'
        ? el('p', { class: 'pequeno mudo', style: 'margin:8px 0 0;text-align:center' }, 'O ramal não está conectado. Tentando de novo…') : null);
  }

  function telaEmChamada() {
    const c = estado.chamada;
    const status = c.atendida ? segundos(Math.floor((Date.now() - estado.inicio) / 1000)) : c.entrada ? 'Tocando…' : 'Chamando…';
    return el('div', { class: 'em-chamada' },
      el('div', { class: 'quem' }, el('div', { class: 'avatar-chamada' }, icone('chamadas')),
        el('strong', {}, c.nome || formatarTelefone(c.numero) || c.numero), c.nome ? el('div', { class: 'mudo pequeno' }, formatarTelefone(c.numero)) : null,
        el('div', { class: 'tempo num' }, status)),
      estado.teclado ? teclado((d) => { try { estado.sessao.sendDTMF(d); } catch { /* sem DTMF */ } }) : null,
      el('div', { class: 'controles' },
        el('button', { type: 'button', class: `controle${estado.mudo ? ' on' : ''}`, disabled: !c.atendida, onclick: alternarMudo }, estado.mudo ? 'Sem mudo' : 'Mudo'),
        el('button', { type: 'button', class: `controle${estado.teclado ? ' on' : ''}`, disabled: !c.atendida, onclick: () => { estado.teclado = !estado.teclado; desenhar(); } }, 'Teclado'),
        el('button', { type: 'button', class: 'acao-desligar', title: 'Desligar', onclick: desligar }, icone('chamadas'))));
  }

  // ---------- Aviso de ligação recebida (meio da tela) ----------
  function mostrarRecebida() {
    const c = estado.chamada;
    limpar(chamada, el('div', { class: 'cartao-chamada' },
      el('div', { class: 'avatar-chamada tocando' }, icone('chamadas')),
      el('div', { class: 'mudo pequeno' }, 'Ligação recebida'),
      el('strong', { class: 'quem-liga' }, c.nome || formatarTelefone(c.numero) || 'Número oculto'),
      c.nome ? el('div', { class: 'mudo' }, formatarTelefone(c.numero)) : null,
      el('div', { class: 'pequeno mudo' }, `no ramal ${estado.cfg.ramal.numero}`),
      el('div', { class: 'botoes' },
        el('button', { type: 'button', class: 'acao-desligar grande', onclick: recusar }, icone('chamadas'), el('span', {}, 'Recusar')),
        el('button', { type: 'button', class: 'acao-ligar grande', onclick: atender }, icone('chamadas'), el('span', {}, 'Atender')))));
    chamada.classList.remove('oculto');
    chamada.querySelector('.acao-ligar')?.focus();
    toque.iniciar();
    pisca.iniciar(`📞 Ligação de ${c.nome || c.numero || 'número oculto'}`);
    // Painel minimizado, em outra aba ou sem foco: notificação do sistema (fica até atender ou recusar).
    if ('Notification' in window && Notification.permission === 'granted' && (document.hidden || !document.hasFocus())) {
      try {
        notificacao = new Notification('Ligação recebida', {
          body: `${c.nome ? `${c.nome} · ` : ''}${formatarTelefone(c.numero) || 'Número oculto'} — clique para atender`,
          tag: 'zoe-ligacao', requireInteraction: true, icon: `${BASE}/img/favicon.svg`,
        });
        notificacao.onclick = () => { window.focus(); notificacao?.close(); };
      } catch { notificacao = null; }
    }
  }
  function esconderRecebida() {
    chamada.classList.add('oculto');
    toque.parar();
    pisca.parar();
    notificacao?.close();
    notificacao = null;
  }

  // ---------- Ações ----------
  function ligar() {
    const destino = estado.numero.trim();
    if (!destino || !estado.ua || estado.situacao !== 'online' || estado.sessao) return;
    try {
      estado.ua.call(`sip:${destino}@${estado.cfg.dominio}`, {
        mediaConstraints: { audio: true, video: false }, pcConfig: pcConfig(), rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
      });
    } catch (err) {
      toast(`Não foi possível ligar: ${err.message}`, true);
    }
  }
  function atender() {
    if (!estado.sessao) return;
    esconderRecebida();
    estado.sessao.answer({ mediaConstraints: { audio: true, video: false }, pcConfig: pcConfig() });
    painel.classList.remove('oculto');
    desenhar();
  }
  function recusar() {
    try { estado.sessao?.terminate({ status_code: 486, reason_phrase: 'Busy Here' }); } catch { /* já encerrada */ }
  }
  function desligar() {
    try { estado.sessao?.terminate(); } catch { /* já encerrada */ }
  }
  function alternarMudo() {
    if (!estado.sessao) return;
    estado.mudo = !estado.mudo;
    if (estado.mudo) estado.sessao.mute({ audio: true }); else estado.sessao.unmute({ audio: true });
    desenhar();
  }

  function ligarAudio(pc) {
    pc.addEventListener('track', (e) => {
      audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      audio.play?.().catch(() => {});
    });
  }

  function novaSessao({ session, originator }) {
    const entrada = originator === 'remote';
    if (estado.sessao) {
      // Já em ligação: a segunda recebe "ocupado".
      if (entrada) session.terminate({ status_code: 486, reason_phrase: 'Busy Here' });
      return;
    }
    estado.sessao = session;
    estado.mudo = false;
    estado.teclado = false;
    estado.chamada = {
      entrada, atendida: false,
      numero: numeroDaUri(entrada ? session.remote_identity?.uri : session.remote_identity?.uri) || estado.numero,
      nome: entrada ? (session.remote_identity?.display_name || '') : '',
    };
    if (session.connection) ligarAudio(session.connection);
    session.on('peerconnection', (e) => ligarAudio(e.peerconnection));
    session.on('accepted', () => {
      estado.chamada.atendida = true;
      estado.inicio = Date.now();
      esconderRecebida();
      clearInterval(relogio);
      relogio = setInterval(desenhar, 1000);
      desenhar();
    });
    const fim = (e) => {
      clearInterval(relogio);
      esconderRecebida();
      const motivo = e?.cause;
      if (e?.originator !== 'local' && motivo && !['Terminated', 'Canceled', 'Bye'].includes(motivo) && !estado.chamada?.atendida) {
        toast(motivo === 'Busy' ? 'Ocupado.' : motivo === 'User Denied Media Access' ? 'Permita o uso do microfone para ligar.' : `Ligação não completada (${motivo}).`, true);
      }
      estado.sessao = null;
      estado.chamada = null;
      audio.srcObject = null;
      desenhar();
    };
    session.on('ended', fim);
    session.on('failed', fim);
    if (entrada) mostrarRecebida(); else painel.classList.remove('oculto');
    desenhar();
  }

  // ---------- Conexão com o Asterisk ----------
  async function conectar() {
    try {
      estado.cfg = await api.get(`/empresas/${empresaId}/telefone`);
    } catch (err) {
      estado.situacao = 'desligado';
      estado.motivo = err.message;
      return desenhar();
    }
    if (!estado.cfg.configurado) {
      estado.situacao = 'desligado';
      estado.motivo = 'O telefone do painel ainda não foi ligado no servidor. Fale com o suporte.';
      return desenhar();
    }
    if (!estado.cfg.ramal) {
      estado.situacao = 'desligado';
      estado.motivo = 'Seu usuário ainda não tem um ramal. O administrador escolhe o ramal em Configurações > Usuários.';
      return desenhar();
    }
    if (!window.RTCPeerConnection || !navigator.mediaDevices) {
      estado.situacao = 'desligado';
      estado.motivo = 'Este navegador não faz ligações. Use o Chrome, o Edge ou o Firefox atualizados (com https).';
      return desenhar();
    }
    try {
      const JsSIP = await carregarJsSip();
      const r = estado.cfg.ramal;
      const ua = new JsSIP.UA({
        sockets: [new JsSIP.WebSocketInterface(estado.cfg.wss)],
        uri: `sip:${r.usuario_sip}@${estado.cfg.dominio}`,
        password: r.senha_sip,
        display_name: r.nome,
        register: true,
        session_timers: false,
        user_agent: 'ZOE PABX (painel)',
      });
      ua.on('registered', () => { estado.situacao = 'online'; desenhar(); });
      ua.on('unregistered', () => { estado.situacao = 'offline'; desenhar(); });
      ua.on('registrationFailed', () => { estado.situacao = 'erro'; desenhar(); });
      ua.on('disconnected', () => { if (estado.situacao !== 'desligado') { estado.situacao = 'offline'; desenhar(); } });
      ua.on('newRTCSession', novaSessao);
      estado.ua = ua;
      ua.start();
    } catch (err) {
      estado.situacao = 'desligado';
      estado.motivo = err.message;
    }
    desenhar();
  }

  const parar = () => {
    clearInterval(relogio);
    esconderRecebida();
    try { estado.sessao?.terminate(); } catch { /* ignora */ }
    try { estado.ua?.stop(); } catch { /* ignora */ }
    raiz.remove();
    chamada.remove();
    if (atual?.parar === parar) atual = null;
  };
  // Fechar a aba encerra a ligação e o registro do ramal.
  window.addEventListener('pagehide', () => { try { estado.ua?.stop(); } catch { /* ignora */ } }, { once: true });
  atual = { empresaId, parar };
  desenhar();
  conectar();
  return parar;
}

/** Desliga o telefone (ao sair do painel). */
export const pararTelefone = () => atual?.parar();
