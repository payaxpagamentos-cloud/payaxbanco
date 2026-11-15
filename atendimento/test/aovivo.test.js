'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { criarApp } = require('../server/app');
const empresasLib = require('../server/lib/empresas');
const conversas = require('../server/lib/conversas');
const { aoVivo, META_ESPERA_S } = require('../server/lib/aovivo');
const { agora } = require('../server/db');

/** Conversa na fila há `minutos`, para a TV mostrar a espera. */
function naFila(db, empresa, filaId, telefone, nome, minutos, prioridade = 'normal') {
  const numero = db.prepare('SELECT * FROM numeros WHERE empresa_id = ?').get(empresa.id);
  const contato = conversas.garantirContato(db, empresa.id, telefone, nome);
  const c = conversas.abrir(db, { empresa, numero, contato });
  db.prepare("UPDATE conversas SET estado = 'aguardando', fila_id = ?, transferida_em = ?, prioridade = ?, atendente_id = NULL WHERE id = ?")
    .run(filaId, new Date(Date.now() - minutos * 60_000).toISOString(), prioridade, c.id);
  return c.id;
}

describe('painel ao vivo', () => {
  test('mostra fila, espera, equipe e alertas, sem expor o cliente', () => {
    const { db, empresa, filas, atendente } = h.criarAmbiente();
    const fila = filas[0];
    db.prepare('INSERT OR IGNORE INTO fila_usuarios (fila_id, usuario_id) VALUES (?, ?)').run(fila.id, atendente.id);
    // A atendente está disponível mas não abriu o painel: não conta como livre.
    db.prepare('UPDATE usuarios SET visto_em = NULL WHERE id = ?').run(atendente.id);
    naFila(db, empresa, fila.id, '5511911112222', 'Joana Prado da Silva', 8);
    naFila(db, empresa, fila.id, '5511933334444', null, 1, 'alta');

    const d = aoVivo(db, empresa.id);
    assert.equal(d.agora.na_fila, 2);
    assert.ok(d.agora.maior_espera_s >= 8 * 60 - 2);
    const f = d.filas.find((x) => x.id === fila.id);
    assert.equal(f.aguardando, 2);
    assert.equal(f.nivel, 'critico', `passou de ${META_ESPERA_S / 60} min`);
    assert.equal(f.disponiveis, 0);
    // A prioridade alta vem primeiro, mesmo tendo chegado depois.
    assert.equal(d.esperando[0].prioridade, 'alta');
    assert.equal(d.esperando[0].cliente, 'Cliente');
    const joana = d.esperando[1];
    assert.equal(joana.cliente, 'Joana', 'só o primeiro nome');
    assert.equal(joana.telefone, '•••• 2222', 'só o final do telefone');
    assert.ok(!JSON.stringify(d).includes('11911112222'), 'o número completo não sai na TV');
    assert.ok(d.alertas.some((a) => a.nivel === 'critico' && a.texto.includes('ninguém disponível')));
    assert.equal(d.equipe.find((p) => p.id === atendente.id).situacao, 'ausente');
    assert.equal(d.telefone, null, 'sem telefonia ligada, sem bloco de telefone');
  });

  test('a situação de cada pessoa e o nível de serviço do dia', () => {
    const { db, empresa, filas, atendente, admin } = h.criarAmbiente();
    db.prepare('UPDATE usuarios SET visto_em = ?, disponivel = 1 WHERE id IN (?, ?)').run(agora(), atendente.id, admin.id);
    const id = naFila(db, empresa, filas[0].id, '5511955556666', 'Rui', 1);
    // A atendente assumiu em 30 s: dentro da meta de 2 min.
    const t = new Date(Date.now() - 60_000).toISOString();
    db.prepare("UPDATE conversas SET estado = 'humano', atendente_id = ?, transferida_em = ?, assumida_em = ? WHERE id = ?")
      .run(atendente.id, t, new Date(Date.parse(t) + 30_000).toISOString(), id);

    const d = aoVivo(db, empresa.id);
    assert.equal(d.agora.com_equipe, 1);
    assert.equal(d.equipe.find((p) => p.id === atendente.id).situacao, 'atendendo');
    assert.equal(d.equipe.find((p) => p.id === admin.id).situacao, 'livre');
    assert.equal(d.equipe[0].id, atendente.id, 'quem está atendendo aparece antes de quem está livre');
    assert.equal(d.hoje.nivel_servico, 100);
    assert.equal(d.hoje.por_hora.length, 24);
    assert.deepEqual(d.alertas, []);
  });
});

