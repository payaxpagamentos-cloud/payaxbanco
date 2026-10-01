'use strict';

/*
 * Relacionamento: cada conta tem um gerente; o cliente conversa com ele pelo Internet Banking e o gerente
 * responde no Banqueiro. Uma conversa é o par (cliente, gerente). Conversa sem gerente (gerente_id nulo) é
 * atendida pelo administrador como "Atendimento PAY AX".
 */

const { ErroNegocio, naoEncontrado } = require('./erros');
const v = require('./validacao');

const MAX_TEXTO = 2000;

/** Gerente válido para assumir contas: usuário ativo com perfil gerente ou administrador. */
function validarGerente(db, id) {
  if (id === null || id === undefined || id === '') return null;
  const g = db.prepare("SELECT id, nome FROM usuarios WHERE id = ? AND ativo = 1 AND perfil IN ('gerente', 'admin')").get(id);
  if (!g) throw new ErroNegocio('Escolha um gerente ativo.', 422);
  return g.id;
}

const listarGerentes = (db) => db.prepare("SELECT id, nome, perfil FROM usuarios WHERE ativo = 1 AND perfil IN ('gerente', 'admin') ORDER BY perfil = 'admin', nome").all();

/** Gerentes das contas ativas do cliente (normalmente um só). */
const gerentesDoCliente = (db, clienteId) => db.prepare(`SELECT DISTINCT g.id, g.nome FROM contas c JOIN usuarios g ON g.id = c.gerente_id
  WHERE c.cliente_id = ? AND c.status <> 'encerrada' AND g.ativo = 1 ORDER BY g.nome`).all(clienteId);

const naCarteira = (db, clienteId, gerenteId) => Boolean(db.prepare("SELECT 1 FROM contas WHERE cliente_id = ? AND gerente_id = ? AND status <> 'encerrada'").get(clienteId, gerenteId))
  || Boolean(db.prepare('SELECT 1 FROM mensagens WHERE cliente_id = ? AND gerente_id = ?').get(clienteId, gerenteId));

const filtroGerente = (gerenteId) => (gerenteId === null ? 'gerente_id IS NULL' : 'gerente_id = ?');
const argsGerente = (gerenteId) => (gerenteId === null ? [] : [gerenteId]);

function mensagens(db, clienteId, gerenteId) {
  return db.prepare(`SELECT m.id, m.autor, m.texto, m.criado_em, m.lida_em, u.nome AS usuario_nome FROM mensagens m
    LEFT JOIN usuarios u ON u.id = m.usuario_id WHERE m.cliente_id = ? AND m.${filtroGerente(gerenteId)} ORDER BY m.id`)
    .all(clienteId, ...argsGerente(gerenteId));
}

/** Marca como lidas as mensagens do outro lado da conversa. */
function marcarLidas(db, clienteId, gerenteId, leitor) {
  const autor = leitor === 'cliente' ? 'gerente' : 'cliente';
  db.prepare(`UPDATE mensagens SET lida_em = datetime('now') WHERE cliente_id = ? AND ${filtroGerente(gerenteId)} AND autor = ? AND lida_em IS NULL`)
    .run(clienteId, ...argsGerente(gerenteId), autor);
}

function enviar(db, { clienteId, gerenteId, autor, usuarioId = null, texto }) {
  const t = String(texto ?? '').trim();
  v.exigir(t.length > 0, 'Escreva a mensagem.');
  v.exigir(t.length <= MAX_TEXTO, `A mensagem pode ter até ${MAX_TEXTO} caracteres.`);
  const r = db.prepare('INSERT INTO mensagens (cliente_id, gerente_id, autor, usuario_id, texto) VALUES (?, ?, ?, ?, ?)')
    .run(clienteId, gerenteId, autor, usuarioId, t);
  return db.prepare('SELECT id, autor, texto, criado_em, lida_em FROM mensagens WHERE id = ?').get(r.lastInsertRowid);
}

/** Conversas do gerente (ou de todos, para o administrador), com a última mensagem e o que aguarda resposta. */
function conversas(db, gerenteId) {
  const where = gerenteId === undefined ? '' : `WHERE m.${filtroGerente(gerenteId)}`;
  return db.prepare(`
    WITH ult AS (SELECT cliente_id, gerente_id, MAX(id) AS id FROM mensagens m ${where} GROUP BY cliente_id, gerente_id)
    SELECT u.cliente_id, u.gerente_id, cl.nome AS cliente_nome, cl.documento AS cliente_documento, g.nome AS gerente_nome,
      m.texto AS ultima_texto, m.autor AS ultima_autor, m.criado_em AS ultima_em,
      (SELECT COUNT(*) FROM mensagens x WHERE x.cliente_id = u.cliente_id AND IFNULL(x.gerente_id, 0) = IFNULL(u.gerente_id, 0)
        AND x.autor = 'cliente' AND x.lida_em IS NULL) AS nao_lidas
    FROM ult u JOIN mensagens m ON m.id = u.id JOIN clientes cl ON cl.id = u.cliente_id LEFT JOIN usuarios g ON g.id = u.gerente_id
    ORDER BY (m.autor = 'cliente') DESC, m.id DESC`).all(...(gerenteId === undefined || gerenteId === null ? [] : [gerenteId]));
}

