'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Coisas do painel que só aparecem no navegador e que já quebraram uma vez em produção.
 * O pareamento da TV ficou sem funcionar porque o campo do código não tinha nome: o formulário
 * mandava o código vazio e o servidor respondia "não encontrado" até para o código certo.
 */
test('Painel: o formulário de pareamento manda o código digitado', () => {
  const rede = fs.readFileSync(path.join(__dirname, '..', 'public/js/rede.js'), 'utf8');
  const campo = rede.match(/el\('input', \{[^}]*class: 'codigo-pareamento'[^}]*\}/s)?.[0] ?? '';
  assert.ok(campo, 'o campo do código existe');
  assert.match(campo, /name: 'codigo'/, 'sem nome, o código não vai junto no envio');

  const css = fs.readFileSync(path.join(__dirname, '..', 'public/css/midia.css'), 'utf8');
  assert.match(css, /\[hidden\]\{ display: none !important; \}/, 'campo escondido tem de ficar escondido');
});

test('Painel: criativos sobem vários de uma vez', () => {
  const comercial = fs.readFileSync(path.join(__dirname, '..', 'public/js/comercial.js'), 'utf8');
  const envio = comercial.slice(comercial.indexOf('function enviarCriativo'), comercial.indexOf('// ----', comercial.indexOf('function enviarCriativo')));
  assert.match(envio, /type: 'file', name: 'arquivo', multiple: true/, 'o seletor de arquivo aceita vários');
  assert.match(envio, /for \(const \[i, alvo\] of arquivos\.entries\(\)\)/, 'cada arquivo vira um criativo');
  assert.match(envio, /name: 'aprovar', checked: true/, 'a equipe pode aprovar já ao enviar');
  assert.match(envio, /'Escolha o anunciante…'/, 'o anunciante é escolhido de propósito, não por acaso');
});

/**
 * A campanha "no ar" que não passava: só no sábado num domingo, e com criativo sem aprovar.
 * O painel tem de dizer o motivo em português, com as mesmas regras que montam o loop da TV.
 */
test('Campanha: o painel diz por que não está passando agora', async (t) => {
  const { iniciar, png, limparArquivos } = require('./helpers');
  const grade = require('../server/lib/grade');
  const { local } = require('../server/lib/datas');
  const api = await iniciar();
  t.after(() => { api.fechar(); limparArquivos(); });
  const master = await api.login();

  const ponto = (await api.post('/painel/locais', { nome: 'Casa', categoria: 'outro', cidade: 'São Paulo', uf: 'SP', publico_dia: 50 }, master)).dados.id;
  const tela = (await api.post('/painel/telas', { local_id: ponto, nome: 'Sala' }, master)).dados.id;
  api.db.prepare("UPDATE telas SET pareada_em = ? WHERE id = ?").run(new Date().toISOString(), tela);
  const anunciante = (await api.post('/painel/anunciantes', { nome: 'Teste' }, master)).dados.id;
  const midia = (await api.enviarArquivo(`/painel/midias?nome=Peca&uso=campanha&anunciante_id=${anunciante}`, png(1920, 1080), master)).dados.id;

  const hoje = local().diaSemana;
  const outroDia = (hoje + 1) % 7;
  const criada = await api.post('/painel/campanhas', {
    anunciante_id: anunciante, nome: 'Só num dia', inicio: local().data, cobranca: 'cortesia', insercoes_hora: 10,
    dias_semana: String(outroDia), hora_inicio: '00:00', hora_fim: '00:00',
    criativos: [{ midia_id: midia }], alvos: [{ tipo: 'tela', valor: String(tela) }],
  }, master);
  assert.equal(criada.status, 201, JSON.stringify(criada.dados));
  const c = criada.dados;
  api.db.prepare("UPDATE campanhas SET status = 'ativa' WHERE id = ?").run(c.id);

  let d = (await api.get(`/painel/campanhas/${c.id}`, master)).dados;
  assert.equal(d.agora.passando, false);
  assert.ok(d.agora.motivos.some((m) => /só passa/.test(m)), 'diz que hoje não é o dia da campanha');
  assert.ok(d.agora.motivos.some((m) => /aguardando aprovação/.test(m)), 'diz que o criativo está sem aprovar');

  // Corrigido o dia e aprovado o criativo, a campanha passa — e o loop da TV concorda.
  api.db.prepare("UPDATE campanhas SET dias_semana = '0123456', hora_inicio = '00:00', hora_fim = '00:00' WHERE id = ?").run(c.id);
  await api.post(`/painel/midias/${midia}/aprovacao`, { decisao: 'aprovar' }, master);
  d = (await api.get(`/painel/campanhas/${c.id}`, master)).dados;
  assert.equal(d.agora.passando, true, JSON.stringify(d.agora.motivos));
  const loop = JSON.stringify(grade.montarPorTela(api.db, tela));
  assert.ok(loop.includes(`"campanha_id":${c.id}`) || loop.includes('Só num dia'), 'a campanha entrou no loop da TV');
});

