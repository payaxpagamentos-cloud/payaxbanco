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
  // Edição de título já existente (o SAC da IXC indicou esta rota para alterar o nosso número).
  alterarReceber: 'fn_areceber_altera',
  // "Receber" do Contas a Receber: é a baixa de verdade (gera o recebimento na conta e libera o cliente).
  baixa: 'fn_areceber_recebimentos_baixas_novo',
  recebimentos: 'fn_areceber_baixas',
  carteira: 'fn_carteira_cobranca',
  arquivosCliente: 'cliente_arquivos',
  // Arquivos da própria fatura: a tela existe (Contas a receber → Arquivos), mas a rota não está na
  // documentação da API. O nome segue o padrão do Contas a Pagar e só é usado depois de o diagnóstico confirmar.
  arquivosTitulo: 'fn_areceber_arquivos',
};

/** Campos que a rota "Alterar boleto" (fn_areceber_altera) aceita. */
const CAMPOS_ALTERA = ['documento', 'data_emissao', 'data_vencimento', 'id_carteira_cobranca', 'obs', 'tipo_recebimento', 'status',
  'aguardando_confirmacao_pagamento', 'nn_boleto', 'pix_txid', 'libera_periodo', 'liberado', 'titulo_protestado', 'id_remessa_alteracao', 'motivo_alteracao'];

/** Campos do modelo de edição completa do título (PUT fn_areceber): o IXC valida o registro inteiro. */
const CAMPOS_EDITAR = ['id_cliente', 'id_conta', 'id_conta_class_finan_a', 'filial_id', 'documento', 'data_emissao', 'data_vencimento', 'valor', 'previsao',
  'tipo_recebimento', 'id_carteira_cobranca', 'obs', 'status', 'id_saida', 'liberado', 'gerencianet_token', 'tipo_conta', 'id_cobranca', 'status_cobranca',
  'id_nota_gerada', 'id_im_imovel', 'impresso', 'arquivo_remessa_baixado', 'duplicata', 'id_sip', 'tipo_renegociacao', 'id_renegociacao', 'id_renegociacao_novo',
  'forma_recebimento', 'credito_data', 'baixa_data', 'baixa_id_operador', 'cancelamento_id_operador', 'numero_parcela_recorrente', 'nparcela',
  'id_contrato_principal', 'previsao_conta_receita', 'tipo_cobranca', 'parcela_proporcional', 'tipo_pagamento_cartao', 'titulo_protestado',
  'desconto_condicional_valor', 'validade_desconto_condicional', 'id_nota_gerada_opc2', 'id_nota_gerada_opc3', 'id_nota_gerada_opc4',
  'id_lote_geracao_financeiro_fatura', 'valor_aberto', 'valor_recebido', 'pagamento_valor', 'pagamento_data', 'valor_cancelado', 'data_cancelamento',
  'titulo_importado', 'aguardando_confirmacao_pagamento', 'parcelado_cartao', 'recebido_via_pix', 'id_remessa', 'nn_boleto', 'boleto', 'gateway_link',
  'linha_digitavel', 'id_remessa_alteracao', 'motivo_alteracao', 'pix_txid', 'libera_periodo', 'id_mot_cancelamento', 'id_contrato', 'id_contrato_avulso',
  'ultima_atualizacao', 'id_conta_class_finan', 'valor_class_finan', 'json_class_finan', 'id_nf_gerada', 'id_nf_opcional2', 'id_nf_opcional3', 'id_nf_opcional4'];

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
  nossoNumero: 'nn_boleto',     // "nosso número" do título (nome confirmado pelo SAC da IXC)
  carteira: 'id_carteira_cobranca',
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
/** Valor para a baixa: o IXC pede vírgula decimal e sem ponto ("1234,56"). */
const paraReaisVirgula = (c) => (c / 100).toFixed(2).replace('.', ',');

/**
 * Valor lido do IXC devolvido numa gravação: a leitura traz datas como AAAA-MM-DD e a escrita exige DD/MM/AAAA
 * (data "zerada" vai vazia). O resto volta como veio.
 */
