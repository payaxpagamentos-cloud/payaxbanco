'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { dia, limparArquivos } = require('./helpers');
const { abrir, agora, gravarConfig } = require('../server/db');
const { montar } = require('../server/lib/grade');
const { inicioDia, minutosDe, dentroDaJanela } = require('../server/lib/datas');

/** Monta um cenário na memória: pontos, telas, anunciantes, criativos e campanhas. */
function cenario() {
  const db = abrir(':memory:');
  // Nestes testes interessa o encaixe das campanhas: a tela da marca (que completa o loop) fica desligada,
  // e tem teste próprio mais abaixo.
  gravarConfig(db, 'marca_preenche', 0);
  const inserir = (sql, ...p) => Number(db.prepare(sql).run(...p).lastInsertRowid);

  const ponto = (nome, categoria, cidade, publico = 400) =>
    inserir('INSERT INTO locais (nome, categoria, cidade, uf, publico_dia, criado_em) VALUES (?, ?, ?, ?, ?, ?)', nome, categoria, cidade, 'SP', publico, agora());
  const tela = (localId, nome, orientacao = 'paisagem') =>
    inserir('INSERT INTO telas (local_id, nome, orientacao, pareada_em, criado_em) VALUES (?, ?, ?, ?, ?)', localId, nome, orientacao, agora(), agora());
  const anunciante = (nome) => inserir('INSERT INTO anunciantes (nome, criado_em) VALUES (?, ?)', nome, agora());
  const midia = (anuncianteId, nome, duracao, extra = {}) => inserir(
    `INSERT INTO midias (anunciante_id, local_id, nome, uso, tipo, arquivo, mime, bytes, sha256, duracao_s, orientacao, status, validade_ate, criado_em)
     VALUES (?, ?, ?, ?, 'imagem', ?, 'image/png', 1000, ?, ?, ?, ?, ?, ?)`,
    anuncianteId, extra.local_id ?? null, nome, extra.uso ?? 'campanha', `${nome}.png`, `sha-${nome}`, duracao,
    extra.orientacao ?? null, extra.status ?? 'aprovada', extra.validade_ate ?? null, agora(),
  );
  const campanha = (anuncianteId, nome, criativos, extra = {}) => {
    const id = inserir(
      `INSERT INTO campanhas (anunciante_id, nome, status, inicio, fim, cobranca, valor_centavos, insercoes_hora, prioridade, dias_semana, hora_inicio, hora_fim,
        limite_dia, criado_em) VALUES (?, ?, ?, ?, ?, 'mensal', 10000, ?, ?, ?, ?, ?, ?, ?)`,
      anuncianteId, nome, extra.status ?? 'ativa', extra.inicio ?? dia(-5), extra.fim ?? dia(30), extra.insercoes_hora ?? 6, extra.prioridade ?? 3,
      extra.dias_semana ?? '0123456', extra.hora_inicio ?? '00:00', extra.hora_fim ?? '00:00', extra.limite_dia ?? 0, agora(),
    );
    criativos.forEach((m, i) => db.prepare('INSERT INTO campanha_midias (campanha_id, midia_id, ordem) VALUES (?, ?, ?)').run(id, m, i));
    for (const a of extra.alvos ?? []) db.prepare('INSERT INTO campanha_alvos (campanha_id, tipo, valor) VALUES (?, ?, ?)').run(id, a.tipo, String(a.valor));
    return id;
  };
  const daTela = (id) => db.prepare('SELECT t.*, l.categoria, l.cidade FROM telas t JOIN locais l ON l.id = t.local_id WHERE t.id = ?').get(id);
  return { db, ponto, tela, anunciante, midia, campanha, daTela, inserir };
}

/** Instante local (fuso configurado) de um dia e hora. */
const quando = (data, hora) => new Date(Date.parse(inicioDia(data)) + minutosDe(hora) * 60_000);

