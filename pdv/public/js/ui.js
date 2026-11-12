/** Criação de elementos e formatação comuns às telas. Texto vindo da API entra sempre como texto, nunca como HTML. */
export function el(tag, attrs = {}, ...filhos) {
  const e = ['svg', 'path', 'rect', 'circle', 'g'].includes(tag) ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.setAttribute('class', v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k === 'value' && 'value' in e) e.value = v;
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
export const inteiro = (n) => (n ?? 0).toLocaleString('pt-BR');
export const dataHora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
export const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—');
export const somarDias = (d, n) => { const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate() + n); return x.toLocaleDateString('en-CA'); };
/**
 * Hoje no fuso do servidor: o PDV fecha o caixa e a conferência pelo dia do provedor, não pelo do computador.
 * O desvio vem de /api/publico no começo da sessão (quase sempre zero).
 */
let desvioDias = 0;
const dataDoNavegador = () => new Date().toLocaleDateString('en-CA');
export const definirHoje = (data) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data ?? ''))) return;
  desvioDias = Math.round((Date.parse(`${data}T12:00:00Z`) - Date.parse(`${dataDoNavegador()}T12:00:00Z`)) / 86400000);
};
export const hojeLocal = () => (desvioDias ? somarDias(dataDoNavegador(), desvioDias) : dataDoNavegador());
export const iniciais = (nome) => String(nome ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
/** Duração em h:mm:ss (ou m:ss). */
export function duracao(s) {
  const t = Math.max(0, Math.round(s ?? 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), seg = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(seg).padStart(2, '0')}` : `${m}:${String(seg).padStart(2, '0')}`;
}
export const minutos = (s) => `${inteiro(Math.round((s ?? 0) / 60))} min`;
export const gb = (bytes) => `${((bytes ?? 0) / 1024 ** 3).toFixed(2)}GB`;
/** Telefone com máscara simples para leitura (o valor guardado é só dígitos). */
export function telefone(t) {
  const d = String(t ?? '');
  if (/^\d{10,11}$/.test(d)) return `(${d.slice(0, 2)}) ${d.slice(2, -4)}-${d.slice(-4)}`;
  return d;
}

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
export function modal(titulo, conteudo, { largo = false } = {}) {
  return new Promise((resolve) => {
    const fundo = el('div', { class: 'modal-fundo' });
    const fechar = (v = null) => { fundo.remove(); document.removeEventListener('keydown', esc); resolve(v); };
    const esc = (e) => { if (e.key === 'Escape') fechar(); };
    document.addEventListener('keydown', esc);
    fundo.addEventListener('mousedown', (e) => { if (e.target === fundo) fechar(); });
    const caixa = el('div', { class: `modal${largo ? ' largo' : ''}`, role: 'dialog', 'aria-label': titulo }, el('h2', {}, titulo));
    caixa.append(...[].concat(typeof conteudo === 'function' ? conteudo(fechar) : conteudo).flat(Infinity).filter((f) => f !== null && f !== undefined && f !== false));
    fundo.append(caixa);
    document.body.append(fundo);
    caixa.querySelector('input:not([type=hidden]), select, textarea')?.focus();
  });
}

/**
 * Formulário num modal. `campos(f)` devolve os elementos; `enviar(dados)` salva (erros aparecem e o modal fica aberto).
 * Resolve com o retorno de enviar, ou null ao cancelar.
 */
export const formModal = (titulo, campos, enviar, { rotulo = 'Salvar', largo = false } = {}) => modal(titulo, (fechar) => {
  const f = el('form', { class: 'form' });
  const ok = el('button', { class: 'btn primario largo' }, rotulo);
  f.append(...[].concat(campos(f)).flat(Infinity).filter(Boolean),
    el('div', { class: 'linha entre', style: 'margin-top:6px' }, el('button', { type: 'button', class: 'btn', onclick: () => fechar() }, 'Cancelar'), ok));
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    acao(ok, async () => fechar((await enviar(lerForm(f), f)) ?? true));
  });
  return f;
}, { largo });

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

/** Lê os campos nomeados de um formulário como objeto (caixas de marcar viram true/false). */
export function lerForm(form) {
  const dados = Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
  for (const c of form.querySelectorAll('input[type=checkbox][name]')) dados[c.name] = c.checked;
  return dados;
}

export const campo = (rotulo, attrs = {}) => el('label', { class: 'campo' }, rotulo, el('input', attrs));
export const area = (rotulo, attrs = {}, valor = '') => { const t = el('textarea', attrs); t.value = valor ?? ''; return el('label', { class: 'campo' }, rotulo, t); };
export const marcar = (rotulo, attrs = {}) => el('label', { class: 'marcar' }, el('input', { type: 'checkbox', ...attrs }), rotulo);
export function escolha(rotulo, nome, opcoes, valor, attrs = {}) {
  const s = el('select', { name: nome, ...attrs }, Object.entries(opcoes).map(([v, t]) => el('option', { value: v }, t)));
  s.value = valor === null || valor === undefined ? '' : String(valor);
  return rotulo ? el('label', { class: 'campo' }, rotulo, s) : s;
}
/** Centavos ↔ reais nos campos de valor. */
export const reaisCampo = (c) => (c === null || c === undefined ? '' : ((c ?? 0) / 100).toFixed(2).replace('.', ','));
export const centavos = (txt) => (txt === '' || txt === undefined ? undefined : Math.round(Number(String(txt).replace(/\./g, '').replace(',', '.')) * 100));

/** Repete fn a cada ms enquanto a página está visível (consulta o servidor para atualizar a tela). */
export function repetir(fn, ms) {
  let parado = false;
  let timer;
  const ciclo = async () => {
    if (parado) return;
    if (document.visibilityState === 'visible') { try { await fn(); } catch { /* próxima tentativa */ } }
    if (!parado) timer = setTimeout(ciclo, ms);
  };
  ciclo();
  return () => { parado = true; clearTimeout(timer); };
}

/** Barra de uso (ex.: disco 0,42/1,00GB 42%). */
export function barraUso(usado, limite, { formato = (x) => String(x), sufixo = '' } = {}) {
  const pct = limite > 0 ? Math.min(100, Math.round((usado / limite) * 100)) : (usado > 0 ? 100 : 0);
  return el('div', { class: `uso${pct >= 100 && (limite > 0 || usado > 0) ? ' cheio' : ''}` },
    el('div', { class: 'numeros' }, el('span', {}, `${formato(usado)}/${formato(limite)}${sufixo}`), el('span', {}, `${pct}%`)),
    el('div', { class: 'trilho' }, el('span', { style: `width:${pct}%` })));
}

// Ícones de traço (fixos, não vêm da API).
const P = {
  dashboard: 'M3 3v18h18M7 15l4-4 3 3 6-6',
  pdv: 'M4 7h16l-1.2 12.2a2 2 0 0 1-2 1.8H7.2a2 2 0 0 1-2-1.8zM9 7V5a3 3 0 0 1 6 0v2M9.5 12h5',
  caixa: 'M3 7h18v12H3zM3 11h18M8 15h3M7 7l1.5-3h7L17 7',
  recebimentos: 'M6 2h9l5 5v15H6zM14 2v6h6M9 12h6M9 16h4',
  conferencia: 'M4 5h10M4 10h10M4 15h6M14 18l3 3 5-6',
  maquininha: 'M6 2h12v20H6zM9 6h6M8 10h8M8 14h3M14 14h2M8 18h3',
  cartao: 'M2 6h20v12H2zM2 10h20M6 15h4',
  dinheiro: 'M2 6h20v12H2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM5 9h.01M19 15h.01',
  pix: 'M12 2.5 21.5 12 12 21.5 2.5 12zM8 12l4 4 4-4-4-4z',
  cadastros: 'M4 6h16M4 12h16M4 18h10M18 16v4M16 18h4',
  configuracoes: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  empresas: 'M4 7h16v12H4zM9 7V5h6v2M4 12h16',
  usuarios: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  cliente: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  buscar: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  imprimir: 'M7 9V3h10v6M7 19H5a2 2 0 0 1-2-2v-5h18v5a2 2 0 0 1-2 2h-2M7 15h10v6H7z',
  alerta: 'M12 3 2 21h20zM12 10v5M12 18h.01',
  ok: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12l3 3 5-6',
  relogio: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  sincronizar: 'M3 12a9 9 0 0 1 15-6.7L21 8M21 4v4h-4M21 12a9 9 0 0 1-15 6.7L3 16M3 20v-4h4',
  editar: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  lixo: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  abaixo: 'M6 9l6 6 6-6',
  seta: 'M15 18l-6-6 6-6',
  entrar: 'M10 17l5-5-5-5M15 12H3M14 3h6v18h-6',
  baixar: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  cadeado: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
  sol: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  lua: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  seguranca: 'M12 3l8 3v6c0 5-3.4 8.3-8 9-4.6-.7-8-4-8-9V6z',
};
export function icone(nome) {
  return el('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    el('path', { d: P[nome] ?? '' }));
}

/** Marca: cupom fiscal + nome (a primeira palavra em destaque, o resto como subtítulo). */
export function marca(nome = 'Payax PDV') {
  const [principal, ...resto] = String(nome).trim().split(/\s+/);
  const svg = el('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.9', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    el('path', { d: 'M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4L6 21z' }),
    el('path', { d: 'M9.5 8h5M9.5 12h5' }));
  return el('span', { class: 'marca' }, el('span', { class: 'simbolo' }, svg),
    el('span', { class: 'texto' }, el('strong', {}, principal), resto.length ? el('small', {}, resto.join(' ')) : null));
}

/** Pessoa com as iniciais num círculo (listas de operadores e usuários). */
export const pessoa = (nome, extra) => el('span', { class: 'pessoa' }, el('span', { class: 'iniciais' }, iniciais(nome)),
  el('span', {}, nome, extra ? el('div', { class: 'pequeno mudo' }, extra) : null));
/** Situação com ponto colorido, sem fundo. */
export const situacao = (texto, tipo = '') => el('span', { class: `situacao ${tipo}` }, texto);

// ---- Vocabulário do PDV ----
export const FORMAS = { dinheiro: 'Dinheiro', pix: 'PIX', debito: 'Cartão de débito', credito: 'Cartão de crédito', transferencia: 'Transferência', outro: 'Outro' };
export const FORMAS_CURTAS = { dinheiro: 'Dinheiro', pix: 'PIX', debito: 'Débito', credito: 'Crédito', transferencia: 'Transferência', outro: 'Outro' };
export const ICONE_FORMA = { dinheiro: 'dinheiro', pix: 'pix', debito: 'cartao', credito: 'cartao', transferencia: 'sincronizar', outro: 'recebimentos' };
export const PERFIS = { master: 'Master', suporte: 'Suporte', admin: 'Administrador', supervisor: 'Supervisor', operador: 'Operador de caixa' };
export const ADQUIRENTES = { stone: 'Stone', cielo: 'Cielo', rede: 'Rede', getnet: 'GetNet', pagbank: 'PagBank', mercadopago: 'Mercado Pago', sipag: 'Sipag', safrapay: 'SafraPay', outro: 'Outro' };
export const MODOS_TERMINAL = { agente: 'Aplicativo na maquininha', webhook: 'Adquirente (webhook)', manual: 'Digitado pelo operador' };
export const STATUS_IXC = {
  pendente: ['Aguardando baixa', 'aviso'], enviando: ['Enviando ao IXC', 'info'], baixado: ['Baixado no IXC', 'ok'], parcial: ['Baixa parcial', 'aviso'],
  erro: ['Erro na baixa', 'erro'], manual: ['Baixa manual', 'ok'], avulso: ['Sem fatura', ''], estornado: ['Estornado', ''],
};
export const STATUS_CARTAO = {
  pendente: ['Esperando a maquininha', 'aviso'], enviada: ['Na maquininha', 'info'], aprovada: ['Aprovada', 'ok'], negada: ['Negada', 'erro'],
  cancelada: ['Cancelada', ''], expirada: ['Expirada', 'erro'], estornada: ['Estornada', ''],
};
export const CONFERENCIA = { pendente: ['Não conferido', ''], conferido: ['Conferido', 'ok'], divergente: ['Divergente', 'erro'] };
export const STATUS_CAIXA = { aberto: ['Aberto', 'info'], fechado: ['Fechado', ''], conferido: ['Conferido', 'ok'] };
export const etiqueta = (texto, tipo = '') => el('span', { class: `etiqueta ${tipo}` }, texto);
export const etiquetaDe = (mapa, chave) => etiqueta(mapa[chave]?.[0] ?? chave ?? '—', mapa[chave]?.[1] ?? '');
/** Data 'AAAA-MM-DD' no formato do balcão. */
export const dataBr = (d) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '—');
/** Quantos dias de atraso (negativo = ainda vai vencer). */
export const diasAte = (d) => Math.floor((Date.parse(`${d}T12:00:00`) - Date.parse(`${hojeLocal()}T12:00:00`)) / 86400000);
export const documento = (d) => {
  const t = String(d ?? '').replace(/\D/g, '');
  if (t.length === 11) return t.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (t.length === 14) return t.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return t || '';
};
