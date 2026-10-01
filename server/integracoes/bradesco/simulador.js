'use strict';

/*
 * Simulador da conta PAY AX no Bradesco. Reproduz o comportamento da API PIX do Banco Central
 * (cobranças, PIX recebidos, webhook) e de saldo/extrato/envio, guardando o estado no próprio banco
 * de dados. Permite testar o Banqueiro de ponta a ponta antes de receber as credenciais reais.
 */
const crypto = require('node:crypto');
const { gerarBrCode } = require('./brcode');
const { centavosParaDecimal, ErroBradesco } = require('./util');

const ISPB_BRADESCO = '60746948';

function endToEndId() {
  const agora = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
  return `E${ISPB_BRADESCO}${agora}${crypto.randomUUID().replace(/-/g, '').slice(0, 11)}`;
}

class SimuladorBradesco {
  constructor(db, cfg) {
    this.db = db;
    this.cfg = cfg;
    this.modo = 'simulador';
  }

  /** Na primeira utilização, abre a conta simulada com o total já custodiado pelo Banqueiro. */
  abrirConta() {
    if (this.db.prepare('SELECT 1 FROM bradesco_sim_movimentos LIMIT 1').get()) return;
    const { total } = this.db.prepare("SELECT COALESCE(SUM(saldo_centavos),0) AS total FROM contas WHERE status <> 'encerrada'").get();
    this.db.prepare("INSERT INTO bradesco_sim_movimentos (natureza, valor_centavos, descricao) VALUES ('C', ?, 'Saldo inicial')")
      .run(Math.max(0, total));
  }

  saldoSync() {
    this.abrirConta();
    return this.db.prepare(`SELECT COALESCE(SUM(CASE natureza WHEN 'C' THEN valor_centavos ELSE -valor_centavos END),0) AS s
      FROM bradesco_sim_movimentos`).get().s;
  }

  async criarCobranca({ txid, valorCentavos }) {
    this.abrirConta();
    const pixCopiaECola = gerarBrCode({
      location: `pix.simulador.payax.local/qr/v2/${txid}`,
      nome: this.cfg.nomeRecebedor, cidade: this.cfg.cidadeRecebedor, valorCentavos,
    });
    this.db.prepare("INSERT INTO bradesco_sim_cobrancas (txid, valor_centavos, status, pix_copia_e_cola) VALUES (?, ?, 'ATIVA', ?)")
      .run(txid, valorCentavos, pixCopiaECola);
    return { txid, status: 'ATIVA', pixCopiaECola };
  }

  async consultarCobranca(txid) {
    const c = this.db.prepare('SELECT * FROM bradesco_sim_cobrancas WHERE txid = ?').get(txid);
    if (!c) throw new ErroBradesco('Cobrança não encontrada no Bradesco.', 404);
    return { txid, status: c.status, pixCopiaECola: c.pix_copia_e_cola, valor: { original: centavosParaDecimal(c.valor_centavos) } };
  }

  /** Simula um pagador quitando a cobrança e devolve o corpo do webhook que o banco enviaria. */
  simularPagamento(txid, pagador = { nome: 'PAGADOR SIMULADO', cpf: '12345678909' }) {
    this.abrirConta();
    const c = this.db.prepare('SELECT * FROM bradesco_sim_cobrancas WHERE txid = ?').get(txid);
    if (!c) throw new ErroBradesco('Cobrança não encontrada no Bradesco.', 404);
    if (c.status !== 'ATIVA') throw new ErroBradesco(`Cobrança ${c.status.toLowerCase()} no Bradesco.`, 409);
    const e2e = endToEndId();
    this.db.prepare("UPDATE bradesco_sim_cobrancas SET status = 'CONCLUIDA' WHERE txid = ?").run(txid);
    this.db.prepare(`INSERT INTO bradesco_sim_movimentos (natureza, valor_centavos, descricao, end_to_end_id, txid, pagador_nome, pagador_documento)
      VALUES ('C', ?, 'PIX recebido', ?, ?, ?, ?)`).run(c.valor_centavos, e2e, txid, pagador.nome, pagador.cpf ?? pagador.cnpj);
    return { pix: [{ endToEndId: e2e, txid, valor: centavosParaDecimal(c.valor_centavos), horario: new Date().toISOString(), pagador }] };
  }

