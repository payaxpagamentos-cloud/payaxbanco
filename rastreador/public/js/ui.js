/** Criação de elementos e formatação comuns às telas. Texto vindo da API entra sempre como texto, nunca como HTML. */
export function el(tag, attrs = {}, ...filhos) {
  const e = tag === 'svg' || tag === 'path' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
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
/** Telefone com máscara simples para leitura (o valor guardado é só dígitos). */
export function telefone(t) {
  const d = String(t ?? '');
  if (/^\d{10,11}$/.test(d)) return `(${d.slice(0, 2)}) ${d.slice(2, -4)}-${d.slice(-4)}`;
  return d;
}
export const km = (m) => `${((m ?? 0) / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km`;
export const kmh = (v) => `${Math.round(v ?? 0)} km/h`;
export const data = (d) => (d ? d.split('-').reverse().join('/') : '—');
/** Placa com o traço da leitura: ABC-1234 (antiga) ou ABC1D23 (Mercosul). */
export const placa = (p) => (/^[A-Z]{3}\d{4}$/.test(p ?? '') ? `${p.slice(0, 3)}-${p.slice(3)}` : p ?? '');
/** Há quanto tempo (agora, há 5 min, há 3 h, há 2 dias). */
export function desde(iso) {
  if (!iso) return 'nunca';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return `há ${Math.floor(s / 86400)} dia${s >= 172800 ? 's' : ''}`;
}

export const TIPOS_EMPRESA = { frota: 'Frota', pessoa: 'Pessoa física', locadora: 'Locadora' };
export const PERFIS = { master: 'Master', suporte: 'Suporte', cliente: 'Administrador da empresa', operador: 'Operador (monitoramento)' };
export const TIPOS_VEICULO = { carro: 'Carro', moto: 'Moto', caminhao: 'Caminhão', van: 'Van / utilitário', onibus: 'Ônibus', maquina: 'Máquina', outro: 'Outro' };
export const PROTOCOLOS = { gt06: 'GT06 (TCP)', osmand: 'Celular / OsmAnd (HTTP)', api: 'API (outro sistema)' };
export const SITUACOES = {
  movimento: ['Em movimento', 'ok'], ligado: ['Parado ligado', 'aviso'], parado: ['Parado', ''], sem_sinal: ['Sem sinal', 'erro'],
  sem_posicao: ['Aguardando posição', ''], sem_rastreador: ['Sem rastreador', ''], inativo: ['Inativo', ''],
};
export const TIPOS_ALERTA = {
  velocidade: 'Excesso de velocidade', cerca_entrada: 'Entrada na cerca', cerca_saida: 'Saída da cerca', ignicao_ligada: 'Ignição ligada',
  ignicao_desligada: 'Ignição desligada', fora_horario: 'Uso fora do horário', panico: 'Botão de pânico', bateria_desconectada: 'Bateria desconectada',
  bateria_baixa: 'Bateria baixa', sem_comunicacao: 'Sem comunicação', violacao: 'Violação do equipamento',
};
// Alertas que pedem atenção imediata (vermelhos).
export const ALERTAS_GRAVES = ['panico', 'bateria_desconectada', 'violacao'];
export const TIPOS_COMANDO = { bloquear: 'Bloquear', desbloquear: 'Desbloquear', localizar: 'Pedir posição', reiniciar: 'Reiniciar equipamento', personalizado: 'Personalizado' };
export const STATUS_COMANDO = {
  pendente: ['Aguardando envio', 'aviso'], enviado: ['Enviado', 'info'], confirmado: ['Confirmado', 'ok'], falhou: ['Falhou', 'erro'], expirado: ['Expirado', 'erro'],
  cancelado: ['Cancelado', ''],
};
export const etiqueta = (texto, tipo = '') => el('span', { class: `etiqueta ${tipo}` }, texto);
export const etiquetaSituacao = (s) => etiqueta(SITUACOES[s]?.[0] ?? s, SITUACOES[s]?.[1]);
export const etiquetaComando = (s) => etiqueta(STATUS_COMANDO[s]?.[0] ?? s, STATUS_COMANDO[s]?.[1]);
export const etiquetaAlerta = (t) => etiqueta(TIPOS_ALERTA[t] ?? t, ALERTAS_GRAVES.includes(t) ? 'erro' : 'aviso');

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
  mapa: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14',
  historico: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3',
  alertas: 'M12 3a6 6 0 0 0-6 6v4l-2 3h16l-2-3V9a6 6 0 0 0-6-6zM10 19a2 2 0 0 0 4 0',
  veiculos: 'M5 16h14M3 13l2-6h14l2 6v5h-3M6 18H3v-5M7 18a2 2 0 1 0 4 0 2 2 0 0 0-4 0zM13 18a2 2 0 1 0 4 0 2 2 0 0 0-4 0z',
  motoristas: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  cercas: 'M12 21s-7-5.6-7-11a7 7 0 0 1 14 0c0 5.4-7 11-7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  manutencao: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z',
  relatorios: 'M6 2h9l5 5v15H6zM14 2v6h6M9 13h7M9 17h7',
  comandos: 'M4 17l6-6-6-6M12 19h8',
  configuracoes: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  integracoes: 'M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0zM12 16v5',
  empresas: 'M4 7h16v12H4zM9 7V5h6v2M4 12h16',
  rastreadores: 'M7 3h10v18H7zM11 18h2M12 3V1M5 8a8 8 0 0 0 0 8M19 8a8 8 0 0 1 0 8',
  usuarios: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4-6.3',
  diagnostico: 'M3 4h18v12H3zM8 20h8M12 16v4M7 10h2l2-3 2 6 2-3h2',
  seguranca: 'M6 10V8a6 6 0 0 1 12 0v2M5 10h14v11H5zM12 14v3',
  editar: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  cadeado: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
  aberto: 'M7 11V8a5 5 0 0 1 9.6-2M5 11h14v10H5z',
  lixo: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  sol: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  lua: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  seta: 'M15 18l-6-6 6-6',
  entrar: 'M10 17l5-5-5-5M15 12H3M14 3h6v18h-6',
  baixar: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  olho: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  compartilhar: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4',
  alvo: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 1v4M12 19v4M1 12h4M19 12h4',
  play: 'M7 4l13 8-13 8z',
  pausa: 'M7 4h3v16H7zM14 4h3v16h-3z',
  check: 'M4 12l5 5L20 6',
};
export function icone(nome) {
  return el('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    el('path', { d: P[nome] ?? '' }));
}
export function marca(nome = 'Rastreador') {
  const svg = el('svg', { viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true' },
    el('path', { d: 'M12 1.5a7.5 7.5 0 0 0-7.5 7.5c0 5.6 6.4 12.6 6.7 12.9.4.4 1.2.4 1.6 0 .3-.3 6.7-7.3 6.7-12.9A7.5 7.5 0 0 0 12 1.5zm0 4.7a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6z' }));
  return el('span', { class: 'marca' }, svg, el('span', {}, nome));
}
