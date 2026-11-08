/** Componentes e formatação comuns. Texto vindo do servidor entra sempre como texto, nunca como HTML. */
import { sessao } from './api.js';

// Ícones de traço (24×24) da referência visual do Manager Network.
const ICONES = {
  painel: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  atividade: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  rede: '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="2" y="16" width="6" height="5" rx="1"/><rect x="16" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M5 16v-4h14v4"/>',
  chamado: '<path d="M5 4h14v5a3 3 0 0 0 0 6v5H5v-5a3 3 0 0 0 0-6V4Z"/><path d="M13 7v2m0 3v2m0 3v1"/>',
  equipe: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 2 4v2"/>',
  carro: '<path d="m5 6-2 7v6h3v-3h12v3h3v-6l-2-7H5Z"/><path d="M3 12h18M6 15h1m10 0h1"/>',
  chave: '<path d="M14 6a6 6 0 0 0-7 7L2 18l4 4 5-5a6 6 0 0 0 7-7l-4 4-4-4 4-4Z"/>',
  combustivel: '<path d="M4 21V4h10v17M2 21h14M4 10h10M18 5l3 4v9a2 2 0 0 1-4 0v-4h-3"/><path d="M18 5v5h3"/>',
  pino: '<path d="M19 10c0 6-7 11-7 11S5 16 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
  plugue: '<path d="m7 3 3 3m4-1 4 4M5 9l10-6 6 6-6 10-4-4-8 7m8-7-5-5"/>',
  busca: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  sino: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  pausa: '<path d="M8 5v14M16 5v14"/>',
  tocar: '<path d="m8 4 12 8-12 8V4Z"/>',
  calendario: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18"/>',
  mais: '<path d="M12 5v14M5 12h14"/>',
  seta: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  voltar: '<path d="M19 12H5m5-5-5 5 5 5"/>',
  alerta: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3v1"/>',
  relogio: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  caixa: '<path d="m12 2 10 5v10l-10 5-10-5V7l10-5Z"/><path d="m2 7 10 5 10-5M12 12v10"/>',
  globo: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  tv: '<rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 22h8M12 18v4"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  fechar: '<path d="m6 6 12 12M6 18 18 6"/>',
  ok: '<path d="m5 12 4 4 10-10"/>',
  baixar: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  escudo: '<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Z"/><path d="m8 11 3 3 5-5"/>',
  dinheiro: '<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.01M18 12h.01"/>',
  camadas: '<path d="m12 3 10 6-10 6L2 9l10-6Zm-10 12 10 6 10-6M2 12l10 6 10-6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
  servidor: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6h.01M7 17h.01M14 6h3m-3 11h3"/>',
  gota: '<path d="M19 14a7 7 0 0 1-14 0C5 9 12 2 12 2s7 7 7 12Z"/>',
  externo: '<path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7"/>',
  rota: '<circle cx="5" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="M7 5h9a4 4 0 0 1 0 8H8a3 3 0 0 0 0 6h9"/>',
  arquivo: '<path d="M5 3h9l5 5v13H5V3Zm9 0v6h5M8 13h8m-8 4h8"/>',
  sinal: '<path d="M5 20v-3m5 3v-7m5 7V9m5 11V4"/>',
  atualizar: '<path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/>',
  sair: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"/>',
  config: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z"/>',
  camera: '<path d="M3 8h4l2-3h6l2 3h4v12H3V8Z"/><circle cx="12" cy="13" r="4"/>',
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
  s.innerHTML = ICONES[nome] ?? ICONES.caixa;
  return s;
}

export function el(tag, attrs = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if ((k === 'value' || k === 'checked') && k in e) e[k] = v;
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const f of filhos.flat(Infinity)) if (f !== null && f !== undefined && f !== false) e.append(f instanceof Node ? f : String(f));
  return e;
}
export const $ = (s, r = document) => r.querySelector(s);
export const limpar = (e, ...f) => { e.replaceChildren(...f.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false)); return e; };

// ---------------- Permissões e formatação no fuso da operação ----------------
export const usuario = () => sessao.get()?.usuario ?? null;
export const pode = (p) => Boolean(usuario()?.permissoes?.includes(p));
const fuso = () => usuario()?.fuso || 'America/Sao_Paulo';

