'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { iniciar } = require('./helpers');
const { dataLocal, somarDias } = require('../server/lib/datas');

const hoje = () => dataLocal('America/Sao_Paulo');

/** PNG válido de 1×1 pixel, montado aqui mesmo (assinatura + IHDR + IDAT + IEND). */
function png1x1() {
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const bloco = (tipo, dados) => {
    const t = Buffer.from(tipo); const len = Buffer.alloc(4); len.writeUInt32BE(dados.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, dados])));
    return Buffer.concat([len, t, dados, c]);
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const idat = zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255]));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), bloco('IHDR', ihdr), bloco('IDAT', idat), bloco('IEND', Buffer.alloc(0))]);
}

test('Bolepix com preço próprio', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin, { tarifa_liquidacao: '0,00', percentual: '0', comissao_minima: '0', tarifa_fixa: '1,99' });
  const a = await api.cliente(tk.admin);
  const linha = (id) => api.db.prepare('SELECT * FROM boletos WHERE id = ?').get(id);

  await t.test('sem preço próprio, o Bolepix segue o boleto', async () => {
    const b = await api.boleto(tk.admin, a.cliente.id, { tipo: 'bolepix', vencimento: somarDias(hoje(), 5) });
    assert.equal(linha(b.id).comissao_fixa_centavos, 199);
  });

  await t.test('com preço próprio: cada tipo congela o seu preço na emissão', async () => {
    const r = await api.post(`/api/clientes/${a.cliente.id}/precos`, {
      tarifa_fixa: '1,99', tarifa_liquidacao: '0', percentual: '0', comissao_minima: '0',
      bolepix_proprio: '1', bolepix_tarifa_fixa: '2,49', bolepix_tarifa_liquidacao: '0', bolepix_percentual: '0', bolepix_comissao_minima: '0',
    }, tk.financeiro);
    assert.equal(r.status, 201);
    const comum = await api.boleto(tk.admin, a.cliente.id, { tipo: 'boleto', vencimento: somarDias(hoje(), 5) });
    const pix = await api.boleto(tk.admin, a.cliente.id, { tipo: 'bolepix', vencimento: somarDias(hoje(), 5) });
    assert.equal(linha(comum.id).comissao_fixa_centavos, 199);
    assert.equal(linha(pix.id).comissao_fixa_centavos, 249);
    // Na liquidação, o split usa o preço congelado de cada um.
    await api.post(`/api/boletos/${pix.id}/liquidar`, { pago_em: hoje(), valor_pago: '100,00', meio: 'pix' }, tk.financeiro);
    const tarifa = api.db.prepare("SELECT -SUM(valor_centavos) AS v FROM lancamentos WHERE boleto_id = ? AND tipo = 'comissao'").get(pix.id).v;
    assert.equal(tarifa, 249);
  });

  await t.test('a simulação e a Área do Cliente mostram o preço do Bolepix', async () => {
    const s = (await api.post('/api/boletos/simular', { cliente_id: a.cliente.id, valor: '100,00', tipo: 'bolepix' }, tk.admin)).dados;
    assert.equal(s.comissao_centavos, 249);
    const s2 = (await api.post('/api/boletos/simular', { cliente_id: a.cliente.id, valor: '100,00', tipo: 'boleto' }, tk.admin)).dados;
    assert.equal(s2.comissao_centavos, 199);
    const rel = (await api.get('/cliente/api/painel', a.token)).dados;
    assert.match(rel.preco.bolepix.tarifa_texto, /2,49/);
  });

  await t.test('o cliente não altera preço', async () => {
    assert.equal((await api.post(`/api/clientes/${a.cliente.id}/precos`, { tarifa_fixa: '0' }, a.token)).status, 401);
    assert.equal((await api.post(`/api/clientes/${a.cliente.id}/precos`, { tarifa_fixa: '0' }, tk.operacao)).status, 403);
  });
});

test('logo do cliente no boleto', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const tk = await api.equipe();
  await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);
  const a = await api.cliente(tk.admin);
  const imagem = `data:image/png;base64,${png1x1().toString('base64')}`;

  await t.test('o cliente envia o logo e ele aparece na ficha do boleto', async () => {
    const r = await api.put('/cliente/api/cadastro/logo', { imagem }, a.token);
    assert.equal(r.status, 200);
    const b = await api.boleto(tk.admin, a.cliente.id, { vencimento: somarDias(hoje(), 5) });
    const ficha = await api.get(`/api/boletos/${b.id}/ficha`, tk.admin);
    assert.match(String(ficha.dados), /class="logo-cliente" src="data:image\/png;base64,/);
    const lista = (await api.get('/api/clientes', tk.admin)).dados;
    assert.ok(lista.itens.every((c) => c.logo === undefined), 'a lista não carrega a imagem');
  });

  await t.test('só PNG ou JPEG de verdade, até 200 KB', async () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}`;
    assert.equal((await api.put('/cliente/api/cadastro/logo', { imagem: svg }, a.token)).status, 422);
    const falso = `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`;
    assert.equal((await api.put('/cliente/api/cadastro/logo', { imagem: falso }, a.token)).status, 422);
    const grande = `data:image/png;base64,${Buffer.concat([png1x1(), Buffer.alloc(210 * 1024)]).toString('base64')}`;
    assert.equal((await api.put('/cliente/api/cadastro/logo', { imagem: grande }, a.token)).status, 422);
  });

  await t.test('a equipe também troca e remove; consulta não', async () => {
    assert.equal((await api.put(`/api/clientes/${a.cliente.id}/logo`, { imagem }, tk.consulta)).status, 403);
    assert.equal((await api.put(`/api/clientes/${a.cliente.id}/logo`, { imagem: null }, tk.operacao)).status, 200);
    assert.equal(api.db.prepare('SELECT logo FROM clientes WHERE id = ?').get(a.cliente.id).logo, null);
  });
});
