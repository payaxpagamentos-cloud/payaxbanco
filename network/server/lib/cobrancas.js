'use strict';

const { agora, transacao } = require('../db');
const { ErroNegocio } = require('./erros');
const { diasEntre } = require('./datas');
const boleto = require('./boleto');
const pix = require('./pix');
const cnab = require('./cnab');
const fat = require('./faturamento');

/*
 * Cobrança bancária: emitir o meio de pagamento de uma fatura e conciliar o que o banco devolve.
 *
 * Decisões que valem para todo o módulo:
 * - A FATURA continua sendo a verdade do que é devido. A cobrança é o MEIO de pagar, e uma fatura pode
 *   ter mais de um ao mesmo tempo (boleto e PIX), que é como a maioria dos provedores trabalha hoje.
 * - O PIX não depende de banco nem de credenciamento: a chave basta. O boleto depende de convênio e do
 *   campo livre certo, por isso toda conta nasce com o layout NÃO validado e o sistema repete o aviso
 *   até alguém confirmar um boleto de verdade com o banco.
 * - RETORNO NUNCA É APLICADO ÀS CEGAS: o arquivo entra como "conferindo", o operador vê a prévia com os
 *   campos lidos, e só então aplica. Posição de layout errada vira valor sem sentido na tela, não baixa
 *   errada no financeiro.
 * - A baixa criada pelo retorno é um pagamento comum do financeiro, com origem "retorno": ela aparece no
 *   extrato da fatura, no histórico do assinante e pode ser estornada como qualquer outra.
 */

const digitos = (v) => String(v ?? '').replace(/\D/g, '');

/** Conta de cobrança usável, com a mensagem certa quando falta configuração. */
function contaDe(db, org, contaId = null) {
  const c = contaId
    ? db.prepare('SELECT * FROM contas_cobranca WHERE id = ? AND organizacao_id = ?').get(Number(contaId), org)
    : db.prepare('SELECT * FROM contas_cobranca WHERE organizacao_id = ? AND ativa = 1 ORDER BY padrao DESC, id LIMIT 1').get(org);
  if (!c) throw new ErroNegocio('Nenhuma conta de cobrança cadastrada. Cadastre a conta do provedor em Faturamento → Cobrança bancária.', 422);
  if (!c.ativa) throw new ErroNegocio(`A conta ${c.nome} está inativa.`, 422);
  return c;
}

/** Dados do pagador que vão na remessa e no boleto. */
function pagadorDa(db, faturaId) {
  return db.prepare(`SELECT a.nome, a.documento, a.logradouro, a.numero, a.bairro, a.cidade, a.uf, a.cep
    FROM faturas f JOIN assinantes a ON a.id = f.assinante_id WHERE f.id = ?`).get(faturaId);
}

/** Próximo nosso número da conta, reservado de forma atômica. */
function proximoNossoNumero(db, contaId) {
  db.prepare('UPDATE contas_cobranca SET proximo_nosso_numero = proximo_nosso_numero + 1 WHERE id = ?').run(contaId);
  return db.prepare('SELECT proximo_nosso_numero FROM contas_cobranca WHERE id = ?').get(contaId).proximo_nosso_numero - 1;
}

/**
 * Emite o meio de pagamento de uma fatura.
 *
 * O valor é o SALDO da fatura, não o valor original: emitir boleto de fatura com baixa parcial pelo valor
 * cheio faria o assinante pagar duas vezes. Encargos de atraso não entram no código — eles são calculados
 * no dia do pagamento e o banco cobra pela instrução de juros, que é configuração do convênio.
 */
