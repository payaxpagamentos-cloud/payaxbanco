import { api, qs, baixar } from '../api.js';
import { el, limpar, pode, cabecalho, painel, tabela, paginacao, abas, etq, rotulo, opcoes, dinheiro, data, dataHora, documento, dl,
  numero, porcento, carregar, carregando, formulario, pedirMotivo, confirmar, botao, toast, faixa, stat, vazio, modal, hoje } from '../ui.js';

/*
 * Contabilidade.
 *
 * Toda tela aqui diz a que competência se refere e se ela está fechada. Um balancete sem período é um
 * número solto; um de mês aberto pode mudar amanhã, e quem vai levar ao contador precisa saber disso.
 */

const competenciaAtual = () => hoje().slice(0, 7);
const TIPOS = [['ativo', 'Ativo'], ['passivo', 'Passivo'], ['patrimonio', 'Patrimônio líquido'], ['receita', 'Receita'], ['despesa', 'Despesa']];
const ROTULO_CHAVE = {
  clientes: 'Clientes a receber', caixa: 'Caixa (dinheiro)', banco: 'Banco (PIX, boleto, cartão)',
  receita_mensalidade: 'Receita de mensalidade', receita_instalacao: 'Receita de instalação',
  receita_sva: 'Receita de SVA', receita_equipamento: 'Aluguel de equipamento', receita_outros: 'Outras receitas de serviço',
  juros_recebidos: 'Juros e multas recebidos', descontos_concedidos: 'Descontos concedidos', cancelamentos: 'Cancelamentos',
};

export default async function contabil({ alvo, query, ir }) {
  const aba = query.aba ?? 'painel';
  const comp = query.competencia ?? competenciaAtual();
  const corpo = el('div');
  const recarregar = () => contabil({ alvo, query, ir });

  limpar(alvo, cabecalho({
    sobretitulo: 'Assinantes e financeiro',
    titulo: 'Contabilidade',
    descricao: 'Partidas dobradas: todo lançamento fecha, nada é apagado e competência fechada não muda. '
      + 'O que o financeiro faz entra aqui sozinho, e a conferência mostra se sobrou alguma coisa de fora.',
    acoes: [
      pode('contabil.lancar') ? botao('Novo lançamento', () => novoLancamento(recarregar), { ic: 'mais' }) : null,
    ],
  }), abas([['painel', 'Painel'], ['balancete', 'Balancete'], ['dre', 'DRE'], ['lancamentos', 'Lançamentos'],
    ['orcamento', 'Orçado × realizado'], ['plano', 'Plano de contas'], ['certificado', 'Certificado digital']],
  aba, (id) => ir(`#/contabil?aba=${id}&competencia=${comp}`)), corpo);

  if (aba === 'balancete') return telaBalancete(corpo, comp, ir);
  if (aba === 'dre') return telaDre(corpo, comp, ir);
  if (aba === 'lancamentos') return telaLancamentos(corpo, query, ir, recarregar);
  if (aba === 'orcamento') return telaOrcamento(corpo, comp, ir, recarregar);
  if (aba === 'plano') return telaPlano(corpo, recarregar);
  if (aba === 'certificado') return telaCertificado(corpo, recarregar);
  return telaPainel(corpo, comp, ir, recarregar);
}

const seletorCompetencia = (comp, ir, aba) => el('div', { class: 'filtros' },
  el('label', { class: 'campo', style: 'max-width:200px' }, el('span', {}, 'Competência'),
    el('input', { type: 'month', value: comp, onchange: (e) => ir(`#/contabil?aba=${aba}&competencia=${e.target.value}`) })));

/* ---------------- Painel ---------------- */

