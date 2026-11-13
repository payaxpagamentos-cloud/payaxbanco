/** Componentes e formatação do PayAx. Texto vindo do servidor entra sempre como texto, nunca como HTML. */

const ICONES = {
  painel: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  boleto: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M6 8v8M9 8v8M11 8v8M14 8v8M16 8v8M18 8v8"/>',
  pix: '<path d="m12 3 4.2 4.2a3 3 0 0 0 2.1.9H19l2 2-2 2h-.7a3 3 0 0 0-2.1.9L12 17.2 7.8 13a3 3 0 0 0-2.1-.9H5l-2-2 2-2h.7a3 3 0 0 0 2.1-.9L12 3Z"/>',
  dinheiro: '<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.01M18 12h.01"/>',
  banco: '<path d="M3 10h18M5 10v8m4-8v8m6-8v8m4-8v8M2 21h20M12 3l9 5H3l9-5Z"/>',
  pessoas: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 2 4v2"/>',
  relatorio: '<path d="M5 3h9l5 5v13H5V3Zm9 0v6h5"/><path d="M8 13h8M8 17h5"/>',
  troca: '<path d="M4 8h13l-3-3m3 3-3 3M20 16H7l3-3m-3 3 3 3"/>',
  config: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z"/>',
  plugue: '<path d="m7 3 3 3m4-1 4 4M5 9l10-6 6 6-6 10-4-4-8 7m8-7-5-5"/>',
  escudo: '<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Z"/><path d="m8 11 3 3 5-5"/>',
  busca: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  mais: '<path d="M12 5v14M5 12h14"/>',
  fechar: '<path d="m6 6 12 12M6 18 18 6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  seta: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  voltar: '<path d="M19 12H5m5-5-5 5 5 5"/>',
  baixar: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  imprimir: '<path d="M7 8V3h10v5M7 18H4v-7h16v7h-3M7 14h10v7H7v-7Z"/>',
  copiar: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H3V3h12v2"/>',
  ok: '<path d="m5 12 4 4 10-10"/>',
  alerta: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3v1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
  relogio: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendario: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18"/>',
  atualizar: '<path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/>',
  sair: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"/>',
  cofre: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="12" r="4"/><path d="M12 8v1m0 6v1m4-4h-1m-6 0H8"/>',
  importar: '<path d="M12 15V3m-4 8 4 4 4-4M4 17v4h16v-4"/>',
  olho: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  lista: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
};

export function icone(nome, classe = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', '18');
  s.setAttribute('height', '18');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.6');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  if (classe) s.setAttribute('class', classe);
  s.innerHTML = ICONES[nome] ?? ICONES.lista;
  return s;
}

export function el(tag, attrs = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, val] of Object.entries(attrs ?? {})) {
    if (val === null || val === undefined || val === false) continue;
    if (k === 'class') e.className = val;
    else if (k.startsWith('on') && typeof val === 'function') e.addEventListener(k.slice(2), val);
    else if (k === 'dataset') Object.assign(e.dataset, val);
    else if ((k === 'value' || k === 'checked' || k === 'disabled') && k in e) e[k] = val;
    else if (val === true) e.setAttribute(k, '');
    else e.setAttribute(k, val);
  }
  for (const f of filhos.flat(Infinity)) if (f !== null && f !== undefined && f !== false) e.append(f instanceof Node ? f : String(f));
  return e;
}
export const $ = (s, r = document) => r.querySelector(s);
export const limpar = (e, ...f) => { e.replaceChildren(...f.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false)); return e; };

// ---------------------------------------------------------------- Formatação
const real = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const dinheiro = (c) => (c === null || c === undefined ? '—' : real.format((c || 0) / 100));
export const dinheiroCurto = (c) => {
  const v = Math.abs(c || 0) / 100;
  const s = c < 0 ? '-' : '';
  if (v >= 1_000_000) return `${s}R$ ${(v / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
  if (v >= 1000) return `${s}R$ ${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
  return real.format((c || 0) / 100);
};
export const numero = (n, casas = 0) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas }));
export const percentual = (ppm) => `${((ppm || 0) / 10000).toLocaleString('pt-BR', { maximumFractionDigits: 4 })}%`;
export const data = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '—');
export const dataCurta = (d) => (d ? String(d).slice(5, 10).split('-').reverse().join('/') : '—');
export const dataHora = (iso) => (iso ? new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)) : '—');
export const documento = (d) => {
  const t = String(d ?? '').replace(/\D/g, '');
  if (t.length === 11) return t.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (t.length === 14) return t.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return t || '—';
};
export const telefone = (t) => {
  const d = String(t ?? '').replace(/\D/g, '').replace(/^55/, '');
  if (d.length === 11) return d.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
  if (d.length === 10) return d.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
  return t || '—';
};
export const linhaDigitavel = (l) => {
  const d = String(l ?? '').replace(/\D/g, '');
  return d.length === 47
    ? `${d.slice(0, 5)}.${d.slice(5, 10)} ${d.slice(10, 15)}.${d.slice(15, 21)} ${d.slice(21, 26)}.${d.slice(26, 32)} ${d[32]} ${d.slice(33)}`
    : l ?? '—';
};
export const iniciais = (n) => String(n ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0].toUpperCase()).join('');
export const hojeIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const primeiroDiaMes = () => `${hojeIso().slice(0, 7)}-01`;
export const somarDias = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