test('faixa de horário que vira a madrugada', () => {
  assert.equal(dentroDaJanela('23:30', '22:00', '02:00'), true);
  assert.equal(dentroDaJanela('01:00', '22:00', '02:00'), true);
  assert.equal(dentroDaJanela('12:00', '22:00', '02:00'), false);
  assert.equal(dentroDaJanela('12:00', '00:00', '00:00'), true, 'início igual ao fim = 24 horas');
  assert.equal(dentroDaJanela('08:00', '09:00', '18:00'), false);
});

test('inserções proporcionais ao contratado e nada repetido do mesmo anunciante', () => {
  const c = cenario();
  const p = c.ponto('Mercado Dia', 'mercado', 'Campinas');
  const t = c.tela(p, 'Caixa 1');
  const a1 = c.anunciante('Ótica');
  const a2 = c.anunciante('Pizzaria');
  c.campanha(a1, 'Ótica 6/h', [c.midia(a1, 'otica', 10)], { insercoes_hora: 6 });
  c.campanha(a2, 'Pizza 12/h', [c.midia(a2, 'pizza', 10)], { insercoes_hora: 12 });

  const g = montar(c.db, c.daTela(t));
  const porCampanha = Object.fromEntries(g.campanhas.map((x) => [x.anunciante, x.insercoes_loop]));
  assert.deepEqual(porCampanha, { Pizzaria: 2, 'Ótica': 1 }, 'quem contrata o dobro aparece o dobro de vezes');
  assert.equal(g.duracao_s, 30);
  assert.equal(g.campanhas.find((x) => x.anunciante === 'Pizzaria').share, 66.7);
  const seq = g.itens.map((i) => i.anunciante);
  assert.deepEqual(seq, ['Pizzaria', 'Ótica', 'Pizzaria'], 'as inserções ficam espalhadas pelo loop');
});

test('todos os criativos da campanha entram no loop', () => {
  const c = cenario();
  const t = c.tela(c.ponto('Padaria', 'padaria', 'Campinas'), 'TV');
  const a = c.anunciante('Loja');
  c.campanha(a, 'Três peças', [c.midia(a, 'p1', 10), c.midia(a, 'p2', 15), c.midia(a, 'p3', 20)], { insercoes_hora: 6 });
  const g = montar(c.db, c.daTela(t));
  assert.equal(g.itens.length, 3);
  assert.deepEqual(g.itens.map((i) => i.duracao_s), [10, 15, 20]);
  assert.equal(g.duracao_s, 45);
});

test('loop grande demais: a campanha de menor prioridade perde inserções', () => {
  const c = cenario();
  const t = c.tela(c.ponto('Academia', 'academia', 'Campinas'), 'TV');
  gravarConfig(c.db, 'bloco_maximo_s', 120);
  const a1 = c.anunciante('Patrocinador');
  const a2 = c.anunciante('Eventual');
  const a3 = c.anunciante('Pequeno');
  c.campanha(a1, 'Alta prioridade', [c.midia(a1, 'alta', 20)], { insercoes_hora: 12, prioridade: 5 });
  c.campanha(a2, 'Baixa prioridade', [c.midia(a2, 'baixa', 20)], { insercoes_hora: 12, prioridade: 1 });
  c.campanha(a3, 'Uma por hora', [c.midia(a3, 'pequeno', 20)], { insercoes_hora: 1, prioridade: 3 });

  const g = montar(c.db, c.daTela(t));
  assert.ok(g.duracao_s <= 120, `loop deveria caber em 120s, tem ${g.duracao_s}s`);
  const insercoes = (nome) => g.campanhas.find((x) => x.anunciante === nome).insercoes_loop;
  assert.ok(insercoes('Patrocinador') > insercoes('Eventual'),
    `a prioridade alta deveria manter mais inserções (${insercoes('Patrocinador')} x ${insercoes('Eventual')})`);
  assert.ok(insercoes('Eventual') >= 1 && insercoes('Pequeno') >= 1, 'ninguém sai do ar por completo');
});

