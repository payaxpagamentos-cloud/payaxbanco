#!/usr/bin/env node
'use strict';

/**
 * Testa o sinal de todos os canais ao vivo e, se mandado, liga os que responderem.
 *
 *   node scripts/testar-canais.js              # só testa e mostra o resultado
 *   node scripts/testar-canais.js --ligar      # testa e põe no ar os que passaram
 *   node scripts/testar-canais.js --so-falhas  # repete só nos que falharam antes
 *
 * Existe porque 116 canais não se testam no painel um por um. Em cada canal, conecta na origem,
 * lê os codecs e diz se dá para converter sem recodificar — e grava a situação no canal, que é
 * o que o painel mostra depois.
 *
 * Com --ligar, canal que respondeu entra no ar e canal que falhou fica desligado. Essa é a
 * ordem certa: ninguém descobre que um canal está fora do ar pelo assinante reclamando.
 */

const { abrir, agora } = require('../server/db');
const aovivo = require('../server/lib/aovivo');

const ligar = process.argv.includes('--ligar');
const soFalhas = process.argv.includes('--so-falhas');
const db = abrir();

const canais = db.prepare(`SELECT id, nome, numero, url_hls, sinal_status FROM canais
  WHERE fonte = 'rtmp' AND url_hls IS NOT NULL AND url_hls <> ''
  ${soFalhas ? "AND (sinal_status IS NULL OR sinal_status = 'falha')" : ''}
  ORDER BY numero`).all();

if (!canais.length) {
  console.log(soFalhas ? 'Nenhum canal com falha para repetir.' : 'Nenhum canal ao vivo cadastrado.');
  process.exit(0);
}

(async () => {
  console.log(`Testando ${canais.length} canal(is). Cada um leva alguns segundos.\n`);
  const passaram = [];
  const falharam = [];
  const comAviso = [];

  for (const c of canais) {
    let r;
    try {
      r = await aovivo.conferir(c);
    } catch (err) {
      r = { status: 'falha', detalhe: err.message };
    }
    db.prepare('UPDATE canais SET sinal_status = ?, sinal_detalhe = ?, sinal_em = ? WHERE id = ?')
      .run(r.status, r.detalhe, agora(), c.id);

    const marca = r.status === 'ok' ? '\x1b[32mok   \x1b[0m' : '\x1b[31mfalha\x1b[0m';
    console.log(`  ${marca} ${String(c.numero).padStart(3)} ${c.nome.padEnd(24)} ${r.detalhe ?? ''}`);
    if (r.status === 'ok') {
      passaram.push(c);
      if (r.video && r.video.codec !== 'h264') comAviso.push(`${c.nome}: vídeo em ${r.video.codec.toUpperCase()}`);
    } else {
      falharam.push({ ...c, motivo: r.detalhe });
    }
  }

  console.log(`\n${passaram.length} responderam, ${falharam.length} falharam.`);
  if (comAviso.length) {
    console.log('\nAtenção ao codec (toca em aparelho novo, mas não em Smart TV e iPhone antigos):');
    for (const a of comAviso) console.log(`  ${a}`);
  }

  if (ligar) {
    // Canal que respondeu entra no ar; o que falhou sai, mesmo que estivesse ligado antes —
    // é melhor o canal sumir da lista do que aparecer e dar tela preta.
    const acender = db.prepare('UPDATE canais SET ativo = 1, atualizado_em = ? WHERE id = ?');
    const apagar = db.prepare('UPDATE canais SET ativo = 0, atualizado_em = ? WHERE id = ?');
    for (const c of passaram) acender.run(agora(), c.id);
    for (const c of falharam) apagar.run(agora(), c.id);
    console.log(`\n${passaram.length} canal(is) NO AR para os assinantes; ${falharam.length} desligado(s).`);
    console.log('A conversão só sobe quando alguém abrir o canal, então ligar todos não pesa no servidor.');
  } else if (passaram.length) {
    console.log('\nNada foi ligado. Para pôr no ar os que responderam:');
    console.log('  node scripts/testar-canais.js --ligar');
  }

  if (falharam.length) {
    console.log('\nOs que falharam:');
    for (const f of falharam.slice(0, 20)) console.log(`  ${String(f.numero).padStart(3)} ${f.nome}: ${f.motivo}`);
    if (falharam.length > 20) console.log(`  … e mais ${falharam.length - 20}.`);
    console.log('\nFalhando TODOS, o problema é de rede ou de liberação de IP na origem, não dos canais.');
    console.log('Para repetir só nesses, depois de resolver:  node scripts/testar-canais.js --so-falhas --ligar');
  }
})().catch((err) => {
  console.error('Falhou:', err.message);
  process.exit(1);
}).finally(() => db.close());
