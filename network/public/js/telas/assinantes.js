import { api, qs, baixar } from '../api.js';
import { el, limpar, icone, pode, cabecalho, painel, tabela, paginacao, etq, etqDe, rotulo, opcoes, dinheiro, data, dataHora, dl, documento, telefone,
  competencia, velocidade, carregar, carregando, formulario, botao, toast, faixa, stat } from '../ui.js';

export default async function assinantes({ alvo, params, query, ir }) {
  if (params[0]) return detalhe(alvo, Number(params[0]), ir);
  const filtro = { busca: query.busca ?? '', situacao: '', pagina: 1 };
  const corpo = el('div');
  const busca = el('input', { type: 'search', class: 'busca', placeholder: 'Nome, CPF/CNPJ ou código', value: filtro.busca, 'aria-label': 'Buscar assinantes' });
  const situacao = el('select', { 'aria-label': 'Situação' }, el('option', { value: '' }, 'Todas as situações'),
    opcoes('situacaoAssinante').map(([v, r]) => el('option', { value: v }, r)));
  busca.addEventListener('input', () => { filtro.busca = busca.value; filtro.pagina = 1; clearTimeout(busca.t); busca.t = setTimeout(atualizar, 300); });
  situacao.addEventListener('change', () => { filtro.situacao = situacao.value; filtro.pagina = 1; atualizar(); });

  limpar(alvo, cabecalho({
    sobretitulo: 'Assinantes e financeiro',
    titulo: 'Assinantes',
    descricao: 'As pessoas e empresas atendidas. A situação do serviço é do contrato: um assinante pode ter um contrato ativo e outro bloqueado.',
    acoes: [
      pode('assinantes.ver') ? botao('Exportar CSV', () => baixar('/assinantes/csv/lista', 'assinantes.csv'), { tipo: 'secundario', ic: 'baixar' }) : null,
      pode('assinantes.editar') ? botao('Novo assinante', () => editar(null, (a) => ir(`#/assinantes/${a.id}`)), { ic: 'mais' }) : null,
    ],
  }), el('div', { class: 'filtros' }, busca, situacao), corpo);

  function atualizar() {
    return carregar(corpo, () => api.get(`/assinantes${qs(filtro)}`), (l) => painel(null, tabela([
      { titulo: 'Assinante', valor: (a) => el('div', {}, el('div', { class: 'forte' }, `${a.codigo} · ${a.nome}`),
        el('div', { class: 'fraco' }, [documento(a.documento), a.nome_fantasia, [a.bairro, a.cidade].filter(Boolean).join(', ')].filter(Boolean).join(' · '))) },
      { titulo: 'Contato', valor: (a) => el('div', {}, telefone(a.telefone), a.email ? el('div', { class: 'fraco' }, a.email) : null) },
      { titulo: 'Contratos', valor: (a) => el('div', {}, a.contratos_ativos || el('span', { class: 'fraco' }, '—'),
        a.contratos_bloqueados ? el('div', { class: 'fraco' }, `${a.contratos_bloqueados} bloqueado(s)`) : null), classe: 'num' },
      { titulo: 'Em aberto', valor: (a) => el('div', {}, a.saldo_centavos ? dinheiro(a.saldo_centavos) : el('span', { class: 'fraco' }, '—'),
        a.faturas_vencidas ? el('div', { class: 'fraco' }, `${a.faturas_vencidas} vencida(s)`) : null), classe: 'num' },
      { titulo: 'Situação', valor: (a) => el('div', {}, etqDe('situacaoAssinante', a.situacao),
        a.contratos_bloqueados ? el('div', { style: 'margin-top:4px' }, etq('Serviço bloqueado', 'erro')) : null) },
    ], l.itens, {
      vazioTexto: filtro.busca || filtro.situacao ? 'Nenhum assinante com esse filtro.' : 'Nenhum assinante cadastrado.',
      aoClicar: (a) => ir(`#/assinantes/${a.id}`),
      pagina: paginacao(l, (p) => { filtro.pagina = p; atualizar(); }),
    }), { semCorpo: true }));
  }
  atualizar();
}