function telaPainel(corpo, comp, ir, recarregar) {
  return carregar(corpo, () => api.get(`/contabil/resumo${qs({ competencia: comp })}`), (r) => {
    if (!r.plano_criado) {
      return vazio('A contabilidade ainda não foi aberta.',
        'Comece pelo plano de contas: dá para partir de um plano padrão para provedor e ajustá-lo, ou montar o seu do zero.',
        pode('contabil.plano') ? botao('Criar plano de contas padrão', () => criarPadrao(recarregar), { ic: 'camadas' }) : null);
    }
    const d = r.dre ?? {};
    return [
      seletorCompetencia(comp, ir, 'painel'),
      r.fechada ? faixa(`A competência ${comp} está fechada: nada entra nem muda nela.`, 'info', 'cadeado') : null,
      r.balancete_fecha === false
        ? faixa('O balancete desta competência não está fechando. Isso não deveria acontecer — avise antes de entregar ao contador.', 'erro', 'alerta')
        : null,
      !r.mapa_completo
        ? faixa(`O plano de contas ainda não está mapeado: falta definir ${r.contas_faltando.map((k) => ROTULO_CHAVE[k] ?? k).join(', ')}. `
          + 'Sem o mapa, o sistema não contabiliza sozinho.', 'aviso', 'alerta')
        : !r.automatica
          ? faixa('A contabilização automática está desligada: o que o financeiro faz não entra aqui sozinho.', 'aviso', 'info')
          : null,
      r.pendentes
        ? faixa(`${numero(r.pendentes)}${r.pode_haver_mais_pendentes ? '+' : ''} fato(s) do financeiro ainda sem lançamento. `
          + 'Enquanto estiverem assim, o balancete está incompleto.', 'aviso', 'alerta')
        : faixa('Nenhum fato do financeiro sem lançamento: a contabilidade está em dia com o caixa.', 'ok', 'ok'),
      el('div', { class: 'stats' },
        stat({ rotulo: 'Receita líquida', valor: dinheiro(d.receita_liquida_centavos ?? 0), nota: `Competência ${comp}`, ic: 'dinheiro' }),
        stat({ rotulo: 'Custo do serviço', valor: dinheiro(d.custo_servico_centavos ?? 0), nota: 'Link, manutenção, materiais', ic: 'rede' }),
        stat({ rotulo: 'Despesas', valor: dinheiro(d.despesas_centavos ?? 0), nota: 'Pessoal, administrativo, frota', ic: 'recibo' }),
        stat({ rotulo: 'Resultado', valor: dinheiro(d.resultado_centavos ?? 0),
          nota: d.margem_pct === null || d.margem_pct === undefined ? 'Sem receita na competência' : `Margem de ${porcento(d.margem_pct)}`,
          notaTipo: (d.resultado_centavos ?? 0) < 0 ? 'erro' : 'ok', ic: 'painel' })),
      el('div', { class: 'grade meio-a-meio' },
        el('div', {}, painel('Conferência com o financeiro', dl([
          ['Lançamentos na competência', numero(r.lancamentos)],
          ['Contas no plano', numero(r.contas)],
          ['Contabilização automática', r.automatica ? etq('Ligada', 'ok') : etq('Desligada', 'neutra')],
          ['Fatos pendentes', r.pendentes ? etq(`${numero(r.pendentes)} sem lançamento`, 'erro') : etq('Nenhum', 'ok')],
          ['Balancete', r.balancete_fecha ? etq('Fecha', 'ok') : etq('Não fecha', 'erro')],
          ['Competência', r.fechada ? etq('Fechada', 'neutra') : etq('Aberta', 'info')],
        ]), {
          acoes: [
            pode('contabil.lancar') && r.pendentes ? botao('Contabilizar pendentes', () => contabilizar(recarregar), { ic: 'atualizar' }) : null,
            pode('contabil.ver') ? botao('Ver pendências', () => verPendencias(), { tipo: 'secundario', ic: 'busca' }) : null,
          ],
        })),
        el('div', {}, painel('Fechamento', [
          el('p', { class: 'fraco' }, 'Fechar carimba a competência: depois disso, nem lançamento novo nem estorno entram nela. '
            + 'É o que impede o balancete entregue ao contador de mudar depois de entregue.'),
          el('div', { class: 'form-acoes', style: 'justify-content:flex-start;margin-top:12px' },
            pode('contabil.fechar') && !r.fechada ? botao(`Fechar ${comp}`, () => fechar(comp, recarregar), { ic: 'cadeado' }) : null,
            pode('contabil.reabrir') && r.fechada ? botao('Reabrir', () => reabrir(comp, recarregar), { tipo: 'perigo' }) : null),
          el('div', { style: 'margin-top:16px' }, carregando('Fechamentos anteriores…')),
        ]))),
    ];
  });
}

const criarPadrao = async (recarregar) => {
  if (!await confirmar('Criar plano de contas padrão',
    'Cria um plano para provedor de internet, com ativo, passivo, receitas e despesas, e já aponta as contas que o sistema usa '
    + 'para contabilizar sozinho. É um ponto de partida: renomeie, desative ou crie contas antes do primeiro lançamento.', 'Criar')) return;
  const r = await api.post('/contabil/plano/padrao', {});
  toast(`${r.contas} contas criadas e ${r.mapeadas} mapeadas.`);
  recarregar();
};

async function contabilizar(recarregar) {
  const r = await api.post('/contabil/pendencias/contabilizar', {});
  toast(`${r.faturas} fatura(s) e ${r.pagamentos} baixa(s) contabilizadas. Restam ${r.restantes}.`);
  for (const e of r.erros ?? []) toast(`${e.tipo} ${e.numero ?? e.fatura}: ${e.erro}`, true);
  recarregar();
}

const verPendencias = async () => {
  const p = await api.get('/contabil/pendencias');
  return modal('Fatos do financeiro sem lançamento', [
    p.total
      ? faixa(`${numero(p.total)}${p.pode_haver_mais ? '+' : ''} fato(s) pendentes. O balancete não está completo enquanto houver qualquer um aqui.`, 'aviso', 'alerta')
      : faixa('Nada pendente: tudo o que o financeiro registrou tem lançamento contábil.', 'ok', 'ok'),
    p.contas_faltando.length ? faixa(`Contas ainda não mapeadas: ${p.contas_faltando.map((k) => ROTULO_CHAVE[k] ?? k).join(', ')}.`, 'erro', 'alerta') : null,
    p.faturas.length ? painel('Faturas', tabela([
      { titulo: 'Fatura', valor: (f) => `#${f.numero}` },
      { titulo: 'Assinante', valor: (f) => f.assinante_nome },
      { titulo: 'Competência', valor: (f) => f.competencia ?? 'avulsa' },
      { titulo: 'Valor', valor: (f) => dinheiro(f.valor_centavos), classe: 'num' },
    ], p.faturas.slice(0, 50)), { semCorpo: true }) : null,
    p.pagamentos.length ? painel('Baixas', tabela([
      { titulo: 'Fatura', valor: (x) => `#${x.fatura_numero}` },
      { titulo: 'Data', valor: (x) => data(x.data) },
      { titulo: 'Valor', valor: (x) => dinheiro(x.valor_centavos), classe: 'num' },
    ], p.pagamentos.slice(0, 50)), { semCorpo: true }) : null,
  ], { largo: true });
};

