'use strict';

/*
 * Ciclo de vida do boleto: emissão → registro no banco → liquidação (com split) → ou baixa.
 *
 * O split acontece UMA vez por título, na liquidação, dentro da mesma transação que marca o boleto como pago.
 * Reprocessar o mesmo aviso do banco não duplica crédito: a liquidação é idempotente pelo estado do título.
 */
const config = require('../config');
const { transacao, agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const v = require('./validacao');
const datas = require('./datas');
const febraban = require('./febraban');
const precos = require('./precos');
const razao = require('./razao');
const { criarBanco } = require('./bradesco');
const { decifrar } = require('./cripto');

const hoje = () => datas.dataLocal(config.fusoPadrao);

/** Conta bancária do título: a informada, a padrão ou a única ativa. */
function contaDe(db, contaId) {
  const c = contaId
    ? db.prepare('SELECT * FROM contas_bancarias WHERE id = ? AND ativa = 1').get(contaId)
    : db.prepare('SELECT * FROM contas_bancarias WHERE ativa = 1 ORDER BY padrao DESC, id LIMIT 1').get();
  if (!c) throw new ErroNegocio('Nenhuma conta bancária ativa cadastrada (Configurações → Contas bancárias).', 409);
  return c;
}

/** Credenciais do banco, decifradas. Devolve null quando a integração não está configurada. */
function credenciaisDaConta(db, contaId) {
  const i = db.prepare("SELECT * FROM integracoes WHERE escopo = 'banco' AND (conta_id = ? OR conta_id IS NULL) ORDER BY conta_id DESC LIMIT 1").get(contaId);
  if (!i?.credenciais || i.estado === 'desabilitada') return null;
  try { return JSON.parse(decifrar(i.credenciais)); } catch { return null; }
}

/** Próximo nosso número da conta, reservado de forma atômica (não repete nem com dois pedidos ao mesmo tempo). */
function proximoNossoNumero(db, conta) {
  const r = db.prepare(`UPDATE contas_bancarias
      SET nosso_numero_atual = MAX(nosso_numero_atual, nosso_numero_inicial - 1) + 1
      WHERE id = ? AND MAX(nosso_numero_atual, nosso_numero_inicial - 1) + 1 <= nosso_numero_final
      RETURNING nosso_numero_atual`).get(conta.id);
  if (!r) throw new ErroNegocio('A faixa de nosso número desta conta acabou. Peça uma nova faixa ao banco e atualize a conta.', 409);
  return String(r.nosso_numero_atual).padStart(11, '0');
}

/** Valida e normaliza os dados de um boleto novo. */
function validarEntrada(dados, cliente) {
  const tipo = v.opcao(dados.tipo ?? 'bolepix', 'o tipo', ['boleto', 'bolepix']);
  // `valor` vem da tela em reais ("1.234,56"); `valor_centavos` vem de integrações (IXC, API), já em inteiros.
  const valor = dados.valor_centavos !== undefined && dados.valor_centavos !== null && dados.valor_centavos !== ''
    ? v.inteiro(dados.valor_centavos, 'o valor', { min: 1 })
    : v.centavos(dados.valor, 'o valor');
  if (valor < 500) throw new ErroNegocio('O valor mínimo de um boleto é R$ 5,00.', 422);
  if (valor > cliente.limite_boleto_centavos) {
    throw new ErroNegocio(`Valor acima do limite por boleto deste cliente (${(cliente.limite_boleto_centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}).`, 422);
  }
  const vencimento = v.data(dados.vencimento, 'o vencimento');
  const emissao = dados.emissao ? v.data(dados.emissao, 'a emissão') : hoje();
  if (vencimento < emissao) throw new ErroNegocio('O vencimento não pode ser anterior à emissão.', 422);
  if (datas.diasEntre(emissao, vencimento) > 3650) throw new ErroNegocio('Vencimento distante demais (máximo de 10 anos).', 422);
  const descontoAte = v.dataOpcional(dados.desconto_ate, 'a data limite do desconto');
  const desconto = v.centavosOpcional(dados.desconto, 'o desconto') ?? 0;
  if (desconto >= valor) throw new ErroNegocio('O desconto não pode ser igual ou maior que o valor do boleto.', 422);
  if (desconto && !descontoAte) throw new ErroNegocio('Informe até quando o desconto vale.', 422);

  return {
    tipo,
    valor_centavos: valor,
    emissao,
    vencimento,
    seu_numero: v.opcional(dados.seu_numero, 'o número do documento', 25),
    pagador_nome: v.texto(dados.pagador_nome, 'o nome do pagador', 70),
    pagador_documento: v.documento(dados.pagador_documento, 'o CPF/CNPJ do pagador'),
    pagador_email: dados.pagador_email ? v.email(dados.pagador_email) : null,
    pagador_telefone: dados.pagador_telefone ? v.telefone(dados.pagador_telefone) : null,
    pagador_cep: dados.pagador_cep ? v.cep(dados.pagador_cep) : null,
    pagador_endereco: v.opcional(dados.pagador_endereco, 'o endereço do pagador', 60),
    pagador_numero: v.opcional(dados.pagador_numero, 'o número do endereço', 10),
    pagador_bairro: v.opcional(dados.pagador_bairro, 'o bairro', 40),
    pagador_cidade: v.opcional(dados.pagador_cidade, 'a cidade', 40),
    pagador_uf: v.ufOpcional(dados.pagador_uf),
    juros_mes_ppm: dados.juros_mes === undefined || dados.juros_mes === null || dados.juros_mes === '' ? 0 : v.percentual(dados.juros_mes, 'os juros ao mês', { max: 10 }),
    multa_ppm: dados.multa === undefined || dados.multa === null || dados.multa === '' ? 0 : v.percentual(dados.multa, 'a multa', { max: 10 }),
    desconto_centavos: desconto,
    desconto_ate: descontoAte,
    dias_baixa: v.inteiroOpcional(dados.dias_baixa, 'os dias para baixa', { min: 0, max: 999 }) ?? 60,
    mensagem: v.opcional(dados.mensagem, 'a mensagem', 160),
  };
}

/**
 * Emite um boleto: reserva o nosso número, registra no banco e grava o título já com o preço congelado.
 * Em caso de falha no banco, o título fica como 'falha' com o motivo — o nosso número não é reaproveitado
 * (o banco pode tê-lo recebido), e a tela permite tentar de novo gerando outro.
 */
async function emitir(db, { cliente, dados, usuario = null, usuarioCliente = null, origem = 'avulso', ixc = {} }) {
  if (cliente.situacao !== 'ativo') throw new ErroNegocio(`O cliente está ${cliente.situacao}: não é possível emitir boletos.`, 409);
  const entrada = validarEntrada(dados, cliente);
  const conta = contaDe(db, dados.conta_id);
  if (entrada.tipo === 'bolepix' && !conta.pix_chave) {
    throw new ErroNegocio('A conta bancária não tem chave PIX cadastrada: só é possível emitir boleto comum.', 409);
  }
  const preco = precos.vigente(db, cliente.id, entrada.emissao);
  const congelado = precos.congelar(preco, conta);

  // Evita duplicar o mesmo título vindo do IXC.
  if (origem === 'ixc' && ixc.receber_id) {
    const existente = db.prepare("SELECT id, nosso_numero FROM boletos WHERE cliente_id = ? AND ixc_receber_id = ? AND situacao NOT IN ('cancelado','falha')")
      .get(cliente.id, String(ixc.receber_id));
    if (existente) return { ...existente, ja_existia: true };
  }

  const nossoNumero = transacao(db, () => proximoNossoNumero(db, conta));
  const boleto = { ...entrada, nosso_numero: nossoNumero, cliente_id: cliente.id, conta_id: conta.id };

  let registro = null;
  let erro = null;
  let porArquivo = false;
  try {
    const banco = criarBanco(conta, credenciaisDaConta(db, conta.id));
    porArquivo = banco.modo === 'cnab';
    registro = await banco.registrar(boleto);
  } catch (err) {
    erro = err.message || 'Falha ao registrar no banco.';
    // Sem resposta do banco ainda calculamos o código: o título fica como falha e pode ser consultado depois.
    registro = febraban.boletoBradesco({
      agencia: conta.agencia, conta: conta.conta, carteira: conta.carteira,
      nossoNumero, valorCentavos: entrada.valor_centavos, vencimento: entrada.vencimento,
    });
  }

  return transacao(db, () => {
    const id = db.prepare(`INSERT INTO boletos (
        cliente_id, conta_id, nosso_numero, nosso_numero_dv, seu_numero, origem, ixc_receber_id, ixc_cliente_id, tipo,
        pagador_nome, pagador_documento, pagador_email, pagador_telefone, pagador_cep, pagador_endereco, pagador_numero,
        pagador_bairro, pagador_cidade, pagador_uf,
        valor_centavos, emissao, vencimento, juros_mes_ppm, multa_ppm, desconto_centavos, desconto_ate, dias_baixa, mensagem,
        codigo_barras, linha_digitavel, pix_txid, pix_emv, situacao, erro_registro, registrado_em,
        preco_id, tarifa_emissao_centavos, tarifa_liquidacao_centavos, percentual_ppm, comissao_minima_centavos,
        comissao_maxima_centavos, custo_liquidacao_centavos, criado_em, criado_por, criado_por_cliente)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id`).get(
      cliente.id, conta.id, nossoNumero, registro.nosso_numero_dv, entrada.seu_numero, origem,
      ixc.receber_id ? String(ixc.receber_id) : null, ixc.cliente_id ? String(ixc.cliente_id) : null, entrada.tipo,
      entrada.pagador_nome, entrada.pagador_documento, entrada.pagador_email, entrada.pagador_telefone, entrada.pagador_cep,
      entrada.pagador_endereco, entrada.pagador_numero, entrada.pagador_bairro, entrada.pagador_cidade, entrada.pagador_uf,
      entrada.valor_centavos, entrada.emissao, entrada.vencimento, entrada.juros_mes_ppm, entrada.multa_ppm,
      entrada.desconto_centavos, entrada.desconto_ate, entrada.dias_baixa, entrada.mensagem,
      registro.codigo_barras, registro.linha_digitavel, registro.pix_txid ?? null, registro.pix_emv ?? null,
      erro ? 'falha' : porArquivo ? 'registrando' : 'registrado', erro, erro || porArquivo ? null : agora(),
      congelado.preco_id, congelado.tarifa_emissao_centavos, congelado.tarifa_liquidacao_centavos, congelado.percentual_ppm,
      congelado.comissao_minima_centavos, congelado.comissao_maxima_centavos, congelado.custo_liquidacao_centavos,
      agora(), usuario?.id ?? null, usuarioCliente?.id ?? null,
    ).id;

    // Tarifa de emissão: cobrada no registro, mesmo que o título não seja pago.
    if (!erro && congelado.tarifa_emissao_centavos > 0) {
      razao.lancar(db, {
        cliente_id: cliente.id,
        boleto_id: id,
        tipo: 'tarifa_emissao',
        valor_centavos: -congelado.tarifa_emissao_centavos,
        descricao: `Tarifa de emissão · boleto ${febraban.formatarNossoNumero(nossoNumero, registro.nosso_numero_dv)}`,
        data_competencia: entrada.emissao,
        data_liberacao: entrada.emissao,
        criado_por: usuario?.id ?? null,
      });
    }
    return { id, nosso_numero: nossoNumero, situacao: erro ? 'falha' : 'registrado', erro };
  });
}

/**
 * Liquida o título e faz o split, numa transação só. Idempotente: se o boleto já está liquidado, não refaz nada.
 * @param {{pago_em: string, valor_pago_centavos: number, juros_centavos?: number, desconto_centavos?: number, meio?: string}} pagamento
 */
function liquidar(db, boletoId, pagamento, { usuario = null, origem = 'webhook' } = {}) {
  return transacao(db, () => {
    const b = db.prepare('SELECT * FROM boletos WHERE id = ?').get(boletoId);
    if (!b) throw naoEncontrado('Boleto');
    if (b.situacao === 'liquidado') return { ja_liquidado: true, boleto_id: b.id };
    if (b.situacao === 'cancelado') throw new ErroNegocio('Boleto cancelado não pode ser liquidado.', 409);

    const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(b.cliente_id);
    const pagoEm = v.data(pagamento.pago_em ?? hoje(), 'a data do pagamento');
    const valorPago = Number(pagamento.valor_pago_centavos ?? b.valor_centavos);
    if (!Number.isInteger(valorPago) || valorPago <= 0) throw new ErroNegocio('Valor pago inválido.', 422);

    const split = precos.calcularSplit({
      valorPagoCentavos: valorPago,
      preco: precos.doBoleto(b),
      custoLiquidacaoCentavos: b.custo_liquidacao_centavos,
    });
    // A retenção conta em dias úteis a partir do crédito: é quando o dinheiro de fato está na conta.
    const liberacao = datas.somarDiasUteis(pagoEm, cliente.retencao_dias);
    const ref = febraban.formatarNossoNumero(b.nosso_numero, b.nosso_numero_dv);

    db.prepare(`UPDATE boletos SET situacao = 'liquidado', pago_em = ?, pago_valor_centavos = ?, pago_juros_centavos = ?,
        pago_desconto_centavos = ?, pago_meio = ?, liquidado_em = ?, versao = versao + 1 WHERE id = ?`)
      .run(pagoEm, valorPago, Number(pagamento.juros_centavos ?? 0), Number(pagamento.desconto_centavos ?? 0),
        pagamento.meio === 'pix' ? 'pix' : 'boleto', agora(), b.id);

    const comum = { cliente_id: b.cliente_id, boleto_id: b.id, data_competencia: pagoEm, data_liberacao: liberacao, criado_por: usuario?.id ?? null };
    razao.lancar(db, { ...comum, tipo: 'credito_liquidacao', valor_centavos: split.bruto_centavos,
      descricao: `Recebimento ${ref} · ${b.pagador_nome}` });
    razao.lancar(db, { ...comum, tipo: 'tarifa_banco', valor_centavos: -split.tarifa_banco_centavos,
      descricao: `Tarifa bancária ${ref}` });
    razao.lancar(db, { ...comum, tipo: 'comissao', valor_centavos: -split.comissao_centavos,
      descricao: `Tarifa PayAx ${precos.percentualTexto(b.percentual_ppm)} ${ref}` });

    return { boleto_id: b.id, cliente_id: b.cliente_id, pago_em: pagoEm, liberacao, origem, ...split };
  });
}

/** Desfaz uma liquidação (devolução/estorno do banco): contrapartida no razão, sem apagar nada. */
function estornarLiquidacao(db, boletoId, motivo, usuario = null) {
  return transacao(db, () => {
    const b = db.prepare('SELECT * FROM boletos WHERE id = ?').get(boletoId);
    if (!b) throw naoEncontrado('Boleto');
    if (b.situacao !== 'liquidado') throw new ErroNegocio('Só é possível estornar um título liquidado.', 409);
    const lancs = db.prepare("SELECT * FROM lancamentos WHERE boleto_id = ? AND tipo IN ('credito_liquidacao','tarifa_banco','comissao')").all(b.id);
    const data = hoje();
    for (const l of lancs) {
      razao.lancar(db, {
        cliente_id: b.cliente_id, boleto_id: b.id, tipo: 'estorno', valor_centavos: -l.valor_centavos,
        descricao: `Estorno · ${l.descricao}`, data_competencia: data, data_liberacao: data, criado_por: usuario?.id ?? null,
      });
    }
    db.prepare(`UPDATE boletos SET situacao = 'registrado', pago_em = NULL, pago_valor_centavos = NULL, liquidado_em = NULL,
        motivo_baixa = ?, versao = versao + 1 WHERE id = ?`).run(`Liquidação estornada: ${motivo}`, b.id);
    return { boleto_id: b.id, estornados: lancs.length };
  });
}

/** Baixa (cancela) o título no banco e no sistema. */
async function baixar(db, boletoId, motivo, { usuario = null } = {}) {
  const b = db.prepare('SELECT * FROM boletos WHERE id = ?').get(boletoId);
  if (!b) throw naoEncontrado('Boleto');
  if (b.situacao === 'liquidado') throw new ErroNegocio('Boleto já liquidado não pode ser baixado.', 409);
  if (b.situacao === 'baixado' || b.situacao === 'cancelado') return { ja_baixado: true, boleto_id: b.id };
  const conta = db.prepare('SELECT * FROM contas_bancarias WHERE id = ?').get(b.conta_id);
  let erro = null;
  let porArquivo = false;
  if (b.situacao === 'registrado' || b.situacao === 'registrando') {
    try {
      const banco = criarBanco(conta, credenciaisDaConta(db, conta.id));
      porArquivo = banco.modo === 'cnab';
      await banco.baixar(b.nosso_numero, motivo ?? 'Baixa solicitada pelo beneficiário');
    } catch (err) {
      erro = err.message;
    }
  }
  if (erro) throw new ErroNegocio(`O banco recusou a baixa: ${erro}`, 502);
  // No modo arquivo o pedido de baixa vai na próxima remessa (ocorrência 02), sem ninguém gerar nada.
  db.prepare(`UPDATE boletos SET situacao = 'baixado', baixado_em = ?, motivo_baixa = ?,
      comando_pendente = CASE WHEN ? AND remessa_id IS NOT NULL THEN '02' ELSE comando_pendente END,
      versao = versao + 1 WHERE id = ?`)
    .run(agora(), v.opcional(motivo, 'o motivo', 160), porArquivo ? 1 : 0, b.id);
  return { boleto_id: b.id, situacao: 'baixado', instrucao_na_proxima_remessa: porArquivo };
}

/**
 * Valor a pagar hoje: com desconto até a data limite, ou com multa e juros proporcionais depois do vencimento.
 * Juros são pro rata die sobre a taxa mensal; a multa é única.
 */
function valorAtualizado(b, data = hoje()) {
  const base = b.valor_centavos;
  if (b.desconto_centavos && b.desconto_ate && data <= b.desconto_ate) {
    return { valor_centavos: base - b.desconto_centavos, desconto_centavos: b.desconto_centavos, multa_centavos: 0, juros_centavos: 0 };
  }
  if (data <= b.vencimento) return { valor_centavos: base, desconto_centavos: 0, multa_centavos: 0, juros_centavos: 0 };
  const diasAtraso = datas.diasEntre(b.vencimento, data);
  const multa = Math.round((base * (b.multa_ppm || 0)) / 1_000_000);
  const juros = Math.round((base * (b.juros_mes_ppm || 0) * diasAtraso) / (1_000_000 * 30));
  return { valor_centavos: base + multa + juros, desconto_centavos: 0, multa_centavos: multa, juros_centavos: juros, dias_atraso: diasAtraso };
}

/** Situação para mostrar na tela: 'registrado' vencido vira 'vencido'. */
function situacaoVisivel(b, data = hoje()) {
  if (b.situacao === 'registrado' && b.vencimento < data) return 'vencido';
  return b.situacao;
}

module.exports = { emitir, liquidar, estornarLiquidacao, baixar, valorAtualizado, situacaoVisivel, contaDe, credenciaisDaConta, proximoNossoNumero, validarEntrada, hoje };
