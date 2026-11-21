'use strict';

/*
 * Adaptadores de API bancária (registro).
 *
 * Aqui ficam as integrações ONLINE com instituições — registro de boleto por API, consulta de PIX
 * recebido, conciliação automática — e a PayAx. Hoje o registro está VAZIO, e isso é proposital.
 *
 * Por que vazio: cada banco publica seu próprio manual (endpoints, escopos OAuth, formato do corpo,
 * certificado mTLS, ambiente de homologação) e esse manual só sai depois do credenciamento. Escrever
 * um adaptador "de memória" produziria chamadas que falham em produção — e, pior, um sistema que PARECE
 * conectado. O provedor só descobriria no primeiro boleto que o cliente não consegue pagar.
 *
 * Enquanto não há adaptador, a cobrança funciona inteira pelo caminho offline, que não depende de
 * credenciamento nenhum:
 *   - PIX  -> BR Code gerado localmente a partir da chave (lib/pix.js);
 *   - boleto -> código de barras e linha digitável montados localmente (lib/boleto.js);
 *   - registro e baixa -> arquivo de remessa e retorno CNAB (lib/cnab.js).
 *
 * Para ligar um banco (ou a PayAx) é só implementar o contrato abaixo e chamar registrar(). Nada no
 * núcleo precisa mudar: emissão, conciliação e tela já perguntam ao registro o que existe.
 */

const ACOES = ['registrar', 'consultar', 'baixar', 'extrato', 'pix_cobranca', 'pix_consultar'];

/*
 * Contrato de um adaptador:
 *
 * {
 *   nome: 'payax',                      // identificador estável, usado no banco de dados
 *   rotulo: 'PayAx',                    // como aparece na tela
 *   instituicao: '000',                 // código FEBRABAN, ou null para quem não é banco
 *   autenticacao: 'oauth2_mtls',        // só informativo: o que o provedor precisa providenciar
 *   capacidades: ['registrar', 'pix_cobranca', 'pix_consultar'],
 *   campos: [                           // o que a tela pede ao configurar a conta
 *     { nome: 'client_id', rotulo: 'Client ID', segredo: false, obrigatorio: true },
 *     { nome: 'client_secret', rotulo: 'Client Secret', segredo: true, obrigatorio: true },
 *   ],
 *   homologacao: 'https://...',         // ambiente de teste, quando existe
 *
 *   async registrar(ctx, { conta, cobranca, fatura, pagador }) -> { situacao, nosso_numero?, linha_digitavel?, codigo_barras?, url? }
 *   async consultar(ctx, { conta, cobranca }) -> { situacao, pago_em?, valor_pago_centavos?, juros_centavos? }
 *   async baixar(ctx, { conta, cobranca, motivo }) -> { situacao }
 *   async extrato(ctx, { conta, de, ate }) -> [{ data, valor_centavos, identificador, descricao }]
 *   async pix_cobranca(ctx, { conta, fatura, valor_centavos, vencimento }) -> { txid, brcode, url? }
 *   async pix_consultar(ctx, { conta, txid }) -> { situacao, pago_em?, valor_centavos?, pagador? }
 * }
 *
 * ctx traz { segredos, config, log } — os segredos já decifrados pelo cofre, nunca lidos do disco
 * pelo adaptador, e nunca registrados em log.
 *
 * Regras que valem para todo adaptador:
 *   1. Toda escrita é idempotente por (conta, cobranca). Reenviar o mesmo registro não pode gerar
 *      dois títulos no banco.
 *   2. O adaptador NUNCA dá baixa no financeiro. Ele devolve o que o banco disse; quem mexe em
 *      fatura é lib/cobrancas.js, pelo mesmo caminho do retorno CNAB.
 *   3. Falha de rede é erro temporário (repetir); recusa do banco é erro definitivo (mostrar o motivo).
 *   4. Nada de valor em ponto flutuante: centavos inteiros, igual ao resto do sistema.
 */

const REGISTRO = new Map();

function registrar(adaptador) {
  const { nome, rotulo, capacidades } = adaptador ?? {};
  if (!nome || !/^[a-z0-9_]{2,30}$/.test(nome)) throw new Error('Adaptador bancário sem nome válido.');
  if (!rotulo) throw new Error(`Adaptador ${nome} sem rótulo.`);
  if (!Array.isArray(capacidades) || !capacidades.length) throw new Error(`Adaptador ${nome} não declarou capacidades.`);
  for (const c of capacidades) {
    if (!ACOES.includes(c)) throw new Error(`Adaptador ${nome}: capacidade desconhecida "${c}".`);
    if (typeof adaptador[c] !== 'function') throw new Error(`Adaptador ${nome} declara "${c}" mas não implementa.`);
  }
  if (REGISTRO.has(nome)) throw new Error(`Adaptador ${nome} registrado duas vezes.`);
  REGISTRO.set(nome, Object.freeze({ instituicao: null, autenticacao: 'desconhecida', campos: [], ...adaptador }));
  return adaptador;
}

const obter = (nome) => REGISTRO.get(nome) ?? null;

/** O que a tela mostra: os adaptadores disponíveis e, quando não há nenhum, por quê. */
function catalogo() {
  const itens = [...REGISTRO.values()].map(({ nome, rotulo, instituicao, autenticacao, capacidades, campos, homologacao }) =>
    ({ nome, rotulo, instituicao, autenticacao, capacidades, campos, homologacao: homologacao ?? null }));
  return {
    itens,
    disponivel: itens.length > 0,
    explicacao: itens.length
      ? null
      : 'A cobrança funciona por arquivo (remessa e retorno CNAB) e por PIX com BR Code gerado aqui — as duas coisas não '
        + 'dependem de API. Para ligar um banco ou a PayAx é preciso o manual da instituição e as credenciais do '
        + 'credenciamento; sem isso, qualquer integração seria chute.',
  };
}

function podem(acao) {
  return [...REGISTRO.values()].filter((a) => a.capacidades.includes(acao)).map((a) => a.nome);
}

module.exports = { ACOES, registrar, obter, catalogo, podem };
