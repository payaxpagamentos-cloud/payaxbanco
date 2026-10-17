/** Criação de elementos e formatação comuns às páginas. Texto vindo da API entra sempre como texto, nunca como HTML. */
export function el(tag, attrs = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const f of filhos.flat(Infinity)) if (f !== null && f !== undefined && f !== false) e.append(f instanceof Node ? f : String(f));
  return e;
}

export const $ = (s, raiz = document) => raiz.querySelector(s);
export const limpar = (e, ...filhos) => { e.replaceChildren(...filhos.flat(Infinity).filter((f) => f !== null && f !== undefined && f !== false)); return e; };

const real = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const dinheiro = (c) => real.format((c ?? 0) / 100 || 0); // || 0 evita "-R$ 0,00"
export const km = (m) => `${((m ?? 0) / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} km`;
export const minutos = (s) => {
  const m = Math.max(1, Math.round((s ?? 0) / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
};
export const dataHora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
export const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—');
export const hojeLocal = () => new Date().toLocaleDateString('en-CA');
export const somarDias = (d, n) => { const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate() + n); return x.toLocaleDateString('en-CA'); };
export const iniciais = (nome) => String(nome ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');

export const FORMAS = { pix: 'PIX', cartao: 'Cartão', empresa: 'Empresa' };
export const CATEGORIAS = { comum: 'Táxi comum', executivo: 'Executivo' };
export const STATUS = {
  aguardando_pagamento: ['Aguardando pagamento', 'aviso'], solicitada: ['Procurando motorista', 'aviso'], aceita: ['Motorista a caminho', 'info'], chegou: ['Motorista no local', 'info'],
  em_andamento: ['Em viagem', 'info'], finalizada: ['Finalizada', 'ok'], cancelada: ['Cancelada', 'erro'],
};
export const etiquetaStatus = (s) => el('span', { class: `etiqueta ${STATUS[s]?.[1] ?? ''}` }, STATUS[s]?.[0] ?? s);

let timerToast;
export function toast(msg, erro = false) {
  document.querySelector('.toast')?.remove();
  const t = el('div', { class: `toast${erro ? ' erro' : ''}`, role: 'status' }, msg);
  document.body.append(t);
  clearTimeout(timerToast);
  timerToast = setTimeout(() => t.remove(), erro ? 5000 : 3000);
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
export function modal(titulo, conteudo) {
  return new Promise((resolve) => {
    const fundo = el('div', { class: 'modal-fundo' });
    const fechar = (v = null) => { fundo.remove(); resolve(v); };
    fundo.addEventListener('click', (e) => { if (e.target === fundo) fechar(); });
    const caixa = el('div', { class: 'modal', role: 'dialog', 'aria-label': titulo }, el('h2', {}, titulo));
    caixa.append(...[].concat(typeof conteudo === 'function' ? conteudo(fechar) : conteudo).flat(Infinity).filter((f) => f !== null && f !== undefined && f !== false));
    fundo.append(caixa);
    document.body.append(fundo);
    caixa.querySelector('input, select, textarea, button')?.focus();
  });
}

/** Pergunta um texto (ex.: motivo). */
export const perguntar = (titulo, rotulo, { obrigatorio = true, valor = '' } = {}) => modal(titulo, (fechar) => {
  const campo = el('input', { value: valor, maxlength: 300 });
  return el('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); if (obrigatorio && !campo.value.trim()) return campo.focus(); fechar(campo.value.trim()); } },
    el('label', { class: 'campo' }, rotulo, campo),
    el('div', { class: 'linha entre' }, el('button', { type: 'button', class: 'btn', onclick: () => fechar() }, 'Voltar'), el('button', { class: 'btn primario' }, 'Confirmar')));
});

export const confirmar = (titulo, texto, rotulo = 'Confirmar') => modal(titulo, (fechar) => [
  el('p', { class: 'mudo' }, texto),
  el('div', { class: 'linha entre' }, el('button', { class: 'btn', onclick: () => fechar(false) }, 'Voltar'), el('button', { class: 'btn primario', onclick: () => fechar(true) }, rotulo)),
]);

/** Lê os campos nomeados de um formulário como objeto. */
export const lerForm = (form) => Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));

export const SVG_TAXI = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 3h6l1 3h1.5A2.5 2.5 0 0 1 20 8.2l1 4.3V19a1 1 0 0 1-1 1h-1.5a1 1 0 0 1-1-1v-1h-11v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6.5l1-4.3A2.5 2.5 0 0 1 6.5 6H8l1-3Zm-2.4 5-.9 4h12.6l-.9-4H6.6ZM7 14.2a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Zm10 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z"/></svg>';
/** Logotipo: o SVG é fixo (não vem da API). */
export function marca(sub) {
  const selo = el('span', { class: 'selo' });
  selo.innerHTML = SVG_TAXI;
  return el('span', { class: 'marca' }, selo, el('span', {}, 'APP Táxi'), sub ? el('span', { class: 'etiqueta' }, sub) : null);
}

/** Repete fn a cada ms enquanto a página está visível (consulta o servidor para atualizar a tela). */
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
