'use strict';

const { Router } = require('express');
const { receber } = require('../lib/posicoes');
const { ErroNegocio } = require('../lib/erros');

const verdadeiro = (x) => (x === undefined || x === null || x === '' ? null : ['1', 'true', 'on', 'sim'].includes(String(x).toLowerCase()));

/** Hora enviada pelo app: segundos ou milissegundos desde 1970, ou data ISO / 'AAAA-MM-DD HH:MM:SS' (UTC). */
function hora(x) {
  if (x === undefined || x === null || x === '') return null;
  if (/^\d+(\.\d+)?$/.test(String(x))) {
    const n = Number(x);
    return new Date(n > 1e12 ? n : n * 1000).toISOString();
  }
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(String(x)) ? String(x) : `${String(x).replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Protocolo OsmAnd (HTTP), usado pelo app Traccar Client (Android e iPhone) e por vários rastreadores:
 * - parâmetros: ?id=IDENTIFICADOR&lat=..&lon=..&timestamp=..&speed=(nós)&bearing=..&altitude=..&batt=..&ignition=true&alarm=sos
 * - ou JSON do Traccar Client mais novo: { device_id, location: { timestamp, coords: { latitude, longitude, speed (m/s), heading, altitude }, battery } }.
 * Responde 200 mesmo para equipamento não cadastrado (ele aparece em Rastreadores → Não cadastrados), para o app não acumular a fila.
 */
module.exports = (db) => {
  const r = Router();

  const tratar = (req, res) => {
    const q = { ...req.query, ...(req.body && typeof req.body === 'object' ? req.body : {}) };
    let m;
    if (q.location && typeof q.location === 'object') {
      const l = q.location;
      const c = l.coords ?? {};
      m = {
        imei: q.device_id ?? l.extras?.device_id,
        lat: c.latitude, lng: c.longitude, velocidade_kmh: Number(c.speed) > 0 ? Number(c.speed) * 3.6 : 0, curso: Number(c.heading) >= 0 ? c.heading : null,
        altitude: c.altitude, gps_em: hora(l.timestamp), evento: l.extras?.alarm === 'sos' ? 'panico' : null,
      };
    } else {
      m = {
        imei: q.id ?? q.deviceid,
        lat: q.lat, lng: q.lon ?? q.lng, velocidade_kmh: Number(q.speed) > 0 ? Number(q.speed) * 1.852 : 0, curso: q.bearing ?? q.heading,
        altitude: q.altitude, gps_em: hora(q.timestamp), ignicao: verdadeiro(q.ignition), evento: q.alarm === 'sos' ? 'panico' : null,
        valido: q.valid === undefined ? true : verdadeiro(q.valid) !== false,
      };
    }
    if (!/^[A-Za-z0-9._-]{4,40}$/.test(String(m.imei ?? ''))) throw new ErroNegocio('Identificador do equipamento ausente ou inválido.', 400);
    receber(db, { ...m, imei: String(m.imei), protocolo: 'osmand', ip: req.ip });
    res.status(200).end();
  };
  r.get('/', tratar);
  r.post('/', tratar);
  return r;
};
