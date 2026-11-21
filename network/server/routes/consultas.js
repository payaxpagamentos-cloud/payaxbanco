'use strict';

const { Router } = require('express');
const { exigir } = require('../auth');
const { registrar } = require('../lib/auditoria');
const consultas = require('../lib/consultas');

/*
 * Consulta pública de CNPJ e CEP para preencher o cadastro.
 *
 * Quem pode cadastrar pode consultar. A resposta nunca é gravada em lugar nenhum do cadastro por conta própria:
 * ela volta para a tela, a equipe confere e salva. A consulta fica na auditoria para o histórico explicar de onde
 * veio o endereço de um assinante.
 */
module.exports = (db) => {
  const r = Router();

  const responder = (tipo) => async (req, res, next) => {
    try {
      const resultado = await consultas.consultar(db, tipo, req.params.valor, { forcar: req.query.forcar === '1', org: req.org });
      if (resultado.encontrado && !resultado.do_cache) {
        registrar(db, req, `consulta_${tipo}`, { recurso: tipo, depois: { chave: resultado.chave, fonte: resultado.fonte } });
      }
      res.json(resultado);
    } catch (err) {
      next(err);
    }
  };

  r.get('/cnpj/:valor', exigir('assinantes.editar'), responder('cnpj'));
  r.get('/cep/:valor', exigir('assinantes.editar', 'contratos.editar', 'rede.editar'), responder('cep'));

  return r;
};