function emitir(db, { org, fatura, conta, tipo, usuarioId = null }) {
  if (fatura.situacao === 'cancelada') throw new ErroNegocio('Fatura cancelada não recebe cobrança.', 422);
  if (fatura.situacao === 'paga') throw new ErroNegocio('Fatura já quitada.', 422);
  const saldo = fatura.valor_centavos - fatura.pago_centavos;
  if (saldo <= 0) throw new ErroNegocio('A fatura não tem saldo em aberto.', 422);

  const existente = db.prepare("SELECT * FROM cobrancas WHERE fatura_id = ? AND tipo = ? AND situacao IN ('emitida','registrada')").get(fatura.id, tipo);
  if (existente) return { ...existente, ja_existia: true };

  const t = agora();
  if (tipo === 'pix') {
    if (!conta.emite_pix) throw new ErroNegocio(`A conta ${conta.nome} não está marcada para emitir PIX.`, 422);
    const txid = pix.txidDaFatura(fatura.numero);
    const brcode = pix.brcode({
      chave: conta.chave_pix,
      valor_centavos: saldo,
      beneficiario: conta.beneficiario_nome,
      cidade: conta.beneficiario_cidade,
      txid,
    });
    const id = Number(db.prepare(`INSERT INTO cobrancas (organizacao_id, fatura_id, conta_id, tipo, pix_brcode, pix_txid, valor_centavos, vencimento, criado_por, criado_em)
      VALUES (?, ?, ?, 'pix', ?, ?, ?, ?, ?, ?)`).run(org, fatura.id, conta.id, brcode, txid, saldo, fatura.vencimento, usuarioId, t).lastInsertRowid);
    return db.prepare('SELECT * FROM cobrancas WHERE id = ?').get(id);
  }

  if (!conta.emite_boleto) throw new ErroNegocio(`A conta ${conta.nome} não está marcada para emitir boleto.`, 422);
  if (!conta.banco) throw new ErroNegocio(`A conta ${conta.nome} não tem banco definido.`, 422);
  const nn = proximoNossoNumero(db, conta.id);
  const montado = boleto.montar({
    banco: conta.banco,
    valor_centavos: saldo,
    vencimento: fatura.vencimento,
    agencia: conta.agencia,
    conta: conta.conta,
    carteira: conta.carteira,
    convenio: conta.convenio,
    codigo_beneficiario: conta.codigo_beneficiario,
    posto: conta.posto,
    modalidade: conta.modalidade,
    nosso_numero: nn,
  });
  const id = Number(db.prepare(`INSERT INTO cobrancas (organizacao_id, fatura_id, conta_id, tipo, nosso_numero, nosso_numero_dv, codigo_barras,
    linha_digitavel, valor_centavos, vencimento, criado_por, criado_em) VALUES (?, ?, ?, 'boleto', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(org, fatura.id, conta.id, String(nn), montado.nosso_numero_dv, montado.codigo_barras, montado.linha_digitavel, saldo, fatura.vencimento, usuarioId, t).lastInsertRowid);
  return { ...db.prepare('SELECT * FROM cobrancas WHERE id = ?').get(id), layout_validado: conta.layout_validado === 1, observacao_banco: montado.observacao };
}

/** Cobrança pronta para a tela, com a linha digitável formatada e o aviso de layout quando couber. */
function publico(db, c) {
  if (!c) return null;
  const conta = db.prepare('SELECT nome, banco, layout_validado FROM contas_cobranca WHERE id = ?').get(c.conta_id);
  return {
    ...c,
    conta_nome: conta?.nome ?? null,
    linha_formatada: c.linha_digitavel ? boleto.formatarLinha(c.linha_digitavel) : null,
    // O boleto de uma conta cujo layout nunca foi conferido com o banco é um risco conhecido, e a tela diz isso.
    aviso_layout: c.tipo === 'boleto' && conta && !conta.layout_validado
      ? 'O campo livre desta conta ainda não foi conferido com o banco. Confira um boleto de teste antes de enviar a primeira remessa em produção.'
      : null,
  };
}

// ---------------- Remessa ----------------

/** Gera a remessa com as cobranças ainda não enviadas da conta. */
function gerarRemessa(db, { org, conta, usuarioId = null }) {
  const pendentes = db.prepare(`SELECT c.*, f.numero AS fatura_numero FROM cobrancas c JOIN faturas f ON f.id = c.fatura_id
    WHERE c.conta_id = ? AND c.tipo = 'boleto' AND c.situacao = 'emitida' AND c.remessa_id IS NULL ORDER BY c.id`).all(conta.id);
  if (!pendentes.length) throw new ErroNegocio('Nenhum boleto emitido aguardando remessa nesta conta.', 422);
  const numero = db.prepare('SELECT proxima_remessa FROM contas_cobranca WHERE id = ?').get(conta.id).proxima_remessa;

  const titulos = pendentes.map((c) => {
    const p = pagadorDa(db, c.fatura_id);
    return {
      nosso_numero: `${c.nosso_numero}${c.nosso_numero_dv ?? ''}`,
      documento: String(c.fatura_numero),
      carteira: conta.carteira,
      valor_centavos: c.valor_centavos,
      vencimento: c.vencimento,
      emitido_em: c.criado_em.slice(0, 10),
      pagador_nome: p.nome,
      pagador_documento: p.documento,
      pagador_endereco: [p.logradouro, p.numero].filter(Boolean).join(', '),
      pagador_bairro: p.bairro,
      pagador_cep: p.cep,
      pagador_cidade: p.cidade,
      pagador_uf: p.uf,
    };
  });
  const arquivo = cnab.gerarRemessa240({ conta, cobrancas: titulos, numero });
  const nome = `CB${boleto.zeros(conta.banco, 3)}${String(numero).padStart(5, '0')}.REM`;
  return transacao(db, () => {
    const id = Number(db.prepare(`INSERT INTO remessas (organizacao_id, conta_id, numero, layout, arquivo, titulos, valor_centavos, conteudo, criado_por, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(org, conta.id, numero, arquivo.layout, nome, arquivo.titulos, arquivo.valor_centavos, arquivo.conteudo, usuarioId, agora()).lastInsertRowid);
    const marcar = db.prepare('UPDATE cobrancas SET remessa_id = ?, versao = versao + 1 WHERE id = ?');
    for (const c of pendentes) marcar.run(id, c.id);
    db.prepare('UPDATE contas_cobranca SET proxima_remessa = proxima_remessa + 1 WHERE id = ?').run(conta.id);
    return { id, arquivo: nome, ...arquivo };
  });
}