// ---------------------------------------------------------------- Rótulos
export const R = {
  situacaoBoleto: {
    registrando: ['Registrando', 'neutra'], registrado: ['Em aberto', 'info'], a_vencer: ['A vencer', 'info'],
    vencido: ['Vencido', 'aviso'], liquidado: ['Liquidado', 'ok'], baixado: ['Baixado', 'neutra'],
    cancelado: ['Cancelado', 'neutra'], falha: ['Falha no registro', 'erro'],
  },
  situacaoRepasse: {
    aguardando_aprovacao: ['Aguardando aprovação', 'aviso'], aprovado: ['Aprovado', 'info'], enviado: ['Enviado', 'info'],
    confirmado: ['Confirmado', 'ok'], falhou: ['Falhou', 'erro'], cancelado: ['Cancelado', 'neutra'],
  },
  situacaoCliente: {
    implantacao: ['Em implantação', 'aviso'], ativo: ['Ativo', 'ok'], suspenso: ['Suspenso', 'erro'], encerrado: ['Encerrado', 'neutra'],
  },
  estadoIntegracao: {
    nao_configurada: ['Não configurada', 'neutra'], conectada: ['Conectada', 'ok'], falha: ['Falha', 'erro'], desabilitada: ['Desabilitada', 'neutra'],
  },
  tipoBoleto: { boleto: 'Boleto', bolepix: 'Bolepix (boleto + QR PIX)' },
  origem: { avulso: 'Avulso', ixc: 'IXC', api: 'API', lote: 'Lote' },
  perfilEquipe: { admin: 'Administrador', financeiro: 'Financeiro', operacao: 'Operação', consulta: 'Consulta' },
  perfilCliente: { admin: 'Administrador', operador: 'Operador', consulta: 'Consulta' },
};

/** Selo de estado: cor + texto (a cor nunca informa sozinha). */
export function selo(valor, tabela = R.situacaoBoleto) {
  const [texto, tom] = tabela[valor] ?? [valor ?? '—', 'neutra'];
  return el('span', { class: `selo ${tom}` }, texto);
}

// ---------------------------------------------------------------- Blocos
export function kpi({ rotulo, valor, apoio, tom = '', menor = false, ic = null }) {
  return el('div', { class: `kpi${tom === 'destaque' ? ' destaque' : ''}` },
    el('div', { class: 'rotulo' }, ic ? icone(ic) : null, rotulo),
    el('div', { class: `valor num${menor ? ' menor' : ''}${tom === 'positivo' ? ' positivo' : tom === 'negativo' ? ' negativo' : ''}` }, valor),
    apoio ? el('div', { class: 'apoio' }, apoio) : null);
}

export function cartao(titulo, corpo, acoes = null) {
  return el('section', { class: 'cartao' },
    titulo ? el('header', {}, el('h2', {}, titulo), acoes ? el('div', { class: 'acoes' }, acoes) : null) : null,
    el('div', { class: 'corpo' }, corpo));
}

/**
 * Tabela. `colunas`: [{ titulo, campo|conteudo(item), dir, classe }].
 */
export function tabela({ colunas, itens, vazio = 'Nada por aqui ainda.', aoClicar = null, rodape = null }) {
  if (!itens?.length) return el('div', { class: 'tabela-caixa' }, el('div', { class: 'vazio' }, vazio));
  return el('div', { class: 'tabela-caixa' },
    el('table', { class: 'lista' },
      el('thead', {}, el('tr', {}, colunas.map((c) => el('th', { class: c.dir ? 'dir' : null }, c.titulo)))),
      el('tbody', {}, itens.map((i) => el('tr', {
        class: aoClicar ? 'clicavel' : null,
        ...(aoClicar ? { onclick: () => aoClicar(i), tabindex: '0', onkeydown: (e) => { if (e.key === 'Enter') aoClicar(i); } } : {}),
      }, colunas.map((c) => el('td', { class: [c.dir ? 'dir' : '', c.classe ?? ''].filter(Boolean).join(' ') || null },
        c.conteudo ? c.conteudo(i) : i[c.campo] ?? '—')))))),
    rodape);
}

export function paginacao({ pagina, por_pagina, total }, aoMudar) {
  const paginas = Math.max(1, Math.ceil(total / por_pagina));
  if (total <= por_pagina) return null;
  return el('div', { class: 'paginacao' },
    el('button', { class: 'botao sec pequeno', disabled: pagina <= 1, onclick: () => aoMudar(pagina - 1) }, 'Anterior'),
    el('span', {}, `Página ${pagina} de ${paginas}`),
    el('button', { class: 'botao sec pequeno', disabled: pagina >= paginas, onclick: () => aoMudar(pagina + 1) }, 'Próxima'),
    el('span', { class: 'fim' }, `${numero(total)} registro(s)`));
}

