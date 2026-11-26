import { ehTV, nomeDaTV } from './tv.js';

/** Criação de elementos, formatação e avisos. Texto vindo da API entra sempre como texto, nunca como HTML. */
export function el(tag, attrs = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.setAttribute('style', v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const f of filhos.flat(Infinity)) if (f !== null && f !== undefined && f !== false) e.append(f instanceof Node ? f : String(f));
  return e;
}

export const $ = (s, raiz = document) => raiz.querySelector(s);
export const $$ = (s, raiz = document) => [...raiz.querySelectorAll(s)];
export const limpar = (e, ...filhos) => {
  e.replaceChildren(...filhos.flat(Infinity).filter((f) => f !== null && f !== undefined && f !== false));
  return e;
};

/** Ícone SVG (os desenhos são fixos no código, nunca vêm da API). */
const ICONES = {
  menu: 'M3.5 6.25h17v1.9h-17zm0 4.8h17v1.9h-17zm0 4.8h17v1.9h-17z',
  cadeado: 'M12 2a4.5 4.5 0 0 0-4.5 4.5V9H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1.5V6.5A4.5 4.5 0 0 0 12 2zm0 2a2.5 2.5 0 0 1 2.5 2.5V9h-5V6.5A2.5 2.5 0 0 1 12 4zm0 10a1.6 1.6 0 0 1 .8 3v1.6a.8.8 0 0 1-1.6 0V17a1.6 1.6 0 0 1 .8-3z',
  tocar: 'M8 5.5v13l11-6.5z',
  pausar: 'M7 5h3.6v14H7zm6.4 0H17v14h-3.6z',
  voltar10: 'M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7zm-1.6 10.6V11h-.9l-1.6.6.2.8 1.1-.3v3.5zm3.4.1c1.1 0 1.9-.8 1.9-2.4s-.8-2.4-1.9-2.4-1.9.8-1.9 2.4.8 2.4 1.9 2.4zm0-.9c-.5 0-.8-.5-.8-1.5s.3-1.5.8-1.5.8.5.8 1.5-.3 1.5-.8 1.5z',
  avancar10: 'M12 5V2l5 4-5 4V7a5 5 0 1 0 5 5h2a7 7 0 1 1-7-7zm-1.6 10.6V11h-.9l-1.6.6.2.8 1.1-.3v3.5zm3.4.1c1.1 0 1.9-.8 1.9-2.4s-.8-2.4-1.9-2.4-1.9.8-1.9 2.4.8 2.4 1.9 2.4zm0-.9c-.5 0-.8-.5-.8-1.5s.3-1.5.8-1.5.8.5.8 1.5-.3 1.5-.8 1.5z',
  som: 'M4 9v6h3.5L12 19V5L7.5 9zm11.5 3a3.5 3.5 0 0 0-2-3.2v6.4a3.5 3.5 0 0 0 2-3.2zm-2-7.3v2.1a5.5 5.5 0 0 1 0 10.4v2.1a7.5 7.5 0 0 0 0-14.6z',
  mudo: 'M4 9v6h3.5L12 19V5L7.5 9zm14.6 3 2.1-2.1-1.1-1.1-2.1 2.1-2.1-2.1-1.1 1.1 2.1 2.1-2.1 2.1 1.1 1.1 2.1-2.1 2.1 2.1 1.1-1.1z',
  tela: 'M4 9V4h5v2H6v3zm11-5h5v5h-2V6h-3zM4 15h2v3h3v2H4zm14 3v-3h2v5h-5v-2z',
  telaSair: 'M9 4v2H6v3H4V4zm6 0h5v5h-2V6h-3zM4 15h2v3h3v2H4zm16 0v5h-5v-2h3v-3z',
  engrenagem: 'M12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zm7.4-2.6a7.6 7.6 0 0 0 0-1.8l2-1.5a.5.5 0 0 0 .1-.6l-1.9-3.3a.5.5 0 0 0-.6-.2l-2.3.9a7.3 7.3 0 0 0-1.6-.9l-.3-2.5a.5.5 0 0 0-.5-.4h-3.8a.5.5 0 0 0-.5.4l-.3 2.5c-.6.2-1.1.5-1.6.9l-2.3-.9a.5.5 0 0 0-.6.2L3.3 9a.5.5 0 0 0 .1.6l2 1.5a7.6 7.6 0 0 0 0 1.8l-2 1.5a.5.5 0 0 0-.1.6l1.9 3.3c.1.2.4.3.6.2l2.3-.9c.5.4 1 .7 1.6.9l.3 2.5c0 .3.3.4.5.4h3.8c.3 0 .5-.2.5-.4l.3-2.5c.6-.2 1.1-.5 1.6-.9l2.3.9c.2.1.5 0 .6-.2l1.9-3.3a.5.5 0 0 0-.1-.6z',
  legenda: 'M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm2.5 6.5h3V10h-4a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h4v-1.5h-3zm7 0h3V10h-4a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h4v-1.5h-3z',
  proximo: 'M6 5l9 7-9 7zm10 0h2.5v14H16z',
  pip: 'M19 11h-8v6h8zm2-8H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H3V6.98h18z',
  fechar: 'M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z',
  voltar: 'M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z',
  busca: 'M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z',
  mais: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z',
  certo: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
  info: 'M11 7h2v2h-2zm0 4h2v6h-2zm1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z',
  lixeira: 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z',
  seta: 'M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z',
  coracao: 'M12 21.3l-1.5-1.3C5.4 15.4 2 12.3 2 8.5A4.5 4.5 0 0 1 6.5 4c1.7 0 3.3.8 4.3 2.1h2.4A5.4 5.4 0 0 1 17.5 4 4.5 4.5 0 0 1 22 8.5c0 3.8-3.4 6.9-8.5 11.5z',
  tv: 'M21 3H3a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 13H3V5h18zM8 21h8v-2H8z',
  baixar: 'M12 16 7 11h3.5V4h3v7H17zM5 18h14v2H5z',
  raio: 'M11 21h-1l1-7H6.5a.5.5 0 0 1-.4-.8L13 3h1l-1 7h4.5a.5.5 0 0 1 .4.8z',
};

