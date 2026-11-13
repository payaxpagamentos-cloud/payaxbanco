'use strict';

/**
 * Cliente da API REST do IXC Provedor (/webservice/v1/), um por cliente da plataforma.
 *
 * Autenticação: token de um usuário técnico do provedor ("id:hash", em Configurações → Usuários → Token), em Basic.
 * Consultas levam o cabeçalho `ixcsoft: listar`.
 *
 * Os nomes de recursos e campos variam entre versões do IXC. Estão todos reunidos em RECURSOS e CAMPOS,
 * para serem conferidos e ajustados em um lugar só contra a instância de cada provedor.
 */
const dns = require('node:dns').promises;
const net = require('node:net');
const config = require('../config');
const { ErroNegocio } = require('./erros');

const RECURSOS = {
  cliente: 'cliente',
  contrato: 'cliente_contrato',
  receber: 'fn_areceber',
};

const CAMPOS = {
  // fn_areceber
  id: 'id',
  clienteId: 'id_cliente',
  documento: 'documento',
  valor: 'valor',
  vencimento: 'data_vencimento',
  status: 'status',            // A = aberto, R = recebido, C = cancelado
  valorRecebido: 'valor_recebido',
  dataRecebimento: 'data_recebimento',
  observacao: 'obs',
  linhaDigitavel: 'linha_digitavel',
  nossoNumero: 'nosso_numero',
};

class ErroIxc extends Error {
  constructor(mensagem, { tempoEsgotado = false, status } = {}) {
    super(mensagem);
    this.tempoEsgotado = tempoEsgotado;
    this.status = status;
  }
}

const digitos = (v) => String(v ?? '').replace(/\D/g, '');

/** Valor do IXC ("1.234,56" ou "1234.56") em centavos inteiros. */
function paraCentavos(v) {
  if (v === null || v === undefined || v === '') return 0;
  let t = String(v).trim();
  if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  const n = Math.round(Number(t) * 100);
  return Number.isFinite(n) ? n : 0;
}

const paraReais = (c) => (c / 100).toFixed(2);

/** Data do IXC ('AAAA-MM-DD' ou 'DD/MM/AAAA') normalizada. */
function paraData(v) {
  const t = String(v ?? '').trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(t)) return t.split('/').reverse().join('-');
  return null;
}

/** Recusa endereços da rede interna (evita que uma URL cadastrada alcance serviços do servidor). */
async function conferirEndereco(url) {
  if (config.ixc.redeInterna) return;
  const { hostname } = new URL(url);
  const enderecos = net.isIP(hostname) ? [hostname] : (await dns.lookup(hostname, { all: true })).map((a) => a.address);
  const interno = (ip) => /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(ip)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    || ip === '::1' || /^f[cd]/i.test(ip);
  if (enderecos.some(interno)) throw new ErroIxc('O endereço do IXC aponta para a rede interna do servidor e foi recusado.');
}

/**
 * @param {{ url: string, token: string, timeoutMs?: number }} opcoes
 */