// ---------------------------------------------------------------- Formulários
/** Campo de formulário. `tipo`: text, number, date, select, textarea, dinheiro… */
export function campo({ nome, rotulo, tipo = 'text', valor = '', opcoes = null, ajuda = null, obrigatorio = false, atributos = {} }) {
  let entrada;
  if (tipo === 'select') {
    entrada = el('select', { name: nome, ...atributos }, (opcoes ?? []).map(([v, t]) => el('option', { value: v, selected: String(v) === String(valor) }, t)));
  } else if (tipo === 'textarea') {
    entrada = el('textarea', { name: nome, ...atributos }, valor ?? '');
  } else {
    entrada = el('input', { name: nome, type: tipo === 'dinheiro' ? 'text' : tipo, value: valor ?? '', inputmode: tipo === 'dinheiro' ? 'decimal' : null, ...atributos });
  }
  if (obrigatorio) entrada.required = true;
  return el('label', { class: 'campo-form' }, el('span', {}, rotulo), entrada, ajuda ? el('small', {}, ajuda) : null);
}

/** Lê um formulário como objeto simples. */
export const lerForm = (form) => Object.fromEntries(new FormData(form).entries());

// ---------------------------------------------------------------- Modal, confirmação e aviso
export function modal({ titulo, corpo, acoes = [], largo = false, aoFechar = null }) {
  const fundo = el('div', { class: 'modal-fundo', onclick: (e) => { if (e.target === fundo) fechar(); } });
  const fechar = () => { fundo.remove(); document.removeEventListener('keydown', esc); aoFechar?.(); };
  const esc = (e) => { if (e.key === 'Escape') fechar(); };
  document.addEventListener('keydown', esc);
  const caixa = el('div', { class: `modal${largo ? ' largo' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': titulo },
    el('header', {}, el('h2', {}, titulo), el('button', { class: 'botao-icone', 'aria-label': 'Fechar', onclick: fechar }, icone('fechar'))),
    el('div', { class: 'corpo' }, corpo),
    acoes.length ? el('footer', {}, acoes) : null);
  fundo.append(caixa);
  document.body.append(fundo);
  caixa.querySelector('input, select, textarea, button')?.focus();
  return { fechar, caixa };
}

export function confirmar({ titulo, texto, confirmarTexto = 'Confirmar', perigo = false, campoMotivo = false }) {
  return new Promise((resolve) => {
    const entrada = campoMotivo ? campo({ nome: 'motivo', rotulo: 'Motivo', obrigatorio: true, atributos: { maxlength: 160 } }) : null;
    const m = modal({
      titulo,
      corpo: [el('p', {}, texto), entrada],
      acoes: [
        el('button', { class: 'botao sec', onclick: () => { m.fechar(); resolve(null); } }, 'Cancelar'),
        el('button', {
          class: `botao${perigo ? ' perigo' : ''}`,
          onclick: () => {
            const motivo = entrada?.querySelector('input')?.value.trim();
            if (campoMotivo && !motivo) { entrada.querySelector('input').focus(); return; }
            m.fechar();
            resolve(campoMotivo ? { motivo } : {});
          },
        }, confirmarTexto),
      ],
      aoFechar: () => resolve(null),
    });
  });
}

let caixaToasts = null;
export function toast(texto, tom = '') {
  if (!caixaToasts) { caixaToasts = el('div', { class: 'toasts' }); document.body.append(caixaToasts); }
  const t = el('div', { class: `toast ${tom}`, role: 'status' }, texto);
  caixaToasts.append(t);
  setTimeout(() => t.remove(), tom === 'erro' ? 7000 : 4000);
}

export const aviso = (texto, tom = 'info') => el('div', { class: `aviso ${tom === 'aviso' ? 'aviso-amarelo' : tom}` },
  icone(tom === 'erro' ? 'alerta' : tom === 'ok' ? 'ok' : 'info'), el('div', {}, texto));

/** Executa uma ação mostrando erro em toast e travando o botão enquanto roda. */
export async function acao(botao, fn) {
  const antes = botao.textContent;
  botao.disabled = true;
  try {
    await fn();
  } catch (err) {
    toast(err.message || 'Não foi possível concluir a operação.', 'erro');
  } finally {
    botao.disabled = false;
    if (botao.textContent !== antes) botao.textContent = antes;
  }
}

export async function copiar(texto, mensagem = 'Copiado para a área de transferência.') {
  try {
    await navigator.clipboard.writeText(texto);
    toast(mensagem, 'ok');
  } catch {
    toast('Não foi possível copiar automaticamente. Selecione o texto e copie.', 'erro');
  }
}