  /** Simula alguém enviando PIX direto para a chave da PAY AX, sem cobrança (sem txid). */
  simularPixAvulso(valorCentavos, pagador = { nome: 'PAGADOR AVULSO', cpf: '12345678909' }) {
    this.abrirConta();
    const e2e = endToEndId();
    this.db.prepare(`INSERT INTO bradesco_sim_movimentos (natureza, valor_centavos, descricao, end_to_end_id, pagador_nome, pagador_documento)
      VALUES ('C', ?, 'PIX recebido sem cobrança', ?, ?, ?)`).run(valorCentavos, e2e, pagador.nome, pagador.cpf);
    return { pix: [{ endToEndId: e2e, valor: centavosParaDecimal(valorCentavos), horario: new Date().toISOString(), pagador }] };
  }

  async pixRecebidos({ inicio }) {
    this.abrirConta();
    return this.db.prepare(`SELECT * FROM bradesco_sim_movimentos WHERE natureza = 'C' AND end_to_end_id IS NOT NULL
        AND criado_em >= datetime(?) ORDER BY id`).all(inicio.toISOString())
      .map((m) => ({ endToEndId: m.end_to_end_id, txid: m.txid, valor: centavosParaDecimal(m.valor_centavos), horario: m.criado_em, pagador: { nome: m.pagador_nome, cpf: m.pagador_documento } }));
  }

  async enviarPix({ chave, valorCentavos, descricao }) {
    if (valorCentavos > this.saldoSync()) throw new ErroBradesco('Saldo insuficiente na conta PAY AX no Bradesco.', 422);
    const e2e = endToEndId();
    this.db.prepare("INSERT INTO bradesco_sim_movimentos (natureza, valor_centavos, descricao, end_to_end_id) VALUES ('D', ?, ?, ?)")
      .run(valorCentavos, `PIX enviado para ${chave}${descricao ? ` · ${descricao}` : ''}`, e2e);
    return { endToEndId: e2e, status: 'CONCLUIDO' };
  }

  async pagarBoleto({ codigoBarras, valorCentavos }) {
    if (valorCentavos > this.saldoSync()) throw new ErroBradesco('Saldo insuficiente na conta PAY AX no Bradesco.', 422);
    const autenticacao = `AUT${crypto.randomUUID().replace(/-/g, '').slice(0, 21).toUpperCase()}`;
    this.db.prepare("INSERT INTO bradesco_sim_movimentos (natureza, valor_centavos, descricao, end_to_end_id) VALUES ('D', ?, ?, ?)")
      .run(valorCentavos, `Pagamento ${codigoBarras[0] === '8' ? 'de conta de consumo' : 'de boleto'} ${codigoBarras.slice(0, 3)}…`, autenticacao);
    return { autenticacao, status: 'CONCLUIDO' };
  }

  async saldo() { return this.saldoSync(); }

  async extrato({ inicio }) {
    this.abrirConta();
    return this.db.prepare('SELECT * FROM bradesco_sim_movimentos WHERE criado_em >= datetime(?) OR descricao = \'Saldo inicial\' ORDER BY id DESC LIMIT 200')
      .all(inicio.toISOString())
      .map((m) => ({ data: m.criado_em, natureza: m.natureza, valor_centavos: m.valor_centavos, descricao: m.descricao, end_to_end_id: m.end_to_end_id, txid: m.txid }));
  }

  async configurarWebhook(url) { return { webhookUrl: url, simulado: true }; }
}

module.exports = { SimuladorBradesco };
