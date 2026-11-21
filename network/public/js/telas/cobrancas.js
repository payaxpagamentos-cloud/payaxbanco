import { api, qs, baixar } from '../api.js';
import { el, limpar, pode, cabecalho, painel, tabela, paginacao, abas, etqDe, rotulo, opcoes, dinheiro, data, dataHora, dl, documento,
  numero, carregar, formulario, pedirMotivo, botao, toast, faixa, stat, vazio, modal } from '../ui.js';

/*
 * Cobrança bancária.
 *
 * A tela foi desenhada em torno de dois cuidados que custam caro quando faltam:
 *   1. Boleto com campo livre não conferido com o banco é boleto que o cliente paga e o provedor não
 *      recebe. Enquanto a conta não for marcada como conferida, o aviso aparece em toda emissão.
 *   2. Retorno do banco nunca é aplicado direto. Sobe, vira prévia, a pessoa olha, e só então aplica.
 */
export default async function cobrancas({ alvo, query, ir }) {
  const aba = query.aba ?? 'painel';
  const corpo = el('div');
  const recarregar = () => cobrancas({ alvo, query, ir });
  limpar(alvo, cabecalho({
    sobretitulo: 'Assinantes e financeiro',
    titulo: 'Cobrança bancária',
    descricao: 'PIX e boleto saem daqui sem depender de API de banco: o BR Code é gerado no sistema e o registro vai por arquivo (CNAB). '
      + 'O retorno do banco sempre passa por conferência antes de baixar qualquer fatura.',
    acoes: [
      pode('faturamento.baixar') ? botao('Enviar retorno do banco', () => enviarRetorno(ir), { ic: 'baixar' }) : null,
      pode('integracoes.editar') ? botao('Nova conta', () => editarConta(null, recarregar), { tipo: 'secundario', ic: 'mais' }) : null,
    ],
  }), abas([['painel', 'Painel'], ['emitidas', 'Cobranças emitidas'], ['remessas', 'Remessas'], ['retornos', 'Retornos'], ['contas', 'Contas de cobrança']],
    aba, (id) => ir(`#/bancos?aba=${id}`)), corpo);

  if (aba === 'emitidas') return listaEmitidas(corpo, query, ir);
  if (aba === 'remessas') return carregar(corpo, () => api.get('/cobrancas/remessas'), (l) => desenharRemessas(l, recarregar));
  if (aba === 'retornos') return carregar(corpo, () => api.get('/cobrancas/retornos'), (l) => desenharRetornos(l, ir));
  if (aba === 'contas') return carregar(corpo, () => api.get('/cobrancas/contas'), (l) => desenharContas(l, recarregar));
  return carregar(corpo, () => Promise.all([api.get('/cobrancas/resumo'), api.get('/cobrancas/bancos')]), ([r, b]) => desenharPainel(r, b.adaptadores));
}