test('dias da semana e faixa de horário mandam na grade', () => {
  const c = cenario();
  const t = c.tela(c.ponto('Restaurante', 'restaurante', 'Campinas'), 'TV');
  const a = c.anunciante('Marmitaria');
  c.campanha(a, 'Só no almoço', [c.midia(a, 'almoco', 10)], { hora_inicio: '11:00', hora_fim: '14:00' });

  const dataDeTeste = dia(1);
  assert.equal(montar(c.db, c.daTela(t), quando(dataDeTeste, '12:00')).itens.length, 1);
  assert.equal(montar(c.db, c.daTela(t), quando(dataDeTeste, '16:00')).sem_conteudo, true);

  // Dia da semana do instante escolhido, para montar uma campanha que não roda nele.
  const l = require('../server/lib/datas').local(quando(dataDeTeste, '12:00'));
  const outrosDias = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== l.diaSemana).join('');
  const a2 = c.anunciante('Outra');
  c.campanha(a2, 'Outros dias', [c.midia(a2, 'outros', 10)], { dias_semana: outrosDias });
  assert.equal(montar(c.db, c.daTela(t), quando(dataDeTeste, '12:00')).itens.length, 1, 'a campanha de outro dia não entra');
});

test('período da campanha: antes do início e depois do fim, não vai ao ar', () => {
  const c = cenario();
  const t = c.tela(c.ponto('Posto', 'posto', 'Campinas'), 'TV');
  const a = c.anunciante('Lubrificante');
  c.campanha(a, 'Futura', [c.midia(a, 'futura', 10)], { inicio: dia(10), fim: dia(20) });
  c.campanha(a, 'Vencida', [c.midia(a, 'vencida', 10)], { inicio: dia(-20), fim: dia(-1) });
  assert.equal(montar(c.db, c.daTela(t)).sem_conteudo, true);
});

test('alvos: tela, ponto, categoria e cidade', () => {
  const c = cenario();
  const padaria = c.ponto('Padaria Central', 'padaria', 'Campinas');
  const academia = c.ponto('Academia Norte', 'academia', 'Valinhos');
  const tPadaria = c.tela(padaria, 'TV Padaria');
  const tAcademia = c.tela(academia, 'TV Academia');
  const a = c.anunciante('Suplementos');
  c.campanha(a, 'Só academias', [c.midia(a, 'whey', 10)], { alvos: [{ tipo: 'categoria', valor: 'academia' }] });
  c.campanha(a, 'Só Campinas', [c.midia(a, 'campinas', 10)], { alvos: [{ tipo: 'cidade', valor: 'Campinas' }] });
  c.campanha(a, 'Só uma tela', [c.midia(a, 'tela', 10)], { alvos: [{ tipo: 'tela', valor: tPadaria }] });

  const nomes = (id) => montar(c.db, c.daTela(id)).itens.map((i) => i.campanha).sort();
  assert.deepEqual(nomes(tPadaria), ['Só Campinas', 'Só uma tela']);
  assert.deepEqual(nomes(tAcademia), ['Só academias']);
});

test('criativo pendente, recusado ou vencido não vai ao ar', () => {
  const c = cenario();
  const t = c.tela(c.ponto('Farmácia', 'farmacia', 'Campinas'), 'TV');
  const a = c.anunciante('Laboratório');
  c.campanha(a, 'Pendente', [c.midia(a, 'pendente', 10, { status: 'pendente' })]);
  c.campanha(a, 'Vencida ontem', [c.midia(a, 'vencida', 10, { validade_ate: dia(-1) })]);
  c.campanha(a, 'No prazo', [c.midia(a, 'prazo', 10, { validade_ate: dia(1) })]);
  const g = montar(c.db, c.daTela(t));
  assert.deepEqual(g.itens.map((i) => i.campanha), ['No prazo']);
});

