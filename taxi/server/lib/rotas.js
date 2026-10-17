'use strict';

const config = require('../config');
const { ErroNegocio } = require('./erros');

/**
 * Rotas pelas ruas para o navegador do motorista e para a estimativa do preço fechado, com o OSRM
 * (motor de rotas livre sobre o mapa do OpenStreetMap). Em produção, rode um servidor OSRM próprio (TAXI_ROTAS_URL):
 * o servidor público de demonstração não aceita uso comercial.
 */
const cache = new Map();

const DIRECAO = {
  right: 'à direita', left: 'à esquerda', 'slight right': 'levemente à direita', 'slight left': 'levemente à esquerda',
  'sharp right': 'fechado à direita', 'sharp left': 'fechado à esquerda', straight: 'em frente', uturn: 'o retorno',
};
const LADO = { right: 'à direita', 'slight right': 'à direita', 'sharp right': 'à direita', left: 'à esquerda', 'slight left': 'à esquerda', 'sharp left': 'à esquerda' };
const minuscula = (t) => t[0].toLowerCase() + t.slice(1);
const ORDINAL = ['primeira', 'segunda', 'terceira', 'quarta', 'quinta', 'sexta', 'sétima', 'oitava'];

// Gênero do tipo de via, para "na Rua" / "no Túnel" / "pela Avenida" / "pelo Viaduto". Sem tipo conhecido (ex.: "SP-280"): "em" / "por".
const MASCULINOS = ['túnel', 'tunel', 'viaduto', 'largo', 'elevado', 'acesso', 'complexo', 'anel', 'corredor', 'pátio', 'trevo', 'caminho', 'beco',
  'eixo', 'rodoanel', 'contorno', 'parque', 'boulevard', 'jardim', 'loteamento', 'retorno'];
const FEMININOS = ['rua', 'avenida', 'av', 'av.', 'estrada', 'rodovia', 'alameda', 'travessa', 'praça', 'praca', 'ladeira', 'ponte', 'via', 'marginal',
  'passarela', 'vila', 'vereda', 'servidão', 'quadra', 'rótula'];
function preposicoes(via) {
  const tipo = via.split(/\s+/)[0].toLowerCase();
  if (MASCULINOS.includes(tipo)) return { em: 'no', por: 'pelo' };
  if (FEMININOS.includes(tipo)) return { em: 'na', por: 'pela' };
  return { em: 'em', por: 'por' };
}

/** Instrução em português para uma manobra do OSRM ({ type, modifier, exit } e o nome da via). */
function instrucao(m, via) {
  const pr = preposicoes(via || '');
  const naVia = via ? ` ${pr.em} ${via}` : '';
  const pelaVia = via ? ` ${pr.por} ${via}` : '';
  const dir = DIRECAO[m.modifier];
  const lado = LADO[m.modifier];
  const virar = () => {
    if (m.modifier === 'uturn') return `Faça o retorno${pelaVia ? ` para seguir${pelaVia}` : ''}`;
    if (m.modifier === 'straight' || !dir) return `Siga em frente${pelaVia}`;
    if (m.modifier?.startsWith('slight')) return `Mantenha-se ${lado}${naVia}`;
    if (m.modifier?.startsWith('sharp')) return `Vire ${dir.replace('fechado ', '')} (curva fechada)${naVia}`;
    return `Vire ${dir}${naVia}`;
  };
  switch (m.type) {
    case 'depart': return `Siga${pelaVia || ' em frente'}`;
    case 'arrive': return lado ? `Você chegou. O destino está ${lado}` : 'Você chegou ao destino';
    case 'turn': return virar();
    case 'end of road': return `No fim da via, ${minuscula(virar())}`;
    case 'continue': return m.modifier === 'uturn' ? virar() : `Continue${pelaVia || ' em frente'}`;
    case 'new name': return `Continue${pelaVia || ' em frente'}`;
    case 'merge': return `Entre${naVia || ' na via'}${lado ? ` ${lado}` : ''}`;
    case 'on ramp': return `Pegue o acesso${lado ? ` ${lado}` : ''}${via ? ` para ${via}` : ''}`;
    case 'off ramp': return `Pegue a saída${lado ? ` ${lado}` : ''}${via ? ` para ${via}` : ''}`;
    case 'fork': return `Na bifurcação, mantenha-se ${lado ?? 'em frente'}${via ? ` para ${via}` : ''}`;
    case 'roundabout': case 'rotary':
      return `Na rotatória, pegue a ${ORDINAL[(m.exit ?? 1) - 1] ?? `${m.exit}ª`} saída${via ? ` para ${via}` : ''}`;
    case 'roundabout turn': return `Na rotatória, ${minuscula(virar())}`;
    case 'exit roundabout': case 'exit rotary': return `Saia da rotatória${via ? ` para ${via}` : ''}`;
    default: return virar();
  }
}

/** Ícone (seta) da manobra para a tela do navegador. */
function seta(m) {
  if (m.type === 'arrive') return '🏁';
  if (m.type === 'depart') return '↑';
  if (['roundabout', 'rotary', 'roundabout turn'].includes(m.type)) return '⟳';
  return { right: '↱', left: '↰', 'slight right': '↗', 'slight left': '↖', 'sharp right': '↘', 'sharp left': '↙', uturn: '↶' }[m.modifier] ?? '↑';
}

/** Rota de carro entre dois pontos { lat, lng }: distância, duração, geometria [[lat, lng]] e manobras em português. */
async function rota(origem, destino) {
  if (!config.rotas.url) throw new ErroNegocio('Navegação indisponível: servidor de rotas não configurado.', 503);
  const coords = `${origem.lng.toFixed(6)},${origem.lat.toFixed(6)};${destino.lng.toFixed(6)},${destino.lat.toFixed(6)}`;
  if (cache.has(coords)) return cache.get(coords);
  let dados;
  try {
    const resp = await fetch(`${config.rotas.url}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true`, {
      headers: { 'User-Agent': 'APP-Taxi/1.0' }, signal: AbortSignal.timeout(config.rotas.timeoutMs),
    });
    dados = await resp.json();
  } catch {
    throw new ErroNegocio('Servidor de rotas indisponível no momento.', 502);
  }
  if (dados.code !== 'Ok' || !dados.routes?.length) throw new ErroNegocio('Não foi possível traçar a rota até este ponto.', 422);
  const r = dados.routes[0];
  const passos = r.legs.flatMap((l) => l.steps).map((p) => ({
    instrucao: instrucao(p.maneuver, p.name || p.ref || ''),
    seta: seta(p.maneuver),
    via: p.name || p.ref || '',
    distancia_m: Math.round(p.distance),
    duracao_s: Math.round(p.duration),
    local: [p.maneuver.location[1], p.maneuver.location[0]],
  }));
  const out = {
    distancia_m: Math.round(r.distance),
    duracao_s: Math.round(r.duration),
    geometria: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    passos,
  };
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  cache.set(coords, out);
  return out;
}

module.exports = { rota, instrucao, seta };
