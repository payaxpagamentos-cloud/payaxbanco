'use strict';

/**
 * Cliente da API REST do IXC Provedor (/webservice/v1/), usado pelo PDV.
 *
 * Autenticação: token de um usuário do IXC só para o PDV ("id:hash", em Configurações > Usuários > Token), em Basic.
 * Consultas levam o cabeçalho `ixcsoft: listar`; a baixa é um PUT no próprio registro do contas a receber.
 *
 * Os nomes dos recursos e dos campos abaixo são os do IXC atual e devem ser conferidos na instância do provedor
 * (variam entre versões). Estão todos aqui, num lugar só, para ajustar sem mexer no resto do sistema.
 */

const RECURSOS = {
  cliente: 'cliente',
  contrato: 'cliente_contrato',
  receber: 'fn_areceber',
};

// Situação do título no contas a receber do IXC.
const SITUACAO = {
  A: 'aberto',
  R: 'recebido',
  C: 'cancelado',
  L: 'levado_cartorio',
  P: 'parcialmente_recebido',
};

// Situação de acesso do contrato (cliente_contrato.status_internet).
const ACESSO = {
  A: 'liberado',
  D: 'desativado',
  CM: 'bloqueio_manual',
  CA: 'bloqueio_automatico',
  FA: 'financeiro_em_atraso',
  AA: 'aguardando_assinatura',
};

class ErroIxc extends Error {
  constructor(mensagem, { tempoEsgotado = false, status } = {}) {
    super(mensagem);
    this.tempoEsgotado = tempoEsgotado;
    this.status = status;
  }
}

const digitos = (v) => String(v ?? '').replace(/\D/g, '');
const limpo = (t) => String(t ?? '').replace(/<[^>]+>/g, '').trim();

/** CPF/CNPJ como o IXC costuma guardar (com pontuação). */
function formatarDocumento(doc) {
  const d = digitos(doc);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return d;
}

