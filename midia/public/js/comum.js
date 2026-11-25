/** Peças repetidas nas telas do painel: cartões, indicadores, tabelas, prévias e a linha do tempo do loop. */
import { el, icone, inteiro, dinheiro, duracao, mb, etiqueta, escolha } from './ui.js';
import { BASE, sessao, api } from './api.js';

/** Prefixo da API (para <img> que o navegador busca direto, como a logo do ponto). */
export const BASE_API = `${BASE}/api`;

export const cartao = (titulo, ...filhos) => el('div', { class: 'cartao' }, titulo ? el('h2', {}, titulo) : null, ...filhos);
export const vazio = (texto) => el('p', { class: 'mudo', style: 'margin:6px 0' }, texto);
export const carregando = () => el('p', { class: 'mudo' }, 'Carregando…');

/** Indicador grande: rótulo, valor e uma nota. */
export const indicador = ({ rotulo, valor, nota, ic, cor = 'azul' }) => el('div', { class: 'cartao indicador com-icone' },
  ic ? el('div', { class: `ic ${cor}` }, icone(ic)) : null,
  el('div', { class: 'corpo' }, el('div', { class: 'rotulo' }, rotulo), el('div', { class: 'valor num' }, valor), nota ? el('div', { class: 'nota' }, nota) : null));

/**
 * Tabela: `colunas` é [[chave|função, título, classe?]]. `opts.aoClicar` deixa a linha clicável.
 */
export function tabela(colunas, linhas, { aoClicar = null, vazioTexto = 'Nada por aqui ainda.', rodape = null } = {}) {
  if (!linhas.length) return vazio(vazioTexto);
  return el('div', { class: 'rolagem' }, el('table', { class: 'tabela' },
    el('thead', {}, el('tr', {}, colunas.map(([, titulo, classe]) => el('th', { class: classe ?? null }, titulo)))),
    el('tbody', {}, linhas.map((l) => el('tr', { class: aoClicar ? 'clicavel' : null, onclick: aoClicar ? () => aoClicar(l) : null },
      colunas.map(([chave, , classe]) => el('td', { class: classe ?? null }, typeof chave === 'function' ? chave(l) : l[chave] ?? '—'))))),
    rodape ? el('tfoot', {}, rodape) : null));
}

/** Barra de filtros (os campos já vêm montados). */
export const filtros = (...campos) => el('div', { class: 'filtros livre' }, ...campos.flat(Infinity).filter(Boolean));

/** Prévia do criativo (imagem ou vídeo), buscada com a sessão e mostrada como blob. */
export function previa(midia, { rota = 'painel', classe = '' } = {}) {
  const caixa = el('div', { class: `previa ${classe}` });
  const tipo = el('span', { class: 'tipo' }, midia.tipo === 'video' ? `Vídeo ${duracao(midia.duracao_s)}` : `${midia.duracao_s}s`);
  fetch(`${BASE}/api/${rota}/midias/${midia.id}/arquivo`, { headers: { Authorization: `Bearer ${sessao.get()?.token ?? ''}` } })
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('sem prévia'))))
    .then((b) => {
      const url = URL.createObjectURL(b);
      const e = midia.tipo === 'video'
        ? el('video', { src: url, muted: true, loop: true, autoplay: true, playsinline: true })
        : el('img', { src: url, alt: midia.nome });
      if (midia.tipo === 'video') e.muted = true;
      caixa.prepend(e);
    })
    .catch(() => caixa.prepend(el('span', { class: 'mudo pequeno' }, 'Sem prévia')));
  caixa.append(tipo);
  return caixa;
}

/** Imagem servida pela API (que exige o token da sessão, por isso não dá para usar <img src> direto). */
export function imagemDaApi(caminho, { alt = '', classe = '', vazio: textoVazio = 'Sem imagem' } = {}) {
  const caixa = el('div', { class: classe });
  fetch(`${BASE}/api${caminho}`, { headers: { Authorization: `Bearer ${sessao.get()?.token ?? ''}` } })
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('sem imagem'))))
    .then((b) => caixa.append(el('img', { src: URL.createObjectURL(b), alt })))
    .catch(() => caixa.append(el('span', { class: 'mudo pequeno' }, textoVazio)));
  return caixa;
}

