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
