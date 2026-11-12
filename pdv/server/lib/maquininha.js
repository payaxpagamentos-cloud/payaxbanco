'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const { agora, transacao } = require('../db');
const { decifrar } = require('./cripto');
const { ErroNegocio, naoEncontrado } = require('./erros');
const v = require('./validacao');

const FORMAS_CARTAO = ['debito', 'credito', 'pix'];

/** Formas que este aparelho aceita (o cadastro manda; na dúvida, as três). */
function formasDoTerminal(terminal) {
  try {
    const lista = JSON.parse(terminal.formas || '[]').filter((f) => FORMAS_CARTAO.includes(f));
    return lista.length ? lista : FORMAS_CARTAO;
  } catch {
    return FORMAS_CARTAO;
  }
}
const ABERTAS = ['pendente', 'enviada'];

const publico = (t) => (t ? {
  id: t.id,
  referencia: t.referencia,
  terminal_id: t.terminal_id,
  forma: t.forma,
  valor_centavos: t.valor_centavos,
  parcelas: t.parcelas,
  status: t.status,
  bandeira: t.bandeira,
  nsu: t.nsu,
  autorizacao: t.autorizacao,
  cartao_final: t.cartao_final,
  cv: t.cv,
  mensagem: t.mensagem,
  recebimento_id: t.recebimento_id,
  criado_em: t.criado_em,
  atualizado_em: t.atualizado_em,
  expira_em: t.expira_em,
} : null);

function lerTerminal(db, empresaId, id) {
  const t = db.prepare('SELECT * FROM terminais WHERE id = ? AND empresa_id = ?').get(Number(id), empresaId);
  if (!t) throw naoEncontrado('Maquininha');
  if (!t.ativo) throw new ErroNegocio('Esta maquininha está desativada.', 409);
  return t;
}

/**
 * Envia a cobrança para a maquininha.
 * - modo `agente`: a cobrança fica pendente até o aplicativo da maquininha buscá-la (ele devolve o resultado depois).
 * - modo `webhook`: o PDV chama o endereço do adquirente/intermediador agora; o resultado chega pelo retorno.
 * - modo `manual`: não há envio — use `registrarManual` com o NSU lido no comprovante da maquininha.
 */
async function cobrar(db, { empresa, terminalId, forma, valorCentavos, parcelas = 1, operadorId = null, caixaId = null }) {
  const terminal = lerTerminal(db, empresa.id, terminalId);
  v.opcao(forma, 'a forma de pagamento', FORMAS_CARTAO);
  if (!formasDoTerminal(terminal).includes(forma)) {
    throw new ErroNegocio(`A maquininha "${terminal.nome}" não aceita ${forma === 'pix' ? 'PIX' : forma}.`, 409);
  }
  const valor = v.centavos(valorCentavos, 'o valor');
  const p = forma === 'credito' ? v.inteiro(parcelas, 'o número de parcelas', { min: 1, max: 24 }) : 1;
  if (terminal.modo === 'manual') throw new ErroNegocio('Esta maquininha é de digitação manual: informe o NSU e a autorização do comprovante.', 409);

  const referencia = `PDV-${empresa.id}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`.toUpperCase();
  const criado = agora();
  const expira = new Date(Date.now() + config.cartaoExpiraMin * 60_000).toISOString();
  const r = db.prepare(`INSERT INTO transacoes_cartao (empresa_id, terminal_id, operador_id, caixa_id, referencia, forma, valor_centavos, parcelas, status, criado_em, atualizado_em, expira_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?, ?, ?)`)
    .run(empresa.id, terminal.id, operadorId, caixaId, referencia, forma, valor, p, criado, criado, expira);
  const id = Number(r.lastInsertRowid);

  if (terminal.modo === 'webhook') {
    try {
      await enviarAoAdquirente(terminal, { referencia, forma, valor_centavos: valor, parcelas: p });
      db.prepare("UPDATE transacoes_cartao SET status = 'enviada', atualizado_em = ? WHERE id = ? AND status = 'pendente'").run(agora(), id);
    } catch (err) {
      db.prepare("UPDATE transacoes_cartao SET status = 'negada', mensagem = ?, atualizado_em = ? WHERE id = ?").run(String(err.message).slice(0, 300), agora(), id);
      throw new ErroNegocio(`A maquininha não aceitou a cobrança: ${err.message}`, 502);
    }
  }
  return publico(db.prepare('SELECT * FROM transacoes_cartao WHERE id = ?').get(id));
}