const real = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const dinheiro = (c) => (c === null || c === undefined ? '—' : real.format(c / 100 || 0));
export const numero = (n, casas = 0) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas }));
export const litros = (ml) => (ml === null || ml === undefined ? '—' : `${numero(ml / 1000, ml % 1000 ? 2 : 0)} L`);
export const precoLitro = (m) => (m === null || m === undefined ? '—' : `R$ ${numero(m / 1000, 3)}`);
export const km = (k) => (k === null || k === undefined ? '—' : `${numero(k)} km`);
export function dataHora(iso, { segundos = false } = {}) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('pt-BR', { timeZone: fuso(), day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', ...(segundos ? { second: '2-digit' } : {}) })
    .format(new Date(iso));
}
export const hora = (iso) => (iso ? new Intl.DateTimeFormat('pt-BR', { timeZone: fuso(), hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—');
export const data = (d) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '—');
export const hoje = () => new Intl.DateTimeFormat('en-CA', { timeZone: fuso(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export function desde(iso) {
  if (!iso) return 'nunca';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return `há ${Math.floor(s / 86400)} dia(s)`;
}
export const duracaoMin = (m) => (m === null || m === undefined ? '—' : m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} min`);
export const placa = (p) => (/^[A-Z]{3}\d{4}$/.test(p ?? '') ? `${p.slice(0, 3)}-${p.slice(3)}` : p ?? '');
export const iniciais = (n) => String(n ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0].toUpperCase()).join('');
/** Valor de <input type=datetime-local> para ISO (UTC) e de volta. */
export const localParaIso = (v) => (v ? new Date(v).toISOString() : null);
export const isoParaLocal = (iso) => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

// ---------------- Rótulos ----------------
export const R = {
  statusChamado: { aberto: ['Aberto', 'neutra'], atribuido: ['Atribuído', 'info'], em_rota: ['Em rota', 'info'], em_execucao: ['Em execução', 'aviso'],
    em_validacao: ['Concluído · em validação', 'aviso'], aprovado: ['Aprovado', 'ok'], retornado: ['Retornado', 'erro'], cancelado: ['Cancelado', 'neutra'] },
  prioridade: { baixa: 'Baixa', media: 'Média', alta: 'Alta', critica: 'Crítica' },
  tipoChamado: { instalacao: 'Instalação', reparo: 'Reparo', fusao: 'Fusão', manutencao_rede: 'Manutenção de rede', vistoria: 'Vistoria', retirada: 'Retirada', outro: 'Outro' },
  statusVeiculo: { disponivel: ['Disponível', 'ok'], em_operacao: ['Em operação', 'info'], reservado: ['Reservado', 'info'], em_oficina: ['Em oficina', 'aviso'],
    indisponivel: ['Indisponível', 'erro'], inativo: ['Inativo', 'neutra'] },
  statusAtivo: { operacional: ['Operacional', 'ok'], atencao: ['Atenção', 'aviso'], indisponivel: ['Indisponível', 'erro'], nao_avaliado: ['Não avaliado', 'neutra'] },
  origemStatus: { sem_avaliacao: 'Sem avaliação', inspecao_manual: 'Inspeção manual', inferencia: 'Inferência (OLT/ONU/topologia)', monitoramento: 'Monitoramento' },
  tipoAtivo: { pop: 'POP', ceo: 'Caixa de emenda (CEO)', cto: 'CTO' },
  severidade: { critica: ['Crítica', 'erro'], alta: ['Alta', 'aviso'], media: ['Média', 'aviso'], baixa: ['Baixa', 'neutra'] },
  statusIncidente: { aberto: ['Aberto', 'erro'], reconhecido: ['Reconhecido', 'aviso'], em_atendimento: ['Em atendimento', 'info'], resolvido: ['Resolvido', 'ok'] },
  estadoIntegracao: { nao_configurada: ['Não configurada', 'neutra'], testando: ['Testando', 'info'], conectada: ['Conectada', 'ok'], parcial: ['Parcial', 'aviso'],
    desatualizada: ['Desatualizada', 'aviso'], sem_permissao: ['Sem permissão', 'erro'], limite_atingido: ['Limite atingido', 'aviso'], falha: ['Falha', 'erro'], desabilitada: ['Desabilitada', 'neutra'] },
  statusComissao: { aguardando_aprovacao: ['Aguardando aprovação', 'aviso'], aprovada: ['Aprovada', 'ok'], rejeitada: ['Rejeitada', 'erro'], suspensa: ['Suspensa', 'neutra'], paga: ['Pagamento registrado', 'info'] },
  statusManutencao: { solicitado: ['Solicitado', 'neutra'], orcado: ['Orçado', 'info'], aprovado: ['Aprovado', 'info'], agendado: ['Agendado', 'info'], em_execucao: ['Em execução', 'aviso'],
    concluido: ['Concluído', 'ok'], cancelado: ['Cancelado', 'neutra'] },
  tipoManutencao: { preventiva: 'Preventiva', corretiva: 'Corretiva (mecânico)', lavagem: 'Lavagem' },
  itemPlano: { oleo: 'Óleo', filtros: 'Filtros', pneus: 'Pneus', freios: 'Freios', revisao: 'Revisão', correia: 'Correia', bateria: 'Bateria', outro: 'Outro' },
  situacaoPlano: { em_dia: ['Em dia', 'ok'], proximo: ['Próximo', 'aviso'], vencido: ['Vencido', 'erro'], critico: ['Vencido · fora da tolerância', 'erro'], sem_dados: ['Sem dados', 'neutra'] },
  situacaoRastreio: { em_movimento: ['Em movimento', 'ok'], parado: ['Parado', 'info'], atualizada: ['Posição atual', 'ok'], desatualizada: ['Posição desatualizada', 'aviso'],
    sem_posicao: ['Sem posição recebida', 'neutra'], sem_dispositivo: ['Sem dispositivo', 'neutra'] },
  sinal: { sem_relatos_relevantes: ['Sem relatos relevantes', 'ok'], indicio_externo: ['Indício externo', 'aviso'], sem_dados: ['Sem dados', 'neutra'] },
  restricao: { oficina: 'Oficina', manutencao: 'Ordem de manutenção', documento: 'Documento', sinistro: 'Sinistro', administrativa: 'Administrativa' },
  combustivel: { flex: 'Flex', gasolina: 'Gasolina', etanol: 'Etanol', diesel: 'Diesel', gnv: 'GNV', eletrico: 'Elétrico' },
  categoria: { passeio: 'Passeio', utilitario: 'Utilitário', picape: 'Picape', van: 'Van', caminhao: 'Caminhão', moto: 'Moto', outro: 'Outro' },
  fornecedor: { oficina: 'Oficina / mecânico', posto: 'Posto', lavagem: 'Lavagem', pecas: 'Peças', outro: 'Outro' },
  documento: { crlv: 'CRLV', seguro: 'Seguro', licenciamento: 'Licenciamento', ipva: 'IPVA', vistoria: 'Vistoria', outro: 'Outro' },
  equipamento: { olt: 'OLT', switch: 'Switch', roteador: 'Roteador', servidor: 'Servidor', outro: 'Outro' },
};
export const etq = (texto, tipo = '') => el('span', { class: `etq ${tipo}` }, texto);
export const etqDe = (mapa, chave) => { const x = R[mapa]?.[chave]; return Array.isArray(x) ? etq(x[0], x[1]) : etq(x ?? chave ?? '—', 'neutra'); };
export const rotulo = (mapa, chave) => { const x = R[mapa]?.[chave]; return Array.isArray(x) ? x[0] : x ?? chave ?? '—'; };
export const opcoes = (mapa) => Object.entries(R[mapa]).map(([k, x]) => [k, Array.isArray(x) ? x[0] : x]);

// ---------------- Avisos ----------------
let timerToast;
export function toast(msg, erro = false) {
  document.querySelector('.toast')?.remove();
  const t = el('div', { class: `toast${erro ? ' erro' : ''}`, role: erro ? 'alert' : 'status' }, msg);
  document.body.append(t);
  clearTimeout(timerToast);
  timerToast = setTimeout(() => t.remove(), erro ? 6000 : 3200);
}

/** Executa a ação do botão com bloqueio de duplo clique e mostra o erro. */
export async function acao(botao, fn) {
  if (botao?.disabled) return undefined;
  if (botao) botao.disabled = true;
  try { return await fn(); } catch (err) { toast(err.message, true); return undefined; } finally { if (botao) botao.disabled = false; }
}

// ---------------- Estados ----------------
export const carregando = (texto = 'Carregando…') => el('div', { class: 'carregando', role: 'status' }, texto);
export const vazio = (titulo, texto = '', botao = null) => el('div', { class: 'vazio' }, el('strong', {}, titulo), texto, botao ? el('div', {}, botao) : null);
export const falha = (err, tentar) => el('div', { class: 'falha', role: 'alert' }, err.message || String(err),
  err.dados?.request_id ? el('small', {}, `ID para diagnóstico: ${err.dados.request_id}`) : null,
  tentar ? el('div', {}, el('button', { class: 'botao secundario pequeno', style: 'margin-top:10px', onclick: tentar }, 'Tentar de novo')) : null);
export const faixa = (texto, tipo = '', ic = 'info') => el('div', { class: `aviso-faixa ${tipo}`, role: tipo === 'erro' ? 'alert' : null }, icone(ic), el('div', {}, texto));

/** Carrega dados num contêiner, mostrando carregando / erro com nova tentativa. */
export async function carregar(alvo, fn, desenhar) {
  limpar(alvo, carregando());
  try {
    const dados = await fn();
    limpar(alvo, desenhar(dados));
    return dados;
  } catch (err) {
    limpar(alvo, falha(err, () => carregar(alvo, fn, desenhar)));
    return null;
  }
}

// ---------------- Estrutura ----------------
export function cabecalho({ sobretitulo, titulo, descricao, acoes = [] }) {
  return el('div', { class: 'cab-pagina' },
    el('div', { class: 'textos' }, sobretitulo ? el('div', { class: 'sobretitulo' }, sobretitulo) : null, el('h1', {}, titulo), descricao ? el('p', { class: 'descricao' }, descricao) : null),
    acoes.filter(Boolean).length ? el('div', { class: 'acoes' }, acoes) : null);
}
export function painel(titulo, corpo, { acoes = [], rodape = null, semCorpo = false, classe = '' } = {}) {
  return el('section', { class: `painel ${classe}` },
    titulo ? el('div', { class: 'painel-cab' }, el('h2', {}, titulo), acoes.filter(Boolean).length ? el('div', { class: 'acoes' }, acoes) : null) : null,
    semCorpo ? corpo : el('div', { class: 'painel-corpo' }, corpo),
    rodape ? el('div', { class: 'painel-rodape' }, rodape) : null);
}
export const botao = (texto, onclick, { tipo = '', ic = null, titulo = null } = {}) =>
  el('button', { type: 'button', class: `botao ${tipo}`, onclick: (e) => acao(e.currentTarget, onclick), title: titulo, 'aria-label': titulo }, ic ? icone(ic) : null, texto);

export function stat({ rotulo: r, valor, sufixo, nota, notaTipo = '', ic, fonte, semDado = false }) {
  return el('div', { class: `stat${semDado ? ' sem-dado' : ''}` },
    el('div', { class: 'rotulo' }, el('span', {}, r), ic ? icone(ic) : null),
    el('div', { class: 'valor' }, valor, sufixo ? el('small', {}, sufixo) : null),
    nota ? el('div', { class: `nota ${notaTipo}` }, nota) : null,
    fonte ? el('div', { class: 'fonte' }, fonte) : null);
}

/** Tabela com rolagem interna, estado vazio e linhas clicáveis/navegáveis por teclado. */
export function tabela(colunas, linhas, { vazioTexto = 'Nenhum registro.', aoClicar = null, pagina = null } = {}) {
  if (!linhas.length) return vazio(vazioTexto);
  const t = el('table', { class: 'tabela' },
    el('thead', {}, el('tr', {}, colunas.map((c) => el('th', { class: c.classe ?? '', scope: 'col' }, c.titulo)))),
    el('tbody', {}, linhas.map((l) => el('tr', aoClicar ? { class: 'clicavel', tabindex: '0', onclick: () => aoClicar(l), onkeydown: (e) => { if (e.key === 'Enter') aoClicar(l); } } : {},
      colunas.map((c) => el('td', { class: c.classe ?? '' }, c.valor(l)))))));
  return el('div', {}, el('div', { class: 'tabela-rolagem' }, t), pagina);
}

/** Paginação simples para listas do servidor ({ total, pagina, por_pagina }). */
export function paginacao(lista, irPara) {
  const paginas = Math.max(1, Math.ceil(lista.total / lista.por_pagina));
  if (paginas <= 1) return el('div', { class: 'paginacao' }, `${lista.total} registro(s)`);
  return el('div', { class: 'paginacao' }, `${lista.total} registro(s) · página ${lista.pagina} de ${paginas}`,
    el('div', {}, el('button', { class: 'botao secundario pequeno', disabled: lista.pagina <= 1, onclick: () => irPara(lista.pagina - 1) }, 'Anterior'), ' ',
      el('button', { class: 'botao secundario pequeno', disabled: lista.pagina >= paginas, onclick: () => irPara(lista.pagina + 1) }, 'Próxima')));
}

export function abas(lista, ativa, aoTrocar) {
  const barra = el('div', { class: 'abas', role: 'tablist' });
  for (const [id, r] of lista) {
    barra.append(el('button', { role: 'tab', 'aria-selected': String(id === ativa), onclick: () => aoTrocar(id) }, r));
  }
  return barra;
}

export const dl = (pares) => el('dl', { class: 'dl' }, pares.filter(Boolean).flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v ?? '—')]));

// ---------------- Janelas ----------------
export function modal(titulo, conteudo, { largo = false } = {}) {
  return new Promise((resolve) => {
    const anterior = document.activeElement;
    const fundo = el('div', { class: 'modal-fundo' });
    const fechar = (v = null) => { fundo.remove(); document.removeEventListener('keydown', tecla); anterior?.focus?.(); resolve(v); };
    const tecla = (e) => {
      if (e.key === 'Escape') fechar();
      if (e.key === 'Tab') {
        const f = [...caixa.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')].filter((x) => !x.disabled);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
        else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', tecla);
    fundo.addEventListener('mousedown', (e) => { if (e.target === fundo) fechar(); });
    const id = `t${Math.random().toString(36).slice(2)}`;
    const caixa = el('div', { class: `modal${largo ? ' largo' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id },
      el('div', { class: 'modal-cab' }, el('h2', { id }, titulo), el('button', { class: 'botao-icone', 'aria-label': 'Fechar', onclick: () => fechar() }, icone('fechar'))));
    caixa.append(...[].concat(typeof conteudo === 'function' ? conteudo(fechar) : conteudo).flat(Infinity).filter(Boolean));
    fundo.append(caixa);
    document.body.append(fundo);
    (caixa.querySelector('input:not([type=hidden]):not([type=checkbox]), select, textarea') ?? caixa.querySelector('button'))?.focus();
  });
}

/**
 * Formulário em janela a partir da descrição dos campos. O erro do servidor aparece dentro do formulário (que continua aberto).
 * campo: { nome, rotulo, tipo: text|number|email|password|date|datetime-local|select|textarea|checkbox|file, opcoes: [[v, r]], obrigatorio, valor, ajuda, passo, inteiro, accept }
 */
export function formulario(titulo, campos, { enviar, rotuloEnviar = 'Salvar', largo = false, antes = null } = {}) {
  return modal(titulo, (fechar) => {
    const erro = el('div', { class: 'erro-form', role: 'alert', hidden: true });
    const entradas = {};
    const grade = el('div', { class: 'form-grade' });
    for (const c of campos.filter(Boolean)) {
      if (c.tipo === 'secao') { grade.append(el('div', { class: 'inteiro sobretitulo', style: 'margin:8px 0 -4px' }, c.rotulo)); continue; }
      let entrada;
      const comum = { name: c.nome, required: c.obrigatorio || null, id: `f_${c.nome}` };
      if (c.tipo === 'select') {
        entrada = el('select', comum, c.vazio !== false ? el('option', { value: '' }, c.vazio ?? 'Selecione…') : null,
          (c.opcoes ?? []).map(([v, r]) => el('option', { value: v, selected: String(v) === String(c.valor ?? '') ? true : null }, r)));
      } else if (c.tipo === 'textarea') entrada = el('textarea', { ...comum, rows: c.linhas ?? 3 }, c.valor ?? '');
      else if (c.tipo === 'checkbox') entrada = el('input', { ...comum, type: 'checkbox', checked: Boolean(c.valor) });
      else if (c.tipo === 'file') entrada = el('input', { ...comum, type: 'file', accept: c.accept ?? 'image/jpeg,image/png,image/webp,application/pdf', capture: c.capture ?? null });
      else entrada = el('input', { ...comum, type: c.tipo ?? 'text', value: c.valor ?? '', step: c.passo ?? (c.tipo === 'number' ? 'any' : null), min: c.min ?? null, max: c.max ?? null,
        placeholder: c.placeholder ?? null, inputmode: c.inputmode ?? (c.tipo === 'decimal' ? 'decimal' : null), autocomplete: c.autocomplete ?? 'off' });
      if (c.tipo === 'decimal') { entrada.type = 'text'; entrada.inputMode = 'decimal'; }
      entradas[c.nome] = { c, entrada };
      grade.append(c.tipo === 'checkbox'
        ? el('label', { class: `check ${c.inteiro ? 'inteiro' : ''}` }, entrada, c.rotulo)
        : el('label', { class: `campo ${c.inteiro ? 'inteiro' : ''}`, for: comum.id }, el('span', {}, c.rotulo, c.obrigatorio ? ' *' : ''), entrada, c.ajuda ? el('span', { class: 'ajuda' }, c.ajuda) : null));
    }
    const enviarBtn = el('button', { type: 'submit', class: 'botao' }, rotuloEnviar);
    const form = el('form', { novalidate: true }, antes, grade, erro, el('div', { class: 'form-acoes' },
      el('button', { type: 'button', class: 'botao secundario', onclick: () => fechar() }, 'Cancelar'), enviarBtn));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      erro.hidden = true;
      const dados = {};
      for (const [nome, { c, entrada }] of Object.entries(entradas)) {
        if (c.tipo === 'checkbox') dados[nome] = entrada.checked;
        else if (c.tipo === 'file') dados[nome] = entrada.files?.[0] ?? null;
        else dados[nome] = entrada.value.trim();
        if (c.obrigatorio && (dados[nome] === '' || dados[nome] === null)) {
          erro.textContent = `Preencha: ${c.rotulo}.`;
          erro.hidden = false;
          entrada.focus();
          return;
        }
      }
      enviarBtn.disabled = true;
      try {
        const r = await enviar(dados);
        fechar(r ?? true);
      } catch (err) {
        erro.textContent = err.message + (err.dados?.request_id ? ` (ID ${err.dados.request_id})` : '');
        erro.hidden = false;
      } finally { enviarBtn.disabled = false; }
    });
    return form;
  }, { largo });
}

