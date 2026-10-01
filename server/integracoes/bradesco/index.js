'use strict';

const QRCode = require('qrcode');
const config = require('../../config');
const { transacao } = require('../../db');
const { ErroNegocio, naoEncontrado } = require('../../lib/erros');
const v = require('../../lib/validacao');
const { registrar } = require('../../lib/auditoria');
const { buscarConta, exigirContaOperavel, novoGrupo, lancar, exigirAlcada } = require('../../lib/conta');
const { SimuladorBradesco } = require('./simulador');
const { ApiBradesco } = require('./api');
const { gerarTxid, decimalParaCentavos } = require('./util');
const { canalDe } = require('../../lib/movimentos');
const { lerBoleto } = require('../../lib/boleto');

const SISTEMA = { usuario: null, ip: 'bradesco' };
const DIA = 24 * 60 * 60 * 1000;

/**
 * O cliente final não sabe qual banco liquida as operações da PAY AX: para ele, a mensagem é genérica.
 * A equipe (Banqueiro) recebe o detalhe técnico.
 */
const mensagemParaCliente = (req, err, generica) => (req.cliente ? generica : err.message);

function criarCliente(db, cfg) {
  if (cfg.modo === 'simulador') return new SimuladorBradesco(db, cfg);
  if (['sandbox', 'producao'].includes(cfg.modo)) return new ApiBradesco(cfg);
  throw new Error(`BRADESCO_MODO inválido: ${cfg.modo}`);
}

/** Valida e normaliza uma chave PIX de outro banco. Retorna null se o formato não for reconhecido. */
function normalizarChaveExterna(chave) {
  const s = String(chave ?? '').trim();
  if (v.emailValido(s)) return s.toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return s.toLowerCase();
  const d = v.digitos(s);
  if (s.startsWith('+')) return d.length >= 12 && d.length <= 13 ? `+${d}` : null;
  if (v.cpfValido(d) || v.cnpjValido(d)) return d;
  if (d.length >= 10 && d.length <= 11) return `+55${d}`;
  return null;
}

/**
 * Serviço da conta única PAY AX no Bradesco. O dinheiro entra e sai pelo Bradesco; o Banqueiro
 * mantém o saldo de cada cliente e concilia o total com o saldo da conta no banco.
 */
