'use strict';

/**
 * O vigia da reprodução: o que garante que canal ao vivo não fica travado.
 *
 * Aqui o <video> é de mentira e o relógio é controlado pelo teste, para a escada de remédios,
 * a espera entre tentativas e a regra de não desistir no ao vivo serem conferidas na hora, sem
 * esperar minutos de verdade. O caminho com vídeo e HLS reais é exercitado à parte, no
 * navegador (scripts/conferir-vigia.js).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// O vigia é um módulo do navegador (ESM) dentro de uma pasta que o Node lê como CommonJS. Em
// vez de mudar o arquivo que o app serve só por causa do teste, ele é carregado pelo conteúdo.
const fs = require('node:fs');
const path = require('node:path');
let modulo = null;
const carregar = async () => {
  if (!modulo) {
    const fonte = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'vigia.js'), 'utf8');
    modulo = await import(`data:text/javascript;base64,${Buffer.from(fonte).toString('base64')}`);
  }
  return modulo;
};

/** <video> de mentira: só o que o vigia olha. */
function videoFalso({ tempo = 0 } = {}) {
  return { currentTime: tempo, paused: false, seeking: false, ended: false,
    seekable: { length: 1, end: () => 100 } };
}

/** Relógio controlado: o teste decide quanto tempo passou. */
function relogioFalso() {
  let t = 1_000_000;
  return { agora: () => t, avancar: (ms) => { t += ms; } };
}

/**
 * Avança o relógio, bate o vigia e deixa as microtarefas correrem.
 *
 * O remédio é assíncrono: a trava que impede dois remédios ao mesmo tempo só é solta num
 * `finally`, que é microtarefa. Num bloco de teste todo síncrono elas nunca rodariam, e o vigia
 * pareceria travado por culpa do teste, não do código.
 */
const passar = async (r, g, ms) => {
  r.avancar(ms);
  g.bater();
  await Promise.resolve();
  await Promise.resolve();
};

test('vigia: vídeo que anda não é incomodado', async () => {
  const { vigiarReproducao } = await carregar();
  const v = videoFalso();
  const r = relogioFalso();
  const aplicados = [];
  const g = vigiarReproducao(v, { agora: r.agora, remedios: [() => aplicados.push(1)], intervaloMs: 1e9 });

  for (let i = 0; i < 10; i += 1) { v.currentTime += 1; r.avancar(2000); g.bater(); }
  assert.deepEqual(aplicados, [], 'vídeo andando não pode levar remédio nenhum');
  g.parar();
});

test('vigia: pausado, buscando ou terminado não conta como travado', async () => {
  const { vigiarReproducao } = await carregar();
  const r = relogioFalso();
  for (const estado of ['paused', 'seeking', 'ended']) {
    const v = videoFalso();
    v[estado] = true;
    const aplicados = [];
    const g = vigiarReproducao(v, { agora: r.agora, remedios: [() => aplicados.push(1)], intervaloMs: 1e9 });
    for (let i = 0; i < 10; i += 1) { r.avancar(5000); g.bater(); }
    assert.deepEqual(aplicados, [], `${estado} é parada de propósito, não travamento`);
    g.parar();
  }
});

test('vigia: vídeo parado leva os remédios em ordem, com espera crescente', async () => {
  const { vigiarReproducao, esperaDoPasso } = await carregar();
  const v = videoFalso();
  const r = relogioFalso();
  const aplicados = [];
  const g = vigiarReproducao(v, {
    agora: r.agora,
    paradoMs: 6000,
    intervaloMs: 1e9,
    remedios: [
      () => aplicados.push('empurrao'),
      () => aplicados.push('recuperar'),
      () => aplicados.push('recarregar'),
      () => aplicados.push('refazer'),
    ],
  });

  // A primeira batida é só a observação inicial; a segunda marca o começo da parada.
  await passar(r, g, 0);
  await passar(r, g, 1000);
  assert.deepEqual(aplicados, [], 'não age antes de ter certeza de que parou');
  await passar(r, g, 3000);
  assert.deepEqual(aplicados, [], '3s parado ainda pode ser engasgo normal');

  // Passados os 6s, vem o primeiro remédio — e só ele.
  await passar(r, g, 4000);
  assert.deepEqual(aplicados, ['empurrao']);
  await passar(r, g, 0);
  await passar(r, g, 0);
  assert.deepEqual(aplicados, ['empurrao'], 'não repete antes da espera do passo');

  // Cada passo seguinte exige a espera dele: 2s, 4s, 8s…
  const esperados = ['recuperar', 'recarregar', 'refazer'];
  for (const [i, nome] of esperados.entries()) {
    await passar(r, g, esperaDoPasso(i + 1) + 1);   // marca a parada de novo
    await passar(r, g, 6001);                        // e agora sim passou o tempo parado
    assert.equal(aplicados[aplicados.length - 1], nome, `passo ${i + 2} devia ser ${nome}`);
  }

  // Passado o fim da lista, o último remédio se repete — é o que refaz a fonte do zero.
  await passar(r, g, esperaDoPasso(4) + 1);
  await passar(r, g, 6001);
  assert.equal(aplicados[aplicados.length - 1], 'refazer');
  assert.equal(aplicados.filter((a) => a === 'refazer').length, 2);
  g.parar();
});

