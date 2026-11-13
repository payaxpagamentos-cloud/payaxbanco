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
export const hojeLocal = () => new Date().toLocaleDateString('en-CA');
export const somarDias = (d, n) => { const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate() + n); return x.toLocaleDateString('en-CA'); };
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

export const ESTADOS = {
  bot: ['ZOE', 'info'], aguardando: ['Na fila', 'aviso'], humano: ['Com atendente', 'ok'], encerrada: ['Encerrada', ''],
};
export const RESOLVIDA_POR = {
  ia: 'Resolvida pela IA', cliente: 'Cliente se despediu', humano: 'Resolvida pela equipe', abandono: 'Cliente parou de responder',
};
export const PERFIS = {
  master: 'Master', suporte: 'Suporte', cliente: 'Administrador da empresa', supervisor: 'Supervisor (só consulta)', atendente: 'Atendente',
};
export const PRIORIDADES = { baixa: 'Baixa', normal: 'Normal', alta: 'Alta' };
export const STATUS_MENSAGEM = {
  recebida: ['Recebida', ''], fila: ['Enviando…', 'info'], enviada: ['Enviada', ''], entregue: ['Entregue', ''],
  lida: ['Lida', 'ok'], falhou: ['Falhou', 'erro'],
};
export const AUTORES = { cliente: 'Cliente', ia: 'ZOE', atendente: 'Atendente', sistema: 'Sistema' };
export const TIPOS_MENSAGEM = {
  texto: 'Texto', imagem: 'Imagem', audio: 'Áudio', video: 'Vídeo', documento: 'Documento', figurinha: 'Figurinha',
  localizacao: 'Localização', contato: 'Contato', botao: 'Opção escolhida', template: 'Template', sistema: 'Sistema', nao_suportado: 'Não suportado',
};
export const STATUS_CHAMADO = { aberto: ['Aberto', 'aviso'], andamento: ['Em andamento', 'info'], resolvido: ['Resolvido', 'ok'], cancelado: ['Cancelado', ''] };
export const DIAS_CURTOS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
export const DIAS_NOMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

export const etiqueta = (texto, tipo = '') => el('span', { class: `etiqueta ${tipo}` }, texto);
const deMapa = (mapa, chave, cru) => etiqueta(mapa[chave]?.[0] ?? cru ?? chave, mapa[chave]?.[1] ?? '');
export const etiquetaEstado = (e) => deMapa(ESTADOS, e);
export const etiquetaMensagem = (s) => deMapa(STATUS_MENSAGEM, s);
export const etiquetaChamado = (s) => deMapa(STATUS_CHAMADO, s);

/** Nota do CSAT como estrelas. */
export const estrelas = (nota) => (nota ? el('span', { class: 'estrelas', title: `${nota} de 5` }, '★'.repeat(nota) + '☆'.repeat(5 - nota)) : el('span', { class: 'mudo' }, '—'));

/** Dias da semana de uma fila ('0111110') como letras marcadas. */
export const diasSemana = (dias) => el('span', { class: 'dias' }, [...String(dias ?? '0000000')].map((x, i) =>
  el('i', { class: x === '1' ? 'on' : '', title: DIAS_NOMES[i] }, DIAS_CURTOS[i])));

/** "há 3 min", "há 2 h", "ontem" — para a caixa de entrada. */
export function desde(iso) {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86_400) return `há ${Math.floor(s / 3600)} h`;
  if (s < 172_800) return 'ontem';
  return dataHora(iso);
}

/** Tempo de espera, com destaque quando passa do limite. */
export const espera = (segundos, limiteMin = 10) => el('span', { class: `situacao${segundos > limiteMin * 60 ? ' erro' : segundos > (limiteMin / 2) * 60 ? ' aviso' : ''}` }, duracao(segundos));