// ---------------- Retorno ----------------

/**
 * Casa um registro do retorno com a cobrança emitida.
 *
 * Duas chaves independentes: o nosso número (a chave do título no banco) e o número da fatura (que vai
 * no campo "número do documento"). Quando as duas apontam para o mesmo título, a leitura está certa;
 * quando não casa nada, o registro fica marcado como não encontrado em vez de ser adivinhado.
 */
function casar(db, org, registro) {
  if (registro.nosso_numero) {
    const porNn = db.prepare(`SELECT c.*, f.numero AS fatura_numero FROM cobrancas c JOIN faturas f ON f.id = c.fatura_id
      WHERE c.organizacao_id = ? AND c.tipo = 'boleto' AND CAST(c.nosso_numero AS INTEGER) = CAST(? AS INTEGER) AND c.situacao <> 'cancelada'
      ORDER BY c.id DESC LIMIT 1`).get(org, registro.nosso_numero);
    if (porNn) return { cobranca: porNn, chave: 'nosso número' };
  }
  // Vários bancos devolvem o nosso número já com o dígito verificador grudado: 1234 emitido volta como 12345.
  // Só tentamos sem o último dígito, e só se ele for o dígito que o sistema calculou para aquele título.
  if (registro.nosso_numero && registro.nosso_numero.length > 1) {
    const sem = registro.nosso_numero.slice(0, -1);
    const dv = registro.nosso_numero.slice(-1);
    const porDv = db.prepare(`SELECT c.*, f.numero AS fatura_numero FROM cobrancas c JOIN faturas f ON f.id = c.fatura_id
      WHERE c.organizacao_id = ? AND c.tipo = 'boleto' AND CAST(c.nosso_numero AS INTEGER) = CAST(? AS INTEGER)
      AND c.nosso_numero_dv = ? AND c.situacao <> 'cancelada' ORDER BY c.id DESC LIMIT 1`).get(org, sem, dv);
    if (porDv) return { cobranca: porDv, chave: 'nosso número com dígito' };
  }
  if (registro.documento) {
    const porDoc = db.prepare(`SELECT c.*, f.numero AS fatura_numero FROM cobrancas c JOIN faturas f ON f.id = c.fatura_id
      WHERE c.organizacao_id = ? AND f.numero = ? AND c.situacao <> 'cancelada' ORDER BY c.id DESC LIMIT 1`).get(org, Number(registro.documento));
    if (porDoc) return { cobranca: porDoc, chave: 'número da fatura' };
  }
  return { cobranca: null, chave: null };
}

