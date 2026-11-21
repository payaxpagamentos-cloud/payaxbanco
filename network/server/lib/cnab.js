'use strict';

const { ErroNegocio } = require('./erros');
const { zeros, digitos } = require('./boleto');

/*
 * CNAB: os arquivos que o provedor troca com o banco, sem API nenhuma.
 *
 *   remessa  — o que o sistema manda registrar (os boletos emitidos)
 *   retorno  — o que o banco devolve: quem pagou, quanto, quando, e o que foi rejeitado
 *
 * O retorno é o que mais vale: sem ele, alguém dá baixa à mão, fatura por fatura, olhando o extrato.
 *
 * SOBRE AS POSIÇÕES: o CNAB 240 é padrão FEBRABAN e muda pouco entre bancos; o 400 muda bastante.
 * Por isso nada aqui é aplicado às cegas — a leitura devolve uma PRÉVIA com os campos lidos ao lado da
 * linha crua, e o operador confere antes de qualquer baixa. Posição errada aparece na hora como valor
 * sem sentido, em vez de virar baixa errada no financeiro.
 */

/** Campo por posição, na contagem do manual do banco (a primeira coluna é 1, não 0). */
const fatiar = (linha, de, ate) => linha.slice(de - 1, ate).trim();
const numero = (linha, de, ate) => Number(digitos(fatiar(linha, de, ate)) || 0);
/** Dinheiro no CNAB vem sem vírgula, sempre com duas casas: o número já é o valor em centavos. */
const centavos = (linha, de, ate) => numero(linha, de, ate);
const dataDDMMAAAA = (s) => (/^\d{8}$/.test(s) && s !== '00000000' ? `${s.slice(4, 8)}-${s.slice(2, 4)}-${s.slice(0, 2)}` : null);
const dataDDMMAA = (s) => (/^\d{6}$/.test(s) && s !== '000000' ? `20${s.slice(4, 6)}-${s.slice(2, 4)}-${s.slice(0, 2)}` : null);

/*
 * O que cada código de ocorrência significa, e — o que importa de verdade — o EFEITO dele:
 * só "pagamento" vira baixa. Os demais informam, registram ou rejeitam.
 */
const OCORRENCIAS = {
  cnab240: {
    '02': ['Entrada confirmada', 'registro'],
    '03': ['Entrada rejeitada', 'rejeicao'],
    '04': ['Transferência de carteira', 'informativo'],
    '05': ['Liquidação sem registro', 'pagamento'],
    '06': ['Liquidação', 'pagamento'],
    '07': ['Confirmação do acerto de dados', 'informativo'],
    '08': ['Liquidação em cartório', 'pagamento'],
    '09': ['Baixa', 'baixa'],
    11: ['Título em carteira (em ser)', 'informativo'],
    12: ['Confirmação de abatimento', 'informativo'],
    14: ['Vencimento alterado', 'informativo'],
    17: ['Liquidação após baixa', 'pagamento'],
    19: ['Confirmação de protesto', 'informativo'],
    23: ['Encaminhado a protesto', 'informativo'],
    26: ['Instrução rejeitada', 'rejeicao'],
    27: ['Alteração rejeitada', 'rejeicao'],
    28: ['Débito de tarifas', 'informativo'],
    30: ['Alteração de dados rejeitada', 'rejeicao'],
  },
  cnab400: {
    '02': ['Entrada confirmada', 'registro'],
    '03': ['Entrada rejeitada', 'rejeicao'],
    '05': ['Liquidação sem registro', 'pagamento'],
    '06': ['Liquidação normal', 'pagamento'],
    '07': ['Liquidação por conta', 'pagamento'],
    '08': ['Liquidação por saldo', 'pagamento'],
    '09': ['Baixa automática', 'baixa'],
    10: ['Baixa por solicitação', 'baixa'],
    11: ['Em ser (arquivo mensal)', 'informativo'],
    12: ['Abatimento concedido', 'informativo'],
    14: ['Vencimento alterado', 'informativo'],
    15: ['Liquidação em cartório', 'pagamento'],
    16: ['Título pago em cheque', 'pagamento'],
    19: ['Confirmação de protesto', 'informativo'],
    23: ['Encaminhado a cartório', 'informativo'],
    28: ['Débito de tarifas', 'informativo'],
  },
};