test('vigia: espera entre tentativas dobra até o teto, sem passar dele', async () => {
  const { esperaDoPasso } = await carregar();
  assert.deepEqual([1, 2, 3, 4, 5].map((p) => esperaDoPasso(p)), [2000, 4000, 8000, 16000, 20000]);
  assert.equal(esperaDoPasso(40), 20000, 'por mais que insista, nunca passa do teto');
});

test('vigia: canal AO VIVO nunca desiste; sob demanda desiste e oferece saída', async () => {
  const { vigiarReproducao, esperaDoPasso } = await carregar();

  // Este é o requisito da operação: canal de TV não pode virar tela de erro. A origem cai e
  // volta, e quem está vendo TV espera — tela de erro num canal é pior que a espera com aviso.
  const moer = async (aoVivo) => {
    const v = videoFalso();
    const r = relogioFalso();
    const avisos = [];
    let vezes = 0;
    const g = vigiarReproducao(v, {
      aoVivo, agora: r.agora, intervaloMs: 1e9, tentativasAteDesistir: 6,
      remedios: [() => { vezes += 1; }],
      aoMudar: ({ estado }) => avisos.push(estado),
    });
    for (let i = 0; i < 40; i += 1) {
      await passar(r, g, esperaDoPasso(40) + 1);
      await passar(r, g, 6001);
    }
    g.parar();
    return { vezes, avisos, desistiu: g.desistiu };
  };

  const vivo = await moer(true);
  assert.equal(vivo.desistiu, false, 'canal ao vivo não pode desistir');
  assert.ok(vivo.vezes > 20, `ao vivo continua tentando (tentou ${vivo.vezes})`);
  assert.ok(!vivo.avisos.includes('desistiu'));

  const gravado = await moer(false);
  assert.equal(gravado.desistiu, true, 'sob demanda precisa oferecer uma saída');
  assert.ok(gravado.avisos.includes('desistiu'));
  assert.equal(gravado.vezes, 6, 'desiste exatamente no limite combinado');
});

test('vigia: vídeo que volta a andar limpa o aviso e zera a contagem', async () => {
  const { vigiarReproducao, esperaDoPasso } = await carregar();
  const v = videoFalso();
  const r = relogioFalso();
  const avisos = [];
  const g = vigiarReproducao(v, {
    agora: r.agora, intervaloMs: 1e9, remedios: [() => {}],
    aoMudar: ({ estado }) => avisos.push(estado),
  });

  await passar(r, g, 0);
  await passar(r, g, 1000);
  await passar(r, g, 7000);
  assert.ok(g.passo >= 1, 'estava travado');

  // O sinal voltou — mas um suspiro não basta: a contagem só zera com avanço que se sustenta.
  r.avancar(esperaDoPasso(1) + 1);
  v.currentTime += 1;
  await passar(r, g, 0);
  assert.ok(g.passo >= 1, 'dois segundos de imagem não são recuperação: a escada continua de pé');
  assert.notEqual(avisos[avisos.length - 1], 'voltou');

  // Andando de verdade, por tempo suficiente.
  for (let i = 0; i < 5; i += 1) { v.currentTime += 2; await passar(r, g, 2000); }
  assert.equal(g.passo, 0, 'contagem zerada');
  assert.equal(avisos[avisos.length - 1], 'voltou', 'a tela precisa saber para tirar a rodinha');

  // E travando de novo depois disso, a escada recomeça do primeiro degrau, como deve.
  await passar(r, g, 1000);
  await passar(r, g, 7000);
  assert.equal(g.passo, 1);
  g.parar();
});

test('vigia: remédio que explode não derruba o vigia nem pula a fila', async () => {
  const { vigiarReproducao, esperaDoPasso } = await carregar();
  const v = videoFalso();
  const r = relogioFalso();
  const aplicados = [];
  const g = vigiarReproducao(v, {
    agora: r.agora, intervaloMs: 1e9,
    remedios: [
      () => { aplicados.push('um'); throw new Error('o navegador recusou o salto'); },
      async () => { aplicados.push('dois'); throw new Error('falhou também'); },
      () => aplicados.push('tres'),
    ],
  });
  await passar(r, g, 0);
  for (let i = 0; i < 3; i += 1) {
    await passar(r, g, esperaDoPasso(i + 1) + 1);
    await passar(r, g, 6001);
  }
  assert.deepEqual(aplicados, ['um', 'dois', 'tres'], 'a fila anda mesmo com remédio que falha');
  g.parar();
});

test('vigia: parar de verdade para — vigia de player fechado não pode mexer em nada', async () => {
  const { vigiarReproducao, esperaDoPasso } = await carregar();
  const v = videoFalso();
  const r = relogioFalso();
  let vezes = 0;
  const g = vigiarReproducao(v, { agora: r.agora, intervaloMs: 1e9, remedios: [() => { vezes += 1; }] });
  await passar(r, g, 0);
  await passar(r, g, 1000);
  await passar(r, g, 7000);
  assert.equal(vezes, 1);
  g.parar();
  for (let i = 0; i < 10; i += 1) { await passar(r, g, esperaDoPasso(9)); g.forcar(); await Promise.resolve(); }
  assert.equal(vezes, 1, 'depois de parar, nem bater nem forçar podem agir');
});