const fechar = (comp, recarregar) => formulario(`Fechar a competência ${comp}`, [
  { nome: 'observacoes', rotulo: 'Observações', tipo: 'textarea', inteiro: true, ajuda: 'Fica no registro do fechamento.' },
], {
  rotuloEnviar: 'Fechar',
  enviar: async (d) => {
    const r = await api.post('/contabil/fechamentos', { competencia: comp, ...d });
    toast(`Competência ${comp} fechada com ${r.lancamentos} lançamento(s).`);
    if (r.aviso) toast(r.aviso, true);
    recarregar();
  },
});

const reabrir = (comp, recarregar) => pedirMotivo(`Reabrir a competência ${comp}`, 'Motivo da reabertura', async (motivo) => {
  const r = await api.post(`/contabil/fechamentos/${comp}/reabrir`, { motivo });
  toast(r.aviso);
  recarregar();
}, { rotuloEnviar: 'Reabrir', ajuda: 'Se o balancete já foi entregue ao contador, avise-o: o que ele recebeu pode mudar.' });

/* ---------------- Balancete ---------------- */

function telaBalancete(corpo, comp, ir) {
  return carregar(corpo, () => api.get(`/contabil/balancete${qs({ de: comp, ate: comp })}`), (b) => [
    seletorCompetencia(comp, ir, 'balancete'),
    b.fecha
      ? faixa(`Balancete de ${comp} fecha: débitos e créditos somam ${dinheiro(b.total_debito_centavos)}.`, 'ok', 'ok')
      : faixa(`O balancete NÃO fecha: diferença de ${dinheiro(b.diferenca_centavos)}. Não entregue assim.`, 'erro', 'alerta'),
    b.fechada ? faixa('Competência fechada.', 'info', 'cadeado') : null,
    painel(null, tabela([
      { titulo: 'Conta', valor: (c) => el('div', { style: `padding-left:${(c.nivel - 1) * 14}px` },
        el('span', { class: c.analitica ? '' : 'forte' }, `${c.codigo} ${c.nome}`)) },
      { titulo: 'Saldo anterior', valor: (c) => dinheiro(c.saldo_anterior_centavos), classe: 'num' },
      { titulo: 'Débito', valor: (c) => (c.debito ? dinheiro(c.debito) : el('span', { class: 'fraco' }, '—')), classe: 'num' },
      { titulo: 'Crédito', valor: (c) => (c.credito ? dinheiro(c.credito) : el('span', { class: 'fraco' }, '—')), classe: 'num' },
      { titulo: 'Saldo', valor: (c) => el('span', { class: c.analitica ? '' : 'forte' }, dinheiro(c.saldo_centavos)), classe: 'num' },
      { titulo: '', valor: (c) => (c.analitica ? botao('Razão', () => verRazao(c, comp), { tipo: 'secundario pequeno' }) : ''), classe: 'acoes-celula' },
    ], b.linhas, { vazioTexto: 'Nenhum lançamento nesta competência.' }), {
      semCorpo: Boolean(b.linhas.length),
      acoes: [botao('Baixar CSV', () => baixar(`/contabil/balancete/csv${qs({ de: comp, ate: comp })}`, `balancete-${comp}.csv`), { tipo: 'secundario', ic: 'baixar' })],
    }),
  ]);
}

async function verRazao(conta, comp) {
  const r = await api.get(`/contabil/razao/${conta.id}${qs({ de: comp, ate: comp })}`);
  return modal(`Razão · ${r.conta.codigo} ${r.conta.nome}`, [
    dl([['Saldo anterior', dinheiro(r.saldo_anterior_centavos)], ['Saldo final', dinheiro(r.saldo_centavos)], ['Natureza', r.conta.natureza]]),
    tabela([
      { titulo: 'Data', valor: (l) => data(l.data) },
      { titulo: 'Lançamento', valor: (l) => el('div', {}, el('div', {}, `#${l.numero}`), el('div', { class: 'fraco' }, l.historico)) },
      { titulo: 'Débito', valor: (l) => (l.tipo === 'D' ? dinheiro(l.valor_centavos) : ''), classe: 'num' },
      { titulo: 'Crédito', valor: (l) => (l.tipo === 'C' ? dinheiro(l.valor_centavos) : ''), classe: 'num' },
      { titulo: 'Saldo', valor: (l) => dinheiro(l.saldo_centavos), classe: 'num' },
    ], r.linhas, { vazioTexto: 'Sem movimento no período.' }),
  ], { largo: true });
}