/*
 * Posições dos campos. Vêm do padrão e podem ser ajustadas pelo provedor quando o banco dele usa
 * uma variação — o que é comum no 400 e raro no 240.
 */
const POSICOES = {
  cnab240: {
    segmentoT: { ocorrencia: [16, 17], nosso_numero: [37, 56], carteira: [57, 57], documento: [58, 72], vencimento: [73, 80], valor: [81, 95] },
    segmentoU: { juros: [18, 32], desconto: [33, 47], abatimento: [48, 62], iof: [63, 77], valor_pago: [78, 92],
      valor_liquido: [93, 107], despesas: [108, 122], creditos: [123, 137], data_ocorrencia: [138, 145], data_credito: [146, 153] },
  },
  cnab400: {
    nosso_numero: [38, 62], ocorrencia: [109, 110], data_ocorrencia: [111, 116], documento: [117, 126],
    vencimento: [147, 152], valor: [153, 165], despesas: [176, 188], valor_pago: [254, 266], juros: [267, 279], data_credito: [296, 301],
  },
};

/** Separa as linhas e descobre o layout pelo tamanho delas. */
function detectar(conteudo) {
  const linhas = String(conteudo ?? '').split(/\r?\n/).filter((l) => l.trim().length > 10);
  if (!linhas.length) throw new ErroNegocio('Arquivo vazio ou sem linhas reconhecíveis.', 422);
  const tamanhos = linhas.map((l) => l.replace(/\r$/, '').length);
  const maior = Math.max(...tamanhos);
  if (maior >= 230 && maior <= 250) return { layout: 'cnab240', linhas };
  if (maior >= 390 && maior <= 410) return { layout: 'cnab400', linhas };
  throw new ErroNegocio(`Não reconheci o layout: as linhas têm ${maior} caracteres (esperado 240 ou 400). Confira se o arquivo é mesmo um retorno de cobrança.`, 422);
}

const ocorrenciaDe = (layout, codigo) => {
  const c = zeros(codigo, 2);
  const [texto, efeito] = OCORRENCIAS[layout][c] ?? OCORRENCIAS[layout][String(Number(c))] ?? [`Ocorrência ${c}`, 'informativo'];
  return { codigo: c, texto, efeito };
};

/** Lê um retorno CNAB 240: o segmento T traz o título e o U, o dinheiro. Os dois são um registro só. */
function lerRetorno240(linhas, posicoes) {
  const p = posicoes.segmentoT;
  const q = posicoes.segmentoU;
  const registros = [];
  const cabecalho = linhas.find((l) => l[7] === '0') ?? '';
  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i];
    if (l[7] !== '3' || l[13] !== 'T') continue;
    const u = linhas[i + 1] && linhas[i + 1][7] === '3' && linhas[i + 1][13] === 'U' ? linhas[i + 1] : null;
    registros.push({
      linha: i + 1,
      ocorrencia: ocorrenciaDe('cnab240', fatiar(l, ...p.ocorrencia)),
      nosso_numero: digitos(fatiar(l, ...p.nosso_numero)).replace(/^0+/, '') || null,
      carteira: fatiar(l, ...p.carteira),
      documento: fatiar(l, ...p.documento).replace(/^0+/, '') || null,
      vencimento: dataDDMMAAAA(digitos(fatiar(l, ...p.vencimento))),
      valor_centavos: centavos(l, ...p.valor),
      valor_pago_centavos: u ? centavos(u, ...q.valor_pago) : 0,
      juros_centavos: u ? centavos(u, ...q.juros) : 0,
      desconto_centavos: u ? centavos(u, ...q.desconto) : 0,
      despesas_centavos: u ? centavos(u, ...q.despesas) : 0,
      data_ocorrencia: u ? dataDDMMAAAA(digitos(fatiar(u, ...q.data_ocorrencia))) : null,
      data_credito: u ? dataDDMMAAAA(digitos(fatiar(u, ...q.data_credito))) : null,
      bruto: l.slice(0, 120),
    });
  }
  return {
    banco: cabecalho.slice(0, 3),
    gerado_em: dataDDMMAAAA(digitos(cabecalho.slice(143, 151))),
    registros,
  };
}