// ---------------- Painel ----------------
function desenharPainel(r, adaptadores) {
  const porTipo = (tipo, situacoes) => r.por_situacao.filter((x) => x.tipo === tipo && situacoes.includes(x.situacao)).reduce((s, x) => s + x.n, 0);
  const avisos = [];
  if (!r.contas) {
    avisos.push(faixa('Nenhuma conta de cobrança cadastrada ainda. Sem conta, o sistema não emite PIX nem boleto — cadastre a conta na aba "Contas de cobrança".', 'aviso'));
  }
  if (r.contas_sem_layout_validado) {
    avisos.push(faixa(`${numero(r.contas_sem_layout_validado)} conta(s) emitem boleto com um campo livre que nunca foi conferido com o banco. `
      + 'Pague um boleto de teste, confirme com o gerente e marque a conta como conferida antes de usar em produção.', 'aviso', 'alerta'));
  }
  if (r.retornos_conferindo) {
    avisos.push(faixa(`${numero(r.retornos_conferindo)} arquivo(s) de retorno aguardando conferência. Nenhuma fatura foi baixada por eles ainda.`, 'info'));
  }
  return [
    ...avisos,
    el('div', { class: 'stats' },
      stat({ rotulo: 'Aguardando remessa', valor: numero(r.aguardando_remessa), nota: r.aguardando_remessa ? 'Boletos emitidos que o banco ainda não recebeu' : 'Nada pendente de envio',
        notaTipo: r.aguardando_remessa ? 'aviso' : 'ok', ic: 'arquivo', semDado: !r.aguardando_remessa }),
      stat({ rotulo: 'Registradas no banco', valor: numero(porTipo('boleto', ['registrada'])), nota: 'Boletos que o banco confirmou pelo retorno', ic: 'ok' }),
      stat({ rotulo: 'PIX em aberto', valor: numero(porTipo('pix', ['emitida', 'registrada'])), nota: 'BR Codes gerados e ainda não quitados', ic: 'dinheiro' }),
      stat({ rotulo: 'Faturas sem meio de pagamento', valor: numero(r.sem_cobranca), nota: r.sem_cobranca ? 'O assinante não tem como pagar essas faturas' : 'Toda fatura em aberto tem PIX ou boleto',
        notaTipo: r.sem_cobranca ? 'erro' : 'ok', ic: 'alerta', semDado: !r.sem_cobranca })),
    el('div', { class: 'grade principal-lateral' },
      el('div', {},
        painel('Situação das cobranças', r.por_situacao.length
          ? tabela([
            { titulo: 'Meio', valor: (x) => rotulo('tipoCobranca', x.tipo) },
            { titulo: 'Situação', valor: (x) => etqDe('situacaoCobranca', x.situacao) },
            { titulo: 'Quantidade', valor: (x) => numero(x.n), classe: 'num' },
            { titulo: 'Valor', valor: (x) => dinheiro(x.v), classe: 'num' },
          ], r.por_situacao, { vazioTexto: 'Nenhuma cobrança emitida.' })
          : vazio('Nenhuma cobrança emitida ainda.', 'Emita o PIX ou o boleto a partir da fatura, na tela de Faturamento ou na ficha do assinante.'), { semCorpo: r.por_situacao.length > 0 })),
      el('div', {},
        painel('Prazo médio de recebimento', r.prazo_medio_dias === null
          ? vazio('Ainda sem baixas suficientes.', 'O prazo aparece depois das primeiras faturas quitadas.')
          : dl([['Da emissão até o pagamento', `${numero(r.prazo_medio_dias, 1)} dia(s)`], ['Base', 'Últimos 6 meses'], ['Hoje', data(r.hoje)]])),
        // Dito sem rodeios: hoje não há banco conectado por API, e o que funciona sem isso.
        painel('API dos bancos e PayAx', adaptadores.disponivel
          ? tabela([
            { titulo: 'Instituição', valor: (a) => a.rotulo },
            { titulo: 'Faz', valor: (a) => a.capacidades.join(', ') },
          ], adaptadores.itens)
          : vazio('Nenhuma API bancária conectada.', adaptadores.explicacao)))),
  ];
}

// ---------------- Cobranças emitidas ----------------
function listaEmitidas(corpo, query, ir) {
  const filtro = { situacao: query.situacao ?? '', tipo: query.tipo ?? '', pagina: 1 };
  const lista = el('div');
  const sel = (nome, vazioTexto, mapa) => el('select', { 'aria-label': vazioTexto, onchange: (e) => { filtro[nome] = e.target.value; filtro.pagina = 1; buscar(); } },
    el('option', { value: '' }, vazioTexto), opcoes(mapa).map(([v, r]) => el('option', { value: v, selected: filtro[nome] === v }, r)));
  const buscar = () => carregar(lista, () => api.get(`/cobrancas${qs(filtro)}`), desenhar);
  const desenhar = (l) => tabela([
    { titulo: 'Assinante', valor: (c) => el('div', {}, el('div', { class: 'forte' }, c.assinante_nome), el('div', { class: 'fraco' }, `Fatura #${c.fatura_numero} · ${c.conta_nome}`)) },
    { titulo: 'Meio', valor: (c) => el('div', {}, rotulo('tipoCobranca', c.tipo),
      c.linha_formatada ? el('div', { class: 'fraco mono' }, c.linha_formatada) : c.pix_txid ? el('div', { class: 'fraco mono' }, c.pix_txid) : null) },
    { titulo: 'Vencimento', valor: (c) => data(c.vencimento) },
    { titulo: 'Valor', valor: (c) => dinheiro(c.valor_centavos), classe: 'num' },
    { titulo: 'Situação', valor: (c) => el('div', {}, etqDe('situacaoCobranca', c.situacao),
      c.pago_em ? el('div', { class: 'fraco' }, `Pago em ${data(c.pago_em)}`) : c.motivo_rejeicao ? el('div', { class: 'fraco erro' }, c.motivo_rejeicao) : null) },
    { titulo: '', valor: (c) => botao('Ver', () => verCobranca(c), { tipo: 'secundario', ic: 'recibo' }), classe: 'acoes-celula' },
  ], l.itens, { vazioTexto: 'Nenhuma cobrança com esses filtros.', pagina: paginacao(l, (p) => { filtro.pagina = p; buscar(); }) });

  limpar(corpo, el('div', { class: 'filtros' }, sel('tipo', 'Todos os meios', 'tipoCobranca'), sel('situacao', 'Todas as situações', 'situacaoCobranca')), lista);
  buscar();
}