/* ---------------- DRE ---------------- */

function telaDre(corpo, comp, ir) {
  const linha = (rotuloTexto, valor, { forte = false, negativo = false } = {}) =>
    el('div', { class: `linha-dre${forte ? ' forte' : ''}` }, el('span', {}, rotuloTexto),
      el('strong', { class: negativo ? 'erro' : '' }, dinheiro(valor)));
  return carregar(corpo, () => api.get(`/contabil/dre${qs({ de: comp, ate: comp })}`), (d) => [
    seletorCompetencia(comp, ir, 'dre'),
    d.fechada ? faixa('Competência fechada: este resultado não muda mais.', 'info', 'cadeado') : null,
    el('div', { class: 'grade meio-a-meio' },
      el('div', {}, painel(`Resultado de ${comp}`, [
        linha('Receita de serviços', d.receita_servicos_centavos),
        linha('Outras receitas', d.outras_receitas_centavos),
        linha('(−) Deduções e descontos', d.deducoes_centavos, { negativo: Boolean(d.deducoes_centavos) }),
        linha('= Receita líquida', d.receita_liquida_centavos, { forte: true }),
        linha('(−) Custo do serviço prestado', d.custo_servico_centavos, { negativo: Boolean(d.custo_servico_centavos) }),
        linha('= Lucro bruto', d.lucro_bruto_centavos, { forte: true }),
        linha('(−) Despesas operacionais', d.despesas_centavos, { negativo: Boolean(d.despesas_centavos) }),
        linha('= Resultado do período', d.resultado_centavos, { forte: true, negativo: d.resultado_centavos < 0 }),
        d.margem_pct === null
          ? el('p', { class: 'fraco' }, 'Sem receita na competência: não há margem a calcular.')
          : el('p', { class: 'fraco' }, `Margem de ${porcento(d.margem_pct)} sobre a receita líquida.`),
      ])),
      // Um painel com três seções, e não três painéis: três molduras empilhadas ficavam bem mais altas
      // que o resultado ao lado, e a comparação entre as duas colunas é justamente o que se quer aqui.
      el('div', {}, painel('Detalhe por conta', [
        secao('Receitas', d.detalhe.receitas),
        secao('Custos', d.detalhe.custos),
        secao('Despesas', d.detalhe.despesas),
      ]))),
  ]);
}

const secao = (titulo, itens) => el('div', { class: 'secao-detalhe' },
  el('h3', {}, titulo, el('span', { class: 'fraco' }, itens.length ? `${itens.length} conta(s)` : '')),
  detalhe(itens));

const detalhe = (itens) => (itens.length
  ? el('ul', { class: 'linha-tempo' }, itens.map((i) => el('li', {}, `${i.codigo} ${i.nome}`, el('small', {}, dinheiro(i.valor_centavos)))))
  : el('p', { class: 'fraco' }, 'Nada nesta competência.'));

/* ---------------- Lançamentos ---------------- */

function telaLancamentos(corpo, query, ir, recarregar) {
  const filtro = { competencia: query.competencia ?? competenciaAtual(), origem: query.origem ?? '', busca: query.busca ?? '', pagina: 1 };
  const lista = el('div');
  const buscar = () => carregar(lista, () => api.get(`/contabil/lancamentos${qs(filtro)}`), desenhar);
  const desenhar = (l) => tabela([
    { titulo: 'Nº', valor: (x) => el('div', {}, el('div', { class: 'forte' }, `#${x.numero}`), el('div', { class: 'fraco' }, data(x.data))) },
    { titulo: 'Histórico', valor: (x) => el('div', {}, el('div', {}, x.historico),
      el('div', { class: 'fraco' }, [rotulo('origemLancamento', x.origem), x.criado_por_nome].filter(Boolean).join(' · '))) },
    { titulo: 'Partidas', valor: (x) => el('ul', { class: 'partidas' }, x.partidas.map((p) => el('li', {},
      el('span', { class: p.tipo === 'D' ? 'tipo-d' : 'tipo-c' }, p.tipo), ` ${p.codigo} ${p.conta_nome}`,
      el('b', {}, dinheiro(p.valor_centavos))))) },
    { titulo: 'Valor', valor: (x) => dinheiro(x.valor_centavos), classe: 'num' },
    { titulo: 'Situação', valor: (x) => (x.estornado_por_id ? etq('Estornado', 'neutra') : x.estorna_id ? etq('É um estorno', 'info') : etq('Em vigor', 'ok')) },
    { titulo: '', valor: (x) => (pode('contabil.lancar') && !x.estornado_por_id && !x.estorna_id
      ? botao('Estornar', () => estornarLancamento(x, recarregar), { tipo: 'secundario pequeno' }) : ''), classe: 'acoes-celula' },
  ], l.itens, { vazioTexto: 'Nenhum lançamento com esses filtros.', pagina: paginacao(l, (p) => { filtro.pagina = p; buscar(); }) });

  limpar(corpo, el('div', { class: 'filtros' },
    el('input', { type: 'month', value: filtro.competencia, 'aria-label': 'Competência', onchange: (e) => { filtro.competencia = e.target.value; filtro.pagina = 1; buscar(); } }),
    el('select', { 'aria-label': 'Origem', onchange: (e) => { filtro.origem = e.target.value; filtro.pagina = 1; buscar(); } },
      el('option', { value: '' }, 'Todas as origens'),
      opcoes('origemLancamento').map(([v, r]) => el('option', { value: v, selected: filtro.origem === v }, r))),
    el('input', { type: 'search', class: 'busca', placeholder: 'Buscar no histórico', value: filtro.busca, 'aria-label': 'Buscar',
      onchange: (e) => { filtro.busca = e.target.value; filtro.pagina = 1; buscar(); } })), lista);
  buscar();
  void ir;
}

