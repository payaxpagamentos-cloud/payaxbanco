'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const ferramentas = require('../server/ia/ferramentas');
const ixcTools = require('../server/ia/ferramentas-ixc');
const conversasLib = require('../server/lib/conversas');

/**
 * O portão de identidade é a peça de segurança do bot de provedor: nenhum dado de contrato sai
 * antes de a PLATAFORMA conferir quem é o cliente. O modelo conduz a conversa, mas não abre a porta.
 */
describe('IXC: portão de identidade', () => {
  let meta;
  let ixc;
  let ambiente;

  const contexto = (extra = {}) => {
    const db = ambiente.db;
    const conversa = h.conversaDoCliente(db);
    const contato = db.prepare('SELECT * FROM contatos WHERE id = ?').get(conversa.contato_id);
    return { db, empresa: ambiente.empresa, conversa, contato, ...extra };
  };
  const chamar = (nome, entrada = {}) => {
    const def = ixcTools.FERRAMENTAS[nome];
    return ixcTools.executar(def, { ...contexto(), entrada });
  };

  beforeEach(async () => {
    meta = h.fingirMeta();
    ixc = h.fingirIxc(h.CADASTRO);
    ambiente = h.criarAmbiente();
    h.comIxc(ambiente.db, ambiente.empresa.id);
    const sem = h.semIa();
    // Abre a conversa (sem IA: só precisamos da conversa e do contato criados).
    await h.conversar(ambiente.db, 'oi');
    sem.restaurar();
  });
  afterEach(() => { meta.restaurar(); ixc.restaurar(); });

  test('o telefone identifica o cliente, mas NÃO confirma a identidade', async () => {
    const achado = await ixcTools.identificarPeloTelefone(ambiente.db, contexto());
    assert.equal(achado?.id, '501');
    const c = h.conversaDoCliente(ambiente.db);
    assert.equal(c.ixc_cliente_id, '501');
    assert.equal(c.identidade_confirmada, 0, 'achar pelo telefone não confirma nada');
    assert.equal(c.identidade_metodo, 'cpf3');
  });

  test('toda ferramenta de contrato é recusada antes da confirmação', async () => {
    await ixcTools.identificarPeloTelefone(ambiente.db, contexto());
    for (const nome of ['situacao_do_contrato', 'faturas_em_aberto', 'diagnostico_de_conexao', 'meus_chamados']) {
      const r = await chamar(nome);
      assert.equal(r.ok, false, `${nome} deveria estar bloqueada`);
      assert.equal(r.bloqueado, 'identidade não confirmada');
      assert.match(r.instrucao, /TRÊS PRIMEIROS/);
    }
    // E o IXC nem chegou a ser consultado para esses dados.
    assert.equal(ixc.chamadas.some((x) => x.recurso === 'fn_areceber'), false, 'nenhuma consulta de fatura chegou ao IXC');
  });

  test('a ferramenta de desbloqueio e a de abrir chamado também passam pelo portão', async () => {
    await ixcTools.identificarPeloTelefone(ambiente.db, contexto());
    const d = await chamar('desbloqueio_de_confianca', { contrato_id: '77', motivo: 'pagou' });
    assert.equal(d.ok, false);
    assert.equal(d.bloqueado, 'identidade não confirmada');
    const ch = await chamar('abrir_chamado_tecnico', { titulo: 'x', relato: 'y' });
    assert.equal(ch.ok, false);
    assert.equal(ch.bloqueado, 'identidade não confirmada');
    assert.equal(ixc.chamadas.some((x) => x.recurso === 'desbloqueio_confianca'), false);
  });

  test('três dígitos errados não confirmam, contam tentativa e o limite manda transferir', async () => {
    await ixcTools.identificarPeloTelefone(ambiente.db, contexto());
    const primeira = await chamar('confirmar_identidade', { resposta: '999' });
    assert.equal(primeira.confere, false);
    assert.equal(primeira.tentativas_restantes, 2);
    assert.match(primeira.instrucao, /Não diga qual é o dado certo/);

    await chamar('confirmar_identidade', { resposta: '888' });
    const terceira = await chamar('confirmar_identidade', { resposta: '777' });
    assert.equal(terceira.ok, false);
    assert.match(terceira.instrucao, /transferir_para_humano/);
    assert.equal(h.conversaDoCliente(ambiente.db).identidade_confirmada, 0);
  });

  test('os três dígitos certos destravam, e aí as consultas funcionam', async () => {
    await ixcTools.identificarPeloTelefone(ambiente.db, contexto());
    const ok = await chamar('confirmar_identidade', { resposta: '123' });
    assert.equal(ok.confere, true);
    assert.equal(ok.cliente.nome, 'Ana Clara Ribeiro');
    assert.equal(h.conversaDoCliente(ambiente.db).identidade_confirmada, 1);

    const contrato = await chamar('situacao_do_contrato');
    assert.equal(contrato.ok, true);
    assert.equal(contrato.contratos[0].plano, 'Fibra 600 Mega');
    assert.equal(contrato.contratos[0].acesso, 'bloqueio_automatico');
    assert.match(contrato.contratos[0].o_que_significa, /falta de pagamento/);
    assert.match(contrato.dica, /faturas_em_aberto/);

    const faturas = await chamar('faturas_em_aberto');
    assert.equal(faturas.quantidade, 2);
    assert.equal(faturas.total.replace(/\u00a0/g, ' '), 'R$ 259,80');
    assert.equal(faturas.faturas[0].vencimento, '10/10/2026');
    assert.equal(faturas.faturas[0].vencida, true);
  });

  test('telefone desconhecido: pede o documento e confirma pela data de nascimento', async () => {
    const db = ambiente.db;
    // Troca o telefone do contato por um que não está no cadastro do IXC.
    const conversaId = h.conversaDoCliente(db).id;
    db.prepare('UPDATE contatos SET telefone = ? WHERE id = ?').run('5511900000000', h.conversaDoCliente(db).contato_id);
    const ctx = () => {
      const conversa = db.prepare('SELECT * FROM conversas WHERE id = ?').get(conversaId);
      return { db, empresa: ambiente.empresa, conversa, contato: db.prepare('SELECT * FROM contatos WHERE id = ?').get(conversa.contato_id) };
    };
    const chamar2 = (nome, entrada = {}) => ixcTools.executar(ixcTools.FERRAMENTAS[nome], { ...ctx(), entrada });
    const conversaAgora = () => db.prepare('SELECT * FROM conversas WHERE id = ?').get(conversaId);
    assert.equal(await ixcTools.identificarPeloTelefone(db, ctx()), null);

    const barrado = await chamar2('faturas_em_aberto');
    assert.equal(barrado.bloqueado, 'cliente não identificado');
    assert.match(barrado.instrucao, /identificar_cliente/);

    const invalido = await chamar2('identificar_cliente', { documento: '11111111111' });
    assert.equal(invalido.ok, false);
    assert.match(invalido.erro, /inválido/);

    const achou = await chamar2('identificar_cliente', { documento: '12345678909' });
    assert.equal(achou.encontrou, true);
    assert.equal(achou.pode_confirmar, true);
    assert.match(achou.instrucao, /DATA DE NASCIMENTO/);
    assert.equal(conversaAgora().identidade_confirmada, 0, 'achar pelo documento também não confirma');

    assert.equal((await chamar2('confirmar_identidade', { resposta: '01/01/1980' })).confere, false);
    const ok = await chamar2('confirmar_identidade', { resposta: '05/03/1990' });
    assert.equal(ok.confere, true);
    assert.equal(conversaAgora().identidade_confirmada, 1);
  });

  test('cadastro sem data de nascimento não é confirmado por aqui: transfere', async () => {
    ixc.restaurar();
    ixc = h.fingirIxc({ ...h.CADASTRO, clientes: [{ ...h.CADASTRO.clientes[0], data_nascimento: '' }] });
    const db = ambiente.db;
    const conversaId = h.conversaDoCliente(db).id;
    db.prepare('UPDATE contatos SET telefone = ? WHERE id = ?').run('5511900000000', h.conversaDoCliente(db).contato_id);
    const conversa = db.prepare('SELECT * FROM conversas WHERE id = ?').get(conversaId);
    const r = await ixcTools.executar(ixcTools.FERRAMENTAS.identificar_cliente, {
      db, empresa: ambiente.empresa, conversa, contato: db.prepare('SELECT * FROM contatos WHERE id = ?').get(conversa.contato_id),
      entrada: { documento: '12345678909' },
    });
    assert.equal(r.pode_confirmar, false);
    assert.match(r.instrucao, /transferir_para_humano/);
  });
});

