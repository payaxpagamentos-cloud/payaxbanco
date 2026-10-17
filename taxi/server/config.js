'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const secret = process.env.TAXI_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.TAXI_SECRET && process.env.NODE_ENV !== 'test') {
  console.warn('[APP Táxi] TAXI_SECRET não definido: usando segredo temporário (sessões expiram ao reiniciar).');
}

const producao = process.env.NODE_ENV === 'production';

// Em produção, recusa iniciar com segredos ausentes ou fracos.
if (producao) {
  const faltando = ['TAXI_SECRET', 'TAXI_ADMIN_SENHA'].filter((k) => !process.env[k]);
  if (faltando.length) throw new Error(`[APP Táxi] Produção sem configuração obrigatória: ${faltando.join(', ')}.`);
  if (process.env.TAXI_SECRET.length < 32) throw new Error('[APP Táxi] TAXI_SECRET deve ter pelo menos 32 caracteres.');
  if (process.env.TAXI_ADMIN_SENHA.length < 12) throw new Error('[APP Táxi] TAXI_ADMIN_SENHA deve ter pelo menos 12 caracteres.');
}

const [latCentro, lngCentro] = String(process.env.TAXI_MAPA_CENTRO || '-23.5505,-46.6333').split(',').map(Number);

module.exports = {
  producao,
  port: Number(process.env.PORT) || 3200,
  dbFile: process.env.TAXI_DB || path.join(__dirname, '..', 'data', 'taxi.db'),
  secret,
  tokenTtlSeconds: 12 * 60 * 60,
  trustProxy: process.env.TAXI_TRUST_PROXY ?? 'loopback',
  limiteLoginPorMinuto: Number(process.env.TAXI_LIMITE_LOGIN) || 10,
  // Fuso das datas de relatório e da bandeira 2.
  fuso: process.env.TAXI_FUSO || 'America/Sao_Paulo',
  mapa: {
    // Camada de mapa (OpenStreetMap por padrão). O domínio entra na política de segurança das páginas.
    tiles: process.env.TAXI_MAPA_TILES || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    atribuicao: process.env.TAXI_MAPA_ATRIBUICAO || '&copy; colaboradores do OpenStreetMap',
    centro: [Number.isFinite(latCentro) ? latCentro : -23.5505, Number.isFinite(lngCentro) ? lngCentro : -46.6333],
  },
  // Busca de endereços (Nominatim/OpenStreetMap por padrão). Vazio desliga a busca: os pontos são escolhidos no mapa.
  geocoder: {
    url: process.env.TAXI_GEOCODER_URL ?? 'https://nominatim.openstreetmap.org',
    contato: process.env.TAXI_GEOCODER_CONTATO || 'contato@apptaxi.com.br',
    paises: process.env.TAXI_GEOCODER_PAISES || 'br',
  },
  // Pagamentos: 'simulado' (testes: o passageiro aprova na tela) ou 'manual' (PIX na chave da plataforma, confirmado pela central;
  // cartão indisponível). A cobrança automática de PIX e cartão exige um intermediador de pagamentos (PSP) ligado em lib/pagamentos.js.
  pagamentos: process.env.TAXI_PAGAMENTOS || (producao ? 'manual' : 'simulado'),
  admin: {
    nome: process.env.TAXI_ADMIN_NOME || 'Administrador da Central',
    email: process.env.TAXI_ADMIN_EMAIL || 'admin@apptaxi.com.br',
    senha: process.env.TAXI_ADMIN_SENHA || 'admin123',
  },
};
