'use strict';

class ErroNegocio extends Error {
  constructor(mensagem, status = 400, detalhes) {
    super(mensagem);
    this.status = status;
    this.detalhes = detalhes;
  }
}

const naoEncontrado = (o = 'Registro') => new ErroNegocio(`${o} não encontrado.`, 404);

module.exports = { ErroNegocio, naoEncontrado };