describe('IXC: o que a atendente resolve sozinha', () => {
  let meta;
  let ixc;
  let ambiente;

  const confirmado = async () => {
    const db = ambiente.db;
    const conversa = h.conversaDoCliente(db);
    const contato = db.prepare('SELECT * FROM contatos WHERE id = ?').get(conversa.contato_id);
    await ixcTools.identificarPeloTelefone(db, { conversa, contato });
    await ixcTools.executar(ixcTools.FERRAMENTAS.confirmar_identidade, { db, empresa: ambiente.empresa, conversa, contato, entrada: { resposta: '123' } });
    return { db, empresa: ambiente.empresa, conversa: h.conversaDoCliente(db), contato };
  };
  const chamar = async (nome, entrada = {}) => {
    const ctx = await confirmado();
    return ixcTools.executar(ixcTools.FERRAMENTAS[nome], { ...ctx, entrada });
  };

  beforeEach(async () => {
    meta = h.fingirMeta();
    ixc = h.fingirIxc(h.CADASTRO);
    ambiente = h.criarAmbiente();
    h.comIxc(ambiente.db, ambiente.empresa.id);
    const sem = h.semIa();
    await h.conversar(ambiente.db, 'oi');
    sem.restaurar();
  });
  afterEach(() => { meta.restaurar(); ixc.restaurar(); });

  test('segunda via: manda PIX, linha digitável e o PDF, e não deixa pegar fatura de outro cliente', async () => {
    const r = await chamar('enviar_segunda_via', { fatura_id: '9001' });
    assert.equal(r.enviado, true);
    assert.equal(r.com_linha_digitavel, true);
    assert.equal(r.com_pdf, true);
    assert.match(r.instrucao, /Não repita o código/);
    await require('../server/lib/envio').processarFila(ambiente.db);
    const textos = meta.enviadas.map((m) => m.texto).join(' ');
    assert.match(textos, /34191790010104351004791020150008291070026000/);
    assert.match(textos.replace(/\u00a0/g, ' '), /R\$ 129,90/);

    const alheia = await chamar('enviar_segunda_via', { fatura_id: '7777' });
    assert.equal(alheia.ok, false);
    assert.match(alheia.erro, /não está em aberto neste cliente/);
  });

  test('desbloqueio de confiança libera uma vez e barra a segunda no período', async () => {
    const primeiro = await chamar('desbloqueio_de_confianca', { contrato_id: '77', motivo: 'pagou hoje de manhã' });
    assert.equal(primeiro.liberado, true);
    assert.match(primeiro.resposta_do_sistema, /liberado por 3 dias/);
    assert.match(primeiro.instrucao, /fatura continua em aberto/);

    const segundo = await chamar('desbloqueio_de_confianca', { contrato_id: '77', motivo: 'de novo' });
    assert.equal(segundo.ok, false);
    assert.match(segundo.erro, /já usou o desbloqueio de confiança 1 vez/);
    assert.match(segundo.instrucao, /transferir_para_humano/);
  });

  test('desbloqueio desligado na empresa não é oferecido nem executado', async () => {
    ambiente.db.prepare('UPDATE ixc_config SET desbloqueio_ativo = 0 WHERE empresa_id = ?').run(ambiente.empresa.id);
    assert.equal(ferramentas.montar(ambiente.db, { empresaId: ambiente.empresa.id }).tools.some((t) => t.name === 'desbloqueio_de_confianca'), false);
    const r = await chamar('desbloqueio_de_confianca', { contrato_id: '77', motivo: 'x' });
    assert.equal(r.ok, false);
    assert.match(r.erro, /desligado nesta empresa/);
  });

  test('diagnóstico de conexão distingue offline de problema no Wi-Fi', async () => {
    const offline = await chamar('diagnostico_de_conexao');
    assert.equal(offline.online_agora, false);
    assert.match(offline.instrucao, /NÃO está conectado/);
    assert.match(offline.instrucao, /abrir_chamado_tecnico/);

    ixc.restaurar();
    ixc = h.fingirIxc({ ...h.CADASTRO, logins: [{ ...h.CADASTRO.logins[0], online: 'S', ip: '100.64.0.10' }] });
    const online = await chamar('diagnostico_de_conexao');
    assert.equal(online.online_agora, true);
    assert.match(online.instrucao, /ESTÁ conectado/);
    assert.match(online.instrucao, /Wi-Fi/);
  });

  test('abre chamado técnico no IXC e devolve o protocolo', async () => {
    const r = await chamar('abrir_chamado_tecnico', { titulo: 'Sem conexão desde ontem', relato: 'Login offline desde 12/11 às 22h. Cliente já reiniciou o roteador.' });
    assert.equal(r.ok, true);
    assert.equal(r.protocolo, '2026110001');
    assert.match(r.instrucao, /2026110001/);
    assert.match(r.instrucao, /Não prometa prazo/);
    const aberto = ixc.chamadas.find((x) => x.recurso === 'su_oss_chamado' && !x.corpo.qtype);
    assert.equal(aberto.corpo.id_cliente, '501');
    assert.match(aberto.corpo.mensagem, /ZOE no WhatsApp/);
  });

  test('tudo fica registrado em ixc_acoes, para o provedor auditar', async () => {
    await chamar('faturas_em_aberto');
    await chamar('desbloqueio_de_confianca', { contrato_id: '77', motivo: 'pagou' });
    const acoes = ambiente.db.prepare('SELECT tipo, sucesso FROM ixc_acoes WHERE empresa_id = ? ORDER BY id').all(ambiente.empresa.id);
    const tipos = acoes.map((a) => a.tipo);
    assert.ok(tipos.includes('identificacao'));
    assert.ok(tipos.includes('confirmacao'));
    assert.ok(tipos.includes('faturas'));
    assert.ok(tipos.includes('desbloqueio'));
    assert.equal(acoes.every((a) => a.sucesso === 1), true);
  });
});

