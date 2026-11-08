'use strict';

/**
 * Cliente da API REST do IXC Provedor (/webservice/v1/), usado pela ZOE.
 *
 * Autenticação: token de um usuário técnico só da ZOE ("id:hash", em Configurações > Usuários > Token), em Basic.
 * Consultas levam o cabeçalho `ixcsoft: listar`. Toda chamada tem limite de tempo (3 s por padrão): se o IXC não
 * responder, a ZOE avisa o cliente e transfere para um atendente.
 *
 * Os nomes dos recursos e campos abaixo são os do IXC atual e devem ser conferidos na instância do provedor piloto
 * (variam entre versões). Estão todos aqui, num lugar só, para ajustar sem mexer no resto.
 */

const RECURSOS = {
  cliente: 'cliente',
  contrato: 'cliente_contrato',
  receber: 'fn_areceber',
  boleto: 'get_boleto',
  desbloqueio: 'desbloqueio_confianca',
};

// Situação de acesso do contrato (cliente_contrato.status_internet).
const ACESSO = {
  A: 'liberado',
  D: 'desativado',
  CM: 'bloqueio_manual',
  CA: 'bloqueio_automatico', // bloqueio automático por atraso
  FA: 'financeiro_em_atraso', // reduzido/bloqueado por atraso
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

/** CPF/CNPJ como o IXC costuma guardar (com pontuação). */
function formatarDocumento(doc) {
  const d = digitos(doc);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return d;
}

/** Telefone sem o 0 de longa distância nem o 55: DDD + número (ou só o número). */
function telefoneNacional(t) {
  let d = digitos(t);
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length >= 11 && d.startsWith('0')) d = d.replace(/^0+/, '');
  return d;
}

/** Dois telefones são o mesmo: com DDD nos dois, compara DDD + número; senão, os últimos 8 dígitos. */
function mesmoTelefone(a, b) {
  const x = telefoneNacional(a);
  const y = telefoneNacional(b);
  if (x.length < 8 || y.length < 8) return false;
  if (x.length >= 10 && y.length >= 10) {
    // Celular antigo sem o 9: (11) 8765-4321 = (11) 98765-4321.
    const semNove = (t) => (t.length === 11 && t[2] === '9' ? t.slice(0, 2) + t.slice(3) : t);
    return x === y || semNove(x) === semNove(y);
  }
  return x.slice(-8) === y.slice(-8);
}

/**
 * @param {{ url: string, token: string, timeoutMs?: number, cacheMs?: number }} opcoes
 */