function criarServicoBradesco(db, cfg = config.bradesco, cliente = criarCliente(db, cfg)) {
  const qr = (texto) => QRCode.toString(texto, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });

  async function gerarCobranca(req, contaId, valorBruto) {
    const conta = buscarConta(db, contaId);
    exigirContaOperavel(conta);
    const valor = v.valorCentavos(valorBruto);
    const txid = gerarTxid();
    let r;
    try {
      r = await cliente.criarCobranca({
        txid, valorCentavos: valor, expiracaoSegundos: cfg.expiracaoCobrancaSegundos,
        solicitacao: `Depósito PAY AX conta ${conta.numero}-${conta.digito}`,
      });
    } catch (err) {
      throw new ErroNegocio(mensagemParaCliente(req, err, 'Não foi possível gerar o QR Code agora. Tente novamente em instantes.'), err.status ?? 502);
    }
    db.prepare(`INSERT INTO cobrancas_pix (conta_id, txid, valor_centavos, pix_copia_e_cola, expira_em, usuario_id)
      VALUES (?, ?, ?, ?, datetime('now', ?), ?)`)
      .run(conta.id, txid, valor, r.pixCopiaECola, `+${cfg.expiracaoCobrancaSegundos} seconds`, req.usuario?.id ?? null);
    registrar(db, req, 'gerar_cobranca_pix', 'conta', conta.id, { txid, valor_centavos: valor });
    return detalharCobranca(txid);
  }

  async function detalharCobranca(txid) {
    const c = db.prepare(`SELECT p.*, c.numero, c.digito, c.agencia, cl.nome AS cliente_nome
      FROM cobrancas_pix p JOIN contas c ON c.id = p.conta_id JOIN clientes cl ON cl.id = c.cliente_id WHERE p.txid = ?`).get(txid);
    if (!c) throw naoEncontrado('Cobrança');
    return { ...c, qr_svg: c.pix_copia_e_cola ? await qr(c.pix_copia_e_cola) : null };
  }

  /** Processa PIX recebidos (webhook ou sincronização). Idempotente por endToEndId. */
  function processarRecebidos(lista, req = SISTEMA) {
    const resumo = { creditados: 0, sem_vinculo: 0, duplicados: 0 };
    for (const p of lista ?? []) {
      if (!p?.endToEndId) continue;
      if (db.prepare('SELECT 1 FROM pix_recebidos WHERE end_to_end_id = ?').get(p.endToEndId)) { resumo.duplicados++; continue; }
      const valor = decimalParaCentavos(p.valor);
      const pagadorNome = p.pagador?.nome ?? null;
      const pagadorDoc = p.pagador?.cpf ?? p.pagador?.cnpj ?? null;
      transacao(db, () => {
        const cob = p.txid ? db.prepare('SELECT * FROM cobrancas_pix WHERE txid = ?').get(p.txid) : null;
        let motivo = null;
        if (!cob) motivo = p.txid ? 'Cobrança não encontrada no Banqueiro.' : 'PIX sem identificação de cobrança (txid).';
        else if (cob.status === 'concluida') motivo = 'Cobrança já paga anteriormente.';
        let conta = null;
        if (!motivo) {
          conta = buscarConta(db, cob.conta_id);
          if (conta.status !== 'ativa' || conta.cliente_status !== 'ativo') motivo = `Conta ${conta.numero}-${conta.digito} não está ativa.`;
        }
        if (motivo) {
          db.prepare(`INSERT INTO pix_recebidos (end_to_end_id, txid, valor_centavos, pagador_nome, pagador_documento, info_pagador, status, motivo, recebido_em)
            VALUES (?, ?, ?, ?, ?, ?, 'sem_vinculo', ?, ?)`).run(p.endToEndId, p.txid ?? null, valor, pagadorNome, pagadorDoc, p.infoPagador ?? null, motivo, p.horario ?? null);
          registrar(db, req, 'pix_sem_vinculo', 'transacao', null, { end_to_end_id: p.endToEndId, valor_centavos: valor, motivo });
          resumo.sem_vinculo++;
          return;
        }
        const t = lancar(db, {
          contaId: conta.id, tipo: 'pix_recebido', valor, grupo: novoGrupo(), usuarioId: req.usuario?.id ?? null,
          descricao: `PIX recebido${pagadorNome ? ` · ${pagadorNome}` : ''}`,
        });
        db.prepare("UPDATE cobrancas_pix SET status = 'concluida', end_to_end_id = ?, pago_em = datetime('now') WHERE id = ?").run(p.endToEndId, cob.id);
        db.prepare(`INSERT INTO pix_recebidos (end_to_end_id, txid, valor_centavos, pagador_nome, pagador_documento, info_pagador, conta_id, transacao_id, status, recebido_em)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'creditado', ?)`).run(p.endToEndId, p.txid, valor, pagadorNome, pagadorDoc, p.infoPagador ?? null, conta.id, t.id, p.horario ?? null);
        registrar(db, req, 'pix_recebido_bradesco', 'conta', conta.id, { txid: p.txid, end_to_end_id: p.endToEndId, valor_centavos: valor });
        resumo.creditados++;
      });
    }
    return resumo;
  }

  async function sincronizar(req) {
    db.prepare("UPDATE cobrancas_pix SET status = 'expirada' WHERE status = 'ativa' AND expira_em < datetime('now')").run();
    const lista = await cliente.pixRecebidos({ inicio: new Date(Date.now() - 5 * DIA), fim: new Date() });
    const resumo = processarRecebidos(lista, req);
    registrar(db, req, 'sincronizar_bradesco', 'transacao', null, resumo);
    return resumo;
  }

  function vincular(req, recebidoId, contaId) {
    const p = db.prepare('SELECT * FROM pix_recebidos WHERE id = ?').get(recebidoId);
    if (!p) throw naoEncontrado('PIX recebido');
    if (p.status !== 'sem_vinculo') throw new ErroNegocio('Este PIX já foi creditado.', 409);
    const conta = buscarConta(db, contaId);
    exigirContaOperavel(conta);
    return transacao(db, () => {
      const t = lancar(db, {
        contaId: conta.id, tipo: 'pix_recebido', valor: p.valor_centavos, grupo: novoGrupo(), usuarioId: req.usuario?.id ?? null,
        descricao: `PIX recebido${p.pagador_nome ? ` · ${p.pagador_nome}` : ''}`,
      });
      db.prepare("UPDATE pix_recebidos SET status = 'creditado', conta_id = ?, transacao_id = ? WHERE id = ?").run(conta.id, t.id, p.id);
      registrar(db, req, 'vincular_pix', 'conta', conta.id, { end_to_end_id: p.end_to_end_id, valor_centavos: p.valor_centavos });
      return { ok: true, transacao_id: t.id };
    });
  }

  /** Debita o cliente, envia o PIX pela conta PAY AX no Bradesco e devolve o valor se o banco recusar. */
  async function enviarPixExterno(req, origem, chaveBruta, valor, descricao) {
    const chave = normalizarChaveExterna(chaveBruta);
    if (!chave) throw new ErroNegocio('Chave PIX não encontrada na PAY AX e em formato inválido para outro banco.', 422);
    exigirContaOperavel(origem);
    exigirAlcada(req, valor);
    const idempotencia = gerarTxid();
    const usuarioId = req.usuario?.id ?? null;
    const canal = canalDe(req);
    const { saidaId, debito } = transacao(db, () => {
      const t = lancar(db, { contaId: origem.id, tipo: 'pix_enviado', valor: -valor, descricao: `PIX para ${chave} (outro banco)${descricao ? ` · ${descricao}` : ''}`, grupo: novoGrupo(), usuarioId, canal });
      const s = db.prepare('INSERT INTO pix_saidas (conta_id, transacao_id, valor_centavos, chave, descricao, idempotencia, usuario_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(origem.id, t.id, valor, chave, descricao, idempotencia, usuarioId);
      return { saidaId: Number(s.lastInsertRowid), debito: t };
    });
    try {
      const r = await cliente.enviarPix({ idempotencia, chave, valorCentavos: valor, descricao });
      db.prepare("UPDATE pix_saidas SET status = 'concluido', end_to_end_id = ?, atualizado_em = datetime('now') WHERE id = ?").run(r.endToEndId, saidaId);
      registrar(db, req, 'pix_externo', 'conta', origem.id, { chave, valor_centavos: valor, end_to_end_id: r.endToEndId });
      return { externo: true, chave, end_to_end_id: r.endToEndId, transacao_id: debito.id, saldo_origem_centavos: debito.saldo_apos_centavos };
    } catch (err) {
      transacao(db, () => {
        lancar(db, { contaId: origem.id, tipo: 'estorno', valor, descricao: `Estorno automático: PIX para ${chave} não enviado`, grupo: novoGrupo(), usuarioId, canal, ignorarLimite: true });
        db.prepare("UPDATE transacoes SET estornada_em = datetime('now') WHERE id = ?").run(debito.id);
        db.prepare("UPDATE pix_saidas SET status = 'falhou', erro = ?, atualizado_em = datetime('now') WHERE id = ?").run(err.message, saidaId);
        registrar(db, req, 'pix_externo_falhou', 'conta', origem.id, { chave, valor_centavos: valor, erro: err.message });
      });
      throw new ErroNegocio(req.cliente
        ? 'Não foi possível concluir o PIX agora. O valor voltou para a sua conta; tente novamente em instantes.'
        : `O PIX não foi enviado (${err.message}). O valor voltou para a conta do cliente.`, 502);
    }
  }

  /** Paga boleto/conta de consumo pela conta PAY AX no Bradesco, debitando o cliente; devolve se o banco recusar. */
  async function pagarBoleto(req, origem, linha, valorInformado) {
    const b = lerBoleto(linha);
    const valor = b.valor_centavos || v.valorCentavos(valorInformado, 'valor do pagamento');
    exigirContaOperavel(origem);
    exigirAlcada(req, valor);
    const idempotencia = gerarTxid();
    const usuarioId = req.usuario?.id ?? null;
    const canal = canalDe(req);
    const rotulo = b.tipo === 'boleto' ? `Pagamento de boleto (banco ${b.banco})` : 'Pagamento de conta de consumo';
    const { pagamentoId, debito } = transacao(db, () => {
      const t = lancar(db, { contaId: origem.id, tipo: 'pagamento', valor: -valor, descricao: rotulo, grupo: novoGrupo(), usuarioId, canal });
      const s = db.prepare(`INSERT INTO pagamentos (conta_id, transacao_id, tipo, codigo_barras, linha_digitavel, valor_centavos, vencimento, idempotencia, canal)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(origem.id, t.id, b.tipo, b.codigo_barras, b.linha_digitavel, valor, b.vencimento, idempotencia, canal);
      return { pagamentoId: Number(s.lastInsertRowid), debito: t };
    });
    try {
      const r = await cliente.pagarBoleto({ idempotencia, codigoBarras: b.codigo_barras, valorCentavos: valor });
      db.prepare("UPDATE pagamentos SET status = 'concluido', autenticacao = ?, atualizado_em = datetime('now') WHERE id = ?").run(r.autenticacao, pagamentoId);
      registrar(db, req, 'pagamento', 'conta', origem.id, { tipo: b.tipo, valor_centavos: valor, autenticacao: r.autenticacao });
      return { ...b, valor_centavos: valor, autenticacao: r.autenticacao, transacao_id: debito.id, saldo_centavos: debito.saldo_apos_centavos };
    } catch (err) {
      transacao(db, () => {
        lancar(db, { contaId: origem.id, tipo: 'estorno', valor, descricao: `Estorno automático: ${rotulo.toLowerCase()} não realizado`, grupo: novoGrupo(), usuarioId, canal, ignorarLimite: true });
        db.prepare("UPDATE transacoes SET estornada_em = datetime('now') WHERE id = ?").run(debito.id);
        db.prepare("UPDATE pagamentos SET status = 'falhou', erro = ?, atualizado_em = datetime('now') WHERE id = ?").run(err.message, pagamentoId);
        registrar(db, req, 'pagamento_falhou', 'conta', origem.id, { valor_centavos: valor, erro: err.message });
      });
      throw new ErroNegocio(req.cliente
        ? 'Não foi possível concluir o pagamento agora. O valor voltou para a sua conta; tente novamente em instantes.'
        : `O pagamento não foi realizado (${err.message}). O valor voltou para a conta.`, 502);
    }
  }

  async function conciliacao() {
    const avisos = [];
    const tentar = async (fn) => { try { return await fn(); } catch (e) { avisos.push(e.message); return null; } };
    const saldoBanco = await tentar(() => cliente.saldo());
    const extrato = await tentar(() => cliente.extrato({ inicio: new Date(Date.now() - 30 * DIA) }));
    const clientes = db.prepare(`SELECT COALESCE(SUM(saldo_centavos),0) AS total,
        COALESCE(SUM(CASE WHEN saldo_centavos > 0 THEN saldo_centavos END),0) AS credores,
        COALESCE(-SUM(CASE WHEN saldo_centavos < 0 THEN saldo_centavos END),0) AS devedores
      FROM contas WHERE status <> 'encerrada'`).get();
    const conhecidos = new Set([
      ...db.prepare('SELECT end_to_end_id FROM pix_recebidos').all().map((r) => r.end_to_end_id),
      ...db.prepare('SELECT end_to_end_id FROM pix_saidas WHERE end_to_end_id IS NOT NULL').all().map((r) => r.end_to_end_id),
      ...db.prepare('SELECT autenticacao FROM pagamentos WHERE autenticacao IS NOT NULL').all().map((r) => r.autenticacao),
    ]);
    return {
      modo: cliente.modo,
      saldo_bradesco_centavos: saldoBanco,
      clientes_total_centavos: clientes.total,
      clientes_credores_centavos: clientes.credores,
      clientes_devedores_centavos: clientes.devedores,
      diferenca_centavos: saldoBanco === null ? null : saldoBanco - clientes.total,
      extrato: extrato?.map((m) => ({ ...m, conciliado: m.descricao === 'Saldo inicial' || (m.end_to_end_id ? conhecidos.has(m.end_to_end_id) : false) })) ?? null,
      sem_vinculo: db.prepare("SELECT * FROM pix_recebidos WHERE status = 'sem_vinculo' ORDER BY id DESC").all(),
      saidas: db.prepare(`SELECT s.*, c.numero || '-' || c.digito AS conta, cl.nome AS cliente_nome FROM pix_saidas s
        JOIN contas c ON c.id = s.conta_id JOIN clientes cl ON cl.id = c.cliente_id ORDER BY s.id DESC LIMIT 20`).all(),
      cobrancas: db.prepare(`SELECT p.id, p.txid, p.valor_centavos, p.status, p.criado_em, p.pago_em, c.id AS conta_id, c.numero || '-' || c.digito AS conta, cl.nome AS cliente_nome
        FROM cobrancas_pix p JOIN contas c ON c.id = p.conta_id JOIN clientes cl ON cl.id = c.cliente_id ORDER BY p.id DESC LIMIT 20`).all(),
      avisos,
    };
  }

  function simularPagamento(req, txid) {
    if (cliente.modo !== 'simulador') throw new ErroNegocio('Disponível apenas no modo simulador.', 409);
    const cob = db.prepare('SELECT * FROM cobrancas_pix WHERE txid = ?').get(txid);
    if (!cob) throw naoEncontrado('Cobrança');
    const corpo = cliente.simularPagamento(txid);
    return processarRecebidos(corpo.pix, req);
  }

  function simularPixAvulso(req, valorBruto) {
    if (cliente.modo !== 'simulador') throw new ErroNegocio('Disponível apenas no modo simulador.', 409);
    return processarRecebidos(cliente.simularPixAvulso(v.valorCentavos(valorBruto)).pix, req);
  }

  async function configurarWebhook(req, url) {
    v.exigir(/^https:\/\//.test(String(url ?? '')), 'Informe a URL pública HTTPS do webhook.');
    const r = await cliente.configurarWebhook(url);
    registrar(db, req, 'configurar_webhook', 'usuario', req.usuario.id, { url: url.replace(/token=[^&]+/, 'token=***') });
    return r;
  }

  const status = () => ({
    modo: cliente.modo,
    chave_pix: cfg.chavePix,
    webhook_protegido: Boolean(cfg.webhookToken),
  });

  return {
    cliente, gerarCobranca, detalharCobranca, processarRecebidos, sincronizar, vincular,
    enviarPixExterno, pagarBoleto, conciliacao, simularPagamento, simularPixAvulso, configurarWebhook, status, normalizarChaveExterna,
  };
}

module.exports = { criarServicoBradesco, normalizarChaveExterna };
