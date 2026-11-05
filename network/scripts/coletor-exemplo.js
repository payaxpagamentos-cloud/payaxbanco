'use strict';

/*
 * Agente de coleta de exemplo para rodar DENTRO da rede do provedor (não exponha equipamentos à internet).
 * Testa conexão TCP em cada alvo e envia ao Manager Network:
 *   disponibilidade = 1 (respondeu) ou 0 (não respondeu), e latencia_ms quando responde.
 * Uso:
 *   NETWORK_URL=https://seu-dominio/network NETWORK_COLETOR_TOKEN=mnc_... \
 *   ALVOS="olt-pg-01=10.0.0.2:22,rt-borda-01=10.0.0.1:443" node scripts/coletor-exemplo.js
 * O target_id (antes do "=") é o "ID no monitoramento" cadastrado no equipamento.
 * Para potência óptica, latência ICMP, SNMP etc., use a plataforma de monitoramento existente e envie no mesmo formato.
 */

const net = require('node:net');
const crypto = require('node:crypto');

const url = String(process.env.NETWORK_URL || '').replace(/\/+$/, '');
const token = process.env.NETWORK_COLETOR_TOKEN;
const intervalo = (Number(process.env.INTERVALO_S) || 60) * 1000;
const alvos = String(process.env.ALVOS || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
  const [id, destino] = x.split('=');
  const [host, porta] = destino.split(':');
  return { id, host, porta: Number(porta) };
});
if (!url || !token || !alvos.length) {
  console.error('Defina NETWORK_URL, NETWORK_COLETOR_TOKEN e ALVOS (ex.: "olt-pg-01=10.0.0.2:22").');
  process.exit(1);
}

const testar = ({ host, porta }) => new Promise((ok) => {
  const inicio = process.hrtime.bigint();
  const s = net.connect({ host, port: porta, timeout: 3000 });
  const fim = (r) => { s.destroy(); ok(r); };
  s.once('connect', () => fim(Number(process.hrtime.bigint() - inicio) / 1e6));
  s.once('timeout', () => fim(null));
  s.once('error', () => fim(null));
});

async function ciclo() {
  const amostras = [];
  for (const a of alvos) {
    const ms = await testar(a);
    const em = new Date().toISOString();
    amostras.push({ schema_version: 1, source_event_id: crypto.randomUUID(), source: 'coletor-exemplo', target_id: a.id, metric: 'disponibilidade', value: ms === null ? 0 : 1, observed_at: em });
    if (ms !== null) amostras.push({ schema_version: 1, source_event_id: crypto.randomUUID(), source: 'coletor-exemplo', target_id: a.id, metric: 'latencia_ms', value: Math.round(ms * 10) / 10, unit: 'ms', observed_at: em });
  }
  try {
    const r = await fetch(`${url}/api/coletor/amostras`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ amostras }), signal: AbortSignal.timeout(10_000) });
    const d = await r.json().catch(() => ({}));
    console.log(new Date().toISOString(), r.status, `gravadas: ${d.recebidas ?? 0}/${amostras.length}`, d.erro ?? '');
  } catch (err) {
    // Sem conexão com o Manager Network: a próxima rodada tenta de novo (as amostras desta rodada se perdem; use uma fila se precisar).
    console.error(new Date().toISOString(), 'falha ao enviar:', err.message);
  }
}

ciclo();
setInterval(ciclo, intervalo);
