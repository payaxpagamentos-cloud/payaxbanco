/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/
/**
 * Gestão de Frota (módulo vendido à parte): painel, ordens de serviço, plano preventivo por componente (pelo km do GPS),
 * pneus com o desenho das posições do veículo, documentos com vencimento, fornecedores e o custo por km.
 */
import { api, qs } from './api.js';
import { el, limpar, dinheiro, inteiro, data, dataHora, placa, toast, modal, formModal, confirmar, campo, area, marcar, escolha, etiqueta,
  reaisCampo, centavos, hojeLocal, somarDias, icone, telefone } from './ui.js';
import { cartao, indicador, tabela, td, botao, botaoIcone, acoesTopo } from './comum.js';

const base = (ctx) => `/empresas/${ctx.empresaId}/gestao`;
const pode = (ctx) => !ctx.somenteLeitura;
const ir = (ctx, tela) => { location.hash = `#/empresa/${ctx.empresaId}/${tela}`; };
let catalogo = null;
const cat = async (ctx) => (catalogo ??= await api.get(`${base(ctx)}/catalogos`));
const veiculosDa = async (ctx) => (await api.get(`${base(ctx)}/veiculos`)).filter((x) => x.ativo);
const nomeVeiculo = (x) => `${placa(x.placa)}${x.descricao ? ` · ${x.descricao}` : ''}`;
const opcoesVeiculos = (lista) => Object.fromEntries(lista.map((x) => [x.id, nomeVeiculo(x)]));
const mm = (x) => (x === null || x === undefined ? '—' : `${String(Math.round(x * 10) / 10).replace('.', ',')} mm`);
/** Data prevista da troca só quando ainda vai chegar e está a até 5 anos (mais longe que isso é chute, não ajuda). */
const previsaoUtil = (d) => { const f = d ? Date.parse(d) - Date.now() : NaN; return f > 0 && f < 5 * 365.25 * 86_400_000 ? d : null; };
const kmTxt = (x) => (x === null || x === undefined ? '—' : `${inteiro(x)} km`);
const ESTADO = { ok: ['em dia', 'ok'], atencao: ['atenção', 'aviso'], vencido: ['vencido', 'erro'] };
const PRIORIDADE = { baixa: ['baixa', ''], media: ['média', 'info'], alta: ['alta', 'aviso'], urgente: ['urgente', 'erro'] };
const STATUS_OS = { aberta: ['aberta', 'aviso'], em_execucao: ['em execução', 'info'], concluida: ['concluída', 'ok'], cancelada: ['cancelada', ''] };
const TIPO_OS = { preventiva: 'Preventiva', corretiva: 'Corretiva', inspecao: 'Inspeção' };
const PNEU = { ok: ['bom', 'ok'], atencao: ['atenção', 'aviso'], trocar: ['trocar', 'erro'], sem_medicao: ['sem medição', ''] };
const STATUS_PNEU = { estoque: 'Estoque', montado: 'Montado', recapagem: 'Na recapagem', descartado: 'Descartado' };
const DOC = { ok: ['em dia', 'ok'], vencendo: ['vencendo', 'aviso'], vencido: ['vencido', 'erro'], pago: ['pago', 'ok'] };

/** Barra de uso da vida útil (verde até 85%, amarela até 100%, vermelha depois). */
const barraVida = (pct) => el('div', { class: `vida vida-${pct >= 100 ? 'erro' : pct >= 85 ? 'aviso' : 'ok'}`, title: `${pct}% da vida útil` },
  el('div', { class: 'vida-trilho' }, el('span', { style: `width:${Math.min(100, pct)}%` })), el('span', { class: 'vida-num' }, `${Math.round(pct)}%`));

const semModulo = (ctx, err) => {
  limpar(ctx.conteudo, cartao('Gestão de Frota', el('p', { class: 'mudo' }, err.message)));
};
async function tela(ctx, fn) {
  try { await fn(); } catch (err) { if (err.status === 403) semModulo(ctx, err); else throw err; }
}

// ---------- Painel ----------
async function telaPainel(ctx) {
  ctx.recarregar = () => telaPainel(ctx);
  await tela(ctx, async () => {
    const p = await api.get(`${base(ctx)}/painel`);
    const i = p.indicadores;
    const acaoAtencao = (a) => {
      if (a.tipo === 'componente') return pode(ctx) ? botao('Abrir OS', 'primario', async () => { await novaOS(ctx, { veiculo_id: a.veiculo_id, tipo: 'preventiva', componentes: [a.id], descricao: `Troca: ${a.titulo}` }); }) : null;
      if (a.tipo === 'pneu') return botao('Ver pneus', '', () => { sessionStorage.setItem('gestao.veiculo', String(a.veiculo_id)); ir(ctx, 'gestao-pneus'); });
      return botao('Ver documentos', '', () => ir(ctx, 'gestao-documentos'));
    };
    limpar(ctx.conteudo, el('div', { class: 'coluna', style: 'gap:18px' },
      el('div', { class: 'grade' },
        indicador('Custo do mês', dinheiro(i.custo_mes_centavos), `${inteiro(i.km_mes)} km rodados`, '', 'carteira'),
        indicador('Custo por km', i.custo_km_centavos === null ? '—' : dinheiro(Math.round(i.custo_km_centavos)), 'combustível, manutenção, pneus, documentos e multas', '', 'rota'),
        indicador('Disponibilidade', `${String(i.disponibilidade).replace('.', ',')}%`, `${i.parados} parado(s) na oficina de ${i.veiculos}`, i.parados ? 'aviso' : 'ok', 'veiculos'),
        indicador('OS abertas', inteiro(i.os_abertas), 'na oficina ou aguardando', '', 'manutencao'),
        indicador('Vencidos', inteiro(i.vencidos), 'manutenção, pneus e documentos', i.vencidos ? 'erro' : 'ok', 'alertas'),
        indicador('Atenção', inteiro(i.atencao), 'perto de vencer', i.atencao ? 'aviso' : 'ok', 'relatorios')),
      cartao('Precisa de atenção agora', tabela(['Veículo', 'Item', 'Situação', '^Ação'], p.atencao.map((a) => el('tr', {},
        td(el('strong', {}, a.placa ? placa(a.placa) : '—')), td([a.titulo, el('div', { class: 'pequeno mudo' }, { componente: 'Plano preventivo', pneu: 'Pneu', documento: 'Documento' }[a.tipo])]),
        td(etiqueta(a.texto, a.gravidade === 2 ? 'erro' : 'aviso')), el('td', { class: 'acoes' }, acaoAtencao(a)))),
      'Tudo em dia. Os vencimentos aparecem aqui pelo km do rastreador, pelo tempo e pela medição dos pneus.')),
      p.avarias.length ? cartao('Problemas informados pelos motoristas', tabela(['Quando', 'Veículo', 'Problema', 'Gravidade', '^Ação'], p.avarias.map((a) => el('tr', {},
        td(dataHora(a.criado_em)), td(placa(a.placa)), td([a.descricao, a.motorista ? el('div', { class: 'pequeno mudo' }, a.motorista) : null]),
        td(etiqueta({ baixa: 'baixa', media: 'média', alta: 'alta' }[a.gravidade] ?? a.gravidade, a.gravidade === 'alta' ? 'erro' : a.gravidade === 'media' ? 'aviso' : '')),
        el('td', { class: 'acoes' }, pode(ctx) ? botao('Abrir OS', 'primario', () => novaOS(ctx, { veiculo_id: a.veiculo_id, origem: 'avaria', origem_id: a.id, descricao: a.descricao,
          prioridade: a.gravidade === 'alta' ? 'alta' : 'media' })) : null))))) : null,
      cartao('Ordens de serviço abertas', tabela(['Nº', 'Veículo', 'Serviço', 'Prioridade', 'Situação'], p.os_abertas.map((o) => el('tr', { class: 'clicavel', onclick: () => abrirOS(ctx, o.id) },
        td(el('strong', {}, `#${o.numero}`)), td(placa(o.placa)), td([o.descricao, o.parado ? el('div', {}, etiqueta('veículo parado', 'erro')) : null]),
        td(etiqueta(...PRIORIDADE[o.prioridade])), td(etiqueta(...STATUS_OS[o.status])))), 'Nenhuma OS aberta.'))));
  });
}

// ---------- Ordens de serviço ----------
async function novaOS(ctx, pre = {}) {
  const [veiculos, fornecedores] = await Promise.all([veiculosDa(ctx), api.get(`${base(ctx)}/fornecedores`)]);
  if (!veiculos.length) return toast('Cadastre um veículo antes.', true);
  const r = await formModal('Nova ordem de serviço', () => [
    el('div', { class: 'duas' }, escolha('Veículo', 'veiculo_id', opcoesVeiculos(veiculos), pre.veiculo_id ?? veiculos[0].id, pre.veiculo_id ? { disabled: true } : {}),
      escolha('Tipo', 'tipo', TIPO_OS, pre.tipo ?? 'corretiva')),
    campo('O que precisa ser feito', { name: 'descricao', required: true, maxlength: 300, value: pre.descricao ?? '', placeholder: 'Ex.: Barulho na suspensão dianteira' }),
    el('div', { class: 'duas' }, escolha('Prioridade', 'prioridade', Object.fromEntries(Object.entries(PRIORIDADE).map(([k, [t]]) => [k, t[0].toUpperCase() + t.slice(1)])), pre.prioridade ?? 'media'),
      escolha('Oficina / fornecedor', 'fornecedor_id', { '': 'Definir depois', ...Object.fromEntries(fornecedores.map((f) => [f.id, f.nome])) }, '')),
    el('div', { class: 'duas' }, campo('Previsão de entrega', { name: 'previsao', type: 'date' }), el('div', { class: 'campo-marcar' }, marcar('Veículo fica parado (indisponível)', { name: 'parado' }))),
  ], (d) => api.post(`${base(ctx)}/os`, { ...d, veiculo_id: pre.veiculo_id ?? d.veiculo_id, origem: pre.origem, origem_id: pre.origem_id, componentes: pre.componentes }), { rotulo: 'Abrir OS' });
  if (r && r !== true) { toast(`OS #${r.numero} aberta.`); await abrirOS(ctx, r.id); ctx.recarregar?.(); }
}