/** Chamada ao adquirente/intermediador configurado na maquininha (modo webhook). */
async function enviarAoAdquirente(terminal, corpo) {
  if (!terminal.endereco) throw new Error('a maquininha não tem endereço configurado');
  let token = null;
  if (terminal.token_cifrado) {
    try { token = decifrar(terminal.token_cifrado); } catch { throw new Error('não foi possível ler o token da maquininha'); }
  }
  let resp;
  try {
    resp = await fetch(terminal.endereco, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ ...corpo, serial: terminal.serial ?? null, adquirente: terminal.adquirente }),
      signal: AbortSignal.timeout(config.ixcTimeoutMs),
    });
  } catch (err) {
    throw new Error(err.name === 'TimeoutError' ? 'não respondeu a tempo' : 'sem conexão');
  }
  if (!resp.ok) throw new Error(`respondeu com erro ${resp.status}`);
  return resp.json().catch(() => ({}));
}

/** Próxima cobrança esperando esta maquininha (modo agente): entrega uma por vez e marca como enviada. */
function proximaPendente(db, terminal) {
  return transacao(db, () => {
    const t = db.prepare("SELECT * FROM transacoes_cartao WHERE terminal_id = ? AND status = 'pendente' ORDER BY id LIMIT 1").get(terminal.id);
    if (!t) return null;
    db.prepare("UPDATE transacoes_cartao SET status = 'enviada', atualizado_em = ? WHERE id = ?").run(agora(), t.id);
    return publico(db.prepare('SELECT * FROM transacoes_cartao WHERE id = ?').get(t.id));
  });
}

const STATUS_RESULTADO = { aprovada: 'aprovada', negada: 'negada', cancelada: 'cancelada' };

/** Resultado informado pela maquininha (aplicativo da maquininha ou retorno do adquirente). */
function resultado(db, terminal, d) {
  const referencia = v.texto(d.referencia, 'a referência da cobrança', 60);
  const t = db.prepare('SELECT * FROM transacoes_cartao WHERE referencia = ? AND terminal_id = ?').get(referencia, terminal.id);
  if (!t) throw naoEncontrado('Cobrança');
  const status = STATUS_RESULTADO[String(d.status ?? '').toLowerCase()];
  if (!status) throw new ErroNegocio('Situação inválida (use aprovada, negada ou cancelada).', 422);
  if (!ABERTAS.includes(t.status)) {
    // Repetição do mesmo resultado: devolve o que já está gravado, sem erro (a maquininha pode reenviar).
    if (t.status === status) return publico(t);
    throw new ErroNegocio(`Esta cobrança já foi encerrada como ${t.status}.`, 409);
  }
  db.prepare(`UPDATE transacoes_cartao SET status = ?, bandeira = ?, nsu = ?, autorizacao = ?, cartao_final = ?, cv = ?, mensagem = ?, comprovante = ?, atualizado_em = ?
    WHERE id = ?`).run(
    status,
    v.opcional(d.bandeira, 'a bandeira', 30),
    v.opcional(d.nsu, 'o NSU', 30),
    v.opcional(d.autorizacao, 'a autorização', 30),
    v.opcional(String(d.cartao_final ?? '').replace(/\D/g, '').slice(-4), 'os últimos dígitos do cartão', 4),
    v.opcional(d.cv, 'o CV da transação', 30),
    v.opcional(d.mensagem, 'a mensagem', 300),
    v.opcional(d.comprovante, 'o comprovante', 4000),
    agora(), t.id,
  );
  return publico(db.prepare('SELECT * FROM transacoes_cartao WHERE id = ?').get(t.id));
}

