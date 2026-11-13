import { api, ir, pode } from '../app.js';
import { qs } from '../../comum/api.js';
import {
  el, montar, autoPreencher, cartao, tabela, paginacao, kpi, campo, lerForm, modal, confirmar, toast, acao, aviso, selo, copiar,
  dinheiro, numero, percentual, data, dataHora, documento, telefone, hojeIso, primeiroDiaMes, R, icone,
} from '../../comum/ui.js';
import { agendaLiberacao } from '../../comum/graficos.js';
import { emitir } from './boletos.js';

export default async function clientes({ alvo, params, query, recarregar }) {
  if (params[0]) return ficha(alvo, params[0], params[1] ?? 'resumo', query, recarregar);

  const filtros = { busca: query.busca ?? '', situacao: query.situacao ?? '', pagina: Number(query.pagina) || 1 };
  const lista = await api.get(`/clientes${qs(filtros)}`);
  const form = el('form', { class: 'filtros', onsubmit: (e) => { e.preventDefault(); ir(`#/clientes${qs({ ...filtros, ...lerForm(form), pagina: 1 })}`); } },
    campo({ nome: 'busca', rotulo: 'Buscar', valor: filtros.busca, atributos: { placeholder: 'Razão social, CNPJ ou conta (0001)' } }),
    campo({ nome: 'situacao', rotulo: 'Situação', tipo: 'select', valor: filtros.situacao,
      opcoes: [['', 'Todas'], ...Object.entries(R.situacaoCliente).map(([k, [t]]) => [k, t])] }),
    el('button', { class: 'botao', type: 'submit' }, icone('busca'), 'Filtrar'));

  montar(alvo, 
    el('div', { class: 'cabecalho-tela' },
      el('div', {}, el('h1', {}, 'Clientes'), el('p', {}, `${numero(lista.total)} cliente(s) na plataforma`)),
      pode('clientes.editar') ? el('div', { class: 'acoes' }, el('button', { class: 'botao', onclick: () => novoCliente(recarregar) }, icone('mais'), 'Novo cliente')) : null),
    form,
    tabela({
      colunas: [
        { titulo: 'Cliente', conteudo: (c) => el('span', {}, el('span', { class: 'forte' }, c.nome_fantasia || c.razao_social), el('span', { class: 'sub' }, documento(c.cnpj))) },
        { titulo: 'Conta PayAx', conteudo: (c) => el('span', { class: 'num' }, c.conta_payax ?? '—') },
        { titulo: 'Situação', conteudo: (c) => selo(c.situacao, R.situacaoCliente) },
        { titulo: 'Boletos em aberto', dir: true, conteudo: (c) => numero(c.boletos_abertos) },
        { titulo: 'Saldo disponível', dir: true, conteudo: (c) => el('strong', {}, dinheiro(c.disponivel_centavos)) },
        { titulo: 'A liberar', dir: true, conteudo: (c) => dinheiro(c.a_liberar_centavos) },
      ],
      itens: lista.itens,
      vazio: 'Nenhum cliente cadastrado ainda.',
      aoClicar: (c) => ir(`#/clientes/${c.id}`),
      rodape: paginacao(lista, (p) => ir(`#/clientes${qs({ ...filtros, pagina: p })}`)),
    }),
  );
}

// ---------------------------------------------------------------- Ficha do cliente
async function ficha(alvo, id, aba, query, recarregar) {
  const c = await api.get(`/clientes/${id}`);
  const abas = [
    ['resumo', 'Resumo'],
    ['boletos', 'Boletos'],
    ['extrato', 'Conta gráfica'],
    ['repasses', 'Repasses'],
    ['precos', 'Preços'],
    ['acessos', 'Acessos e IXC'],
  ];

  montar(alvo, 
    el('div', { class: 'cabecalho-tela' },
      el('div', {},
        el('a', { class: 'botao sutil', href: '#/clientes' }, icone('voltar'), 'Clientes'),
        el('h1', {}, c.nome_fantasia || c.razao_social),
        el('p', {}, `${documento(c.cnpj)} · conta PayAx ${c.conta_payax_curta} · `, selo(c.situacao, R.situacaoCliente))),
      el('div', { class: 'acoes' },
        pode('boletos.emitir') && c.situacao === 'ativo'
          ? el('button', { class: 'botao', onclick: async () => emitir([c], recarregar, c.id) }, icone('mais'), 'Emitir boleto') : null,
        pode('clientes.editar') ? el('button', { class: 'botao sec', onclick: () => editarCliente(c, recarregar) }, icone('config'), 'Editar cadastro') : null)),
    el('div', { class: 'abas' }, abas.map(([k, t]) =>
      el('button', { class: aba === k ? 'ativa' : '', onclick: () => ir(`#/clientes/${c.id}/${k}`) }, t))),
    el('div', { id: 'aba-corpo' }),
  );
  const corpo = alvo.querySelector('#aba-corpo');
  const telas = { resumo: abaResumo, boletos: abaBoletos, extrato: abaExtrato, repasses: abaRepasses, precos: abaPrecos, acessos: abaAcessos };
  await (telas[aba] ?? abaResumo)(corpo, c, query, recarregar);
}

