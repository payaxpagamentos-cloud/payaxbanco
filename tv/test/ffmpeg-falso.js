#!/usr/bin/env node
'use strict';

/**
 * ffmpeg de mentira, só para os testes do ao vivo.
 *
 * Faz o que o de verdade faz do ponto de vista do servidor: escreve pedaços .ts e uma lista
 * .m3u8 que vai andando, e fica de pé até receber SIGTERM. Assim os testes conferem a conversão
 * inteira — ligar, servir a lista, servir o pedaço, desligar — em frações de segundo e sem
 * precisar de um servidor RTMP no ar. O ffmpeg de verdade é medido à parte, no servidor.
 *
 * Um endereço com "falha" no caminho sai com erro: é como se testa a reconexão.
 */

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);

// O servidor pergunta "ffmpeg -version" para saber se há conversor na máquina (/api/saude e a
// fila de conversão). Sem responder isso, o processo ficaria de pé para sempre e a plataforma
// inteira pararia de responder — foi exatamente o que aconteceu na primeira versão deste arquivo.
if (args.includes('-version') || !args.includes('-i')) {
  process.stdout.write('ffmpeg version 0.0-falso (só para os testes)\n');
  process.exit(0);
}

const saida = args[args.length - 1];
const padrao = args[args.indexOf('-hls_segment_filename') + 1];
const entrada = args[args.indexOf('-i') + 1];

if (/falha/.test(entrada)) {
  process.stderr.write('rtmp://origem: Server returned 404 Not Found\n');
  process.exit(1);
}

fs.mkdirSync(path.dirname(saida), { recursive: true });
const nomeDoPedaco = (i) => padrao.replace('%06d', String(i).padStart(6, '0'));

let n = 0;
function escrever() {
  // Pedaço com a cara de MPEG-TS: começa com 0x47, o byte de sincronismo.
  fs.writeFileSync(nomeDoPedaco(n), Buffer.alloc(188 * 10, 0x47));
  n += 1;
  const primeiro = Math.max(0, n - 3);
  const linhas = [];
  for (let i = primeiro; i < n; i += 1) linhas.push('#EXTINF:4.000,', path.basename(nomeDoPedaco(i)));
  fs.writeFileSync(saida, [
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4',
    `#EXT-X-MEDIA-SEQUENCE:${primeiro}`, ...linhas, '',
  ].join('\n'));
  // Apaga o que saiu da lista, como o delete_segments faz.
  if (primeiro > 0) { try { fs.unlinkSync(nomeDoPedaco(primeiro - 1)); } catch { /* já foi */ } }
}

escrever();
const relogio = setInterval(escrever, 150);
// O ffmpeg de verdade NÃO morre no instante do SIGTERM: ele fecha o pedaço que está escrevendo
// e só então sai, o que leva centenas de milissegundos. Sair na hora aqui escondia uma corrida
// de verdade — canal desligado e religado em seguida, com a limpeza do processo velho caindo em
// cima da pasta do novo. Com o falso morrendo instantaneamente, a janela nem existia e o teste
// passava com o defeito presente.
const DEMORA_PARA_MORRER_MS = 300;
for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, () => {
    clearInterval(relogio);
    setTimeout(() => process.exit(0), DEMORA_PARA_MORRER_MS);
  });
}