const estornarLancamento = (l, recarregar) => pedirMotivo(`Estornar o lançamento #${l.numero}`, 'Motivo do estorno', async (motivo) => {
  const r = await api.post(`/contabil/lancamentos/${l.id}/estornar`, { motivo });
  toast(r.aviso);
  recarregar();
}, { rotuloEnviar: 'Estornar', ajuda: 'O lançamento original continua no histórico, marcado como estornado. Em contabilidade nada é apagado.' });

async function novoLancamento(recarregar) {
  const plano = await api.get('/contabil/plano');
  const analiticas = plano.contas.filter((c) => c.analitica && c.ativa);
  if (!analiticas.length) return toast('Crie o plano de contas antes de lançar.', true);

  const linhas = el('div', { class: 'partidas-form' });
  const total = el('p', { class: 'fraco' });
  const somar = () => {
    let d = 0;
    let c = 0;
    for (const linha of linhas.children) {
      const valor = Math.round(Number(String(linha.querySelector('.valor').value).replace(/\./g, '').replace(',', '.')) * 100) || 0;
      if (linha.querySelector('.tipo').value === 'D') d += valor; else c += valor;
    }
    const fecha = d === c && d > 0;
    total.textContent = `Débitos ${dinheiro(d)} · Créditos ${dinheiro(c)}${fecha ? ' · fecha' : ` · diferença de ${dinheiro(Math.abs(d - c))}`}`;
    total.className = fecha ? 'ok' : 'erro';
  };
  const novaLinha = (tipo = 'D') => {
    const linha = el('div', { class: 'partida-linha' },
      el('select', { class: 'tipo', 'aria-label': 'Débito ou crédito', onchange: somar },
        el('option', { value: 'D', selected: tipo === 'D' }, 'Débito'), el('option', { value: 'C', selected: tipo === 'C' }, 'Crédito')),
      el('select', { class: 'conta', 'aria-label': 'Conta' }, analiticas.map((c) => el('option', { value: c.id }, `${c.codigo} ${c.nome}`))),
      el('input', { class: 'valor', type: 'text', inputmode: 'decimal', placeholder: '0,00', 'aria-label': 'Valor', oninput: somar }),
      el('button', { type: 'button', class: 'botao-icone', 'aria-label': 'Remover partida', onclick: () => { linha.remove(); somar(); } }, '×'));
    linhas.append(linha);
    somar();
  };
  novaLinha('D');
  novaLinha('C');

  return formulario('Novo lançamento', [
    { nome: 'data', rotulo: 'Data', tipo: 'date', obrigatorio: true, valor: hoje() },
    { nome: 'historico', rotulo: 'Histórico', obrigatorio: true, inteiro: true, ajuda: 'É por ele que alguém entende o que aconteceu, meses depois.' },
  ], {
    largo: true,
    rotuloEnviar: 'Lançar',
    antes: el('div', {}, el('p', { class: 'forte', style: 'margin-bottom:8px' }, 'Partidas'), linhas,
      el('div', { class: 'form-acoes', style: 'justify-content:flex-start;margin:10px 0' },
        botao('Mais uma partida', () => novaLinha('D'), { tipo: 'secundario pequeno', ic: 'mais' })), total),
    enviar: async (d) => {
      const partidas = [...linhas.children].map((linha) => ({
        conta_id: Number(linha.querySelector('.conta').value),
        tipo: linha.querySelector('.tipo').value,
        valor: linha.querySelector('.valor').value,
      })).filter((p) => p.valor);
      const r = await api.post('/contabil/lancamentos', { ...d, partidas });
      toast(`Lançamento #${r.numero} gravado.`);
      recarregar();
    },
  });
}

/* ---------------- Orçado × realizado ---------------- */

