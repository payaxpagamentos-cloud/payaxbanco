/** Lado comercial: anunciantes, campanhas, criativos e a simulação da programação. */
import { api, qs } from './api.js';
import {
  el, limpar, icone, toast, acao, modal, formModal, confirmar, perguntar, campo, escolha, marcar, area, lerForm, centavos, reaisCampo,
  inteiro, dinheiro, duracao, dataHora, dataBr, competenciaTexto, etiquetaDe, etiqueta, mb, diasTexto, faixaHorario,
  CATEGORIAS, COBRANCA, ORIENTACOES, STATUS_CAMPANHA, STATUS_MIDIA, STATUS_CONTRATO, DIAS,
} from './ui.js';
import { cartao, indicador, tabela, vazio, previa, miniatura, linhaDoLoop, itensDoLoop, resumoDoLoop, enviarArquivo } from './comum.js';
import { agencias } from './inventario.js';
import { relatorioDeVeiculacao } from './veiculacao.js';

// ---------------------------------------------------------------- Anunciantes e agências
export async function anunciantes(ctx) {
  const corpo = el('div', { class: 'cartao' });
  const filtros = el('div', { class: 'filtros livre' });
  const filtro = { busca: '', status: '' };
  const pintar = async () => {
    const d = await api.get(`/painel/anunciantes${qs(filtro)}`);
    limpar(corpo, tabela([
      [(a) => el('div', {}, el('div', {}, a.nome), el('div', { class: 'pequeno mudo' }, a.contato ?? a.email ?? '—')), 'Anunciante'],
      [(a) => a.documento ?? '—', 'CNPJ/CPF'],
      [(a) => `${inteiro(a.campanhas_ativas)} no ar`, 'Campanhas', 'num dir'],
      [(a) => (a.aberto_centavos ? el('strong', { style: 'color:var(--aviso)' }, dinheiro(a.aberto_centavos)) : '—'), 'Em aberto', 'num dir'],
      [(a) => etiqueta(a.status === 'ativo' ? 'Ativo' : 'Inativo', a.status === 'ativo' ? 'ok' : ''), 'Situação'],
      [(a) => el('div', { class: 'acoes' }, el('button', { class: 'icone-btn', title: 'Editar', onclick: (e) => { e.stopPropagation(); editarAnunciante(a, pintar); } }, icone('editar'))), '', 'acoes'],
    ], d.itens, { aoClicar: (a) => abrirAnunciante(a.id, pintar), vazioTexto: 'Nenhum anunciante cadastrado.' }));
  };
  let timer;
  limpar(filtros,
    el('label', { class: 'campo' }, 'Buscar', el('input', { placeholder: 'Nome ou documento', oninput: (e) => { filtro.busca = e.target.value; clearTimeout(timer); timer = setTimeout(pintar, 300); } })),
    escolha('Situação', 'status', { '': 'Todos', ativo: 'Ativos', inativo: 'Inativos' }, '', { onchange: (e) => { filtro.status = e.target.value; pintar(); } }),
    el('button', { class: 'btn primario', onclick: () => editarAnunciante(null, pintar) }, icone('mais'), 'Novo anunciante'));

  // Duas abas: quem anuncia e as agências que compram a mídia para eles.
  const abas = el('div', { class: 'linha' },
    el('button', { class: 'btn pequeno primario', onclick: (e) => trocar(e.target, 'anunciantes') }, 'Anunciantes'),
    el('button', { class: 'btn pequeno', onclick: (e) => trocar(e.target, 'agencias') }, 'Agências'));
  const trocar = (botao, aba) => {
    for (const b of abas.children) b.classList.remove('primario');
    botao.classList.add('primario');
    filtros.hidden = aba !== 'anunciantes';
    if (aba === 'anunciantes') pintar();
    else agencias(corpo);
  };

  limpar(ctx.conteudo, el('div', { class: 'coluna' }, abas, filtros, corpo));
  await pintar();
}

const editarAnunciante = (a, recarregar) => formModal(a ? `Editar ${a.nome}` : 'Novo anunciante', () => [
  campo('Nome / razão social', { name: 'nome', value: a?.nome ?? '', required: true, maxlength: 120 }),
  el('div', { class: 'duas' },
    campo('CNPJ/CPF', { name: 'documento', value: a?.documento ?? '', maxlength: 20 }),
    campo('Pessoa de contato', { name: 'contato', value: a?.contato ?? '', maxlength: 120 })),
  el('div', { class: 'duas' },
    campo('E-mail', { name: 'email', type: 'email', value: a?.email ?? '', maxlength: 160 }),
    campo('Telefone', { name: 'telefone', value: a?.telefone ?? '', maxlength: 20 })),
  a ? escolha('Situação', 'status', { ativo: 'Ativo', inativo: 'Inativo' }, a.status) : null,
  area('Observação', { name: 'observacao', maxlength: 500 }, a?.observacao ?? ''),
], async (d) => {
  if (a) await api.patch(`/painel/anunciantes/${a.id}`, d);
  else await api.post('/painel/anunciantes', d);
  toast(a ? 'Anunciante atualizado.' : 'Anunciante cadastrado.');
  recarregar();
});