/** Mostra o que o assinante precisa receber: a linha digitável ou o BR Code, copiáveis. */
export function verCobranca(c) {
  const copiar = (texto, oque) => botao(`Copiar ${oque}`, async () => {
    try { await navigator.clipboard.writeText(texto); toast(`${oque[0].toUpperCase()}${oque.slice(1)} copiado.`); }
    catch { toast('O navegador não deixou copiar. Selecione o texto na tela.', true); }
  }, { tipo: 'secundario', ic: 'arquivo' });
  return modal(c.tipo === 'pix' ? 'PIX da fatura' : 'Boleto da fatura', [
    c.aviso_layout ? faixa(c.aviso_layout, 'aviso', 'alerta') : null,
    dl([
      ['Fatura', `#${c.fatura_numero ?? '—'}`],
      ['Valor', dinheiro(c.valor_centavos)],
      ['Vencimento', data(c.vencimento)],
      ['Situação', etqDe('situacaoCobranca', c.situacao)],
      c.nosso_numero ? ['Nosso número', `${c.nosso_numero}${c.nosso_numero_dv ?? ''}`] : null,
      c.pix_txid ? ['Identificador (txid)', c.pix_txid] : null,
    ]),
    c.linha_digitavel
      ? el('div', { class: 'bloco-codigo' }, el('div', { class: 'mono grande' }, c.linha_formatada ?? c.linha_digitavel),
        el('div', { class: 'fraco mono' }, c.codigo_barras), el('div', { class: 'acoes' }, copiar(c.linha_digitavel, 'linha digitável')))
      : null,
    c.pix_brcode
      ? el('div', { class: 'bloco-codigo' }, el('div', { class: 'mono quebra' }, c.pix_brcode), el('div', { class: 'acoes' }, copiar(c.pix_brcode, 'código PIX')))
      : null,
  ], { largo: true });
}

// ---------------- Remessas ----------------
function desenharRemessas(l, recarregar) {
  return painel(null, tabela([
    { titulo: 'Arquivo', valor: (r) => el('div', {}, el('div', { class: 'forte mono' }, r.arquivo),
      el('div', { class: 'fraco' }, `${r.layout.toUpperCase()} · ${r.conta_nome} · ${dataHora(r.criado_em)} · ${r.criado_por_nome ?? 'sistema'}`)) },
    { titulo: 'Títulos', valor: (r) => numero(r.titulos), classe: 'num' },
    { titulo: 'Valor', valor: (r) => dinheiro(r.valor_centavos), classe: 'num' },
    { titulo: '', valor: (r) => botao('Baixar', () => baixar(`/cobrancas/remessas/${r.id}/arquivo`, r.arquivo), { tipo: 'secundario', ic: 'baixar' }), classe: 'acoes-celula' },
  ], l.itens, {
    vazioTexto: 'Nenhuma remessa gerada.',
    pagina: paginacao(l, () => recarregar()),
  }), { semCorpo: Boolean(l.itens.length),
    acoes: [pode('faturamento.faturar') ? botao('Gerar remessa', () => gerarRemessa(recarregar), { ic: 'arquivo' }) : null],
    rodape: el('span', { class: 'fraco' }, 'A remessa leva os boletos emitidos que o banco ainda não recebeu. O arquivo fica guardado: baixar de novo não muda a numeração.') });
}