/** Ficha da OS: itens (peças e serviços), ações e a troca automática dos componentes do plano ao concluir. */
async function abrirOS(ctx, id) {
  let o = await api.get(`${base(ctx)}/os/${id}`);
  const aberta = () => o.status === 'aberta' || o.status === 'em_execucao';
  await modal(`OS #${o.numero} · ${placa(o.placa)}`, (fechar) => {
    const corpo = el('div', { class: 'coluna', style: 'gap:14px' });
    const recarregar = async () => { o = await api.get(`${base(ctx)}/os/${id}`); desenhar(); ctx.recarregar?.(); };
    const novoItem = () => formModal('Adicionar peça ou serviço', () => [
      el('div', { class: 'duas' }, escolha('Tipo', 'tipo', { peca: 'Peça', servico: 'Serviço (mão de obra)' }, 'peca'),
        escolha('Troca do plano preventivo', 'componente_id', { '': 'Não é do plano', ...Object.fromEntries(o.componentes_disponiveis.map((c) => [c.id, `${c.nome}${c.posicao ? ` (${c.posicao})` : ''} · ${Math.round(c.pct)}%`])) }, '')),
      campo('Descrição', { name: 'descricao', required: true, maxlength: 160, placeholder: 'Ex.: Pastilha de freio Cobreq' }),
      el('div', { class: 'duas' }, campo('Quantidade', { name: 'quantidade', inputmode: 'decimal', value: '1' }), campo('Valor unitário (R$)', { name: 'valor', inputmode: 'decimal', placeholder: '0,00' })),
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Peça ligada ao plano preventivo: ao concluir a OS, a vida útil daquele componente recomeça no km da conclusão.'),
    ], (d) => api.post(`${base(ctx)}/os/${id}/itens`, { tipo: d.tipo, descricao: d.descricao, quantidade: String(d.quantidade || '1').replace(',', '.'), valor_centavos: centavos(d.valor) ?? 0,
      componente_id: d.componente_id || undefined }), { rotulo: 'Adicionar' }).then((r) => r && recarregar());
    const concluir = () => formModal(`Concluir OS #${o.numero}`, () => [
      el('div', { class: 'duas' }, campo('Km na conclusão', { name: 'km_conclusao', type: 'number', min: 0, value: o.km_atual }), campo('Data', { name: 'data', type: 'date', value: hojeLocal() })),
      area('Observação (opcional)', { name: 'observacao', maxlength: 500, rows: 2 }),
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, `Total: ${dinheiro(o.total_centavos)}. ${o.itens.some((i) => i.componente_id) ? 'Os componentes do plano desta OS serão marcados como trocados.' : ''}`),
    ], (d) => api.post(`${base(ctx)}/os/${id}/concluir`, d), { rotulo: 'Concluir' }).then((r) => {
      if (r) { toast(r.componentes_trocados ? `OS concluída: ${r.componentes_trocados} componente(s) trocados no plano.` : 'OS concluída.'); recarregar(); }
    });
    const editar = async () => {
      const fornecedores = await api.get(`${base(ctx)}/fornecedores`);
      const r = await formModal(`Editar OS #${o.numero}`, () => [
        campo('O que precisa ser feito', { name: 'descricao', required: true, maxlength: 300, value: o.descricao }),
        el('div', { class: 'duas' }, escolha('Tipo', 'tipo', TIPO_OS, o.tipo), escolha('Prioridade', 'prioridade', Object.fromEntries(Object.entries(PRIORIDADE).map(([k, [t]]) => [k, t])), o.prioridade)),
        el('div', { class: 'duas' }, escolha('Oficina / fornecedor', 'fornecedor_id', { '': 'Sem fornecedor', ...Object.fromEntries(fornecedores.map((f) => [f.id, f.nome])) }, o.fornecedor_id ?? ''),
          campo('Previsão', { name: 'previsao', type: 'date', value: o.previsao ?? '' })),
        marcar('Veículo parado (indisponível)', { name: 'parado', checked: Boolean(o.parado) }),
        area('Observação', { name: 'observacao', maxlength: 500, rows: 2 }, o.observacao ?? ''),
      ], (d) => api.put(`${base(ctx)}/os/${id}`, d));
      if (r) recarregar();
    };
    function desenhar() {
      limpar(corpo,
        el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap' }, etiqueta(...STATUS_OS[o.status]), etiqueta(TIPO_OS[o.tipo], 'info'), etiqueta(`prioridade ${PRIORIDADE[o.prioridade][0]}`, PRIORIDADE[o.prioridade][1]),
          o.parado ? etiqueta('veículo parado', 'erro') : null, o.origem === 'avaria' ? etiqueta('veio de avaria do motorista', '') : null),
        el('p', { style: 'margin:0;font-weight:600' }, o.descricao),
        el('div', { class: 'grade-dados' },
          el('div', {}, el('span', { class: 'mudo pequeno' }, 'Aberta'), el('div', {}, `${dataHora(o.aberta_em)} · ${kmTxt(o.km_abertura)}`)),
          el('div', {}, el('span', { class: 'mudo pequeno' }, 'Fornecedor'), el('div', {}, o.fornecedor ?? '—')),
          el('div', {}, el('span', { class: 'mudo pequeno' }, o.concluida_em ? 'Encerrada' : 'Previsão'), el('div', {}, o.concluida_em ? `${dataHora(o.concluida_em)}${o.km_conclusao ? ` · ${kmTxt(o.km_conclusao)}` : ''}` : o.previsao ? data(o.previsao) : '—'))),
        o.avaria ? el('p', { class: 'pequeno mudo', style: 'margin:0' }, `Avaria informada em ${dataHora(o.avaria.criado_em)}: ${o.avaria.descricao}`) : null,
        tabela(['Item', '>Qtd', '>Unitário', '>Total', '^'], o.itens.map((i) => el('tr', {},
          td([i.descricao, el('div', { class: 'pequeno mudo' }, i.tipo === 'peca' ? (i.componente_id ? 'Peça · troca do plano preventivo' : 'Peça') : 'Serviço')]),
          td(String(i.quantidade).replace('.', ','), 'dir num'), td(dinheiro(i.valor_centavos), 'dir num'), td(dinheiro(Math.round(i.quantidade * i.valor_centavos)), 'dir num'),
          el('td', { class: 'acoes' }, aberta() && pode(ctx) ? botaoIcone('lixo', 'Remover', async () => { await api.del(`${base(ctx)}/os/${id}/itens/${i.id}`); recarregar(); }, 'perigo') : null))),
        'Nenhuma peça ou serviço ainda.'),
        el('div', { class: 'linha entre' }, el('strong', {}, 'Total'), el('strong', { class: 'num', style: 'font-size:18px' }, dinheiro(o.total_centavos))),
        o.observacao ? el('p', { class: 'pequeno', style: 'margin:0' }, o.observacao) : null,
        el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap;justify-content:flex-end' },
          aberta() && pode(ctx) ? [
            botao('Adicionar peça ou serviço', '', novoItem), botao('Editar', '', editar),
            o.status === 'aberta' ? botao('Iniciar', '', async () => { await api.post(`${base(ctx)}/os/${id}/iniciar`); recarregar(); }) : null,
            botao('Cancelar OS', 'perigo', async () => { if (await confirmar('Cancelar OS', `Cancelar a OS #${o.numero}?`, 'Cancelar OS')) { await api.post(`${base(ctx)}/os/${id}/cancelar`); recarregar(); } }),
            botao('Concluir', 'primario', concluir)] : null,
          el('button', { class: 'btn', type: 'button', onclick: () => fechar() }, 'Fechar')));
    }
    desenhar();
    return corpo;
  }, { largo: true });
}

async function telaOS(ctx) {
  await tela(ctx, async () => {
    let filtro = 'abertas';
    const lista = el('div');
    const chips = el('div', { class: 'chips' });
    async function carregar() {
      limpar(chips, Object.entries({ abertas: 'Abertas', concluida: 'Concluídas', cancelada: 'Canceladas', '': 'Todas' }).map(([k, t]) =>
        el('button', { type: 'button', class: `chip${k === filtro ? ' on' : ''}`, onclick: () => { filtro = k; carregar(); } }, t)));
      const os = await api.get(`${base(ctx)}/os${qs({ status: filtro || undefined })}`);
      limpar(lista, tabela(['Nº', 'Veículo', 'Serviço', 'Tipo', 'Prioridade', 'Situação', 'Fornecedor', '>Total', 'Aberta em'], os.map((o) => el('tr', { class: 'clicavel', onclick: () => abrirOS(ctx, o.id) },
        td(el('strong', {}, `#${o.numero}`)), td(placa(o.placa)), td([o.descricao, o.parado ? el('div', {}, etiqueta('parado', 'erro')) : null]), td(TIPO_OS[o.tipo]),
        td(etiqueta(...PRIORIDADE[o.prioridade])), td(etiqueta(...STATUS_OS[o.status])), td(o.fornecedor ?? '—'), td(dinheiro(o.total_centavos), 'dir num'), td(dataHora(o.aberta_em)))),
      'Nenhuma ordem de serviço aqui.'));
    }
    ctx.recarregar = carregar;
    limpar(ctx.conteudo, acoesTopo(chips, pode(ctx) ? el('button', { class: 'btn primario', onclick: () => novaOS(ctx) }, 'Nova OS') : null), cartao(null, lista));
    await carregar();
  });
}

// ---------- Peças do plano: ações comuns (plano, desenho do motor e freios) ----------
const TOM_COMP = { ok: 'ok', atencao: 'aviso', vencido: 'erro' };
/** "82% · faltam 1.200 km" (ou o que passou, ou a data). */
const textoUso = (x) => `${Math.round(x.pct)}%${x.restante_km !== null ? (x.restante_km >= 0 ? ` · faltam ${inteiro(x.restante_km)} km` : ` · passou ${inteiro(-x.restante_km)} km`)
  : x.previsao ? ` · até ${data(x.previsao)}` : ''}`;
const registrarTroca = (ctx, comp) => formModal(`Registrar troca · ${comp.nome}`, () => [
  el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Troca feita sem OS (ex.: na estrada). Com OS, a troca é registrada ao concluir a OS.'),
  el('div', { class: 'duas' }, campo('Km', { name: 'km', type: 'number', min: 0, value: comp.km_atual }), campo('Data', { name: 'data', type: 'date', value: hojeLocal() })),
  el('div', { class: 'duas' }, campo('Custo (R$)', { name: 'custo', inputmode: 'decimal' }), campo('Marca da peça nova', { name: 'marca', maxlength: 60, value: comp.marca ?? '' })),
], (d) => api.post(`${base(ctx)}/componentes/${comp.id}/trocar`, { km: d.km, data: d.data, custo_centavos: centavos(d.custo) ?? 0, marca: d.marca }), { rotulo: 'Registrar troca' })
  .then((r) => { if (r) toast('Troca registrada: a vida útil recomeçou.'); return r; });
/** Inclui a peça no plano do veículo com a vida útil de referência do catálogo (instalada no km de hoje). */
async function incluirNoPlano(ctx, veiculoId, tipo) {
  const x = (await cat(ctx)).componentes[tipo];
  await api.post(`${base(ctx)}/componentes`, { veiculo_id: veiculoId, tipo, vida_km: x.km ?? '', vida_dias: x.dias ?? '' });
  toast(`${x.nome} incluído no plano, instalado no km de hoje. Ajuste o km da última troca se souber.`);
}
/** Ficha rápida de uma peça: uso, próxima troca e as ações. */
const acoesComponente = (ctx, comp, { aoEditar, depois } = {}) => modal(`${comp.nome} · ${placa(comp.placa)}`, (fechar) => {
  const fazer = (fn) => async () => { fechar(); const r = await fn(); if (r) depois?.(); };
  return [
    el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap' }, etiqueta(...ESTADO[comp.estado]), etiqueta(comp.grupo, 'info')),
    barraVida(comp.pct),
    el('div', { class: 'grade-dados' },
      el('div', {}, el('span', { class: 'mudo pequeno' }, 'Instalado'), el('div', {}, `${kmTxt(comp.instalado_km)} · ${data(comp.instalado_em)}`)),
      el('div', {}, el('span', { class: 'mudo pequeno' }, 'Vida útil'), el('div', {}, [comp.vida_km ? kmTxt(comp.vida_km) : null, comp.vida_dias ? `${inteiro(comp.vida_dias)} dias` : null].filter(Boolean).join(' ou '))),
      el('div', {}, el('span', { class: 'mudo pequeno' }, 'Próxima troca'), el('div', {}, [comp.proxima_km ? kmTxt(comp.proxima_km) : null, previsaoUtil(comp.previsao) ? `por volta de ${data(comp.previsao)}` : null].filter(Boolean).join(' · ') || '—'))),
    el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-top:6px' },
      pode(ctx) ? [botao('Abrir OS', 'primario', fazer(() => novaOS(ctx, { veiculo_id: comp.veiculo_id, tipo: 'preventiva', componentes: [comp.id], descricao: `Troca: ${comp.nome}` }))),
        botao('Registrar troca', '', fazer(() => registrarTroca(ctx, comp))), aoEditar ? botao('Editar', '', fazer(() => aoEditar(comp))) : null] : null,
      el('button', { class: 'btn', type: 'button', onclick: () => fechar() }, 'Fechar')),
  ];
});