describe('IXC fora do ar', () => {
  let meta;
  let ambiente;
  beforeEach(async () => {
    meta = h.fingirMeta();
    ambiente = h.criarAmbiente();
    h.comIxc(ambiente.db, ambiente.empresa.id);
    const sem = h.semIa();
    const ixcOk = h.fingirIxc(h.CADASTRO);
    await h.conversar(ambiente.db, 'oi');
    ixcOk.restaurar();
    sem.restaurar();
  });
  afterEach(() => { meta.restaurar(); });

  test('não inventa: devolve o erro e manda transferir', async () => {
    const caido = h.fingirIxc({}, { falhar: true });
    try {
      const db = ambiente.db;
      const conversa = h.conversaDoCliente(db);
      const contato = db.prepare('SELECT * FROM contatos WHERE id = ?').get(conversa.contato_id);
      db.prepare('UPDATE conversas SET ixc_cliente_id = ?, identidade_confirmada = 1 WHERE id = ?').run('501', conversa.id);
      const r = await ixcTools.executar(ixcTools.FERRAMENTAS.faturas_em_aberto,
        { db, empresa: ambiente.empresa, conversa: h.conversaDoCliente(db), contato, entrada: {} });
      assert.equal(r.ok, false);
      assert.match(r.erro, /Sem conexão com o IXC|não consegui consultar/i);
      assert.match(r.instrucao, /transferir_para_humano/);
      assert.match(r.instrucao, /Não invente/);
      const falha = db.prepare("SELECT * FROM ixc_acoes WHERE sucesso = 0 ORDER BY id DESC LIMIT 1").get();
      assert.ok(falha, 'a falha foi registrada para o provedor ver');
    } finally { caido.restaurar(); }
  });

  test('o IXC caído não impede a conversa de abrir', async () => {
    const caido = h.fingirIxc({}, { falhar: true });
    const sem = h.semIa();
    try {
      await h.conversar(ambiente.db, 'minha internet caiu');
      assert.ok(h.conversaDoCliente(ambiente.db), 'a conversa continua existindo');
    } finally { caido.restaurar(); sem.restaurar(); }
  });
});

