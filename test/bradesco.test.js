'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { iniciar } = require('./helpers');
const { crc16, gerarBrCode } = require('../server/integracoes/bradesco/brcode');
const { decimalParaCentavos } = require('../server/integracoes/bradesco/util');
const { ApiBradesco } = require('../server/integracoes/bradesco/api');
const { normalizarChaveExterna } = require('../server/integracoes/bradesco');

test('BR Code: CRC16 confere com o exemplo do manual do Banco Central', () => {
  const exemplo = '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***6304';
  assert.equal(crc16(exemplo), '1D3D');
  const code = gerarBrCode({ location: 'pix.exemplo.com/qr/v2/abc', nome: 'Pay Áx', cidade: 'São Paulo', valorCentavos: 12345 });
  assert.match(code, /5406123\.45/);
  assert.match(code, /5906PAY AX/);
  assert.equal(code.slice(-4), crc16(code.slice(0, -4)));
});

test('conversões e chaves externas', () => {
  assert.equal(decimalParaCentavos('123.4'), 12340);
  assert.equal(decimalParaCentavos('0.07'), 7);
  assert.throws(() => decimalParaCentavos('1,00'));
  assert.equal(normalizarChaveExterna('Fulano@Banco.com'), 'fulano@banco.com');
  assert.equal(normalizarChaveExterna('529.982.247-25'), '52998224725');
  assert.equal(normalizarChaveExterna('(11) 3322-4455'), '+551133224455');
  assert.equal(normalizarChaveExterna('xyz'), null);
});

test('Integração Bradesco (simulador)', async (t) => {
  const api = await iniciar();
  t.after(api.fechar);
  const cli = await api.post('/clientes', { tipo: 'PF', nome: 'Maria Teste', documento: '529.982.247-25' });
  const conta = (await api.post('/contas', { cliente_id: cli.dados.id, tipo: 'corrente' })).dados;
  let cobranca;

  await t.test('gera cobrança PIX com BR Code e QR Code', async () => {
    const r = await api.post('/integracoes/bradesco/cobrancas', { conta_id: conta.id, valor_centavos: 25000 });
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    assert.match(r.dados.txid, /^[A-Za-z0-9]{26,35}$/);
    assert.match(r.dados.pix_copia_e_cola, /^000201/);
    assert.match(r.dados.qr_svg, /^<svg/);
    assert.equal(r.dados.status, 'ativa');
    cobranca = r.dados;
  });

  await t.test('pagamento credita a conta uma única vez', async () => {
    const r = await api.post(`/integracoes/bradesco/cobrancas/${cobranca.txid}/simular-pagamento`);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.creditados, 1);
    assert.equal((await api.get(`/contas/${conta.id}`)).dados.saldo_centavos, 25000);
    assert.equal((await api.get(`/integracoes/bradesco/cobrancas/${cobranca.txid}`)).dados.status, 'concluida');
    const sync = await api.post('/integracoes/bradesco/sincronizar');
    assert.equal(sync.dados.duplicados, 1);
    assert.equal((await api.get(`/contas/${conta.id}`)).dados.saldo_centavos, 25000);
  });

  await t.test('webhook: PIX sem cobrança fica pendente e o gerente vincula', async () => {
    const w = await api.post('/integracoes/bradesco/simular-pix-avulso', { valor_centavos: 1050 });
    assert.equal(w.status, 200, JSON.stringify(w.dados));
    assert.equal(w.dados.sem_vinculo, 1);
    // O banco pode reenviar o mesmo webhook: não deve creditar de novo.
    const e2e = (await api.get('/integracoes/bradesco/conciliacao')).dados.sem_vinculo[0].end_to_end_id;
    const reenvio = await api.post('/integracoes/bradesco/webhook/pix', { pix: [{ endToEndId: e2e, valor: '10.50' }] }, null);
    assert.equal(reenvio.dados.duplicados, 1);
    assert.equal((await api.post('/integracoes/bradesco/webhook/pix', { errado: true }, null)).status, 400);
    const conc = await api.get('/integracoes/bradesco/conciliacao');
    assert.equal(conc.dados.sem_vinculo.length, 1);
    const v = await api.post(`/integracoes/bradesco/recebidos/${conc.dados.sem_vinculo[0].id}/vincular`, { conta_id: conta.id });
    assert.equal(v.status, 200);
    assert.equal((await api.get(`/contas/${conta.id}`)).dados.saldo_centavos, 26050);
  });

  await t.test('PIX para outro banco sai pelo Bradesco; falha devolve o valor', async () => {
    const ok = await api.post('/operacoes/pix', { origem_conta_id: conta.id, chave: 'loja@outrobanco.com', valor_centavos: 5000 });
    assert.equal(ok.status, 201, JSON.stringify(ok.dados));
    assert.equal(ok.dados.externo, true);
    assert.match(ok.dados.end_to_end_id, /^E60746948/);
    assert.equal((await api.get(`/contas/${conta.id}`)).dados.saldo_centavos, 21050);
    // Conta com limite alto, mas sem dinheiro suficiente na conta PAY AX do Bradesco.
    await api.patch(`/contas/${conta.id}/limite`, { limite_centavos: 10_000_000 });
    const falha = await api.post('/operacoes/pix', { origem_conta_id: conta.id, chave: 'loja@outrobanco.com', valor_centavos: 5_000_000 });
    assert.equal(falha.status, 502);
    assert.match(falha.dados.erro, /voltou para a conta/);
    assert.equal((await api.get(`/contas/${conta.id}`)).dados.saldo_centavos, 21050);
    const ext = await api.get(`/contas/${conta.id}/extrato`);
    const enviado = ext.dados.itens.find((x) => x.tipo === 'pix_enviado' && !x.estornada_em);
    assert.equal((await api.post('/operacoes/estorno', { transacao_id: enviado.id, motivo: 'x' })).status, 409);
  });

  await t.test('conciliação fecha: saldo Bradesco = saldo dos clientes', async () => {
    const c = (await api.get('/integracoes/bradesco/conciliacao')).dados;
    assert.equal(c.modo, 'simulador');
    assert.equal(c.saldo_bradesco_centavos, 21050);
    assert.equal(c.clientes_total_centavos, 21050);
    assert.equal(c.diferenca_centavos, 0);
    assert.ok(c.extrato.every((m) => m.conciliado));
  });

  await t.test('webhook exige o token quando configurado', async () => {
    const config = require('../server/config');
    config.bradesco.webhookToken = 'token-secreto';
    try {
      assert.equal((await api.post('/integracoes/bradesco/webhook/pix', { pix: [] }, null)).status, 401);
      assert.equal((await api.post('/integracoes/bradesco/webhook/pix?token=errado', { pix: [] }, null)).status, 401);
      assert.equal((await api.post('/integracoes/bradesco/webhook/pix?token=token-secreto', { pix: [] }, null)).status, 200);
    } finally {
      config.bradesco.webhookToken = '';
    }
  });

  await t.test('operador não acessa conciliação', async () => {
    await api.post('/usuarios', { nome: 'Operador Dois', email: 'op2@payax.com.br', senha: 'senha-forte', perfil: 'operador' });
    const tk = await api.login('op2@payax.com.br', 'senha-forte');
    assert.equal((await api.get('/integracoes/bradesco/conciliacao', tk)).status, 403);
    assert.equal((await api.post('/integracoes/bradesco/cobrancas', { conta_id: conta.id, valor_centavos: 100 }, tk)).status, 201);
  });
});