// ---------- Desenho do motor (visto de cima, frente do carro no alto) ----------
// Cada peça: o desenho (no cofre, deslocado 60 px para dar lugar às etiquetas), o ponto de ligação e a altura da etiqueta.
const DX = 80;
const PECAS_MOTOR = {
  arrefecimento: { nome: 'Água do radiador', lado: 'dir', ly: 70, anc: [470, 77],
    svg: `<rect class="mt-peca" x="170" y="58" width="300" height="38" rx="8"/>${Array.from({ length: 14 }, (_, i) => `<line class="mt-fio" x1="${186 + i * 20}" x2="${186 + i * 20}" y1="64" y2="90"/>`).join('')}` },
  correia_acessorios: { nome: 'Correia de acessórios', lado: 'esq', ly: 140, anc: [236, 140],
    svg: `<path class="mt-correia" d="M250 126 L390 126 Q404 126 404 140 L344 188 Q320 198 296 188 L236 140 Q236 126 250 126 Z"/>
      <circle class="mt-peca" cx="250" cy="140" r="14"/><circle class="mt-peca" cx="390" cy="140" r="14"/><circle class="mt-peca" cx="320" cy="178" r="20"/>` },
  filtro_ar: { nome: 'Filtro de ar', lado: 'esq', ly: 222, anc: [132, 236],
    svg: `<rect class="mt-peca" x="132" y="198" width="80" height="78" rx="12"/><path class="mt-fio" d="M212 236 Q224 236 230 230"/><circle class="mt-fio-c" cx="172" cy="237" r="18"/>` },
  velas: { nome: 'Velas de ignição', lado: 'dir', ly: 150, anc: [380, 250],
    svg: [260, 300, 340, 380].map((x) => `<circle class="mt-peca" cx="${x}" cy="250" r="12"/><rect class="mt-fio-c" x="${x - 3}" y="236" width="6" height="10" rx="2"/>`).join('') },
  bateria: { nome: 'Bateria', lado: 'dir', ly: 230, anc: [508, 235],
    svg: `<rect class="mt-peca" x="448" y="200" width="60" height="70" rx="8"/><rect class="mt-fio-c" x="456" y="192" width="12" height="10" rx="2"/><rect class="mt-fio-c" x="488" y="192" width="12" height="10" rx="2"/>
      <text class="mt-sinal" x="462" y="242">+</text><text class="mt-sinal" x="488" y="242">−</text>` },
  correia_dentada: { nome: 'Correia dentada', lado: 'dir', ly: 310, anc: [438, 300],
    svg: `<rect class="mt-peca" x="414" y="200" width="24" height="170" rx="10"/>${Array.from({ length: 9 }, (_, i) => `<line class="mt-fio" x1="418" x2="434" y1="${214 + i * 18}" y2="${214 + i * 18}"/>`).join('')}` },
  oleo_motor: { nome: 'Óleo do motor', lado: 'dir', ly: 390, anc: [316, 330],
    svg: `<circle class="mt-peca" cx="300" cy="330" r="18"/><path class="mt-fio-c" d="M300 320 Q309 332 300 340 Q291 332 300 320 Z"/>` },
  filtro_oleo: { nome: 'Filtro de óleo', lado: 'esq', ly: 302, anc: [204, 325],
    svg: `<rect class="mt-peca" x="202" y="298" width="24" height="56" rx="10"/><line class="mt-fio" x1="204" x2="224" y1="310" y2="310"/><line class="mt-fio" x1="204" x2="224" y1="342" y2="342"/>` },
  embreagem: { nome: 'Embreagem', lado: 'esq', ly: 382, anc: [262, 394],
    svg: `<rect class="mt-peca" x="262" y="384" width="116" height="22" rx="10"/>` },
  oleo_cambio: { nome: 'Óleo do câmbio', lado: 'dir', ly: 470, anc: [370, 446],
    svg: `<path class="mt-peca" d="M272 410 L368 410 L358 484 Q320 494 282 484 Z"/><line class="mt-fio" x1="320" x2="320" y1="420" y2="476"/>` },
  filtro_combustivel: { nome: 'Filtro de combustível', lado: 'esq', ly: 462, anc: [150, 430],
    svg: `<rect class="mt-peca" x="150" y="418" width="56" height="24" rx="12"/><line class="mt-fio" x1="206" x2="230" y1="430" y2="430"/>` },
  fluido_freio: { nome: 'Fluido de freio', lado: 'dir', ly: 550, anc: [500, 430],
    svg: `<rect class="mt-peca" x="462" y="404" width="38" height="46" rx="8"/><rect class="mt-fio-c" x="472" y="396" width="18" height="10" rx="3"/>` },
};

const familiaDe = (tipo) => (tipo === 'moto' ? 'moto' : ['caminhao', 'onibus', 'maquina'].includes(tipo) ? 'pesado' : 'leve');