export function icone(nome, tamanho) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (tamanho) svg.setAttribute('style', `width:${tamanho}px;height:${tamanho}px`);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONES[nome] ?? ICONES.info);
  svg.append(path);
  return svg;
}

// ---------- Formatação ----------
const real = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const dinheiro = (c) => real.format((c ?? 0) / 100 || 0);
export const numero = (n) => (n ?? 0).toLocaleString('pt-BR');

/** 5400 -> "1h 30min"; 2700 -> "45min". */
export function duracao(segundos) {
  const s = Math.max(0, Math.round(segundos ?? 0));
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h}h${m ? ` ${String(m).padStart(2, '0')}min` : ''}` : `${m || 1}min`;
}

/** 3661 -> "1:01:01" (relógio do player). */
export function relogio(segundos) {
  const s = Math.max(0, Math.floor(segundos ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const seg = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(seg).padStart(2, '0')}` : `${m}:${String(seg).padStart(2, '0')}`;
}

export const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—');
export const dataHora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
export const dataBR = (d) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR') : '—');
export const diaSemana = (d) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }) : '—');
export const hojeLocal = () => new Date().toLocaleDateString('en-CA');
export const somarDias = (d, n) => { const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate() + n); return x.toLocaleDateString('en-CA'); };
export const iniciais = (nome) => String(nome ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');

export const CLASSIFICACOES = { 0: 'L', 10: '10', 12: '12', 14: '14', 16: '16', 18: '18' };
export const etiquetaIdade = (c) => el('span', { class: `etiqueta idade ${c === 0 ? 'l' : `a${c}`}`, title: c === 0 ? 'Livre para todos os públicos' : `Não recomendado para menores de ${c} anos` },
  CLASSIFICACOES[c] ?? String(c ?? ''));
export const QUALIDADES = { sd: 'SD', hd: 'HD', fullhd: 'Full HD', '4k': '4K Ultra HD' };
export const LINHAS_QUALIDADE = { sd: '480p', hd: '720p', fullhd: '1080p', '4k': '2160p' };
export const CATEGORIAS_CANAL = { aberta: 'TV aberta', noticias: 'Notícias', esportes: 'Esportes', filmes: 'Filmes', series: 'Séries',
  infantil: 'Infantil', documentarios: 'Documentários', musica: 'Música', variedades: 'Variedades', religioso: 'Religioso', local: 'Local' };

export function marca(sub) {
  return el('span', { class: 'marca' },
    el('img', { src: `${new URL('../img/favicon.svg', import.meta.url).pathname}`, alt: '' }),
    el('span', {}, el('span', { class: 'play' }, 'PLAY'), el('span', { class: 'tv' }, ' TECH'), el('span', { class: 'vip' }, 'VIP')),
    sub ? el('span', { class: 'etiqueta' }, sub) : null);
}

/** Cor do avatar do perfil a partir do nome (sempre a mesma para o mesmo nome). */
export function corPerfil(nome, cor) {
  if (cor) return cor;
  const cores = ['#FF4D1C', '#FFC043', '#E11D3C', '#FF8A5B', '#C2410C', '#F97316'];
  const soma = [...String(nome ?? '')].reduce((a, c) => a + c.charCodeAt(0), 0);
  return cores[soma % cores.length];
}

// ---------- Avisos e janelas ----------
let timerToast;
export function toast(msg, erro = false) {
  document.querySelector('.toast')?.remove();
  const t = el('div', { class: `toast${erro ? ' erro' : ''}`, role: 'status' }, msg);
  document.body.append(t);
  clearTimeout(timerToast);
  timerToast = setTimeout(() => t.remove(), erro ? 5200 : 3000);
}

/** Executa a ação do botão mostrando o erro, sem duplo clique. */
export async function acao(botao, fn) {
  if (botao) botao.disabled = true;
  try {
    return await fn();
  } catch (err) {
    toast(err.message, true);
    return undefined;
  } finally {
    if (botao) botao.disabled = false;
  }
}

/** Janela modal; resolve com o valor passado a fechar() ou null ao cancelar. */
export function modal(titulo, conteudo, { largo = false, semCabecalho = false } = {}) {
  return new Promise((resolve) => {
    const fundo = el('div', { class: 'modal-fundo' });
    const fechar = (v = null) => {
      fundo.remove();
      document.removeEventListener('keydown', tecla);
      if (window.playtechvipModal === fechar) window.playtechvipModal = null;
      resolve(v);
    };
    // O botão Voltar do controle da TV fecha a janela antes de sair da tela.
    window.playtechvipModal = fechar;
    const tecla = (e) => { if (e.key === 'Escape') fechar(); };
    document.addEventListener('keydown', tecla);
    fundo.addEventListener('click', (e) => { if (e.target === fundo) fechar(); });
    const caixa = el('div', { class: `modal${largo ? ' largo' : ''}${semCabecalho ? ' sem-cabecalho' : ''}`, role: 'dialog', 'aria-label': titulo },
      semCabecalho
        ? el('button', { class: 'btn redondo fechar-flutuante', 'aria-label': 'Fechar', onclick: () => fechar() }, icone('fechar'))
        : el('div', { class: 'linha entre', style: 'margin-bottom:12px' },
          el('h2', { style: 'margin:0' }, titulo),
          el('button', { class: 'btn redondo vazio', 'aria-label': 'Fechar', onclick: () => fechar() }, icone('fechar'))));
    // O conteúdo pode ser uma função assíncrona (quando a janela precisa buscar algo antes de desenhar).
    const colocar = (partes) => {
      caixa.append(...[].concat(partes).flat(Infinity).filter((f) => f !== null && f !== undefined && f !== false));
      caixa.querySelector('input, select, textarea, button.primario')?.focus();
      if (ehTV) requestAnimationFrame(() => caixa.querySelector('button.primario, button, input')?.focus());
    };
    const montado = typeof conteudo === 'function' ? conteudo(fechar) : conteudo;
    if (montado && typeof montado.then === 'function') {
      caixa.append(el('p', { class: 'mudo' }, 'Carregando…'));
      montado.then((partes) => {
        caixa.querySelector('p.mudo')?.remove();
        colocar(partes);
      }).catch((err) => {
        caixa.querySelector('p.mudo')?.remove();
        caixa.append(el('div', { class: 'aviso erro' }, err.message));
      });
    } else {
      colocar(montado);
    }
    fundo.append(caixa);
    document.body.append(fundo);
  });
}

export const confirmar = (titulo, texto, rotulo = 'Confirmar', perigo = false) => modal(titulo, (fechar) => [
  el('p', { class: 'mudo' }, texto),
  el('div', { class: 'linha fim' },
    el('button', { class: 'btn vazio', onclick: () => fechar(false) }, 'Voltar'),
    el('button', { class: `btn ${perigo ? 'perigo' : 'primario'}`, onclick: () => fechar(true) }, rotulo)),
]);

export const perguntar = (titulo, rotulo, { obrigatorio = true, valor = '', tipo = 'text', dica = null } = {}) => modal(titulo, (fechar) => {
  const campo = el('input', { value: valor, maxlength: 300, type: tipo });
  const f = el('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); if (obrigatorio && !campo.value.trim()) return campo.focus(); return fechar(campo.value.trim()); } },
    el('label', { class: 'campo' }, rotulo, campo),
    dica ? el('p', { class: 'pequeno mudo', style: 'margin:0' }, dica) : null,
    el('div', { class: 'linha fim' },
      el('button', { type: 'button', class: 'btn vazio', onclick: () => fechar() }, 'Voltar'),
      el('button', { class: 'btn primario' }, 'Confirmar')));
  return f;
});

/** Lê os campos nomeados de um formulário como objeto. */
export const lerForm = (form) => Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));