async function gerarRemessa(recarregar) {
  const contas = (await api.get('/cobrancas/contas')).filter((c) => c.emite_boleto && c.ativa);
  if (!contas.length) return toast('Nenhuma conta ativa emitindo boleto.', true);
  return formulario('Gerar remessa', [
    { nome: 'conta_id', rotulo: 'Conta', tipo: 'select', obrigatorio: true, opcoes: contas.map((c) => [c.id, `${c.nome} (${c.em_aberto} em aberto)`]),
      ajuda: 'Entram os boletos emitidos nesta conta que ainda não foram para o banco.' },
  ], {
    rotuloEnviar: 'Gerar',
    enviar: async (d) => {
      const r = await api.post('/cobrancas/remessas', { conta_id: Number(d.conta_id) });
      toast(`Remessa ${r.arquivo} gerada com ${r.titulos} título(s).`);
      if (r.aviso) toast(r.aviso, true);
      await baixar(`/cobrancas/remessas/${r.id}/arquivo`, r.arquivo);
      recarregar();
    },
  });
}

// ---------------- Retornos ----------------
function desenharRetornos(l, ir) {
  return painel(null, tabela([
    { titulo: 'Arquivo', valor: (r) => el('div', {}, el('div', { class: 'forte mono' }, r.arquivo),
      el('div', { class: 'fraco' }, `${r.layout.toUpperCase()} · banco ${r.banco ?? '—'} · ${dataHora(r.criado_em)} · ${r.criado_por_nome ?? 'sistema'}`)) },
    { titulo: 'Registros', valor: (r) => el('div', {}, numero(r.registros),
      r.nao_encontrados ? el('div', { class: 'fraco aviso' }, `${numero(r.nao_encontrados)} sem par`) : null), classe: 'num' },
    { titulo: 'Pagamentos', valor: (r) => el('div', {}, numero(r.pagamentos), el('div', { class: 'fraco' }, dinheiro(r.valor_centavos))), classe: 'num' },
    { titulo: 'Situação', valor: (r) => el('div', {}, etqDe('situacaoRetorno', r.situacao),
      r.aplicado_em ? el('div', { class: 'fraco' }, `${numero(r.aplicados)} baixa(s) em ${dataHora(r.aplicado_em)}`) : null) },
    { titulo: '', valor: (r) => botao(r.situacao === 'conferindo' ? 'Conferir' : 'Ver', () => abrirRetorno(r.id, ir), { tipo: 'secundario', ic: 'busca' }), classe: 'acoes-celula' },
  ], l.itens, { vazioTexto: 'Nenhum arquivo de retorno enviado.', pagina: paginacao(l, () => ir('#/bancos?aba=retornos')) }), {
    semCorpo: Boolean(l.itens.length),
    acoes: [pode('faturamento.baixar') ? botao('Enviar retorno', () => enviarRetorno(ir), { ic: 'baixar' }) : null],
    rodape: el('span', { class: 'fraco' }, 'O arquivo enviado é apenas lido. Nenhuma fatura é baixada antes de alguém conferir a prévia e mandar aplicar.'),
  });
}

async function enviarRetorno(ir) {
  return formulario('Enviar retorno do banco', [
    { nome: 'arquivo', rotulo: 'Arquivo de retorno', tipo: 'file', obrigatorio: true, accept: '.ret,.RET,.txt,.crt,text/plain',
      ajuda: 'CNAB 240 ou 400, como o banco entrega. O sistema lê e mostra o que faria — não aplica nada agora.' },
  ], {
    rotuloEnviar: 'Ler e conferir',
    enviar: async (d) => {
      const previa = await api.enviarRetorno(d.arquivo);
      toast(`${previa.registros} registro(s) lidos. Nada foi aplicado ainda.`);
      ir('#/bancos?aba=retornos');
      await mostrarPrevia(previa, ir);
    },
  });
}

const abrirRetorno = async (id, ir) => mostrarPrevia(await api.get(`/cobrancas/retornos/${id}`), ir);