describe('IXC: sonda de capacidades', () => {
  test('diz o que funciona e o que não funciona nesta instância', async () => {
    const parcial = h.fingirIxc({ ...h.CADASTRO, logins: undefined });
    try {
      const { criarIxc } = require('../server/ia/ixc');
      const ixc = criarIxc({ url: h.IXC_URL, token: '99:token', recursos: { chamado: 'recurso_que_nao_existe' } });
      const d = await ixc.diagnosticar();
      assert.equal(d.conectado, true);
      assert.equal(d.capacidades.cliente.ok, true);
      assert.equal(d.capacidades.receber.ok, true);
      assert.equal(d.capacidades.chamado.ok, false, 'o recurso sobrescrito não existe na instância');
      assert.match(d.capacidades.chamado.erro, /não existe nesta instância/);
      assert.ok(d.resumo.includes('cliente'));
      assert.equal(d.resumo.includes('chamado'), false);
    } finally { parcial.restaurar(); }
  });

  test('a atendente só recebe as ferramentas que a sonda aprovou', () => {
    const { db, empresa } = h.criarAmbiente();
    h.comIxc(db, empresa.id, {
      capacidades: JSON.stringify({
        cliente: { ok: true }, contrato: { ok: true }, receber: { ok: true }, boleto: { ok: true },
        desbloqueio: { ok: true }, login: { ok: false, erro: 'sem RADIUS' }, chamado: { ok: false, erro: 'sem OS' },
      }),
    });
    const nomes = ferramentas.montar(db, { empresaId: empresa.id }).tools.map((t) => t.name);
    assert.ok(nomes.includes('faturas_em_aberto'));
    assert.ok(nomes.includes('desbloqueio_de_confianca'));
    assert.equal(nomes.includes('diagnostico_de_conexao'), false, 'sem RADIUS, a ferramenta não é oferecida');
    assert.equal(nomes.includes('abrir_chamado_tecnico'), false, 'sem OS, a ferramenta não é oferecida');
  });
});

