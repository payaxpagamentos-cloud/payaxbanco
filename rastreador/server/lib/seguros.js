'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

// Seguros: catálogo de tipos (master), portfólio por empresa (master), permissão por usuário (admin da empresa)
// e as contratações. A emissão das apólices é feita por uma plataforma externa — ver emitirNaPlataforma().

const { agora, transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const v = require('./validacao');

const STATUS = { pendente: 'Pendente', enviada: 'Enviada à seguradora', emitida: 'Apólice emitida', recusada: 'Recusada', cancelada: 'Cancelada' };
// Ícones aceitos no catálogo (o master escolhe um); são chaves que já existem no painel.
const ICONES = ['seguro', 'manutencao', 'carteira', 'motoristas', 'veiculos', 'seguranca', 'estrela', 'cadeado', 'alvo', 'rastreadores'];

// Preço de venda = custo × (1 + margem/100). Sem custo definido, não há preço (fica "sob consulta").
const precoVenda = (custoCentavos, margemPercent) => (custoCentavos == null ? null
  : Math.round(custoCentavos * (1 + (Number(margemPercent) || 0) / 100)));
const custoDe = (x) => (x === '' || x === null || x === undefined ? null : Math.max(0, Math.round(Number(x)) || 0));
const margemDe = (x) => { const p = Number(x); return !Number.isFinite(p) || p < 0 ? 0 : Math.min(p, 1000); };

// ---------- Catálogo de tipos (master) ----------
function catalogo(db, { todos = false } = {}) {
  return db.prepare(`SELECT * FROM seguros_tipos ${todos ? '' : 'WHERE ativo = 1'} ORDER BY ordem, id`).all();
}
function tipo(db, id) {
  const t = db.prepare('SELECT * FROM seguros_tipos WHERE id = ?').get(Number(id));
  if (!t) throw naoEncontrado('Tipo de seguro');
  return t;
}
function dadosTipo(d) {
  return {
    nome: v.texto(d.nome, 'o nome do seguro', 80),
    descricao: v.opcional(d.descricao, 'a descrição', 300),
    icone: d.icone && ICONES.includes(d.icone) ? d.icone : 'seguro',
    produto_externo: v.opcional(d.produto_externo, 'o código do produto', 80),
    custo_centavos: custoDe(d.custo_centavos),
    ativo: d.ativo === undefined ? 1 : (v.booleano(d.ativo) ? 1 : 0),
  };
}
function criarTipo(db, d) {
  const x = dadosTipo(d);
  const ordem = (db.prepare('SELECT MAX(ordem) AS m FROM seguros_tipos').get().m ?? -1) + 1;
  const { lastInsertRowid } = db.prepare('INSERT INTO seguros_tipos (nome, descricao, icone, produto_externo, custo_centavos, ativo, ordem, criado_em) VALUES (?,?,?,?,?,?,?,?)')
    .run(x.nome, x.descricao, x.icone, x.produto_externo, x.custo_centavos, x.ativo, ordem, agora());
  return tipo(db, lastInsertRowid);
}
function atualizarTipo(db, id, d) {
  tipo(db, id);
  const x = dadosTipo(d);
  db.prepare('UPDATE seguros_tipos SET nome=?, descricao=?, icone=?, produto_externo=?, custo_centavos=?, ativo=? WHERE id=?')
    .run(x.nome, x.descricao, x.icone, x.produto_externo, x.custo_centavos, x.ativo, Number(id));
  return tipo(db, id);
}
function removerTipo(db, id) {
  const t = tipo(db, id);
  const usos = db.prepare('SELECT COUNT(*) AS n FROM seguros_contratacoes WHERE tipo_id = ?').get(t.id).n;
  if (usos) throw new ErroNegocio('Há contratações com esse seguro. Desative-o em vez de excluir (ele sai do portfólio, mas o histórico fica guardado).', 409);
  transacao(db, () => {
    db.prepare('DELETE FROM empresa_seguros WHERE tipo_id = ?').run(t.id);
    db.prepare('DELETE FROM usuario_seguros WHERE tipo_id = ?').run(t.id);
    db.prepare('DELETE FROM seguros_tipos WHERE id = ?').run(t.id);
  });
}

// ---------- Portfólio por empresa (master define) ----------
function portfolioEmpresa(db, empresaId, { todos = false } = {}) {
  return db.prepare(`SELECT t.*, es.margem_percent FROM empresa_seguros es JOIN seguros_tipos t ON t.id = es.tipo_id
    WHERE es.empresa_id = ? ${todos ? '' : 'AND t.ativo = 1'} ORDER BY t.ordem, t.id`).all(Number(empresaId))
    .map((t) => ({ ...t, preco_venda_centavos: precoVenda(t.custo_centavos, t.margem_percent) }));
}
/** Preços de revenda da empresa: custo (do master), margem (da empresa) e o preço de venda calculado. */
function precosEmpresa(db, empresaId) {
  return portfolioEmpresa(db, empresaId);
}
/** A empresa define o percentual de margem por seguro. margens: [{ tipo_id, margem_percent }]. */
function definirMargens(db, empresaId, margens) {
  const port = idsPortfolio(db, empresaId);
  transacao(db, () => {
    const upd = db.prepare('UPDATE empresa_seguros SET margem_percent = ? WHERE empresa_id = ? AND tipo_id = ?');
    for (const m of (Array.isArray(margens) ? margens : [])) {
      const tid = Number(m.tipo_id);
      if (port.has(tid)) upd.run(margemDe(m.margem_percent), Number(empresaId), tid);
    }
  });
  return precosEmpresa(db, empresaId);
}
function idsPortfolio(db, empresaId) {
  return new Set(db.prepare('SELECT tipo_id FROM empresa_seguros WHERE empresa_id = ?').all(Number(empresaId)).map((r) => r.tipo_id));
}
function definirPortfolio(db, empresaId, tipoIds) {
  const validos = new Set(catalogo(db, { todos: true }).map((t) => t.id));
  const alvo = [...new Set((Array.isArray(tipoIds) ? tipoIds : []).map(Number).filter((n) => validos.has(n)))];
  transacao(db, () => {
    db.prepare('DELETE FROM empresa_seguros WHERE empresa_id = ?').run(Number(empresaId));
    const ins = db.prepare('INSERT INTO empresa_seguros (empresa_id, tipo_id, habilitado_em) VALUES (?,?,?)');
    for (const id of alvo) ins.run(Number(empresaId), id, agora());
    // Permissões de usuário que saíram do portfólio deixam de valer.
    db.prepare(`DELETE FROM usuario_seguros WHERE usuario_id IN (SELECT id FROM usuarios WHERE empresa_id = ?)
      AND tipo_id NOT IN (SELECT tipo_id FROM empresa_seguros WHERE empresa_id = ?)`).run(Number(empresaId), Number(empresaId));
  });
  return portfolioEmpresa(db, empresaId, { todos: true });
}

// ---------- Permissão por usuário (admin da empresa define) ----------
function grantsUsuario(db, usuarioId) {
  return new Set(db.prepare('SELECT tipo_id FROM usuario_seguros WHERE usuario_id = ?').all(Number(usuarioId)).map((r) => r.tipo_id));
}
/**
 * Tipos que um usuário pode contratar na empresa `empresaId`: admin (cliente)/master/suporte veem todo o
 * portfólio; operador só o que o administrador liberou. A empresa vem do contexto (master/suporte não têm empresa própria).
 */
function permitidosDoUsuario(db, usuario, empresaId) {
  const port = portfolioEmpresa(db, empresaId);
  if (usuario.perfil !== 'operador') return port;
  const g = grantsUsuario(db, usuario.id);
  return port.filter((t) => g.has(t.id));
}
function definirGrantsUsuario(db, empresaId, usuarioId, tipoIds) {
  const alvoUsuario = db.prepare('SELECT * FROM usuarios WHERE id = ? AND empresa_id = ?').get(Number(usuarioId), Number(empresaId));
  if (!alvoUsuario) throw naoEncontrado('Usuário');
  const port = idsPortfolio(db, empresaId);
  const alvo = [...new Set((Array.isArray(tipoIds) ? tipoIds : []).map(Number).filter((n) => port.has(n)))];
  transacao(db, () => {
    db.prepare('DELETE FROM usuario_seguros WHERE usuario_id = ?').run(Number(usuarioId));
    const ins = db.prepare('INSERT INTO usuario_seguros (usuario_id, tipo_id, liberado_em) VALUES (?,?,?)');
    for (const id of alvo) ins.run(Number(usuarioId), id, agora());
  });
  return [...grantsUsuario(db, usuarioId)];
}

// ---------- Contratação ----------
async function contratar(db, { empresa, usuario, tipoId, veiculoId, motoristaId, observacao, dados }) {
  const t = tipo(db, tipoId);
  v.exigir(t.ativo, 'Esse seguro não está disponível.');
  v.exigir(idsPortfolio(db, empresa.id).has(t.id), 'Esse seguro não está no portfólio da sua empresa.');
  v.exigir(permitidosDoUsuario(db, usuario, empresa.id).some((x) => x.id === t.id),
    'Você não tem permissão para contratar esse seguro. Fale com o administrador da empresa.');

  let vid = null; let mid = null;
  if (veiculoId) {
    const x = db.prepare('SELECT id FROM veiculos WHERE id = ? AND empresa_id = ?').get(Number(veiculoId), empresa.id);
    v.exigir(x, 'Veículo não encontrado.'); vid = x.id;
  }
  if (motoristaId) {
    const x = db.prepare('SELECT id FROM motoristas WHERE id = ? AND empresa_id = ?').get(Number(motoristaId), empresa.id);
    v.exigir(x, 'Motorista não encontrado.'); mid = x.id;
  }
  const obs = v.opcional(observacao, 'a observação', 500);
  const payload = dados && typeof dados === 'object' && !Array.isArray(dados) ? JSON.stringify(dados) : null;

  // Congela o preço no momento da contratação: custo (master), margem da empresa e o preço de venda cobrado do cliente.
  const margem = db.prepare('SELECT margem_percent FROM empresa_seguros WHERE empresa_id = ? AND tipo_id = ?').get(empresa.id, t.id)?.margem_percent ?? 0;
  const venda = precoVenda(t.custo_centavos, margem);

  const { lastInsertRowid } = db.prepare(`INSERT INTO seguros_contratacoes
    (empresa_id, tipo_id, usuario_id, veiculo_id, motorista_id, status, custo_centavos, margem_percent, valor_centavos, dados, observacao, criada_em)
    VALUES (?,?,?,?,?,'pendente',?,?,?,?,?,?)`).run(empresa.id, t.id, usuario.id, vid, mid, t.custo_centavos, margem, venda, payload, obs, agora());

  let contr = db.prepare('SELECT * FROM seguros_contratacoes WHERE id = ?').get(lastInsertRowid);
  // Tenta emitir na plataforma externa. Enquanto a integração não estiver ligada, fica 'pendente'.
  try {
    const emissao = await emitirNaPlataforma(db, contr, t);
    if (emissao) {
      db.prepare('UPDATE seguros_contratacoes SET status=?, referencia_externa=?, apolice_numero=?, valor_centavos=?, atualizada_em=? WHERE id=?')
        .run(emissao.status ?? 'enviada', emissao.referencia_externa ?? null, emissao.apolice_numero ?? null,
          Number.isFinite(emissao.valor_centavos) ? emissao.valor_centavos : null, agora(), contr.id);
      contr = db.prepare('SELECT * FROM seguros_contratacoes WHERE id = ?').get(contr.id);
    }
  } catch { /* plataforma indisponível: segue 'pendente' para reenvio depois */ }
  return contr;
}

/**
 * PONTO DE INTEGRAÇÃO com a plataforma externa de seguros (emissão das apólices).
 *
 * Hoje devolve null — a contratação nasce e permanece 'pendente', tratada pelo master.
 * Quando a plataforma for conectada, troque o corpo por uma chamada à API da seguradora
 * (use o `produto_externo` do tipo e os dados da contratação) e devolva:
 *   { status: 'enviada' | 'emitida', referencia_externa, apolice_numero, valor_centavos }
 * O segredo/chave da plataforma deve vir de variável de ambiente (nunca no código).
 */
async function emitirNaPlataforma(/* db, contratacao, tipoSeguro */) {
  return null;
}

// ---------- Leitura das contratações ----------
function contratacoes(db, { empresaId = null, status = null, limite = 300 } = {}) {
  const cond = []; const args = [];
  if (empresaId) { cond.push('c.empresa_id = ?'); args.push(Number(empresaId)); }
  if (status) { cond.push('c.status = ?'); args.push(status); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  return db.prepare(`SELECT c.id, c.empresa_id, c.tipo_id, c.status, c.referencia_externa, c.apolice_numero,
      c.custo_centavos, c.margem_percent, c.valor_centavos, c.observacao, c.criada_em, c.atualizada_em,
      t.nome AS tipo_nome, t.icone AS tipo_icone, e.nome AS empresa_nome,
      ve.placa AS veiculo_placa, m.nome AS motorista_nome, u.nome AS usuario_nome
    FROM seguros_contratacoes c
    JOIN seguros_tipos t ON t.id = c.tipo_id
    JOIN empresas e ON e.id = c.empresa_id
    LEFT JOIN veiculos ve ON ve.id = c.veiculo_id
    LEFT JOIN motoristas m ON m.id = c.motorista_id
    LEFT JOIN usuarios u ON u.id = c.usuario_id
    ${where} ORDER BY c.criada_em DESC LIMIT ?`).all(...args, Number(limite));
}

/** O master atualiza status, nº da apólice e referência (usado ao integrar ou ao tratar manualmente). */
function atualizarContratacao(db, id, d) {
  const c = db.prepare('SELECT * FROM seguros_contratacoes WHERE id = ?').get(Number(id));
  if (!c) throw naoEncontrado('Contratação');
  // Campo que não veio na requisição mantém o valor atual (só apaga quando enviado vazio).
  const status = d.status ? v.opcao(d.status, 'o status', Object.keys(STATUS)) : c.status;
  const apolice = d.apolice_numero === undefined ? c.apolice_numero : v.opcional(d.apolice_numero, 'o número da apólice', 80);
  const ref = d.referencia_externa === undefined ? c.referencia_externa : v.opcional(d.referencia_externa, 'a referência', 120);
  const obs = d.observacao === undefined ? c.observacao : v.opcional(d.observacao, 'a observação', 500);
  db.prepare('UPDATE seguros_contratacoes SET status=?, apolice_numero=?, referencia_externa=?, observacao=?, atualizada_em=? WHERE id=?')
    .run(status, apolice, ref, obs, agora(), c.id);
  return db.prepare('SELECT * FROM seguros_contratacoes WHERE id = ?').get(c.id);
}

module.exports = {
  STATUS, ICONES, precoVenda, catalogo, tipo, criarTipo, atualizarTipo, removerTipo,
  portfolioEmpresa, idsPortfolio, definirPortfolio, precosEmpresa, definirMargens,
  grantsUsuario, permitidosDoUsuario, definirGrantsUsuario,
  contratar, contratacoes, atualizarContratacao, emitirNaPlataforma,
};
