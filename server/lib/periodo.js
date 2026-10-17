'use strict';

const { ErroNegocio } = require('./erros');

/** Mês já fechado não aceita lançamentos, baixas nem ajustes com data nele. Reabra o mês para corrigir. */
function exigirPeriodoAberto(db, empresaId, ...datas) {
  for (const data of datas.filter(Boolean)) {
    const mes = String(data).slice(0, 7);
    if (db.prepare("SELECT 1 FROM fechamentos WHERE empresa_id = ? AND mes = ? AND etapa = 'fechado'").get(empresaId, mes)) {
      throw new ErroNegocio(`O mês ${mes.slice(5)}/${mes.slice(0, 4)} já foi fechado. Peça ao supervisor para reabrir o período.`, 409);
    }
  }
}

module.exports = { exigirPeriodoAberto };