function desenhoMotor(ctx, comps, aoClicar, plano = null) {
  const W = 800; const H = 620; const LW = 190; const LH = 50;
  const ativo = new Map(comps.map((x) => [x.tipo, x]));
  const pecas = []; const etiquetas = [];
  const existe = (tipo) => !plano || plano.includes(tipo) || ativo.has(tipo);
  for (const [tipo, p] of Object.entries(PECAS_MOTOR)) {
    if (!existe(tipo)) continue;
    const comp = ativo.get(tipo);
    const tom = comp ? TOM_COMP[comp.estado] : 'ausente';
    pecas.push(`<g class="mt-grupo vp-${tom}" data-tipo="${tipo}" role="button" tabindex="0" aria-label="${esc(p.nome)}">${p.svg}</g>`);
    const lx = p.lado === 'esq' ? 8 : W - LW - 8;
    const [ax, ay] = [p.anc[0] + DX, p.anc[1]];
    etiquetas.push(`<g class="vp-etiqueta vp-${tom}" data-tipo="${tipo}" role="button" tabindex="-1">
      <line class="vp-ligacao" x1="${ax}" y1="${ay}" x2="${p.lado === 'esq' ? lx + LW : lx}" y2="${p.ly + LH / 2}"/>
      <rect x="${lx}" y="${p.ly}" width="${LW}" height="${LH}" rx="12" class="vp-cartao"/>
      <circle cx="${lx + 16}" cy="${p.ly + 17}" r="5" class="vp-ponto"/>
      <text x="${lx + 28}" y="${p.ly + 21}" class="vp-t1">${esc(p.nome)}</text>
      <text x="${lx + 16}" y="${p.ly + 39}" class="vp-t2">${comp ? esc(textoUso(comp)) : (pode(ctx) ? '+ incluir no plano' : 'fora do plano')}</text></g>`);
  }
  const raiz = el('div', { class: 'veiculo-ilustrado motor-ilustrado' });
  raiz.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Motor">
    <text x="${W / 2}" y="24" class="vp-frente">▲ FRENTE</text>
    <g transform="translate(${DX} 0)">
      <rect class="mt-cofre" x="120" y="40" width="400" height="472" rx="34"/>
      <rect class="mt-bloco" x="230" y="196" width="180" height="180" rx="20"/>
      <text class="mt-rotulo" x="320" y="296">MOTOR</text>
      <line class="mt-firewall" x1="128" x2="512" y1="500" y2="500"/>
      ${pecas.join('')}
    </g>${etiquetas.join('')}
    <text x="${W / 2}" y="${H - 8}" class="vp-frente">CABINE</text></svg>`;
  for (const g of raiz.querySelectorAll('[data-tipo]')) {
    const abrir = () => aoClicar(g.dataset.tipo, ativo.get(g.dataset.tipo));
    g.addEventListener('click', abrir);
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(); } });
  }
  // Celular: cada peça numa lista legível, embaixo do desenho.
  const CLASSE = { ok: 'ok', aviso: 'aviso', erro: 'erro', ausente: 'vazia' };
  raiz.append(el('div', { class: 'lista-pneus-cel' }, Object.entries(PECAS_MOTOR).filter(([tipo]) => existe(tipo)).map(([tipo, p]) => {
    const comp = ativo.get(tipo);
    return el('button', { type: 'button', class: CLASSE[comp ? TOM_COMP[comp.estado] : 'ausente'], onclick: () => aoClicar(tipo, comp) },
      el('strong', {}, p.nome), el('span', { class: 'pequeno' }, comp ? textoUso(comp) : (pode(ctx) ? '+ incluir' : 'fora do plano')));
  })));
  return raiz;
}

// ---------- Plano preventivo (componentes) ----------
async function telaPreventiva(ctx) {
  await tela(ctx, async () => {
    const [veiculos, c] = await Promise.all([veiculosDa(ctx), cat(ctx)]);
    let veiculoId = sessionStorage.getItem('gestao.veiculo') || '';
    const lista = el('div');
    const sel = escolha(null, 'veiculo', { '': 'Todos os veículos', ...opcoesVeiculos(veiculos) }, veiculoId);
    sel.addEventListener('change', () => { veiculoId = sel.value; sessionStorage.setItem('gestao.veiculo', veiculoId); carregar(); });
    const tipos = Object.fromEntries(Object.entries(c.componentes).map(([k, x]) => [k, `${x.grupo} · ${x.nome}`]));
    const form = (comp, pre = {}) => formModal(comp ? `Editar ${comp.nome}` : 'Novo componente', (f) => {
      const t0 = comp?.tipo ?? pre.tipo ?? 'oleo_motor';
      const tipo = escolha('Componente', 'tipo', tipos, comp?.tipo ?? t0);
      const vidaKm = campo('Vida útil (km)', { name: 'vida_km', type: 'number', min: 1, value: comp ? comp.vida_km ?? '' : c.componentes[t0].km ?? '' });
      const vidaDias = campo('Ou tempo (dias)', { name: 'vida_dias', type: 'number', min: 1, value: comp ? comp.vida_dias ?? '' : c.componentes[t0].dias ?? '' });
      // Ao escolher o componente, sugere a vida útil de referência.
      if (!comp) tipo.querySelector('select').addEventListener('change', (e) => { const x = c.componentes[e.target.value]; f.vida_km.value = x.km ?? ''; f.vida_dias.value = x.dias ?? ''; });
      return [
        comp ? null : escolha('Veículo', 'veiculo_id', opcoesVeiculos(veiculos), veiculoId || veiculos[0]?.id),
        el('div', { class: 'duas' }, tipo, campo('Nome (opcional)', { name: 'nome', maxlength: 80, value: comp?.nome ?? '', placeholder: 'Usa o nome do componente' })),
        el('div', { class: 'duas' }, vidaKm, vidaDias),
        el('div', { class: 'duas' }, campo('Instalado no km (vazio = km de hoje)', { name: 'instalado_km', type: 'number', min: 0, value: comp?.instalado_km ?? '' }),
          campo('Instalado em', { name: 'instalado_em', type: 'date', value: comp?.instalado_em?.slice(0, 10) ?? hojeLocal() })),
        el('div', { class: 'duas' }, campo('Posição (opcional)', { name: 'posicao', maxlength: 40, value: comp?.posicao ?? '', placeholder: 'Ex.: dianteira' }),
          campo('Marca (opcional)', { name: 'marca', maxlength: 60, value: comp?.marca ?? '' })),
        campo('Custo da peça (R$)', { name: 'custo', inputmode: 'decimal', value: comp ? reaisCampo(comp.custo_centavos) : '' }),
      ];
    }, (d) => {
      const corpo = { ...d, custo_centavos: centavos(d.custo) ?? 0 };
      return comp ? api.put(`${base(ctx)}/componentes/${comp.id}`, corpo) : api.post(`${base(ctx)}/componentes`, corpo);
    }).then((r) => { if (r) { toast('Componente salvo.'); carregar(); } });
    const trocar = (comp) => registrarTroca(ctx, comp).then((r) => r && carregar());
    const motor = el('div');
    const historico = async () => {
      if (!veiculoId) return toast('Escolha um veículo para ver o histórico.', true);
      const h = await api.get(`${base(ctx)}/veiculos/${veiculoId}/historico`);
      modal(`Histórico de manutenção · ${nomeVeiculo(veiculos.find((x) => String(x.id) === String(veiculoId)))}`, (fechar) => [
        el('h3', {}, 'Trocas de componentes'),
        tabela(['Componente', 'Instalado', 'Trocado', '>Rodou', '>Custo', 'OS'], h.componentes.map((x) => el('tr', {},
          td(x.nome), td(`${kmTxt(x.instalado_km)} · ${data(x.instalado_em)}`), td(`${kmTxt(x.trocado_km)} · ${data(x.trocado_em)}`), td(kmTxt(x.trocado_km - x.instalado_km), 'dir num'),
          td(dinheiro(x.custo_centavos), 'dir num'), td(x.os_numero ? `#${x.os_numero}` : '—'))), 'Nenhuma troca registrada ainda.'),
        el('h3', {}, 'Ordens de serviço'),
        tabela(['Nº', 'Serviço', 'Situação', '>Total', 'Aberta'], h.os.map((o) => el('tr', {}, td(`#${o.numero}`), td(o.descricao), td(etiqueta(...STATUS_OS[o.status])), td(dinheiro(o.total_centavos), 'dir num'), td(data(o.aberta_em))))
          , 'Nenhuma OS.'),
        el('div', { class: 'linha', style: 'justify-content:flex-end' }, el('button', { class: 'btn primario', onclick: () => fechar() }, 'Fechar')),
      ], { largo: true });
    };
    async function carregar() {
      const comps = await api.get(`${base(ctx)}/componentes${qs({ veiculo_id: veiculoId || undefined })}`);
      // Com um veículo escolhido: o motor desenhado, cada peça na cor do desgaste.
      const v = veiculos.find((x) => String(x.id) === String(veiculoId));
      limpar(motor, v ? cartao(`Motor de ${placa(v.placa)}`, el('div', { class: 'pneus-topo' },
        desenhoMotor(ctx, comps, async (tipo, comp) => {
          if (comp) return acoesComponente(ctx, comp, { aoEditar: (x) => form(x), depois: carregar });
          if (!pode(ctx)) return;
          if (await confirmar(`Incluir ${c.componentes[tipo].nome}`, 'Esta peça ainda não está no plano deste veículo. Incluir com a vida útil de referência, instalada no km de hoje?', 'Incluir')) {
            await incluirNoPlano(ctx, v.id, tipo); carregar();
          }
        }, c.planos[familiaDe(v.tipo)]),
        el('div', { class: 'coluna', style: 'gap:10px;max-width:320px' },
          el('div', { class: 'legenda' }, etiqueta('em dia', 'ok'), etiqueta('atenção: 85%', 'aviso'), etiqueta('vencido', 'erro'), etiqueta('fora do plano', '')),
          el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Toque numa peça para trocar, abrir OS ou editar. A cor sai do km do rastreador e do tempo desde a última troca.'),
          el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Freios e pastilhas aparecem também no desenho dos pneus.')))) : null);
      const umVeiculo = Boolean(veiculoId);
      limpar(lista, tabela([umVeiculo ? null : 'Veículo', 'Componente', 'Instalado', 'Vida útil', 'Uso', 'Próxima troca', 'Situação', '^Ações'].filter(Boolean), comps.map((x) => el('tr', {},
        umVeiculo ? null : td([el('strong', {}, placa(x.placa)), el('div', { class: 'pequeno mudo' }, `hoje ${kmTxt(x.km_atual)}`)], 'sem-quebra'),
        td([x.nome, el('div', { class: 'pequeno mudo' }, [x.grupo, x.posicao, x.marca].filter(Boolean).join(' · '))]),
        td([kmTxt(x.instalado_km), el('div', { class: 'pequeno mudo' }, data(x.instalado_em))], 'sem-quebra'),
        td([x.vida_km ? kmTxt(x.vida_km) : null, x.vida_dias ? `${inteiro(x.vida_dias)} dias` : null].filter(Boolean).join(' ou ')),
        td(barraVida(x.pct)),
        td([x.proxima_km ? kmTxt(x.proxima_km) : '—', el('div', { class: 'pequeno mudo' }, x.restante_km !== null ? (x.restante_km >= 0 ? `faltam ${inteiro(x.restante_km)} km` : `passou ${inteiro(-x.restante_km)} km`) : ''),
          previsaoUtil(x.previsao) ? el('div', { class: 'pequeno mudo' }, `por volta de ${data(x.previsao)}`) : null], 'sem-quebra'),
        td(etiqueta(...ESTADO[x.estado])),
        el('td', { class: 'acoes' }, pode(ctx) ? [
          x.estado !== 'ok' ? botao('Abrir OS', 'primario', () => novaOS(ctx, { veiculo_id: x.veiculo_id, tipo: 'preventiva', componentes: [x.id], descricao: `Troca: ${x.nome}` })) : null,
          botaoIcone('check', 'Registrar troca sem OS', () => trocar(x)), botaoIcone('editar', 'Editar', () => form(x)),
          botaoIcone('lixo', 'Excluir', async () => { if (await confirmar('Excluir componente', `Tirar ${x.nome} do plano de ${placa(x.placa)}?`, 'Excluir')) { await api.del(`${base(ctx)}/componentes/${x.id}`); carregar(); } }, 'perigo')] : null))),
      veiculoId ? 'Este veículo ainda não tem plano preventivo. Use "Aplicar plano padrão" para começar com os itens de referência.' : 'Nenhum componente no plano. Escolha um veículo e aplique o plano padrão.'));
    }
    limpar(ctx.conteudo,
      acoesTopo(el('div', { class: 'linha', style: 'gap:10px;flex-wrap:wrap' }, el('label', { class: 'campo', style: 'min-width:260px' }, 'Veículo', sel),
        el('p', { class: 'mudo pequeno', style: 'margin:0;max-width:380px' }, 'O desgaste sai do km real do rastreador e do tempo desde a instalação: ninguém precisa digitar o hodômetro.')),
      pode(ctx) ? el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap' },
        el('button', { class: 'btn', onclick: historico }, icone('historico'), 'Histórico'),
        el('button', { class: 'btn', onclick: async () => {
          if (!veiculoId) return toast('Escolha o veículo para aplicar o plano padrão.', true);
          const r = await api.post(`${base(ctx)}/veiculos/${veiculoId}/plano-padrao`, {});
          toast(r.criados ? `${r.criados} componente(s) adicionados com a vida útil de referência. Ajuste o km e a data da última troca de cada um.` : 'O plano padrão já está aplicado neste veículo.');
          carregar();
        } }, 'Aplicar plano padrão'),
        el('button', { class: 'btn primario', onclick: () => (veiculos.length ? form(null) : toast('Cadastre um veículo antes.', true)) }, 'Novo componente')) : null),
      motor, cartao(null, lista));
    await carregar();
  });
}

// ---------- Pneus ----------
// ---------- Ilustração dos pneus: o veículo visto de cima, com cada pneu no lugar real ----------
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Corpo de cada tipo de veículo (SVG) e onde fica cada pneu (centro, tamanho e de que lado vai a etiqueta).
const FIGURAS = {
  leve: {
    w: 620, h: 660, pneu: [38, 88],
    corpo: `
      <rect class="vp-sombra" x="208" y="58" width="204" height="518" rx="86"/>
      <rect class="vp-lataria" x="210" y="52" width="200" height="520" rx="84"/>
      <path class="vp-capo" d="M226 150 Q310 70 394 150 L386 196 Q310 178 234 196 Z"/>
      <path class="vp-vidro" d="M236 206 Q310 186 384 206 L374 262 Q310 250 246 262 Z"/>
      <rect class="vp-teto" x="246" y="270" width="128" height="150" rx="22"/>
      <path class="vp-vidro" d="M248 428 Q310 440 372 428 L382 474 Q310 492 238 474 Z"/>
      <rect class="vp-detalhe" x="244" y="88" width="38" height="11" rx="5.5" transform="rotate(-14 263 93)"/><rect class="vp-detalhe" x="338" y="88" width="38" height="11" rx="5.5" transform="rotate(14 357 93)"/>
      <rect class="vp-luz-tras" x="244" y="526" width="38" height="10" rx="5" transform="rotate(14 263 531)"/><rect class="vp-luz-tras" x="338" y="526" width="38" height="10" rx="5" transform="rotate(-14 357 531)"/>
      <ellipse class="vp-lataria" cx="200" cy="232" rx="14" ry="9"/><ellipse class="vp-lataria" cx="420" cy="232" rx="14" ry="9"/>`,
    rodas: { DE: [192, 150, 'esq'], DD: [428, 150, 'dir'], TE: [192, 460, 'esq'], TD: [428, 460, 'dir'], EST: [310, 618, 'estepe'] },
    freios: { dianteiro: { ys: [150], xs: [234, 386], cx: 310 }, traseiro: { ys: [460], xs: [234, 386], cx: 310 } },
  },
  moto: {
    w: 560, h: 600, pneu: [34, 124],
    corpo: `
      <rect class="vp-lataria" x="206" y="112" width="148" height="14" rx="7"/>
      <path class="vp-lataria" d="M262 168 Q280 150 298 168 L306 300 Q280 316 254 300 Z"/>
      <rect class="vp-teto" x="256" y="308" width="48" height="118" rx="22"/>
      <rect class="vp-vidro" x="264" y="176" width="32" height="40" rx="10"/>
      <circle class="vp-detalhe" cx="210" cy="119" r="8"/><circle class="vp-detalhe" cx="350" cy="119" r="8"/>`,
    rodas: { D: [280, 120, 'dir'], T: [280, 478, 'dir'] },
    freios: { dianteiro: { ys: [120], xs: [242], cx: 120 }, traseiro: { ys: [478], xs: [242], cx: 120 } },
  },
  caminhao: {
    w: 660, h: 1060, pneu: [32, 94],
    corpo: `
      <rect class="vp-sombra" x="222" y="46" width="216" height="186" rx="34"/>
      <rect class="vp-lataria" x="224" y="40" width="212" height="186" rx="34"/>
      <path class="vp-vidro" d="M244 70 Q330 52 416 70 L408 118 Q330 106 252 118 Z"/>
      <rect class="vp-teto" x="252" y="128" width="156" height="84" rx="16"/>
      <ellipse class="vp-lataria" cx="212" cy="96" rx="12" ry="18"/><ellipse class="vp-lataria" cx="448" cy="96" rx="12" ry="18"/>
      <rect class="vp-chassi" x="292" y="226" width="76" height="20"/>
      <rect class="vp-sombra" x="234" y="252" width="196" height="700" rx="12"/>
      <rect class="vp-bau" x="232" y="244" width="196" height="700" rx="12"/>
      <g class="vp-frisos">${Array.from({ length: 13 }, (_, i) => `<line x1="244" x2="416" y1="${300 + i * 50}" y2="${300 + i * 50}"/>`).join('')}</g>
      <rect class="vp-luz-tras" x="246" y="930" width="36" height="8" rx="4"/><rect class="vp-luz-tras" x="378" y="930" width="36" height="8" rx="4"/>`,
    rodas: { '1E': [208, 150, 'esq'], '1D': [452, 150, 'dir'], '2EE': [176, 690, 'esq'], '2EI': [212, 690, 'esq'], '2DI': [448, 690, 'dir'], '2DE': [484, 690, 'dir'],
      '3EE': [176, 830, 'esq'], '3EI': [212, 830, 'esq'], '3DI': [448, 830, 'dir'], '3DE': [484, 830, 'dir'], EST: [330, 1010, 'estepe'] },
    freios: { dianteiro: { ys: [150], xs: [250, 410], cx: 330 }, traseiro: { ys: [690, 830], xs: [254, 406], cx: 330, ly: 760 } },
  },
  onibus: {
    w: 660, h: 940, pneu: [32, 94],
    corpo: `
      <rect class="vp-sombra" x="226" y="36" width="212" height="810" rx="46"/>
      <rect class="vp-lataria" x="224" y="30" width="212" height="810" rx="46"/>
      <path class="vp-vidro" d="M244 62 Q330 40 416 62 L410 120 Q330 108 250 120 Z"/>
      <rect class="vp-teto" x="250" y="132" width="160" height="680" rx="22"/>
      <g class="vp-frisos">${Array.from({ length: 6 }, (_, i) => `<rect x="268" y="${170 + i * 104}" width="124" height="70" rx="10"/>`).join('')}</g>
      <rect class="vp-luz-tras" x="244" y="822" width="40" height="8" rx="4"/><rect class="vp-luz-tras" x="376" y="822" width="40" height="8" rx="4"/>`,
    rodas: { '1E': [208, 190, 'esq'], '1D': [452, 190, 'dir'], '2EE': [176, 640, 'esq'], '2EI': [212, 640, 'esq'], '2DI': [448, 640, 'dir'], '2DE': [484, 640, 'dir'], EST: [330, 890, 'estepe'] },
    freios: { dianteiro: { ys: [190], xs: [250, 410], cx: 330 }, traseiro: { ys: [640], xs: [254, 406], cx: 330 } },
  },
};
const figuraDe = (tipo) => FIGURAS[tipo === 'moto' ? 'moto' : tipo === 'caminhao' ? 'caminhao' : tipo === 'onibus' ? 'onibus' : 'leve'];
const COR_PNEU = { ok: 'ok', atencao: 'aviso', trocar: 'erro', sem_medicao: 'neutro' };

