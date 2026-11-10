'use strict';

/** Formatação em português para avisos e relatórios gerados no servidor. */

const num = (n, casas = 0) => Number(n ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });

function bits(bps) {
  const x = Number(bps ?? 0);
  if (x >= 1e9) return `${num(x / 1e9, 2)} Gbps`;
  if (x >= 1e6) return `${num(x / 1e6, 1)} Mbps`;
  if (x >= 1e3) return `${num(x / 1e3, 0)} kbps`;
  return `${num(x, 0)} bps`;
}

function pacotes(pps, sufixo = 'pps') {
  const x = Number(pps ?? 0);
  if (x >= 1e6) return `${num(x / 1e6, 2)} mi ${sufixo}`;
  if (x >= 1e3) return `${num(x / 1e3, 0)} mil ${sufixo}`;
  return `${num(x, 0)} ${sufixo}`;
}

function bytes(b) {
  const x = Number(b ?? 0);
  if (x >= 1e12) return `${num(x / 1e12, 2)} TB`;
  if (x >= 1e9) return `${num(x / 1e9, 2)} GB`;
  if (x >= 1e6) return `${num(x / 1e6, 1)} MB`;
  if (x >= 1e3) return `${num(x / 1e3, 0)} kB`;
  return `${num(x, 0)} B`;
}

function dataHora(iso, fuso = 'America/Sao_Paulo', { segundos = false } = {}) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    ...(segundos ? { second: '2-digit' } : {}) }).format(new Date(iso));
}

function duracao(ms) {
  const m = Math.round(Math.max(0, ms) / 60_000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** Valor de uma métrica de limite, com a unidade certa. */
function metrica(nome, valor) {
  if (nome.endsWith('bps')) return bits(valor);
  if (nome === 'fps') return pacotes(valor, 'fluxos/s');
  if (nome === 'syn_pps') return pacotes(valor, 'SYN/s');
  return pacotes(valor);
}

module.exports = { num, bits, pacotes, bytes, dataHora, duracao, metrica };
