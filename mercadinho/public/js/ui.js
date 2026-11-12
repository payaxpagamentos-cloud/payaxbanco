/** Criação de elementos e formatação. Texto vindo da API entra sempre como texto, nunca como HTML. */
export function el(tag, attrs = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const f of filhos.flat(Infinity)) if (f !== null && f !== undefined && f !== false) e.append(f instanceof Node ? f : String(f));
  return e;
}

export const $ = (s, raiz = document) => raiz.querySelector(s);
export const $$ = (s, raiz = document) => [...raiz.querySelectorAll(s)];
export const limpar = (e, ...filhos) => { e.replaceChildren(...filhos.flat(Infinity).filter((f) => f !== null && f !== undefined && f !== false)); return e; };

/* ---------- formatação ---------- */
const real = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const dinheiro = (c) => real.format((c ?? 0) / 100 || 0); // || 0 evita "-R$ 0,00"
export const numero = (n, casas = 0) => (n ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
/** Quantidade em milésimos vira texto curto: 1000 -> "1", 350 -> "0,35". */
export const qtd = (mil, unidade) => `${((mil ?? 0) / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 })}${unidade ? ` ${unidade}` : ''}`;
export const percentual = (bp, casas = 1) => `${((bp ?? 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`;
export const dataHora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
export const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—');
export const dataBr = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '—');
export const hojeLocal = () => new Date().toLocaleDateString('en-CA');
export const somarDias = (d, n) => { const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate() + n); return x.toLocaleDateString('en-CA'); };
export const competenciaAtual = () => hojeLocal().slice(0, 7);
export const mesPorExtenso = (comp) => new Date(`${comp}-15T12:00:00`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
export const iniciais = (nome) => String(nome ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
/** Converte o que o usuário digitou ("12,90") em centavos. */
export const paraCentavos = (texto) => Math.round(Number(String(texto ?? '0').replace(/\./g, '').replace(',', '.')) * 100) || 0;
export const emReais = (centavos) => ((centavos ?? 0) / 100).toFixed(2).replace('.', ',');

export const FORMAS = { dinheiro: 'Dinheiro', pix: 'PIX', debito: 'Cartão de débito', credito: 'Cartão de crédito', fiado: 'Conta do morador' };
export const UNIDADES = { un: 'unidade', kg: 'quilo', l: 'litro', cx: 'caixa', pct: 'pacote' };
export const PERFIS = { admin: 'Administrador', gerente: 'Gerente', caixa: 'Operador de caixa', estoque: 'Estoquista', morador: 'Morador' };

/* ---------- ícones ---------- */
const ICONES = {
  painel: 'M4 13h7V4H4v9Zm0 7h7v-5H4v5Zm9 0h7v-9h-7v9Zm0-16v5h7V4h-7Z',
  pdv: 'M3 6h2.2l.8 3h13a1.3 1.3 0 0 1 1.26 1.63l-1.7 6.1A2.2 2.2 0 0 1 16.44 18H8.9a2.2 2.2 0 0 1-2.13-1.65L4.4 7.4H3A1.2 1.2 0 0 1 3 5v1Zm4.5 5 1.4 5h7.6l1.4-5H7.5ZM9 19.2a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8Zm8 0a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8Z',
  caixa: 'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3H3V6Zm0 5h18v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7Zm5 2v2h8v-2H8Z',
  produtos: 'M12 2 3 6.5v11L12 22l9-4.5v-11L12 2Zm0 2.3 6.3 3.1L12 10.6 5.7 7.4 12 4.3ZM5 9.2l6 3v7.1l-6-3V9.2Zm8 10.1v-7.1l6-3v7.1l-6 3Z',
  estoque: 'M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z',
  compras: 'M6 4h13.2a1 1 0 0 1 .97 1.24l-1.8 7.2A2 2 0 0 1 16.43 14H8.1l-.4 2H19v2H6.2a1.6 1.6 0 0 1-1.57-1.92L5.4 12.3 3.6 5H2V3h2.6a1 1 0 0 1 .97.76L6 4Zm1.1 2 1.3 6h8.03l1.5-6H7.1ZM9 19a1.6 1.6 0 1 1 0 3.2A1.6 1.6 0 0 1 9 19Zm8 0a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2Z',
  financeiro: 'M3 5h18v4H3V5Zm0 6h18v8H3v-8Zm3 2v4h5v-4H6Zm8 0v1.5h4V13h-4Zm0 2.5V17h4v-1.5h-4Z',
  moradores: 'M12 3 3 9v12h6v-6h6v6h6V9l-9-6Zm0 2.5 6 4V19h-2v-6H8v6H6V9.5l6-4Z',
  relatorios: 'M5 3h9l5 5v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm8 1.8V9h4.2L13 4.8ZM7 12h3v6H7v-6Zm4-2h3v8h-3v-8Zm4 4h3v4h-3v-4Z',
  config: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 2.2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6ZM10.6 2h2.8l.4 2.2 1.7.7 1.9-1.2 2 2-1.2 1.9.7 1.7 2.2.4v2.8l-2.2.4-.7 1.7 1.2 1.9-2 2-1.9-1.2-1.7.7-.4 2.2h-2.8l-.4-2.2-1.7-.7-1.9 1.2-2-2 1.2-1.9-.7-1.7L2 13.4v-2.8l2.2-.4.7-1.7-1.2-1.9 2-2 1.9 1.2 1.7-.7L10.6 2Z',
  sair: 'M10 4v2H6v12h4v2H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5Zm5.6 3.6L20 12l-4.4 4.4-1.4-1.4 2-2H9v-2h7.2l-2-2 1.4-1.4Z',
  mais: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z',
  busca: 'M10.5 3a7.5 7.5 0 0 1 5.9 12.1l4.3 4.3-1.4 1.4-4.3-4.3A7.5 7.5 0 1 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z',
  lixeira: 'M9 3h6l1 2h4v2H4V5h4l1-2ZM6 8h12l-.9 12.1A2 2 0 0 1 15.1 22H8.9a2 2 0 0 1-2-1.9L6 8Z',
  editar: 'm16.8 3.2 4 4L9.5 18.5 4 20l1.5-5.5L16.8 3.2Zm0 2.8L7 15.8l-.6 2.2 2.2-.6 9.8-9.8-1.6-1.6Z',
  check: 'M9.6 16.2 5.4 12l-1.4 1.4 5.6 5.6L20.4 8.2 19 6.8 9.6 16.2Z',
  x: 'M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 5.7 18.3 4.3 16.9 10.6 10.6 4.3 4.3 5.7 2.9 12 9.2l4.9-4.9 1.4 1.4Z',
  alerta: 'M12 2 1.5 20.5h21L12 2Zm0 4.5 7 12.2H5l7-12.2ZM11 10v4h2v-4h-2Zm0 5.5V18h2v-2.5h-2Z',
  cartao: 'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2H3V6Zm0 4h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8Zm3 5v2h5v-2H6Z',
  pix: 'm12 2 4.2 4.2-2.1 2.1a3 3 0 0 0-4.2 0L7.8 6.2 12 2Zm-5.8 5.8 2.1 2.1a3 3 0 0 0 0 4.2l-2.1 2.1L2 12l4.2-4.2Zm11.6 0L22 12l-4.2 4.2-2.1-2.1a3 3 0 0 0 0-4.2l2.1-2.1ZM12 22l-4.2-4.2 2.1-2.1a3 3 0 0 0 4.2 0l2.1 2.1L12 22Z',
  dinheiro: 'M2 6h20v12H2V6Zm2 2v8h16V8H4Zm8 1a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z',
  menu: 'M3 6h18v2H3V6Zm0 5h18v2H3v-2Zm0 5h18v2H3v-2Z',
  voltar: 'M11.4 5.6 5 12l6.4 6.4 1.4-1.4L8.8 13H20v-2H8.8l4-4-1.4-1.4Z',
  baixar: 'M11 3h2v9.2l3.1-3.1 1.4 1.4L12 16l-5.5-5.5 1.4-1.4L11 12.2V3ZM5 18h14v2H5v-2Z',
  caixa2: 'M12 2 3 6v12l9 4 9-4V6l-9-4Zm0 2.2 6.2 2.8L12 9.8 5.8 7 12 4.2ZM5 8.8l6 2.7v7.9l-6-2.7V8.8Zm8 10.6v-7.9l6-2.7v7.9l-6 2.7Z',
  sol: 'M12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-2a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-1-13h2v3h-2V2Zm0 17h2v3h-2v-3ZM2 11h3v2H2v-2Zm17 0h3v2h-3v-2ZM4.2 5.6 5.6 4.2l2.1 2.1-1.4 1.4-2.1-2.1Zm12.1 12.1 1.4-1.4 2.1 2.1-1.4 1.4-2.1-2.1Zm2.1-13.5 1.4 1.4-2.1 2.1-1.4-1.4 2.1-2.1ZM4.2 18.4l2.1-2.1 1.4 1.4-2.1 2.1-1.4-1.4Z',
  lua: 'M12.3 2a8.5 8.5 0 1 0 9.7 11.6A7 7 0 0 1 12.3 2Z',
  impressora: 'M7 3h10v4H7V3ZM5 9h14a2 2 0 0 1 2 2v6h-4v4H7v-4H3v-6a2 2 0 0 1 2-2Zm4 8v2h6v-2H9Z',
  balanca: 'M12 2a3 3 0 0 1 2.8 2H20v2h-2.3l3.3 8c0 1.9-1.8 3-4 3s-4-1.1-4-3l3.3-8H14.8a3 3 0 0 1-1.8 1.8V20h4v2H7v-2h4V7.8A3 3 0 0 1 9.2 6H6.9l3.3 8c0 1.9-1.8 3-4 3s-4-1.1-4-3l3.3-8H3V4h6.2A3 3 0 0 1 12 2Z',
  usuarios: 'M9 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0 2c3.3 0 8 1.7 8 5v3H1v-3c0-3.3 4.7-5 8-5Zm8.5-2a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm.5 2c2.8.2 5 1.6 5 4.2V20h-4v-3c0-1.6-.8-2.9-2-3.8.3 0 .7-.1 1-.2Z',
  relogio: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm1 3v5.3l3.5 2.1-1 1.7L11 13V7h2Z',
  codigobarras: 'M2 4h2v16H2V4Zm3.5 0h1.2v16H5.5V4Zm2.8 0h2v16h-2V4Zm3.4 0h1.2v16h-1.2V4Zm2.6 0h2v16h-2V4Zm3.5 0h1.2v16h-1.2V4ZM20 4h2v16h-2V4Z',
};
export function icone(nome, classe) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  if (classe) svg.setAttribute('class', classe);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONES[nome] ?? ICONES.painel);
  svg.append(path);
  return svg;
}