function mostrarPrevia(p, ir) {
  const podeAplicar = p.situacao === 'conferindo' && pode('faturamento.baixar');
  return modal(`Retorno ${p.arquivo ?? ''} · ${p.layout.toUpperCase()}`, (fechar) => [
    p.situacao === 'conferindo'
      ? faixa('Nada foi aplicado ainda. Confira principalmente os VALORES ao lado de cada linha: se vierem estranhos, o mapa de posições do banco é diferente — '
        + 'descarte o arquivo e avise, em vez de aplicar.', 'aviso', 'alerta')
      : faixa(`Este arquivo já foi ${rotulo('situacaoRetorno', p.situacao).toLowerCase()}.`, 'info'),
    el('div', { class: 'stats compactas' },
      stat({ rotulo: 'Registros', valor: numero(p.registros) }),
      stat({ rotulo: 'Viram baixa', valor: numero(p.a_aplicar), notaTipo: 'ok' }),
      stat({ rotulo: 'Sem par no sistema', valor: numero(p.nao_encontrados), notaTipo: p.nao_encontrados ? 'erro' : '', semDado: !p.nao_encontrados }),
      stat({ rotulo: 'Com divergência', valor: numero(p.com_divergencia), notaTipo: p.com_divergencia ? 'aviso' : '', semDado: !p.com_divergencia })),
    tabela([
      { titulo: 'Linha', valor: (i) => el('div', {}, el('div', {}, `#${i.linha}`), el('div', { class: 'fraco mono miudo' }, i.nosso_numero ?? '—')) },
      { titulo: 'O que o banco diz', valor: (i) => el('div', {}, el('div', {}, i.ocorrencia.texto), el('div', {}, etqDe('efeitoOcorrencia', i.ocorrencia.efeito))) },
      { titulo: 'Casou com', valor: (i) => (i.cobranca_id
        ? el('div', {}, el('div', { class: 'forte' }, `Fatura #${i.fatura_numero}`), el('div', { class: 'fraco' }, `por ${i.casado_por}`))
        : el('span', { class: 'fraco erro' }, 'Nenhuma cobrança')) },
      { titulo: 'Título', valor: (i) => el('div', {}, dinheiro(i.valor_centavos), el('div', { class: 'fraco' }, data(i.vencimento))), classe: 'num' },
      { titulo: 'Pago', valor: (i) => el('div', {}, dinheiro(i.valor_pago_centavos),
        i.juros_centavos ? el('div', { class: 'fraco' }, `juros ${dinheiro(i.juros_centavos)}`) : null,
        i.data_credito ? el('div', { class: 'fraco' }, `crédito ${data(i.data_credito)}`) : null), classe: 'num' },
      { titulo: 'Observação', valor: (i) => (i.divergencias.length
        ? el('ul', { class: 'lista-aviso' }, i.divergencias.map((d) => el('li', {}, d)))
        : el('span', { class: i.aplicar ? 'ok' : 'fraco' }, i.aplicar ? 'Vira baixa ao aplicar' : 'Sem efeito no financeiro')) },
    ], p.itens, { vazioTexto: 'Nenhum registro no arquivo.' }),
    el('details', {}, el('summary', {}, 'Ver as linhas cruas do arquivo'),
      el('pre', { class: 'bruto' }, p.itens.map((i) => `#${i.linha}  ${i.bruto}`).join('\n'))),
    podeAplicar
      ? el('div', { class: 'modal-rodape' },
        botao(`Aplicar ${p.a_aplicar} baixa(s)`, async () => {
          const r = await api.post(`/cobrancas/retornos/${p.id}/aplicar`, {});
          toast(r.aviso);
          for (const e of r.erros ?? []) toast(`Linha ${e.linha}: ${e.erro}`, true);
          fechar();
          ir('#/bancos?aba=retornos');
        }, { ic: 'ok' }),
        botao('Descartar arquivo', () => pedirMotivo('Descartar o retorno', 'Por que este arquivo não deve ser aplicado?', async (motivo) => {
          await api.post(`/cobrancas/retornos/${p.id}/descartar`, { motivo });
          toast('Arquivo descartado. Nada foi alterado no financeiro.');
          fechar();
          ir('#/bancos?aba=retornos');
        }, { rotuloEnviar: 'Descartar' }), { tipo: 'secundario', ic: 'fechar' }))
      : null,
  ], { largo: true });
}

