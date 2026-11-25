'use strict';

const { agora, lerConfig } = require('../db');

/**
 * Clima do dia na tela do condomínio.
 *
 * Numa tela de elevador, o morador olha por alguns segundos. O que faz ele olhar de novo amanhã não é
 * o anúncio — é a informação útil: a temperatura de hoje e o que vem pela frente no prédio. Tela que
 * o morador procura vale mais para quem anuncia nela.
 *
 * Os dados vêm do Open-Meteo (gratuito, sem chave). Duas decisões:
 *
 *  - O servidor busca em segundo plano e guarda; a TV nunca espera por uma API de terceiro. Se a
 *    internet do servidor cair ou o serviço recusar, a tela simplesmente deixa de mostrar o clima —
 *    nada trava e nenhum anúncio deixa de passar.
 *  - A busca é por cidade, não por tela: dez prédios na mesma cidade usam uma consulta só.
 *
 * Depende de acesso à internet a partir do servidor, por isso vem desligado de fábrica.
 */

const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const PREVISAO = 'https://api.open-meteo.com/v1/forecast';
const VALIDADE_MIN = 30;

/** Códigos do Open-Meteo em português, com um nome de ícone que o player sabe desenhar. */
const CODIGOS = {
  0: ['Céu limpo', 'sol'],
  1: ['Sol entre nuvens', 'sol'],
  2: ['Parcialmente nublado', 'nuvem-sol'],
  3: ['Nublado', 'nuvem'],
  45: ['Neblina', 'nevoa'],
  48: ['Neblina com geada', 'nevoa'],
  51: ['Garoa fraca', 'chuva'],
  53: ['Garoa', 'chuva'],
  55: ['Garoa forte', 'chuva'],
  61: ['Chuva fraca', 'chuva'],
  63: ['Chuva', 'chuva'],
  65: ['Chuva forte', 'chuva'],
  66: ['Chuva congelante', 'chuva'],
  67: ['Chuva congelante forte', 'chuva'],
  71: ['Neve fraca', 'neve'],
  73: ['Neve', 'neve'],
  75: ['Neve forte', 'neve'],
  80: ['Pancadas de chuva', 'chuva'],
  81: ['Pancadas de chuva', 'chuva'],
  82: ['Pancadas fortes', 'chuva'],
  95: ['Tempestade', 'tempestade'],
  96: ['Tempestade com granizo', 'tempestade'],
  99: ['Tempestade com granizo', 'tempestade'],
};

const descrever = (codigo) => CODIGOS[codigo] ?? ['—', 'nuvem'];

async function buscarJson(url, ms = 6000) {
  const resposta = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { Accept: 'application/json' } });
  if (!resposta.ok) throw new Error(`${resposta.status}`);
  return resposta.json();
}

/** Coordenadas da cidade (guardadas no ponto, para não geocodificar de novo). */
async function coordenadas(db, cidade, uf) {
  const guardado = db.prepare('SELECT latitude, longitude FROM locais WHERE cidade = ? AND uf = ? AND latitude IS NOT NULL LIMIT 1').get(cidade, uf);
  if (guardado) return { latitude: guardado.latitude, longitude: guardado.longitude };
  const r = await buscarJson(`${GEO}?name=${encodeURIComponent(cidade)}&count=5&language=pt&format=json&country=BR`);
  const achado = (r.results ?? []).find((x) => !uf || (x.admin1 ?? '').toLowerCase().includes(uf.toLowerCase())) ?? (r.results ?? [])[0];
  if (!achado) return null;
  db.prepare('UPDATE locais SET latitude = ?, longitude = ? WHERE cidade = ? AND uf = ?').run(achado.latitude, achado.longitude, cidade, uf);
  return { latitude: achado.latitude, longitude: achado.longitude };
}

/** O clima guardado para a cidade, se ainda estiver fresco. */
function guardado(db, cidade, uf) {
  const c = db.prepare('SELECT * FROM clima WHERE cidade = ? AND uf = ?').get(cidade, uf);
  if (!c) return null;
  const idade = (Date.now() - Date.parse(c.atualizado_em)) / 60_000;
  if (idade > VALIDADE_MIN * 4) return null; // velho demais para mostrar como "agora"
  const [descricao, icone] = descrever(c.codigo);
  return {
    cidade: c.cidade,
    temperatura: Math.round(c.temperatura),
    maxima: c.maxima === null ? null : Math.round(c.maxima),
    minima: c.minima === null ? null : Math.round(c.minima),
    descricao,
    icone,
    atualizado_em: c.atualizado_em,
  };
}

/** Busca e guarda o clima de uma cidade. Devolve o que guardou, ou null quando não deu. */
async function atualizarCidade(db, cidade, uf) {
  try {
    const lugar = await coordenadas(db, cidade, uf);
    if (!lugar) return null;
    const r = await buscarJson(`${PREVISAO}?latitude=${lugar.latitude}&longitude=${lugar.longitude}`
      + '&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto');
    const atual = r.current ?? {};
    if (atual.temperature_2m === undefined) return null;
    db.prepare(`INSERT INTO clima (cidade, uf, temperatura, maxima, minima, codigo, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (cidade, uf) DO UPDATE SET temperatura = excluded.temperatura, maxima = excluded.maxima,
        minima = excluded.minima, codigo = excluded.codigo, atualizado_em = excluded.atualizado_em`)
      .run(cidade, uf, atual.temperature_2m, r.daily?.temperature_2m_max?.[0] ?? null, r.daily?.temperature_2m_min?.[0] ?? null,
        atual.weather_code ?? 0, agora());
    return guardado(db, cidade, uf);
  } catch {
    // Sem internet, serviço fora ou limite atingido: a tela fica sem o clima e segue exibindo.
    return null;
  }
}

/**
 * Atualiza as cidades que têm tela ativa (uma consulta por cidade, não por tela).
 * Chamado pelo servidor de tempos em tempos.
 */
async function atualizar(db) {
  if (!lerConfig(db).clima_ligado) return { ligado: false, cidades: 0 };
  const cidades = db.prepare(`SELECT DISTINCT l.cidade, l.uf FROM locais l JOIN telas t ON t.local_id = l.id
    WHERE l.status = 'ativo' AND t.status = 'ativa' AND l.cidade IS NOT NULL AND l.uf IS NOT NULL`).all();
  let ok = 0;
  for (const c of cidades) {
    const atual = db.prepare('SELECT atualizado_em FROM clima WHERE cidade = ? AND uf = ?').get(c.cidade, c.uf);
    if (atual && (Date.now() - Date.parse(atual.atualizado_em)) / 60_000 < VALIDADE_MIN) { ok++; continue; }
    if (await atualizarCidade(db, c.cidade, c.uf)) ok++;
  }
  return { ligado: true, cidades: cidades.length, atualizadas: ok };
}

/** O que vai para a tela daquele ponto (null quando está desligado ou ainda não há dado). */
function doPonto(db, local) {
  // Sem cidade e UF não há o que consultar (nem toda chamada traz o ponto completo).
  if (!local?.cidade || !local?.uf || !lerConfig(db).clima_ligado) return null;
  return guardado(db, local.cidade, local.uf);
}

module.exports = { atualizar, atualizarCidade, doPonto, descrever, CODIGOS };