/** Miniatura pequena (listas e grades). */
export function miniatura(midiaId, rota = 'painel') {
  const caixa = el('div', { class: 'mini' });
  fetch(`${BASE}/api/${rota}/midias/${midiaId}/arquivo`, { headers: { Authorization: `Bearer ${sessao.get()?.token ?? ''}` } })
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('sem prévia'))))
    .then((b) => caixa.append(el('img', { src: URL.createObjectURL(b), alt: '' })))
    .catch(() => {});
  return caixa;
}

/** Envio de arquivo (criativo): o corpo é o próprio arquivo e os dados vão na URL. */
export async function enviarArquivo(rota, arquivo, dados = {}) {
  const q = new URLSearchParams(Object.entries(dados).filter(([, v]) => v !== '' && v !== null && v !== undefined)).toString();
  let resp;
  try {
    resp = await fetch(`${BASE}/api/${rota}${q ? `?${q}` : ''}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessao.get()?.token ?? ''}`, 'Content-Type': arquivo.type || 'application/octet-stream' },
      body: arquivo,
    });
  } catch {
    throw new Error('Sem conexão com o servidor durante o envio.');
  }
  if (!resp.ok) {
    let msg = `Erro ${resp.status}`;
    try { msg = (await resp.json()).erro || msg; } catch { /* sem corpo */ }
    throw new Error(msg);
  }
  return resp.json();
}

// Cada campanha ganha uma cor na linha do tempo do loop; o par leva a cor do texto que fica legível nela.
const CORES_LOOP = [['#C8FF31', '#18232A'], ['#18232A', '#FFFFFF'], ['#5A7D00', '#FFFFFF'], ['#0E7490', '#FFFFFF'],
  ['#B45309', '#FFFFFF'], ['#9D174D', '#FFFFFF'], ['#1D4ED8', '#FFFFFF'], ['#166534', '#FFFFFF']];

/** Linha do tempo do loop: cada item com largura proporcional à duração. */
export function linhaDoLoop(grade) {
  if (!grade?.itens?.length) return vazio('Esta TV está sem programação: nenhuma campanha ativa alcança ela agora.');
  const total = grade.duracao_s || 1;
  const cores = new Map();
  const cor = (id) => {
    if (!cores.has(id)) cores.set(id, CORES_LOOP[cores.size % CORES_LOOP.length]);
    return cores.get(id);
  };
  const estiloDoItem = (i) => {
    if (!i.campanha_id) return '';
    const [fundo, tinta] = cor(i.campanha_id);
    return `;background:${fundo};color:${tinta}`;
  };
  const zona = grade.layout === 'dividida' && grade.comunicados?.length
    ? el('p', { class: 'pequeno mudo', style: 'margin:8px 0 0' },
      `Tela dividida: ${grade.comunicados.length} comunicado(s) do ponto giram na zona ao lado, fora do carrossel.`)
    : null;
  return el('div', {},
    el('div', { class: 'loop' }, grade.itens.map((i) => el('div', {
      class: `item${i.campanha_id ? '' : ' institucional'}`,
      style: `width:${(i.duracao_s / total) * 100}%${estiloDoItem(i)}`,
      title: `${i.ordem}. ${i.anunciante ? `${i.anunciante} — ` : ''}${i.nome} (${i.duracao_s}s)${i.formato === 'marca' ? ' — tela da marca' : ''}`,
    }, i.duracao_s >= total / 14 ? `${i.duracao_s}s` : ''))),
    el('div', { class: 'loop-legenda' },
      el('span', {}, `Loop de ${duracao(grade.duracao_s)} · ${grade.itens.length} itens`),
      el('span', {}, `${grade.ocupacao}% vendido · ${duracao(grade.institucional_s)} de institucional`)),
    zona);
}

/** O que aparece no lugar da miniatura quando o item é desenhado pela própria tela. */
const selo = (texto, classe) => el('div', { class: `mini ${classe}` }, el('span', { class: 'pequeno' }, texto));

const descricaoDoItem = (i) => {
  if (i.formato === 'marca') return 'Tela da marca (preenche o espaço livre)';
  if (i.formato === 'comunicado') return 'Comunicado do ponto';
  return i.anunciante ? `${i.anunciante} · ${i.campanha}` : 'Institucional / conteúdo do ponto';
};