/**
 * Atualizar o sistema pelo painel (pelo celular): só o master, com a senha digitada de novo, e só um
 * .zip. O painel não troca nada sozinho — deixa o pacote e o pedido para o serviço do servidor.
 */
test('Atualização pelo painel: pede a senha, aceita só zip e deixa o pedido para o servidor', async (t) => {
  const os = require('node:os');
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'midia-atualizacao-'));
  process.env.MIDIA_ATUALIZACAO = pasta;
  const { iniciar, limparArquivos } = require('./helpers');
  const api = await iniciar();
  t.after(() => { api.fechar(); limparArquivos(); delete process.env.MIDIA_ATUALIZACAO; fs.rmSync(pasta, { recursive: true, force: true }); });
  const master = await api.login();
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 1)]);
  const enviar = (corpo, senha, tk = master) => fetch(`${api.base}/painel/sistema/atualizacao`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/zip', 'X-Confirmar-Senha': encodeURIComponent(senha) },
    body: corpo,
  });

  assert.equal((await enviar(zip, 'senha-errada')).status, 403, 'sem a senha certa, nada acontece');
  assert.ok(!fs.existsSync(path.join(pasta, 'pedido')));
  assert.equal((await enviar(Buffer.from('não sou zip'), 'master123')).status, 422, 'só aceita .zip');

  const r = await enviar(zip, 'master123');
  assert.equal(r.status, 202);
  assert.ok(fs.existsSync(path.join(pasta, 'pacote.zip')), 'o pacote fica para o servidor');
  assert.equal(JSON.parse(fs.readFileSync(path.join(pasta, 'pedido'), 'utf8')).por, 'master@midia.com.br');
  assert.equal((await enviar(zip, 'master123')).status, 409, 'uma atualização por vez');

  const s = (await api.get('/painel/sistema/atualizacao', master)).dados;
  assert.equal(s.esperando, true);
  assert.equal(s.sem_resposta, false);

  // O servidor terminou: o painel mostra o resultado.
  fs.rmSync(path.join(pasta, 'pedido'));
  fs.writeFileSync(path.join(pasta, 'estado.json'), JSON.stringify({ etapa: 'concluida', mensagem: 'Sistema atualizado.', atualizado_em: new Date().toISOString() }));
  const fim = (await api.get('/painel/sistema/atualizacao', master)).dados;
  assert.equal(fim.estado.etapa, 'concluida');
  assert.equal(fim.esperando, false);

  // Quem não é master nem vê.
  await api.post('/painel/usuarios', { nome: 'Op', email: 'op@midia.com.br', perfil: 'operador', senha: 'operador-123' }, master);
  const op = await api.login('op@midia.com.br', 'operador-123');
  assert.equal((await api.get('/painel/sistema/atualizacao', op)).status, 403);
  assert.equal((await enviar(zip, 'operador-123', op)).status, 403);
});