/** Miniatura do veículo visto de cima (cadastro do veículo): muda junto com o tipo escolhido. */
export function miniaturaVeiculo(tipo) {
  const f = figuraDe(tipo);
  const [tw, th] = f.pneu;
  const rodas = Object.values(f.rodas).map(([x, y, lado]) => (lado === 'estepe'
    ? `<circle cx="${x}" cy="${y}" r="34" class="vp-pneu"/><circle cx="${x}" cy="${y}" r="15" class="vp-aro"/>`
    : `<rect x="${x - tw / 2}" y="${y - th / 2}" width="${tw}" height="${th}" rx="${Math.min(12, tw / 2.6)}" class="vp-pneu"/>`)).join('');
  const discos = Object.values(f.freios ?? {}).flatMap((p) => p.ys.flatMap((y) => p.xs.map((x) => `<circle cx="${x}" cy="${y}" r="13" class="fr-rotor"/>`))).join('');
  // Recorta as sobras laterais (onde ficam as etiquetas no desenho grande).
  const xs = Object.values(f.rodas).map(([x]) => x);
  const x0 = Math.min(...xs) - 60; const x1 = Math.max(...xs) + 60;
  const d = el('div', { class: 'miniatura-veiculo' });
  d.innerHTML = `<svg viewBox="${x0} 0 ${x1 - x0} ${f.h}" role="img" aria-label="Desenho do veículo"><text x="${f.w / 2}" y="22" class="vp-frente">▲ FRENTE</text>${f.corpo}${discos}${rodas}</svg>`;
  return d;
}

const FREIOS = { dianteiro: ['pastilha_dianteira', 'disco_dianteiro'], traseiro: ['pastilha_traseira', 'disco_traseiro'] };
const PIOR = { vencido: 3, atencao: 2, ok: 1 };
/** Situação dos freios de cada eixo: as peças do plano e a pior delas manda na cor. */
function freiosDe(comps) {
  return Object.fromEntries(Object.entries(FREIOS).map(([eixo, tipos]) => {
    const itens = tipos.map((t) => comps.find((x) => x.tipo === t)).filter(Boolean);
    const pior = itens.reduce((a, x) => (PIOR[x.estado] > PIOR[a] ? x.estado : a), 'ok');
    return [eixo, { tipos, itens, tom: itens.length ? TOM_COMP[pior] : 'ausente' }];
  }));
}