/** Lista dos itens do loop, com miniatura (ou o selo, quando a tela desenha o item). */
export const itensDoLoop = (grade, rota = 'painel') => el('div', { class: 'itens-grade' }, grade.itens.map((i) => el('div', { class: 'item' },
  el('span', { class: 'ordem' }, i.ordem),
  i.formato === 'marca' ? selo('marca', 'selo-marca') : (i.formato === 'comunicado' ? selo('recado', 'selo-comunicado') : miniatura(i.midia_id, rota)),
  el('div', {}, el('div', {}, i.nome), el('div', { class: 'pequeno mudo' }, descricaoDoItem(i))),
  el('span', { class: 'num mudo' }, `${i.duracao_s}s`))));

/** Resumo por campanha dentro de um loop (quanto cada uma ocupa). */
export const resumoDoLoop = (grade) => tabela([
  [(c) => el('div', {}, el('div', {}, c.anunciante), el('div', { class: 'pequeno mudo' }, c.campanha)), 'Anunciante'],
  [(c) => c.insercoes_loop, 'No loop', 'num dir'],
  [(c) => `${c.share}%`, 'Fatia do tempo', 'num dir'],
  [(c) => `${c.insercoes_hora}/h`, 'Inserções por hora', 'num dir'],
  [(c) => (c.insercoes_hora >= c.contratado_hora ? etiqueta('Dentro do contratado', 'ok') : etiqueta(`Contratado: ${c.contratado_hora}/h`, 'aviso')), 'Contrato'],
], grade.campanhas, { vazioTexto: 'Nenhuma campanha nesta TV agora.' });

export const dinheiroOuTraco = (c) => (c ? dinheiro(c) : '—');
export const numeroOuTraco = (n) => (n ? inteiro(n) : '—');
export const bytes = mb;

/**
 * Foto do comunicado no formulário (painel e portal do ponto). A foto cobre o espaço do recado na TV;
 * sem ela, a TV usa uma ilustração do tipo do aviso. Os campos não têm nome: não vão junto do texto —
 * `salvar(id)` envia (ou tira) a foto depois que o comunicado foi gravado.
 */
export function campoFotoComunicado(c, rota) {
  const arquivo = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
  const tirar = el('input', { type: 'checkbox' });
  const campo = el('div', { class: 'coluna', style: 'gap:6px' },
    el('label', { class: 'campo' }, 'Foto (opcional)', arquivo),
    c?.imagem_arquivo ? el('label', { class: 'marcar' }, tirar, 'Tirar a foto atual') : null,
    el('p', { class: 'pequeno mudo', style: 'margin:0' },
      'A foto cobre o espaço do recado na TV, com o texto por cima. Sem foto, a TV usa uma ilustração do tipo do aviso.'));
  const salvar = async (id) => {
    if (arquivo.files[0]) return enviarArquivo(`${rota}/comunicados/${id}/imagem`, arquivo.files[0]);
    if (tirar.checked) {
      const r = await fetch(`${BASE}/api/${rota}/comunicados/${id}/imagem`, { method: 'DELETE', headers: { Authorization: `Bearer ${sessao.get()?.token ?? ''}` } });
      if (!r.ok && r.status !== 404) throw new Error('Não deu para tirar a foto.');
    }
    return null;
  };
  return { campo, salvar };
}

/*
 * Empresas: o master escolhe de qual empresa é o cadastro novo (ponto, anunciante, agência, usuário).
 * Quem é de uma empresa nem vê o campo — o servidor grava a empresa dele.
 */
let empresasDoMaster = [];
export async function carregarEmpresas() {
  try { empresasDoMaster = (await api.get('/painel/opcoes')).empresas ?? []; } catch { empresasDoMaster = []; }
  return empresasDoMaster;
}
export const listaDeEmpresas = () => empresasDoMaster;
export function campoEmpresa(valor = '') {
  const ativas = empresasDoMaster.filter((e) => e.ativo);
  if (ativas.length < 2) return null;
  return escolha('Empresa', 'empresa_id', Object.fromEntries(ativas.map((e) => [e.id, e.nome])), valor || String(ativas[0].id));
}
