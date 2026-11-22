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
  reaisCampo, centavos, hojeLocal, somarDias, icone } from './ui.js';
import { cartao, indicador, tabela, td, botao, botaoIcone, acoesTopo } from './comum.js';

const base = (ctx) => `/empresas/${ctx.empresaId}/gestao`;
const pode = (ctx) => !ctx.somenteLeitura;
const ir = (ctx, tela) => { location.hash = `#/empresa/${ctx.empresaId}/${tela}`; };
let catalogo = null;
const cat = async (ctx) => (catalogo ??= await api.get(`${base(ctx)}/catalogos`));
const veiculosDa = async (ctx) => (await api.get(`/empresas/${ctx.empresaId}/veiculos`)).filter((x) => x.ativo);
const nomeVeiculo = (x) => `${placa(x.placa)}${x.descricao ? ` · ${x.descricao}` : ''}`;
const opcoesVeiculos = (lista) => Object.fromEntries(lista.map((x) => [x.id, nomeVeiculo(x)]));
const mm = (x) => (x === null || x === undefined ? '—' : `${String(Math.round(x * 10) / 10).replace('.', ',')} mm`);
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
        indicador('OS abertas', inteiro(i.os_abertas), null, '', 'manutencao'),
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

// ---------- Plano preventivo (componentes) ----------
async function telaPreventiva(ctx) {
  await tela(ctx, async () => {
    const [veiculos, c] = await Promise.all([veiculosDa(ctx), cat(ctx)]);
    let veiculoId = sessionStorage.getItem('gestao.veiculo') || '';
    const lista = el('div');
    const sel = escolha(null, 'veiculo', { '': 'Todos os veículos', ...opcoesVeiculos(veiculos) }, veiculoId);
    sel.addEventListener('change', () => { veiculoId = sel.value; sessionStorage.setItem('gestao.veiculo', veiculoId); carregar(); });
    const tipos = Object.fromEntries(Object.entries(c.componentes).map(([k, x]) => [k, `${x.grupo} · ${x.nome}`]));
    const form = (comp) => formModal(comp ? `Editar ${comp.nome}` : 'Novo componente', (f) => {
      const tipo = escolha('Componente', 'tipo', tipos, comp?.tipo ?? 'oleo_motor');
      const vidaKm = campo('Vida útil (km)', { name: 'vida_km', type: 'number', min: 1, value: comp?.vida_km ?? c.componentes.oleo_motor.km ?? '' });
      const vidaDias = campo('Ou tempo (dias)', { name: 'vida_dias', type: 'number', min: 1, value: comp?.vida_dias ?? c.componentes.oleo_motor.dias ?? '' });
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
    const trocar = (comp) => formModal(`Registrar troca · ${comp.nome}`, () => [
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Troca feita sem OS (ex.: na estrada). Com OS, a troca é registrada ao concluir a OS.'),
      el('div', { class: 'duas' }, campo('Km', { name: 'km', type: 'number', min: 0, value: comp.km_atual }), campo('Data', { name: 'data', type: 'date', value: hojeLocal() })),
      el('div', { class: 'duas' }, campo('Custo (R$)', { name: 'custo', inputmode: 'decimal' }), campo('Marca da peça nova', { name: 'marca', maxlength: 60, value: comp.marca ?? '' })),
    ], (d) => api.post(`${base(ctx)}/componentes/${comp.id}/trocar`, { km: d.km, data: d.data, custo_centavos: centavos(d.custo) ?? 0, marca: d.marca }), { rotulo: 'Registrar troca' })
      .then((r) => { if (r) { toast('Troca registrada: a vida útil recomeçou.'); carregar(); } });
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
      limpar(lista, tabela(['Veículo', 'Componente', 'Instalado', 'Vida útil', 'Uso', 'Próxima troca', 'Situação', '^Ações'], comps.map((x) => el('tr', {},
        td([el('strong', {}, placa(x.placa)), el('div', { class: 'pequeno mudo' }, `hoje ${kmTxt(x.km_atual)}`)]),
        td([x.nome, el('div', { class: 'pequeno mudo' }, [x.grupo, x.posicao, x.marca].filter(Boolean).join(' · '))]),
        td([kmTxt(x.instalado_km), el('div', { class: 'pequeno mudo' }, data(x.instalado_em))]),
        td([x.vida_km ? kmTxt(x.vida_km) : null, x.vida_dias ? `${inteiro(x.vida_dias)} dias` : null].filter(Boolean).join(' ou ')),
        td(barraVida(x.pct)),
        td([x.proxima_km ? kmTxt(x.proxima_km) : '—', el('div', { class: 'pequeno mudo' }, x.restante_km !== null ? (x.restante_km >= 0 ? `faltam ${inteiro(x.restante_km)} km` : `passou ${inteiro(-x.restante_km)} km`) : ''),
          x.previsao ? el('div', { class: 'pequeno mudo' }, `por volta de ${data(x.previsao)}`) : null]),
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
      cartao(null, lista));
    await carregar();
  });
}

// ---------- Pneus ----------
/** Desenho do veículo visto de cima: um eixo por linha, esquerda e direita do chassi, estepe embaixo. */
function desenhoPneus(ctx, mapa, aoClicar) {
  const eixoDe = (cod) => (/^\d/.test(cod) ? Number(cod[0]) : { DE: 1, DD: 1, D: 1, TE: 2, TD: 2, T: 2 }[cod] ?? 9);
  const lado = (cod) => (cod === 'D' || cod === 'T' ? 'centro' : /^(DE|TE|\dE|\dEE|\dEI)$/.test(cod) ? 'esq' : 'dir');
  const ordemEsq = (c) => (c.endsWith('EE') ? 0 : 1);
  const ordemDir = (c) => (c.endsWith('DI') ? 0 : 1);
  const roda = (pos) => {
    const p = pos.pneu;
    const est = p ? PNEU[p.estado] : null;
    return el('button', { type: 'button', class: `roda ${p ? `com ${est[1] || 'neutro'}` : 'vazia'}`, title: pos.nome, onclick: () => aoClicar(pos) },
      el('span', { class: 'roda-pos' }, pos.codigo),
      p ? [el('strong', {}, p.numero_fogo), el('span', {}, mm(p.sulco_mm)), el('span', { class: 'pequeno' }, kmTxt(p.km_pneu))] : el('span', { class: 'pequeno' }, pode(ctx) ? '+ montar' : 'vazia'));
  };
  const eixos = new Map();
  for (const pos of mapa.posicoes.filter((x) => x.codigo !== 'EST')) {
    const e = eixoDe(pos.codigo);
    if (!eixos.has(e)) eixos.set(e, { esq: [], dir: [], centro: [] });
    eixos.get(e)[lado(pos.codigo)].push(pos);
  }
  const estepe = mapa.posicoes.find((x) => x.codigo === 'EST');
  return el('div', { class: 'veiculo-pneus' },
    el('div', { class: 'frente' }, 'frente'),
    [...eixos.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => el('div', { class: 'eixo' },
      g.centro.length ? el('div', { class: 'lado centro' }, g.centro.map(roda)) : [
        el('div', { class: 'lado esq' }, g.esq.sort((a, b) => ordemEsq(a.codigo) - ordemEsq(b.codigo)).map(roda)),
        el('div', { class: 'chassi' }),
        el('div', { class: 'lado dir' }, g.dir.sort((a, b) => ordemDir(a.codigo) - ordemDir(b.codigo)).map(roda))])),
    estepe ? el('div', { class: 'estepe' }, el('span', { class: 'pequeno mudo' }, 'Estepe'), roda(estepe)) : null);
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
      if (!livres.length) return novo(pos);
      const r = await formModal(`Montar em ${pos.nome}`, () => [
        escolha('Pneu do estoque', 'pneu_id', Object.fromEntries(livres.map((p) => [p.id, `${p.numero_fogo} · ${[p.marca, p.medida].filter(Boolean).join(' ')} · ${mm(p.sulco_mm)} · ${kmTxt(p.km_pneu)}`])), livres[0].id),
        el('button', { type: 'button', class: 'btn pequeno', onclick: (e) => { e.target.closest('.modal-fundo').fechar(); novo(pos); } }, 'Cadastrar um pneu novo'),
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
      const [mapa, fora] = await Promise.all([veiculoId ? api.get(`${base(ctx)}/veiculos/${veiculoId}/pneus`) : null, api.get(`${base(ctx)}/pneus`)]);
      limpar(desenho, mapa ? cartao(`Pneus de ${placa(mapa.veiculo.placa)} · hodômetro ${kmTxt(mapa.veiculo.km_atual)}`,
        el('div', { class: 'pneus-topo' },
          desenhoPneus(ctx, mapa, (pos) => (pos.pneu ? acoesMontado(pos) : pode(ctx) ? montarEm(pos) : null)),
          el('div', { class: 'coluna', style: 'gap:10px;max-width:360px' },
            el('div', { class: 'legenda' }, etiqueta('bom', 'ok'), etiqueta(`atenção: até ${c.sulco_atencao_mm} mm`, 'aviso'), etiqueta(`trocar: até ${String(c.sulco_limite_mm).replace('.', ',')} mm`, 'erro')),
            el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Toque numa roda para medir, ver o histórico ou desmontar. Roda vazia: monte um pneu do estoque. O km de cada pneu vem do rastreador.'),
            pode(ctx) ? el('div', {}, botao('Rodízio', '', () => rodizio(mapa))) : null))) : cartao(null, el('p', { class: 'mudo' }, 'Cadastre um veículo para controlar os pneus.')));
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
    const [veiculos, motoristas, c] = await Promise.all([veiculosDa(ctx), api.get(`/empresas/${ctx.empresaId}/motoristas`), cat(ctx)]);
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
        td(f.telefone ? el('a', { href: `https://wa.me/55${f.telefone}`, target: '_blank', rel: 'noopener' }, f.telefone) : '—'), td(inteiro(f.servicos), 'dir num'), td(dinheiro(f.gasto_centavos), 'dir num'),
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
          indicador('Combustível', dinheiro(t.combustivel_centavos), null, '', 'combustivel'), indicador('Manutenção', dinheiro(t.manutencao_centavos), 'ordens de serviço concluídas', '', 'manutencao'),
          indicador('Pneus', dinheiro(t.pneus_centavos), 'compra, recapagem e conserto', '', 'veiculos'), indicador('Documentos e multas', dinheiro(t.documentos_centavos + t.multas_centavos), null, '', 'multa')),
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

export const TELAS_GESTAO = {
  'gestao-painel': telaPainel, 'gestao-os': telaOS, 'gestao-preventiva': telaPreventiva, 'gestao-pneus': telaPneus,
  'gestao-documentos': telaDocumentos, 'gestao-fornecedores': telaFornecedores, 'gestao-custos': telaCustos,
};