/** Cobrança no cartão digitada pelo operador (maquininha sem integração). */
function registrarManual(db, { empresa, terminalId, forma, valorCentavos, parcelas = 1, operadorId = null, caixaId = null, nsu, autorizacao, bandeira, cartaoFinal }) {
  const terminal = lerTerminal(db, empresa.id, terminalId);
  v.opcao(forma, 'a forma de pagamento', FORMAS_CARTAO);
  const valor = v.centavos(valorCentavos, 'o valor');
  const p = forma === 'credito' ? v.inteiro(parcelas, 'o número de parcelas', { min: 1, max: 24 }) : 1;
  const momento = agora();
  const referencia = `MAN-${empresa.id}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`.toUpperCase();
  const r = db.prepare(`INSERT INTO transacoes_cartao (empresa_id, terminal_id, operador_id, caixa_id, referencia, forma, valor_centavos, parcelas, status, bandeira, nsu, autorizacao, cartao_final, mensagem, criado_em, atualizado_em, expira_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'aprovada', ?, ?, ?, ?, 'Informada pelo operador', ?, ?, ?)`)
    .run(empresa.id, terminal.id, operadorId, caixaId, referencia, forma, valor, p,
      v.opcional(bandeira, 'a bandeira', 30), v.texto(nsu, 'o NSU', 30), v.opcional(autorizacao, 'a autorização', 30),
      v.opcional(String(cartaoFinal ?? '').replace(/\D/g, '').slice(-4), 'os últimos dígitos do cartão', 4), momento, momento, momento);
  return publico(db.prepare('SELECT * FROM transacoes_cartao WHERE id = ?').get(Number(r.lastInsertRowid)));
}

/** Cancela no PDV uma cobrança que ainda não foi concluída (a maquininha deve ser cancelada no aparelho). */
function cancelar(db, empresaId, id) {
  const t = db.prepare('SELECT * FROM transacoes_cartao WHERE id = ? AND empresa_id = ?').get(Number(id), empresaId);
  if (!t) throw naoEncontrado('Cobrança');
  if (t.recebimento_id) throw new ErroNegocio('Esta cobrança já faz parte de um recebimento. Cancele o recebimento.', 409);
  if (!ABERTAS.includes(t.status) && t.status !== 'aprovada') return publico(t);
  const novo = t.status === 'aprovada' ? 'estornada' : 'cancelada';
  db.prepare('UPDATE transacoes_cartao SET status = ?, atualizado_em = ? WHERE id = ?').run(novo, agora(), t.id);
  return publico(db.prepare('SELECT * FROM transacoes_cartao WHERE id = ?').get(t.id));
}

function buscar(db, empresaId, id) {
  const t = db.prepare('SELECT * FROM transacoes_cartao WHERE id = ? AND empresa_id = ?').get(Number(id), empresaId);
  if (!t) throw naoEncontrado('Cobrança');
  return publico(t);
}

/** Cobranças sem resposta além do prazo viram "expirada" (roda de tempos em tempos). */
function expirarVencidas(db) {
  const r = db.prepare(`UPDATE transacoes_cartao SET status = 'expirada', mensagem = COALESCE(mensagem, 'A maquininha não respondeu no prazo.'), atualizado_em = ?
    WHERE status IN ('pendente','enviada') AND expira_em < ?`).run(agora(), agora());
  return r.changes;
}

module.exports = { FORMAS_CARTAO, formasDoTerminal, cobrar, proximaPendente, resultado, registrarManual, cancelar, buscar, expirarVencidas, publico, lerTerminal };
