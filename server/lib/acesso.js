'use strict';

const { ErroNegocio, naoEncontrado } = require('./erros');

/** O analista só enxerga as empresas da própria carteira; supervisor e administrador veem todas. */
const veTodas = (usuario) => usuario.perfil !== 'analista';

/** Cláusula SQL (com parâmetros) que limita a consulta às empresas visíveis ao usuário. */
function filtroCarteira(usuario, coluna = 'e.analista_id') {
  return veTodas(usuario) ? { sql: '1 = 1', params: [] } : { sql: `${coluna} = ?`, params: [usuario.id] };
}

/** Carrega a empresa e confere se o usuário pode trabalhar nela. */
function empresaPermitida(db, usuario, empresaId) {
  const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(Number(empresaId));
  if (!empresa) throw naoEncontrado('Empresa');
  if (!veTodas(usuario) && empresa.analista_id !== usuario.id) {
    throw new ErroNegocio('Esta empresa não está na sua carteira.', 403);
  }
  return empresa;
}

/** Middleware para rotas /empresas/:empresaId/...: carrega req.empresa. */
const carregarEmpresa = (db) => (req, _res, next) => {
  try {
    req.empresa = empresaPermitida(db, req.usuario, req.params.empresaId);
    next();
  } catch (err) {
    next(err);
  }
};

/** Garante que um registro (categoria, contato, conta…) pertence à empresa. */
function daEmpresa(db, tabela, id, empresaId, nome) {
  if (id === null || id === undefined) return null;
  const r = db.prepare(`SELECT * FROM ${tabela} WHERE id = ? AND empresa_id = ?`).get(Number(id), empresaId);
  if (!r) throw new ErroNegocio(`${nome} não encontrado(a) nesta empresa.`, 422);
  return r;
}

module.exports = { veTodas, filtroCarteira, empresaPermitida, carregarEmpresa, daEmpresa };
