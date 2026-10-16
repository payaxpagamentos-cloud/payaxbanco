'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers');
const { lerOfx, lerCsv, valorTexto, dataTexto } = require('../server/lib/extrato');

const OFX_SGML = `OFXHEADER:100
DATA:OFXSGML
CHARSET:1252

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<DTSTART>20260101
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260105120000[-3:BRT]
<TRNAMT>-1.500,00
<FITID>A1
<MEMO>PAGTO FORNECEDOR
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260106
<TRNAMT>2300.55
<FITID>A2
<NAME>PIX RECEBIDO
<MEMO>CLIENTE X
</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

test('valores e datas em formatos brasileiros', () => {
  assert.equal(valorTexto('1.234,56'), 123456);
  assert.equal(valorTexto('-1234.56'), -123456);
  assert.equal(valorTexto('R$ 10,5'), 1050);
  assert.equal(valorTexto('(25,00)'), -2500);
  assert.ok(Number.isNaN(valorTexto('abc')));
  assert.equal(dataTexto('31/01/2026'), '2026-01-31');
  assert.equal(dataTexto('20260131093000'), '2026-01-31');
  assert.equal(dataTexto('31/02/2026'), null);
});

test('OFX 1.x (SGML) com valores em vírgula', () => {
  const itens = lerOfx(OFX_SGML);
  assert.equal(itens.length, 2);
  assert.deepEqual(itens[0], { data: '2026-01-05', valor_centavos: -150000, descricao: 'PAGTO FORNECEDOR', documento: null, fitid: 'A1' });
  assert.equal(itens[1].valor_centavos, 230055);
  assert.equal(itens[1].descricao, 'PIX RECEBIDO · CLIENTE X');
});

test('OFX 2.x (XML)', () => {
  const xml = '<?xml version="1.0"?><OFX><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260210</DTPOSTED><TRNAMT>-9.90</TRNAMT><FITID>X9</FITID><MEMO>TARIFA</MEMO></STMTTRN></BANKTRANLIST></OFX>';
  assert.deepEqual(lerOfx(xml), [{ data: '2026-02-10', valor_centavos: -990, descricao: 'TARIFA', documento: null, fitid: 'X9' }]);
});

test('CSV ignora cabeçalho e gera identificador estável para linhas repetidas', () => {
  const csv = 'Data;Histórico;Valor\n05/01/2026;Tarifa;-9,90\n05/01/2026;Tarifa;-9,90\nSaldo;;100\n';
  const a = lerCsv(csv);
  const b = lerCsv(csv);
  assert.equal(a.length, 2);
  assert.notEqual(a[0].fitid, a[1].fitid);
  assert.deepEqual(a.map((i) => i.fitid), b.map((i) => i.fitid));
});
