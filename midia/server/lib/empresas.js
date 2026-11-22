'use strict';

/**
 * Separação por empresa. O master enxerga todas; administrador e operador, só a empresa deles.
 * Portais (anunciante, lojista) já são presos ao próprio anunciante ou ponto e não passam por aqui.
 *
 * Toda consulta do painel que lista, abre, altera ou apaga um dado passa por um destes:
 *   - empresaDe(req): null (master, vê tudo) ou o id da empresa;
 *   - filtro(req, 'l.empresa_id'): [' AND l.empresa_id = ?', [id]] ou ['', []];
 *   - conferir(req, linha.empresa_id, 'Ponto'): 404 se o dado é de outra empresa (como se não existisse);
 *   - empresaParaGravar(db, req, pedida): a empresa do usuário, ou a escolhida pelo master.
 */
const { ErroNegocio, naoEncontrado } = require('./erros');

const empresaDe = (req) => (req.usuario?.perfil === 'master' ? null : (req.usuario?.empresa_id ?? -1));

function filtro(req, coluna) {
  const e = empresaDe(req);
  return e === null ? ['', []] : [` AND ${coluna} = ?`, [e]];
}

function conferir(req, empresaId, oQue = 'Registro') {
  const e = empresaDe(req);
  if (e !== null && Number(empresaId) !== e) throw naoEncontrado(oQue);
}

const empresaPadrao = (db) => db.prepare('SELECT id FROM empresas WHERE ativo = 1 ORDER BY id LIMIT 1').get()?.id ?? null;

function empresaParaGravar(db, req, pedida) {
  const e = empresaDe(req);
  if (e !== null) return e;
  if (pedida === undefined || pedida === null || pedida === '') return empresaPadrao(db);
  const id = Number(pedida);
  if (!db.prepare('SELECT 1 FROM empresas WHERE id = ?').get(id)) throw new ErroNegocio('Empresa não encontrada.', 422);
  return id;
}

module.exports = { empresaDe, filtro, conferir, empresaPadrao, empresaParaGravar };
