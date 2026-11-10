'use strict';

/*
 * Simulador de flows para demonstração e testes (NUNCA aponte para a produção de outro provedor).
 * Envia NetFlow v9 (ou IPFIX/sFlow) ao coletor com tráfego normal para os IPs de um bloco e, se pedido, um ataque.
 *
 *   node scripts/simulador-fluxos.js                          → tráfego normal para 203.0.113.0/24 em 127.0.0.1:2055
 *   ATAQUE=dns ALVO=203.0.113.10 node scripts/simulador-fluxos.js   → mais uma amplificação DNS de ~2 Gbps no alvo
 *
 * Variáveis: DESTINO (127.0.0.1), PORTA (2055), FORMATO (netflow9 | ipfix | sflow), BLOCO (203.0.113), ATAQUE (dns | syn | ntp),
 * ALVO, GBPS (2). O exportador 127.0.0.1 precisa estar cadastrado em Tráfego → Fontes, com papel "borda".
 */

const dgram = require('node:dgram');
const gerar = require('../server/lib/fluxos/gerar');

const destino = process.env.DESTINO || '127.0.0.1';
const porta = Number(process.env.PORTA) || 2055;
const formato = process.env.FORMATO || 'netflow9';
const bloco = process.env.BLOCO || '203.0.113';
const ataque = process.env.ATAQUE;
const alvo = process.env.ALVO || `${bloco}.10`;
const gbps = Number(process.env.GBPS) || 2;
const s = dgram.createSocket('udp4');
const r = (n) => Math.floor(Math.random() * n);

function pacote(fluxos) {
  // sFlow: cada amostra vale "taxa" pacotes do tamanho médio do fluxo (estimativa, como no roteador real).
  if (formato === 'sflow') return gerar.sflow(fluxos, { taxa: 1000 });
  return gerar.netflow9(fluxos, { ipfix: formato === 'ipfix' });
}

setInterval(() => {
  // Tráfego normal: downloads de vídeo e navegação, ~400 Mbps no total
  const normal = Array.from({ length: 25 }, () => ({ src: `198.51.100.${1 + r(200)}`, dst: `${bloco}.${1 + r(250)}`, sport: [443, 80, 443, 443][r(4)],
    dport: 30000 + r(30000), proto: 6, bytes: 1_500_000 + r(2_500_000), pkts: 1500 + r(2500), flags: 0x18 }));
  const envio = [...normal];
  if (ataque) {
    const total = (gbps * 1e9) / 8; // bytes por segundo
    const n = 10;
    for (let i = 0; i < n; i++) {
      if (ataque === 'syn') envio.push({ src: `192.0.2.${1 + r(250)}`, dst: alvo, sport: 1024 + r(60000), dport: 443, proto: 6, flags: 0x02, bytes: Math.round(total / n), pkts: Math.round(total / n / 60) });
      else envio.push({ src: `192.0.2.${1 + r(250)}`, dst: alvo, sport: ataque === 'ntp' ? 123 : 53, dport: 1024 + r(60000), proto: 17, bytes: Math.round(total / n), pkts: Math.round(total / n / 1200) });
    }
  }
  for (let i = 0; i < envio.length; i += 20) s.send(pacote(envio.slice(i, i + 20)), porta, destino);
}, 1000);
console.log(`Simulador: ${formato} para ${destino}:${porta}, bloco ${bloco}.0/24${ataque ? `, ataque ${ataque} de ${gbps} Gbps em ${alvo}` : ''}. Ctrl+C para parar.`);