async function abrirAnunciante(id, recarregar) {
  const d = await api.get(`/painel/anunciantes/${id}`);
  const atualizar = (fechar) => { fechar(); recarregar(); abrirAnunciante(id, recarregar); };
  const f = d.financeiro;
  await modal(d.nome, (fechar) => [
    el('div', {}, [['CNPJ/CPF', d.documento ?? '—'], ['Contato', d.contato ?? '—'], ['E-mail', d.email ?? '—'], ['Telefone', d.telefone ?? '—']]
      .map(([k, v]) => el('div', { class: 'chave' }, el('span', { class: 'mudo' }, k), el('strong', {}, v)))),

    // O financeiro do cliente fica aqui: é o que se procura quando ele liga.
    el('h3', {}, 'Financeiro do cliente'),
    el('div', { class: 'grade' },
      indicador({
        rotulo: 'Em aberto', valor: dinheiro(f.aberto_centavos), ic: 'faturamento',
        cor: f.atrasado_centavos ? 'vermelho' : 'azul',
        nota: f.atrasado_centavos ? `${dinheiro(f.atrasado_centavos)} vencido` : `${f.faturas_abertas} fatura(s)`,
      }),
      indicador({
        rotulo: 'Próximo vencimento', ic: 'relogio', cor: 'laranja',
        valor: f.proxima ? dataBr(f.proxima.vencimento) : '—',
        nota: f.proxima ? dinheiro(f.proxima.valor_centavos) : 'nada em aberto',
      }),
      indicador({
        rotulo: 'Já recebido', valor: dinheiro(f.recebido_centavos), ic: 'ok', cor: 'verde',
        nota: f.ultimo_pagamento ? `último em ${dataBr(f.ultimo_pagamento.pago_em)}` : 'nenhum pagamento ainda',
      })),

    el('h3', {}, `Contratos (${d.contratos.length})`),
    tabela([
      [(c) => el('div', {}, el('div', {}, c.numero), el('div', { class: 'pequeno mudo' }, c.objeto ?? '—')), 'Contrato'],
      [(c) => `${dataBr(c.inicio)} → ${c.fim ? dataBr(c.fim) : 'sem fim'}`, 'Vigência'],
      [(c) => COBRANCA[c.cobranca] ?? c.cobranca, 'Cobrança'],
      [(c) => (c.valor_centavos ? dinheiro(c.valor_centavos) : '—'), 'Valor', 'num dir'],
      [(c) => inteiro(c.campanhas), 'Campanhas', 'num dir'],
      [(c) => cicloDoContrato(c), 'Ciclo'],
      [(c) => etiquetaDe(STATUS_CONTRATO, c.status), 'Situação'],
      [(c) => el('div', { class: 'acoes' },
        c.status === 'ativo' && c.reajuste_vencido
          ? el('button', { class: 'btn pequeno primario', onclick: (e) => { e.stopPropagation(); fechar(); reajustarContrato(c, () => recarregar()); } }, 'Reajustar')
          : null,
        c.status === 'ativo' && c.fim && c.dias_para_fim <= 45
          ? el('button', { class: 'btn pequeno', onclick: (e) => { e.stopPropagation(); fechar(); renovarContrato(c, () => recarregar()); } }, 'Renovar')
          : null,
        el('button', { class: 'btn pequeno', onclick: (e) => { e.stopPropagation(); fechar(); editarContrato(c, d, () => recarregar()); } }, 'Editar')), '', 'acoes'],
    ], d.contratos, { vazioTexto: 'Nenhum contrato cadastrado para este cliente.' }),
    el('button', { class: 'btn', style: 'margin-top:10px', onclick: () => { fechar(); editarContrato(null, d, () => recarregar()); } }, icone('mais'), 'Novo contrato'),

    el('h3', {}, 'Histórico de pagamentos'),
    tabela([
      [(x) => competenciaTexto(x.competencia), 'Competência'],
      [(x) => dinheiro(x.valor_centavos), 'Valor', 'num dir'],
      [(x) => dataBr(x.vencimento), 'Vencimento'],
      [(x) => dataBr(x.pago_em), 'Pago em'],
      [(x) => (x.pago_em > x.vencimento ? etiqueta('Pagou em atraso', 'aviso') : etiqueta('Em dia', 'ok')), ''],
    ], d.pagamentos, { vazioTexto: 'Nenhum pagamento registrado ainda.' }),

    el('h3', {}, 'Campanhas'),
    tabela([
      [(c) => el('div', {}, el('div', {}, c.nome), c.contrato ? el('div', { class: 'pequeno mudo' }, `contrato ${c.contrato}`) : null), 'Campanha'],
      [(c) => etiquetaDe(STATUS_CAMPANHA, c.status), 'Situação'],
      [(c) => `${dataBr(c.inicio)} a ${c.fim ? dataBr(c.fim) : 'sem fim'}`, 'Período'],
      [(c) => (c.cobranca === 'cpm' ? `CPM ${dinheiro(c.cpm_centavos)}` : c.cobranca === 'mensal' ? `${dinheiro(c.valor_centavos)}/mês` : 'cortesia'), 'Cobrança', 'num dir'],
    ], d.campanhas, { vazioTexto: 'Nenhuma campanha.' }),
    el('h3', {}, 'Faturas'),
    tabela([
      [(f) => f.competencia, 'Competência'], [(f) => dinheiro(f.valor_centavos), 'Valor', 'num dir'],
      [(f) => dataBr(f.vencimento), 'Vencimento'], [(f) => f.status, 'Situação'],
    ], d.faturas, { vazioTexto: 'Nenhuma fatura.' }),
    el('h3', {}, 'Acesso ao portal'),
    d.usuarios.length
      ? el('div', {}, d.usuarios.map((u) => el('div', { class: 'chave' }, el('span', {}, `${u.nome} · ${u.email}`),
        el('span', { class: 'pequeno mudo' }, u.ultimo_acesso ? `último acesso ${dataHora(u.ultimo_acesso)}` : 'nunca acessou'))))
      : vazio('Sem acesso criado. No portal, o anunciante acompanha as inserções e baixa a prova de exibição.'),
    el('div', { class: 'linha entre', style: 'margin-top:18px' },
      el('button', { class: 'btn', onclick: () => { fechar(); criarAcessoAnunciante(d, recarregar); } }, icone('pessoas'), 'Criar acesso ao portal'),
      el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar')),
  ], { largo: true });
}

/** Contrato do cliente: o acordo que sustenta as campanhas dele. */
/** O que o contrato pede agora: reajuste na data, fim chegando, ou nada (o normal). */
function cicloDoContrato(c) {
  if (c.status !== 'ativo') return el('span', { class: 'mudo' }, '—');
  const partes = [];
  if (c.reajuste_vencido) partes.push(etiqueta(`Reajuste desde ${dataBr(c.reajuste_em)}`, 'aviso'));
  else if (c.reajuste_em) partes.push(el('div', { class: 'pequeno mudo' }, `Reajuste em ${dataBr(c.reajuste_em)}`));
  if (c.vencido) partes.push(etiqueta('Venceu e segue ativo', 'erro'));
  else if (c.dias_para_fim !== null && c.dias_para_fim <= 45) {
    partes.push(etiqueta(`Vence em ${c.dias_para_fim} dia(s)`, c.dias_para_fim <= 15 ? 'erro' : 'aviso'));
  }
  if (c.renovacao_automatica) partes.push(el('div', { class: 'pequeno mudo' }, 'Renova sozinho'));
  return partes.length ? el('div', {}, ...partes) : el('span', { class: 'mudo' }, 'em dia');
}

/**
 * Reajuste: o sistema não sabe o IPCA do mês, então quem aplica informa o percentual.
 * O valor muda no contrato e nas campanhas dele — é da campanha que a fatura nasce.
 */
function reajustarContrato(c, recarregar) {
  return formModal(`Reajustar o contrato ${c.numero}`, () => [
    el('p', { class: 'mudo pequeno', style: 'margin:0 0 10px' },
      `Combinado: ${c.reajuste || 'sem índice anotado'}. O valor de hoje é ${dinheiro(c.valor_centavos)}.`),
    el('div', { class: 'duas' },
      campo('Percentual do reajuste (%)', { name: 'percentual', type: 'number', min: 0.01, max: 100, step: '0.01', required: true, autofocus: true,
        value: c.reajuste_percentual ? (c.reajuste_percentual / 100).toString() : '' }),
      campo('Data', { name: 'data', type: 'date', value: c.reajuste_em ?? new Date().toLocaleDateString('en-CA'), required: true })),
    campo('Índice aplicado', { name: 'indice', value: c.reajuste ?? '', maxlength: 60, placeholder: 'Ex.: IPCA acumulado 12 meses' }),
    el('p', { class: 'pequeno mudo', style: 'margin:4px 0 0' }, 'As campanhas em aberto deste contrato sobem no mesmo percentual.'),
  ], async (d) => {
    const r = await api.post(`/painel/contratos/${c.id}/reajuste`, {
      percentual: Math.round(Number(String(d.percentual).replace(',', '.')) * 100),
      data: d.data,
      indice: d.indice,
    });
    toast(`Reajustado: ${dinheiro(r.reajuste.de_centavos)} → ${dinheiro(r.reajuste.para_centavos)} (${r.reajuste.campanhas} campanha(s)).`);
    recarregar();
  });
}

/** Renovação: estende o contrato e, junto, as campanhas que terminavam com ele. */
function renovarContrato(c, recarregar) {
  return formModal(`Renovar o contrato ${c.numero}`, () => [
    el('p', { class: 'mudo pequeno', style: 'margin:0 0 10px' },
      `A vigência atual termina em ${dataBr(c.fim)}. A renovação começa a contar daí.`),
    escolha('Renovar por', 'meses', { 12: '12 meses', 6: '6 meses', 3: '3 meses', 24: '24 meses' }, '12'),
    el('p', { class: 'pequeno mudo', style: 'margin:4px 0 0' },
      'As campanhas que acabavam junto com o contrato passam a acabar na nova data — senão a veiculação pararia com o contrato renovado.'),
  ], async (d) => {
    const r = await api.post(`/painel/contratos/${c.id}/renovar`, { meses: Number(d.meses) });
    toast(`Renovado até ${dataBr(r.renovacao.ate)} (${r.renovacao.campanhas} campanha(s) estendidas).`);
    recarregar();
  });
}

function editarContrato(contrato, cliente, recarregar) {
  const hoje = new Date().toLocaleDateString('en-CA');
  return api.get('/painel/opcoes').then((opcoes) => formModal(contrato ? `Contrato ${contrato.numero}` : `Novo contrato — ${cliente.nome}`, () => [
    el('div', { class: 'duas' },
      campo('Número do contrato', { name: 'numero', value: contrato?.numero ?? '', required: true, maxlength: 40, placeholder: 'Ex.: 2026-014' }),
      escolha('Agência (opcional)', 'agencia_id', { '': 'Direto com o cliente', ...Object.fromEntries(opcoes.agencias.map((x) => [x.id, x.nome])) }, contrato?.agencia_id ?? '')),
    campo('Objeto', { name: 'objeto', value: contrato?.objeto ?? '', maxlength: 300, placeholder: 'Ex.: veiculação no circuito Residencial Campinas' }),
    el('div', { class: 'duas' },
      campo('Início da vigência', { name: 'inicio', type: 'date', value: contrato?.inicio ?? hoje, required: true }),
      campo('Fim (vazio = sem prazo)', { name: 'fim', type: 'date', value: contrato?.fim ?? '' })),
    el('div', { class: 'tres' },
      escolha('Cobrança', 'cobranca', COBRANCA_CONTRATO, contrato?.cobranca ?? 'mensal'),
      campo('Valor (R$)', { name: 'valor', value: reaisCampo(contrato?.valor_centavos), inputmode: 'decimal' }),
      campo('Dia de vencimento', { name: 'vencimento_dia', type: 'number', min: 1, max: 28, value: contrato?.vencimento_dia ?? 10 })),
    el('div', { class: 'tres' },
      campo('Reajuste', { name: 'reajuste', value: contrato?.reajuste ?? '', maxlength: 60, placeholder: 'Ex.: IPCA a cada 12 meses' }),
      campo('A cada (meses)', { name: 'reajuste_meses', type: 'number', min: 0, max: 120, value: contrato?.reajuste_meses ?? 12 }),
      campo('Percentual fixo (%)', { name: 'reajuste_percentual_pct', type: 'number', min: 0, max: 100, step: '0.01',
        value: contrato?.reajuste_percentual ? (contrato.reajuste_percentual / 100).toString() : '' })),
    el('p', { class: 'pequeno mudo', style: 'margin:-4px 0 0' },
      'Com percentual fixo, o reajuste é aplicado sozinho na data. Sem ele, o sistema avisa e a equipe informa quanto — '
      + 'o IPCA do mês o sistema não tem como saber. Zero meses desliga o reajuste.'),
    contrato ? escolha('Situação', 'status', STATUS_CONTRATO_OPCOES, contrato.status) : null,
    marcar('Renovação automática (estende sozinho no fim da vigência)', { name: 'renovacao_automatica', checked: Boolean(contrato?.renovacao_automatica) }),
    area('Observação', { name: 'observacao', maxlength: 500 }, contrato?.observacao ?? ''),
  ], async (d) => {
    const corpo = {
      ...d,
      anunciante_id: cliente.id,
      valor_centavos: centavos(d.valor) ?? 0,
      fim: d.fim || null,
      reajuste_meses: Number(d.reajuste_meses ?? 12),
      reajuste_percentual: Math.round(Number(String(d.reajuste_percentual_pct || 0).replace(',', '.')) * 100),
    };
    delete corpo.valor;
    delete corpo.reajuste_percentual_pct;
    if (contrato) await api.patch(`/painel/contratos/${contrato.id}`, corpo);
    else await api.post('/painel/contratos', corpo);
    toast(contrato ? 'Contrato atualizado.' : 'Contrato cadastrado.');
    recarregar();
  }, { largo: true }));
}

const COBRANCA_CONTRATO = { mensal: 'Valor mensal', cpm: 'CPM (por mil impactos)', pacote: 'Pacote fechado', cortesia: 'Cortesia' };
const STATUS_CONTRATO_OPCOES = { rascunho: 'Rascunho', ativo: 'Ativo', suspenso: 'Suspenso', encerrado: 'Encerrado' };

const criarAcessoAnunciante = (a, recarregar) => formModal(`Acesso ao portal — ${a.nome}`, () => [
  campo('Nome da pessoa', { name: 'nome', value: a.contato ?? '', required: true, maxlength: 120 }),
  campo('E-mail (será o login)', { name: 'email', type: 'email', value: a.email ?? '', required: true }),
], async (d) => {
  const r = await api.post(`/painel/anunciantes/${a.id}/acesso`, d);
  recarregar();
  await modal('Acesso criado', (fechar) => [
    el('p', {}, 'Entregue estes dados ao anunciante. Ele troca a senha no primeiro acesso.'),
    el('div', { class: 'segredo' }, `Endereço: ${location.origin}${location.pathname}\nE-mail: ${d.email}\nSenha provisória: ${r.senha_provisoria}`),
    el('div', { class: 'linha entre' }, el('span', {}), el('button', { class: 'btn primario', onclick: () => fechar() }, 'Entendi')),
  ]);
});

// ---------------------------------------------------------------- Campanhas
export async function campanhas(ctx) {
  const corpo = el('div', { class: 'cartao' });
  const filtro = { busca: '', status: '', anunciante_id: '' };
  const opcoes = await api.get('/painel/opcoes');

  const pintar = async () => {
    const d = await api.get(`/painel/campanhas${qs(filtro)}`);
    limpar(corpo, tabela([
      [(c) => el('div', {}, el('div', {}, c.nome),
        el('div', { class: 'pequeno mudo' }, `${c.anunciante}${c.agencia ? ` · ${c.agencia}` : ''}${c.circuito ? ` · ${c.circuito}` : ''}`)), 'Campanha'],
      [(c) => etiquetaDe(STATUS_CAMPANHA, c.status), 'Situação'],
      [(c) => el('div', {}, el('div', {}, `${dataBr(c.inicio)} → ${c.fim ? dataBr(c.fim) : 'sem fim'}`),
        el('div', { class: 'pequeno mudo' }, `${diasTexto(c.dias_semana)} · ${faixaHorario(c.hora_inicio, c.hora_fim)}`)), 'Quando'],
      [(c) => `${c.insercoes_hora}/h`, 'Inserções', 'num dir'],
      [(c) => (c.criativos_ok === c.criativos ? `${c.criativos}` : el('span', { style: 'color:var(--aviso)' }, `${c.criativos_ok} de ${c.criativos} aprovados`)), 'Criativos', 'num dir'],
      [(c) => (c.alvos ? `${c.alvos} alvo(s)` : 'Toda a rede'), 'Onde'],
      [(c) => inteiro(c.insercoes_hoje), 'Hoje', 'num dir'],
      [(c) => (c.cobranca === 'cpm' ? `CPM ${dinheiro(c.cpm_centavos)}` : c.cobranca === 'mensal' ? `${dinheiro(c.valor_centavos)}/mês` : 'cortesia'), 'Cobrança', 'num dir'],
    ], d.itens, { aoClicar: (c) => abrirCampanha(c.id, pintar, opcoes), vazioTexto: 'Nenhuma campanha. Crie a primeira e envie os criativos.' }));
  };

  let timer;
  limpar(ctx.conteudo,
    el('div', { class: 'filtros livre' },
      el('label', { class: 'campo' }, 'Buscar', el('input', { placeholder: 'Campanha ou anunciante', oninput: (e) => { filtro.busca = e.target.value; clearTimeout(timer); timer = setTimeout(pintar, 300); } })),
      escolha('Situação', 'status', { '': 'Todas', ativa: 'No ar', aguardando: 'Aguardando aprovação', pausada: 'Pausadas', rascunho: 'Rascunhos', encerrada: 'Encerradas' }, '',
        { onchange: (e) => { filtro.status = e.target.value; pintar(); } }),
      escolha('Anunciante', 'anunciante_id', { '': 'Todos', ...Object.fromEntries(opcoes.anunciantes.map((a) => [a.id, a.nome])) }, '',
        { onchange: (e) => { filtro.anunciante_id = e.target.value; pintar(); } }),
      el('button', { class: 'btn primario', onclick: () => editarCampanha(null, pintar, opcoes) }, icone('mais'), 'Nova campanha')),
    corpo);
  await pintar();
}

const camposCampanha = (c, opcoes, padroes) => [
  c ? null : escolha('Anunciante', 'anunciante_id', Object.fromEntries(opcoes.anunciantes.map((a) => [a.id, a.nome])), '', { required: true }),
  campo('Nome da campanha', { name: 'nome', value: c?.nome ?? '', required: true, maxlength: 140 }),
  el('div', { class: 'duas' },
    escolha('Agência (opcional)', 'agencia_id', { '': 'Direto com o anunciante', ...Object.fromEntries(opcoes.agencias.map((a) => [a.id, a.nome])) }, c?.agencia_id ?? ''),
    campo('Número do PI', { name: 'pi', value: c?.pi ?? '', maxlength: 40, placeholder: 'pedido de inserção' })),
  el('div', { class: 'duas' },
    campo('Começa em', { name: 'inicio', type: 'date', value: c?.inicio ?? new Date().toLocaleDateString('en-CA'), required: true }),
    campo('Termina em (vazio = sem fim)', { name: 'fim', type: 'date', value: c?.fim ?? '' })),
  opcoes.circuitos.length
    ? escolha('Circuito (preenche onde passa e as inserções)', 'circuito_id',
      { '': 'Escolher as telas manualmente', ...Object.fromEntries(opcoes.circuitos.map((x) => [x.id, `${x.nome} — ${x.insercoes_hora}/h`])) }, c?.circuito_id ?? '')
    : null,
  el('fieldset', {}, el('legend', {}, 'Quanto vai ao ar'),
    el('div', { class: 'duas' },
      campo('Inserções por hora, em cada TV', { name: 'insercoes_hora', type: 'number', min: 1, max: 120, value: c?.insercoes_hora ?? padroes.insercoes_hora, required: true }),
      escolha('Prioridade (quando a grade enche)', 'prioridade', { 1: '1 — última a entrar', 2: '2', 3: '3 — normal', 4: '4', 5: '5 — primeira a entrar' }, c?.prioridade ?? 3)),
    el('div', { class: 'duas' },
      campo('Hora de início', { name: 'hora_inicio', type: 'time', value: c?.hora_inicio ?? '00:00' }),
      campo('Hora de término (igual ao início = dia inteiro)', { name: 'hora_fim', type: 'time', value: c?.hora_fim ?? '00:00' })),
    el('label', { class: 'campo' }, 'Dias da semana',
      el('div', { class: 'dias' }, DIAS.map((nome, d) => el('label', {}, el('input', { type: 'checkbox', name: `dia_${d}`, checked: String(c?.dias_semana ?? '0123456').includes(String(d)) }), nome)))),
    campo('Limite de inserções por dia em cada TV (0 = sem limite)', { name: 'limite_dia', type: 'number', min: 0, value: c?.limite_dia ?? 0 })),
  el('fieldset', {}, el('legend', {}, 'Cobrança'),
    escolha('Forma', 'cobranca', COBRANCA, c?.cobranca ?? 'mensal'),
    el('div', { class: 'duas' },
      campo('Valor mensal (R$)', { name: 'valor', value: reaisCampo(c?.valor_centavos), inputmode: 'decimal', placeholder: '900,00' }),
      campo('CPM — valor por mil impactos (R$)', { name: 'cpm', value: reaisCampo(c?.cpm_centavos), inputmode: 'decimal', placeholder: '15,00' })),
    el('p', { class: 'pequeno mudo', style: 'margin:0' }, `Preços de tabela: ${dinheiro(padroes.mensalidade_tela_centavos)} por TV/mês · CPM ${dinheiro(padroes.cpm_centavos)}.`)),
];

function editarCampanha(c, recarregar, opcoes) {
  return api.get('/painel/campanhas?limite=1').then(({ padroes }) => formModal(c ? `Editar ${c.nome}` : 'Nova campanha', () => camposCampanha(c, opcoes, padroes), async (d) => {
    const dias = DIAS.map((_, i) => (d[`dia_${i}`] ? String(i) : '')).join('');
    const corpo = {
      ...d,
      dias_semana: dias || '0123456',
      valor_centavos: centavos(d.valor) ?? 0,
      cpm_centavos: centavos(d.cpm) ?? 0,
      fim: d.fim || null,
    };
    for (const k of Object.keys(corpo)) if (/^dia_\d$/.test(k) || ['valor', 'cpm'].includes(k)) delete corpo[k];
    const circuitoId = corpo.circuito_id;
    delete corpo.circuito_id;
    const r = c ? await api.patch(`/painel/campanhas/${c.id}`, corpo) : await api.post('/painel/campanhas', corpo);
    if (circuitoId) await api.post(`/painel/campanhas/${r.id}/circuito`, { circuito_id: circuitoId });
    toast(c ? 'Campanha atualizada.' : (circuitoId ? 'Campanha criada com as telas do circuito. Agora adicione os criativos.' : 'Campanha criada. Agora adicione os criativos e diga onde ela passa.'));
    recarregar();
    if (!c) abrirCampanha(r.id, recarregar, opcoes);
  }, { largo: true }));
}

/** Detalhe da campanha: criativos, onde passa, desempenho e as ações de situação. */
async function abrirCampanha(id, recarregar, opcoes) {
  const d = await api.get(`/painel/campanhas/${id}`);
  const atualizar = async (fechar) => { fechar(); recarregar(); await abrirCampanha(id, recarregar, opcoes); };

  await modal(`${d.nome} — ${d.anunciante}`, (fechar) => [
    el('div', { class: 'linha entre' },
      el('div', { class: 'linha' }, etiquetaDe(STATUS_CAMPANHA, d.status),
        el('span', { class: 'mudo pequeno' }, `${dataBr(d.inicio)} → ${d.fim ? dataBr(d.fim) : 'sem fim'} · ${diasTexto(d.dias_semana)} · ${faixaHorario(d.hora_inicio, d.hora_fim)}`),
        d.agencia ? etiqueta(`${d.agencia}${d.pi ? ` · PI ${d.pi}` : ''} · ${(d.comissao_agencia_percentual / 100).toFixed(0)}% de comissão`, 'info') : null,
        d.circuito ? etiqueta(`Circuito ${d.circuito}`, '') : null),
      el('div', { class: 'linha' }, ...acoesStatus(d, () => atualizar(fechar)))),
    d.motivo ? el('p', { class: 'aviso' }, `Motivo registrado: ${d.motivo}`) : null,

    el('div', { class: 'grade', style: 'margin:16px 0' },
      indicador({ rotulo: 'Inserções no período', valor: inteiro(d.desempenho.insercoes), ic: 'tocar' }),
      indicador({ rotulo: 'Impactos estimados', valor: inteiro(d.desempenho.impactos), ic: 'pessoas', cor: 'ciano' }),
      indicador({ rotulo: 'TVs alcançadas', valor: `${inteiro(d.telas_alcancadas)}`, ic: 'telas', cor: 'roxo', nota: `${inteiro(d.desempenho.telas)} já exibiram` }),
      indicador({
        rotulo: 'Cobrança', ic: 'dinheiro', cor: 'verde',
        valor: d.cobranca === 'cpm' ? `CPM ${dinheiro(d.cpm_centavos)}` : d.cobranca === 'mensal' ? dinheiro(d.valor_centavos) : 'Cortesia',
        nota: d.cobranca === 'mensal' ? 'por mês' : (d.cobranca === 'cpm' ? 'por mil impactos' : 'não fatura'),
      })),

    el('h3', {}, `Criativos (${d.criativos.length})`),
    d.criativos.length
      ? el('div', { class: 'midias' }, d.criativos.map((m) => el('div', { class: 'midia-cartao' }, previa(m),
        el('div', { class: 'corpo' },
          el('h3', { title: m.nome }, m.nome),
          el('div', { class: 'linha' }, etiquetaDe(STATUS_MIDIA, m.status), el('span', { class: 'pequeno mudo' }, `${m.duracao_s}s`)),
          m.orientacao ? el('div', { class: 'pequeno mudo' }, ORIENTACOES[m.orientacao]) : null,
          m.validade_ate ? el('div', { class: 'pequeno mudo' }, `Válido até ${dataBr(m.validade_ate)}`) : null,
          el('div', { class: 'acoes' },
            el('button', { class: 'btn pequeno', onclick: (e) => acao(e.target, async () => {
              const s = await perguntar('Duração nesta campanha', `Quantos segundos este criativo fica no ar? (padrão da mídia: ${m.duracao_midia}s)`, { valor: String(m.duracao_s) });
              if (!s) return;
              await api.del(`/painel/campanhas/${d.id}/criativos/${m.id}`);
              await api.post(`/painel/campanhas/${d.id}/criativos`, { midia_id: m.id, duracao_s: Number(s), ordem: m.ordem });
              atualizar(fechar);
            }) }, 'Duração'),
            el('button', { class: 'btn pequeno perigo', onclick: (e) => acao(e.target, async () => {
              await api.del(`/painel/campanhas/${d.id}/criativos/${m.id}`);
              atualizar(fechar);
            }) }, 'Tirar'))))))
      : vazio('Nenhum criativo. Adicione a imagem ou o vídeo que vai para as telas.'),
    el('div', { class: 'linha', style: 'margin-top:10px' },
      el('button', { class: 'btn', onclick: () => { fechar(); escolherCriativo(d, () => recarregar(), opcoes); } }, icone('mais'), 'Adicionar criativo'),
      el('button', { class: 'btn', onclick: () => { fechar(); enviarCriativo({ anuncianteId: d.anunciante_id, campanhaId: d.id }, () => recarregar(), opcoes); } }, icone('enviar'), 'Enviar arquivo novo')),

    el('h3', {}, 'Onde passa'),
    d.alvos.length
      ? el('div', { class: 'fichas' }, d.alvos.map((a) => el('span', { class: 'ficha' }, textoAlvo(a, opcoes))))
      : el('p', { class: 'aviso ok' }, 'Em toda a rede: todas as TVs ativas.'),
    el('p', { class: 'pequeno mudo' }, `Alcança ${inteiro(d.telas_alcancadas)} TV(s) hoje: ${d.telas.slice(0, 6).map((t) => `${t.local_nome}/${t.nome}`).join(', ')}${d.telas.length > 6 ? '…' : ''}`),
    el('button', { class: 'btn', onclick: () => { fechar(); editarAlvos(d, () => recarregar(), opcoes); } }, icone('pontos'), 'Escolher onde passa'),

    el('div', { class: 'linha entre', style: 'margin-top:20px' },
      el('div', { class: 'linha' },
        el('button', { class: 'btn', onclick: () => { fechar(); editarCampanha(d, recarregar, opcoes); } }, icone('editar'), 'Editar campanha'),
        el('button', {
          class: 'btn', title: 'O checking da agência: o que a campanha fez no mês, pronto para imprimir ou salvar em PDF',
          onclick: () => { fechar(); relatorioDeVeiculacao(d.id, d.nome); },
        }, icone('relatorios'), 'Relatório de veiculação')),
      el('button', { class: 'btn', onclick: () => fechar() }, 'Fechar')),
  ], { largo: true });
}

const textoAlvo = (a, opcoes) => {
  if (a.tipo === 'categoria') return `Categoria: ${CATEGORIAS[a.valor] ?? a.valor}`;
  if (a.tipo === 'cidade') return `Cidade: ${a.valor}`;
  if (a.tipo === 'local') return `Ponto: ${opcoes.locais.find((l) => String(l.id) === a.valor)?.nome ?? a.valor}`;
  const t = opcoes.telas.find((x) => String(x.id) === a.valor);
  return `TV: ${t ? `${t.local_nome} — ${t.nome}` : a.valor}`;
};

function acoesStatus(c, atualizar) {
  const botao = (rotulo, ic, acaoNome, { perigo = false, pedirMotivo = false } = {}) => el('button', {
    class: `btn pequeno${perigo ? ' perigo' : ''}`,
    onclick: (e) => acao(e.target, async () => {
      const motivo = pedirMotivo ? await perguntar(rotulo, 'Motivo (fica registrado)', { obrigatorio: acaoNome === 'recusar' }) : undefined;
      if (pedirMotivo && acaoNome === 'recusar' && !motivo) return;
      await api.post(`/painel/campanhas/${c.id}/status`, { acao: acaoNome, motivo: motivo || undefined });
      toast('Situação atualizada.');
      atualizar();
    }),
  }, ic ? icone(ic) : null, rotulo);

  switch (c.status) {
    case 'rascunho': return [botao('Enviar para aprovação', 'enviar', 'enviar')];
    case 'aguardando': return [botao('Aprovar e colocar no ar', 'ok', 'aprovar'), botao('Recusar', 'erro', 'recusar', { perigo: true, pedirMotivo: true })];
    case 'ativa': return [botao('Pausar', 'pausar', 'pausar', { pedirMotivo: true }), botao('Encerrar', 'parar', 'encerrar', { perigo: true, pedirMotivo: true })];
    case 'pausada': return [botao('Retomar', 'tocar', 'retomar'), botao('Encerrar', 'parar', 'encerrar', { perigo: true, pedirMotivo: true })];
    default: return [botao('Reabrir como rascunho', 'editar', 'reabrir')];
  }
}

/** Escolhe um criativo já aprovado do anunciante. */
async function escolherCriativo(c, recarregar, opcoes) {
  const { itens } = await api.get(`/painel/midias?anunciante_id=${c.anunciante_id}`);
  const disponiveis = itens.filter((m) => m.uso === 'campanha' && !c.criativos.some((x) => x.id === m.id));
  if (!disponiveis.length) {
    toast('Nenhum criativo disponível deste anunciante. Envie um arquivo novo.', true);
    return enviarCriativo({ anuncianteId: c.anunciante_id, campanhaId: c.id }, recarregar, opcoes);
  }
  return modal('Adicionar criativo', (fechar) => el('div', { class: 'midias' }, disponiveis.map((m) => el('div', { class: 'midia-cartao' }, previa(m),
    el('div', { class: 'corpo' },
      el('h3', { title: m.nome }, m.nome),
      el('div', { class: 'linha' }, etiquetaDe(STATUS_MIDIA, m.status), el('span', { class: 'pequeno mudo' }, `${m.duracao_s}s`)),
      el('button', {
        class: 'btn pequeno primario', onclick: (e) => acao(e.target, async () => {
          await api.post(`/painel/campanhas/${c.id}/criativos`, { midia_id: m.id });
          toast('Criativo adicionado.');
          fechar();
          recarregar();
        }),
      }, 'Usar este'))))), { largo: true });
}

/** Editor de alvos: categorias, cidades, pontos e TVs específicas. */
function editarAlvos(c, recarregar, opcoes) {
  const selecao = new Set(c.alvos.map((a) => `${a.tipo}:${a.valor}`));
  return modal(`Onde passa — ${c.nome}`, (fechar) => {
    const grupo = (titulo, tipo, lista) => el('fieldset', {}, el('legend', {}, titulo),
      el('div', { class: 'escolhas' }, lista.map(([valor, rotulo]) => el('label', {},
        el('input', {
          type: 'checkbox', checked: selecao.has(`${tipo}:${valor}`),
          onchange: (e) => (e.target.checked ? selecao.add(`${tipo}:${valor}`) : selecao.delete(`${tipo}:${valor}`)),
        }), rotulo))));
    const ok = el('button', { class: 'btn primario largo' }, 'Salvar');
    ok.addEventListener('click', () => acao(ok, async () => {
      const alvos = [...selecao].map((x) => { const [tipo, ...resto] = x.split(':'); return { tipo, valor: resto.join(':') }; });
      await api.put(`/painel/campanhas/${c.id}/alvos`, { alvos });
      toast(alvos.length ? 'Alvos salvos.' : 'Campanha passa em toda a rede.');
      fechar();
      recarregar();
    }));
    return [
      el('p', { class: 'mudo', style: 'margin:0' }, 'Sem nada marcado, a campanha passa em todas as TVs ativas. Marcando, ela passa só onde bate algum item.'),
      grupo('Por categoria de ponto', 'categoria', Object.entries(CATEGORIAS)),
      grupo('Por cidade', 'cidade', opcoes.cidades.map((x) => [x, x])),
      grupo('Pontos específicos', 'local', opcoes.locais.map((l) => [String(l.id), `${l.nome} — ${l.cidade}`])),
      grupo('TVs específicas', 'tela', opcoes.telas.map((t) => [String(t.id), `${t.local_nome} — ${t.nome}`])),
      el('div', { class: 'linha entre' }, el('button', { class: 'btn', onclick: () => fechar() }, 'Cancelar'), ok),
    ];
  }, { largo: true });
}

// ---------------------------------------------------------------- Criativos
export async function criativos(ctx) {
  const corpo = el('div', {});
  const filtro = { status: '', uso: '', anunciante_id: '', busca: '' };
  const opcoes = await api.get('/painel/opcoes');

  const pintar = async () => {
    const d = await api.get(`/painel/midias${qs(filtro)}`);
    limpar(corpo,
      d.pendentes ? el('p', { class: 'aviso' }, `${d.pendentes} criativo(s) aguardando aprovação. Nada vai ao ar antes de ser aprovado.`) : null,
      el('p', { class: 'pequeno mudo' }, `${d.itens.length} criativo(s) · ${mb(d.disco_bytes)} em disco`),
      d.itens.length
        ? el('div', { class: 'midias' }, d.itens.map((m) => cartaoMidia(m, pintar)))
        : vazio('Nenhum criativo. Envie as imagens e os vídeos que vão para as telas.'));
  };

  let timer;
  limpar(ctx.conteudo,
    el('div', { class: 'filtros livre' },
      el('label', { class: 'campo' }, 'Buscar', el('input', { placeholder: 'Nome do criativo', oninput: (e) => { filtro.busca = e.target.value; clearTimeout(timer); timer = setTimeout(pintar, 300); } })),
      escolha('Situação', 'status', { '': 'Todas', pendente: 'Aguardando aprovação', aprovada: 'Aprovados', recusada: 'Recusados' }, '', { onchange: (e) => { filtro.status = e.target.value; pintar(); } }),
      escolha('Uso', 'uso', { '': 'Todos', campanha: 'De campanha', institucional: 'Institucional / do ponto' }, '', { onchange: (e) => { filtro.uso = e.target.value; pintar(); } }),
      escolha('Anunciante', 'anunciante_id', { '': 'Todos', ...Object.fromEntries(opcoes.anunciantes.map((a) => [a.id, a.nome])) }, '', { onchange: (e) => { filtro.anunciante_id = e.target.value; pintar(); } }),
      el('button', { class: 'btn primario', onclick: () => enviarCriativo({}, pintar, opcoes) }, icone('enviar'), 'Enviar criativo')),
    corpo);
  await pintar();
}

function cartaoMidia(m, recarregar) {
  const decidir = (decisao) => acao(null, async () => {
    const motivo = decisao === 'recusar' ? await perguntar('Recusar criativo', 'Explique o motivo (o anunciante vê isso)') : undefined;
    if (decisao === 'recusar' && !motivo) return;
    await api.post(`/painel/midias/${m.id}/aprovacao`, { decisao, motivo });
    toast(decisao === 'aprovar' ? 'Criativo aprovado: já entra na programação.' : 'Criativo recusado.');
    recarregar();
  });
  return el('div', { class: 'midia-cartao' }, previa(m),
    el('div', { class: 'corpo' },
      el('h3', { title: m.nome }, m.nome),
      el('div', { class: 'pequeno mudo' }, m.anunciante ?? (m.local_nome ? `Ponto: ${m.local_nome}` : 'Institucional da rede')),
      el('div', { class: 'linha' }, etiquetaDe(STATUS_MIDIA, m.status),
        el('span', { class: 'pequeno mudo' }, `${m.largura ?? '?'}×${m.altura ?? '?'} · ${mb(m.bytes)}`)),
      m.motivo ? el('div', { class: 'pequeno', style: 'color:var(--erro)' }, m.motivo) : null,
      m.validade_ate ? el('div', { class: 'pequeno mudo' }, `Válido até ${dataBr(m.validade_ate)}`) : null,
      m.campanhas ? el('div', { class: 'pequeno mudo' }, `Em ${m.campanhas} campanha(s)`) : null,
      el('div', { class: 'acoes' },
        m.status !== 'aprovada' ? el('button', { class: 'btn pequeno primario', onclick: () => decidir('aprovar') }, 'Aprovar') : null,
        m.status !== 'recusada' ? el('button', { class: 'btn pequeno', onclick: () => decidir('recusar') }, 'Recusar') : null,
        el('button', {
          class: 'icone-btn perigo', title: 'Excluir', onclick: (e) => acao(e.target, async () => {
            if (!await confirmar('Excluir criativo', `Apagar "${m.nome}"? Isso só é possível se ele nunca foi exibido.`, 'Excluir')) return;
            await api.del(`/painel/midias/${m.id}`);
            toast('Criativo excluído.');
            recarregar();
          }),
        }, icone('lixo')))));
}

/** Envio do arquivo: o tipo e a duração do vídeo saem do próprio arquivo. */
function enviarCriativo({ anuncianteId = '', campanhaId = null } = {}, recarregar, opcoes) {
  return modal('Enviar criativo', (fechar) => {
    const arquivo = el('input', { type: 'file', name: 'arquivo', accept: 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm', required: true });
    const nome = campo('Nome do criativo', { name: 'nome', required: true, maxlength: 140 });
    const uso = escolha('Uso', 'uso', { campanha: 'De campanha (publicidade)', institucional: 'Institucional / conteúdo do ponto' }, 'campanha');
    const anunciante = escolha('Anunciante', 'anunciante_id', Object.fromEntries(opcoes.anunciantes.map((a) => [a.id, a.nome])), anuncianteId);
    const ponto = escolha('Ponto (opcional, para conteúdo da loja)', 'local_id', { '': 'Institucional da rede', ...Object.fromEntries(opcoes.locais.map((l) => [l.id, l.nome])) }, '');
    ponto.hidden = true;
    uso.querySelector('select').addEventListener('change', (e) => {
      const campanha = e.target.value === 'campanha';
      anunciante.hidden = !campanha;
      ponto.hidden = campanha;
    });
    const duracaoCampo = campo('Duração da imagem (segundos)', { name: 'duracao_s', type: 'number', min: 1, max: 600, placeholder: 'padrão da plataforma' });
    const validade = campo('Válido até (opcional)', { name: 'validade_ate', type: 'date' });
    const ok = el('button', { class: 'btn primario largo' }, 'Enviar');
    arquivo.addEventListener('change', () => {
      const f = arquivo.files?.[0];
      if (f && !nome.querySelector('input').value) nome.querySelector('input').value = f.name.replace(/\.[^.]+$/, '').slice(0, 140);
      duracaoCampo.hidden = Boolean(f && f.type.startsWith('video'));
    });
    const f = el('form', { class: 'form' },
      el('label', { class: 'campo' }, 'Arquivo (imagem JPG/PNG/WEBP ou vídeo MP4/MOV/WEBM)', arquivo),
      nome, uso, anunciante, ponto, duracaoCampo, validade,
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'A duração do vídeo e o tamanho da imagem são lidos do próprio arquivo. O criativo entra como "aguardando aprovação".'),
      el('div', { class: 'linha entre' }, el('button', { type: 'button', class: 'btn', onclick: () => fechar() }, 'Cancelar'), ok));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      acao(ok, async () => {
        const d = lerForm(f);
        const alvo = arquivo.files?.[0];
        if (!alvo) throw new Error('Escolha o arquivo.');
        const m = await enviarArquivo('painel/midias', alvo, {
          nome: d.nome, uso: d.uso, anunciante_id: d.uso === 'campanha' ? d.anunciante_id : '', local_id: d.uso === 'campanha' ? '' : d.local_id,
          duracao_s: d.duracao_s, validade_ate: d.validade_ate,
        });
        if (campanhaId) await api.post(`/painel/campanhas/${campanhaId}/criativos`, { midia_id: m.id });
        toast('Criativo enviado. Aprove para ele entrar na programação.');
        fechar();
        recarregar();
      });
    });
    return f;
  });
}

