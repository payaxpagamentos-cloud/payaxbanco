'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./helpers');
const conhecimento = require('../server/ia/conhecimento');
const prompt = require('../server/ia/prompt');
const conversas = require('../server/lib/conversas');
const { abrir, agora } = require('../server/db');

/**
 * Tudo centralizado na base de conhecimento: "Regra" (o que a ZOE pode e não pode) vale em toda
 * conversa, sem depender de busca; "Informação" é o que ela consulta quando o assunto aparece.
 */
test('regra entra no prompt de toda conversa; informação fica na busca', () => {
  const { db, empresa } = h.criarAmbiente();
  conhecimento.salvar(db, empresa.id, { titulo: 'Visita técnica', resposta: 'Nunca prometa prazo de visita técnica.', tipo: 'regra' });
  conhecimento.salvar(db, empresa.id, { titulo: 'Planos de internet', resposta: 'Temos 300, 600 e 1000 Mega.', perguntas: 'quais planos', tipo: 'informacao' });
  const cfg = conversas.cfgIa(db, empresa.id);
  const texto = prompt.montar(db, { empresa, cfg, contato: null });
  assert.match(texto, /## Regras desta empresa[\s\S]*Nunca prometa prazo de visita técnica\./);
  const indice = (texto.split('## O que existe na base de conhecimento')[1] ?? '').split('\n## ')[0];
  assert.match(indice, /Planos de internet/);
  assert.doesNotMatch(indice, /Visita técnica/, 'a regra não aparece como artigo para buscar');
  assert.equal(conhecimento.buscar(db, empresa.id, 'visita técnica prazo').some((a) => a.titulo === 'Visita técnica'), false);
  assert.ok(conhecimento.buscar(db, empresa.id, 'quais planos vocês têm').some((a) => a.titulo === 'Planos de internet'));
});

test('o campo antigo "Regras desta empresa" vira artigo do tipo regra na atualização', () => {
  const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zoe-')), 'b.db');
  const a = abrir(arq);
  a.prepare("INSERT INTO empresas (nome, status, criada_em) VALUES ('Conn', 'ativa', ?)").run(agora());
  a.prepare("INSERT INTO ia_config (empresa_id, regras) VALUES (1, 'Nunca prometa desconto.')").run();
  a.close();
  const b = abrir(arq);
  const art = b.prepare("SELECT * FROM conhecimento WHERE empresa_id = 1 AND tipo = 'regra'").get();
  assert.equal(art.resposta, 'Nunca prometa desconto.');
  assert.equal(b.prepare('SELECT regras FROM ia_config WHERE empresa_id = 1').get().regras, null, 'não fica duplicado');
  b.close();
  assert.equal(abrir(arq).prepare("SELECT COUNT(*) AS n FROM conhecimento WHERE tipo = 'regra'").get().n, 1, 'roda uma vez só');
});