// ---------------- Contas ----------------
function desenharContas(contas, recarregar) {
  if (!contas.length) {
    return painel(null, vazio('Nenhuma conta de cobrança cadastrada.',
      'A conta guarda os dados do beneficiário, a chave PIX e, para boleto, o convênio e a carteira combinados com o banco.',
      pode('integracoes.editar') ? botao('Cadastrar a primeira conta', () => editarConta(null, recarregar), { ic: 'mais' }) : null), { semCorpo: true });
  }
  return contas.map((c) => painel(c.nome, [
    c.emite_boleto && !c.layout_validado
      ? faixa('O campo livre do código de barras desta conta nunca foi conferido com o banco. Emita um boleto, pague no caixa ou no app e confirme a compensação '
        + 'antes de usar em produção — campo livre errado produz boleto que o cliente paga e o provedor não recebe.', 'aviso', 'alerta')
      : null,
    dl([
      ['Banco', c.banco ? `${c.banco} · ${c.banco_nome ?? '—'}` : 'Sem boleto'],
      c.agencia ? ['Agência / conta', `${c.agencia}${c.agencia_dv ? `-${c.agencia_dv}` : ''} / ${c.conta ?? '—'}${c.conta_dv ? `-${c.conta_dv}` : ''}`] : null,
      c.carteira ? ['Carteira', c.carteira] : null,
      c.convenio ? ['Convênio', c.convenio] : null,
      c.codigo_beneficiario ? ['Código do beneficiário', c.codigo_beneficiario] : null,
      ['Beneficiário', `${c.beneficiario_nome} · ${documento(c.beneficiario_documento)}`],
      ['Chave PIX', c.chave_pix ? `${c.chave_pix} (${rotulo('tipoChavePix', c.chave_pix_tipo)})` : 'Sem PIX'],
      ['Emite', [c.emite_boleto ? 'Boleto' : null, c.emite_pix ? 'PIX' : null].filter(Boolean).join(' e ') || 'Nada'],
      ['Cobranças em aberto', numero(c.em_aberto)],
      ['Próximo nosso número', numero(c.proximo_nosso_numero)],
      ['Próxima remessa', numero(c.proxima_remessa)],
      ['Layout do boleto', c.layout_validado ? `Conferido em ${data(c.layout_validado_em)}` : 'Nunca conferido com o banco'],
      c.observacoes ? ['Observações', c.observacoes] : null,
    ]),
  ], {
    acoes: [
      c.padrao ? el('span', { class: 'etq ok' }, 'Padrão') : null,
      c.ativa ? null : el('span', { class: 'etq neutra' }, 'Inativa'),
      pode('integracoes.editar') ? botao('Editar', () => editarConta(c, recarregar), { tipo: 'secundario', ic: 'config' }) : null,
      pode('integracoes.editar') && c.emite_boleto && !c.layout_validado
        ? botao('Marcar layout como conferido', () => validarLayout(c, recarregar), { tipo: 'secundario', ic: 'ok' }) : null,
    ],
  }));
}