function telaOrcamento(corpo, comp, ir, recarregar) {
  return carregar(corpo, () => api.get(`/contabil/orcamento${qs({ de: comp, ate: comp })}`), (o) => [
    seletorCompetencia(comp, ir, 'orcamento'),
    o.sem_orcamento
      ? faixa(`${numero(o.sem_orcamento)} conta(s) com movimento e sem valor orçado. Sem o orçado, o realizado é um número sem régua.`, 'aviso', 'info')
      : null,
    el('div', { class: 'stats' },
      stat({ rotulo: 'Orçado', valor: dinheiro(o.orcado_centavos), nota: `Competência ${comp}`, ic: 'painel' }),
      stat({ rotulo: 'Realizado', valor: dinheiro(o.realizado_centavos), nota: 'O que a contabilidade registrou', ic: 'recibo' }),
      stat({ rotulo: 'Diferença', valor: dinheiro(o.realizado_centavos - o.orcado_centavos),
        notaTipo: o.realizado_centavos > o.orcado_centavos ? 'aviso' : 'ok', ic: 'alerta' })),
    painel(null, tabela([
      { titulo: 'Conta', valor: (i) => el('span', { class: i.analitica ? '' : 'forte' }, `${i.codigo} ${i.nome}`) },
      { titulo: 'Orçado', valor: (i) => (i.orcado_centavos ? dinheiro(i.orcado_centavos) : el('span', { class: 'fraco' }, 'não orçado')), classe: 'num' },
      { titulo: 'Realizado', valor: (i) => dinheiro(i.realizado_centavos), classe: 'num' },
      { titulo: 'Diferença', valor: (i) => el('span', { class: i.desfavoravel ? 'erro' : '' }, dinheiro(i.diferenca_centavos)), classe: 'num' },
      { titulo: '% do orçado', valor: (i) => (i.pct === null ? el('span', { class: 'fraco' }, '—') : porcento(i.pct)), classe: 'num' },
    ], o.itens, { vazioTexto: 'Nada orçado nem realizado nesta competência.' }), {
      semCorpo: Boolean(o.itens.length),
      acoes: [pode('contabil.lancar') ? botao('Definir orçamento', () => definirOrcamento(comp, recarregar), { ic: 'mais' }) : null],
      rodape: el('span', { class: 'fraco' }, 'Em vermelho: receita abaixo do previsto ou despesa acima dele.'),
    }),
  ]);
}

async function definirOrcamento(comp, recarregar) {
  const plano = await api.get('/contabil/plano');
  const contas = plano.contas.filter((c) => c.analitica && c.ativa && c.resultado);
  return formulario(`Orçamento de ${comp}`, [
    { nome: 'conta_id', rotulo: 'Conta', tipo: 'select', obrigatorio: true, opcoes: contas.map((c) => [c.id, `${c.codigo} ${c.nome}`]) },
    { nome: 'valor', rotulo: 'Valor previsto', obrigatorio: true, ajuda: 'O que se espera desta conta na competência.' },
    { nome: 'observacoes', rotulo: 'Observações' },
  ], {
    rotuloEnviar: 'Gravar',
    enviar: async (d) => {
      await api.put('/contabil/orcamento', { itens: [{ ...d, competencia: comp }] });
      toast('Orçamento gravado.');
      recarregar();
    },
  });
}

/* ---------------- Certificado digital ---------------- */

/*
 * O certificado é a identidade da empresa em forma de arquivo: com ele se assina declaração, guia e nota
 * fiscal. Por isso a tela mostra só o que o próprio certificado diz de si — nada é digitado — e avisa
 * com antecedência do vencimento: certificado vencido trava tudo de uma vez.
 */
function telaCertificado(corpo, recarregar) {
  return carregar(corpo, () => api.get('/certificado'), (d) => {
    const c = d.certificado;
    const s = d.situacao;
    const cor = { ausente: 'neutra', valido: 'ok', vencendo: 'aviso', vencido: 'erro', futuro: 'info' }[s.estado];
    return [
      s.estado === 'vencido' ? faixa(s.texto, 'erro', 'alerta')
        : s.estado === 'vencendo' ? faixa(s.texto, 'aviso', 'alerta')
          : s.estado === 'ausente' ? faixa('Sem certificado, nenhuma obrigação pode ser assinada em nome da empresa.', 'aviso', 'info')
            : faixa(s.texto, 'ok', 'ok'),
      el('div', { class: 'grade meio-a-meio' },
        el('div', {}, painel('Certificado instalado', c
          ? dl([
            ['Apelido', c.apelido],
            ['Titular', c.titular ?? '—'],
            ['CNPJ', c.documento ? documento(c.documento) : el('span', { class: 'fraco' }, 'não consta no certificado')],
            ['Emissor', c.emissor ?? '—'],
            ['Tipo', `${c.tipo} (arquivo)`],
            ['Válido de', data(c.valido_de)],
            ['Válido até', el('span', {}, data(c.valido_ate), ' ', etq(s.dias >= 0 ? `${s.dias} dia(s)` : 'vencido', cor))],
            ['Série', el('span', { class: 'mono miudo' }, c.serie ?? '—')],
            ['Impressão digital', el('span', { class: 'mono miudo quebra' }, c.impressao)],
            ['Instalado em', `${dataHora(c.enviado_em)}${c.enviado_por_nome ? ` por ${c.enviado_por_nome}` : ''}`],
            ['Último uso', c.ultimo_uso_em ? dataHora(c.ultimo_uso_em) : el('span', { class: 'fraco' }, 'nunca usado ainda')],
          ])
          : vazio('Nenhum certificado instalado.',
            'O e-CNPJ tipo A1 é um arquivo .pfx ou .p12 com senha, emitido por uma autoridade certificadora da ICP-Brasil.'), {
          acoes: [
            pode('integracoes.editar') ? botao(c ? 'Substituir' : 'Instalar certificado', () => instalarCertificado(recarregar), { ic: 'escudo' }) : null,
            c ? botao('Testar', () => testarCertificado(), { tipo: 'secundario', ic: 'ok' }) : null,
            c && pode('integracoes.editar') ? botao('Remover', () => removerCertificado(recarregar), { tipo: 'perigo' }) : null,
          ],
          rodape: el('span', { class: 'fraco' }, 'O arquivo e a senha ficam cifrados e nunca saem do servidor — nem nesta tela, nem na API.'),
        })),
        el('div', {}, painel('O que cada integração ainda precisa', [
          el('p', { class: 'fraco' }, 'O certificado é o primeiro requisito de todas elas, e não é o único. '
            + 'O que depende de providência nos órgãos está listado aqui para não virar surpresa.'),
          ...d.integracoes.map((i) => el('div', { class: 'bloco-integracao' },
            el('div', { class: 'forte' }, i.nome),
            el('div', { class: 'fraco' }, i.faz),
            el('ul', { class: 'lista-requisitos' }, i.exige.map((x, n) => el('li', { class: n === 0 && i.certificado_ok ? 'feito' : '' },
              n === 0 && i.certificado_ok ? '✓ ' : '', x))),
            el('div', { class: 'fraco miudo' }, i.observacao))),
        ]))),
      d.historico.length > 1 ? painel('Histórico', tabela([
        { titulo: 'Apelido', valor: (x) => x.apelido },
        { titulo: 'Titular', valor: (x) => x.titular ?? '—' },
        { titulo: 'Validade', valor: (x) => `${data(x.valido_de)} a ${data(x.valido_ate)}` },
        { titulo: 'Situação', valor: (x) => (x.ativo ? etq('Ativo', 'ok') : etq('Desativado', 'neutra')) },
        { titulo: 'Saída', valor: (x) => (x.removido_em ? el('div', {}, dataHora(x.removido_em), el('div', { class: 'fraco' }, x.motivo_remocao)) : '') },
      ], d.historico), { semCorpo: true }) : null,
    ];
  });
}

