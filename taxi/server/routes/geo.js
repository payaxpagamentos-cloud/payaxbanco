'use strict';

const { Router } = require('express');
const config = require('../config');
const { ErroNegocio } = require('../lib/erros');
const v = require('../lib/validacao');

/**
 * Busca de endereços pelo servidor (Nominatim/OpenStreetMap por padrão), com cache e no máximo
 * uma consulta por segundo, como pede a política de uso do serviço público.
 */
const cache = new Map();
let fila = Promise.resolve();
let ultima = 0;

function consultar(caminho) {
  if (!config.geocoder.url) throw new ErroNegocio('Busca de endereços desligada: marque o ponto no mapa.', 503);
  if (cache.has(caminho)) return Promise.resolve(cache.get(caminho));
  const tarefa = fila.then(async () => {
    const espera = ultima + 1000 - Date.now();
    if (espera > 0) await new Promise((r) => setTimeout(r, espera));
    ultima = Date.now();
    const resp = await fetch(`${config.geocoder.url}${caminho}`, {
      headers: { 'User-Agent': `APP-Taxi/1.0 (${config.geocoder.contato})`, 'Accept-Language': 'pt-BR' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new ErroNegocio('Busca de endereços indisponível no momento.', 502);
    const dados = await resp.json();
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    cache.set(caminho, dados);
    return dados;
  });
  fila = tarefa.catch(() => {});
  return tarefa.catch((err) => {
    throw err instanceof ErroNegocio ? err : new ErroNegocio('Busca de endereços indisponível no momento.', 502);
  });
}

const resumo = (x) => ({ endereco: x.display_name, lat: Number(x.lat), lng: Number(x.lon) });

module.exports = () => {
  const r = Router();
  r.get('/buscar', async (req, res) => {
    const q = v.texto(req.query.q, 'o endereço', 200);
    v.exigir(q.length >= 3, 'Digite pelo menos 3 letras.');
    const perto = req.query.lat && req.query.lng
      ? `&viewbox=${Number(req.query.lng) - 0.5},${Number(req.query.lat) + 0.5},${Number(req.query.lng) + 0.5},${Number(req.query.lat) - 0.5}` : '';
    const dados = await consultar(`/search?format=jsonv2&limit=6&countrycodes=${encodeURIComponent(config.geocoder.paises)}&q=${encodeURIComponent(q)}${perto}`);
    res.json(dados.map(resumo));
  });
  r.get('/reverso', async (req, res) => {
    const lat = v.numero(req.query.lat, 'a latitude', { min: -90, max: 90 }).toFixed(5);
    const lng = v.numero(req.query.lng, 'a longitude', { min: -180, max: 180 }).toFixed(5);
    const dados = await consultar(`/reverse?format=jsonv2&zoom=18&lat=${lat}&lon=${lng}`);
    res.json(dados?.display_name ? resumo(dados) : { endereco: `${lat}, ${lng}`, lat: Number(lat), lng: Number(lng) });
  });
  return r;
};