/* ---------- peças prontas ---------- */
export const etiqueta = (texto, tom) => el('span', { class: `etiqueta${tom ? ` ${tom}` : ''}` }, texto);

/**
 * Cartão de número grande. `simbolo` é o nome de um ícone (vira o selo colorido do canto)
 * e `cor` escolhe o tom do selo: verde (padrão), azul, roxo, ambar ou vermelho.
 */
export const indicador = ({ rotulo, valor, nota, tom, simbolo, cor = '', classe = '' }) => el('div', { class: `cartao indicador ${cor} ${classe}`.trim() },
  simbolo ? el('span', { class: 'selo-icone' }, icone(simbolo)) : null,
  el('span', { class: 'rotulo' }, rotulo),
  el('span', { class: `valor${tom ? ` ${tom}` : ''}` }, valor),
  nota ? el('span', { class: 'nota' }, nota) : null);

/** Tabela com cabeçalho, linhas e aviso de lista vazia. */
export function tabela(colunas, linhas, { aoClicar, vazio = 'Nada por aqui ainda.' } = {}) {
  if (!linhas.length) return el('div', { class: 'vazio' }, el('span', { class: 'icone' }, '🗂️'), vazio);
  return el('div', { class: 'tabela-rolagem' }, el('table', {},
    el('thead', {}, el('tr', {}, colunas.map((c) => el('th', { class: c.direita ? 'direita' : null }, c.titulo)))),
    el('tbody', {}, linhas.map((linha) => el('tr', {
      class: aoClicar ? 'clicavel' : null,
      onclick: aoClicar ? () => aoClicar(linha) : null,
    }, colunas.map((c) => el('td', { class: c.direita ? 'direita' : null }, c.celula(linha))))))));
}

