'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, empresaDeTeste } = require('./helpers');
const { ixcFalso } = require('./ixc-falso');

const hoje = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

/** Chamadas da tela do cliente, com a chave do PDV. */
const tela = (app, chave) => ({
  get: (c) => app.req('GET', `/autoatendimento${c}`, undefined, null, { 'X-Api-Key': chave }),
  post: (c, b) => app.req('POST', `/autoatendimento${c}`, b ?? {}, null, { 'X-Api-Key': chave }),
});

test('Tela do cliente: o cliente digita o CPF, paga no cartão e a fatura é baixada no IXC', async (t) => {
  const ixc = await ixcFalso();
  const app = await iniciar();
  const e = await empresaDeTeste(app, { ixcUrl: ixc.url, ixcToken: ixc.token });
  t.after(async () => { await app.fechar(); await ixc.fechar(); });

  let chave;
  await t.test('o administrador liga a tela e recebe a chave', async () => {
    assert.equal((await app.post(`/empresas/${e.eid}/cadastros/pdvs/${e.pdv.id}/autoatendimento`, {}, e.operador)).status, 403);
    const r = await app.post(`/empresas/${e.eid}/cadastros/pdvs/${e.pdv.id}/autoatendimento`, {}, e.admin);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.match(r.dados.chave, /^pdv_[0-9a-f]{8}_/);
    chave = r.dados.chave;

    const pdvs = (await app.get(`/empresas/${e.eid}/cadastros/pdvs`, e.admin)).dados.itens;
    assert.equal(pdvs.find((p) => p.id === e.pdv.id).autoatendimento, 1);
  });

  await t.test('sem chave a tela não abre', async () => {
    assert.equal((await tela(app, 'pdv_00000000_xxxxxxxxxxxxxxxxxxxxxxxx').get('/')).status, 401);
    assert.equal((await app.get('/autoatendimento/')).status, 401);
  });

  await t.test('a tela abre com a marca, a loja e a maquininha do PDV', async () => {
    const r = await tela(app, chave).get('/');
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.empresa.nome, 'Provedor Teste');
    assert.equal(r.dados.pdv.nome, e.pdv.nome);
    assert.equal(r.dados.logo_url, 'img/logo-cliente.png', 'o logo tem um padrão, mesmo sem configurar');
    assert.equal(r.dados.maquininha.id, e.maquininha.id);
    assert.deepEqual(r.dados.formas, ['debito', 'credito', 'pix']);
    assert.equal(r.dados.ixc_pronto, true);
  });

  await t.test('o logo e o recado da empresa aparecem na tela', async () => {
    await app.patch(`/empresas/${e.eid}/configuracoes`, { logo_url: 'img/logo-cliente.png', autoatendimento_mensagem: 'Pague aqui com cartão.' }, e.admin);
    const r = await tela(app, chave).get('/');
    assert.equal(r.dados.mensagem, 'Pague aqui com cartão.');
    const ruim = await app.patch(`/empresas/${e.eid}/configuracoes`, { logo_url: 'javascript:alert(1)' }, e.admin);
    assert.equal(ruim.status, 422, 'endereço de logo inseguro é recusado');
  });

  let faturas;
  await t.test('o CPF mostra as faturas com o nome escondido em parte', async () => {
    const invalido = await tela(app, chave).post('/faturas', { documento: '12345678900' });
    assert.equal(invalido.status, 422);

    const semCadastro = await tela(app, chave).post('/faturas', { documento: '390.533.447-05' });
    assert.equal(semCadastro.status, 200);
    assert.equal(semCadastro.dados.encontrado, false);

    const r = await tela(app, chave).post('/faturas', { documento: '529.982.247-25' });
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.encontrado, true);
    assert.match(r.dados.cliente.nome, /^MARIA \*|^MARIA D/, 'o nome vem parcialmente escondido');
    assert.ok(r.dados.cliente.nome.includes('*'), 'sobrenome escondido');
    assert.match(r.dados.cliente.documento, /^529\*+25$/);
    assert.equal(r.dados.faturas.length, 2);
    const vencida = r.dados.faturas.find((f) => f.id === '900');
    assert.ok(vencida.dias_atraso > 0 && vencida.acrescimo_centavos > 0, 'a vencida vem com multa e juros');
    faturas = r.dados.faturas;
  });

  let cobranca;
  await t.test('a tela manda a maquininha cobrar o total escolhido', async () => {
    const total = faturas.reduce((s, f) => s + f.total_centavos, 0);
    const r = await tela(app, chave).post('/cobrancas', { forma: 'credito', valor_centavos: total, parcelas: 2 });
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    assert.equal(r.dados.status, 'pendente');
    cobranca = r.dados;

    const naMaquininha = await app.terminal(e.maquininha.chave).get('/terminal/cobranca');
    assert.equal(naMaquininha.dados.referencia, cobranca.referencia);
  });

  await t.test('sem aprovação da maquininha o recebimento não é gravado', async () => {
    const r = await tela(app, chave).post('/recebimentos', { transacao_id: cobranca.id, cliente_ixc_id: '10', faturas: faturas.map((f) => f.id) });
    assert.equal(r.status, 409);
    assert.match(r.dados.erro, /não foi aprovado/);
  });

  let recibo;
  await t.test('cartão aprovado: recibo na tela e faturas baixadas no IXC', async () => {
    await app.terminal(e.maquininha.chave).post('/terminal/resultado',
      { referencia: cobranca.referencia, status: 'aprovada', nsu: '909090', autorizacao: '112233', bandeira: 'MASTERCARD', cartao_final: '7788' });

    const r = await tela(app, chave).post('/recebimentos', { transacao_id: cobranca.id, cliente_ixc_id: '10', faturas: faturas.map((f) => f.id) });
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    recibo = r.dados;
    assert.equal(recibo.titulos.length, 2);
    assert.equal(recibo.pagamento[0].nsu, '909090');
    assert.match(recibo.comprovante, /RECIBO DE PAGAMENTO/);
    assert.ok(recibo.cliente_nome.includes('*'), 'o comprovante da tela também esconde parte do nome');
    assert.equal(ixc.estado.faturas.find((f) => f.id === '900').status, 'R');
    assert.equal(ixc.estado.faturas.find((f) => f.id === '901').status, 'R');
  });

  await t.test('o recebimento entra na conferência como "tela do cliente", sem caixa', async () => {
    const lista = await app.get(`/empresas/${e.eid}/recebimentos?origem=autoatendimento`, e.supervisor);
    assert.equal(lista.status, 200, JSON.stringify(lista.dados));
    assert.equal(lista.dados.itens.length, 1);
    const x = lista.dados.itens[0];
    assert.equal(x.numero, recibo.numero);
    assert.equal(x.origem, 'autoatendimento');
    assert.equal(x.caixa_id, null, 'a tela do cliente não mexe no caixa do balcão');
    assert.match(x.operador_nome, /^Autoatendimento/);

    const resumo = await app.get(`/empresas/${e.eid}/conferencia?de=${hoje()}&ate=${hoje()}`, e.supervisor);
    assert.equal(resumo.dados.totais.baixados_centavos, recibo.valor_centavos);
    assert.equal(resumo.dados.totais.a_confirmar_centavos, 0);
  });

  await t.test('fatura já paga não aparece de novo para o cliente', async () => {
    const r = await tela(app, chave).post('/faturas', { documento: '529.982.247-25' });
    assert.equal(r.dados.faturas.length, 0, 'as duas faturas pagas saem da lista');
  });

  await t.test('a tela não tem acesso ao painel nem a outras empresas', async () => {
    assert.equal((await app.req('GET', `/empresas/${e.eid}/recebimentos`, undefined, null, { 'X-Api-Key': chave })).status, 401);
    assert.equal((await app.req('GET', '/master/empresas', undefined, null, { 'X-Api-Key': chave })).status, 401);
  });

  await t.test('desligar a tela derruba a chave na hora', async () => {
    const r = await app.del(`/empresas/${e.eid}/cadastros/pdvs/${e.pdv.id}/autoatendimento`, undefined, e.admin);
    assert.equal(r.status, 200);
    assert.equal((await tela(app, chave).get('/')).status, 401);
  });
});

