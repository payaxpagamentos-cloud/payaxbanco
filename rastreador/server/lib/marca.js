'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

const { lerConfig } = require('../db');

/**
 * Nome com que o sistema se apresenta. O sistema completo é "Gestão de Frota"; "Rastreador" é o nome do produto quando a
 * empresa usa só o rastreamento (sem o módulo Gestão de Frota). Um nome próprio definido pelo master vale para todos.
 */
const NOME_COMPLETO = 'Gestão de Frota';
const NOME_SO_RASTREAMENTO = 'Rastreador';

function nomeSistema(db, empresa = null) {
  const base = lerConfig(db).nome_plataforma || NOME_COMPLETO;
  if (base !== NOME_COMPLETO || !empresa) return base;
  const e = typeof empresa === 'object' ? empresa : db.prepare('SELECT gestao_frota FROM empresas WHERE id = ?').get(Number(empresa));
  return e && !e.gestao_frota ? NOME_SO_RASTREAMENTO : NOME_COMPLETO;
}

module.exports = { nomeSistema, NOME_COMPLETO, NOME_SO_RASTREAMENTO };