/** Consulta o CNPJ na base da Receita e devolve os campos do cadastro, com a situação cadastral em uma linha. */
async function buscarCnpj(valor) {
  const r = await api.get(`/consultas/cnpj/${String(valor).replace(/\D/g, '')}`);
  if (!r.encontrado) return r;
  const d = r.dados;
  // O tipo passa a PJ sozinho (quem consultou CNPJ está cadastrando empresa) e a data de abertura
  // ocupa o campo de nascimento, que para empresa é exatamente isso.
  return { ...r, dados: { ...d, tipo: 'pj', nascimento: d.abertura ?? null },
    resumo: [d.situacao ? `Situação cadastral: ${d.situacao}${d.situacao_desde ? ` desde ${d.situacao_desde.split('-').reverse().join('/')}` : ''}` : null,
      d.atividade, d.porte, d.simples].filter(Boolean).join(' · ') };
}

/** Consulta o CEP e devolve só os campos de endereço (o número e o complemento continuam com quem cadastra). */
async function buscarCep(valor, chaveNumero = 'numero') {
  const r = await api.get(`/consultas/cep/${String(valor).replace(/\D/g, '')}`);
  if (!r.encontrado) return r;
  const { complemento, ibge, [chaveNumero]: _n, ...resto } = r.dados;
  return { ...r, dados: resto };
}

function editar(a, depois) {
  const pj = () => (a?.tipo ?? 'pf') === 'pj';
  return formulario(a ? `Assinante ${a.codigo}` : 'Novo assinante', [
    { tipo: 'secao', rotulo: 'Identificação' },
    { nome: 'tipo', rotulo: 'Tipo', tipo: 'select', vazio: false, opcoes: opcoes('tipoPessoa'), valor: a?.tipo ?? 'pf' },
    { nome: 'documento', rotulo: 'CPF / CNPJ', obrigatorio: true, valor: a ? documento(a.documento) : '',
      ajuda: 'Conferido pelo dígito verificador e único na operação. Com CNPJ, "Buscar na Receita" preenche o cadastro.',
      busca: { rotulo: 'Buscar na Receita', executar: buscarCnpj } },
    { nome: 'nome', rotulo: pj() ? 'Razão social' : 'Nome', obrigatorio: true, valor: a?.nome, inteiro: true },
    { nome: 'nome_fantasia', rotulo: 'Nome fantasia', valor: a?.nome_fantasia },
    { nome: 'identidade', rotulo: 'RG / Inscrição estadual', valor: a?.identidade },
    { nome: 'nascimento', rotulo: 'Nascimento / abertura', tipo: 'date', valor: a?.nascimento, ajuda: 'Para empresa, a data de abertura.' },
    { tipo: 'secao', rotulo: 'Contato' },
    { nome: 'telefone', rotulo: 'Telefone', valor: a?.telefone, ajuda: 'Com DDD.' },
    { nome: 'telefone2', rotulo: 'Outro telefone', valor: a?.telefone2 },
    { nome: 'email', rotulo: 'E-mail', tipo: 'email', valor: a?.email, inteiro: true },
    { tipo: 'secao', rotulo: 'Endereço' },
    { nome: 'cep', rotulo: 'CEP', valor: a?.cep, ajuda: 'Preenche logradouro, bairro, cidade e UF.',
      busca: { rotulo: 'Buscar CEP', executar: (x) => buscarCep(x, 'numero') } },
    { nome: 'logradouro', rotulo: 'Logradouro', valor: a?.logradouro },
    { nome: 'numero', rotulo: 'Número', valor: a?.numero },
    { nome: 'complemento', rotulo: 'Complemento', valor: a?.complemento },
    { nome: 'bairro', rotulo: 'Bairro', valor: a?.bairro },
    { nome: 'cidade', rotulo: 'Cidade', valor: a?.cidade },
    { nome: 'uf', rotulo: 'UF', valor: a?.uf },
    { nome: 'latitude', rotulo: 'Latitude', valor: a?.latitude },
    { nome: 'longitude', rotulo: 'Longitude', valor: a?.longitude },
    { tipo: 'secao', rotulo: 'Outros' },
    { nome: 'consentimento', rotulo: 'Consentiu receber contato comercial (LGPD)', tipo: 'checkbox', valor: Boolean(a?.consentimento_em), inteiro: true },
    { nome: 'observacoes', rotulo: 'Observações', tipo: 'textarea', valor: a?.observacoes, inteiro: true },
  ], {
    largo: true,
    enviar: async (d) => {
      const r = a ? await api.patch(`/assinantes/${a.id}`, { ...d, versao: a.versao }) : await api.post('/assinantes', d);
      toast('Assinante salvo.');
      depois?.(r);
      return r;
    },
  });
}

