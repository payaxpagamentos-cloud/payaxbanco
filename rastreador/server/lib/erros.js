'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

class ErroNegocio extends Error {
  constructor(mensagem, status = 400, detalhes) {
    super(mensagem);
    this.status = status;
    this.detalhes = detalhes;
  }
}

const naoEncontrado = (o = 'Registro') => new ErroNegocio(`${o} não encontrado.`, 404);

module.exports = { ErroNegocio, naoEncontrado };