function criarIxc({ url, token, timeoutMs = config.ixc.timeoutMs }) {
  if (!url || !token) throw new ErroNegocio('IXC sem endereço ou token configurado.', 409);
  const base = `${String(url).replace(/\/+$/, '').replace(/\/webservice\/v1$/, '')}/webservice/v1`;
  const autorizacao = `Basic ${Buffer.from(String(token)).toString('base64')}`;

  async function chamar(recurso, corpo, { listar = false, metodo = 'POST', sufixo = '' } = {}) {
    await conferirEndereco(base);
    let resp;
    try {
      resp = await fetch(`${base}/${recurso}${sufixo}`, {
        method: metodo,
        headers: {
          Authorization: autorizacao,
          'Content-Type': 'application/json',
          ...(listar ? { ixcsoft: 'listar' } : {}),
        },
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const tempo = err.name === 'TimeoutError' || err.name === 'AbortError';
      throw new ErroIxc(tempo ? 'O IXC não respondeu a tempo.' : `Sem conexão com o IXC: ${err.message}`, { tempoEsgotado: tempo });
    }
    if (resp.status === 401 || resp.status === 403) throw new ErroIxc('O IXC recusou o token (confira usuário e token na instância).', { status: resp.status });
    if (!resp.ok) throw new ErroIxc(`O IXC respondeu com erro ${resp.status}.`, { status: resp.status });
    let dados;
    try { dados = await resp.json(); } catch { throw new ErroIxc('O IXC respondeu algo que não é JSON (confira o endereço).'); }
    if (dados?.type === 'error' || dados?.tipo === 'erro') {
      throw new ErroIxc(String(dados.message ?? dados.mensagem ?? 'O IXC recusou a operação.').replace(/<[^>]+>/g, '').trim());
    }
    return dados;
  }

  async function listar(recurso, qtype, query, { oper = '=', rp = 100, pagina = 1, sortname, sortorder = 'asc' } = {}) {
    const dados = await chamar(recurso, {
      qtype, query: String(query), oper, page: String(pagina), rp: String(rp), sortname: sortname ?? qtype, sortorder,
    }, { listar: true });
    return { registros: Array.isArray(dados?.registros) ? dados.registros : [], total: Number(dados?.total ?? 0) };
  }

  /** Converte um título do IXC para o formato do sistema. */
  const traduzirTitulo = (t) => ({
    ixc_id: String(t[CAMPOS.id]),
    ixc_cliente_id: String(t[CAMPOS.clienteId] ?? ''),
    documento: String(t[CAMPOS.documento] ?? ''),
    valor_centavos: paraCentavos(t[CAMPOS.valor]),
    vencimento: paraData(t[CAMPOS.vencimento]),
    status: String(t[CAMPOS.status] ?? ''),
    bruto: t,
  });

  return {
    async testar() {
      const r = await listar(RECURSOS.cliente, 'cliente.id', '0', { oper: '>', rp: 1 });
      return { ok: true, clientes: r.total };
    },

    async clientePorId(id) {
      const r = await listar(RECURSOS.cliente, 'cliente.id', id, { rp: 1 });
      const c = r.registros[0];
      if (!c) return null;
      return {
        ixc_id: String(c.id),
        nome: c.razao ?? c.fantasia ?? c.nome ?? '',
        documento: digitos(c.cnpj_cpf),
        email: String(c.email ?? '').split(/[;,]/)[0].trim() || null,
        telefone: digitos(c.telefone_celular ?? c.fone ?? c.whatsapp ?? ''),
        cep: digitos(c.cep),
        endereco: c.endereco ?? null,
        numero: c.numero ?? null,
        bairro: c.bairro ?? null,
        cidade: c.cidade_nome ?? c.cidade ?? null,
        uf: c.estado ?? c.uf ?? null,
        bruto: c,
      };
    },

    /** Títulos em aberto com vencimento no intervalo (os candidatos a virar boleto). */
    async titulosEmAberto({ de, ate, pagina = 1, rp = 100 } = {}) {
      const r = await listar(RECURSOS.receber, `${RECURSOS.receber}.${CAMPOS.vencimento}`, `${de},${ate}`, {
        oper: 'between', rp, pagina, sortname: `${RECURSOS.receber}.${CAMPOS.vencimento}`,
      });
      return {
        total: r.total,
        titulos: r.registros.map(traduzirTitulo).filter((t) => t.status === 'A' && t.valor_centavos > 0),
      };
    },

    async tituloPorId(id) {
      const r = await listar(RECURSOS.receber, `${RECURSOS.receber}.${CAMPOS.id}`, id, { rp: 1 });
      return r.registros[0] ? traduzirTitulo(r.registros[0]) : null;
    },

    /**
     * Grava no IXC o código do boleto emitido, para o provedor ver no título de origem.
     */
    async anotarBoleto(ixcId, { linha_digitavel, nosso_numero }) {
      return chamar(RECURSOS.receber, {
        [CAMPOS.id]: String(ixcId),
        [CAMPOS.linhaDigitavel]: linha_digitavel,
        [CAMPOS.nossoNumero]: nosso_numero,
      }, { metodo: 'PUT', sufixo: `/${ixcId}` });
    },

    /**
     * Dá baixa no título do IXC quando o boleto é liquidado.
     * ATENÇÃO: confira o recurso de baixa na instância do provedor — algumas versões usam `fn_areceber_baixa`
     * em vez do PUT direto no título.
     */
    async baixarTitulo(ixcId, { data_recebimento, valor_centavos, observacao }) {
      return chamar(RECURSOS.receber, {
        [CAMPOS.id]: String(ixcId),
        [CAMPOS.status]: 'R',
        [CAMPOS.dataRecebimento]: data_recebimento,
        [CAMPOS.valorRecebido]: paraReais(valor_centavos),
        [CAMPOS.observacao]: String(observacao ?? '').slice(0, 200),
      }, { metodo: 'PUT', sufixo: `/${ixcId}` });
    },
  };
}

module.exports = { criarIxc, ErroIxc, RECURSOS, CAMPOS, paraCentavos, paraData };