/** Porcentagem com uma casa. */
export const porcento = (v) => `${Number(v ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

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
/**
 * Lê um número como a pessoa digitou. "1.234,56" e "1234,56" são reais; "655.00" e "0.0068" são
 * o jeito de escrever dólar. Tratar todo ponto como milhar transformava US$ 655.00 em 65.500.
 */
export function lerNumero(txt) {
  const t = String(txt ?? '').trim().replace(/[^\d.,-]/g, '');
  if (!t) return NaN;
  if (t.includes(',')) return Number(t.replace(/\./g, '').replace(',', '.'));
  const partes = t.split('.');
  // Só ponto: um ponto com 1 ou 2 casas (ou começando em "0.") é decimal; senão é milhar.
  if (partes.length === 2 && (partes[1].length !== 3 || partes[0] === '0' || partes[0] === '')) return Number(t);
  return Number(t.replace(/\./g, ''));
}
export const centavos = (txt) => (txt === '' || txt === undefined ? undefined : Math.round(lerNumero(txt) * 100));

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
  caixa: 'M3 12h4l2 3h6l2-3h4M3 12l2.5-7h13L21 12v7H3z',
  conversa: 'M21 12a8 8 0 0 1-8 8H8l-5 2 1.6-4.3A8 8 0 1 1 21 12z',
  ia: 'M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8zM19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9zM5 15l.7 1.6 1.6.7-1.6.7L5 19.6l-.7-1.6-1.6-.7 1.6-.7z',
  conhecimento: 'M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2zM18 17H6M9 7h6M9 11h6',
  filas: 'M4 6h16M4 12h10M4 18h6M20 12l-3-3v6z',
  contatos: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4-6.3',
  chamados: 'M6 2h9l5 5v15H6zM14 2v6h6M9 13h7M9 17h5',
  equipe: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  etiqueta: 'M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01',
  relatorios: 'M6 2h9l5 5v15H6zM14 2v6h6M9 13h7M9 17h7',
  seguranca: 'M6 10V8a6 6 0 0 1 12 0v2M5 10h14v11H5zM12 14v3',
  diagnostico: 'M3 4h18v12H3zM8 20h8M12 16v4M7 10h2l2-3 2 6 2-3h2',
  configuracoes: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  integracoes: 'M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0zM12 16v5',
  empresas: 'M4 7h16v12H4zM9 7V5h6v2M4 12h16',
  numero: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2',
  enviar: 'M4 12l16-8-6 16-3-6z',
  anexo: 'M21 11l-8.5 8.5a4 4 0 0 1-5.7-5.7l8.5-8.5a2.8 2.8 0 0 1 4 4l-8.5 8.5a1.5 1.5 0 0 1-2.1-2.1l7.8-7.8',
  nota: 'M4 4h12l4 4v12H4zM8 10h8M8 14h5',
  transferir: 'M4 7h12l-3-3M20 17H8l3 3',
  voltar: 'M9 14l-5-5 5-5M4 9h11a5 5 0 0 1 0 10H9',
  encerrar: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12h8',
  relogio: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  ok: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12l3 3 5-6',
  alerta: 'M12 3l9 16H3zM12 9v5M12 17h.01',
  robo: 'M8 11h.01M16 11h.01M6 8h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM12 4v4M9 15h6',
  pessoa: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 21a7 7 0 0 1 14 0',
  estrela: 'M12 3l2.6 6.1 6.4.6-4.9 4.3 1.5 6.4L12 17l-5.6 3.4 1.5-6.4L3 9.7l6.4-.6z',
  dinheiro: 'M12 3v18M16.5 7.5c-.8-1.2-2.4-2-4.5-2-2.5 0-4 1.3-4 3s1.5 2.6 4 3 4 1.4 4 3.2-1.6 3.3-4 3.3c-2.2 0-3.9-.9-4.6-2.3',
  editar: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  mais: 'M12 5v14M5 12h14',
  abaixo: 'M6 9l6 6 6-6',
  cadeado: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
  aberto: 'M7 11V8a5 5 0 0 1 9.6-2M5 11h14v10H5z',
  lixo: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  sol: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  lua: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  seta: 'M15 18l-6-6 6-6',
  entrar: 'M10 17l5-5-5-5M15 12H3M14 3h6v18h-6',
  baixar: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  olho: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  busca: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  raio: 'M13 2 4 14h7l-1 8 9-12h-7z',
  teste: 'M10 2h4v6l5 10a2 2 0 0 1-1.8 3H6.8A2 2 0 0 1 5 18l5-10zM9 14h6',
};
export function icone(nome) {
  return el('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    el('path', { d: P[nome] ?? '' }));
}
/** Marca: balão de conversa com um brilho (a ZOE) + nome. */
export function marca(nome = 'ZOE Atende') {
  const [principal, ...resto] = String(nome).trim().split(/\s+/);
  const svg = el('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.9', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    el('path', { d: 'M21 11.5a8 8 0 0 1-8 8H8.5L4 21.5l1.4-3.9A8 8 0 1 1 21 11.5z' }),
    el('path', { d: 'M12.2 6.6l1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1z', fill: 'currentColor', stroke: 'none' }));
  return el('span', { class: 'marca' }, el('span', { class: 'simbolo' }, svg),
    el('span', { class: 'texto' }, el('strong', {}, principal), resto.length ? el('small', {}, resto.join(' ')) : null));
}

/** Pessoa com as iniciais num círculo (tabelas de ramais, agentes e usuários). */
export const pessoa = (nome, extra) => el('span', { class: 'pessoa' }, el('span', { class: 'iniciais' }, iniciais(nome)),
  el('span', {}, nome, extra ? el('div', { class: 'pequeno mudo' }, extra) : null));
/** Situação com ponto colorido, sem fundo (online, offline, em chamada). */
export const situacao = (texto, tipo = '') => el('span', { class: `situacao ${tipo}` }, texto);
