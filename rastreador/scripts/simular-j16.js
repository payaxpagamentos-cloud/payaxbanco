'use strict';

// Simulador do rastreador J16 4G (protocolo GT06 4G): conecta no servidor como o equipamento, envia login, posições a cada
// poucos segundos (andando em volta do ponto de partida), estado da ignição, e responde aos comandos (bloqueio, status…).
// Serve para testar o sistema antes de instalar o rastreador de verdade.
// Uso: node scripts/simular-j16.js [IMEI] [servidor] [porta] [lat] [lng]
//      node scripts/simular-j16.js 866557088453933 localhost 5023 -23.5505 -46.6333

const net = require('node:net');
const { quadro, extrair } = require('../server/lib/gt06');

const [imei = '866557088453933', host = 'localhost', porta = '5023', lat0 = '-23.5505', lng0 = '-46.6333'] = process.argv.slice(2);
if (!/^\d{15}$/.test(imei)) throw new Error('Informe o IMEI de 15 dígitos.');

let serial = 0;
let pos = { lat: Number(lat0), lng: Number(lng0) };
let rumo = Math.random() * 360;
let ligado = true;
let bloqueado = false;
let passo = 0;
const prox = () => (serial = (serial + 1) & 0xffff);

/** GPS (18 bytes) na hora atual em UTC, como o J16 configurado com GMT,W,0,0#. */
function gps(velocidade) {
  const d = new Date();
  const b = Buffer.alloc(18);
  b.set([d.getUTCFullYear() - 2000, d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), 0xc9], 0);
  b.writeUInt32BE(Math.round(Math.abs(pos.lat) * 1_800_000), 7);
  b.writeUInt32BE(Math.round(Math.abs(pos.lng) * 1_800_000), 11);
  b[15] = velocidade;
  b.writeUInt16BE(0x1000 | (pos.lat >= 0 ? 0x0400 : 0) | (pos.lng < 0 ? 0x0800 : 0) | (Math.round(rumo) % 360), 16);
  return b;
}
// Célula 4G: MCC 724 (Brasil), MNC 11, LAC (4 bytes) e célula (8 bytes).
const celula = Buffer.concat([Buffer.from([0x02, 0xd4, 0x0b]), Buffer.from([0, 0, 0x2b, 0x67]), Buffer.from([0, 0, 0, 0, 0x01, 0x2c, 0x5a, 0x11])]);
const estado = () => (ligado ? 0x02 : 0) | 0x04 | 0x40 | (bloqueado ? 0x80 : 0);

const sock = net.connect(Number(porta), host, () => {
  console.log(`Conectado em ${host}:${porta} como o J16 ${imei}.`);
  sock.write(quadro(0x01, Buffer.concat([Buffer.from(`0${imei}`, 'hex'), Buffer.from([0x36, 0x08]), Buffer.from([0x00, 0x00])]), prox()));
});

let buf = Buffer.alloc(0);
sock.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  const { quadros, resto } = extrair(buf);
  buf = Buffer.from(resto);
  for (const q of quadros) {
    if (q.protocolo === 0x01) console.log('Login aceito pelo servidor.');
    if (q.protocolo !== 0x80) continue;
    const flag = q.conteudo.subarray(1, 5);
    const texto = q.conteudo.subarray(5, q.conteudo.length - 2).toString('latin1');
    let resposta = 'OK';
    if (/^RELAY,1#/i.test(texto)) { bloqueado = true; resposta = 'RELAY=1 OK, Cut off the fuel supply: Success!'; }
    else if (/^RELAY,0#/i.test(texto)) { bloqueado = false; resposta = 'RELAY=0 OK, Restore fuel supply: Success!'; }
    else if (/^STATUS#/i.test(texto)) resposta = `Battery:External power; GPRS:Link Up; GSM Signal Level:Strong; GPS:Successful positioning; ACC:${ligado ? 'ON' : 'OFF'}; Defense:OFF; RELAY:${bloqueado ? 1 : 0}`;
    else if (/^PARAM#/i.test(texto)) resposta = `IMEI:${imei}; TIMER:30,3600; SERVER:1,${host},${porta},0; GMT:W,0,0; APN:indica.br`;
    else if (/^WHERE#/i.test(texto)) resposta = `Lat:${pos.lat.toFixed(6)},Lon:${pos.lng.toFixed(6)},Speed:0`;
    console.log(`Comando recebido: ${texto}  →  ${resposta}`);
    const t = Buffer.from(resposta, 'latin1');
    sock.write(quadro(0x15, Buffer.concat([Buffer.from([4 + t.length]), flag, t, Buffer.from([0x00, 0x02])]), prox()));
    if (/^(WHERE|RELAY)/i.test(texto)) enviarPosicao();
  }
});
sock.on('close', () => { console.log('Conexão encerrada.'); process.exit(0); });
sock.on('error', (err) => { console.error(`Erro: ${err.message}`); process.exit(1); });

function enviarPosicao() {
  const velocidade = !ligado || bloqueado ? 0 : Math.round(25 + Math.random() * 45);
  if (velocidade) {
    rumo = (rumo + (Math.random() - 0.5) * 50 + 360) % 360;
    const m = (velocidade / 3.6) * 10;
    pos = { lat: pos.lat + (Math.cos((rumo * Math.PI) / 180) * m) / 111_195, lng: pos.lng + (Math.sin((rumo * Math.PI) / 180) * m) / (111_195 * Math.cos((pos.lat * Math.PI) / 180)) };
  }
  sock.write(quadro(0xa0, Buffer.concat([gps(velocidade), celula, Buffer.from([ligado ? 1 : 0, 0x00, 0x00])]), prox()));
  console.log(`Posição ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)} a ${velocidade} km/h · ignição ${ligado ? 'ligada' : 'desligada'}${bloqueado ? ' · BLOQUEADO' : ''}`);
}

// Posição a cada 10 s; a cada ~5 min desliga por 1 min (parada); estado (heartbeat) a cada minuto.
setInterval(() => {
  passo++;
  if (passo % 30 === 0) { ligado = false; sock.write(quadro(0x23, Buffer.from([estado(), 0x00, 0x04, 0x00, 0x02]), prox())); }
  if (passo % 30 === 6) { ligado = true; sock.write(quadro(0x23, Buffer.from([estado(), 0x00, 0x04, 0x00, 0x02]), prox())); }
  enviarPosicao();
}, 10_000);
setInterval(() => sock.write(quadro(0x13, Buffer.from([estado(), 0x06, 0x04, 0x00, 0x02]), prox())), 60_000);
setTimeout(enviarPosicao, 1000);