/**
 * Lê o arquivo e monta a prévia: o que seria feito com cada registro, sem mexer em nada.
 * `divergencia` é o que o operador precisa olhar antes de aplicar — valor diferente do título, por exemplo.
 */
function conferirRetorno(db, org, conteudo, { posicoes } = {}) {
  const lido = cnab.lerRetorno(conteudo, posicoes ? { posicoes } : {});
  const itens = lido.registros.map((r) => {
    const { cobranca, chave } = casar(db, org, r);
    const pago = r.valor_pago_centavos || 0;
    const divergencias = [];
    if (!cobranca) {
      divergencias.push('Nenhuma cobrança emitida bate com este registro.');
    } else {
      if (r.valor_centavos && cobranca.valor_centavos !== r.valor_centavos) {
        divergencias.push(`O valor do título no banco (${(r.valor_centavos / 100).toFixed(2)}) é diferente do emitido (${(cobranca.valor_centavos / 100).toFixed(2)}).`);
      }
      if (r.vencimento && cobranca.vencimento !== r.vencimento) divergencias.push(`Vencimento no banco: ${r.vencimento}; no sistema: ${cobranca.vencimento}.`);
      if (cobranca.situacao === 'paga' && r.ocorrencia.efeito === 'pagamento') divergencias.push('Esta cobrança já estava marcada como paga.');
      if (r.ocorrencia.efeito === 'pagamento' && pago <= 0) divergencias.push('Ocorrência de pagamento sem valor pago: confira as posições do layout.');
    }
    return {
      ...r,
      cobranca_id: cobranca?.id ?? null,
      fatura_id: cobranca?.fatura_id ?? null,
      fatura_numero: cobranca?.fatura_numero ?? null,
      casado_por: chave,
      aplicar: Boolean(cobranca) && r.ocorrencia.efeito === 'pagamento' && pago > 0 && cobranca.situacao !== 'paga',
      divergencias,
    };
  });
  return {
    layout: lido.layout,
    banco: lido.banco,
    gerado_em: lido.gerado_em,
    linhas: lido.linhas,
    registros: itens.length,
    pagamentos: itens.filter((x) => x.ocorrencia.efeito === 'pagamento').length,
    valor_centavos: itens.filter((x) => x.ocorrencia.efeito === 'pagamento').reduce((s, x) => s + x.valor_pago_centavos, 0),
    a_aplicar: itens.filter((x) => x.aplicar).length,
    nao_encontrados: itens.filter((x) => !x.cobranca_id).length,
    com_divergencia: itens.filter((x) => x.divergencias.length).length,
    itens,
  };
}

/**
 * Aplica o que a prévia mostrou: dá baixa nas faturas pagas e marca o que o banco rejeitou ou baixou.
 * Cada baixa é um pagamento comum do financeiro, com origem "retorno" — aparece no extrato da fatura e
 * pode ser estornada como qualquer outra.
 */
