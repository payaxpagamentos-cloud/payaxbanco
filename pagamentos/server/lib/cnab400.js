'use strict';

/*
 * CNAB 400 do Bradesco — cobrança registrada.
 *
 *   REMESSA: nós mandamos os títulos para o banco registrar (ocorrência 01) ou para pedir baixa (02),
 *            alterar vencimento (06) etc.
 *   RETORNO: o banco devolve o que aconteceu com cada título — entrada confirmada, liquidação, baixa, rejeição.
 *
 * Todo registro tem EXATAMENTE 400 bytes e o arquivo usa CRLF. Um byte fora de lugar e o banco rejeita
 * o arquivo inteiro, então todas as posições estão declaradas nas tabelas LAYOUT_* abaixo, em um lugar só.
 *
 * CONFERIR ANTES DE PRODUÇÃO: o layout do Bradesco é estável, mas cada convênio pode ter particularidades
 * (campo de multa, rateio, mensagens). Gere uma remessa de teste, mande para o banco homologar e ajuste
 * aqui — nenhuma outra parte do sistema precisa mudar.
 */
const { ErroNegocio } = require('./erros');

// ---------------------------------------------------------------- Formatação de campos
const so = (v) => String(v ?? '').replace(/\D/g, '');

/** Texto à esquerda, completado com espaços, sem acento e em maiúsculas (o CNAB é ASCII). */
function texto(v, tamanho) {
  const t = String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .,\-/()]/g, ' ').toUpperCase();
  return t.slice(0, tamanho).padEnd(tamanho, ' ');
}

/** Número à direita, completado com zeros. */
const numero = (v, tamanho) => so(v).slice(-tamanho).padStart(tamanho, '0');

/** Valor em centavos, sem vírgula (o CNAB já entende as duas últimas casas como centavos). */
const valor = (centavos, tamanho = 13) => numero(String(Math.max(0, Math.round(Number(centavos) || 0))), tamanho);