describe('IXC: a nota de estado que vai ao modelo', () => {
  let meta;
  beforeEach(() => { meta = h.fingirMeta(); });
  afterEach(() => { meta.restaurar(); });

  test('muda conforme a identificação e entra como mensagem de sistema no fim', async () => {
    const ixc = h.fingirIxc(h.CADASTRO);
    const { db, empresa } = h.criarAmbiente();
    h.comIxc(db, empresa.id);
    const sem = h.semIa();
    try {
      await h.conversar(db, 'oi');
      const conversa = h.conversaDoCliente(db);
      const contato = db.prepare('SELECT * FROM contatos WHERE id = ?').get(conversa.contato_id);

      assert.match(ixcTools.notaDeEstado(db, conversa), /não está no cadastro|TRÊS PRIMEIROS/);
      await ixcTools.identificarPeloTelefone(db, { conversa, contato });
      assert.match(ixcTools.notaDeEstado(db, h.conversaDoCliente(db)), /AINDA NÃO foi confirmada/);

      db.prepare('UPDATE conversas SET identidade_confirmada = 1 WHERE id = ?').run(conversa.id);
      assert.match(ixcTools.notaDeEstado(db, h.conversaDoCliente(db)), /confirmado.*liberadas/s);

      // A nota entra depois da última mensagem do cliente, como a API exige.
      const { comEstado } = require('../server/ia/atendente');
      const msgs = comEstado([{ role: 'user', content: [{ type: 'text', text: 'oi' }] }], 'nota de teste');
      assert.equal(msgs.at(-1).role, 'system');
      assert.equal(msgs.at(-1).content, 'nota de teste');
      // Sem mensagem de usuário no fim, a nota não é acrescentada (a API recusaria).
      assert.equal(comEstado([{ role: 'assistant', content: [] }], 'nota').length, 1);
    } finally { sem.restaurar(); ixc.restaurar(); }
  });

  test('sem IXC configurado não há nota nem ferramentas', () => {
    const { db, empresa } = h.criarAmbiente();
    assert.equal(ixcTools.configurado(db, empresa.id), false);
    assert.equal(ixcTools.notaDeEstado(db, { empresa_id: empresa.id, id: 1 }), null);
    assert.equal(ferramentas.montar(db, { empresaId: empresa.id }).tools.some((t) => t.name.startsWith('situacao_')), false);
  });
});