/** Tempo até a primeira resposta do gerente a cada mensagem do cliente sem resposta anterior (em minutos). */
function temposResposta(lista) {
  const porConversa = new Map();
  for (const m of lista) {
    const k = `${m.cliente_id}:${m.gerente_id ?? 0}`;
    if (!porConversa.has(k)) porConversa.set(k, []);
    porConversa.get(k).push(m);
  }
  const tempos = [];
  for (const msgs of porConversa.values()) {
    let aguardandoDesde = null;
    for (const m of msgs) {
      if (m.autor === 'cliente' && aguardandoDesde === null) aguardandoDesde = m.criado_em;
      if (m.autor === 'gerente' && aguardandoDesde !== null) {
        tempos.push((Date.parse(`${m.criado_em.replace(' ', 'T')}Z`) - Date.parse(`${aguardandoDesde.replace(' ', 'T')}Z`)) / 60000);
        aguardandoDesde = null;
      }
    }
  }
  return tempos;
}

const media = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/** Indicadores do painel de relacionamento. `gerenteId` undefined = todos os gerentes. */
function painel(db, gerenteId, dias) {
  const periodo = Math.min(Math.max(Number(dias) || 30, 1), 365);
  const desde = `-${periodo} days`;
  const fg = gerenteId === undefined ? '1 = 1' : 'gerente_id = ?';
  const ag = gerenteId === undefined ? [] : [gerenteId];
  const msgs = db.prepare(`SELECT cliente_id, gerente_id, autor, criado_em FROM mensagens WHERE ${fg} AND criado_em >= datetime('now', ?) ORDER BY id`).all(...ag, desde);
  const carteira = db.prepare(`SELECT COUNT(DISTINCT cliente_id) AS clientes, COUNT(*) AS contas FROM contas WHERE status <> 'encerrada' AND ${gerenteId === undefined ? 'gerente_id IS NOT NULL' : 'gerente_id = ?'}`).get(...ag);
  const distintos = (autor) => new Set(msgs.filter((m) => m.autor === autor).map((m) => m.cliente_id)).size;
  const conv = conversas(db, gerenteId);

  // Série diária de mensagens recebidas e enviadas no período.
  const serie = [];
  const hoje = new Date();
  for (let i = periodo - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate() - i)).toISOString().slice(0, 10);
    serie.push({ dia: d, recebidas: 0, enviadas: 0 });
  }
  const idx = new Map(serie.map((s, i) => [s.dia, i]));
  for (const m of msgs) {
    const i = idx.get(m.criado_em.slice(0, 10));
    if (i !== undefined) serie[i][m.autor === 'cliente' ? 'recebidas' : 'enviadas'] += 1;
  }

  // Quem entrou em contato no período.
  const contatos = db.prepare(`SELECT m.cliente_id, cl.nome AS cliente_nome, g.nome AS gerente_nome, m.gerente_id,
      SUM(m.autor = 'cliente') AS recebidas, SUM(m.autor = 'gerente') AS enviadas, MAX(m.criado_em) AS ultima_em,
      (SELECT x.autor FROM mensagens x WHERE x.cliente_id = m.cliente_id AND IFNULL(x.gerente_id, 0) = IFNULL(m.gerente_id, 0)
        AND x.criado_em >= datetime('now', ?) ORDER BY x.id LIMIT 1) AS iniciado_por
    FROM mensagens m JOIN clientes cl ON cl.id = m.cliente_id LEFT JOIN usuarios g ON g.id = m.gerente_id
    WHERE ${gerenteId === undefined ? '1 = 1' : 'm.gerente_id = ?'} AND m.criado_em >= datetime('now', ?) GROUP BY m.cliente_id, m.gerente_id ORDER BY ultima_em DESC`).all(desde, ...ag, desde)
    .map((c) => ({ ...c,
      aguardando: conv.some((x) => x.cliente_id === c.cliente_id && x.gerente_id === c.gerente_id && x.ultima_autor === 'cliente') }));

  const resultado = {
    dias: periodo,
    carteira_clientes: carteira.clientes,
    carteira_contas: carteira.contas,
    clientes_contato: distintos('cliente'),
    clientes_contatados: distintos('gerente'),
    recebidas: msgs.filter((m) => m.autor === 'cliente').length,
    enviadas: msgs.filter((m) => m.autor === 'gerente').length,
    aguardando: conv.filter((c) => c.ultima_autor === 'cliente').length,
    tempo_medio_resposta_min: media(temposResposta(msgs)),
    serie,
    contatos,
  };

  if (gerenteId === undefined) {
    resultado.por_gerente = listarGerentes(db).filter((g) => g.perfil === 'gerente').map((g) => {
      const p = painel(db, g.id, periodo);
      return { id: g.id, nome: g.nome, carteira_clientes: p.carteira_clientes, clientes_contato: p.clientes_contato,
        clientes_contatados: p.clientes_contatados, recebidas: p.recebidas, enviadas: p.enviadas, aguardando: p.aguardando,
        tempo_medio_resposta_min: p.tempo_medio_resposta_min };
    });
  }
  return resultado;
}

/** Clientes da carteira do gerente (para iniciar uma conversa). */
const carteira = (db, gerenteId) => db.prepare(`SELECT DISTINCT cl.id, cl.nome, cl.documento FROM contas c JOIN clientes cl ON cl.id = c.cliente_id
  WHERE c.status <> 'encerrada' AND ${gerenteId === undefined ? 'c.gerente_id IS NOT NULL' : 'c.gerente_id = ?'} ORDER BY cl.nome`)
  .all(...(gerenteId === undefined ? [] : [gerenteId]));

function cliente(db, id) {
  const c = db.prepare('SELECT id, nome, documento, email, telefone FROM clientes WHERE id = ?').get(id);
  if (!c) throw naoEncontrado('Cliente');
  return c;
}

module.exports = {
  validarGerente, listarGerentes, gerentesDoCliente, naCarteira, mensagens, marcarLidas, enviar, conversas, painel, carteira, cliente,
};
