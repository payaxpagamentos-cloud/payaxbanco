'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const qr = require('../server/lib/qr');

/*
 * QR Code.
 *
 * Um QR errado não dá erro em lugar nenhum: ele simplesmente não lê, e quem descobre é o cliente com o
 * celular na mão diante do boleto. Por isso a prova que vale é a última deste arquivo — um leitor de QR
 * de verdade, que não conhece este código, lendo a imagem gerada. Os testes antes dela cobrem a estrutura
 * e rodam sem rede, para a suíte continuar útil off-line.
 */

const CASOS = [
  ['curto', 'oi'],
  ['QR da NFCom', 'https://dfe-portal.svrs.rs.gov.br/nfcom/qrCode?chNFCom=41261111222333000181620010000000011026376185&tpAmb=2'],
  ['BR Code do PIX', '00020126530014br.gov.bcb.pix0131financeiro@provedor-demo.com.br52040000530398654040.005802BR5925PROVEDOR DEMONSTRACAO LTD6012PONTA GROSSA62090505FAT23'],
  ['com acento', 'Instalação em São Paulo — ação nº 1'],
  ['longo', 'a'.repeat(300)],
];

test('QR Code: estrutura', async (t) => {
  await t.test('a versão escolhida é a menor que comporta o texto', () => {
    assert.equal(qr.matriz('oi').versao, 1);
    // Um texto que enche a versão 1 (17 bytes de dados em M) precisa pular para a 2.
    assert.equal(qr.matriz('a'.repeat(14)).versao, 1);
    assert.ok(qr.matriz('a'.repeat(30)).versao >= 2);
    assert.ok(qr.matriz('a'.repeat(300)).versao >= 10);
  });

  await t.test('o tamanho da matriz segue a versão: 4 × versão + 17', () => {
    for (const [, texto] of CASOS) {
      const r = qr.matriz(texto);
      assert.equal(r.tamanho, r.versao * 4 + 17, texto.slice(0, 20));
      assert.equal(r.matriz.length, r.tamanho);
      assert.ok(r.matriz.every((linha) => linha.length === r.tamanho));
    }
  });

  await t.test('os três padrões de busca estão nos cantos certos', () => {
    const { matriz: m, tamanho } = qr.matriz(CASOS[1][1]);
    const busca = (cx, cy) => {
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          const anel = dx === 0 || dx === 6 || dy === 0 || dy === 6;
          const miolo = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
          assert.equal(m[cy + dy][cx + dx], anel || miolo ? 1 : 0, `busca em ${cx},${cy} módulo ${dx},${dy}`);
        }
      }
    };
    busca(0, 0);
    busca(tamanho - 7, 0);
    busca(0, tamanho - 7);
    // O quarto canto NÃO tem padrão de busca: é por ele que o leitor descobre a orientação.
    const cantoLivre = m.slice(tamanho - 7).every((linha) => linha.slice(tamanho - 7).some((v) => v === 0));
    assert.ok(cantoLivre);
  });

  await t.test('as linhas de sincronismo alternam', () => {
    const { matriz: m, tamanho } = qr.matriz(CASOS[1][1]);
    for (let i = 8; i < tamanho - 8; i++) {
      assert.equal(m[6][i], i % 2 === 0 ? 1 : 0, `sincronismo horizontal em ${i}`);
      assert.equal(m[i][6], i % 2 === 0 ? 1 : 0, `sincronismo vertical em ${i}`);
    }
  });

  await t.test('o módulo escuro é escuro', () => {
    const { matriz: m, tamanho } = qr.matriz('oi');
    assert.equal(m[tamanho - 8][8], 1, 'a norma exige este módulo sempre escuro');
  });

  await t.test('a máscara escolhida é sempre uma das oito, e a escolha é estável', () => {
    for (const [nome, texto] of CASOS) {
      const a = qr.matriz(texto);
      const b = qr.matriz(texto);
      assert.ok(a.mascara >= 0 && a.mascara <= 7, nome);
      assert.equal(a.mascara, b.mascara, `${nome}: mesma entrada, mesma saída`);
      assert.deepEqual(a.matriz, b.matriz);
    }
  });

  await t.test('texto grande demais é recusado com motivo, não truncado em silêncio', () => {
    assert.throws(() => qr.matriz('x'.repeat(5000)), /longo demais/);
  });

  await t.test('o SVG tem a margem branca que os leitores exigem', () => {
    const s = qr.svg('oi', { modulo: 4, margem: 4 });
    const { tamanho } = qr.matriz('oi');
    const lado = (tamanho + 8) * 4;
    assert.ok(s.includes(`viewBox="0 0 ${lado} ${lado}"`));
    assert.ok(s.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
    assert.ok(s.includes('shape-rendering="crispEdges"'), 'sem isto o navegador borra os módulos');
  });
});

/*
 * A prova que importa: um leitor independente lê o que foi gerado.
 *
 * Usa o Chromium que já vem na máquina e o jsQR, baixado na hora. Sem rede, o teste é pulado em vez de
 * falhar — a suíte precisa rodar off-line —, mas então a garantia fica só na estrutura, acima.
 */
test('QR Code: UM LEITOR DE VERDADE LÊ O QUE FOI GERADO', async (t) => {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { return t.skip('playwright não disponível'); }

  // O leitor fica guardado no repositório (test/vendor), para a prova rodar off-line, sempre.
  const leitor = require('node:path').join(__dirname, 'vendor', 'jsqr.js');
  if (!require('node:fs').existsSync(leitor)) return t.skip('leitor de QR não encontrado em test/vendor');

  const navegador = await chromium.launch();
  const pagina = await navegador.newPage();
  try {
    await pagina.goto('about:blank');
    await pagina.addScriptTag({ path: leitor });
    await pagina.waitForFunction('typeof window.jsQR === "function"', { timeout: 20_000 });
  } catch (err) {
    await navegador.close();
    return t.skip(`não foi possível carregar o leitor de QR (${String(err.message).split('\n')[0].slice(0, 80)})`);
  }

  try {
    for (const [nome, texto] of CASOS) {
      await t.test(`lê: ${nome}`, async () => {
        const r = await pagina.evaluate(async (svg) => {
          const img = new Image();
          img.src = `data:image/svg+xml;base64,${btoa(String.fromCharCode(...new TextEncoder().encode(svg)))}`;
          await new Promise((pronto) => { img.onload = pronto; img.onerror = pronto; });
          const tela = document.createElement('canvas');
          tela.width = img.naturalWidth || img.width;
          tela.height = img.naturalHeight || img.height;
          if (!tela.width || !tela.height) return { lido: null, largura: 0, altura: 0, escuros: 0 };
          const ctx = tela.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const d = ctx.getImageData(0, 0, tela.width, tela.height);
          let escuros = 0;
          for (let i = 0; i < d.data.length; i += 4) if (d.data[i] < 128) escuros++;
          const achado = window.jsQR(d.data, d.width, d.height);
          return { lido: achado ? achado.data : null, largura: d.width, altura: d.height, escuros };
        }, qr.svg(texto, { modulo: 6 }));
        // Diagnóstico junto da falha: sem pixels escuros o problema é a imagem, não o código.
        assert.equal(r.lido, texto,
          `o leitor precisa devolver exatamente o texto original (${nome}; imagem ${r.largura}x${r.altura}, ${r.escuros} pixels escuros)`);
      });
    }
  } finally {
    await navegador.close();
  }
});