let timerToast;
export function toast(msg, tipo = 'ok') {
  document.querySelector('.toast')?.remove();
  const t = el('div', { class: `toast ${tipo}`, role: 'status' }, msg);
  document.body.append(t);
  clearTimeout(timerToast);
  timerToast = setTimeout(() => t.remove(), tipo === 'erro' ? 5200 : 2800);
}

/** Janela modal; resolve com o valor passado a fechar() ou null ao cancelar. */
export function modal(titulo, conteudo, { largo = false } = {}) {
  return new Promise((resolve) => {
    const fundo = el('div', { class: 'modal-fundo' });
    const fechar = (v = null) => { fundo.remove(); document.removeEventListener('keydown', aoTeclar); resolve(v); };
    const aoTeclar = (e) => { if (e.key === 'Escape') fechar(); };
    document.addEventListener('keydown', aoTeclar);
    fundo.addEventListener('click', (e) => { if (e.target === fundo) fechar(); });
    const caixa = el('div', { class: `modal${largo ? ' largo' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': titulo },
      titulo ? el('h2', {}, titulo) : null);
    caixa.append(...[].concat(typeof conteudo === 'function' ? conteudo(fechar) : conteudo).flat(Infinity).filter(Boolean));
    fundo.append(caixa);
    document.body.append(fundo);
    caixa.querySelector('input, select, textarea, button')?.focus();
  });
}

export const confirmar = (titulo, texto, rotulo = 'Confirmar', perigo = false) => modal(titulo, (fechar) => [
  el('p', { class: 'mudo' }, texto),
  el('div', { class: 'linha fim' },
    el('button', { class: 'btn fantasma', onclick: () => fechar(false) }, 'Voltar'),
    el('button', { class: `btn ${perigo ? 'perigo' : 'primario'}`, onclick: () => fechar(true) }, rotulo)),
]);

export const perguntar = (titulo, rotulo, { valor = '', obrigatorio = true, tipo = 'text', dica = null } = {}) => modal(titulo, (fechar) => {
  const campo = el('input', { value: valor, maxlength: 300, type: tipo });
  return el('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); if (obrigatorio && !campo.value.trim()) return campo.focus(); fechar(campo.value.trim()); } },
    el('label', { class: 'campo' }, rotulo, campo),
    dica ? el('p', { class: 'pequeno mudo' }, dica) : null,
    el('div', { class: 'linha fim' },
      el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
      el('button', { class: 'btn primario' }, 'Confirmar')));
});

/** Executa a ação do botão mostrando o erro, sem duplo clique. */
export async function acao(botao, fn) {
  if (botao) botao.disabled = true;
  try {
    return await fn();
  } catch (err) {
    toast(err.message, 'erro');
    return undefined;
  } finally {
    if (botao) botao.disabled = false;
  }
}

/** Lê os campos nomeados de um formulário como objeto. */
export const lerForm = (form) => Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));

export const opcoes = (lista, { selecionado = null, vazio = null, rotulo = 'nome', valor = 'id' } = {}) => [
  vazio ? el('option', { value: '' }, vazio) : null,
  ...lista.map((item) => el('option', { value: item[valor], selected: String(item[valor]) === String(selecionado) }, item[rotulo])),
];

/** Gráfico de colunas simples (sem biblioteca): uma coluna por ponto, altura proporcional ao maior valor. */
export function colunas(pontos, { formatar = dinheiro } = {}) {
  const maior = Math.max(1, ...pontos.map((p) => p.valor));
  return el('div', { class: 'colunas' }, pontos.map((p) => el('div', { class: 'col', title: `${p.rotulo}: ${formatar(p.valor)}` },
    el('div', { class: 'barra-vertical', style: `height: ${Math.max(3, Math.round((p.valor / maior) * 120))}px` }),
    el('span', { class: 'rotulo' }, p.rotulo))));
}

/** Rosca de participação, desenhada com conic-gradient. */
export function rosca(fatias, { centro = '' } = {}) {
  const total = fatias.reduce((s, f) => s + f.valor, 0) || 1;
  let acumulado = 0;
  const partes = fatias.map((f) => {
    const inicio = (acumulado / total) * 360;
    acumulado += f.valor;
    return `${f.cor} ${inicio}deg ${(acumulado / total) * 360}deg`;
  });
  return el('div', { class: 'linha', style: 'gap: 20px; flex-wrap: wrap' },
    el('div', { class: 'rosca', style: `background: conic-gradient(${partes.join(', ')})` }, el('div', { class: 'buraco' }, el('strong', {}, centro))),
    el('div', { class: 'legenda' }, fatias.map((f) => el('div', { class: 'item' },
      el('span', { class: 'cor', style: `background: ${f.cor}` }), el('span', { class: 'crescer' }, f.rotulo),
      el('strong', { class: 'num' }, dinheiro(f.valor))))));
}

/** Repete fn a cada ms enquanto a página está visível. */
export function repetir(fn, ms) {
  let parado = false;
  let timer;
  const ciclo = async () => {
    if (parado) return;
    if (document.visibilityState === 'visible') { try { await fn(); } catch { /* tenta de novo no próximo ciclo */ } }
    timer = setTimeout(ciclo, ms);
  };
  timer = setTimeout(ciclo, ms);
  return () => { parado = true; clearTimeout(timer); };
}

/** Marca (logotipo) do sistema. */
export const marca = (nome = 'Mercadinho', sub = 'do Condomínio') => el('div', { class: 'marca' },
  el('span', { class: 'selo' }, icone('pdv')),
  el('span', {}, el('div', { class: 'nome' }, nome), el('div', { class: 'sub' }, sub)));
