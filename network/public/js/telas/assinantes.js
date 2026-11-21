import { api, qs, baixar } from '../api.js';
import { el, limpar, pode, cabecalho, painel, tabela, paginacao, etq, etqDe, rotulo, opcoes, documento, telefone, dinheiro,
  carregar, formulario, botao, toast } from '../ui.js';

export default async function assinantes({ alvo, params, query, ir }) {
  // O detalhe é a ficha completa: uma tela só, sem pular para contrato, fatura, cobrança ou provisionamento.
  if (params[0]) {
    const { default: ficha } = await import('./ficha.js');
    return ficha({ alvo, id: Number(params[0]), query, ir, editarAssinante: editar });
  }
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

export { editar as editarAssinante, buscarCep };