function desenhoPneus(ctx, mapa, aoClicar, freios = null, aoFreio = null) {
  const f = figuraDe(mapa.veiculo.tipo);
  const [tw, th] = f.pneu;
  const porCodigo = new Map(mapa.posicoes.map((p) => [p.codigo, p]));
  // Etiquetas: duas por lado num eixo duplo (externo em cima, interno embaixo), uma no eixo simples.
  const LW = 150; const LH = 50;
  const partes = [];
  const etiquetas = [];
  const grupos = new Map();
  for (const [cod, [x, y, lado]] of Object.entries(f.rodas)) {
    if (!porCodigo.has(cod)) continue;
    const k = `${lado}:${y}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(cod);
  }
  // No eixo duplo, o pneu de fora (mais longe do chassi) fica com a etiqueta de cima, dos dois lados.
  for (const g of grupos.values()) g.sort((a, b) => Math.abs(f.rodas[b][0] - f.w / 2) - Math.abs(f.rodas[a][0] - f.w / 2));
  for (const [cod, [x, y, lado]] of Object.entries(f.rodas)) {
    const pos = porCodigo.get(cod);
    if (!pos) continue;
    const p = pos.pneu;
    const tom = p ? COR_PNEU[p.estado] ?? 'neutro' : 'vazia';
    const estepe = lado === 'estepe';
    // O pneu: borracha escura com os sulcos desenhados e o anel na cor do estado.
    if (estepe) {
      partes.push(`<g class="vp-roda vp-${tom}" data-pos="${esc(cod)}" tabindex="0" role="button" aria-label="${esc(pos.nome)}">
        <circle cx="${x}" cy="${y}" r="34" class="vp-pneu"/><circle cx="${x}" cy="${y}" r="15" class="vp-aro"/><circle cx="${x}" cy="${y}" r="40" class="vp-anel"/></g>`);
    } else {
      const sulcos = Array.from({ length: Math.floor(th / 12) }, (_, i) => `<line x1="${x - tw / 2 + 5}" x2="${x + tw / 2 - 5}" y1="${y - th / 2 + 9 + i * 12}" y2="${y - th / 2 + 9 + i * 12}"/>`).join('');
      partes.push(`<g class="vp-roda vp-${tom}" data-pos="${esc(cod)}" tabindex="0" role="button" aria-label="${esc(pos.nome)}">
        <rect x="${x - tw / 2 - 5}" y="${y - th / 2 - 5}" width="${tw + 10}" height="${th + 10}" rx="${tw / 2}" class="vp-anel"/>
        <rect x="${x - tw / 2}" y="${y - th / 2}" width="${tw}" height="${th}" rx="${Math.min(12, tw / 2.6)}" class="vp-pneu"/>
        <g class="vp-sulcos">${sulcos}</g></g>`);
    }
    // A etiqueta ao lado, ligada ao pneu por uma linha.
    const grupo = grupos.get(`${lado}:${y}`);
    const i = grupo.indexOf(cod);
    const ly = grupo.length > 1 ? y - LH - 4 + i * (LH + 8) : y - LH / 2;
    const lx = estepe ? x + 54 : lado === 'esq' ? 8 : lado === 'dir' ? f.w - LW - 8 : x + 30;
    const ancX = estepe ? x + 40 : lado === 'esq' ? x - tw / 2 - 6 : x + tw / 2 + 6;
    const fimX = lado === 'esq' ? lx + LW : lx;
    const linha1 = `${esc(cod)} · ${p ? esc(p.numero_fogo) : 'vazia'}`;
    const linha2 = p ? `${p.sulco_mm === null ? 'sem medição' : `${String(Math.round(p.sulco_mm * 10) / 10).replace('.', ',')} mm`} · ${inteiro(p.km_pneu)} km` : (pode(ctx) ? '+ montar pneu' : 'sem pneu');
    etiquetas.push(`<g class="vp-etiqueta vp-${tom}" data-pos="${esc(cod)}" role="button" tabindex="-1">
      ${grupo.length > 1 ? '' : `<line class="vp-ligacao" x1="${ancX}" y1="${y}" x2="${fimX}" y2="${ly + LH / 2}"/>`}
      <rect x="${lx}" y="${ly}" width="${LW}" height="${LH}" rx="12" class="vp-cartao"/>
      <circle cx="${lx + 16}" cy="${ly + 17}" r="5" class="vp-ponto"/>
      <text x="${lx + 28}" y="${ly + 21}" class="vp-t1">${linha1}</text>
      <text x="${lx + 16}" y="${ly + 39}" class="vp-t2">${linha2}</text></g>`);
  }
  // Freios: o disco com a pinça em cada roda e, no meio do eixo, a etiqueta com a pastilha e o disco.
  const freio = [];
  if (freios && f.freios) {
    const NOME = { pastilha_dianteira: 'pastilha', pastilha_traseira: 'pastilha', disco_dianteiro: 'disco', disco_traseiro: 'disco' };
    for (const [eixo, pos] of Object.entries(f.freios)) {
      const fr = freios[eixo];
      for (const y of pos.ys) for (const x of pos.xs) {
        freio.push(`<g class="fr-disco vp-${fr.tom}" data-freio="${eixo}" role="button" tabindex="0" aria-label="Freio ${eixo}">
          <circle cx="${x}" cy="${y}" r="15" class="fr-rotor"/><circle cx="${x}" cy="${y}" r="5" class="fr-cubo"/>
          <path class="fr-pinca" d="M${x - 9} ${y - 16} Q${x} ${y - 23} ${x + 9} ${y - 16} L${x + 7} ${y - 10} Q${x} ${y - 15} ${x - 7} ${y - 10} Z"/></g>`);
      }
      const yy = pos.ly ?? pos.ys[0];
      const w = 172; const lx = pos.cx - w / 2; const ly = yy + 26;
      const t2 = fr.itens.length ? fr.itens.map((c) => `${NOME[c.tipo]} ${Math.round(c.pct)}%`).join(' · ') : (pode(ctx) ? '+ incluir no plano' : 'fora do plano');
      freio.push(`<g class="vp-etiqueta fr-etiqueta vp-${fr.tom}" data-freio="${eixo}" role="button" tabindex="-1">
        <rect x="${lx}" y="${ly}" width="${w}" height="46" rx="12" class="vp-cartao"/>
        <circle cx="${lx + 15}" cy="${ly + 16}" r="5" class="vp-ponto"/>
        <text x="${lx + 27}" y="${ly + 20}" class="vp-t1">Freio ${eixo}</text>
        <text x="${lx + 15}" y="${ly + 37}" class="vp-t2">${esc(t2)}</text></g>`);
    }
  }
  const raiz = el('div', { class: 'veiculo-ilustrado' });
  raiz.innerHTML = `<svg viewBox="0 0 ${f.w} ${f.h}" role="img" aria-label="Pneus de ${esc(mapa.veiculo.placa)}">
    <text x="${f.w / 2}" y="22" class="vp-frente">▲ FRENTE</text>${f.corpo}${freio.filter((x) => x.includes('fr-disco')).join('')}${partes.join('')}${etiquetas.join('')}${freio.filter((x) => !x.includes('fr-disco')).join('')}</svg>`;
  for (const g of raiz.querySelectorAll('[data-freio]')) {
    const abrir = () => aoFreio?.(g.dataset.freio);
    g.addEventListener('click', abrir);
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(); } });
  }
  // Celular: a mesma informação numa lista legível, embaixo do desenho (pneus e depois os freios).
  const CLASSE_FR = { ok: 'ok', aviso: 'aviso', erro: 'erro', ausente: 'vazia' };
  const freiosCel = freios && f.freios ? Object.keys(f.freios).map((eixo) => el('button', { type: 'button', class: CLASSE_FR[freios[eixo].tom], onclick: () => aoFreio?.(eixo) },
    el('strong', {}, `Freio ${eixo}`),
    el('span', { class: 'pequeno' }, freios[eixo].itens.length ? freios[eixo].itens.map((c) => `${c.tipo.startsWith('disco') ? 'disco' : 'pastilha'} ${Math.round(c.pct)}%`).join(' · ') : (pode(ctx) ? '+ incluir' : 'fora do plano')))) : [];
  raiz.append(el('div', { class: 'lista-pneus-cel' }, [...mapa.posicoes.map((pos) => {
    const p = pos.pneu;
    const tom = p ? ({ ok: 'ok', atencao: 'aviso', trocar: 'erro' }[p.estado] ?? '') : 'vazia';
    return el('button', { type: 'button', class: tom, onclick: () => aoClicar(pos) },
      el('span', {}, el('strong', {}, `${pos.codigo} · ${p ? p.numero_fogo : 'vazia'}`), el('div', { class: 'pequeno mudo' }, pos.nome)),
      el('span', { class: 'pequeno' }, p ? `${mm(p.sulco_mm)} · ${kmTxt(p.km_pneu)}` : (pode(ctx) ? '+ montar' : '')));
  }), ...freiosCel]));
  for (const g of raiz.querySelectorAll('[data-pos]')) {
    const abrir = () => aoClicar(porCodigo.get(g.dataset.pos));
    g.addEventListener('click', abrir);
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(); } });
  }
  return raiz;
}

async function telaPneus(ctx) {
  await tela(ctx, async () => {
    const [veiculos, c] = await Promise.all([veiculosDa(ctx), cat(ctx)]);
    let veiculoId = sessionStorage.getItem('gestao.veiculo') || String(veiculos[0]?.id ?? '');
    if (veiculoId && !veiculos.some((x) => String(x.id) === veiculoId)) veiculoId = String(veiculos[0]?.id ?? '');
    const desenho = el('div');
    const estoque = el('div');
    const sel = escolha(null, 'veiculo', opcoesVeiculos(veiculos), veiculoId);
    sel.addEventListener('change', () => { veiculoId = sel.value; sessionStorage.setItem('gestao.veiculo', veiculoId); carregar(); });
    const P = (path, corpo) => api.post(`${base(ctx)}${path}`, corpo ?? {});
    const medir = (p) => formModal(`Medir sulco · ${p.numero_fogo}`, () => [
      campo('Sulco medido (mm)', { name: 'sulco', inputmode: 'decimal', required: true, placeholder: 'Ex.: 4,5' }),
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, `Limite legal: ${String(c.sulco_limite_mm).replace('.', ',')} mm. Abaixo de ${c.sulco_atencao_mm} mm o sistema avisa.`),
    ], (d) => P(`/pneus/${p.id}/medir`, { sulco_mm: String(d.sulco).replace(',', '.') }), { rotulo: 'Salvar medição' }).then((r) => r && carregar());
    const historico = async (p) => {
      const h = await api.get(`${base(ctx)}/pneus/${p.id}/historico`);
      const NOMES = { cadastro: 'Cadastro', montagem: 'Montagem', desmontagem: 'Desmontagem', rodizio: 'Rodízio', medicao: 'Medição', recapagem: 'Recapagem', conserto: 'Conserto', descarte: 'Descarte' };
      modal(`Pneu ${p.numero_fogo}`, (fechar) => [
        el('p', { class: 'mudo', style: 'margin-top:0' }, [p.marca, p.modelo, p.medida, p.dot ? `DOT ${p.dot}` : null, `vida ${p.vida}`].filter(Boolean).join(' · ')),
        el('div', { class: 'grade-dados' },
          el('div', {}, el('span', { class: 'mudo pequeno' }, 'Km rodado'), el('strong', {}, kmTxt(p.km_pneu))),
          el('div', {}, el('span', { class: 'mudo pequeno' }, 'Custo total'), el('strong', {}, dinheiro(p.custo_total_centavos))),
          el('div', {}, el('span', { class: 'mudo pequeno' }, 'Custo por km'), el('strong', {}, p.custo_km_centavos === null ? '—' : `R$ ${(p.custo_km_centavos / 100).toFixed(3).replace('.', ',')}`)),
          el('div', {}, el('span', { class: 'mudo pequeno' }, 'Sulco'), el('strong', {}, `${mm(p.sulco_mm)}${p.km_restante !== null ? ` · ~${inteiro(p.km_restante)} km até o limite` : ''}`))),
        tabela(['Quando', 'Evento', 'Veículo / posição', '>Km do pneu', '>Sulco', '>Custo', 'Por'], h.map((e) => el('tr', {},
          td(dataHora(e.criado_em)), td([NOMES[e.tipo], e.observacao ? el('div', { class: 'pequeno mudo' }, e.observacao) : null]), td(e.placa ? `${placa(e.placa)}${e.posicao ? ` · ${e.posicao}` : ''}` : '—'),
          td(kmTxt(e.km_pneu), 'dir num'), td(e.sulco_mm === null ? '—' : mm(e.sulco_mm), 'dir num'), td(e.custo_centavos ? dinheiro(e.custo_centavos) : '—', 'dir num'), td(e.motorista ? `${e.motorista} (motorista)` : e.usuario ?? '—')))),
        el('div', { class: 'linha', style: 'justify-content:flex-end' }, el('button', { class: 'btn primario', onclick: () => fechar() }, 'Fechar')),
      ], { largo: true });
    };
    const novo = (pre = {}) => formModal('Novo pneu', () => [
      el('div', { class: 'duas' }, campo('Número de fogo', { name: 'numero_fogo', required: true, maxlength: 30, placeholder: 'Marcado no pneu' }), campo('Medida', { name: 'medida', maxlength: 30, placeholder: 'Ex.: 205/55 R16' })),
      el('div', { class: 'tres' }, campo('Marca', { name: 'marca', maxlength: 60 }), campo('Modelo', { name: 'modelo', maxlength: 60 }), campo('DOT', { name: 'dot', maxlength: 20, placeholder: 'Ex.: 2325' })),
      el('div', { class: 'tres' }, campo('Custo (R$)', { name: 'custo', inputmode: 'decimal' }), campo('Sulco novo (mm)', { name: 'sulco_novo_mm', inputmode: 'decimal', placeholder: 'Ex.: 8' }),
        escolha('Vida', 'vida', { 0: 'Novo', 1: '1ª recapagem', 2: '2ª recapagem', 3: '3ª recapagem' }, 0)),
      pre.posicao ? el('p', { class: 'pequeno', style: 'margin:0' }, `Será montado em ${pre.nome}.`) : null,
    ], (d) => P('/pneus', { ...d, custo_centavos: centavos(d.custo) ?? 0, sulco_novo_mm: d.sulco_novo_mm ? d.sulco_novo_mm.replace(',', '.') : '', veiculo_id: pre.posicao ? veiculoId : undefined, posicao: pre.posicao }),
    { rotulo: 'Cadastrar' }).then((r) => { if (r) { toast('Pneu cadastrado.'); carregar(); } });
    const montarEm = async (pos) => {
      const livres = await api.get(`${base(ctx)}/pneus?status=estoque`);
      if (!livres.length) return novo({ posicao: pos.codigo, nome: pos.nome });
      const r = await formModal(`Montar em ${pos.nome}`, () => [
        escolha('Pneu do estoque', 'pneu_id', Object.fromEntries(livres.map((p) => [p.id, `${p.numero_fogo} · ${[p.marca, p.medida].filter(Boolean).join(' ')} · ${mm(p.sulco_mm)} · ${kmTxt(p.km_pneu)}`])), livres[0].id),
        el('button', { type: 'button', class: 'btn pequeno', onclick: (e) => { e.target.closest('.modal-fundo').fechar(); novo({ posicao: pos.codigo, nome: pos.nome }); } }, 'Cadastrar um pneu novo'),
      ], (d) => P(`/pneus/${d.pneu_id}/montar`, { veiculo_id: veiculoId, posicao: pos.codigo }), { rotulo: 'Montar' });
      if (r) { toast('Pneu montado.'); carregar(); }
    };
    const acoesMontado = (pos) => modal(`${pos.nome} · pneu ${pos.pneu.numero_fogo}`, (fechar) => {
      const p = pos.pneu;
      const fazer = (fn) => async () => { fechar(); await fn(); };
      return [
        el('p', { class: 'mudo', style: 'margin-top:0' }, `${[p.marca, p.medida].filter(Boolean).join(' ')} · sulco ${mm(p.sulco_mm)} · ${kmTxt(p.km_pneu)} rodados`),
        el('div', { class: 'coluna', style: 'gap:8px' },
          botao('Ver histórico e custo por km', '', fazer(() => historico(p))),
          pode(ctx) ? [botao('Medir sulco', 'primario', fazer(() => medir(p))),
            botao('Desmontar para o estoque', '', fazer(() => desmontar(p, 'estoque'))),
            botao('Desmontar e mandar para a recapagem', '', fazer(() => desmontar(p, 'recapagem'))),
            botao('Desmontar e descartar', 'perigo', fazer(() => desmontar(p, 'descartado')))] : null),
        el('div', { class: 'linha', style: 'justify-content:flex-end;margin-top:12px' }, el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar')),
      ];
    });
    const desmontar = (p, destino) => formModal(`Desmontar ${p.numero_fogo}`, () => [
      campo('Sulco na desmontagem (mm, opcional)', { name: 'sulco_mm', inputmode: 'decimal' }),
      destino === 'descartado' ? campo('Motivo do descarte', { name: 'motivo', maxlength: 200, placeholder: 'Ex.: corte lateral' }) : null,
    ], (d) => P(`/pneus/${p.id}/desmontar`, { destino, sulco_mm: d.sulco_mm ? d.sulco_mm.replace(',', '.') : '', motivo: d.motivo }), { rotulo: 'Desmontar' })
      .then((r) => { if (r) { toast(destino === 'estoque' ? 'Pneu no estoque.' : destino === 'recapagem' ? 'Pneu enviado para a recapagem.' : 'Pneu descartado.'); carregar(); } });
    const rodizio = async (mapa) => {
      const montados = mapa.posicoes.filter((x) => x.pneu);
      if (montados.length < 2) return toast('O rodízio precisa de pelo menos 2 pneus montados.', true);
      const opcoes = Object.fromEntries(mapa.posicoes.map((x) => [x.codigo, `${x.codigo} · ${x.nome}`]));
      const r = await formModal('Rodízio de pneus', () => [
        el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Escolha a nova posição de cada pneu. O km de cada pneu continua com ele.'),
        montados.map((x) => escolha(`Pneu ${x.pneu.numero_fogo} (hoje em ${x.codigo})`, `p${x.pneu.id}`, opcoes, x.codigo)),
      ], (d) => P(`/veiculos/${veiculoId}/rodizio`, { trocas: montados.map((x) => ({ pneu_id: x.pneu.id, posicao: d[`p${x.pneu.id}`] })) }), { rotulo: 'Fazer rodízio' });
      if (r) { toast('Rodízio registrado.'); carregar(); }
    };
    async function carregar() {
      const [mapa, fora, comps] = await Promise.all([veiculoId ? api.get(`${base(ctx)}/veiculos/${veiculoId}/pneus`) : null, api.get(`${base(ctx)}/pneus`),
        veiculoId ? api.get(`${base(ctx)}/componentes?veiculo_id=${veiculoId}`) : []]);
      const freios = freiosDe(comps);
      // Ficha do freio do eixo: pastilha e disco, cada um com a barra de desgaste e as ações.
      const fichaFreio = (eixo) => modal(`Freio ${eixo} · ${placa(mapa.veiculo.placa)}`, (fechar) => {
        const fr = freios[eixo];
        return [
          el('div', { class: 'coluna', style: 'gap:12px' }, fr.tipos.map((tipo) => {
            const comp = fr.itens.find((x) => x.tipo === tipo);
            const nome = c.componentes[tipo].nome;
            return el('div', { class: 'cartao', style: 'padding:12px 14px;margin:0' },
              el('div', { class: 'linha entre', style: 'gap:8px' }, el('strong', {}, nome), comp ? etiqueta(...ESTADO[comp.estado]) : etiqueta('fora do plano', '')),
              comp ? [barraVida(comp.pct), el('p', { class: 'pequeno mudo', style: 'margin:4px 0 0' }, `Instalado em ${kmTxt(comp.instalado_km)} · ${textoUso(comp)}`)] : null,
              pode(ctx) ? el('div', { class: 'linha', style: 'gap:8px;justify-content:flex-end;margin-top:8px' }, comp ? [
                botao('Abrir OS', 'primario', async () => { fechar(); await novaOS(ctx, { veiculo_id: comp.veiculo_id, tipo: 'preventiva', componentes: [comp.id], descricao: `Troca: ${comp.nome}` }); carregar(); }),
                botao('Registrar troca', '', async () => { fechar(); if (await registrarTroca(ctx, comp)) carregar(); })]
                : botao('Incluir no plano', 'primario', async () => { fechar(); await incluirNoPlano(ctx, mapa.veiculo.id, tipo); carregar(); })) : null);
          })),
          el('div', { class: 'linha', style: 'justify-content:flex-end;margin-top:12px' }, el('button', { class: 'btn', type: 'button', onclick: () => fechar() }, 'Fechar')),
        ];
      });
      limpar(desenho, mapa ? cartao(`Pneus de ${placa(mapa.veiculo.placa)} · hodômetro ${kmTxt(mapa.veiculo.km_atual)}`,
        el('div', { class: 'pneus-topo' },
          desenhoPneus(ctx, mapa, (pos) => (pos.pneu ? acoesMontado(pos) : pode(ctx) ? montarEm(pos) : null), freios, fichaFreio),
          el('div', { class: 'coluna', style: 'gap:10px;max-width:360px' },
            el('div', { class: 'legenda' }, etiqueta('bom', 'ok'), etiqueta(`atenção: até ${c.sulco_atencao_mm} mm`, 'aviso'), etiqueta(`trocar: até ${String(c.sulco_limite_mm).replace('.', ',')} mm`, 'erro')),
            el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'O disco desenhado em cada roda é o freio: a cor sai do desgaste da pastilha e do disco. Toque nele para trocar ou abrir OS.'),
            el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Toque numa roda para medir, ver o histórico ou desmontar. Roda vazia: monte um pneu do estoque. O km de cada pneu vem do rastreador.'),
            pode(ctx) && mapa.posicoes.filter((p) => p.pneu).length >= 2 ? el('div', {}, botao('Rodízio', '', () => rodizio(mapa))) : null))) : cartao(null, el('p', { class: 'mudo' }, 'Cadastre um veículo para controlar os pneus.')));
      const lista = fora.filter((p) => p.status !== 'montado');
      limpar(estoque, cartao('Estoque e recapagem', tabela(['Nº de fogo', 'Pneu', 'Situação', '>Sulco', '>Km rodado', '>Custo/km', '^Ações'], lista.map((p) => el('tr', {},
        td(el('strong', {}, p.numero_fogo)), td([[p.marca, p.modelo].filter(Boolean).join(' ') || '—', el('div', { class: 'pequeno mudo' }, [p.medida, `vida ${p.vida}`].filter(Boolean).join(' · '))]),
        td(etiqueta(STATUS_PNEU[p.status], p.status === 'recapagem' ? 'info' : '')), td(mm(p.sulco_mm), 'dir num'), td(kmTxt(p.km_pneu), 'dir num'),
        td(p.custo_km_centavos === null ? '—' : `R$ ${(p.custo_km_centavos / 100).toFixed(3).replace('.', ',')}`, 'dir num'),
        el('td', { class: 'acoes' }, botaoIcone('historico', 'Histórico', () => historico(p)), pode(ctx) ? [
          p.status === 'estoque' ? botao('Recapar', '', async () => { await P(`/pneus/${p.id}/recapagem`); toast('Enviado para a recapagem.'); carregar(); }) : null,
          p.status === 'recapagem' ? botao('Voltou da recapagem', 'primario', () => formModal(`Recapagem · ${p.numero_fogo}`, () => [
            el('div', { class: 'duas' }, campo('Custo (R$)', { name: 'custo', inputmode: 'decimal' }), campo('Sulco novo (mm)', { name: 'sulco', inputmode: 'decimal' }))],
          (d) => P(`/pneus/${p.id}/voltar-recapagem`, { custo_centavos: centavos(d.custo) ?? 0, sulco_mm: d.sulco ? d.sulco.replace(',', '.') : '' }), { rotulo: 'Voltar ao estoque' }).then((r) => r && carregar())) : null,
          botao('Conserto', '', () => formModal(`Conserto · ${p.numero_fogo}`, () => [campo('O que foi feito', { name: 'observacao', required: true, maxlength: 200, placeholder: 'Ex.: remendo' }),
            campo('Custo (R$)', { name: 'custo', inputmode: 'decimal' })], (d) => P(`/pneus/${p.id}/conserto`, { observacao: d.observacao, custo_centavos: centavos(d.custo) ?? 0 }), { rotulo: 'Registrar' }).then((r) => r && carregar())),
          botaoIcone('lixo', 'Descartar', async () => { if (await confirmar('Descartar pneu', `Descartar o pneu ${p.numero_fogo}?`, 'Descartar')) { await P(`/pneus/${p.id}/descartar`, {}); carregar(); } }, 'perigo')] : null))),
      'Nenhum pneu no estoque ou na recapagem.')));
    }
    limpar(ctx.conteudo, acoesTopo(el('label', { class: 'campo', style: 'min-width:260px' }, 'Veículo', sel),
      pode(ctx) ? el('button', { class: 'btn primario', onclick: () => novo() }, 'Cadastrar pneu no estoque') : null), el('div', { class: 'coluna', style: 'gap:18px' }, desenho, estoque));
    await carregar();
  });
}

// ---------- Documentos ----------
async function telaDocumentos(ctx) {
  await tela(ctx, async () => {
    const [veiculos, motoristas, c] = await Promise.all([veiculosDa(ctx), api.get(`${base(ctx)}/motoristas`), cat(ctx)]);
    const lista = el('div');
    const form = (d) => formModal(d ? `Editar ${d.nome_tipo}` : 'Novo documento', (f) => {
      const tipo = escolha('Documento', 'tipo', c.documentos, d?.tipo ?? 'licenciamento');
      const doVeiculo = escolha('Veículo', 'veiculo_id', opcoesVeiculos(veiculos), d?.veiculo_id ?? veiculos[0]?.id);
      const doMotorista = escolha('Motorista', 'motorista_id', Object.fromEntries(motoristas.filter((m) => m.ativo).map((m) => [m.id, m.nome])), d?.motorista_id ?? '');
      const ajustar = () => { const m = ['cnh', 'exame'].includes(f.tipo.value); doVeiculo.classList.toggle('oculto', m); doMotorista.classList.toggle('oculto', !m); };
      tipo.querySelector('select').addEventListener('change', ajustar);
      queueMicrotask(ajustar);
      return [el('div', { class: 'duas' }, tipo, el('div', {}, doVeiculo, doMotorista)),
        el('div', { class: 'duas' }, campo('Vencimento', { name: 'vencimento', type: 'date', required: true, value: d?.vencimento ?? '' }), campo('Valor (R$)', { name: 'valor', inputmode: 'decimal', value: d ? reaisCampo(d.valor_centavos) : '' })),
        el('div', { class: 'duas' }, campo('Número (opcional)', { name: 'numero', maxlength: 60, value: d?.numero ?? '' }), campo('Observação (opcional)', { name: 'descricao', maxlength: 120, value: d?.descricao ?? '' })),
        marcar('Já está pago', { name: 'pago', checked: Boolean(d?.pago) })];
    }, (x) => {
      const corpo = { ...x, valor_centavos: centavos(x.valor) ?? 0 };
      return d ? api.put(`${base(ctx)}/documentos/${d.id}`, corpo) : api.post(`${base(ctx)}/documentos`, corpo);
    }).then((r) => { if (r) { toast('Documento salvo.'); carregar(); } });
    async function carregar() {
      const docs = await api.get(`${base(ctx)}/documentos`);
      limpar(lista, tabela(['Situação', 'Documento', 'Veículo / motorista', 'Vencimento', '>Valor', '^Ações'], docs.map((d) => el('tr', {},
        td(etiqueta(...DOC[d.estado])), td([d.nome_tipo, d.numero || d.descricao ? el('div', { class: 'pequeno mudo' }, [d.numero, d.descricao].filter(Boolean).join(' · ')) : null]),
        td(d.placa ? placa(d.placa) : d.motorista ?? '—'),
        td([data(d.vencimento), el('div', { class: 'pequeno mudo' }, d.dias < 0 ? `vencido há ${-d.dias} dia(s)` : d.dias === 0 ? 'vence hoje' : `em ${d.dias} dia(s)`)]),
        td([d.valor_centavos ? dinheiro(d.valor_centavos) : '—', d.pago ? el('div', { class: 'pequeno' }, etiqueta('pago', 'ok')) : null], 'dir num'),
        el('td', { class: 'acoes' }, pode(ctx) ? [botaoIcone('editar', 'Editar', () => form(d)),
          botaoIcone('lixo', 'Excluir', async () => { if (await confirmar('Excluir documento', `Excluir ${d.nome_tipo}?`, 'Excluir')) { await api.del(`${base(ctx)}/documentos/${d.id}`); carregar(); } }, 'perigo')] : null))),
      'Nenhum documento cadastrado. Cadastre IPVA, licenciamento, seguro, tacógrafo e a CNH dos motoristas: o sistema avisa antes de vencer.'));
    }
    limpar(ctx.conteudo, acoesTopo(el('p', { class: 'mudo', style: 'margin:0' }, 'Vencimentos da frota e dos motoristas. Aviso pelo WhatsApp 15 dias antes.'),
      pode(ctx) ? el('button', { class: 'btn primario', onclick: () => form(null) }, 'Novo documento') : null), cartao(null, lista));
    await carregar();
  });
}

// ---------- Fornecedores ----------
async function telaFornecedores(ctx) {
  await tela(ctx, async () => {
    const c = await cat(ctx);
    const lista = el('div');
    const form = (f) => formModal(f ? `Editar ${f.nome}` : 'Novo fornecedor', () => [
      el('div', { class: 'duas' }, campo('Nome', { name: 'nome', required: true, maxlength: 120, value: f?.nome ?? '' }), escolha('Tipo', 'tipo', c.fornecedores, f?.tipo ?? 'oficina')),
      el('div', { class: 'tres' }, campo('Telefone', { name: 'telefone', value: f?.telefone ?? '' }), campo('CNPJ / CPF', { name: 'documento', value: f?.documento ?? '' }), campo('Cidade', { name: 'cidade', maxlength: 80, value: f?.cidade ?? '' })),
      campo('Observação', { name: 'observacao', maxlength: 300, value: f?.observacao ?? '' }),
    ], (d) => (f ? api.put(`${base(ctx)}/fornecedores/${f.id}`, d) : api.post(`${base(ctx)}/fornecedores`, d))).then((r) => { if (r) { toast('Fornecedor salvo.'); carregar(); } });
    async function carregar() {
      const fs = await api.get(`${base(ctx)}/fornecedores`);
      limpar(lista, tabela(['Fornecedor', 'Tipo', 'Contato', '>Serviços', '>Gasto total', '^Ações'], fs.map((f) => el('tr', {},
        td([el('strong', {}, f.nome), f.cidade ? el('div', { class: 'pequeno mudo' }, f.cidade) : null]), td(c.fornecedores[f.tipo]),
        td(f.telefone ? el('a', { href: `https://wa.me/55${f.telefone}`, target: '_blank', rel: 'noopener' }, telefone(f.telefone)) : '—'), td(inteiro(f.servicos), 'dir num'), td(dinheiro(f.gasto_centavos), 'dir num'),
        el('td', { class: 'acoes' }, pode(ctx) ? [botaoIcone('editar', 'Editar', () => form(f)),
          botaoIcone('lixo', 'Remover', async () => { if (await confirmar('Remover fornecedor', `Remover ${f.nome}? As OS antigas continuam com o nome.`, 'Remover')) { await api.del(`${base(ctx)}/fornecedores/${f.id}`); carregar(); } }, 'perigo')] : null))),
      'Nenhum fornecedor. Cadastre as oficinas, borracharias e autopeças para escolher na OS e comparar o gasto.'));
    }
    limpar(ctx.conteudo, acoesTopo(el('p', { class: 'mudo', style: 'margin:0' }, 'Oficinas, borracharias, autopeças e o quanto foi gasto com cada um.'),
      pode(ctx) ? el('button', { class: 'btn primario', onclick: () => form(null) }, 'Novo fornecedor') : null), cartao(null, lista));
    await carregar();
  });
}