/** Adicionado à tela inicial do celular, o painel aparece com o ícone colorido da marca. */
test('Painel: ícone colorido ao instalar no celular', () => {
  const raiz = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
  assert.match(html, /rel="apple-touch-icon" href="img\/apple-touch-icon.png"/, 'o iPhone usa o apple-touch-icon');
  assert.match(html, /rel="manifest" href="manifest.webmanifest"/);
  const manifesto = JSON.parse(fs.readFileSync(path.join(raiz, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifesto.display, 'standalone');
  for (const i of manifesto.icons) {
    const png = fs.readFileSync(path.join(raiz, i.src));
    assert.equal(png.readUInt32BE(0), 0x89504e47, `${i.src} é PNG`);
    assert.equal(png.readUInt32BE(16), Number(i.sizes.split('x')[0]), `${i.src} tem o tamanho declarado`);
  }
});

/**
 * Comunicado sempre com imagem: o ponto anexa uma foto que cobre o espaço do recado na TV. A foto só
 * sai para as TVs daquele ponto, e trocar a foto muda a versão da programação (a TV baixa de novo).
 */
test('Comunicado: foto anexada chega à TV do ponto e só a ela', async (t) => {
  const { iniciar, png, limparArquivos } = require('./helpers');
  const api = await iniciar();
  t.after(() => { api.fechar(); limparArquivos(); });
  const master = await api.login();
  const novoPonto = async (nome) => (await api.post('/painel/locais', { nome, categoria: 'condominio_residencial', cidade: 'Campinas', uf: 'SP', publico_dia: 100 }, master)).dados.id;
  const predio = await novoPonto('Edifício Foto');
  const outro = await novoPonto('Edifício Vizinho');
  const parear = async (local) => {
    const tv = api.aparelho();
    const reg = await tv.registrar({ aparelho: 'TV', largura: 1080, altura: 1920, versao: '1.2' });
    const p = await api.post('/painel/telas/parear', { codigo: reg.dados.codigo, local_id: local, nome: 'Elevador' }, master);
    await api.patch(`/painel/telas/${p.dados.id}`, { layout: 'dividida' }, master);
    tv.usar((await tv.pareamento(reg.dados.codigo)).dados.token);
    return tv;
  };
  const tvPredio = await parear(predio);
  const tvVizinho = await parear(outro);

  const hoje = new Date().toLocaleDateString('en-CA');
  const c = (await api.post('/painel/comunicados', { local_id: predio, titulo: 'Assembleia', texto: 'Às 19h no salão.', tipo: 'assembleia', inicio: hoje, fim: hoje }, master)).dados;
  const antes = (await tvPredio.programacao()).dados.grade;
  assert.equal(antes.comunicados[0].imagem, false, 'sem foto, a TV desenha a ilustração do tipo');

  assert.equal((await api.enviarArquivo(`/painel/comunicados/${c.id}/imagem`, Buffer.from('não é imagem'), master)).status, 415);
  assert.equal((await api.enviarArquivo(`/painel/comunicados/${c.id}/imagem`, png(1200, 800), master)).status, 201);

  const depois = (await tvPredio.programacao()).dados.grade;
  assert.equal(depois.comunicados[0].imagem, true);
  assert.notEqual(depois.versao, antes.versao, 'trocar a foto faz a TV baixar a programação de novo');

  const foto = await fetch(`${api.base}/player/comunicados/${c.id}/imagem`, { headers: { Authorization: `Bearer ${tvPredio.token}` } });
  assert.equal(foto.status, 200);
  assert.equal(foto.headers.get('content-type'), 'image/png');
  const alheia = await fetch(`${api.base}/player/comunicados/${c.id}/imagem`, { headers: { Authorization: `Bearer ${tvVizinho.token}` } });
  assert.equal(alheia.status, 404, 'a foto de um prédio não sai na TV do vizinho');

  assert.equal((await api.del(`/painel/comunicados/${c.id}/imagem`, undefined, master)).status, 204);
  assert.equal((await tvPredio.programacao()).dados.grade.comunicados[0].imagem, false);

  // O layout dividido é meio a meio e o anúncio cobre a metade dele.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public/tv/tv.css'), 'utf8');
  assert.match(css, /body\.dividida \.palco\{ grid-template-columns: 1fr 1fr;/);
  assert.match(css, /body\.dividida \.zona-anuncio \.camada img:not\(\.fundo\), body\.dividida \.zona-anuncio \.camada video\{ object-fit: cover; \}/);
});

/** Administrador: faz tudo o que o master faz, menos atualizar o sistema e mexer no backup — e não vira master. */
test('Perfil administrador: tudo menos a aba Sistema, sem poder se promover', async (t) => {
  const { iniciar, limparArquivos } = require('./helpers');
  const api = await iniciar();
  t.after(() => { api.fechar(); limparArquivos(); });
  const master = await api.login();
  const criado = await api.post('/painel/usuarios', { nome: 'Robson', email: 'robson@vaimidia.com.br', senha: 'robson-2026', perfil: 'administrador' }, master);
  assert.equal(criado.status, 201, JSON.stringify(criado.dados));
  const adm = await api.login('robson@vaimidia.com.br', 'robson-2026');

  assert.equal((await api.get('/painel/configuracoes', adm)).status, 200, 'mexe nas configurações');
  // As configurações valem para a rede inteira (todas as empresas): só o master altera.
  assert.equal((await api.put('/painel/configuracoes', { cpm_centavos: 3000 }, adm)).status, 403, 'não mexe nas regras da rede');
  assert.equal((await api.get('/painel/usuarios', adm)).status, 200, 'cuida da equipe');
  assert.equal((await api.post('/painel/usuarios', { nome: 'Op', email: 'op2@vaimidia.com.br', senha: 'operador-2026', perfil: 'operador' }, adm)).status, 201);

  assert.equal((await api.get('/painel/sistema/atualizacao', adm)).status, 403, 'não atualiza o sistema');
  assert.equal((await api.get('/painel/backups', adm)).status, 403, 'não mexe no backup');
  assert.equal((await api.post('/painel/usuarios', { nome: 'X', email: 'x@vaimidia.com.br', senha: 'xxxxxxxx-1', perfil: 'master' }, adm)).status, 403, 'não cria master');
  assert.equal((await api.patch(`/painel/usuarios/${criado.dados.id}`, { perfil: 'master' }, adm)).status, 403, 'não se promove');
  const mestre = (await api.get('/painel/usuarios', master)).dados.itens.find((u) => u.perfil === 'master');
  assert.equal((await api.patch(`/painel/usuarios/${mestre.id}`, { ativo: false }, adm)).status, 403, 'não desativa o master');
});

/** Corrigir o e-mail de um usuário: a pessoa passa a entrar com o e-mail novo, com a mesma senha. */
test('Usuários: editar nome e e-mail', async (t) => {
  const { iniciar, limparArquivos } = require('./helpers');
  const api = await iniciar();
  t.after(() => { api.fechar(); limparArquivos(); });
  const master = await api.login();
  const u = (await api.post('/painel/usuarios', { nome: 'Robson', email: 'robson@vimidia.com.br', senha: 'robson-2026', perfil: 'administrador' }, master)).dados;
  const r = await api.patch(`/painel/usuarios/${u.id}`, { nome: 'Robson Silva', email: 'robson@vaimidia.com.br' }, master);
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  assert.equal(r.dados.email, 'robson@vaimidia.com.br');
  assert.ok(await api.login('robson@vaimidia.com.br', 'robson-2026'), 'entra com o e-mail novo e a senha de antes');
  assert.equal((await api.patch(`/painel/usuarios/${u.id}`, { email: 'master@midia.com.br' }, master)).status, 409, 'e-mail de outra pessoa não pode');
});

/** O player abre sem internet: a página fica guardada na TV (service worker) e o aviso não aparece na tela. */
test('Player: guarda a página na TV e não avisa "sem internet" na tela', () => {
  const tv = (f) => fs.readFileSync(path.join(__dirname, '..', 'public/tv', f), 'utf8');
  assert.match(tv('player.js'), /serviceWorker\.register\('sw\.js'/);
  assert.match(tv('sw.js'), /cache\.put\(`\$\{BASE\}\/tv\/`/, 'a página é guardada já na instalação');
  assert.ok(!tv('index.html').includes('sem-conexao'), 'sem aviso de internet em cima do anúncio');
});