/** Lê um retorno CNAB 400: cada registro de detalhe (tipo 1) é um título. */
function lerRetorno400(linhas, p) {
  const cabecalho = linhas.find((l) => l[0] === '0') ?? '';
  const registros = [];
  linhas.forEach((l, i) => {
    if (l[0] !== '1') return;
    registros.push({
      linha: i + 1,
      ocorrencia: ocorrenciaDe('cnab400', fatiar(l, ...p.ocorrencia)),
      nosso_numero: digitos(fatiar(l, ...p.nosso_numero)).replace(/^0+/, '') || null,
      carteira: null,
      documento: fatiar(l, ...p.documento).replace(/^0+/, '') || null,
      vencimento: dataDDMMAA(digitos(fatiar(l, ...p.vencimento))),
      valor_centavos: centavos(l, ...p.valor),
      valor_pago_centavos: centavos(l, ...p.valor_pago),
      juros_centavos: centavos(l, ...p.juros),
      desconto_centavos: 0,
      despesas_centavos: centavos(l, ...p.despesas),
      data_ocorrencia: dataDDMMAA(digitos(fatiar(l, ...p.data_ocorrencia))),
      data_credito: dataDDMMAA(digitos(fatiar(l, ...p.data_credito))),
      bruto: l.slice(0, 120),
    });
  });
  return { banco: cabecalho.slice(76, 79) || cabecalho.slice(0, 3), gerado_em: dataDDMMAA(digitos(cabecalho.slice(94, 100))), registros };
}

/** Lê o arquivo de retorno, qualquer um dos dois layouts. */
function lerRetorno(conteudo, { posicoes = POSICOES } = {}) {
  const { layout, linhas } = detectar(conteudo);
  const dados = layout === 'cnab240' ? lerRetorno240(linhas, posicoes.cnab240) : lerRetorno400(linhas, posicoes.cnab400);
  if (!dados.registros.length) {
    throw new ErroNegocio('O arquivo foi lido, mas não tem nenhum registro de título. Confira se é o retorno de cobrança e não o extrato ou o retorno de pagamentos.', 422);
  }
  return { layout, linhas: linhas.length, ...dados };
}

// ---------------- Remessa ----------------

const texto = (v, n) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 .,\-/]/g, '').toUpperCase().padEnd(n, ' ').slice(0, n);
const brancos = (n) => ' '.repeat(n);
const dataAAAAMMDD = (d) => (d ? digitos(d).slice(0, 8).replace(/^(\d{4})(\d{2})(\d{2})$/, '$3$2$1') : '00000000');
const agora = () => new Date();

/**
 * Remessa CNAB 240 no layout FEBRABAN.
 *
 * O esqueleto (header de arquivo, header de lote, segmentos P e Q, trailers) é padrão; o que cada banco
 * exige de diferente costuma estar em campos de uso exclusivo. Por isso a primeira remessa de qualquer
 * provedor tem de ser conferida com o banco antes de virar rotina — o sistema avisa isso na tela.
 */