// ---------- Custos ----------
async function telaCustos(ctx) {
  await tela(ctx, async () => {
    const hoje = hojeLocal();
    const PER = { mes: ['Este mês', `${hoje.slice(0, 7)}-01`, hoje], trinta: ['Últimos 30 dias', somarDias(hoje, -29), hoje], noventa: ['Últimos 90 dias', somarDias(hoje, -89), hoje],
      ano: ['Este ano', `${hoje.slice(0, 4)}-01-01`, hoje] };
    let periodo = 'mes';
    const chips = el('div', { class: 'chips' });
    const corpo = el('div', { class: 'coluna', style: 'gap:18px' });
    async function carregar() {
      limpar(chips, Object.entries(PER).map(([k, [t]]) => el('button', { type: 'button', class: `chip${k === periodo ? ' on' : ''}`, onclick: () => { periodo = k; carregar(); } }, t)));
      const [, de, ate] = PER[periodo];
      const r = await api.get(`${base(ctx)}/custos${qs({ de, ate })}`);
      const t = r.totais;
      const porKm = (x) => (x === null ? '—' : `R$ ${(x / 100).toFixed(2).replace('.', ',')}`);
      limpar(corpo,
        el('div', { class: 'grade' },
          indicador('Custo total', dinheiro(t.total_centavos), `${inteiro(t.km)} km rodados`, '', 'carteira'), indicador('Custo por km', porKm(t.custo_km_centavos), 'média da frota', '', 'rota'),
          indicador('Combustível', dinheiro(t.combustivel_centavos), 'abastecimentos do app', '', 'combustivel'), indicador('Manutenção', dinheiro(t.manutencao_centavos), 'ordens de serviço concluídas', '', 'manutencao'),
          indicador('Pneus', dinheiro(t.pneus_centavos), 'compra, recapagem e conserto', '', 'veiculos'), indicador('Documentos e multas', dinheiro(t.documentos_centavos + t.multas_centavos), 'IPVA, seguro, licença e multas', '', 'multa')),
        cartao('Por veículo', tabela(['Veículo', '>Km', '>Combustível', '>Manutenção', '>Pneus', '>Documentos', '>Multas', '>Total', '>Custo/km'], r.veiculos.map((x) => el('tr', {},
          td([el('strong', {}, placa(x.placa)), x.descricao ? el('div', { class: 'pequeno mudo' }, x.descricao) : null]), td(inteiro(x.km), 'dir num'),
          td(dinheiro(x.combustivel_centavos), 'dir num'), td(dinheiro(x.manutencao_centavos), 'dir num'), td(dinheiro(x.pneus_centavos), 'dir num'),
          td(dinheiro(x.documentos_centavos), 'dir num'), td(dinheiro(x.multas_centavos), 'dir num'), td(el('strong', {}, dinheiro(x.total_centavos)), 'dir num'), td(porKm(x.custo_km_centavos), 'dir num'))),
        'Nenhum veículo.')),
        el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Combustível: abastecimentos lançados no app do motorista. Pneu novo entra no custo do veículo em que foi montado pela primeira vez; recapagem e conserto, no último veículo em que rodou. Km: rastreador.'));
    }
    limpar(ctx.conteudo, acoesTopo(chips), corpo);
    await carregar();
  });
}

// ---------- Detran: tudo o que o veículo deve ou pagou ao governo (IPVA, licenciamento, seguro e multas) ----------
const SIT_DETRAN = { pago: ['pago', 'ok'], a_pagar: ['a pagar', 'aviso'], vencido: ['vencido', 'erro'], em_recurso: ['em recurso', ''] };
const CAT_DETRAN = { ipva: 'IPVA', licenciamento: 'Licenciamento', seguro: 'Seguro', multa: 'Multa', outros: 'Outros' };
async function telaDetran(ctx) {
  await tela(ctx, async () => {
    const veiculos = await veiculosDa(ctx);
    const anoAtual = Number(hojeLocal().slice(0, 4));
    let ano = anoAtual;
    let veiculoId = '';
    const selVeiculo = escolha(null, 'veiculo', { '': 'Todos os veículos', ...opcoesVeiculos(veiculos) }, '');
    const selAno = escolha(null, 'ano', Object.fromEntries([0, 1, 2, 3].map((i) => [anoAtual - i, String(anoAtual - i)])), ano);
    selVeiculo.addEventListener('change', () => { veiculoId = selVeiculo.value; carregar(); });
    selAno.addEventListener('change', () => { ano = Number(selAno.value); carregar(); });
    const corpo = el('div', { class: 'coluna', style: 'gap:18px' });
    const soFrota = ctx.usuario?.acesso === 'frota' && !ctx.master;
    async function carregar() {
      const r = await api.get(`${base(ctx)}/detran${qs({ ano, veiculo_id: veiculoId || undefined })}`);
      const t = r.totais;
      limpar(corpo,
        el('div', { class: 'grade' },
          indicador(`Total de ${r.ano}`, dinheiro(t.total_centavos), 'IPVA, licenciamento, seguro e multas', '', 'carteira'),
          indicador('Pago', dinheiro(t.pago_centavos), 'quitado no ano', t.pago_centavos ? 'ok' : '', 'check'),
          indicador('Em aberto', dinheiro(t.aberto_centavos), t.vencido_centavos ? `${dinheiro(t.vencido_centavos)} já vencido` : 'nada vencido', t.vencido_centavos ? 'erro' : t.aberto_centavos ? 'aviso' : 'ok', 'alertas'),
          indicador('IPVA', dinheiro(t.ipva_centavos), 'imposto do ano', '', 'relatorios'),
          indicador('Licenciamento e seguro', dinheiro(t.licenciamento_seguro_centavos), 'CRLV e seguro do veículo', '', 'veiculos'),
          indicador('Multas', dinheiro(t.multas_centavos), `${inteiro(t.multas)} multa(s) no ano`, t.multas ? 'aviso' : '', 'multa')),
        r.debitos.length ? cartao(`Débitos em aberto no Detran · ${dinheiro(t.debitos_centavos)}`, tabela(['Veículo', 'Débito', '>Valor', 'Consultado em'], r.debitos.map((x) => el('tr', {},
          td(el('strong', {}, placa(x.placa))), td(x.descricao), td(dinheiro(x.valor_centavos), 'dir num'), td(dataHora(x.consultado_em))))),
          el('p', { class: 'pequeno mudo', style: 'margin:10px 0 0' }, 'Resultado da última consulta de cada placa no Detran. Depois de pagar, lance em Documentos como pago e consulte de novo.')) : null,
        cartao('Por veículo', tabela(['Veículo', '>IPVA', '>Licenciamento', '>Seguro', '>Multas', '>Outros', '>Total', '>Em aberto'], r.veiculos.map((x) => el('tr', {},
          td([el('strong', {}, placa(x.placa)), x.descricao ? el('div', { class: 'pequeno mudo' }, x.descricao) : null]),
          ...['ipva', 'licenciamento', 'seguro', 'multa', 'outros'].map((k) => td(dinheiro(x[k]), 'dir num')),
          td(el('strong', {}, dinheiro(x.total)), 'dir num'), td(x.aberto ? el('span', { class: 'texto-erro' }, dinheiro(x.aberto)) : dinheiro(0), 'dir num'))), 'Nenhum veículo.')),
        cartao(`Lançamentos de ${r.ano}`, tabela(['Data', 'Veículo', 'Tipo', 'Descrição', '>Valor', 'Situação'], r.lancamentos.map((x) => el('tr', {},
          td(data(x.data), 'sem-quebra'), td(el('strong', {}, placa(x.placa))), td(CAT_DETRAN[x.categoria]), td(x.descricao),
          td(dinheiro(x.valor_centavos), 'dir num'), td(etiqueta(...SIT_DETRAN[x.situacao])))),
          `Nada lançado em ${r.ano}. Cadastre IPVA, licenciamento e seguro em Documentos; as multas vêm da Central de multas.`)));
    }
    limpar(ctx.conteudo,
      acoesTopo(el('div', { class: 'linha', style: 'gap:10px;flex-wrap:wrap' },
        el('label', { class: 'campo', style: 'min-width:260px' }, 'Veículo', selVeiculo), el('label', { class: 'campo', style: 'min-width:120px' }, 'Ano', selAno)),
      el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap' },
        soFrota ? null : el('button', { class: 'btn', onclick: () => ir(ctx, 'multas-consultar') }, icone('lupa'), 'Consultar débitos'),
        pode(ctx) ? el('button', { class: 'btn primario', onclick: () => ir(ctx, 'gestao-documentos') }, 'Lançar IPVA, licenciamento ou seguro') : null)),
      corpo);
    await carregar();
  });
}

export const TELAS_GESTAO = {
  'gestao-painel': telaPainel, 'gestao-os': telaOS, 'gestao-preventiva': telaPreventiva, 'gestao-pneus': telaPneus,
  'gestao-documentos': telaDocumentos, 'gestao-fornecedores': telaFornecedores, 'gestao-custos': telaCustos, 'gestao-detran': telaDetran,
};