function paraEscrita(v) {
  if (v === null || v === undefined) return '';
  const t = String(v);
  if (/^0000-00-00/.test(t)) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})(\s.*)?$/.exec(t);
  return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ?? ''}` : t;
}

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
    carteira: String(t[CAMPOS.carteira] ?? ''),
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
        complemento: c.complemento ?? null,
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
        recebidos: r.registros.length,   // da página, antes do filtro (para saber se há mais páginas)
        titulos: r.registros.map(traduzirTitulo).filter((t) => t.status === 'A' && t.valor_centavos > 0),
      };
    },

    async tituloPorId(id) {
      const r = await listar(RECURSOS.receber, `${RECURSOS.receber}.${CAMPOS.id}`, id, { rp: 1 });
      return r.registros[0] ? traduzirTitulo(r.registros[0]) : null;
    },

    /** O título como o IXC devolve (todos os campos), ou null. */
    async tituloBruto(id) {
      const r = await listar(RECURSOS.receber, `${RECURSOS.receber}.${CAMPOS.id}`, id, { rp: 1 });
      return r.registros[0] ?? null;
    },

    /**
     * Altera campos do título pela rota "Alterar boleto". A rota grava o que recebe: por isso lê o título e
     * devolve os valores atuais dos outros campos (com `liberado = S`, senão a fatura some das telas do IXC).
     */
    async alterarTitulo(ixcId, mudancas) {
      const atual = await this.tituloBruto(ixcId);
      if (!atual) throw new ErroIxc(`Título ${ixcId} não encontrado no IXC.`);
      const corpo = Object.fromEntries(CAMPOS_ALTERA.map((k) => [k, paraEscrita(atual[k])]));
      Object.assign(corpo, mudancas);
      corpo.liberado = corpo.liberado || 'S';
      return chamar(RECURSOS.alterarReceber, corpo, { metodo: 'PUT', sufixo: `/${ixcId}` });
    },

    /** Grava no IXC o nosso número do boleto emitido, para o provedor ver no título de origem. */
    async anotarBoleto(ixcId, { nosso_numero }) {
      return this.alterarTitulo(ixcId, { [CAMPOS.nossoNumero]: nosso_numero });
    },

    /**
     * Grava o link do boleto no campo "Link gateway" do título. Só a edição completa (PUT fn_areceber) tem esse
     * campo, e o IXC valida o registro inteiro: lê o título, devolve tudo como está e muda só o link. Depois
     * relê e diz se o link ficou gravado e se algum outro campo importante mudou.
     */
    async gravarLink(ixcId, link, { extras = {} } = {}) {
      const antes = await this.tituloBruto(ixcId);
      if (!antes) throw new ErroIxc(`Título ${ixcId} não encontrado no IXC.`);
      const corpo = Object.fromEntries(CAMPOS_EDITAR.map((k) => [k, paraEscrita(antes[k])]));
      corpo.gateway_link = link;
      corpo.liberado = corpo.liberado || 'S';
      Object.assign(corpo, extras);
      await chamar(RECURSOS.receber, corpo, { metodo: 'PUT', sufixo: `/${ixcId}` });
      const depois = await this.tituloBruto(ixcId);
      const vigiados = ['valor', 'valor_aberto', 'data_vencimento', 'status', 'id_carteira_cobranca', 'liberado', 'nn_boleto', 'id_cliente', 'id_contrato'];
      const mudou = vigiados.filter((k) => String(antes[k] ?? '') !== String(depois?.[k] ?? ''))
        .map((k) => ({ campo: k, antes: antes[k] ?? '', depois: depois?.[k] ?? '' }));
      return { gravado: String(depois?.gateway_link ?? '') === String(link), link_lido: depois?.gateway_link ?? '', mudou };
    },

    /** Conta (caixa/banco) ligada à carteira de cobrança: é onde o IXC lança o recebimento. */
    async carteiraBruta(carteiraId) {
      if (!carteiraId) return null;
      const r = await listar(RECURSOS.carteira, `${RECURSOS.carteira}.id`, carteiraId, { rp: 1 });
      return r.registros[0] ?? null;
    },

    async contaDaCarteira(carteiraId) {
      const c = await this.carteiraBruta(carteiraId);
      return c?.id_conta ? String(c.id_conta) : null;
    },

    /**
     * Anexa um arquivo (o PDF do boleto). `onde`: 'cliente' = aba Arquivos do cadastro do cliente (rota documentada);
     * 'titulo' = aba Arquivos da fatura (rota não documentada: use depois de o diagnóstico confirmar).
     */
    async anexarArquivo({ onde = 'cliente', clienteId, contratoId = null, tituloId = null, descricao, nome, conteudo, tipo = 'application/pdf' }) {
      await conferirEndereco(base);
      const form = new FormData();
      form.set('descricao', String(descricao).slice(0, 100));
      const arquivo = new Blob([conteudo], { type: tipo });
      let recurso = RECURSOS.arquivosCliente;
      if (onde === 'titulo') {
        recurso = RECURSOS.arquivosTitulo;
        form.set('id_areceber', String(tituloId));
        form.set('arquivo', arquivo, nome);
      } else {
        form.set('id_cliente', String(clienteId));
        if (contratoId) form.set('id_contrato', String(contratoId));
        form.set('local_arquivo', arquivo, nome);
      }
      let resp;
      try {
        // Sem Content-Type: o próprio envio define o multipart com a fronteira certa.
        resp = await fetch(`${base}/${recurso}`, { method: 'POST', headers: { Authorization: autorizacao }, body: form, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        const tempo = err.name === 'TimeoutError' || err.name === 'AbortError';
        throw new ErroIxc(tempo ? 'O IXC não respondeu a tempo.' : `Sem conexão com o IXC: ${err.message}`, { tempoEsgotado: tempo });
      }
      if (resp.status === 401 || resp.status === 403) throw new ErroIxc('O IXC recusou o token (confira usuário e token na instância).', { status: resp.status });
      if (!resp.ok) throw new ErroIxc(`O IXC respondeu com erro ${resp.status}.`, { status: resp.status });
      let dados;
      try { dados = await resp.json(); } catch { throw new ErroIxc('O IXC respondeu algo que não é JSON ao receber o arquivo.'); }
      if (dados?.type === 'error' || dados?.tipo === 'erro') {
        throw new ErroIxc(String(dados.message ?? dados.mensagem ?? 'O IXC recusou o arquivo.').replace(/<[^>]+>/g, '').trim());
      }
      return { id: dados?.id ?? null };
    },

    /**
     * Dá baixa no título quando o boleto é liquidado, pela rota do botão "Receber" (gera o recebimento na conta
     * e desbloqueia o cliente). Pagou a mais (multa e juros) vira acréscimo; a menos, desconto.
     *   conta ......... conta/caixa do IXC onde o dinheiro entra (padrão: a conta da carteira do título);
     *   planejamento .. planejamento analítico (padrão: o do próprio título).
     */
    async baixarTitulo(ixcId, { data_recebimento, valor_centavos, observacao, conta = null, planejamento = null, pix = false }) {
      const t = await this.tituloBruto(ixcId);
      if (!t) throw new ErroIxc(`Título ${ixcId} não encontrado no IXC.`);
      if (String(t[CAMPOS.status]) === 'R') return { ja_recebido: true };
      if (String(t[CAMPOS.status]) === 'C') throw new ErroIxc(`O título ${ixcId} está cancelado no IXC: a baixa não foi lançada. Confira com o cliente.`);
      const contaIxc = conta || await this.contaDaCarteira(t[CAMPOS.carteira]);
      if (!contaIxc) throw new ErroIxc('Não achei a conta do IXC para lançar a baixa: informe a "Conta para a baixa" na configuração do sistema do cliente.');
      const aberto = paraCentavos(t.valor_aberto) || paraCentavos(t[CAMPOS.valor]);
      const diferenca = valor_centavos - aberto;
      const corpo = {
        filial_id: String(t.filial_id ?? ''),
        id_receber: String(ixcId),
        conta_: String(contaIxc),
        id_conta: String(planejamento || t.id_conta || ''),
        tipo_recebimento: pix ? 'P' : 'B',
        data: paraEscrita(data_recebimento),
        documento: String(t[CAMPOS.documento] || `PAYAX-${ixcId}`).slice(0, 30),
        pdesconto: '',
        vdesconto: diferenca < 0 ? paraReaisVirgula(-diferenca) : '',
        id_motivo_desconto: '',
        pacrescimo: '',
        vacrescimo: diferenca > 0 ? paraReaisVirgula(diferenca) : '',
        valor_parcela: paraReaisVirgula(aberto),
        credito: paraReaisVirgula(valor_centavos),
        debito: '',
        valor_total_recebido: paraReaisVirgula(valor_centavos),
        historico: String(observacao ?? 'Baixa automática PAY AX').slice(0, 200),
        tipo_r: 'T',
        previsao: 'S',
        tipo_lanc: 'R',
      };
      await chamar(RECURSOS.baixa, corpo);
      // O IXC pode responder "sucesso" sem ter baixado: confere o título depois.
      const depois = await this.tituloBruto(ixcId);
      if (String(depois?.[CAMPOS.status]) !== 'R') {
        throw new ErroIxc(`O IXC aceitou a baixa do título ${ixcId}, mas ele continua em aberto (situação "${depois?.[CAMPOS.status] ?? '?'}"). Confira a conta e o planejamento da baixa.`);
      }
      return { ok: true };
    },
  };
}

module.exports = { criarIxc, ErroIxc, RECURSOS, CAMPOS, CAMPOS_ALTERA, CAMPOS_EDITAR, paraCentavos, paraData, paraEscrita };
