'use strict';

/**
 * Revisão antes da instalação: cada teste aqui fecha um defeito real encontrado na revisão do código.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const h = require('./helpers');
const { criarApp } = require('../server/app');
const empresasLib = require('../server/lib/empresas');
const conversas = require('../server/lib/conversas');
const { agora } = require('../server/db');

describe('isolamento entre empresas e LGPD, pela API', () => {
  let meta;
  let amb;
  let db;
  let A;
  let srv;
  let base;
  const chamar = (m, c, corpo, tok, extra = {}) => fetch(base + c, {
    method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...extra },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const entrar = async (email) => (await (await chamar('POST', '/auth/login', { email, senha: 'senha12345' })).json()).token;

  before(async () => {
    meta = h.fingirMeta();
    amb = h.criarAmbiente({ iaAtiva: false });
    ({ db } = amb);
    A = empresasLib.criar(db, { nome: 'Atacante' }, { comExemplos: false });
    empresasLib.criarUsuario(db, A.id, { nome: 'Mal', email: 'mal@a.com.br', perfil: 'cliente', senha: 'senha12345' });
    empresasLib.salvarNumero(db, A.id, { nome: 'A', telefone: '1144445555', phone_number_id: '55555', token: 'x', app_secret: 'segredoA' });
    srv = criarApp(db).listen(0);
    await new Promise((r) => srv.once('listening', r));
    base = `http://127.0.0.1:${srv.address().port}/api`;
  });
  after(async () => { meta.restaurar(); await new Promise((r) => srv.close(r)); });

  test('webhook assinado pela empresa A não entrega mensagem forjada no número da empresa B', async () => {
    const corpo = { entry: [{ changes: [
      { value: { metadata: { phone_number_id: '55555' }, messages: [] } },
      { value: { metadata: { phone_number_id: h.PHONE_ID }, contacts: [{ wa_id: '5511900000001', profile: { name: 'Falso' } }],
        messages: [{ id: 'wamid.forjada1', from: '5511900000001', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'oi' } }] } },
    ] }] };
    const cru = JSON.stringify(corpo);
    const r = await fetch(`${base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json',
      'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', 'segredoA').update(cru).digest('hex')}` }, body: cru });
    assert.equal(r.status, 200);
    await new Promise((x) => setTimeout(x, 200));
    assert.equal(db.prepare("SELECT 1 FROM mensagens WHERE wa_id = 'wamid.forjada1'").get(), undefined, 'a entrada de B foi ignorada');
  });

  test('chamado não aponta para conversa de outra empresa', async () => {
    const ctB = conversas.garantirContato(db, amb.empresa.id, '5511911110000', null);
    const convB = conversas.abrir(db, { empresa: amb.empresa, numero: amb.numero, contato: ctB });
    const tokA = await entrar('mal@a.com.br');
    const ctA = Number(db.prepare("INSERT INTO contatos (empresa_id, telefone, primeiro_contato_em) VALUES (?, '5511911112222', ?)").run(A.id, agora()).lastInsertRowid);
    const r = await chamar('POST', `/empresas/${A.id}/chamados`, { contato_id: ctA, conversa_id: convB.id, assunto: 'x' }, tokA);
    assert.equal(r.status, 404);
  });

  test('atendente sem "ver CPF" não recebe o documento inteiro em nenhuma resposta', async () => {
    const conv = db.prepare('SELECT * FROM conversas WHERE empresa_id = ? ORDER BY id DESC LIMIT 1').get(amb.empresa.id);
    db.prepare("UPDATE contatos SET documento = '52998224725' WHERE id = ?").run(conv.contato_id);
    const tok = await entrar('marina@fibramais.com.br');
    const respostas = [
      await (await chamar('GET', `/empresas/${amb.empresa.id}/conversas?caixa=abertas`, null, tok)).json(),
      await (await chamar('GET', `/empresas/${amb.empresa.id}/conversas/${conv.id}`, null, tok)).json(),
      await (await chamar('PATCH', `/empresas/${amb.empresa.id}/contatos/${conv.contato_id}`, {}, tok)).json(),
    ];
    for (const corpo of respostas) assert.ok(!JSON.stringify(corpo).includes('52998224725'), JSON.stringify(corpo).slice(0, 200));
    // O administrador (com a permissão) continua vendo.
    const admin = await entrar('carlos@fibramais.com.br');
    const d = await (await chamar('GET', `/empresas/${amb.empresa.id}/conversas/${conv.id}`, null, admin)).json();
    assert.equal(d.contato.documento, '52998224725');
  });

  test('a ficha 360° na Ouvidoria exige a permissão da ficha', async () => {
    const ouv = require('../server/lib/ouvidoria');
    const conv = db.prepare('SELECT * FROM conversas WHERE empresa_id = ? ORDER BY id DESC LIMIT 1').get(amb.empresa.id);
    const contato = db.prepare('SELECT * FROM contatos WHERE id = ?').get(conv.contato_id);
    const { ouvidoria } = ouv.abrir(db, { empresa: amb.empresa, contato, tipo: 'reclamacao', assunto: 'x' });
    const marina = db.prepare("SELECT id FROM usuarios WHERE email = 'marina@fibramais.com.br'").get();
    db.prepare("INSERT OR REPLACE INTO usuario_permissoes (usuario_id, permissao, concedida) VALUES (?, 'ouvidoria.ver', 1)").run(marina.id);
    db.prepare("INSERT OR REPLACE INTO usuario_permissoes (usuario_id, permissao, concedida) VALUES (?, 'cliente.ficha', 0)").run(marina.id);
    const tok = await entrar('marina@fibramais.com.br');
    const d = await (await chamar('GET', `/empresas/${amb.empresa.id}/ouvidoria/${ouvidoria.id}`, null, tok)).json();
    assert.equal(d.ficha, null);
    assert.equal(d.ficha_restrita, true);
  });

  test('chave errada na integração e token errado no webhook não enchem o banco', async () => {
    const antes = db.prepare('SELECT COUNT(*) n FROM acessos_recusados').get().n;
    for (let i = 0; i < 20; i++) await chamar('GET', '/integracao/conversas', null, null, { 'X-Api-Key': `atd_errada${i}` });
    for (let i = 0; i < 20; i++) await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=x${i}&hub.challenge=1`);
    const depois = db.prepare('SELECT COUNT(*) n FROM acessos_recusados').get().n;
    assert.ok(depois - antes <= 2, `${depois - antes} linhas para 40 tentativas`);
  });
});

describe('identidade: o limite de tentativas é da plataforma', () => {
  test('passado o limite, nem compara — e trocar de conversa não zera', async () => {
    const meta = h.fingirMeta();
    const ixc = h.fingirIxc(h.CADASTRO);
    try {
      const amb = h.criarAmbiente();
      h.comIxc(amb.db, amb.empresa.id);
      const ixcTools = require('../server/ia/ferramentas-ixc');
      const sem = h.semIa();
      await h.conversar(amb.db, 'oi');
      sem.restaurar();
      const ctx = () => {
        const conversa = h.conversaDoCliente(amb.db);
        return { db: amb.db, empresa: amb.empresa, conversa, contato: amb.db.prepare('SELECT * FROM contatos WHERE id = ?').get(conversa.contato_id) };
      };
      await ixcTools.identificarPeloTelefone(amb.db, ctx());
      const def = ixcTools.FERRAMENTAS.confirmar_identidade;
      for (const chute of ['000', '111', '222']) await ixcTools.executar(def, { ...ctx(), entrada: { resposta: chute } });
      // Nova conversa (ex.: uma ligação nova) para o mesmo cadastro: o limite continua valendo.
      const c = h.conversaDoCliente(amb.db);
      amb.db.prepare("UPDATE conversas SET identidade_tentativas = 0 WHERE id = ?").run(c.id);
      const certo = String(h.CADASTRO.clientes[0].cnpj_cpf).replace(/\D/g, '').slice(0, 3);
      const r = await ixcTools.executar(def, { ...ctx(), entrada: { resposta: certo } });
      assert.equal(r.ok, false);
      assert.equal(r.bloqueado, 'limite de tentativas');
      assert.equal(h.conversaDoCliente(amb.db).identidade_confirmada, 0);
    } finally { meta.restaurar(); ixc.restaurar(); }
  });
});

describe('rotinas', () => {
  test('a limpeza por retenção apaga a conversa antiga mesmo com eventos da IA e chamados', () => {
    const { limpar } = require('../server/lib/manutencao');
    const { db, empresa, numero } = h.criarAmbiente();
    const ct = conversas.garantirContato(db, empresa.id, '5511977776666');
    const c = conversas.abrir(db, { empresa, numero, contato: ct });
    conversas.encerrar(db, c, { resolvidaPor: 'ia', avisar: false });
    db.prepare("INSERT INTO chamados (empresa_id, conversa_id, contato_id, protocolo, assunto, criado_em) VALUES (?, ?, ?, 'X1', 'x', ?)").run(empresa.id, c.id, ct.id, agora());
    db.prepare("UPDATE conversas SET encerrada_em = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(c.id);
    db.prepare("UPDATE configuracoes SET valor = '30' WHERE chave = 'retencao_dias'").run();
    assert.equal(limpar(db).conversas, 1);
    assert.equal(db.prepare('SELECT conversa_id FROM chamados WHERE protocolo = ?').get('X1').conversa_id, null, 'o chamado fica, sem o vínculo');
  });

  test('conversa na fila não é encerrada como abandono em 3 h; conversa com a ZOE é', () => {
    const { encerrarAbandonadas } = require('../server/lib/manutencao');
    const { db, empresa, numero } = h.criarAmbiente();
    const quatroHoras = new Date(Date.now() - 4 * 3_600_000).toISOString();
    const abrir = (tel, estado) => {
      const ct = conversas.garantirContato(db, empresa.id, tel);
      const c = conversas.abrir(db, { empresa, numero, contato: ct });
      db.prepare('UPDATE conversas SET estado = ?, ultima_mensagem_cliente_em = ?, aberta_em = ? WHERE id = ?').run(estado, quatroHoras, quatroHoras, c.id);
      return c.id;
    };
    const naFila = abrir('5511900001111', 'aguardando');
    const comZoe = abrir('5511900002222', 'bot');
    const fechadas = encerrarAbandonadas(db);
    assert.ok(fechadas.includes(comZoe));
    assert.ok(!fechadas.includes(naFila), 'quem foi transferido à noite continua visível para a equipe');
  });

  test('a régua das 21 h roda todo dia (o dia é o local, não o de Greenwich)', () => {
    const regua = require('../server/lib/regua');
    const { db, empresa } = h.criarAmbiente();
    db.prepare(`INSERT INTO reguas (empresa_id, nome, template, hora, dias_semana, ativa, criada_em, ultima_execucao_em, preferir_janela)
      VALUES (?, 'r', 't', '21:30', '1111111', 1, 'x', '2026-11-14T00:31:00.000Z', 0)`).run(empresa.id);
    // Rodou dia 13 às 21:31 em São Paulo (00:31Z do dia 14). Dia 14 às 21:32 local (00:32Z do dia 15) tem de rodar.
    assert.equal(regua.devemRodar(db, new Date('2026-11-15T00:32:00Z')).length, 1);
    // E no mesmo dia local, não.
    assert.equal(regua.devemRodar(db, new Date('2026-11-14T00:35:00Z')).length, 0);
  });

  test('senha provisória não é mais "atende" + 4 dígitos', () => {
    const { db, empresa } = h.criarAmbiente();
    const { senha_provisoria: s } = empresasLib.criarUsuario(db, empresa.id, { nome: 'Nova', email: 'nova@fibramais.com.br', perfil: 'atendente' });
    assert.ok(s.length >= 12);
    assert.doesNotMatch(s, /^atende\d{4}$/);
  });
});

describe('rede interna', () => {
  test('IPv4 mapeado em IPv6, metadados da nuvem e loopback são recusados', () => {
    const rede = require('../server/lib/rede');
    for (const ip of ['127.0.0.1', '169.254.169.254', '::1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '10.0.0.1', 'fd00::1']) {
      assert.equal(rede.ipBloqueado(ip, { interna: false }), true, ip);
    }
    assert.equal(rede.ipBloqueado('10.0.0.1', { interna: true }), false, 'IXC na rede do provedor, com ATEND_REDE_INTERNA=1');
    assert.equal(rede.ipBloqueado('169.254.169.254', { interna: true }), true, 'metadados da nuvem nunca');
    assert.equal(rede.ipBloqueado('8.8.8.8', { interna: false }), false);
  });
});