test('por padrão passam todas as artes; com "só no formato da TV", a tela em retrato prefere o criativo em retrato', () => {
  const c = cenario();
  const p = c.ponto('Loja', 'loja', 'Campinas');
  const retrato = c.tela(p, 'Totem', 'retrato');
  const paisagem = c.tela(p, 'TV balcão', 'paisagem');
  const a = c.anunciante('Moda');
  c.campanha(a, 'Dois formatos', [c.midia(a, 'deitado', 10, { orientacao: 'paisagem' }), c.midia(a, 'empe', 10, { orientacao: 'retrato' })]);
  // Padrão: a TV passa todas as artes da campanha, qualquer que seja o formato.
  assert.deepEqual(montar(c.db, c.daTela(retrato)).itens.map((i) => i.nome).sort(), ['deitado', 'empe']);
  assert.deepEqual(montar(c.db, c.daTela(paisagem)).itens.map((i) => i.nome).sort(), ['deitado', 'empe']);
  // Com a opção ligada na TV, só as do formato dela.
  c.db.prepare('UPDATE telas SET so_formato = 1').run();
  assert.deepEqual(montar(c.db, c.daTela(retrato)).itens.map((i) => i.nome), ['empe']);
  assert.deepEqual(montar(c.db, c.daTela(paisagem)).itens.map((i) => i.nome), ['deitado']);
});

test('institucional completa o loop e fica intercalado; sem publicidade, roda sozinho', () => {
  const c = cenario();
  const p = c.ponto('Mercado', 'mercado', 'Campinas');
  const t = c.tela(p, 'TV');
  gravarConfig(c.db, 'bloco_minimo_s', 60);
  c.midia(null, 'institucional-rede', 10, { uso: 'institucional' });
  c.midia(null, 'conteudo-do-ponto', 10, { uso: 'institucional', local_id: p });

  const so = montar(c.db, c.daTela(t));
  assert.equal(so.vendido_s, 0);
  assert.ok(so.duracao_s >= 60, 'sem campanha, o institucional preenche o tempo mínimo');
  assert.equal(so.itens[0].nome, 'conteudo-do-ponto', 'o conteúdo do próprio ponto vem primeiro');
  assert.equal(so.ocupacao, 0);

  const a = c.anunciante('Anunciante');
  c.campanha(a, 'Campanha', [c.midia(a, 'anuncio', 15)], { insercoes_hora: 6 });
  const g = montar(c.db, c.daTela(t));
  assert.equal(g.vendido_s, 15);
  assert.ok(g.duracao_s >= 60);
  assert.ok(g.ocupacao > 0 && g.ocupacao < 100);
  assert.ok(g.itens.some((i) => i.campanha === 'Campanha'));
  assert.ok(g.itens.some((i) => i.campanha === null), 'o institucional segue no loop');
});

test('limite de inserções por dia tira a campanha do ar quando bate a meta', () => {
  const c = cenario();
  const p = c.ponto('Clínica', 'clinica', 'Campinas');
  const t = c.tela(p, 'Recepção');
  const a = c.anunciante('Plano de saúde');
  const campanha = c.campanha(a, 'Com teto diário', [c.midia(a, 'plano', 10)], { limite_dia: 50 });
  assert.equal(montar(c.db, c.daTela(t)).itens.length, 1);

  c.db.prepare('INSERT INTO resumo_dia (data, tela_id, campanha_id, local_id, insercoes, segundos) VALUES (?, ?, ?, ?, 50, 500)')
    .run(require('../server/lib/datas').hoje(), t, campanha, p);
  assert.equal(montar(c.db, c.daTela(t)).sem_conteudo, true, 'batido o teto do dia, sai da grade daquela TV');
});

