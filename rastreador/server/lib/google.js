'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

const config = require('../config');

/**
 * Mapas do Google pela Map Tiles API (2D): ruas e satélite com os nomes por cima (híbrido), em alta resolução.
 * Só é usado com a chave no .env (RASTREADOR_GOOGLE_MAPS_CHAVE). Cada tipo de mapa precisa de uma "sessão" (vale cerca de
 * 2 semanas), criada aqui e guardada até perto de vencer. A chave vai para o navegador nas imagens: restrinja-a no Google Cloud.
 */
const TIPOS = {
  mapa: { mapType: 'roadmap' },
  satelite: { mapType: 'satellite', layerTypes: ['layerRoadmap'] },
};
const sessoes = new Map();
// Quando o Google recusa (chave sem faturamento, API desligada), o sistema não tenta de novo a cada página aberta: espera
// 10 minutos e avisa uma vez por período. Sem isso, cada abertura do painel esperava o Google falhar e o log enchia.
const ESPERA_FALHA_MS = 10 * 60 * 1000;
let falhouEm = 0;

async function criarSessao(tipo) {
  const resp = await fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(config.google.chave)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...TIPOS[tipo], language: 'pt-BR', region: 'BR', scale: 'scaleFactor2x', highDpi: true }),
    signal: AbortSignal.timeout(8000),
  });
  const r = await resp.json().catch(() => ({}));
  if (!resp.ok || !r.session) throw new Error(r.error?.message || `Google respondeu ${resp.status}`);
  // Renova um dia antes de vencer.
  const vence = (Number(r.expiry) || Date.now() / 1000 + 86_400) * 1000 - 86_400_000;
  return { sessao: r.session, vence };
}

/** Sessões válidas de ruas e satélite, ou null sem chave (ou se o Google recusar: o sistema volta ao mapa gratuito). */
async function sessoesGoogle() {
  if (!config.google.chave) return null;
  if (Date.now() - falhouEm < ESPERA_FALHA_MS) return null;
  try {
    const r = {};
    for (const tipo of Object.keys(TIPOS)) {
      let s = sessoes.get(tipo);
      if (!s || s.vence < Date.now()) {
        s = await criarSessao(tipo);
        sessoes.set(tipo, s);
      }
      r[tipo] = s.sessao;
    }
    return { chave: config.google.chave, sessoes: r };
  } catch (err) {
    falhouEm = Date.now();
    console.error(`[Rastreador] Mapa do Google indisponível, usando o gratuito (nova tentativa em ${ESPERA_FALHA_MS / 60_000} min):`, err.message);
    return null;
  }
}

module.exports = { sessoesGoogle };