// ---------------------------------------------------------------- Programação (simulação e ocupação)
export async function programacao(ctx) {
  const opcoes = await api.get('/painel/opcoes');
  if (!opcoes.telas.length) return limpar(ctx.conteudo, vazio('Cadastre uma TV para ver a programação.'));
  const corpo = el('div', { class: 'coluna' });
  const estado = { tela_id: String(opcoes.telas[0].id), data: '', hora: '' };

  const pintar = async () => {
    const g = await api.get(`/painel/grade/${estado.tela_id}${qs({ data: estado.data, hora: estado.hora })}`);
    const ocupacao = await api.get('/painel/ocupacao');
    limpar(corpo,
      cartao(`Loop de ${g.tela.local} — ${g.tela.nome}`,
        el('p', { class: 'pequeno mudo', style: 'margin-top:-8px' }, `Simulado para ${dataHora(g.simulado_em)} · ${ORIENTACOES[g.tela.orientacao]}`),
        linhaDoLoop(g),
        g.itens.length ? el('div', { style: 'margin-top:16px' }, resumoDoLoop(g)) : null,
        g.itens.length ? el('details', { style: 'margin-top:12px' }, el('summary', { class: 'mudo pequeno' }, 'Ver o loop item por item'), itensDoLoop(g)) : null),
      cartao('Ocupação de todas as TVs',
        el('p', { class: 'pequeno mudo', style: 'margin-top:-8px' }, 'Quanto do loop de cada TV está vendido agora. Onde a ocupação está baixa, ainda cabe campanha.'),
        tabela([
          [(t) => el('div', {}, el('div', {}, t.local), el('div', { class: 'pequeno mudo' }, `${t.tela} · ${t.cidade}`)), 'TV'],
          [(t) => duracao(t.duracao_s), 'Loop', 'num dir'],
          [(t) => `${t.campanhas}`, 'Campanhas', 'num dir'],
          [(t) => el('div', { class: 'uso' },
            el('div', { class: 'numeros' }, el('span', {}, `${duracao(t.vendido_s)} de ${duracao(t.duracao_s)}`), el('span', {}, `${t.ocupacao}%`)),
            el('div', { class: 'trilho' }, el('span', { style: `width:${Math.min(100, t.ocupacao)}%` }))), 'Vendido'],
          [(t) => inteiro(t.publico_dia), 'Público/dia', 'num dir'],
          [(t) => (t.sem_conteudo ? etiqueta('Sem programação', 'erro') : (t.ocupacao < 40 ? etiqueta('Espaço livre', 'aviso') : etiqueta('Boa ocupação', 'ok'))), 'Situação'],
        ], ocupacao.itens, { aoClicar: (t) => { estado.tela_id = String(t.tela_id); pintar(); } })));
  };

  limpar(ctx.conteudo,
    el('div', { class: 'filtros livre' },
      escolha('TV', 'tela_id', Object.fromEntries(opcoes.telas.map((t) => [t.id, `${t.local_nome} — ${t.nome}`])), estado.tela_id, { onchange: (e) => { estado.tela_id = e.target.value; pintar(); } }),
      campo('Simular no dia', { type: 'date', onchange: (e) => { estado.data = e.target.value; pintar(); } }),
      campo('Na hora', { type: 'time', onchange: (e) => { estado.hora = e.target.value; pintar(); } }),
      el('button', { class: 'btn', onclick: () => { estado.data = ''; estado.hora = ''; pintar(); } }, icone('relogio'), 'Agora')),
    corpo);
  await pintar();
}
