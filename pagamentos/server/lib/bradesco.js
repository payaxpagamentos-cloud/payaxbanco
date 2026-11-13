'use strict';

/**
 * Conector do Bradesco — Cobrança Registrada (boleto), Boleto Híbrido (Bolepix) e PIX de repasse.
 *
 * Dois modos, escolhidos em PAYAX_BANCO_MODO:
 *   - 'simulador': registra o título localmente (código de barras e BR Code calculados aqui, pelo padrão FEBRABAN
 *     e EMV do Banco Central). É o modo de desenvolvimento e de homologação interna — nenhum dado sai do servidor.
 *   - 'bradesco': fala com a API do banco (OAuth2 com JWT assinado pelo certificado + mTLS).
 *
 * TODO AO RECEBER AS CREDENCIAIS: os caminhos e os nomes de campo abaixo seguem a documentação da API de Cobrança
 * do Bradesco, mas variam por contrato e por versão. Estão todos reunidos em ENDPOINTS e nas funções de mapeamento
 * (paraApi / daApi) para serem ajustados em um lugar só, contra o ambiente de homologação do banco.
 */
const crypto = require('node:crypto');
const https = require('node:https');
const config = require('../config');
const febraban = require('./febraban');
const pix = require('./pix');
const { ErroNegocio } = require('./erros');

const HOSTS = {
  homologacao: 'https://proxy.api.prebanco.com.br',
  producao: 'https://openapi.bradesco.com.br',
};

const ENDPOINTS = {
  token: '/auth/server/v1.1/token',
  registrar: '/boleto/cobranca-registro/v1/boletos',
  consultar: '/boleto/cobranca-consulta/v1/boletos',
  baixar: '/boleto/cobranca-registro/v1/boletos/baixa',
  pix_pagamento: '/pix/pagamento/v1/pagamentos',
};

class ErroBanco extends Error {
  constructor(mensagem, { status, codigo, tempoEsgotado = false, detalhes } = {}) {
    super(mensagem);
    this.status = status;
    this.codigo = codigo;
    this.tempoEsgotado = tempoEsgotado;
    this.detalhes = detalhes;
  }
}

const so = (s) => String(s ?? '').replace(/\D/g, '');
const semAcento = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, '').trim();
const dataBr = (iso) => (iso ? iso.split('-').reverse().join('.') : '');

// ----------------------------------------------------------------- Simulador

/**
 * Registra o título sem sair do servidor: calcula o código de barras e a linha digitável pelo padrão FEBRABAN
 * e, no Bolepix, o BR Code com a chave PIX da conta. É o que a tela e os testes usam enquanto o contrato
 * com o banco não está ligado.
 */
