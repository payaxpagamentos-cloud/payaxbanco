'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { iniciar } = require('./helpers');
const { agora } = require('../server/db');
const { hoje, somarDias } = require('../server/lib/datas');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGNUf7yNAQaYGJAAbg4AV/UByClZiqQAAAAASUVORK5CYII=', 'base64');
// Cabeçalho mínimo de um MP4 ("ftyp" a partir do 5º byte): é o que o servidor confere.
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64)]);

/** Grava uma venda paga direto no banco: o teste é da vitrine, não do caixa. */
function vender(db, itens) {
  const total = itens.reduce((s, i) => s + i.preco * i.qtd, 0);
  const custo = itens.reduce((s, i) => s + i.custo * i.qtd, 0);
  const id = Number(db.prepare(`INSERT INTO vendas (origem, status, subtotal_centavos, total_centavos, custo_centavos, criada_em, fechada_em)
    VALUES ('autoatendimento', 'paga', ?, ?, ?, ?, ?)`).run(total, total, custo, agora(), agora()).lastInsertRowid);
  for (const i of itens) {
    db.prepare(`INSERT INTO venda_itens (venda_id, produto_id, descricao, qtd_mil, preco_centavos, total_centavos, custo_centavos)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, i.produto.id, i.produto.nome, i.qtd * 1000, i.preco, i.preco * i.qtd, i.custo);
  }
}

async function preparar(t) {
  const app = await iniciar();
  t.after(() => app.fechar());
  const admin = await app.login();
  const novo = async (nome, preco, custo) => (await app.post('/produtos', { nome, preco, custo, estoque: '100', categoria_id: 1 }, admin)).dados;
  // Fatura muito com margem pequena x fatura pouco com margem grande.
  const arroz = await novo('Arroz 5 kg', '30,00', '27,00'); // lucro 3,00 por unidade
  const chocolate = await novo('Chocolate', '10,00', '4,00'); // lucro 6,00 por unidade
  const sabao = await novo('Sabão', '5,00', '4,50');
  vender(app.db, [
    { produto: arroz, qtd: 10, preco: 3000, custo: 2700 }, // fatura 300, lucro 30
    { produto: chocolate, qtd: 8, preco: 1000, custo: 400 }, // fatura 80, lucro 48
    { produto: sabao, qtd: 2, preco: 500, custo: 450 }, // fatura 10, lucro 1
  ]);
  return { app, admin, arroz, chocolate, sabao };
}

test('mais lucrativos: ordena pelo lucro, não pelo faturamento', async (t) => {
  const { app, admin } = await preparar(t);
  const vendidos = (await app.get('/relatorios/mais-vendidos', admin)).dados.map((l) => l.nome);
  const lucrativos = (await app.get('/relatorios/mais-lucrativos', admin)).dados;
  assert.deepEqual(vendidos, ['Arroz 5 kg', 'Chocolate', 'Sabão']);
  assert.deepEqual(lucrativos.map((l) => l.nome), ['Chocolate', 'Arroz 5 kg', 'Sabão']);
  assert.equal(lucrativos[0].lucro_centavos, 4800);
  assert.equal(lucrativos[0].margem_bp, 6000); // 48 de lucro sobre 80 de venda
  const csv = await app.get('/relatorios/csv/mais-lucrativos', admin);
  assert.equal(csv.status, 200);
  assert.match(csv.dados, /Produto;Categoria;Quantidade;Faturamento;Custo;Lucro;Margem %/);
});

test('oferta: preço menor vale na venda, some depois do prazo e não pode subir o preço', async (t) => {
  const { app, admin, chocolate } = await preparar(t);
  const { precoVigente } = require('../server/lib/produtos');

  // Oferta acima do preço normal é recusada.
  const cara = await app.patch(`/produtos/${chocolate.id}`, { oferta_preco: '12,00' }, admin);
  assert.equal(cara.status, 422);
  // Data que já passou também.
  const velha = await app.patch(`/produtos/${chocolate.id}`, { oferta_preco: '7,90', oferta_ate: somarDias(hoje(), -1) }, admin);
  assert.equal(velha.status, 422);

  const ok = await app.patch(`/produtos/${chocolate.id}`, { oferta_preco: '7,90', oferta_ate: hoje() }, admin);
  assert.equal(ok.status, 200);
  assert.equal(ok.dados.em_oferta, true);
  assert.equal(ok.dados.preco_vigente_centavos, 790);
  assert.equal(ok.dados.preco_centavos, 1000); // o preço normal continua guardado

  // A venda cobra o preço da oferta.
  const vendas = require('../server/lib/vendas');
  const venda = app.db.prepare(`INSERT INTO vendas (origem, status, criada_em) VALUES ('autoatendimento', 'aberta', ?)`).run(agora());
  const comItem = vendas.adicionarItem(app.db, Number(venda.lastInsertRowid), { produto_id: chocolate.id, qtd_mil: 2000 });
  assert.equal(comItem.itens[0].preco_centavos, 790);
  assert.equal(comItem.itens[0].total_centavos, 1580);

  // O último dia conta; no dia seguinte volta o preço normal.
  const p = app.db.prepare('SELECT * FROM produtos WHERE id = ?').get(chocolate.id);
  assert.equal(precoVigente(p, hoje()), 790);
  assert.equal(precoVigente(p, somarDias(hoje(), 1)), 1000);

  // Encerrar: preço vazio tira a oferta e a data.
  const fim = await app.patch(`/produtos/${chocolate.id}`, { oferta_preco: '' }, admin);
  assert.equal(fim.dados.em_oferta, false);
  assert.equal(fim.dados.oferta_ate, null);
});

test('vitrine pública: intercala as fontes e nunca mostra custo nem lucro', async (t) => {
  const { app, admin, chocolate } = await preparar(t);
  await app.patch(`/produtos/${chocolate.id}`, { oferta_preco: '7,90' }, admin);

  // Sem login: a TV não faz login.
  const r = await app.get('/vitrine');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const { slides } = r.dados;
  // A oferta vem primeiro; o chocolate não se repete como mais vendido ou mais lucrativo.
  assert.equal(slides[0].nome, 'Chocolate');
  assert.equal(slides[0].selo, 'Oferta');
  assert.equal(slides[0].preco_centavos, 790);
  assert.equal(slides[0].preco_cheio_centavos, 1000);
  assert.equal(slides.filter((s) => s.nome === 'Chocolate').length, 1);
  assert.ok(slides.some((s) => s.selo === 'Mais vendido' && s.nome === 'Arroz 5 kg'));
  // O mais lucrativo aparece para o cliente só como "Destaque da casa".
  assert.ok(slides.every((s) => !/lucr/i.test(s.selo ?? '')));
  // Nada de custo, lucro ou margem na resposta pública.
  assert.doesNotMatch(JSON.stringify(r.dados), /custo|lucro|margem/i);

  // Desligar uma fonte tira ela da sequência: sem a lista de ofertas e sem os mais lucrativos, sobram os mais vendidos.
  await app.patch('/admin/config', { vitrine_ofertas: false, vitrine_mais_lucrativos: false }, admin);
  const sem = (await app.get('/vitrine')).dados.slides;
  assert.deepEqual(sem.map((s) => s.nome), ['Arroz 5 kg', 'Chocolate', 'Sabão']);
  assert.ok(sem.every((s) => s.selo !== 'Destaque da casa'));
  // O chocolate entrou como mais vendido, mas continua mostrando o preço que o caixa cobra: o da oferta.
  const choc = sem.find((s) => s.nome === 'Chocolate');
  assert.equal(choc.preco_centavos, 790);
  assert.equal(choc.selo, 'Oferta');
});

test('vitrine: produto com foto passa na frente; sem foto completa a lista', async (t) => {
  const { app, admin, sabao } = await preparar(t);
  await app.patch('/admin/config', { vitrine_qtd_produtos: 1, vitrine_ofertas: false, vitrine_mais_lucrativos: false }, admin);
  // Sem nenhuma foto, entra o primeiro do ranking (para a vitrine não ficar vazia).
  assert.deepEqual((await app.get('/vitrine')).dados.slides.map((s) => s.nome), ['Arroz 5 kg']);
  assert.equal((await app.get('/vitrine/gestao/resumo', admin)).dados.sem_foto.vendidos, 1);
  // Com foto, o sabão (último do ranking) passa à frente de quem não tem.
  await app.enviarArquivo(`/produtos/${sabao.id}/foto`, PNG, 'image/png', admin);
  assert.deepEqual((await app.get('/vitrine')).dados.slides.map((s) => s.nome), ['Sabão']);
});

test('vitrine: envio de vídeo e imagem, validação, ordem e quem pode mexer', async (t) => {
  const { app, admin } = await preparar(t);

  // Gestão exige login de gerente ou admin.
  assert.equal((await app.get('/vitrine/gestao/midias')).status, 401);
  const caixa = (await app.criarUsuario(admin, { nome: 'Caixa', email: 'caixa.vitrine@teste.com', perfil: 'caixa' })).token;
  assert.equal((await app.enviarArquivo('/vitrine/gestao/midias', MP4, 'video/mp4', caixa)).status, 403);

  // Arquivo que não é vídeo, mesmo dizendo que é, não entra.
  const falso = await app.enviarArquivo('/vitrine/gestao/midias', Buffer.from('isto nao e um video de verdade'), 'video/mp4', admin);
  assert.equal(falso.status, 422);

  const video = await app.enviarArquivo('/vitrine/gestao/midias?titulo=Promo', MP4, 'video/mp4', admin);
  assert.equal(video.status, 201);
  assert.equal(video.dados.tipo, 'video');
  assert.match(video.dados.arquivo, /^video-[0-9a-f]{12}\.mp4$/);
  const imagem = await app.enviarArquivo('/vitrine/gestao/midias?titulo=Aviso&duracao=7', PNG, 'image/png', admin);
  assert.equal(imagem.dados.tipo, 'imagem');
  assert.equal(imagem.dados.duracao_seg, 7);

  // Servido sem login, para a TV.
  const baixado = await fetch(`${app.raiz}/vitrine-midia/${video.dados.arquivo}`);
  assert.equal(baixado.status, 200);
  assert.equal(baixado.headers.get('content-type'), 'video/mp4');

  // Entra na sequência pública, na ordem definida.
  await app.post('/vitrine/gestao/midias/ordem', { ids: [imagem.dados.id, video.dados.id] }, admin);
  const midias = (await app.get('/vitrine')).dados.slides.filter((s) => s.tipo !== 'produto');
  assert.deepEqual(midias.map((m) => m.tipo), ['imagem', 'video']);

  // Pausar tira da sequência sem apagar.
  await app.patch(`/vitrine/gestao/midias/${imagem.dados.id}`, { ativa: false }, admin);
  assert.ok((await app.get('/vitrine')).dados.slides.every((s) => s.arquivo !== imagem.dados.arquivo));

  // Apagar remove o arquivo do disco.
  const arquivo = require('../server/lib/vitrine').caminho(video.dados.arquivo);
  assert.equal(fs.existsSync(arquivo), true);
  assert.equal((await app.del(`/vitrine/gestao/midias/${video.dados.id}`, admin)).status, 204);
  assert.equal(fs.existsSync(arquivo), false);
});

test('vitrine: as artes aprovadas entram uma vez só, com duração de 12 s', async (t) => {
  const { app } = await preparar(t);
  const vitrine = require('../server/lib/vitrine');
  assert.equal(vitrine.semearArtesIniciais(app.db), 3);
  const midias = vitrine.listarMidias(app.db);
  assert.deepEqual(midias.map((m) => m.titulo), ['Seu mercado, pertinho de você', 'Bateu a fome? Seu lanche está aqui', 'Faltou em casa? Os essenciais estão aqui']);
  assert.ok(midias.every((m) => m.tipo === 'imagem' && m.duracao_seg === 12));
  // Rodar de novo (servidor reiniciado) não duplica…
  assert.equal(vitrine.semearArtesIniciais(app.db), 0);
  // …e se a administração apagar uma, ela não volta sozinha.
  vitrine.apagarMidia(app.db, midias[0].id);
  assert.equal(vitrine.semearArtesIniciais(app.db), 0);
  assert.equal(vitrine.listarMidias(app.db).length, 2);

  // Cada quadro leva a duração: é com ela que várias TVs se alinham pelo relógio.
  const { slides, sincronizar } = (await app.get('/vitrine')).dados;
  assert.equal(sincronizar, true);
  assert.ok(slides.every((s) => s.duracao_ms >= 3000));
  // As artes ficam espalhadas, começando por uma delas.
  assert.equal(slides[0].tipo, 'imagem');
});

test('vitrine: vídeo guarda a duração real lida no envio', async (t) => {
  const { app, admin } = await preparar(t);
  const r = await app.enviarArquivo('/vitrine/gestao/midias?titulo=Comercial&duracao_video=15.4', MP4, 'video/mp4', admin);
  assert.equal(r.status, 201);
  assert.equal(r.dados.duracao_video_ms, 15400);
  const video = (await app.get('/vitrine')).dados.slides.find((s) => s.tipo === 'video');
  assert.equal(video.duracao_ms, 15400);
});
