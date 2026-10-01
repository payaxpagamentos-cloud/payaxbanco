'use strict';

function paginacao(query) {
  const limite = Math.min(Math.max(parseInt(query.limite, 10) || 20, 1), 200);
  const pagina = Math.max(parseInt(query.pagina, 10) || 1, 1);
  return { limite, pagina, offset: (pagina - 1) * limite };
}

module.exports = { paginacao };