function simulador(conta) {
  return {
    modo: 'simulador',
    async testar() {
      return { ok: true, mensagem: 'Modo simulador: os boletos são registrados localmente, sem chamar o banco.' };
    },
    async registrar(boleto) {
      const calc = febraban.boletoBradesco({
        agencia: conta.agencia,
        conta: conta.conta,
        carteira: conta.carteira,
        nossoNumero: boleto.nosso_numero,
        valorCentavos: boleto.valor_centavos,
        vencimento: boleto.vencimento,
      });
      const bolepix = boleto.tipo === 'bolepix';
      return {
        ...calc,
        pix_txid: bolepix ? `PAYAX${String(boleto.nosso_numero).padStart(11, '0')}` : null,
        pix_emv: bolepix
          ? pix.copiaECola({
            chave: conta.pix_chave,
            nome: conta.beneficiario_nome,
            cidade: conta.beneficiario_cidade,
            valorCentavos: boleto.valor_centavos,
            txid: `PAYAX${String(boleto.nosso_numero).padStart(11, '0')}`,
          })
          : null,
        protocolo: `SIM-${Date.now().toString(36).toUpperCase()}`,
      };
    },
    async consultar(nossoNumero) {
      // O simulador não tem estado próprio: quem sabe da situação é o nosso banco de dados.
      return { nosso_numero: nossoNumero, situacao: null, simulado: true };
    },
    async baixar() {
      return { ok: true, protocolo: `SIM-BX-${Date.now().toString(36).toUpperCase()}` };
    },
    async pagarPix({ chave, valor_centavos, descricao }) {
      if (!chave) throw new ErroBanco('Repasse sem chave PIX de destino.');
      return {
        end_to_end: `E${conta.banco}${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
        situacao: 'confirmado',
        valor_centavos,
        descricao,
        simulado: true,
      };
    },
  };
}

// ----------------------------------------------------------------- API do Bradesco

/** Corpo que a API espera para registrar um boleto. Ajustar aqui ao ligar o contrato. */
function paraApi(boleto, conta) {
  const p = {
    nuCPFCNPJ: so(conta.beneficiario_documento).slice(0, -6) || so(conta.beneficiario_documento),
    filialCPFCNPJ: so(conta.beneficiario_documento).slice(-6, -2) || '0',
    ctrlCPFCNPJ: so(conta.beneficiario_documento).slice(-2),
    cdTipoAcesso: '2',
    clubBanco: Number(conta.cedente) || 0,
    cdTipoContrato: 48,
    nuSequenciaContrato: 0,
    idProduto: Number(conta.carteira) || 9,
    nuNegociacao: `${so(conta.agencia).padStart(4, '0')}${so(conta.conta).padStart(7, '0')}`,
    cdBanco: Number(conta.banco) || 237,
    eNumeroTitulo: String(boleto.nosso_numero),
    dtEmissaoTitulo: dataBr(boleto.emissao),
    dtVencimentoTitulo: dataBr(boleto.vencimento),
    tpVencimento: 0,
    vlNominalTitulo: boleto.valor_centavos,
    cdEspecieTitulo: 2, // 02 = duplicata mercantil
    tpProtestoAutomaticoNegativacao: 0,
    prazoProtestoAutomaticoNegativacao: 0,
    controleParticipante: String(boleto.seu_numero ?? '').slice(0, 25),
    cdPagamentoParcial: 'N',
    qtdePagamentoParcial: 0,
    // Pagador
    nomePagador: semAcento(boleto.pagador_nome).slice(0, 70),
    logradouroPagador: semAcento(boleto.pagador_endereco).slice(0, 40),
    nuLogradouroPagador: String(boleto.pagador_numero ?? '').slice(0, 10),
    complementoLogradouroPagador: '',
    cepPagador: Number(so(boleto.pagador_cep).slice(0, 5)) || 0,
    complementoCepPagador: Number(so(boleto.pagador_cep).slice(5)) || 0,
    bairroPagador: semAcento(boleto.pagador_bairro).slice(0, 40),
    municipioPagador: semAcento(boleto.pagador_cidade).slice(0, 30),
    ufPagador: String(boleto.pagador_uf ?? '').toUpperCase().slice(0, 2),
    cdIndCpfcnpjPagador: so(boleto.pagador_documento).length === 11 ? 1 : 2,
    nuCpfcnpjPagador: Number(so(boleto.pagador_documento)),
    // Encargos: o Bradesco recebe percentuais com 5 casas (escala 100000 = 1%) — converte do nosso ppm.
    percentualJuros: Math.round((boleto.juros_mes_ppm || 0) / 10),
    percentualMulta: Math.round((boleto.multa_ppm || 0) / 10),
    vlDesconto1: boleto.desconto_centavos || 0,
    dataLimiteDesconto1: dataBr(boleto.desconto_ate),
    prazoBaixaTitulo: boleto.dias_baixa ?? 60,
    primeiraInstrucao: semAcento(boleto.mensagem).slice(0, 80),
  };
  // Boleto híbrido: pede ao banco o QR Code PIX no mesmo título.
  if (boleto.tipo === 'bolepix') {
    p.cdTipoQrCode = 1;
    p.chaveRecebedorQrCode = conta.pix_chave ?? '';
  }
  return p;
}

/** Normaliza a resposta do banco para o formato que o sistema usa. */
function daApi(resp, boleto, conta) {
  const barras = so(resp.cdBarras ?? resp.codigoBarras ?? resp.codBarras ?? '');
  const linha = so(resp.linhaDigitavel ?? resp.cdLinhaDigitavel ?? '');
  const calc = febraban.boletoBradesco({
    agencia: conta.agencia, conta: conta.conta, carteira: conta.carteira,
    nossoNumero: boleto.nosso_numero, valorCentavos: boleto.valor_centavos, vencimento: boleto.vencimento,
  });
  return {
    codigo_barras: barras.length === 44 ? barras : calc.codigo_barras,
    linha_digitavel: linha.length === 47 ? linha : calc.linha_digitavel,
    nosso_numero: calc.nosso_numero,
    nosso_numero_dv: String(resp.digitoNossoNumero ?? resp.dvNossoNumero ?? calc.nosso_numero_dv),
    pix_txid: resp.txidQrCode ?? resp.txId ?? null,
    pix_emv: resp.emvQrCode ?? resp.qrCodePix ?? resp.emv ?? null,
    protocolo: String(resp.nuProtocolo ?? resp.protocolo ?? ''),
  };
}

/** Situação do título na consulta do banco → situação interna. */
function situacaoDaApi(codigo) {
  const mapa = {
    1: 'registrado', 2: 'registrado', 3: 'liquidado', 4: 'liquidado', 5: 'baixado', 6: 'baixado', 9: 'falha',
    NORMAL: 'registrado', LIQUIDADO: 'liquidado', BAIXADO: 'baixado', CANCELADO: 'baixado',
  };
  return mapa[codigo] ?? mapa[String(codigo).toUpperCase()] ?? null;
}

/**
 * Cliente da API. `credenciais`: { client_id, client_secret, certificado_pem, chave_privada_pem, chave_senha }.
 * O certificado nunca sai do servidor: é usado no mTLS e para assinar o JWT de autenticação.
 */
function apiBradesco(conta, credenciais, opcoes = {}) {
  const base = opcoes.host || HOSTS[opcoes.ambiente || config.banco.ambiente] || HOSTS.homologacao;
  const timeoutMs = opcoes.timeoutMs ?? config.banco.timeoutMs;
  let token = null;

  const agente = credenciais.certificado_pem && credenciais.chave_privada_pem
    ? new https.Agent({
      cert: credenciais.certificado_pem,
      key: credenciais.chave_privada_pem,
      passphrase: credenciais.chave_senha || undefined,
      keepAlive: true,
    })
    : undefined;

  /** JWT assinado com a chave privada do certificado (assertion do OAuth2). */
  function assertion() {
    const cabecalho = { alg: 'RS256', typ: 'JWT' };
    const agoraS = Math.floor(Date.now() / 1000);
    const corpo = {
      aud: `${base}${ENDPOINTS.token}`,
      sub: credenciais.client_id,
      iat: agoraS,
      exp: agoraS + 3600,
      jti: crypto.randomUUID(),
      ver: '1.1',
    };
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const entrada = `${b64(cabecalho)}.${b64(corpo)}`;
    const assinatura = crypto.sign('RSA-SHA256', Buffer.from(entrada), {
      key: credenciais.chave_privada_pem,
      passphrase: credenciais.chave_senha || undefined,
    }).toString('base64url');
    return `${entrada}.${assinatura}`;
  }

  async function chamar(caminho, { metodo = 'POST', corpo, autenticado = true } = {}) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (autenticado) headers.Authorization = `Bearer ${await autenticar()}`;
    let resp;
    try {
      resp = await fetch(`${base}${caminho}`, {
        method: metodo,
        headers,
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
        signal: AbortSignal.timeout(timeoutMs),
        ...(agente ? { dispatcher: undefined, agent: agente } : {}),
      });
    } catch (err) {
      const tempo = err.name === 'TimeoutError' || err.name === 'AbortError';
      throw new ErroBanco(tempo ? 'O Bradesco não respondeu a tempo.' : `Sem conexão com o Bradesco: ${err.message}`, { tempoEsgotado: tempo });
    }
    const texto = await resp.text();
    let dados = null;
    try { dados = texto ? JSON.parse(texto) : null; } catch { dados = { bruto: texto }; }
    if (resp.status === 401 || resp.status === 403) {
      token = null;
      throw new ErroBanco('O Bradesco recusou as credenciais (confira o certificado e o client_id).', { status: resp.status, detalhes: dados });
    }
    if (!resp.ok) {
      const msg = dados?.message ?? dados?.mensagem ?? dados?.erros?.[0]?.mensagem ?? `erro ${resp.status}`;
      throw new ErroBanco(`O Bradesco recusou a operação: ${msg}`, { status: resp.status, codigo: dados?.codigo, detalhes: dados });
    }
    return dados;
  }

  async function autenticar() {
    if (token && token.expira > Date.now() + 30_000) return token.valor;
    const corpo = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: assertion(),
    });
    let resp;
    try {
      resp = await fetch(`${base}${ENDPOINTS.token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: corpo,
        signal: AbortSignal.timeout(timeoutMs),
        ...(agente ? { agent: agente } : {}),
      });
    } catch (err) {
      throw new ErroBanco(`Não foi possível autenticar no Bradesco: ${err.message}`, { tempoEsgotado: err.name === 'TimeoutError' });
    }
    const dados = await resp.json().catch(() => null);
    if (!resp.ok || !dados?.access_token) {
      throw new ErroBanco('O Bradesco não devolveu o token de acesso.', { status: resp.status, detalhes: dados });
    }
    token = { valor: dados.access_token, expira: Date.now() + (Number(dados.expires_in) || 600) * 1000 };
    return token.valor;
  }

  return {
    modo: 'bradesco',
    async testar() {
      await autenticar();
      return { ok: true, mensagem: `Autenticado no Bradesco (${opcoes.ambiente || config.banco.ambiente}).` };
    },
    async registrar(boleto) {
      const resp = await chamar(ENDPOINTS.registrar, { corpo: paraApi(boleto, conta) });
      return daApi(resp ?? {}, boleto, conta);
    },
    async consultar(nossoNumero) {
      const resp = await chamar(`${ENDPOINTS.consultar}`, {
        corpo: { nuNegociacao: `${so(conta.agencia).padStart(4, '0')}${so(conta.conta).padStart(7, '0')}`, eNumeroTitulo: String(nossoNumero) },
      });
      const t = resp?.titulos?.[0] ?? resp ?? {};
      return {
        nosso_numero: String(nossoNumero),
        situacao: situacaoDaApi(t.cdSituacaoTitulo ?? t.situacao),
        pago_valor_centavos: Number(t.vlPagoTitulo ?? t.valorPago ?? 0) || null,
        pago_em: t.dtCreditoTitulo ? String(t.dtCreditoTitulo).split('.').reverse().join('-') : null,
        bruto: t,
      };
    },
    async baixar(nossoNumero, motivo) {
      const resp = await chamar(ENDPOINTS.baixar, {
        corpo: {
          nuNegociacao: `${so(conta.agencia).padStart(4, '0')}${so(conta.conta).padStart(7, '0')}`,
          eNumeroTitulo: String(nossoNumero),
          cdMotivoBaixa: 1,
          observacao: semAcento(motivo).slice(0, 60),
        },
      });
      return { ok: true, protocolo: String(resp?.nuProtocolo ?? '') };
    },
    async pagarPix({ chave, tipo_chave, valor_centavos, descricao, documento_titular }) {
      const resp = await chamar(ENDPOINTS.pix_pagamento, {
        corpo: {
          contaDebito: { agencia: so(conta.agencia), conta: so(conta.conta) },
          chaveDestino: chave,
          tipoChave: tipo_chave,
          valor: (valor_centavos / 100).toFixed(2),
          descricao: semAcento(descricao).slice(0, 140),
          cpfCnpjRecebedor: so(documento_titular) || undefined,
        },
      });
      return {
        end_to_end: resp?.endToEndId ?? resp?.e2eId ?? null,
        situacao: String(resp?.status ?? '').toUpperCase() === 'CONCLUIDO' ? 'confirmado' : 'enviado',
        bruto: resp,
      };
    },
  };
}