function aplicarRetorno(db, { org, previa, retornoId, hoje, usuarioId = null, aoQuitar = null }) {
  const resultado = { baixados: 0, valor_centavos: 0, registrados: 0, rejeitados: 0, baixas_banco: 0, ignorados: 0, erros: [] };
  for (const item of previa.itens) {
    if (!item.cobranca_id) { resultado.ignorados += 1; continue; }
    const cobranca = db.prepare('SELECT * FROM cobrancas WHERE id = ?').get(item.cobranca_id);
    const efeito = item.ocorrencia.efeito;

    if (efeito === 'registro') {
      db.prepare("UPDATE cobrancas SET situacao = 'registrada', registrada_em = ?, retorno_id = ?, versao = versao + 1 WHERE id = ? AND situacao = 'emitida'")
        .run(item.data_ocorrencia ?? hoje, retornoId, cobranca.id);
      resultado.registrados += 1;
      continue;
    }
    if (efeito === 'rejeicao') {
      db.prepare("UPDATE cobrancas SET situacao = 'rejeitada', motivo_rejeicao = ?, retorno_id = ?, versao = versao + 1 WHERE id = ?")
        .run(item.ocorrencia.texto, retornoId, cobranca.id);
      resultado.rejeitados += 1;
      continue;
    }
    if (efeito === 'baixa') {
      db.prepare("UPDATE cobrancas SET situacao = 'baixada', retorno_id = ?, versao = versao + 1 WHERE id = ? AND situacao <> 'paga'").run(retornoId, cobranca.id);
      resultado.baixas_banco += 1;
      continue;
    }
    if (!item.aplicar) { resultado.ignorados += 1; continue; }

    const fatura = db.prepare('SELECT * FROM faturas WHERE id = ?').get(cobranca.fatura_id);
    const saldo = fatura.valor_centavos - fatura.pago_centavos;
    // O banco credita o valor pago; o que abate a fatura é no máximo o saldo dela — o excedente é encargo.
    const abate = Math.min(item.valor_pago_centavos, saldo);
    if (abate <= 0) { resultado.ignorados += 1; continue; }
    try {
      const baixa = fat.registrarPagamento(db, {
        org,
        fatura,
        usuarioId,
        dados: {
          valor_centavos: abate,
          juros_centavos: item.juros_centavos ?? 0,
          multa_centavos: 0,
          desconto_centavos: item.desconto_centavos ?? 0,
          data: item.data_credito ?? item.data_ocorrencia ?? hoje,
          forma: 'boleto',
          origem: 'retorno',
          observacoes: `Retorno ${previa.layout} · ${item.ocorrencia.texto} · nosso número ${item.nosso_numero ?? '—'}`,
        },
      });
      db.prepare(`UPDATE cobrancas SET situacao = 'paga', pago_em = ?, valor_pago_centavos = ?, juros_centavos = ?, despesas_centavos = ?,
        retorno_id = ?, pagamento_id = ?, versao = versao + 1 WHERE id = ?`)
        .run(item.data_credito ?? item.data_ocorrencia ?? hoje, item.valor_pago_centavos, item.juros_centavos ?? 0, item.despesas_centavos ?? 0,
          retornoId, baixa.pagamento_id, cobranca.id);
      resultado.baixados += 1;
      resultado.valor_centavos += abate;
      if (baixa.fatura.situacao === 'paga' && fatura.contrato_id && aoQuitar) aoQuitar(fatura.contrato_id);
    } catch (err) {
      resultado.erros.push({ linha: item.linha, fatura: item.fatura_numero, erro: err.message });
    }
  }
  return resultado;
}

/** Quantos dias o provedor demora, em média, entre emitir e receber. */
function prazoMedioRecebimento(db, org, { meses = 6 } = {}) {
  const pagas = db.prepare(`SELECT vencimento, pago_em FROM cobrancas WHERE organizacao_id = ? AND situacao = 'paga' AND pago_em IS NOT NULL
    ORDER BY id DESC LIMIT 500`).all(org);
  if (!pagas.length) return null;
  const dias = pagas.map((c) => diasEntre(c.vencimento, c.pago_em));
  return Math.round((dias.reduce((a, b) => a + b, 0) / dias.length) * 10) / 10;
}

module.exports = { contaDe, pagadorDa, proximoNossoNumero, emitir, publico, gerarRemessa, conferirRetorno, aplicarRetorno, casar, prazoMedioRecebimento, digitos };