function criarIxc({ url, token, timeoutMs = 3000, cacheMs = 60_000 }) {
  const base = `${String(url).replace(/\/+$/, '').replace(/\/webservice\/v1$/, '')}/webservice/v1`;
  const autorizacao = `Basic ${Buffer.from(String(token)).toString('base64')}`;
  const cache = new Map();

  async function chamar(recurso, corpo, { listar = false } = {}) {
    let resp;
    try {
      resp = await fetch(`${base}/${recurso}`, {
        method: 'POST',
        headers: { Authorization: autorizacao, 'Content-Type': 'application/json', ...(listar ? { ixcsoft: 'listar' } : {}) },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const tempo = err.name === 'TimeoutError' || err.name === 'AbortError';
      throw new ErroIxc(tempo ? 'O IXC não respondeu a tempo.' : 'Sem conexão com o IXC.', { tempoEsgotado: tempo });
    }
    if (resp.status === 401 || resp.status === 403) throw new ErroIxc('O IXC recusou o token da ZOE.', { status: resp.status });
    if (!resp.ok) throw new ErroIxc(`O IXC respondeu com erro ${resp.status}.`, { status: resp.status });
    let dados;
    try { dados = await resp.json(); } catch { throw new ErroIxc('O IXC respondeu algo que não é JSON (confira o endereço).'); }
    if (dados?.type === 'error' || dados?.tipo === 'erro') {
      throw new ErroIxc(String(dados.message ?? dados.mensagem ?? 'O IXC recusou a operação.').replace(/<[^>]+>/g, '').trim());
    }
    return dados;
  }

  /** Consulta, com cache curto por ligação (escopo), para não repetir a mesma pergunta ao IXC durante o atendimento. */
  async function listar(escopo, recurso, qtype, query, { oper = '=', rp = 20, sortname, sortorder = 'asc' } = {}) {
    const chave = JSON.stringify([escopo, recurso, qtype, query, oper, rp, sortname, sortorder]);
    const c = cache.get(chave);
    if (c && c.expira > Date.now()) return c.valor;
    const dados = await chamar(recurso, {
      qtype, query: String(query), oper, page: '1', rp: String(rp), sortname: sortname ?? qtype, sortorder,
    }, { listar: true });
    const valor = Array.isArray(dados?.registros) ? dados.registros : [];
    cache.set(chave, { valor, expira: Date.now() + cacheMs });
    while (cache.size > 2000) cache.delete(cache.keys().next().value);
    return valor;
  }

  const ativo = (c) => c.ativo === undefined || c.ativo === 'S';
  const esquecer = (escopo) => {
    for (const k of cache.keys()) if (JSON.parse(k)[0] === escopo) cache.delete(k);
  };

  /** Métodos com o cache de uma ligação (escopo = uid); sem escopo, sem cache compartilhado útil. */
  const metodos = (escopo) => ({
    /** Confere se o endereço e o token funcionam (lista um cliente). */
    async testar() {
      await listar(escopo, RECURSOS.cliente, 'cliente.id', '0', { oper: '>', rp: 1 });
      return true;
    },

    async clientePorId(id) {
      return (await listar(escopo, RECURSOS.cliente, 'cliente.id', id))[0] ?? null;
    },

    /** Clientes ativos com este CPF/CNPJ (com e sem pontuação, conforme o IXC guardou). */
    async clientesPorDocumento(doc) {
      const d = digitos(doc);
      const formatado = formatarDocumento(d);
      let lista = await listar(escopo, RECURSOS.cliente, 'cliente.cnpj_cpf', formatado);
      if (!lista.length && formatado !== d) lista = await listar(escopo, RECURSOS.cliente, 'cliente.cnpj_cpf', d);
      return lista.filter((c) => ativo(c) && digitos(c.cnpj_cpf) === d);
    },

    /**
     * Clientes ativos com este telefone em qualquer um dos campos (fone, celular, WhatsApp).
     * O IXC guarda o telefone formatado de vários jeitos, então a busca é pelo final do número e a comparação é feita aqui.
     */
    async clientesPorTelefone(tel) {
      const d = telefoneNacional(tel);
      if (d.length < 8) return [];
      const fim = d.slice(-8);
      const padroes = [...new Set([`${fim.slice(0, 4)}-${fim.slice(4)}`, fim])];
      const campos = ['cliente.telefone_celular', 'cliente.fone', 'cliente.whatsapp'];
      const listas = await Promise.all(campos.flatMap((campo) => padroes.map((p) => listar(escopo, RECURSOS.cliente, campo, p, { oper: 'L', rp: 50 }))));
      const porId = new Map();
      for (const c of listas.flat()) {
        if (ativo(c) && [c.telefone_celular, c.fone, c.whatsapp].some((t) => mesmoTelefone(t, d))) porId.set(String(c.id), c);
      }
      return [...porId.values()];
    },

    async contratos(clienteId) {
      return (await listar(escopo, RECURSOS.contrato, 'cliente_contrato.id_cliente', clienteId, { rp: 50 }))
        .map((c) => ({
          id: String(c.id),
          plano: c.contrato ?? null,
          status: c.status,
          acesso: ACESSO[c.status_internet] ?? c.status_internet ?? null,
          ativo: c.status === 'A',
        }));
    },

    /** Faturas em aberto do cliente, da mais antiga para a mais nova. */
    async faturasAbertas(clienteId) {
      const lista = await listar(escopo, RECURSOS.receber, 'fn_areceber.id_cliente', clienteId, { rp: 100, sortname: 'fn_areceber.data_vencimento' });
      return lista
        .filter((f) => f.status === 'A')
        .map((f) => ({
          id: String(f.id),
          contrato_id: f.id_contrato ? String(f.id_contrato) : null,
          vencimento: String(f.data_vencimento ?? '').slice(0, 10),
          valor_centavos: Math.round(Number(f.valor_aberto ?? f.valor ?? 0) * 100),
        }))
        .sort((a, b) => a.vencimento.localeCompare(b.vencimento));
    },

    /**
     * Segunda via. `mail` e `sms` pedem ao próprio IXC que envie aos contatos do cadastro;
     * `arquivo` devolve o PDF em base64 (para mandar pelo WhatsApp do provedor).
     */
    async boleto(faturaId, tipo) {
      const dados = await chamar(RECURSOS.boleto, {
        boletos: String(faturaId), juro: 'N', multa: 'N', atualiza_boleto: 'N', tipo_boleto: tipo, base64: tipo === 'arquivo' ? 'S' : 'N',
      });
      return dados;
    },

    /** Desbloqueio de confiança do contrato (o IXC aplica o prazo e as regras dele também). */
    async desbloqueioConfianca(contratoId) {
      const dados = await chamar(RECURSOS.desbloqueio, { id: String(contratoId) });
      esquecer(escopo); // a situação do contrato mudou
      return String(dados?.mensagem ?? dados?.message ?? 'Contrato desbloqueado.').replace(/<[^>]+>/g, '').trim();
    },
  });

  return { ...metodos(''), ligacao: (uid) => metodos(`ligacao:${uid}`) };
}

module.exports = { criarIxc, ErroIxc, RECURSOS, ACESSO, mesmoTelefone, telefoneNacional, formatarDocumento };