async function abaResumo(alvo, c, query, recarregar) {
  const par = (rot, val) => el('div', { class: 'par' }, el('span', { class: 'rot' }, rot), el('span', { class: 'val' }, val));
  montar(alvo, 
    el('div', { class: 'grade kpis' },
      kpi({ rotulo: 'Saldo disponível', valor: dinheiro(c.saldo.disponivel_centavos), apoio: 'pronto para repasse', tom: 'destaque', ic: 'cofre' }),
      kpi({ rotulo: 'A liberar', valor: dinheiro(c.saldo.a_liberar_centavos), apoio: `retenção de D+${c.retencao_dias} dia(s) útil(eis)`, ic: 'relogio' }),
      kpi({ rotulo: 'Recebido no mês', valor: dinheiro(c.liquidacoes_mes.bruto_centavos), apoio: `${numero(c.liquidacoes_mes.titulos)} título(s)`, ic: 'dinheiro' }),
      kpi({ rotulo: 'Nossa receita no mês', valor: dinheiro(c.liquidacoes_mes.receita_centavos),
        apoio: c.pode_ver_margem ? `margem ${dinheiro(c.liquidacoes_mes.margem_centavos)}` : 'comissão + tarifas', tom: 'positivo', ic: 'relatorio' })),
    el('div', { class: 'grade duas', style: 'margin-top:14px' },
      cartao('Cadastro', el('div', { class: 'pares' },
        par('Conta PayAx', el('strong', {}, c.conta_payax ?? '—')),
        par('Razão social', c.razao_social),
        par('CNPJ', documento(c.cnpj)),
        par('Responsável', c.responsavel ?? '—'),
        par('E-mail', c.email ?? '—'),
        par('Telefone', telefone(c.telefone)),
        par('Cidade', [c.cidade, c.uf].filter(Boolean).join('/') || '—'),
        par('Limite por boleto', dinheiro(c.limite_boleto_centavos)))),
      cartao('Repasse', el('div', { class: 'pares' },
        par('Chave PIX', c.pix_chave ? `${c.pix_chave} (${c.pix_tipo})` : el('span', { style: 'color:var(--vermelho)' }, 'não cadastrada')),
        par('Titular', c.pix_titular ?? c.razao_social),
        par('Automático', c.repasse_automatico ? 'Sim, a cada dia útil' : 'Não (manual)'),
        par('Valor mínimo', dinheiro(c.repasse_minimo_centavos)),
        par('Limite sem aprovação', dinheiro(c.repasse_limite_aprovacao_centavos)),
        par('Retenção', `D+${c.retencao_dias} dia(s) útil(eis)`)))),
    el('div', { class: 'grade duas', style: 'margin-top:14px' },
      cartao('Boletos do mês', el('div', { class: 'pares' },
        par('Emitidos', `${numero(c.resumo_mes.emitidos)} · ${dinheiro(c.resumo_mes.valor_emitido_centavos)}`),
        par('Liquidados', `${numero(c.resumo_mes.liquidados)} · ${dinheiro(c.resumo_mes.valor_liquidado_centavos)}`),
        par('A vencer', numero(c.resumo_mes.a_vencer)),
        par('Vencidos', `${numero(c.resumo_mes.vencidos)} · ${dinheiro(c.resumo_mes.valor_vencido_centavos)}`))),
      cartao('Liberação do saldo nos próximos dias', agendaLiberacao({ dados: c.agenda }))),
  );
}