test('a tela da marca só segura a tela que ainda não tem campanha', () => {
  const c = cenario();
  const t = c.tela(c.ponto('Prédio novo', 'condominio_residencial', 'Campinas'), 'Elevador');
  gravarConfig(c.db, 'marca_preenche', 1);
  gravarConfig(c.db, 'marca_duracao_s', 10);
  gravarConfig(c.db, 'bloco_minimo_s', 60);

  const sozinha = montar(c.db, c.daTela(t));
  assert.equal(sozinha.sem_conteudo, false, 'tela sem campanha não fica preta: entra a marca da rede');
  assert.ok(sozinha.itens.every((i) => i.formato === 'marca'));
  assert.equal(sozinha.duracao_s, 60);
  assert.equal(sozinha.ocupacao, 0, 'é tempo não vendido');

  const a = c.anunciante('Construtora');
  c.campanha(a, 'Lançamento', [c.midia(a, 'lancamento', 15)], { insercoes_hora: 6 });
  const g = montar(c.db, c.daTela(t));
  assert.equal(g.vendido_s, 15, 'a publicidade não perde espaço para a marca');
  assert.ok(g.itens.some((i) => i.campanha === 'Lançamento'));
  // Com anúncio no ar, a tela é do cliente: a marca da rede não entra no meio.
  assert.ok(!g.itens.some((i) => i.formato === 'marca'), 'com anúncio no ar, a marca não aparece');
  assert.equal(g.duracao_s, 15);

  gravarConfig(c.db, 'marca_preenche', 0);
  const semMarca = montar(c.db, c.daTela(t));
  assert.ok(!semMarca.itens.some((i) => i.formato === 'marca'), 'dá para desligar a tela da marca');
  assert.equal(semMarca.duracao_s, 15);
});

test('a versão só muda quando a programação muda', () => {
  const c = cenario();
  const t = c.tela(c.ponto('Oficina', 'oficina', 'Campinas'), 'TV');
  const a = c.anunciante('Autopeças');
  const camp = c.campanha(a, 'Peças', [c.midia(a, 'peca', 10)]);
  const v1 = montar(c.db, c.daTela(t)).versao;
  assert.equal(montar(c.db, c.daTela(t)).versao, v1, 'nada mudou: mesma versão');

  c.db.prepare('UPDATE telas SET legenda = ? WHERE id = ?').run('Bem-vindo!', t);
  const v2 = montar(c.db, c.daTela(t)).versao;
  assert.notEqual(v2, v1);

  c.db.prepare("UPDATE campanhas SET status = 'pausada' WHERE id = ?").run(camp);
  assert.notEqual(montar(c.db, c.daTela(t)).versao, v2);
});

test('impactos: a fatia do loop vira público alcançado', () => {
  const c = cenario();
  const p = c.ponto('Supermercado', 'mercado', 'Campinas', 1000);
  const t = c.tela(p, 'TV');
  const a1 = c.anunciante('A');
  const a2 = c.anunciante('B');
  const c1 = c.campanha(a1, 'Campanha A', [c.midia(a1, 'a', 10)]);
  const c2 = c.campanha(a2, 'Campanha B', [c.midia(a2, 'b', 10)]);
  const hoje = require('../server/lib/datas').hoje();
  // 75% do tempo de tela para A, 25% para B.
  c.db.prepare('INSERT INTO resumo_dia (data, tela_id, campanha_id, local_id, insercoes, segundos) VALUES (?, ?, ?, ?, 30, 300)').run(hoje, t, c1, p);
  c.db.prepare('INSERT INTO resumo_dia (data, tela_id, campanha_id, local_id, insercoes, segundos) VALUES (?, ?, ?, ?, 10, 100)').run(hoje, t, c2, p);

  const rel = require('../server/lib/relatorios');
  const itens = rel.porCampanha(c.db, { de: hoje, ate: hoje });
  assert.equal(itens.find((x) => x.campanha_id === c1).impactos, 750);
  assert.equal(itens.find((x) => x.campanha_id === c2).impactos, 250);
});

test.after(limparArquivos);
