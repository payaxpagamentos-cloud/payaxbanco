'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const secret = process.env.RASTREADOR_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.RASTREADOR_SECRET && process.env.NODE_ENV !== 'test') {
  console.warn('[Rastreador] RASTREADOR_SECRET não definido: usando segredo temporário (sessões expiram ao reiniciar).');
}

const producao = process.env.NODE_ENV === 'production';

// Em produção, recusa iniciar com segredos ausentes ou fracos.
if (producao) {
  const faltando = ['RASTREADOR_SECRET', 'RASTREADOR_ADMIN_SENHA'].filter((k) => !process.env[k]);
  if (faltando.length) throw new Error(`[Rastreador] Produção sem configuração obrigatória: ${faltando.join(', ')}.`);
  if (process.env.RASTREADOR_SECRET.length < 32) throw new Error('[Rastreador] RASTREADOR_SECRET deve ter pelo menos 32 caracteres.');
  if (process.env.RASTREADOR_ADMIN_SENHA.length < 12) throw new Error('[Rastreador] RASTREADOR_ADMIN_SENHA deve ter pelo menos 12 caracteres.');
}

// Endereço em que o painel é publicado: '' (raiz do domínio) ou um caminho, como '/rastreador'.
const basePath = String(process.env.RASTREADOR_BASE_PATH || '').replace(/\/+$/, '').replace(/^(?=[^/])/, '/');
const latCentro = Number(process.env.RASTREADOR_MAPA_LAT);
const lngCentro = Number(process.env.RASTREADOR_MAPA_LNG);

module.exports = {
  producao,
  basePath,
  port: Number(process.env.PORT) || 3400,
  // Porta TCP em que os rastreadores do protocolo GT06 (e compatíveis) se conectam. 0 desliga.
  portaGt06: process.env.RASTREADOR_GT06_PORTA === undefined ? 5023 : Number(process.env.RASTREADOR_GT06_PORTA),
  dbFile: process.env.RASTREADOR_DB || path.join(__dirname, '..', 'data', 'rastreador.db'),
  secret,
  tokenTtlSeconds: 12 * 60 * 60,
  trustProxy: process.env.RASTREADOR_TRUST_PROXY ?? 'loopback',
  limiteLoginPorMinuto: Number(process.env.RASTREADOR_LIMITE_LOGIN) || 10,
  // Fuso das datas do dashboard e dos relatórios.
  fuso: process.env.RASTREADOR_FUSO || 'America/Sao_Paulo',
  mapa: {
    // Camada do OpenStreetMap (ou outro servidor de mapas no mesmo formato). O domínio entra na política de segurança das páginas.
    tiles: process.env.RASTREADOR_MAPA_TILES || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    atribuicao: process.env.RASTREADOR_MAPA_ATRIBUICAO || '&copy; colaboradores do OpenStreetMap',
    centro: [Number.isFinite(latCentro) ? latCentro : -23.5505, Number.isFinite(lngCentro) ? lngCentro : -46.6333],
  },
  admin: {
    nome: process.env.RASTREADOR_ADMIN_NOME || 'Master',
    email: process.env.RASTREADOR_ADMIN_EMAIL || 'master@rastreador.com.br',
    senha: process.env.RASTREADOR_ADMIN_SENHA || 'master123',
  },
};