/** Reais do IXC ("1.234,56" ou "1234.56") em centavos. */
function centavos(valor) {
  if (valor === null || valor === undefined || valor === '') return 0;
  let t = String(valor).trim();
  if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Centavos no formato que o IXC aceita em valores ("1234.56"). */
const reais = (c) => ((c ?? 0) / 100).toFixed(2);

/** Data do IXC ('AAAA-MM-DD' ou vazia/zerada) normalizada. */
const data = (v) => {
  const t = String(v ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(t) && !t.startsWith('0000') ? t : null;
};

/** Um título do contas a receber do IXC, já traduzido para o vocabulário do PDV (valores em centavos). */
const titulo = (f) => ({
  id: String(f.id),
  cliente_id: f.id_cliente ? String(f.id_cliente) : null,
  contrato_id: f.id_contrato ? String(f.id_contrato) : null,
  documento: f.documento ?? f.numero_documento ?? null,
  descricao: limpo(f.obs ?? f.historico ?? '') || null,
  vencimento: data(f.data_vencimento),
  emissao: data(f.data_emissao),
  situacao: SITUACAO[f.status] ?? String(f.status ?? '').toLowerCase() ?? null,
  situacao_ixc: f.status ?? null,
  valor_centavos: centavos(f.valor),
  aberto_centavos: centavos(f.valor_aberto ?? f.valor),
  recebido_centavos: centavos(f.valor_recebido ?? f.valor_pago ?? 0),
  pagamento: data(f.data_pagamento ?? f.data_recebimento ?? f.data_baixa),
  linha_digitavel: f.linha_digitavel ?? null,
});

/**
 * @param {{ url: string, token: string, timeoutMs?: number }} opcoes
 */
function criarIxc({ url, token, timeoutMs = 8000 }) {
  const base = `${String(url).replace(/\/+$/, '').replace(/\/webservice\/v1$/, '')}/webservice/v1`;
  const autorizacao = `Basic ${Buffer.from(String(token)).toString('base64')}`;

  async function chamar(caminho, corpo, { listar = false, metodo = 'POST' } = {}) {
    let resp;
    try {
      resp = await fetch(`${base}/${caminho}`, {
        method: metodo,
        headers: { Authorization: autorizacao, 'Content-Type': 'application/json', ...(listar ? { ixcsoft: 'listar' } : {}) },
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const tempo = err.name === 'TimeoutError' || err.name === 'AbortError';
      throw new ErroIxc(tempo ? 'O IXC não respondeu a tempo.' : 'Sem conexão com o IXC.', { tempoEsgotado: tempo });
    }
    if (resp.status === 401 || resp.status === 403) throw new ErroIxc('O IXC recusou o token do PDV.', { status: resp.status });
    if (!resp.ok) throw new ErroIxc(`O IXC respondeu com erro ${resp.status}.`, { status: resp.status });
    let dados;
    try { dados = await resp.json(); } catch { throw new ErroIxc('O IXC respondeu algo que não é JSON (confira o endereço).'); }
    if (dados?.type === 'error' || dados?.tipo === 'erro') {
      throw new ErroIxc(limpo(dados.message ?? dados.mensagem ?? 'O IXC recusou a operação.') || 'O IXC recusou a operação.');
    }
    return dados;
  }

  /** Consulta uma lista (ixcsoft: listar). */
  async function listar(recurso, qtype, query, { oper = '=', rp = 50, sortname, sortorder = 'asc' } = {}) {
    const dados = await chamar(recurso, {
      qtype, query: String(query), oper, page: '1', rp: String(rp), sortname: sortname ?? qtype, sortorder,
    }, { listar: true });
    return Array.isArray(dados?.registros) ? dados.registros : [];
  }

  const ativo = (c) => c.ativo === undefined || c.ativo === 'S';
  const cliente = (c) => ({
    id: String(c.id),
    nome: limpo(c.razao ?? c.fantasia ?? ''),
    fantasia: limpo(c.fantasia ?? '') || null,
    documento: digitos(c.cnpj_cpf),
    telefone: c.telefone_celular || c.fone || c.whatsapp || null,
    email: c.email ?? null,
    cidade: c.cidade_nome ?? null,
    ativo: ativo(c),
  });

  return {
    /** Confere se o endereço e o token funcionam (lista um cliente). */
    async testar() {
      await listar(RECURSOS.cliente, 'cliente.id', '0', { oper: '>', rp: 1 });
      return true;
    },

    async clientePorId(id) {
      const c = (await listar(RECURSOS.cliente, 'cliente.id', id, { rp: 1 }))[0];
      return c ? cliente(c) : null;
    },

    /** Clientes com este CPF/CNPJ (com e sem pontuação, conforme o IXC guardou). */
    async clientesPorDocumento(doc) {
      const d = digitos(doc);
      const formatado = formatarDocumento(d);
      let lista = await listar(RECURSOS.cliente, 'cliente.cnpj_cpf', formatado);
      if (!lista.length && formatado !== d) lista = await listar(RECURSOS.cliente, 'cliente.cnpj_cpf', d);
      return lista.filter((c) => digitos(c.cnpj_cpf) === d).map(cliente);
    },

    /** Clientes cujo nome contém o texto (busca do balcão). */
    async clientesPorNome(nome) {
      return (await listar(RECURSOS.cliente, 'cliente.razao', String(nome).trim(), { oper: 'L', rp: 30 })).map(cliente);
    },

    /** Clientes por telefone (últimos 8 dígitos, do jeito que o IXC costuma guardar). */
    async clientesPorTelefone(tel) {
      const d = digitos(tel);
      if (d.length < 8) return [];
      const fim = d.slice(-8);
      const padroes = [...new Set([`${fim.slice(0, 4)}-${fim.slice(4)}`, fim])];
      const campos = ['cliente.telefone_celular', 'cliente.fone', 'cliente.whatsapp'];
      const listas = await Promise.all(campos.flatMap((campo) => padroes.map((p) => listar(RECURSOS.cliente, campo, p, { oper: 'L', rp: 30 }))));
      const porId = new Map();
      for (const c of listas.flat()) {
        if ([c.telefone_celular, c.fone, c.whatsapp].some((t) => digitos(t).endsWith(fim))) porId.set(String(c.id), c);
      }
      return [...porId.values()].map(cliente);
    },

    async contratos(clienteId) {
      return (await listar(RECURSOS.contrato, 'cliente_contrato.id_cliente', clienteId, { rp: 50 })).map((c) => ({
        id: String(c.id),
        plano: limpo(c.contrato ?? '') || null,
        status: c.status,
        acesso: ACESSO[c.status_internet] ?? c.status_internet ?? null,
        ativo: c.status === 'A',
      }));
    },

    /** Títulos em aberto do cliente, do vencimento mais antigo para o mais novo. */
    async faturasAbertas(clienteId) {
      const lista = await listar(RECURSOS.receber, 'fn_areceber.id_cliente', clienteId, { rp: 200, sortname: 'fn_areceber.data_vencimento' });
      return lista.map(titulo).filter((f) => f.situacao === 'aberto' || f.situacao === 'parcialmente_recebido')
        .sort((a, b) => String(a.vencimento).localeCompare(String(b.vencimento)));
    },

    /** Um título pelo id (usado na conferência: situação e valor que o IXC tem agora). */
    async fatura(id) {
      const f = (await listar(RECURSOS.receber, 'fn_areceber.id', id, { rp: 1 }))[0];
      return f ? titulo(f) : null;
    },

    /** Títulos baixados num intervalo de datas (conferência pelo lado do IXC). */
    async faturasPagas(de, ate) {
      const lista = await listar(RECURSOS.receber, 'fn_areceber.data_pagamento', `${de},${ate}`, { oper: 'B', rp: 500, sortname: 'fn_areceber.data_pagamento' });
      return lista.map(titulo).filter((f) => f.pagamento);
    },

    /**
     * Baixa (liquidação) do título no IXC. O PDV manda a data, o valor recebido e o tipo de recebimento
     * configurado para a forma de pagamento usada no balcão.
     */
    async baixar({ faturaId, valorCentavos, dataPagamento, tipoRecebimento, contaId, historico, jurosCentavos = 0, descontoCentavos = 0 }) {
      const corpo = {
        id: String(faturaId),
        status: 'R',
        data_pagamento: dataPagamento,
        data_recebimento: dataPagamento,
        valor_recebido: reais(valorCentavos),
        valor_aberto: '0.00',
        ...(jurosCentavos ? { juros: reais(jurosCentavos) } : {}),
        ...(descontoCentavos ? { valor_desconto: reais(descontoCentavos) } : {}),
        ...(tipoRecebimento ? { id_tipo_recebimento: String(tipoRecebimento) } : {}),
        ...(contaId ? { id_conta: String(contaId) } : {}),
        ...(historico ? { obs: String(historico).slice(0, 255) } : {}),
      };
      const dados = await chamar(`${RECURSOS.receber}/${faturaId}`, corpo, { metodo: 'PUT' });
      return { mensagem: limpo(dados?.message ?? dados?.mensagem ?? 'Título baixado.'), resposta: dados };
    },

    /** Reabre o título no IXC (usado quando o recebimento é cancelado no PDV). */
    async estornar({ faturaId, valorCentavos, historico }) {
      const corpo = {
        id: String(faturaId),
        status: 'A',
        data_pagamento: '',
        data_recebimento: '',
        valor_recebido: '0.00',
        valor_aberto: reais(valorCentavos),
        ...(historico ? { obs: String(historico).slice(0, 255) } : {}),
      };
      const dados = await chamar(`${RECURSOS.receber}/${faturaId}`, corpo, { metodo: 'PUT' });
      return { mensagem: limpo(dados?.message ?? dados?.mensagem ?? 'Título reaberto.'), resposta: dados };
    },
  };
}

module.exports = { criarIxc, ErroIxc, RECURSOS, SITUACAO, ACESSO, centavos, reais, formatarDocumento, digitos };