test('Tela do cliente: sem maquininha ela só consulta', async (t) => {
  const ixc = await ixcFalso();
  const app = await iniciar();
  const e = await empresaDeTeste(app, { ixcUrl: ixc.url, ixcToken: ixc.token, terminal: false });
  t.after(async () => { await app.fechar(); await ixc.fechar(); });
  const { chave } = (await app.post(`/empresas/${e.eid}/cadastros/pdvs/${e.pdv.id}/autoatendimento`, {}, e.admin)).dados;

  const abertura = await tela(app, chave).get('/');
  assert.deepEqual(abertura.dados.formas, []);
  assert.equal(abertura.dados.maquininha, null);

  const consulta = await tela(app, chave).post('/faturas', { documento: '111.444.777-35' });
  assert.equal(consulta.dados.encontrado, true);
  assert.equal(consulta.dados.faturas.length, 1);

  const cobranca = await tela(app, chave).post('/cobrancas', { forma: 'debito', valor_centavos: 15000 });
  assert.equal(cobranca.status, 409);
  assert.match(cobranca.dados.erro, /maquininha/i);
});

test('Tela do cliente: propaganda de fundo enviada pelo painel', async (t) => {
  const ixc = await ixcFalso();
  const app = await iniciar();
  const e = await empresaDeTeste(app, { ixcUrl: ixc.url, ixcToken: ixc.token, terminal: false });
  t.after(async () => { await app.fechar(); await ixc.fechar(); });
  const { chave } = (await app.post(`/empresas/${e.eid}/cadastros/pdvs/${e.pdv.id}/autoatendimento`, {}, e.admin)).dados;

  // PNG 1×1 de verdade (o servidor confere o começo do arquivo).
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const enviar = (tipo, corpo, tipoConteudo, token) => fetch(`${app.base}/empresas/${e.eid}/configuracoes/imagens/${tipo}`, {
    method: 'POST', headers: { 'Content-Type': tipoConteudo, Authorization: `Bearer ${token}` }, body: corpo,
  });

  await t.test('só o administrador envia, e só imagem de verdade', async () => {
    assert.equal((await enviar('fundo', png, 'image/png', e.operador)).status, 403);
    assert.equal((await enviar('fundo', Buffer.from('<svg onload=alert(1)>'), 'image/png', e.admin)).status, 422);
    assert.equal((await enviar('maluco', png, 'image/png', e.admin)).status, 422);
  });

  let url;
  await t.test('a arte enviada vira o fundo da tela e fica servida pelo PDV', async () => {
    const r = await enviar('fundo', png, 'image/png', e.admin);
    assert.equal(r.status, 201);
    ({ url } = await r.json());
    assert.match(url, new RegExp(`^arquivos/empresa${e.eid}/fundo-[0-9a-f]{16}\\.png$`));

    const abertura = await app.req('GET', '/autoatendimento/', undefined, null, { 'X-Api-Key': chave });
    assert.equal(abertura.dados.fundo_url, url);

    const imagem = await fetch(`${app.base.replace(/\/api$/, '')}/${url}`);
    assert.equal(imagem.status, 200);
    assert.equal(imagem.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await imagem.arrayBuffer()).length, png.length);
  });

  await t.test('enviar outra arte troca a anterior', async () => {
    const r = await enviar('fundo', png, 'image/png', e.admin);
    const { url: nova } = await r.json();
    assert.notEqual(nova, url);
    const c = await app.get(`/empresas/${e.eid}/configuracoes`, e.admin);
    assert.equal(c.dados.autoatendimento_fundo, nova);
    assert.equal((await fetch(`${app.base.replace(/\/api$/, '')}/${url}`)).status, 404, 'a anterior é apagada do servidor');
  });

  await t.test('sem arte, a tela volta ao fundo do sistema', async () => {
    await app.patch(`/empresas/${e.eid}/configuracoes`, { autoatendimento_fundo: '' }, e.admin);
    const abertura = await app.req('GET', '/autoatendimento/', undefined, null, { 'X-Api-Key': chave });
    assert.equal(abertura.dados.fundo_url, null);
  });
});
