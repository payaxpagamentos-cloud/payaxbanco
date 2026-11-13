'use strict';

const { ErroNegocio } = require('../lib/erros');

/**
 * Cliente da API REST do IXC Provedor (/webservice/v1/).
 *
 * Autenticação: token de um usuário técnico só do bot ("id:hash", em Configurações > Usuários > Token),
 * em Basic. Consultas levam o cabeçalho `ixcsoft: listar`. Toda chamada tem limite de tempo: se o IXC
 * não responder, a ZOE avisa o cliente e transfere — nunca inventa a resposta.
 *
 * NOMES DE RECURSO E CAMPO VARIAM ENTRE VERSÕES DO IXC. Por isso:
 *   1. estão todos no mapa RECURSOS, num lugar só;
 *   2. a empresa pode sobrescrever cada um na configuração, sem mexer no código;
 *   3. `diagnosticar()` testa cada capacidade na instância do provedor e diz o que funciona ali —
 *      a ZOE só recebe as ferramentas que a sonda aprovou.
 */

const RECURSOS = {
  cliente: 'cliente',
  contrato: 'cliente_contrato',
  receber: 'fn_areceber',
  boleto: 'get_boleto',
  desbloqueio: 'desbloqueio_confianca',
  // Login de conexão (RADIUS) e o histórico de conexões: usados no diagnóstico "minha internet caiu".
  login: 'radusuarios',
  conexao: 'radpop_radaccounting',
  // Ordem de serviço / chamado técnico.
  chamado: 'su_oss_chamado',
  // Assunto do chamado (a lista de motivos cadastrada pelo provedor).
  assunto: 'su_oss_assunto',
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

const EXPLICACAO_ACESSO = {
  liberado: 'o acesso está liberado',
  desativado: 'o contrato está desativado',
  bloqueio_manual: 'o acesso está bloqueado manualmente pelo provedor',
  bloqueio_automatico: 'o acesso foi bloqueado automaticamente por falta de pagamento',
  financeiro_em_atraso: 'o acesso está reduzido ou bloqueado por fatura em atraso',
  aguardando_assinatura: 'o contrato está aguardando assinatura',
};

class ErroIxc extends Error {
  constructor(mensagem, { tempoEsgotado = false, status, recurso = null } = {}) {
    super(mensagem);
    this.tempoEsgotado = tempoEsgotado;
    this.status = status;
    this.recurso = recurso;
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

/** Telefone sem o 0 de longa distância nem o 55: DDD + número. */
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

/** Data de nascimento do cadastro, em AAAA-MM-DD (o IXC usa nomes diferentes conforme a versão). */
const nascimentoDe = (c) => {
  const bruto = String(c?.data_nascimento ?? c?.nascimento ?? c?.data_nasc ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(bruto)) return bruto.slice(0, 10);
  const br = bruto.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return br ? `${br[3]}-${br[2]}-${br[1]}` : null;
};

const centavos = (v) => Math.round(Number(String(v ?? 0).replace(',', '.')) * 100) || 0;
const soData = (v) => String(v ?? '').slice(0, 10);

/**
 * @param {{ url: string, token: string, timeoutMs?: number, cacheMs?: number, recursos?: object }} opcoes
 */
function criarIxc({ url, token, timeoutMs = 8000, cacheMs = 60_000, recursos = {} } = {}) {
  if (!url || !token) throw new ErroIxc('IXC sem endereço ou token configurado.');
  const R = { ...RECURSOS, ...Object.fromEntries(Object.entries(recursos ?? {}).filter(([, v]) => v)) };
  const base = `${String(url).replace(/\/+$/, '').replace(/\/webservice\/v1$/i, '')}/webservice/v1`;
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
      throw new ErroIxc(tempo ? 'O IXC não respondeu a tempo.' : 'Sem conexão com o IXC.', { tempoEsgotado: tempo, recurso });
    }
    if (resp.status === 401 || resp.status === 403) throw new ErroIxc('O IXC recusou o token.', { status: resp.status, recurso });
    if (!resp.ok) throw new ErroIxc(`O IXC respondeu com erro ${resp.status}.`, { status: resp.status, recurso });
    let dados;
    try { dados = await resp.json(); } catch { throw new ErroIxc('O IXC respondeu algo que não é JSON (confira o endereço).', { recurso }); }
    if (dados?.type === 'error' || dados?.tipo === 'erro') {
      throw new ErroIxc(String(dados.message ?? dados.mensagem ?? 'O IXC recusou a operação.').replace(/<[^>]+>/g, '').trim(), { recurso });
    }
    return dados;
  }

  /** Consulta com cache curto por conversa, para não repetir a mesma pergunta durante o atendimento. */
  async function listar(escopo, recurso, qtype, query, { oper = '=', rp = 20, sortname, sortorder = 'asc' } = {}) {
    const chave = JSON.stringify([escopo, recurso, qtype, query, oper, rp, sortname, sortorder]);
    const guardado = cache.get(chave);
    if (guardado && guardado.expira > Date.now()) return guardado.valor;
    const dados = await chamar(recurso, {
      qtype, query: String(query), oper, page: '1', rp: String(rp), sortname: sortname ?? qtype, sortorder,
    }, { listar: true });
    const valor = Array.isArray(dados?.registros) ? dados.registros : [];
    cache.set(chave, { valor, expira: Date.now() + cacheMs });
    while (cache.size > 2000) cache.delete(cache.keys().next().value);
    return valor;
  }

  const ativo = (c) => c.ativo === undefined || c.ativo === 'S';
  const esquecer = (escopo) => { for (const k of cache.keys()) if (JSON.parse(k)[0] === escopo) cache.delete(k); };

  /** Métodos com cache por conversa (escopo). */
  const metodos = (escopo) => ({
    async clientePorId(id) {
      return (await listar(escopo, R.cliente, 'cliente.id', String(id)))[0] ?? null;
    },

    /** Clientes ativos com este CPF/CNPJ (com e sem pontuação, conforme o IXC guardou). */
    async clientesPorDocumento(doc) {
      const d = digitos(doc);
      const formatado = formatarDocumento(d);
      let lista = await listar(escopo, R.cliente, 'cliente.cnpj_cpf', formatado);
      if (!lista.length && formatado !== d) lista = await listar(escopo, R.cliente, 'cliente.cnpj_cpf', d);
      return lista.filter((c) => ativo(c) && digitos(c.cnpj_cpf) === d);
    },

    /**
     * Clientes ativos com este telefone em qualquer campo (fone, celular, WhatsApp).
     * O IXC guarda o número formatado de vários jeitos: a busca é pelo final e a comparação é feita aqui.
     */
    async clientesPorTelefone(tel) {
      const d = telefoneNacional(tel);
      if (d.length < 8) return [];
      const fim = d.slice(-8);
      const padroes = [...new Set([`${fim.slice(0, 4)}-${fim.slice(4)}`, fim])];
      const campos = ['cliente.telefone_celular', 'cliente.fone', 'cliente.whatsapp'];
      const listas = await Promise.all(campos.flatMap((campo) => padroes.map((p) => listar(escopo, R.cliente, campo, p, { oper: 'L', rp: 50 })
        .catch(() => []))));
      const porId = new Map();
      for (const c of listas.flat()) {
        if (ativo(c) && [c.telefone_celular, c.fone, c.whatsapp].some((t) => mesmoTelefone(t, d))) porId.set(String(c.id), c);
      }
      return [...porId.values()];
    },

    async contratos(clienteId) {
      const lista = await listar(escopo, R.contrato, 'cliente_contrato.id_cliente', String(clienteId), { rp: 50 });
      return lista.map((c) => ({
        id: String(c.id),
        plano: c.contrato ?? c.descricao_aux_plano_venda ?? null,
        status: c.status,
        acesso: ACESSO[c.status_internet] ?? c.status_internet ?? null,
        explicacao: EXPLICACAO_ACESSO[ACESSO[c.status_internet]] ?? null,
        ativo: c.status === 'A',
        endereco: [c.endereco, c.numero, c.bairro, c.cidade].filter(Boolean).join(', ') || null,
        // Para a ficha do cliente: desde quando ele é cliente e quanto paga por mês.
        ativado_em: soData(c.data_ativacao ?? c.data_cadastro ?? c.data) || null,
        cancelado_em: soData(c.data_cancelamento) || null,
        mensalidade_centavos: centavos(c.valor ?? c.valor_plano ?? c.aviso_aux_valor ?? 0),
        motivo_cancelamento: c.obs_cancelamento ?? null,
      }));
    },

    /** Faturas em aberto, da mais antiga para a mais nova. */
    async faturasAbertas(clienteId) {
      const lista = await listar(escopo, R.receber, 'fn_areceber.id_cliente', String(clienteId), { rp: 100, sortname: 'fn_areceber.data_vencimento' });
      const hoje = new Date().toISOString().slice(0, 10);
      return lista
        .filter((f) => f.status === 'A')
        .map((f) => ({
          id: String(f.id),
          contrato_id: f.id_contrato ? String(f.id_contrato) : null,
          vencimento: soData(f.data_vencimento),
          valor_centavos: centavos(f.valor_aberto ?? f.valor),
          vencida: soData(f.data_vencimento) < hoje,
          dias_atraso: soData(f.data_vencimento) < hoje
            ? Math.floor((Date.parse(`${hoje}T12:00:00Z`) - Date.parse(`${soData(f.data_vencimento)}T12:00:00Z`)) / 86_400_000) : 0,
          linha_digitavel: f.linha_digitavel ?? null,
          pix: f.pix_copia_cola ?? f.gateway_link ?? null,
        }))
        .sort((a, b) => a.vencimento.localeCompare(b.vencimento));
    },

    /**
     * Histórico de faturas do período, pagas e em aberto. É daqui que sai a pontualidade do cliente:
     * quantas pagou, quantas pagou com atraso e quantos dias em média.
     */
    async historicoFaturas(clienteId, { meses = 12 } = {}) {
      const lista = await listar(escopo, R.receber, 'fn_areceber.id_cliente', String(clienteId), { rp: 300, sortname: 'fn_areceber.data_vencimento', sortorder: 'desc' });
      const corte = new Date(Date.now() - meses * 30 * 86_400_000).toISOString().slice(0, 10);
      const atraso = (venc, pago) => (venc && pago && pago > venc
        ? Math.round((Date.parse(`${pago}T12:00:00Z`) - Date.parse(`${venc}T12:00:00Z`)) / 86_400_000) : 0);
      return lista
        .filter((f) => soData(f.data_vencimento) >= corte && f.status !== 'C')
        .map((f) => {
          const vencimento = soData(f.data_vencimento);
          const pagamento = soData(f.data_pagamento ?? f.data_recebimento) || null;
          return {
            id: String(f.id),
            vencimento,
            pagamento,
            paga: f.status === 'R' || Boolean(pagamento),
            valor_centavos: centavos(f.valor ?? f.valor_aberto),
            dias_atraso_no_pagamento: atraso(vencimento, pagamento),
          };
        })
        .sort((a, b) => b.vencimento.localeCompare(a.vencimento));
    },

    /**
     * Faturas em aberto com vencimento numa data exata. É o que a régua de cobrança consulta:
     * "quem vence daqui a 3 dias" ou "quem venceu há 5 dias", numa consulta só para a base inteira.
     */
    async faturasComVencimento(data) {
      const lista = await listar(escopo, R.receber, 'fn_areceber.data_vencimento', data, { rp: 2000, sortname: 'fn_areceber.id' });
      return lista
        .filter((f) => f.status === 'A')
        .map((f) => ({
          id: String(f.id),
          cliente_id: String(f.id_cliente),
          contrato_id: f.id_contrato ? String(f.id_contrato) : null,
          vencimento: soData(f.data_vencimento),
          valor_centavos: centavos(f.valor_aberto ?? f.valor),
          linha_digitavel: f.linha_digitavel ?? null,
          pix: f.pix_copia_cola ?? null,
        }));
    },

    /** Uma fatura ainda está em aberto? A régua confere antes de cobrar quem já pagou. */
    async faturaEmAberto(faturaId) {
      const f = (await listar(escopo, R.receber, 'fn_areceber.id', String(faturaId), { rp: 1 }))[0];
      return f ? f.status === 'A' : null;
    },

    /** Todos os chamados do período (abertos e fechados): quantos problemas este cliente teve. */
    async historicoChamados(clienteId, { meses = 6 } = {}) {
      const lista = await listar(escopo, R.chamado, 'su_oss_chamado.id_cliente', String(clienteId), { rp: 200, sortname: 'su_oss_chamado.id', sortorder: 'desc' });
      const corte = new Date(Date.now() - meses * 30 * 86_400_000).toISOString().slice(0, 10);
      return lista
        .map((c) => ({
          id: String(c.id),
          protocolo: c.protocolo ?? String(c.id),
          assunto: c.titulo ?? c.mensagem ?? null,
          status: c.status,
          aberto: ['A', 'AN', 'EN', 'AG'].includes(String(c.status)),
          aberto_em: soData(c.data_abertura ?? c.data),
          fechado_em: soData(c.data_fechamento) || null,
        }))
        .filter((c) => c.aberto_em >= corte);
    },

    /**
     * Segunda via. `tipo`: 'mail' e 'sms' pedem ao próprio IXC que envie aos contatos do cadastro;
     * 'arquivo' devolve o PDF em base64, para a plataforma mandar pelo WhatsApp.
     */
    async boleto(faturaId, tipo = 'arquivo') {
      return chamar(R.boleto, {
        boletos: String(faturaId), juro: 'N', multa: 'N', atualiza_boleto: 'N',
        tipo_boleto: tipo, base64: tipo === 'arquivo' ? 'S' : 'N',
      });
    },

    /** Desbloqueio de confiança do contrato (o IXC aplica os próprios prazos e regras também). */
    async desbloqueioConfianca(contratoId) {
      const dados = await chamar(R.desbloqueio, { id: String(contratoId) });
      esquecer(escopo); // a situação do contrato mudou
      return String(dados?.mensagem ?? dados?.message ?? 'Contrato desbloqueado.').replace(/<[^>]+>/g, '').trim();
    },

    /** Logins de conexão do cliente (RADIUS): online agora, IP e última autenticação. */
    async logins(clienteId) {
      const lista = await listar(escopo, R.login, 'radusuarios.id_cliente', String(clienteId), { rp: 20 });
      return lista.map((l) => ({
        id: String(l.id),
        login: l.login ?? null,
        contrato_id: l.id_contrato ? String(l.id_contrato) : null,
        online: l.online === 'S',
        ip: l.ip ?? null,
        ultima_conexao: l.ultima_conexao_inicial ?? l.data_conexao ?? null,
        ultima_queda: l.ultima_conexao_final ?? null,
        // Sinal da fibra, quando o IXC guarda (varia bastante entre versões e integrações de OLT).
        sinal: l.sinal ?? l.rx_power ?? null,
      }));
    },

    /** Chamados técnicos abertos do cliente. */
    async chamadosAbertos(clienteId) {
      const lista = await listar(escopo, R.chamado, 'su_oss_chamado.id_cliente', String(clienteId), { rp: 20, sortname: 'su_oss_chamado.id', sortorder: 'desc' });
      return lista
        .filter((c) => ['A', 'AN', 'EN', 'AG'].includes(String(c.status)))
        .map((c) => ({
          id: String(c.id),
          protocolo: c.protocolo ?? String(c.id),
          assunto: c.titulo ?? c.mensagem ?? null,
          status: c.status,
          aberto_em: soData(c.data_abertura ?? c.data),
          agendado_para: c.data_agenda ? soData(c.data_agenda) : null,
        }));
    },

    /** Abre um chamado técnico (ordem de serviço) no IXC. */
    async abrirChamado({ clienteId, contratoId = null, assuntoId = null, titulo, mensagem }) {
      const dados = await chamar(R.chamado, {
        id_cliente: String(clienteId),
        ...(contratoId ? { id_contrato: String(contratoId) } : {}),
        ...(assuntoId ? { id_assunto: String(assuntoId) } : {}),
        titulo: String(titulo).slice(0, 120),
        mensagem: String(mensagem).slice(0, 2000),
        status: 'N',
        origem_endereco: 'M',
        prioridade: 'N',
      });
      const id = dados?.id ?? dados?.registro?.id ?? null;
      return {
        id: id ? String(id) : null,
        protocolo: dados?.protocolo ?? (id ? String(id) : null),
        mensagem: String(dados?.mensagem ?? dados?.message ?? 'Chamado aberto.').replace(/<[^>]+>/g, '').trim(),
      };
    },

    /** Assuntos de chamado cadastrados pelo provedor (para a IA escolher o certo). */
    async assuntos() {
      const lista = await listar(escopo, R.assunto, 'su_oss_assunto.id', '0', { oper: '>', rp: 100 });
      return lista.filter((a) => a.ativo === undefined || a.ativo === 'S').map((a) => ({ id: String(a.id), nome: a.assunto ?? a.descricao ?? `#${a.id}` }));
    },
  });

  /**
   * Sonda: testa cada capacidade nesta instância do IXC e diz o que funciona.
   * Só de leitura — nunca abre chamado nem desbloqueia nada.
   */
  async function diagnosticar() {
    const m = metodos('diagnostico');
    const testes = [
      ['cliente', 'Consultar cliente', () => listar('diagnostico', R.cliente, 'cliente.id', '0', { oper: '>', rp: 1 })],
      ['contrato', 'Ler contratos e situação do acesso', () => listar('diagnostico', R.contrato, 'cliente_contrato.id', '0', { oper: '>', rp: 1 })],
      ['receber', 'Listar faturas em aberto', () => listar('diagnostico', R.receber, 'fn_areceber.id', '0', { oper: '>', rp: 1 })],
      ['login', 'Ver se a conexão está online (RADIUS)', () => listar('diagnostico', R.login, 'radusuarios.id', '0', { oper: '>', rp: 1 })],
      ['chamado', 'Abrir e consultar chamado técnico', () => listar('diagnostico', R.chamado, 'su_oss_chamado.id', '0', { oper: '>', rp: 1 })],
      ['assunto', 'Ler os assuntos de chamado do provedor', () => m.assuntos()],
    ];
    const capacidades = {};
    for (const [chave, nome, fn] of testes) {
      try {
        const r = await fn();
        capacidades[chave] = { nome, ok: true, recurso: R[chave], amostra: Array.isArray(r) ? r.length : null };
      } catch (err) {
        capacidades[chave] = { nome, ok: false, recurso: R[chave], erro: err.message };
      }
    }
    // Boleto e desbloqueio mudam dados ou dependem de um id real: a sonda não os dispara.
    capacidades.boleto = { nome: 'Enviar segunda via do boleto', ok: capacidades.receber.ok, recurso: R.boleto, nao_testado: true };
    capacidades.desbloqueio = { nome: 'Desbloqueio de confiança', ok: capacidades.contrato.ok, recurso: R.desbloqueio, nao_testado: true };
    return {
      conectado: capacidades.cliente.ok,
      capacidades,
      resumo: Object.entries(capacidades).filter(([, c]) => c.ok).map(([k]) => k),
    };
  }

  return { ...metodos(''), conversa: (id) => metodos(`conversa:${id}`), diagnosticar, recursos: R };
}

/** Erro do IXC pronto para a API do painel. */
const comoErroNegocio = (err) => new ErroNegocio(err instanceof ErroIxc ? err.message : 'Falha ao falar com o IXC.', 502);

module.exports = {
  criarIxc, ErroIxc, RECURSOS, ACESSO, EXPLICACAO_ACESSO,
  mesmoTelefone, telefoneNacional, formatarDocumento, nascimentoDe, comoErroNegocio, digitos,
};