async function abaBoletos(alvo, c, query) {
  const lista = await api.get(`/clientes/${c.id}/boletos${qs({ ...query, por_pagina: 50 })}`);
  montar(alvo, tabela({
    colunas: [
      { titulo: 'Nosso número', conteudo: (b) => el('span', { class: 'num' }, b.nosso_numero_formatado) },
      { titulo: 'Pagador', conteudo: (b) => el('span', {}, b.pagador_nome, el('span', { class: 'sub' }, documento(b.pagador_documento))) },
      { titulo: 'Vencimento', dir: true, conteudo: (b) => data(b.vencimento) },
      { titulo: 'Valor', dir: true, conteudo: (b) => dinheiro(b.valor_centavos) },
      { titulo: 'Situação', conteudo: (b) => selo(b.situacao_visivel) },
    ],
    itens: lista.itens,
    vazio: 'Este cliente ainda não emitiu boletos.',
    aoClicar: (b) => ir(`#/boletos/${b.id}`),
  }));
}

async function abaExtrato(alvo, c, query, recarregar) {
  const de = query.de ?? primeiroDiaMes();
  const ate = query.ate ?? hojeIso();
  const e = await api.get(`/clientes/${c.id}/extrato${qs({ de, ate })}`);
  const form = el('form', { class: 'filtros', onsubmit: (ev) => { ev.preventDefault(); ir(`#/clientes/${c.id}/extrato${qs(lerForm(form))}`); } },
    campo({ nome: 'de', rotulo: 'De', tipo: 'date', valor: de }),
    campo({ nome: 'ate', rotulo: 'Até', tipo: 'date', valor: ate }),
    el('button', { class: 'botao', type: 'submit' }, 'Filtrar'),
    el('button', { class: 'botao sec', type: 'button', onclick: (ev) => acao(ev.currentTarget, () => api.baixar(`/clientes/${c.id}/extrato.csv${qs({ de, ate })}`, `extrato-${c.cnpj}.csv`)) }, icone('baixar'), 'CSV'),
    pode('razao.ajustar') ? el('button', { class: 'botao sec', type: 'button', onclick: () => ajustar(c, recarregar) }, 'Lançar ajuste') : null);

  montar(alvo, 
    el('div', { class: 'grade kpis' },
      kpi({ rotulo: 'Saldo disponível', valor: dinheiro(e.saldo.disponivel_centavos), tom: 'destaque' }),
      kpi({ rotulo: 'A liberar', valor: dinheiro(e.saldo.a_liberar_centavos), menor: true }),
      kpi({ rotulo: 'Saldo total', valor: dinheiro(e.saldo.total_centavos), menor: true }),
      kpi({ rotulo: 'Movimento do período', valor: dinheiro(e.soma_centavos), menor: true, apoio: `${numero(e.total)} lançamento(s)` })),
    el('div', { style: 'margin-top:14px' }, form),
    tabela({
      colunas: [
        { titulo: 'Competência', conteudo: (l) => data(l.data_competencia) },
        { titulo: 'Liberação', conteudo: (l) => el('span', {}, data(l.data_liberacao),
          l.data_liberacao > hojeIso() ? el('span', { class: 'sub' }, 'a liberar') : null) },
        { titulo: 'Lançamento', conteudo: (l) => el('span', {}, l.tipo_nome, el('span', { class: 'sub' }, l.descricao)) },
        { titulo: 'Valor', dir: true, conteudo: (l) => el('strong', { style: l.valor_centavos < 0 ? 'color:var(--vermelho)' : 'color:var(--verde-texto)' }, dinheiro(l.valor_centavos)) },
        { titulo: 'Saldo', dir: true, conteudo: (l) => dinheiro(l.saldo_acumulado_centavos) },
      ],
      itens: e.itens,
      vazio: 'Nenhum lançamento no período.',
    }),
  );
}

