'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const { agora, transacao: emTransacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { hoje, somarDias } = require('./datas');

/**
 * Cobrança no cartão pela maquininha, com três provedores:
 *
 *  • simulado    — para testes e demonstração: aprova na hora e gera NSU falso.
 *  • ponte       — maquininha ligada ao caixa (pinpad TEF: PayGo, Elgin, Stone SDK...). O sistema conversa por HTTP
 *                  com um agente instalado na máquina do caixa, que fala com o pinpad. Protocolo esperado:
 *                    POST {url}/pagamento   { valor_centavos, forma, parcelas, referencia }
 *                       -> { id, status: "pendente"|"aprovada"|"negada", nsu, autorizacao, bandeira, mensagem }
 *                    GET  {url}/pagamento/{id}       -> mesmo formato
 *                    POST {url}/pagamento/{id}/cancelar -> { status: "cancelada" }
 *                  O token da maquininha, quando existir, vai no cabeçalho Authorization.
 *  • mercadopago — maquininha inteligente Point pela API do Mercado Pago (Payment Intents), usando o
 *                  número de série do aparelho (identificador) e o token de acesso da conta.
 *
 * Todo pedido nasce como transação 'pendente' no banco: o caixa consulta até aprovar, negar ou expirar.
 * Nada é cobrado sem registro, e nenhuma venda fecha no cartão sem transação aprovada.
 */

const nsuFalso = () => String(crypto.randomInt(100_000, 999_999));
const BANDEIRAS = ['Visa', 'Mastercard', 'Elo', 'Hipercard'];

/** Taxa cobrada pela adquirente, conforme a forma e o número de parcelas. */
function taxaDa(maquininha, forma, parcelas) {
  const bp = forma === 'debito' ? maquininha.taxa_debito_bp : parcelas > 1 ? maquininha.taxa_parcelado_bp : maquininha.taxa_credito_bp;
  return bp;
}

const prazoDe = (maquininha, forma) => (forma === 'debito' ? maquininha.prazo_debito_dias : maquininha.prazo_credito_dias);