async function editarConta(c, recarregar) {
  const { bancos } = await api.get('/cobrancas/bancos');
  const atual = c ?? {};
  const naoValidados = bancos.filter((b) => !b.validado).map((b) => b.codigo);
  return formulario(c ? `Conta ${c.nome}` : 'Nova conta de cobrança', [
    { nome: 'nome', rotulo: 'Nome da conta', obrigatorio: true, valor: atual.nome, ajuda: 'Só para identificar na tela, ex.: "Itaú cobrança".' },
    { nome: 'emite_pix', rotulo: 'Emitir PIX', tipo: 'checkbox', valor: c ? Boolean(atual.emite_pix) : true },
    { nome: 'chave_pix', rotulo: 'Chave PIX', valor: atual.chave_pix, ajuda: 'A chave da conta que vai receber. Vai dentro do BR Code.' },
    { nome: 'chave_pix_tipo', rotulo: 'Tipo da chave', tipo: 'select', opcoes: opcoes('tipoChavePix'), valor: atual.chave_pix_tipo },
    { nome: 'emite_boleto', rotulo: 'Emitir boleto', tipo: 'checkbox', valor: Boolean(atual.emite_boleto) },
    { nome: 'banco', rotulo: 'Banco', tipo: 'select', opcoes: bancos.map((b) => [b.codigo, `${b.codigo} · ${b.nome}${b.validado ? '' : ' (layout a conferir)'}`]), valor: atual.banco,
      ajuda: `Os layouts marcados "a conferir" (${naoValidados.join(', ')}) montam o código de barras pelo manual do banco, mas nunca foram validados em produção aqui.` },
    { nome: 'agencia', rotulo: 'Agência', valor: atual.agencia },
    { nome: 'agencia_dv', rotulo: 'Dígito da agência', valor: atual.agencia_dv },
    { nome: 'conta', rotulo: 'Conta', valor: atual.conta },
    { nome: 'conta_dv', rotulo: 'Dígito da conta', valor: atual.conta_dv },
    { nome: 'carteira', rotulo: 'Carteira', valor: atual.carteira, ajuda: 'A carteira combinada no contrato de cobrança com o banco.' },
    { nome: 'convenio', rotulo: 'Convênio', valor: atual.convenio },
    { nome: 'codigo_beneficiario', rotulo: 'Código do beneficiário', valor: atual.codigo_beneficiario },
    { nome: 'posto', rotulo: 'Posto (Sicredi)', valor: atual.posto },
    { nome: 'modalidade', rotulo: 'Modalidade (Sicoob)', valor: atual.modalidade },
    { nome: 'beneficiario_nome', rotulo: 'Nome do beneficiário', obrigatorio: true, valor: atual.beneficiario_nome },
    { nome: 'beneficiario_documento', rotulo: 'CNPJ/CPF do beneficiário', obrigatorio: true, valor: atual.beneficiario_documento },
    { nome: 'beneficiario_endereco', rotulo: 'Endereço', valor: atual.beneficiario_endereco },
    { nome: 'beneficiario_cidade', rotulo: 'Cidade', valor: atual.beneficiario_cidade, ajuda: 'Obrigatória para PIX: vai dentro do BR Code.' },
    { nome: 'beneficiario_uf', rotulo: 'UF', valor: atual.beneficiario_uf },
    { nome: 'beneficiario_cep', rotulo: 'CEP', valor: atual.beneficiario_cep },
    { nome: 'padrao', rotulo: 'Usar como conta padrão', tipo: 'checkbox', valor: Boolean(atual.padrao) },
    { nome: 'ativa', rotulo: 'Conta ativa', tipo: 'checkbox', valor: c ? Boolean(atual.ativa) : true },
    { nome: 'observacoes', rotulo: 'Observações', tipo: 'textarea', valor: atual.observacoes },
  ], {
    largo: true,
    enviar: async (d) => {
      await (c ? api.patch(`/cobrancas/contas/${c.id}`, d) : api.post('/cobrancas/contas', d));
      toast(c ? 'Conta atualizada.' : 'Conta cadastrada.');
      recarregar();
    },
  });
}

const validarLayout = (c, recarregar) => pedirMotivo('Marcar o layout como conferido',
  'Descreva a conferência: qual boleto foi pago, quando, e quem confirmou a compensação com o banco.',
  async (confirmacao) => {
    await api.post(`/cobrancas/contas/${c.id}/validar-layout`, { confirmacao });
    toast('Layout marcado como conferido.');
    recarregar();
  }, { rotuloEnviar: 'Marcar como conferido', ajuda: 'Fica guardado no registro de auditoria, com seu nome e a data.' });

/** Emite PIX ou boleto para uma fatura. Usada também pela ficha do assinante e pelo faturamento. */
export async function emitirCobranca(fatura, aoTerminar) {
  const contas = (await api.get('/cobrancas/contas')).filter((c) => c.ativa);
  if (!contas.length) return toast('Cadastre uma conta de cobrança antes de emitir.', true);
  return formulario(`Emitir cobrança da fatura #${fatura.numero}`, [
    { nome: 'tipo', rotulo: 'Meio de pagamento', tipo: 'select', obrigatorio: true, opcoes: opcoes('tipoCobranca'), valor: 'pix' },
    { nome: 'conta_id', rotulo: 'Conta', tipo: 'select', obrigatorio: true, opcoes: contas.map((c) => [c.id, c.nome]), valor: contas.find((c) => c.padrao)?.id ?? contas[0].id },
  ], {
    rotuloEnviar: 'Emitir',
    enviar: async (d) => {
      const c = await api.post(`/cobrancas/faturas/${fatura.id}/emitir`, { tipo: d.tipo, conta_id: Number(d.conta_id) });
      toast(c.ja_existia ? 'Esta fatura já tinha essa cobrança: é a mesma de antes.' : 'Cobrança emitida.');
      await verCobranca({ ...c, fatura_numero: fatura.numero });
      aoTerminar?.();
    },
  });
}