test('Cliente da API PIX: token OAuth2 em cache e criação de cobrança no padrão do Banco Central', async (t) => {
  const chamadas = [];
  const servidor = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      chamadas.push({ metodo: req.method, url: req.url, auth: req.headers.authorization, corpo });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'tok123', expires_in: 3600 }));
      if (req.method === 'PUT' && req.url.startsWith('/v2/cob/')) {
        const b = JSON.parse(corpo);
        return res.end(JSON.stringify({ txid: req.url.split('/').pop(), status: 'ATIVA', pixCopiaECola: '000201...', valor: b.valor }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ title: 'Não encontrado', detail: 'Cobrança inexistente' }));
    });
  });
  await new Promise((r) => servidor.listen(0, r));
  t.after(() => servidor.close());
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const api = new ApiBradesco({ modo: 'sandbox', tokenUrl: `${base}/oauth/token`, pixBaseUrl: `${base}/v2`, clientId: 'id', clientSecret: 'segredo', chavePix: '11222333000181' });

  const r = await api.criarCobranca({ txid: 'PAYAXabcdefghijklmnopqrstuv', valorCentavos: 1005, expiracaoSegundos: 600, solicitacao: 'Teste' });
  assert.equal(r.status, 'ATIVA');
  await api.criarCobranca({ txid: 'PAYAXabcdefghijklmnopqrstuw', valorCentavos: 1, expiracaoSegundos: 600 });
  assert.equal(chamadas.filter((c) => c.url === '/oauth/token').length, 1);
  assert.equal(chamadas[0].auth, `Basic ${Buffer.from('id:segredo').toString('base64')}`);
  const cob = chamadas.find((c) => c.metodo === 'PUT');
  assert.equal(cob.auth, 'Bearer tok123');
  assert.deepEqual(JSON.parse(cob.corpo), { calendario: { expiracao: 600 }, valor: { original: '10.05' }, chave: '11222333000181', solicitacaoPagador: 'Teste' });
  await assert.rejects(api.consultarCobranca('x'), /Cobrança inexistente/);
  await assert.rejects(api.enviarPix(), /aguardando a documentação/);
});
