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
