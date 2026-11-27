'use strict';

/**
 * Começar a tocar sozinho: o que faz o canal abrir rodando em vez de pedir um play.
 *
 * O <video> aqui é de mentira, e de propósito — o que precisa ser exercitado é o comportamento
 * TORTO do iPhone, que nenhum navegador desta máquina reproduz: o `play()` resolve com sucesso
 * e o sistema pausa o vídeo logo depois, sem erro nenhum. Era exatamente isso que deixava o
 * canal parado com a seta de play no meio.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let modulo = null;
const carregar = async () => {
  if (!modulo) {
    const fonte = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'autoplay.js'), 'utf8');
    modulo = await import(`data:text/javascript;base64,${Buffer.from(fonte).toString('base64')}`);
  }
  return modulo;
};

/**
 * <video> de mentira.
 * @param bloqueiaComSom  rejeita o play enquanto não estiver mudo (o bloqueio clássico)
 * @param pausaDepoisMs   pausa sozinho este tempo depois do play (o caso torto do iPhone)
 * @param pausaAoTirarMudo pausa quando o som é devolvido (o outro caso do iPhone)
 */
function videoFalso({ bloqueiaComSom = false, pausaDepoisMs = 0, pausaAoTirarMudo = false } = {}) {
  const v = {
    paused: true,
    muted: false,
    tentativas: 0,
    async play() {
      this.tentativas += 1;
      if (bloqueiaComSom && !this.muted) {
        const e = new Error('play() failed because the user didn\'t interact with the document first');
        e.name = 'NotAllowedError';
        throw e;
      }
      this.paused = false;
      if (pausaDepoisMs) setTimeout(() => { this.paused = true; }, pausaDepoisMs);
    },
  };
  if (pausaAoTirarMudo) {
    let mudo = false;
    Object.defineProperty(v, 'muted', {
      get: () => mudo,
      set(novo) { mudo = novo; if (!novo) v.paused = true; },
    });
  }
  return v;
}

const opcoes = (extra = {}) => ({ conferirMs: 400, ...extra });

test('autoplay: navegador que deixa tocar com som não é incomodado', async () => {
  const { iniciarReproducao } = await carregar();
  const v = videoFalso();
  const avisos = [];
  const ok = await iniciarReproducao(v, opcoes({
    aoPrecisarDeToque: () => avisos.push('toque'),
    aoVoltarOSom: () => avisos.push('som'),
  }));
  assert.equal(ok, true);
  assert.equal(v.paused, false);
  assert.equal(v.muted, false, 'não se muta quem não precisava');
  assert.deepEqual(avisos, ['som']);
  assert.equal(v.tentativas, 1, 'uma chamada basta: nada de insistir à toa');
});

test('autoplay: bloqueio clássico — toca mudo e devolve o som', async () => {
  const { iniciarReproducao } = await carregar();
  const v = videoFalso({ bloqueiaComSom: true });
  const avisos = [];
  const ok = await iniciarReproducao(v, opcoes({
    aoPrecisarDeToque: () => avisos.push('toque'),
    aoVoltarOSom: () => avisos.push('som'),
  }));
  assert.equal(ok, true);
  assert.equal(v.paused, false, 'o canal entra no ar');
  assert.equal(v.muted, false, 'e com som');
  assert.deepEqual(avisos, ['som']);
});

test('autoplay: iPhone — play() dá certo e o vídeo pausa depois', async () => {
  // Este é o caso que a correção anterior não pegava: a promessa resolve, o código dava por
  // bom, e meio segundo depois o canal estava parado. Sem erro, sem aviso, sem nada.
  const { iniciarReproducao } = await carregar();
  // A pausa vem TARDE de propósito: é assim no aparelho, e é o que uma conferência única,
  // feita logo depois do play, deixa passar. Com 100 ms qualquer verificação pegaria, e o
  // teste passaria mesmo com o código defeituoso — ou seja, não valeria nada.
  const v = videoFalso({ pausaDepoisMs: 600 });
  const avisos = [];
  const ok = await iniciarReproducao(v, opcoes({
    conferirMs: 1500,
    aoPrecisarDeToque: () => avisos.push('toque'),
    aoVoltarOSom: () => avisos.push('som'),
  }));
  // Não dá para fingir que deu certo: ou o canal está no ar, ou a pessoa precisa saber.
  assert.ok(v.tentativas > 1, 'tem de insistir, não aceitar a primeira resposta');
  assert.ok(ok === false || avisos.includes('toque'), 'ou falha honestamente, ou pede o toque');
  assert.ok(!avisos.includes('som'), 'não pode dizer que o som está valendo');
});

test('autoplay: iPhone — tirar o mudo pausa, então fica mudo e pede um toque', async () => {
  const { iniciarReproducao } = await carregar();
  const v = videoFalso({ bloqueiaComSom: true, pausaAoTirarMudo: true });
  const avisos = [];
  const ok = await iniciarReproducao(v, opcoes({
    aoPrecisarDeToque: () => avisos.push('toque'),
    aoVoltarOSom: () => avisos.push('som'),
  }));
  assert.equal(ok, true, 'o canal fica no ar de qualquer jeito');
  assert.equal(v.paused, false);
  assert.equal(v.muted, true, 'mudo, porque o som é que não foi aceito');
  assert.deepEqual(avisos, ['toque'], 'e a pessoa recebe o convite de um toque');
});

test('autoplay: pausa que a pessoa pediu é respeitada, não combatida', async () => {
  // Sem isto o player brigaria com quem quer pausar: aperta pausa, ele manda tocar de novo.
  const { iniciarReproducao } = await carregar();
  const v = videoFalso({ pausaDepoisMs: 100 });
  const avisos = [];
  const ok = await iniciarReproducao(v, opcoes({
    pausouDeProposito: () => true,
    aoPrecisarDeToque: () => avisos.push('toque'),
    aoVoltarOSom: () => avisos.push('som'),
  }));
  assert.equal(ok, true);
  assert.equal(v.tentativas, 1, 'não insiste contra a vontade de quem pausou');
  assert.ok(!avisos.includes('toque'));
});

test('autoplay: player que fechou no meio não é mexido', async () => {
  const { iniciarReproducao } = await carregar();
  const v = videoFalso();
  const ok = await iniciarReproducao(v, opcoes({ cancelado: () => true }));
  assert.equal(ok, false);
  assert.equal(v.tentativas, 0, 'nem chega a pedir play');
});