async function chamar(url, { metodo = 'GET', corpo, token } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.maquininha.timeoutMs);
  try {
    const resp = await fetch(url, {
      method: metodo,
      signal: ctrl.signal,
      headers: { ...(corpo ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    const texto = await resp.text();
    let dados = {};
    try { dados = texto ? JSON.parse(texto) : {}; } catch { dados = { mensagem: texto.slice(0, 200) }; }
    if (!resp.ok) throw new ErroNegocio(dados.message || dados.erro || dados.mensagem || `A maquininha respondeu ${resp.status}.`, 502);
    return dados;
  } catch (err) {
    if (err instanceof ErroNegocio) throw err;
    throw new ErroNegocio(err.name === 'AbortError' ? 'A maquininha não respondeu a tempo.' : `Não foi possível falar com a maquininha: ${err.message}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

/** Normaliza a resposta de cada provedor para { status, nsu, autorizacao, bandeira, externo_id, mensagem }. */
const DRIVERS = {
  simulado: {
    async iniciar(_maq, pedido) {
      return { status: 'aprovada', nsu: nsuFalso(), autorizacao: nsuFalso(), bandeira: BANDEIRAS[pedido.valor_centavos % BANDEIRAS.length], externo_id: `SIM-${Date.now()}`, mensagem: 'Aprovada (maquininha simulada)' };
    },
    async consultar(_maq, t) {
      return { status: t.status === 'pendente' ? 'aprovada' : t.status, nsu: t.nsu ?? nsuFalso(), autorizacao: t.autorizacao ?? nsuFalso(), bandeira: t.bandeira ?? 'Visa' };
    },
    async cancelar() {
      return { status: 'cancelada', mensagem: 'Cancelada na maquininha simulada' };
    },
  },

  ponte: {
    async iniciar(maq, pedido) {
      const d = await chamar(`${maq.url}/pagamento`, { metodo: 'POST', token: maq.token, corpo: {
        valor_centavos: pedido.valor_centavos, forma: pedido.forma, parcelas: pedido.parcelas, referencia: pedido.referencia,
      } });
      return { status: d.status ?? 'pendente', nsu: d.nsu, autorizacao: d.autorizacao, bandeira: d.bandeira, externo_id: d.id ?? d.externo_id, mensagem: d.mensagem };
    },
    async consultar(maq, t) {
      const d = await chamar(`${maq.url}/pagamento/${encodeURIComponent(t.externo_id)}`, { token: maq.token });
      return { status: d.status ?? 'pendente', nsu: d.nsu, autorizacao: d.autorizacao, bandeira: d.bandeira, mensagem: d.mensagem };
    },
    async cancelar(maq, t) {
      const d = await chamar(`${maq.url}/pagamento/${encodeURIComponent(t.externo_id)}/cancelar`, { metodo: 'POST', token: maq.token });
      return { status: d.status ?? 'cancelada', mensagem: d.mensagem };
    },
  },

  mercadopago: {
    async iniciar(maq, pedido) {
      const d = await chamar(`https://api.mercadopago.com/point/integration-api/devices/${encodeURIComponent(maq.identificador)}/payment-intents`, {
        metodo: 'POST',
        token: maq.token,
        corpo: {
          amount: pedido.valor_centavos,
          description: pedido.referencia,
          payment: { type: pedido.forma === 'debito' ? 'debit_card' : 'credit_card', installments: pedido.parcelas, installments_cost: 'seller' },
        },
      });
      return { status: 'pendente', externo_id: d.id, mensagem: 'Cobrança enviada à maquininha. Peça o cartão ao cliente.' };
    },
    async consultar(maq, t) {
      const d = await chamar(`https://api.mercadopago.com/point/integration-api/payment-intents/${encodeURIComponent(t.externo_id)}`, { token: maq.token });
      const estado = String(d.state ?? '').toUpperCase();
      const status = estado === 'FINISHED' ? 'aprovada'
        : ['CANCELED', 'ABANDONED'].includes(estado) ? 'cancelada'
          : ['ERROR', 'REFUSED', 'REJECTED'].includes(estado) ? 'negada' : 'pendente';
      return { status, nsu: d.payment?.id ? String(d.payment.id) : undefined, autorizacao: d.payment?.authorization_code, bandeira: d.payment?.payment_method?.brand ?? d.payment?.payment_method_id, mensagem: d.state };
    },
    async cancelar(maq, t) {
      await chamar(`https://api.mercadopago.com/point/integration-api/devices/${encodeURIComponent(maq.identificador)}/payment-intents/${encodeURIComponent(t.externo_id)}`, { metodo: 'DELETE', token: maq.token });
      return { status: 'cancelada', mensagem: 'Cobrança cancelada na maquininha' };
    },
  },
};

const maquininhaDe = (db, id) => {
  const m = db.prepare('SELECT * FROM maquininhas WHERE id = ?').get(id);
  if (!m) throw naoEncontrado('Maquininha');
  if (!m.ativa) throw new ErroNegocio('Esta maquininha está desativada.', 409);
  if (m.provedor === 'ponte' && !m.url) throw new ErroNegocio('A ponte da maquininha está sem endereço configurado.', 409);
  if (m.provedor === 'mercadopago' && (!m.identificador || !m.token)) throw new ErroNegocio('A maquininha do Mercado Pago precisa do número de série e do token.', 409);
  return m;
};

const transacaoDe = (db, id) => {
  const t = db.prepare('SELECT * FROM transacoes_cartao WHERE id = ?').get(id);
  if (!t) throw naoEncontrado('Cobrança');
  return t;
};

/**
 * Grava o desfecho da cobrança. Quando aprova, calcula a taxa, o líquido e a data em que o dinheiro cai,
 * e lança o recebível no financeiro (a maquininha paga depois, não na hora da venda).
 */
function aplicarResultado(db, t, maq, resultado) {
  const status = ['pendente', 'aprovada', 'negada', 'cancelada', 'expirada'].includes(resultado.status) ? resultado.status : 'pendente';
  let taxa = t.taxa_centavos;
  let liquido = t.liquido_centavos;
  let previsao = t.previsao_credito;
  if (status === 'aprovada') {
    taxa = Math.round((t.valor_centavos * taxaDa(maq, t.forma, t.parcelas)) / 10_000);
    liquido = t.valor_centavos - taxa;
    previsao = somarDias(hoje(), prazoDe(maq, t.forma));
  }
  db.prepare(`UPDATE transacoes_cartao SET status = ?, nsu = COALESCE(?, nsu), autorizacao = COALESCE(?, autorizacao), bandeira = COALESCE(?, bandeira),
    externo_id = COALESCE(?, externo_id), mensagem = COALESCE(?, mensagem), taxa_centavos = ?, liquido_centavos = ?, previsao_credito = ?, atualizada_em = ? WHERE id = ?`)
    .run(status, resultado.nsu ?? null, resultado.autorizacao ?? null, resultado.bandeira ?? null, resultado.externo_id ?? null,
      resultado.mensagem ?? null, taxa, liquido, previsao, agora(), t.id);

  if (status === 'aprovada' && !db.prepare('SELECT 1 FROM lancamentos WHERE transacao_id = ?').get(t.id)) {
    const parcelado = t.parcelas > 1 ? ` em ${t.parcelas}x` : '';
    db.prepare(`INSERT INTO lancamentos (tipo, descricao, categoria, transacao_id, valor_centavos, vencimento, criado_em)
      VALUES ('receber', ?, 'Cartão', ?, ?, ?, ?)`)
      .run(`Cartão ${t.forma}${parcelado}${t.venda_id ? ` — venda #${t.venda_id}` : ''}`, t.id, liquido, previsao, agora());
  }
  return transacaoDe(db, t.id);
}

/** Envia a cobrança para a maquininha e devolve a transação (já aprovada, no caso da simulada). */
async function cobrar(db, { maquininha_id, venda_id = null, forma, parcelas = 1, valor_centavos }) {
  const maq = maquininhaDe(db, maquininha_id);
  if (!['debito', 'credito'].includes(forma)) throw new ErroNegocio('Forma de pagamento inválida para a maquininha.', 422);
  if (!Number.isInteger(valor_centavos) || valor_centavos <= 0) throw new ErroNegocio('Valor inválido para a cobrança.', 422);
  if (forma === 'debito' && parcelas > 1) throw new ErroNegocio('Débito não aceita parcelamento.', 422);

  const id = Number(db.prepare(`INSERT INTO transacoes_cartao (maquininha_id, venda_id, forma, parcelas, valor_centavos, criada_em, atualizada_em)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(maquininha_id, venda_id, forma, parcelas, valor_centavos, agora(), agora()).lastInsertRowid);
  const t = transacaoDe(db, id);
  const referencia = `Venda ${venda_id ?? '-'} | ${new Date().toLocaleDateString('pt-BR')}`;
  try {
    const resultado = await DRIVERS[maq.provedor].iniciar(maq, { valor_centavos, forma, parcelas, referencia });
    return emTransacao(db, () => aplicarResultado(db, t, maq, resultado));
  } catch (err) {
    db.prepare("UPDATE transacoes_cartao SET status = 'negada', mensagem = ?, atualizada_em = ? WHERE id = ?").run(err.message.slice(0, 200), agora(), id);
    throw err;
  }
}

/** Pergunta à maquininha como ficou a cobrança pendente. */
async function consultar(db, transacao_id) {
  const t = transacaoDe(db, transacao_id);
  if (t.status !== 'pendente') return t;
  const maq = maquininhaDe(db, t.maquininha_id);
  const resultado = await DRIVERS[maq.provedor].consultar(maq, t);
  return emTransacao(db, () => aplicarResultado(db, t, maq, resultado));
}

/** Cancela a cobrança (na maquininha quando ela ainda estiver esperando o cartão). */
async function cancelar(db, transacao_id, motivo = 'Cancelada pelo caixa') {
  const t = transacaoDe(db, transacao_id);
  if (t.status === 'cancelada') return t;
  const maq = db.prepare('SELECT * FROM maquininhas WHERE id = ?').get(t.maquininha_id);
  if (t.status === 'pendente' && t.externo_id && maq) {
    try { await DRIVERS[maq.provedor].cancelar(maq, t); } catch { /* a maquininha pode já ter encerrado sozinha */ }
  }
  return emTransacao(db, () => {
    db.prepare("UPDATE transacoes_cartao SET status = 'cancelada', mensagem = ?, atualizada_em = ? WHERE id = ?").run(motivo, agora(), t.id);
    db.prepare("UPDATE lancamentos SET status = 'cancelado' WHERE transacao_id = ? AND status = 'aberto'").run(t.id);
    return transacaoDe(db, t.id);
  });
}

/** Cobranças esquecidas na maquininha viram 'expirada' (o caixa pode tentar de novo sem dúvida sobre o que foi cobrado). */
function expirarPendentes(db) {
  const corte = new Date(Date.now() - config.maquininha.expirarMin * 60_000).toISOString();
  const r = db.prepare("UPDATE transacoes_cartao SET status = 'expirada', mensagem = 'Sem resposta da maquininha', atualizada_em = ? WHERE status = 'pendente' AND criada_em < ?")
    .run(agora(), corte);
  return Number(r.changes);
}

const listar = (db, { status = null, limite = 100 } = {}) => db.prepare(`SELECT t.*, m.nome AS maquininha, m.provedor
  FROM transacoes_cartao t JOIN maquininhas m ON m.id = t.maquininha_id
  ${status ? 'WHERE t.status = ?' : ''} ORDER BY t.id DESC LIMIT ?`).all(...(status ? [status] : []), limite);

/** Testa a comunicação com a maquininha sem cobrar nada do cliente. */
async function testar(db, maquininha_id) {
  const maq = maquininhaDe(db, maquininha_id);
  if (maq.provedor === 'simulado') return { ok: true, mensagem: 'Maquininha simulada pronta (aprova todas as cobranças).' };
  if (maq.provedor === 'ponte') {
    const d = await chamar(`${maq.url}/status`, { token: maq.token });
    return { ok: true, mensagem: d.mensagem ?? `Ponte respondeu: ${d.status ?? 'ok'}.`, detalhes: d };
  }
  const d = await chamar(`https://api.mercadopago.com/point/integration-api/devices/${encodeURIComponent(maq.identificador)}`, { token: maq.token });
  return { ok: true, mensagem: `Maquininha ${d.id ?? maq.identificador} encontrada (${d.operating_mode ?? 'modo desconhecido'}).`, detalhes: d };
}

module.exports = { cobrar, consultar, cancelar, expirarPendentes, listar, testar, taxaDa, prazoDe, transacaoDe, maquininhaDe, DRIVERS };