function ajustar(c, recarregar) {
  const form = el('form', { class: 'linha-form', onsubmit: (e) => e.preventDefault() },
    campo({ nome: 'sentido', rotulo: 'Tipo', tipo: 'select', opcoes: [['credito', 'Crédito (aumenta o saldo)'], ['debito', 'Débito (reduz o saldo)']] }),
    campo({ nome: 'valor', rotulo: 'Valor (R$)', tipo: 'dinheiro', obrigatorio: true }),
    campo({ nome: 'motivo', rotulo: 'Motivo', obrigatorio: true, atributos: { maxlength: 200 } }));
  const botao = el('button', { class: 'botao' }, 'Lançar ajuste');
  botao.addEventListener('click', () => acao(botao, async () => {
    await api.post(`/clientes/${c.id}/ajustes`, lerForm(form));
    m.fechar();
    toast('Ajuste lançado na conta gráfica.', 'ok');
    recarregar();
  }));
  const m = modal({ titulo: `Ajuste manual · ${c.razao_social}`,
    corpo: [aviso('O ajuste entra no extrato do cliente com o motivo informado e fica na auditoria.', 'aviso'), form],
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao] });
}

async function abaRepasses(alvo, c, query, recarregar) {
  const d = await api.get(`/clientes/${c.id}/repasses`);
  montar(alvo, 
    el('div', { class: 'grade kpis' },
      kpi({ rotulo: 'Disponível para repasse', valor: dinheiro(d.disponivel.disponivel_centavos), tom: 'destaque' }),
      kpi({ rotulo: 'Tarifa do repasse', valor: dinheiro(d.disponivel.taxa_repasse_centavos), menor: true }),
      kpi({ rotulo: 'Em trânsito', valor: dinheiro(d.disponivel.em_transito_centavos), menor: true })),
    pode('repasses.aprovar') && d.disponivel.disponivel_centavos > 0
      ? el('div', { style: 'margin-top:14px' }, el('button', { class: 'botao', onclick: (e) => acao(e.currentTarget, async () => {
        const r = await confirmar({ titulo: 'Repassar saldo', texto: `Repassar ${dinheiro(d.disponivel.disponivel_centavos)} para a chave PIX ${c.pix_chave ?? '(não cadastrada)'}?`, confirmarTexto: 'Repassar' });
        if (!r) return;
        await api.post('/repasses', { cliente_id: c.id, valor: 'tudo', enviar_agora: true });
        toast('Repasse criado.', 'ok');
        recarregar();
      }) }, icone('troca'), 'Repassar saldo disponível'))
      : null,
    el('div', { style: 'margin-top:14px' }, tabela({
      colunas: [
        { titulo: '#', conteudo: (r) => r.id },
        { titulo: 'Criado', conteudo: (r) => dataHora(r.criado_em) },
        { titulo: 'Valor', dir: true, conteudo: (r) => el('span', {}, el('strong', {}, dinheiro(r.valor_liquido_centavos)),
          r.taxa_centavos ? el('span', { class: 'sub' }, `tarifa ${dinheiro(r.taxa_centavos)}`) : null) },
        { titulo: 'Chave PIX', conteudo: (r) => r.pix_chave },
        { titulo: 'Situação', conteudo: (r) => selo(r.situacao, R.situacaoRepasse) },
      ],
      itens: d.itens,
      vazio: 'Nenhum repasse ainda.',
    })),
  );
}

async function abaPrecos(alvo, c, query, recarregar) {
  const p = await api.get(`/clientes/${c.id}/precos`);
  const v = p.vigente;
  const par = (rot, val) => el('div', { class: 'par' }, el('span', { class: 'rot' }, rot), el('span', { class: 'val' }, val));
  montar(alvo, 
    cartao(v.id ? 'Tabela do cliente (vigente)' : 'Usando a tabela padrão da plataforma',
      el('div', { class: 'pares' },
        par('Tarifa de emissão', dinheiro(v.tarifa_emissao_centavos)),
        par('Tarifa de liquidação', dinheiro(v.tarifa_liquidacao_centavos)),
        par('Comissão', percentual(v.percentual_ppm)),
        par('Comissão mínima', dinheiro(v.comissao_minima_centavos)),
        par('Comissão máxima', v.comissao_maxima_centavos === null ? 'sem teto' : dinheiro(v.comissao_maxima_centavos)),
        par('Tarifa do repasse', dinheiro(v.tarifa_repasse_centavos))),
      pode('precos.editar') ? el('button', { class: 'botao', onclick: () => novoPreco(c, v, recarregar) }, 'Nova tabela') : null),
    el('div', { style: 'margin-top:14px' }, cartao('Histórico de preços', tabela({
      colunas: [
        { titulo: 'Vigência', conteudo: (x) => `${data(x.vigencia_inicio)} → ${x.vigencia_fim ? data(x.vigencia_fim) : 'em diante'}` },
        { titulo: 'Emissão', dir: true, conteudo: (x) => dinheiro(x.tarifa_emissao_centavos) },
        { titulo: 'Liquidação', dir: true, conteudo: (x) => dinheiro(x.tarifa_liquidacao_centavos) },
        { titulo: 'Comissão', dir: true, conteudo: (x) => percentual(x.percentual_ppm) },
        { titulo: 'Mínima', dir: true, conteudo: (x) => dinheiro(x.comissao_minima_centavos) },
      ],
      itens: p.historico,
      vazio: 'Sem tabela própria: vale a tabela padrão da plataforma.',
    }))),
  );
}