async function detalhe(alvo, id, ir) {
  const recarregar = () => detalhe(alvo, id, ir);
  limpar(alvo, carregando());
  let a;
  try { a = await api.get(`/assinantes/${id}`); } catch (err) { limpar(alvo, el('div', { class: 'falha' }, err.message)); return; }
  const bloqueados = a.contratos.filter((c) => c.situacao === 'bloqueado');
  const planos = pode('contratos.editar') ? await api.get('/planos?ativos=1').catch(() => []) : [];

  limpar(alvo,
    el('a', { href: '#/assinantes', class: 'botao fantasma pequeno', style: 'margin-bottom:10px' }, icone('voltar'), 'Assinantes'),
    cabecalho({
      sobretitulo: `${rotulo('tipoPessoa', a.tipo)} · assinante ${a.codigo}`,
      titulo: a.nome,
      descricao: [documento(a.documento), a.nome_fantasia].filter(Boolean).join(' · '),
      acoes: [
        pode('assinantes.editar') ? botao('Editar', () => editar(a, recarregar), { tipo: 'secundario' }) : null,
        pode('contratos.editar') ? botao('Novo contrato', () => novoContrato(a, planos, recarregar), { ic: 'mais' }) : null,
      ],
    }),
    bloqueados.length ? faixa(`${bloqueados.length} contrato(s) com o serviço bloqueado. Trate na tela de Cobrança e bloqueios.`, 'erro', 'alerta') : null,
    el('div', { class: 'stats' },
      stat({ rotulo: 'Em aberto', valor: dinheiro(a.posicao.saldo_centavos), nota: a.posicao.vencidas ? `${a.posicao.vencidas} fatura(s) vencida(s)` : 'Nada vencido',
        notaTipo: a.posicao.vencidas ? 'erro' : 'ok', ic: 'dinheiro' }),
      stat({ rotulo: 'Total devido hoje', valor: dinheiro(a.posicao.devido_centavos), nota: 'Com multa e juros do dia', ic: 'alerta' }),
      stat({ rotulo: 'Contratos', valor: a.contratos.filter((c) => c.situacao !== 'cancelado').length, nota: `${a.contratos.length} no histórico`, ic: 'arquivo' }),
      stat({ rotulo: 'Situação', valor: rotulo('situacaoAssinante', a.situacao), nota: a.consentimento_em ? 'Consentimento LGPD registrado' : 'Sem consentimento de contato comercial', ic: 'escudo' })),
    el('div', { class: 'grade principal-lateral' },
      el('div', {},
        painel('Contratos', tabela([
          { titulo: 'Contrato', valor: (c) => el('div', {}, el('div', { class: 'forte' }, `#${c.numero} · ${c.plano_nome}`),
            el('div', { class: 'fraco' }, [velocidade(c.download_mbps, c.upload_mbps), c.cto_codigo ? `${c.cto_codigo}${c.porta_numero ? `/porta ${c.porta_numero}` : ''}` : 'Sem ponto na planta'].join(' · '))) },
          { titulo: 'Mensalidade', valor: (c) => el('div', {}, dinheiro(c.mensalidade_centavos), el('div', { class: 'fraco' }, `vence dia ${c.dia_vencimento}`)), classe: 'num' },
          { titulo: 'Em aberto', valor: (c) => (c.posicao.saldo_centavos ? el('div', {}, dinheiro(c.posicao.saldo_centavos),
            c.posicao.atraso_dias ? el('div', { class: 'fraco' }, `${c.posicao.atraso_dias} dia(s) de atraso`) : null) : el('span', { class: 'fraco' }, '—')), classe: 'num' },
          { titulo: 'Situação', valor: (c) => el('div', {}, etqDe('situacaoContrato', c.situacao),
            c.bloqueio ? el('div', { class: 'fraco' }, `${rotulo('tipoBloqueio', c.bloqueio.tipo)} · ${rotulo('origemAcao', c.bloqueio.origem)}`) : null) },
          { titulo: 'Ativação', valor: (c) => data(c.ativacao) },
        ], a.contratos, { vazioTexto: 'Nenhum contrato.', aoClicar: (c) => ir(`#/contratos/${c.id}`) }), { semCorpo: true }),
        painel('Faturas', tabela([
          { titulo: 'Fatura', valor: (f) => el('div', {}, el('div', { class: 'forte' }, `#${f.numero}`),
            el('div', { class: 'fraco' }, f.competencia ? competencia(f.competencia) : 'Avulsa')) },
          { titulo: 'Vencimento', valor: (f) => el('div', {}, data(f.vencimento),
            f.encargos.dias_atraso ? el('div', { class: 'fraco' }, `${f.encargos.dias_atraso} dia(s) de atraso`) : null) },
          { titulo: 'Valor', valor: (f) => dinheiro(f.valor_centavos), classe: 'num' },
          { titulo: 'Pago', valor: (f) => (f.pago_centavos ? dinheiro(f.pago_centavos) : el('span', { class: 'fraco' }, '—')), classe: 'num' },
          { titulo: 'Devido hoje', valor: (f) => (f.encargos.total_devido_centavos ? el('div', {}, dinheiro(f.encargos.total_devido_centavos),
            f.encargos.multa_centavos ? el('div', { class: 'fraco' }, `multa ${dinheiro(f.encargos.multa_centavos)} + juros ${dinheiro(f.encargos.juros_centavos)}`) : null)
            : el('span', { class: 'fraco' }, '—')), classe: 'num' },
          { titulo: 'Situação', valor: (f) => etqDe('situacaoFatura', f.situacao) },
        ], a.faturas, { vazioTexto: 'Nenhuma fatura emitida.', aoClicar: pode('faturamento.ver') ? (f) => ir(`#/faturamento/${f.id}`) : null }), { semCorpo: true })),
      el('div', {},
        painel('Cadastro', dl([
          ['Documento', documento(a.documento)],
          [a.tipo === 'pj' ? 'Inscrição estadual' : 'RG', a.identidade],
          ['Telefone', telefone(a.telefone)],
          ['Outro telefone', a.telefone2 ? telefone(a.telefone2) : null],
          ['E-mail', a.email],
          ['Endereço', [[a.logradouro, a.numero].filter(Boolean).join(', '), a.complemento, a.bairro, [a.cidade, a.uf].filter(Boolean).join('/')].filter(Boolean).join(' · ')],
          ['CEP', a.cep],
          ['Cadastrado em', dataHora(a.criado_em)],
          ['Consentimento LGPD', a.consentimento_em ? dataHora(a.consentimento_em) : 'Não registrado'],
          ['Observações', a.observacoes],
        ])))));
}