/** 'AAAA-MM-DD' → 'DDMMAA'. Sem data, zeros. */
const data = (iso) => {
  const d = String(iso ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '000000';
  return `${d.slice(8, 10)}${d.slice(5, 7)}${d.slice(2, 4)}`;
};

/** 'DDMMAA' → 'AAAA-MM-DD'. Século: 70 para cima é 19xx; abaixo, 20xx. */
function dataIso(ddmmaa) {
  const t = so(ddmmaa).padStart(6, '0');
  if (t === '000000') return null;
  const [dd, mm, aa] = [t.slice(0, 2), t.slice(2, 4), t.slice(4, 6)];
  const ano = Number(aa) >= 70 ? `19${aa}` : `20${aa}`;
  const iso = `${ano}-${mm}-${dd}`;
  return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(iso) ? iso : null;
}

/** Identificação da empresa no banco (20 posições no header, 17 no detalhe). */
const identificacaoEmpresa = (conta, tamanho) => {
  const base = `0${numero(conta.carteira, 3)}${numero(conta.agencia, 5)}${numero(conta.conta, 7)}${so(conta.conta_dv) || '0'}`;
  return tamanho === 20 ? `${base}   ` : base.slice(0, tamanho);
};

// ---------------------------------------------------------------- Ocorrências
/** Comandos que mandamos na remessa. */
const COMANDO = { registrar: '01', baixar: '02', abatimento: '04', alterar_vencimento: '06', protestar: '09', sustar_protesto: '18' };

/**
 * O que o banco responde no retorno. O que não está aqui é registrado e ignorado
 * (aparece na conciliação como "não tratado", sem quebrar nada).
 */
const OCORRENCIA = {
  '02': { acao: 'confirmado', texto: 'Entrada confirmada' },
  '03': { acao: 'rejeitado', texto: 'Entrada rejeitada' },
  '06': { acao: 'liquidado', texto: 'Liquidação normal' },
  '08': { acao: 'liquidado', texto: 'Liquidação em cartório' },
  '09': { acao: 'baixado', texto: 'Baixa automática' },
  10: { acao: 'baixado', texto: 'Baixa por ter sido liquidado anteriormente' },
  11: { acao: 'informativo', texto: 'Em ser (título em carteira)' },
  12: { acao: 'informativo', texto: 'Abatimento concedido' },
  13: { acao: 'informativo', texto: 'Abatimento cancelado' },
  14: { acao: 'informativo', texto: 'Vencimento alterado' },
  15: { acao: 'liquidado', texto: 'Liquidação em cartório' },
  16: { acao: 'liquidado', texto: 'Título pago em cheque (aguardando compensação)' },
  17: { acao: 'liquidado', texto: 'Liquidação após baixa' },
  19: { acao: 'informativo', texto: 'Confirmação de instrução de protesto' },
  20: { acao: 'informativo', texto: 'Confirmação de sustação de protesto' },
  23: { acao: 'informativo', texto: 'Encaminhado a cartório' },
  24: { acao: 'informativo', texto: 'Custas de cartório' },
  25: { acao: 'informativo', texto: 'Protesto sustado' },
  27: { acao: 'informativo', texto: 'Confirmação de alteração de dados' },
  28: { acao: 'tarifa', texto: 'Débito de tarifas ou custas' },
  30: { acao: 'rejeitado', texto: 'Alteração de dados rejeitada' },
  32: { acao: 'rejeitado', texto: 'Instrução rejeitada' },
  35: { acao: 'informativo', texto: 'Confirmação de inclusão em banco de dados' },
};

/** Motivos de rejeição mais comuns (posições 319-328, cinco pares). */
const MOTIVO = {
  '01': 'Código do banco inválido', '04': 'Código de movimento não permitido', '15': 'Características da cobrança incompatíveis',
  16: 'Data de vencimento inválida', 17: 'Data de vencimento anterior à emissão', 18: 'Vencimento fora do prazo',
  20: 'Valor do título inválido', 21: 'Espécie do título inválida', 24: 'Data de emissão inválida',
  27: 'Valor/data de desconto inválido', 38: 'Prazo para protesto inválido', 39: 'Pedido de protesto não permitido',
  44: 'Agência cedente não prevista', 45: 'Nome do pagador não informado', 46: 'Tipo/número de inscrição do pagador inválido',
  47: 'Endereço do pagador não informado', 48: 'CEP inválido', 50: 'CEP irregular para o banco cobrador',
  53: 'Tipo/número de inscrição do sacador avalista inválido', 54: 'Sacador avalista não informado',
  63: 'Entrada para título já cadastrado', 65: 'Limite excedido', 66: 'Número autorizado excedido',
};

const motivosDe = (campo) => String(campo ?? '').match(/.{2}/g)?.map((m) => m.trim())
  .filter((m) => m && m !== '00').map((m) => ({ codigo: m, texto: MOTIVO[m] ?? MOTIVO[String(Number(m))] ?? 'Motivo não catalogado' })) ?? [];

// ---------------------------------------------------------------- Remessa
/** Header da remessa (registro 0). */
function headerRemessa(conta, { sequencial, hoje }) {
  const linha = '0' // 001 identificação do registro
    + '1' // 002 operação: remessa
    + 'REMESSA' // 003-009
    + '01' // 010-011 código do serviço
    + texto('COBRANCA', 15) // 012-026
    + identificacaoEmpresa(conta, 20) // 027-046
    + texto(conta.beneficiario_nome, 30) // 047-076
    + '237' // 077-079
    + texto('BRADESCO', 15) // 080-094
    + data(hoje) // 095-100
    + ' '.repeat(8) // 101-108
    + 'MX' // 109-110 identificação do sistema
    + numero(sequencial, 7) // 111-117
    + ' '.repeat(277) // 118-394
    + numero(1, 6); // 395-400
  return conferir(linha, 'header da remessa');
}

/**
 * Registro de um título (registro 1).
 * @param {object} b boleto já gravado, com o pagador
 * @param {object} conta conta bancária nossa
 */
function detalheRemessa(b, conta, { sequencial, comando = COMANDO.registrar, hoje }) {
  const docPagador = so(b.pagador_documento);
  const cep = so(b.pagador_cep).padStart(8, '0');
  // Juros ao dia em reais: o CNAB pede valor por dia, e guardamos o percentual ao mês.
  const jurosDia = Math.round((b.valor_centavos * (b.juros_mes_ppm || 0)) / 1_000_000 / 30);
  // Montado por blocos, com a posição de cada campo declarada ao lado — é o que o banco confere byte a byte.
  const partes = [
    '1', // 001
    '02', // 002-003 tipo de inscrição da empresa
    numero(conta.beneficiario_documento, 14), // 004-017
    ' '.repeat(3), // 018-020 brancos
    identificacaoEmpresa(conta, 17), // 021-037
    texto(b.seu_numero ?? b.nosso_numero, 25), // 038-062 nº de controle do participante
    '000', // 063-065 código do banco (só débito automático)
    b.multa_ppm ? '2' : '0', // 066 campo de multa: 2 = percentual
    numero(Math.round((b.multa_ppm || 0) / 100), 4), // 067-070 percentual de multa (2 casas)
    numero(b.nosso_numero, 11), // 071-081
    String(b.nosso_numero_dv ?? '0').slice(0, 1), // 082 dígito do nosso número
    valor(0, 10), // 083-092 desconto bonificação por dia
    '2', // 093 condição de emissão: 2 = cliente emite (somos nós)
    'N', // 094 não emite boleto para débito automático
    ' '.repeat(10), // 095-104 identificação da operação no banco
    ' ', // 105 indicador de rateio
    '0', // 106 endereçamento para aviso de débito automático
    ' '.repeat(2), // 107-108
    comando, // 109-110 ocorrência
    texto(b.seu_numero ?? b.nosso_numero, 10), // 111-120 nº do documento
    data(b.vencimento), // 121-126
    valor(b.valor_centavos, 13), // 127-139
    '000', // 140-142 banco encarregado da cobrança
    '00000', // 143-147 agência depositária
    '01', // 148-149 espécie do título (01 = duplicata mercantil)
    'N', // 150 aceite
    data(b.emissao), // 151-156
    b.dias_baixa ? '00' : '00', // 157-158 1ª instrução
    '00', // 159-160 2ª instrução
    valor(jurosDia, 13), // 161-173 juros de mora por dia
    data(b.desconto_centavos ? b.desconto_ate : null), // 174-179 data limite do desconto
    valor(b.desconto_centavos, 13), // 180-192
    valor(0, 13), // 193-205 IOF
    valor(0, 13), // 206-218 abatimento
    docPagador.length === 11 ? '01' : '02', // 219-220 tipo de inscrição do pagador
    numero(docPagador, 14), // 221-234
    texto(b.pagador_nome, 40), // 235-274
    texto([b.pagador_endereco, b.pagador_numero].filter(Boolean).join(', '), 40), // 275-314
    texto(b.mensagem, 12), // 315-326 1ª mensagem
    cep.slice(0, 5), // 327-331
    cep.slice(5, 8), // 332-334
    texto(b.pagador_bairro ? `${b.pagador_bairro} ${b.pagador_cidade ?? ''} ${b.pagador_uf ?? ''}` : '', 60), // 335-394 sacador/mensagem
    numero(sequencial, 6), // 395-400
  ];
  return conferir(partes.join(''), `título ${b.nosso_numero}`);
}

/** Trailer da remessa (registro 9). */
const trailerRemessa = (sequencial) => conferir(`9${' '.repeat(393)}${numero(sequencial, 6)}`, 'trailer da remessa');

/** Confere o tamanho do registro antes de deixar sair. */
function conferir(linha, onde) {
  if (linha.length !== 400) {
    throw new ErroNegocio(`Registro CNAB com ${linha.length} posições em vez de 400 (${onde}). O banco rejeitaria o arquivo inteiro.`, 500);
  }
  return linha;
}

/**
 * Monta o arquivo de remessa inteiro.
 * @returns {{conteudo: string, registros: number, nome: string}}
 */
function gerarRemessa({ conta, titulos, boletos, sequencial, hoje, comando = COMANDO.registrar }) {
  // Aceita a lista simples (todos com o mesmo comando) ou [{ boleto, comando }] para misturar
  // registros novos com pedidos de baixa no mesmo arquivo.
  const lista = titulos ?? (boletos ?? []).map((b) => ({ boleto: b, comando }));
  if (!lista.length) throw new ErroNegocio('Nenhum título para enviar na remessa.', 422);
  const linhas = [headerRemessa(conta, { sequencial, hoje })];
  lista.forEach((t, i) => linhas.push(detalheRemessa(t.boleto, conta, { sequencial: i + 2, comando: t.comando ?? comando, hoje })));
  linhas.push(trailerRemessa(linhas.length + 1));
  return {
    conteudo: `${linhas.join('\r\n')}\r\n`,
    registros: lista.length,
    nome: `CB${data(hoje)}${numero(sequencial, 2)}.REM`,
  };
}

// ---------------------------------------------------------------- Retorno
/** Lê o arquivo de retorno inteiro. Linhas com tamanho errado viram erro explícito, não silêncio. */
function lerRetorno(conteudo) {
  const linhas = String(conteudo ?? '').split(/\r?\n/).filter((l) => l.trim().length);
  if (!linhas.length) throw new ErroNegocio('Arquivo de retorno vazio.', 422);

  const cabecalho = linhas[0];
  if (cabecalho[0] !== '0' || !cabecalho.startsWith('02RETORNO')) {
    throw new ErroNegocio('Este arquivo não parece um retorno de cobrança CNAB 400 do Bradesco.', 422);
  }
  const tamanhoErrado = linhas.findIndex((l) => l.length !== 400);
  if (tamanhoErrado >= 0) {
    throw new ErroNegocio(`A linha ${tamanhoErrado + 1} tem ${linhas[tamanhoErrado].length} posições em vez de 400.`, 422);
  }

  const campo = (l, de, ate) => l.slice(de - 1, ate);
  const header = {
    tipo: 'retorno',
    empresa: campo(cabecalho, 47, 76).trim(),
    banco: campo(cabecalho, 77, 79),
    gerado_em: dataIso(campo(cabecalho, 95, 100)),
    credito_em: dataIso(campo(cabecalho, 114, 119)),
    sequencial: Number(campo(cabecalho, 391, 394)) || null,
  };

  const registros = [];
  for (const l of linhas.slice(1)) {
    if (l[0] !== '1') continue; // só os detalhes interessam (9 é o trailer)
    const codigo = campo(l, 109, 110);
    const oc = OCORRENCIA[codigo] ?? OCORRENCIA[String(Number(codigo))] ?? { acao: 'nao_tratado', texto: `Ocorrência ${codigo}` };
    registros.push({
      nosso_numero: campo(l, 71, 81),
      nosso_numero_dv: campo(l, 82, 82),
      seu_numero: campo(l, 38, 62).trim(),
      documento: campo(l, 117, 126).trim(),
      ocorrencia: codigo,
      acao: oc.acao,
      ocorrencia_texto: oc.texto,
      ocorrido_em: dataIso(campo(l, 111, 116)),
      vencimento: dataIso(campo(l, 147, 152)),
      valor_centavos: Number(campo(l, 153, 165)),
      tarifa_centavos: Number(campo(l, 176, 188)),
      iof_centavos: Number(campo(l, 215, 227)),
      abatimento_centavos: Number(campo(l, 228, 240)),
      desconto_centavos: Number(campo(l, 241, 253)),
      pago_centavos: Number(campo(l, 254, 266)),
      juros_centavos: Number(campo(l, 267, 279)),
      outros_centavos: Number(campo(l, 280, 292)),
      creditado_em: dataIso(campo(l, 296, 301)),
      motivos: oc.acao === 'rejeitado' ? motivosDe(campo(l, 319, 328)) : [],
      sequencial: Number(campo(l, 395, 400)) || null,
    });
  }
  return { header, registros, linhas: linhas.length };
}

/** Confere se um texto parece um retorno, sem lançar (usado ao varrer a pasta). */
const pareceRetorno = (conteudo) => /^0.?2RETORNO/.test(String(conteudo ?? '').slice(0, 12));

module.exports = { gerarRemessa, lerRetorno, pareceRetorno, headerRemessa, detalheRemessa, trailerRemessa,
  COMANDO, OCORRENCIA, MOTIVO, texto, numero, valor, data, dataIso, identificacaoEmpresa };