function novoPreco(c, atual, recarregar) {
  const reais = (v) => (v === null || v === undefined ? '' : (v / 100).toFixed(2).replace('.', ','));
  const form = el('form', { class: 'linha-form', onsubmit: (e) => e.preventDefault() },
    campo({ nome: 'vigencia_inicio', rotulo: 'Vigente a partir de', tipo: 'date', valor: hojeIso(), obrigatorio: true }),
    campo({ nome: 'tarifa_emissao', rotulo: 'Tarifa de emissão (R$)', tipo: 'dinheiro', valor: reais(atual.tarifa_emissao_centavos) }),
    campo({ nome: 'tarifa_liquidacao', rotulo: 'Tarifa de liquidação (R$)', tipo: 'dinheiro', valor: reais(atual.tarifa_liquidacao_centavos), ajuda: 'Cobrada do cliente a cada título pago' }),
    campo({ nome: 'percentual', rotulo: 'Comissão (%)', valor: ((atual.percentual_ppm || 0) / 10000).toString().replace('.', ','), ajuda: 'Sobre o valor pago' }),
    campo({ nome: 'comissao_minima', rotulo: 'Comissão mínima (R$)', tipo: 'dinheiro', valor: reais(atual.comissao_minima_centavos) }),
    campo({ nome: 'comissao_maxima', rotulo: 'Comissão máxima (R$)', tipo: 'dinheiro', valor: reais(atual.comissao_maxima_centavos), ajuda: 'Vazio = sem teto' }),
    campo({ nome: 'tarifa_repasse', rotulo: 'Tarifa do repasse (R$)', tipo: 'dinheiro', valor: reais(atual.tarifa_repasse_centavos) }),
    campo({ nome: 'observacao', rotulo: 'Observação' }));
  const botao = el('button', { class: 'botao' }, 'Salvar tabela');
  botao.addEventListener('click', () => acao(botao, async () => {
    await api.post(`/clientes/${c.id}/precos`, lerForm(form));
    m.fechar();
    toast('Nova tabela de preços em vigor.', 'ok');
    recarregar();
  }));
  const m = modal({ titulo: `Preços de ${c.razao_social}`, largo: true,
    corpo: [aviso('Boletos já emitidos mantêm o preço congelado na emissão: a nova tabela vale para os próximos.', 'info'), form],
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao] });
}