export const confirmar = (titulo, texto, rotulo = 'Confirmar') => modal(titulo, (fechar) => [el('p', {}, texto), el('div', { class: 'form-acoes' },
  el('button', { class: 'botao secundario', onclick: () => fechar(false) }, 'Cancelar'), el('button', { class: 'botao', onclick: () => fechar(true) }, rotulo))]);

/** Pede um texto obrigatório (motivo, evidência) e executa a ação com ele. */
export const pedirMotivo = (titulo, rotuloCampo, enviar, { rotuloEnviar = 'Confirmar', ajuda } = {}) =>
  formulario(titulo, [{ nome: 'texto', rotulo: rotuloCampo, tipo: 'textarea', obrigatorio: true, inteiro: true, ajuda }], { enviar: (d) => enviar(d.texto), rotuloEnviar });

/** Indicador de fonte e horário (nunca "ao vivo" sem coleta). */
export function fonteHorario(estado, ultimo, fonte) {
  const x = R.estadoIntegracao[estado] ?? [estado, 'neutra'];
  return el('span', { class: 'conexao' }, etq(x[0], x[1]), fonte ? ` ${fonte}` : '', ultimo ? ` · última coleta ${dataHora(ultimo)} (${desde(ultimo)})` : ' · sem coleta');
}