const instalarCertificado = (recarregar) => formulario('Instalar certificado digital', [
  { nome: 'apelido', rotulo: 'Apelido', obrigatorio: true, valor: `e-CNPJ ${new Date().getFullYear()}`,
    ajuda: 'Só para identificar na tela, quando houver renovação.' },
  { nome: 'arquivo', rotulo: 'Arquivo do certificado', tipo: 'file', obrigatorio: true, accept: '.pfx,.p12',
    ajuda: 'O A1 é um arquivo .pfx ou .p12. O A3 (cartão ou token) não serve aqui: a chave dele nunca sai do dispositivo.' },
  { nome: 'senha', rotulo: 'Senha do certificado', tipo: 'password', obrigatorio: true,
    ajuda: 'Fica cifrada no servidor e nunca é mostrada de volta.' },
], {
  rotuloEnviar: 'Instalar',
  enviar: async (d) => {
    const arquivo = d.arquivo;
    if (!arquivo) throw new Error('Escolha o arquivo do certificado.');
    const base64 = await new Promise((resolve, reject) => {
      const leitor = new FileReader();
      leitor.onload = () => resolve(String(leitor.result).split(',')[1]);
      leitor.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
      leitor.readAsDataURL(arquivo);
    });
    const r = await api.post('/certificado', { apelido: d.apelido, senha: d.senha, arquivo: base64 });
    toast(`Certificado de ${r.titular ?? 'titular não identificado'} instalado. ${r.situacao.texto}`);
    if (r.aviso) toast(r.aviso, true);
    recarregar();
  },
});

async function testarCertificado() {
  const r = await api.post('/certificado/testar', {});
  toast(r.confere ? `Certificado abre normalmente. ${r.texto}` : r.aviso, !r.confere);
}

const removerCertificado = (recarregar) => pedirMotivo('Remover o certificado', 'Motivo da remoção', async (motivo) => {
  const r = await api.remover('/certificado', { motivo });
  toast(r.aviso ?? 'Certificado removido.', true);
  recarregar();
}, { rotuloEnviar: 'Remover', ajuda: 'O certificado sai de uso, mas continua no histórico com a data e o motivo.' });

/* ---------------- Plano de contas ---------------- */