async function abaAcessos(alvo, c, query, recarregar) {
  montar(alvo, 
    cartao('Acessos ao Internet Bank', tabela({
      colunas: [
        { titulo: 'Nome', conteudo: (a) => el('span', {}, a.nome, el('span', { class: 'sub' }, a.email)) },
        { titulo: 'Perfil', conteudo: (a) => R.perfilCliente[a.perfil] ?? a.perfil },
        { titulo: 'Último acesso', conteudo: (a) => (a.ultimo_acesso ? dataHora(a.ultimo_acesso) : 'nunca entrou') },
        { titulo: 'Situação', conteudo: (a) => selo(a.ativo ? 'ativo' : 'suspenso', R.situacaoCliente) },
        { titulo: '', dir: true, conteudo: (a) => el('button', { class: 'botao sutil pequeno', onclick: (e) => acao(e.currentTarget, async () => {
          const r = await confirmar({ titulo: 'Redefinir senha', texto: `Gerar nova senha provisória para ${a.nome}?`, confirmarTexto: 'Gerar' });
          if (!r) return;
          const out = await api.patch(`/clientes/${c.id}/acessos/${a.id}`, { redefinir_senha: true });
          modal({ titulo: 'Senha provisória', corpo: [el('p', {}, `Entregue esta senha a ${a.nome}. Ela será trocada no primeiro acesso.`),
            el('div', { class: 'codigo' }, out.senha_provisoria)], acoes: [el('button', { class: 'botao', onclick: () => copiar(out.senha_provisoria) }, 'Copiar')] });
        }) }, 'Redefinir senha') },
      ],
      itens: c.acessos,
      vazio: 'Nenhum acesso criado. O cliente ainda não consegue entrar no Internet Bank.',
    }), pode('clientes.editar') ? el('button', { class: 'botao', onclick: () => novoAcesso(c, recarregar) }, icone('mais'), 'Novo acesso') : null),

    el('div', { style: 'margin-top:14px' }, cartao('Integração com o IXC',
      el('div', {},
        el('div', { class: 'pares' },
          el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Estado'), el('span', { class: 'val' }, selo(c.ixc.estado, R.estadoIntegracao))),
          el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Importação automática'), el('span', { class: 'val' }, c.ixc.importacao_automatica ? 'Ligada' : 'Desligada')),
          el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Último teste'), el('span', { class: 'val' }, c.ixc.ultimo_teste ? dataHora(c.ixc.ultimo_teste) : '—'))),
        c.ixc.ultimo_erro ? el('div', { style: 'margin-top:10px' }, aviso(c.ixc.ultimo_erro, 'erro')) : null,
        el('p', { style: 'margin-top:10px;color:var(--texto-2);font-size:13px' },
          'A configuração do IXC deste cliente (endereço e token) fica em Integrações.')),
      el('a', { class: 'botao sec', href: '#/integracoes' }, icone('plugue'), 'Abrir Integrações'))),
  );
}

function novoAcesso(c, recarregar) {
  const form = el('form', { class: 'linha-form', onsubmit: (e) => e.preventDefault() },
    campo({ nome: 'nome', rotulo: 'Nome', obrigatorio: true }),
    campo({ nome: 'email', rotulo: 'E-mail', tipo: 'email', obrigatorio: true }),
    campo({ nome: 'perfil', rotulo: 'Perfil', tipo: 'select', valor: 'admin', opcoes: Object.entries(R.perfilCliente) }));
  const botao = el('button', { class: 'botao' }, 'Criar acesso');
  botao.addEventListener('click', () => acao(botao, async () => {
    const out = await api.post(`/clientes/${c.id}/acessos`, lerForm(form));
    m.fechar();
    modal({ titulo: 'Acesso criado', corpo: [
      el('p', {}, `Entregue esta senha provisória a ${out.nome}. Ela será trocada no primeiro acesso.`),
      el('div', { class: 'codigo' }, out.senha_provisoria),
    ], acoes: [el('button', { class: 'botao', onclick: () => copiar(out.senha_provisoria) }, icone('copiar'), 'Copiar senha')] });
    recarregar();
  }));
  const m = modal({ titulo: 'Novo acesso ao Internet Bank', corpo: form,
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao] });
}