describe('links de TV', () => {
  let meta;
  let db;
  let empresa;
  let servidor;
  let base;
  const tokens = {};
  const chamar = (metodo, caminho, corpo, token) => fetch(`${base}/api${caminho}`, {
    method: metodo,
    headers: { ...(corpo ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const entrar = async (email) => (await (await chamar('POST', '/auth/login', { email, senha: 'senha12345' })).json()).token;

  before(async () => {
    meta = h.fingirMeta();
    ({ db, empresa } = h.criarAmbiente());
    servidor = criarApp(db).listen(0);
    await new Promise((r) => servidor.once('listening', r));
    base = `http://127.0.0.1:${servidor.address().port}`;
    empresasLib.criarUsuario(db, empresa.id, { nome: 'Beatriz', email: 'bia.tv@fibramais.com.br', perfil: 'supervisor', senha: 'senha12345' });
    tokens.admin = await entrar('carlos@fibramais.com.br');
    tokens.atendente = await entrar('marina@fibramais.com.br');
    tokens.supervisor = await entrar('bia.tv@fibramais.com.br');
  });
  after(async () => { meta.restaurar(); await new Promise((r) => servidor.close(r)); });

  test('a supervisão vê o painel; o atendente não', async () => {
    assert.equal((await chamar('GET', `/empresas/${empresa.id}/ao-vivo`, null, tokens.supervisor)).status, 200);
    assert.equal((await chamar('GET', `/empresas/${empresa.id}/ao-vivo`, null, tokens.atendente)).status, 403);
  });

  test('o link abre só o painel, sem login, e para na hora ao ser revogado', async () => {
    // O supervisor só consulta: não cria link.
    assert.equal((await chamar('POST', `/empresas/${empresa.id}/telas-tv`, { nome: 'TV' }, tokens.supervisor)).status, 403);
    const r = await chamar('POST', `/empresas/${empresa.id}/telas-tv`, { nome: 'TV da sala' }, tokens.admin);
    assert.equal(r.status, 201);
    const { id, chave } = await r.json();
    assert.match(chave, /^tv_/);
    assert.ok(!db.prepare('SELECT chave_hash FROM telas_tv WHERE id = ?').get(id).chave_hash.includes(chave), 'o banco guarda só o hash');

    const tv = await chamar('GET', '/tv/ao-vivo', null, chave);
    assert.equal(tv.status, 200);
    assert.equal((await tv.json()).empresa.id, empresa.id);
    // O link da TV não é sessão nem chave de API: não abre mais nada.
    assert.equal((await chamar('GET', `/empresas/${empresa.id}/conversas`, null, chave)).status, 401);
    assert.equal((await chamar('GET', '/integracao/conversas', null, chave)).status, 401);
    assert.equal((await chamar('GET', '/tv/ao-vivo', null, 'tv_inventado')).status, 401);

    const lista = await (await chamar('GET', `/empresas/${empresa.id}/telas-tv`, null, tokens.supervisor)).json();
    assert.equal(lista.length, 1);
    assert.ok(lista[0].ultimo_uso, 'a lista mostra quando a TV abriu por último');
    assert.ok(!JSON.stringify(lista).includes(chave));

    assert.equal((await chamar('DELETE', `/empresas/${empresa.id}/telas-tv/${id}`, null, tokens.admin)).status, 200);
    assert.equal((await chamar('GET', '/tv/ao-vivo', null, chave)).status, 401);
  });
});