/**
 * Modo arquivo (CNAB 400): o código de barras é calculado aqui, igual ao simulador, mas o registro
 * acontece pela REMESSA e a confirmação chega pelo RETORNO. A baixa também vira instrução na remessa.
 * O PIX do repasse não passa por arquivo: usa a API quando houver credencial.
 */
function porArquivo(conta, credenciais) {
  const local = simulador(conta);
  return {
    ...local,
    modo: 'cnab',
    async testar() {
      return { ok: true, mensagem: 'Modo arquivo (CNAB 400): o registro vai na remessa e a conciliação vem do retorno.' };
    },
    async registrar(boleto) {
      // Sem chamada ao banco: o título entra na próxima remessa e fica aguardando a confirmação.
      return { ...(await local.registrar(boleto)), protocolo: 'CNAB', aguardando_remessa: true };
    },
    async baixar() {
      return { ok: true, por_arquivo: true };
    },
    async pagarPix(dados) {
      if (!credenciais?.client_id) {
        throw new ErroNegocio('O repasse por PIX precisa das credenciais da API do Bradesco (Integrações → Banco). O arquivo CNAB cobre só a cobrança.', 409);
      }
      return apiBradesco(conta, credenciais).pagarPix(dados);
    },
  };
}

/**
 * Devolve o conector da conta. `credenciais` vem decifrada da tabela integracoes.
 * Sem credenciais em modo 'bradesco', recusa — nunca cai em silêncio para o simulador em produção.
 */
function criarBanco(conta, credenciais = null, opcoes = {}) {
  const modo = opcoes.modo || config.banco.modo;
  if (modo === 'simulador') return simulador(conta);
  if (modo === 'cnab') return porArquivo(conta, credenciais);
  if (!credenciais?.client_id) {
    throw new ErroNegocio('A integração com o Bradesco ainda não foi configurada (Integrações → Banco).', 409);
  }
  return apiBradesco(conta, credenciais, opcoes);
}

module.exports = { criarBanco, simulador, porArquivo, apiBradesco, ErroBanco, situacaoDaApi, HOSTS, ENDPOINTS };