function telaPlano(corpo, recarregar) {
  return carregar(corpo, () => api.get('/contabil/plano'), (p) => {
    if (!p.contas.length) {
      return vazio('Sem plano de contas.', 'O plano padrão para provedor é um bom ponto de partida.',
        pode('contabil.plano') ? botao('Criar plano padrão', () => criarPadrao(recarregar), { ic: 'camadas' }) : null);
    }
    const faltando = p.chaves_obrigatorias.filter((k) => !p.mapa[k]);
    return [
      faltando.length
        ? faixa(`Falta apontar a conta de: ${faltando.map((k) => ROTULO_CHAVE[k] ?? k).join(', ')}. Sem isso o sistema não contabiliza sozinho.`, 'aviso', 'alerta')
        : faixa(p.automatica ? 'Mapa completo e contabilização automática ligada.' : 'Mapa completo. A contabilização automática está desligada.',
          p.automatica ? '' : 'aviso', p.automatica ? 'ok' : 'info'),
      el('div', { class: 'grade plano-mapa' },
        el('div', {}, painel('Contas', tabela([
          { titulo: 'Conta', valor: (c) => el('div', { style: `padding-left:${(c.nivel - 1) * 14}px` },
            el('span', { class: c.analitica ? '' : 'forte' }, `${c.codigo} ${c.nome}`),
            c.analitica ? null : el('small', { class: 'fraco' }, ' (totaliza as filhas)')) },
          { titulo: 'Tipo', valor: (c) => rotulo('tipoConta', c.tipo) },
          { titulo: 'Natureza', valor: (c) => (c.natureza === 'devedora' ? 'Devedora' : 'Credora') },
          { titulo: 'Situação', valor: (c) => (c.ativa ? etq('Ativa', 'ok') : etq('Inativa', 'neutra')) },
          { titulo: '', valor: (c) => (pode('contabil.plano')
            ? botao('Editar', () => editarConta(c, recarregar), { tipo: 'secundario pequeno' }) : ''), classe: 'acoes-celula' },
        ], p.contas, { vazioTexto: 'Nenhuma conta.' }), {
          semCorpo: true,
          acoes: [pode('contabil.plano') ? botao('Nova conta', () => novaConta(p, recarregar), { ic: 'mais' }) : null],
        })),
        el('div', {}, painel('Para onde vai cada fato', [
          el('p', { class: 'fraco' }, 'É este mapa que permite contabilizar sozinho. Sem ele, o sistema teria de adivinhar — '
            + 'e adivinhar em contabilidade é inventar.'),
          dl(p.chaves_obrigatorias.map((k) => {
            const c = p.contas.find((x) => x.id === p.mapa[k]);
            return [ROTULO_CHAVE[k] ?? k, c ? `${c.codigo} ${c.nome}` : etq('não definida', 'erro')];
          })),
          el('div', { class: 'form-acoes', style: 'justify-content:flex-start;margin-top:12px' },
            pode('contabil.plano') ? botao('Editar o mapa', () => editarMapa(p, recarregar), { tipo: 'secundario', ic: 'config' }) : null,
            pode('contabil.plano') ? botao(p.automatica ? 'Desligar automática' : 'Ligar automática',
              () => alternarAutomatica(!p.automatica, recarregar), { tipo: p.automatica ? 'perigo' : '', ic: 'atualizar' }) : null),
        ]))),
    ];
  });
}

const novaConta = (p, recarregar) => formulario('Nova conta contábil', [
  { nome: 'codigo', rotulo: 'Código', obrigatorio: true, ajuda: 'Hierárquico, com pontos: 5.3.05. A conta mãe precisa existir antes.' },
  { nome: 'nome', rotulo: 'Nome', obrigatorio: true },
  { nome: 'tipo', rotulo: 'Tipo', tipo: 'select', obrigatorio: true, opcoes: TIPOS },
  { nome: 'observacoes', rotulo: 'Observações' },
], {
  enviar: async (d) => {
    await api.post('/contabil/plano', d);
    toast('Conta criada.');
    recarregar();
  },
});

const editarConta = (c, recarregar) => formulario(`Conta ${c.codigo}`, [
  { nome: 'nome', rotulo: 'Nome', obrigatorio: true, valor: c.nome },
  { nome: 'ativa', rotulo: 'Conta ativa', tipo: 'checkbox', valor: Boolean(c.ativa),
    ajuda: c.tem_lancamento ? 'Esta conta já tem lançamentos: desativar só é possível se o saldo for zero.' : null },
  { nome: 'observacoes', rotulo: 'Observações', valor: c.observacoes },
], {
  enviar: async (d) => {
    await api.patch(`/contabil/plano/${c.id}`, { ...d, versao: c.versao });
    toast('Conta atualizada.');
    recarregar();
  },
});

const editarMapa = (p, recarregar) => formulario('Para onde vai cada fato', p.chaves_obrigatorias.map((k) => ({
  nome: k, rotulo: ROTULO_CHAVE[k] ?? k, tipo: 'select', obrigatorio: true, valor: p.mapa[k],
  opcoes: p.contas.filter((c) => c.analitica && c.ativa).map((c) => [c.id, `${c.codigo} ${c.nome}`]),
})), {
  largo: true,
  enviar: async (d) => {
    const r = await api.put('/contabil/plano/mapa', Object.fromEntries(Object.entries(d).map(([k, v]) => [k, Number(v)])));
    toast(r.completo ? 'Mapa completo.' : `Ainda falta: ${r.faltando.join(', ')}.`);
    recarregar();
  },
});

async function alternarAutomatica(ligar, recarregar) {
  if (ligar && !await confirmar('Ligar a contabilização automática',
    'A partir de agora, toda fatura emitida, baixa recebida, estorno e cancelamento viram lançamento contábil sozinhos. '
    + 'Os fatos anteriores continuam pendentes até você mandar contabilizá-los.', 'Ligar')) return;
  const r = await api.put('/contabil/automatica', { ligada: ligar });
  toast(ligar ? 'Contabilização automática ligada.' : 'Contabilização automática desligada.');
  if (r.aviso) toast(r.aviso, true);
  recarregar();
}