/** Repete fn a cada ms enquanto a página está visível. */
export function repetir(fn, ms) {
  let parado = false;
  let timer;
  const ciclo = async () => {
    if (parado) return;
    if (document.visibilityState === 'visible') { try { await fn(); } catch { /* próxima tentativa */ } }
    timer = setTimeout(ciclo, ms);
  };
  ciclo();
  return () => { parado = true; clearTimeout(timer); };
}

/** Espera o usuário parar de digitar. */
export function atrasar(fn, ms = 350) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Copia para a área de transferência (com reserva para navegadores sem permissão). */
export async function copiar(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    toast('Copiado!');
  } catch {
    const campo = el('textarea', { style: 'position:fixed;opacity:0' });
    campo.value = texto;
    document.body.append(campo);
    campo.select();
    try { document.execCommand('copy'); toast('Copiado!'); } catch { toast('Copie manualmente.', true); }
    campo.remove();
  }
}

/** Nome do aparelho, para a lista de telas em uso. */
export function nomeDoAparelho() {
  if (ehTV) return nomeDaTV();
  const ua = navigator.userAgent;
  const sistema = /iPhone|iPad/i.test(ua) ? 'iPhone/iPad' : /Android/i.test(ua) ? 'Android' : /Mac/i.test(ua) ? 'Mac'
    : /Windows/i.test(ua) ? 'Windows' : /CrOS/i.test(ua) ? 'Chromebook' : /Linux/i.test(ua) ? 'Linux' : 'Navegador';
  const navegador = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
  return `${sistema} · ${navegador}`;
}