function gerarRemessa240({ conta, cobrancas, numero: numeroRemessa, em = agora() }) {
  if (!cobrancas.length) throw new ErroNegocio('Nenhuma cobrança para enviar na remessa.', 422);
  const banco = zeros(conta.banco, 3);
  const empresaTipo = digitos(conta.beneficiario_documento).length > 11 ? '2' : '1';
  const data = `${String(em.getDate()).padStart(2, '0')}${String(em.getMonth() + 1).padStart(2, '0')}${em.getFullYear()}`;
  const hora = `${String(em.getHours()).padStart(2, '0')}${String(em.getMinutes()).padStart(2, '0')}${String(em.getSeconds()).padStart(2, '0')}`;
  const contaBloco = `${zeros(conta.agencia, 5)}${texto(conta.agencia_dv, 1)}${zeros(conta.conta, 12)}${texto(conta.conta_dv, 1)}${texto(conta.conta_dv, 1)}`;

  const linhas = [];
  // Header do arquivo
  linhas.push(`${banco}0000${'0'}${brancos(9)}${empresaTipo}${zeros(conta.beneficiario_documento, 14)}${texto(conta.convenio ?? conta.codigo_beneficiario, 20)}`
    + `${contaBloco}${texto(conta.beneficiario_nome, 30)}${texto(conta.banco_nome ?? '', 30)}${brancos(10)}1${data}${hora}${zeros(numeroRemessa, 6)}${'103'}${zeros(0, 5)}${brancos(20)}${brancos(20)}${brancos(29)}`);
  // Header do lote (cobrança, remessa)
  linhas.push(`${banco}00011R01 ${'  '}${empresaTipo}${zeros(conta.beneficiario_documento, 15)}${texto(conta.convenio ?? conta.codigo_beneficiario, 20)}`
    + `${contaBloco}${texto(conta.beneficiario_nome, 30)}${brancos(40)}${brancos(40)}${zeros(numeroRemessa, 8)}${data}${zeros(0, 8)}${brancos(33)}`);

  let sequencial = 0;
  let total = 0;
  for (const c of cobrancas) {
    sequencial += 1;
    total += c.valor_centavos;
    const nn = `${texto(c.nosso_numero, 20)}`;
    // Segmento P: o título
    linhas.push(`${banco}00013${zeros(sequencial, 5)}P ${'01'}${contaBloco}${nn}${zeros(c.carteira ?? 1, 1)}${'1'}${'2'}${brancos(1)}`
      + `${texto(c.documento, 15)}${dataAAAAMMDD(c.vencimento)}${zeros(c.valor_centavos, 15)}${zeros(0, 5)}${brancos(1)}${'02'}${'1'}${'A'}`
      + `${dataAAAAMMDD(c.emitido_em)}${'3'}${zeros(0, 13)}${'0'}${zeros(0, 13)}${zeros(0, 15)}${zeros(0, 15)}${texto(c.documento, 25)}${'3'}${zeros(0, 2)}${'0'}${zeros(0, 3)}${brancos(1)}`);
    sequencial += 1;
    // Segmento Q: o pagador
    const doc = digitos(c.pagador_documento);
    linhas.push(`${banco}00013${zeros(sequencial, 5)}Q ${'01'}${doc.length > 11 ? '2' : '1'}${zeros(doc, 15)}${texto(c.pagador_nome, 40)}`
      + `${texto(c.pagador_endereco, 40)}${texto(c.pagador_bairro, 15)}${zeros(c.pagador_cep, 8)}${texto(c.pagador_cidade, 15)}${texto(c.pagador_uf, 2)}`
      + `${'0'}${zeros(0, 15)}${brancos(40)}${zeros(0, 3)}${brancos(28)}`);
  }
  // Trailers
  linhas.push(`${banco}00015${brancos(9)}${zeros(sequencial + 2, 6)}${zeros(cobrancas.length, 6)}${zeros(total, 17)}${zeros(0, 6)}${zeros(0, 17)}${zeros(0, 6)}${zeros(0, 17)}${zeros(0, 6)}${zeros(0, 17)}${brancos(8)}${brancos(117)}`);
  linhas.push(`${banco}99999${brancos(9)}${zeros(1, 6)}${zeros(sequencial + 4, 6)}${zeros(0, 6)}${brancos(205)}`);

  // Toda linha do CNAB 240 tem exatamente 240 caracteres.
  const ajustadas = linhas.map((l, i) => {
    if (l.length > 240) throw new ErroNegocio(`Linha ${i + 1} da remessa ficou com ${l.length} caracteres (o limite é 240).`, 500);
    return l.padEnd(240, ' ');
  });
  return { conteudo: `${ajustadas.join('\r\n')}\r\n`, linhas: ajustadas.length, titulos: cobrancas.length, valor_centavos: total, layout: 'cnab240' };
}

module.exports = { detectar, lerRetorno, lerRetorno240, lerRetorno400, gerarRemessa240, OCORRENCIAS, POSICOES, ocorrenciaDe, fatiar };