// ---------------------------------------------------------------- Cadastro
function camposCadastro(c = {}) {
  const reais = (v) => (v === null || v === undefined ? '' : (v / 100).toFixed(2).replace('.', ','));
  return el('div', {},
    el('div', { class: 'linha-form' },
      campo({ nome: 'razao_social', rotulo: 'Razão social', valor: c.razao_social ?? '', obrigatorio: true }),
      campo({ nome: 'nome_fantasia', rotulo: 'Nome fantasia', valor: c.nome_fantasia ?? '' }),
      campo({ nome: 'cnpj', rotulo: 'CNPJ', valor: c.cnpj ?? '', obrigatorio: true }),
      campo({ nome: 'situacao', rotulo: 'Situação', tipo: 'select', valor: c.situacao ?? 'implantacao', opcoes: Object.entries(R.situacaoCliente).map(([k, [t]]) => [k, t]) })),
    el('div', { class: 'linha-form', style: 'margin-top:12px' },
      campo({ nome: 'responsavel', rotulo: 'Responsável', valor: c.responsavel ?? '' }),
      campo({ nome: 'email', rotulo: 'E-mail', tipo: 'email', valor: c.email ?? '' }),
      campo({ nome: 'telefone', rotulo: 'Telefone', valor: c.telefone ?? '' })),
    el('h3', { style: 'font-size:14px;margin:14px 0 8px' }, 'Endereço'),
    el('div', { class: 'linha-form' },
      campo({ nome: 'cep', rotulo: 'CEP', valor: c.cep ?? '' }),
      campo({ nome: 'endereco', rotulo: 'Endereço', valor: c.endereco ?? '' }),
      campo({ nome: 'numero', rotulo: 'Número', valor: c.numero ?? '' }),
      campo({ nome: 'bairro', rotulo: 'Bairro', valor: c.bairro ?? '' }),
      campo({ nome: 'cidade', rotulo: 'Cidade', valor: c.cidade ?? '' }),
      campo({ nome: 'uf', rotulo: 'UF', valor: c.uf ?? '', atributos: { maxlength: 2, style: 'text-transform:uppercase' } })),
    el('h3', { style: 'font-size:14px;margin:14px 0 8px' }, 'Repasse e limites'),
    el('div', { class: 'linha-form' },
      campo({ nome: 'pix_chave', rotulo: 'Chave PIX do repasse', valor: c.pix_chave ?? '', ajuda: 'CPF/CNPJ, celular, e-mail ou chave aleatória' }),
      campo({ nome: 'pix_titular', rotulo: 'Titular da chave', valor: c.pix_titular ?? '' }),
      campo({ nome: 'pix_documento', rotulo: 'CPF/CNPJ do titular', valor: c.pix_documento ?? '' }),
      campo({ nome: 'retencao_dias', rotulo: 'Retenção (dias úteis)', tipo: 'number', valor: c.retencao_dias ?? 1, atributos: { min: 0, max: 30 } }),
      campo({ nome: 'repasse_automatico', rotulo: 'Repasse automático', tipo: 'select', valor: String(c.repasse_automatico ?? 1), opcoes: [['1', 'Sim'], ['0', 'Não']] }),
      campo({ nome: 'repasse_minimo', rotulo: 'Repasse mínimo (R$)', tipo: 'dinheiro', valor: reais(c.repasse_minimo_centavos ?? 1000) }),
      campo({ nome: 'repasse_limite_aprovacao', rotulo: 'Limite sem aprovação (R$)', tipo: 'dinheiro', valor: reais(c.repasse_limite_aprovacao_centavos ?? 5000000) }),
      campo({ nome: 'limite_boleto', rotulo: 'Limite por boleto (R$)', tipo: 'dinheiro', valor: reais(c.limite_boleto_centavos ?? 5000000) })),
    el('div', { style: 'margin-top:12px' }, campo({ nome: 'observacoes', rotulo: 'Observações', tipo: 'textarea', valor: c.observacoes ?? '' })));
}

/** Liga CNPJ e CEP à consulta automática no formulário de cadastro. */
function ligarConsultas(form) {
  autoPreencher(form, api, { tipo: 'cnpj', campo: 'cnpj', mapa: {
    razao_social: 'razao_social', nome_fantasia: 'nome_fantasia', cep: 'cep', endereco: 'endereco',
    numero: 'numero', complemento: 'complemento', bairro: 'bairro', cidade: 'cidade', uf: 'uf',
  } });
  autoPreencher(form, api, { tipo: 'cep', campo: 'cep', mapa: {
    endereco: 'endereco', bairro: 'bairro', cidade: 'cidade', uf: 'uf',
  } });
}

function novoCliente(recarregar) {
  const form = el('form', { onsubmit: (e) => e.preventDefault() }, camposCadastro());
  ligarConsultas(form);
  const botao = el('button', { class: 'botao' }, 'Cadastrar cliente');
  botao.addEventListener('click', () => acao(botao, async () => {
    const c = await api.post('/clientes', lerForm(form));
    m.fechar();
    toast('Cliente cadastrado.', 'ok');
    ir(`#/clientes/${c.id}`);
    recarregar();
  }));
  const m = modal({ titulo: 'Novo cliente', largo: true, corpo: form,
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao] });
}

function editarCliente(c, recarregar) {
  const form = el('form', { onsubmit: (e) => e.preventDefault() }, camposCadastro(c));
  ligarConsultas(form);
  const botao = el('button', { class: 'botao' }, 'Salvar');
  botao.addEventListener('click', () => acao(botao, async () => {
    await api.patch(`/clientes/${c.id}`, { ...lerForm(form), versao: c.versao });
    m.fechar();
    toast('Cadastro atualizado.', 'ok');
    recarregar();
  }));
  const m = modal({ titulo: `Editar ${c.razao_social}`, largo: true, corpo: form,
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao] });
}