/** Contrato novo para este assinante: o endereço em branco significa o endereço do assinante. */
function novoContrato(a, planos, depois) {
  return formulario(`Novo contrato · ${a.nome}`, [
    { nome: 'plano_id', rotulo: 'Plano', tipo: 'select', obrigatorio: true, inteiro: true,
      opcoes: planos.map((p) => [p.id, `${p.nome} · ${dinheiro(p.mensalidade_centavos)}${p.download_mbps ? ` · ${velocidade(p.download_mbps, p.upload_mbps)}` : ''}`]) },
    { nome: 'mensalidade', rotulo: 'Mensalidade contratada (R$)', tipo: 'decimal', ajuda: 'Em branco usa o valor do plano. O contrato guarda este valor para sempre.' },
    { nome: 'instalacao', rotulo: 'Taxa de instalação (R$)', tipo: 'decimal', ajuda: 'Em branco usa a taxa do plano.' },
    { nome: 'dia_vencimento', rotulo: 'Dia do vencimento', tipo: 'number', min: 1, max: 28, ajuda: 'De 1 a 28, para existir em todo mês.' },
    { nome: 'carencia_dias', rotulo: 'Carência própria (dias)', tipo: 'number', ajuda: 'Em branco usa a carência da operação antes de qualquer bloqueio.' },
    { tipo: 'secao', rotulo: 'Endereço de instalação (em branco = o do assinante)' },
    { nome: 'cep', rotulo: 'CEP', busca: { rotulo: 'Buscar CEP', executar: (x) => buscarCep(x, 'numero_endereco') } },
    { nome: 'logradouro', rotulo: 'Logradouro' }, { nome: 'numero_endereco', rotulo: 'Número' },
    { nome: 'complemento', rotulo: 'Complemento' }, { nome: 'bairro', rotulo: 'Bairro' }, { nome: 'cidade', rotulo: 'Cidade' }, { nome: 'uf', rotulo: 'UF' },
    { nome: 'observacoes', rotulo: 'Observações', tipo: 'textarea', inteiro: true },
  ], {
    largo: true,
    antes: faixa('O contrato nasce em implantação: ele só fatura e só pode bloquear depois de ativado, com a data em que o serviço entrou.', '', 'info'),
    enviar: async (d) => {
      const r = await api.post('/contratos', { ...d, assinante_id: a.id, dia_vencimento: d.dia_vencimento || undefined });
      toast(`Contrato #${r.numero} criado em implantação.`);
      depois?.();
      return r;
    },
  });
}

export { editar as editarAssinante, buscarCep };
