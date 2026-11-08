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

// Versão do pacote instalado (gravada pelo empacotar.js); no código de desenvolvimento, "desenvolvimento".
let versao = 'desenvolvimento';
try { versao = JSON.parse(require('node:fs').readFileSync(path.join(__dirname, 'versao.json'), 'utf8')).versao || versao; } catch { /* sem arquivo */ }

module.exports = {
  versao,
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
    // Mapa vetorial moderno (MapLibre), com um estilo para o tema claro e outro para o escuro. Padrão: OpenFreeMap (gratuito, sem chave).
    // "raster" em RASTREADOR_MAPA_ESTILO desliga o vetorial e usa a camada de imagens abaixo.
    estilo: process.env.RASTREADOR_MAPA_ESTILO === 'raster' ? null : (process.env.RASTREADOR_MAPA_ESTILO || 'https://tiles.openfreemap.org/styles/liberty'),
    estilo_escuro: process.env.RASTREADOR_MAPA_ESTILO === 'raster' ? null
      : (process.env.RASTREADOR_MAPA_ESTILO_ESCURO || process.env.RASTREADOR_MAPA_ESTILO || 'https://tiles.openfreemap.org/styles/dark'),
    // Estilo padrão: recebe o visual moderno do sistema (paleta clara e prédios planos). Um estilo próprio no .env é usado como vier.
    estilo_padrao: !process.env.RASTREADOR_MAPA_ESTILO,
    atribuicao_vetorial: process.env.RASTREADOR_MAPA_ATRIBUICAO_VETORIAL
      || '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> &copy; colaboradores do OpenStreetMap',
    // Camada de imagens (reserva quando o navegador não tem WebGL): mapa de ruas da Esri. Os servidores do OpenStreetMap bloqueiam
    // sistemas com muitos acessos e o CARTO passou a exigir chave. O domínio entra na política de segurança das páginas.
    tiles: process.env.RASTREADOR_MAPA_TILES || 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    atribuicao: process.env.RASTREADOR_MAPA_ATRIBUICAO || 'Mapa &copy; Esri, HERE, Garmin, colaboradores do OpenStreetMap',
    // Satélite (botão Mapa / Satélite): imagem do Esri World Imagery com os nomes de ruas e lugares por cima (como o modo híbrido).
    // Para outro provedor (ex.: MapTiler com chave), troque as URLs; RASTREADOR_SATELITE_ROTULOS vazio tira os nomes.
    satelite: {
      tiles: process.env.RASTREADOR_SATELITE_TILES || 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      rotulos: String(process.env.RASTREADOR_SATELITE_ROTULOS ?? [
        'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
        'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      ].join(' ')).split(/\s+/).filter(Boolean),
      atribuicao: process.env.RASTREADOR_SATELITE_ATRIBUICAO || 'Imagens &copy; Esri, Maxar, Earthstar Geographics',
    },
    centro: [Number.isFinite(latCentro) ? latCentro : -23.5505, Number.isFinite(lngCentro) ? lngCentro : -46.6333],
  },
  // Busca de endereços e endereço do veículo (Photon/OpenStreetMap). RASTREADOR_GEOCODER_URL vazio desliga.
  geocoder: {
    url: String(process.env.RASTREADOR_GEOCODER_URL ?? 'https://photon.komoot.io').replace(/\/+$/, ''),
    // Endereço do veículo: a rua vem do Nominatim (mede até o traçado da rua). Vazio usa só o Photon.
    reverso: String(process.env.RASTREADOR_GEOCODER_REVERSO_URL ?? 'https://nominatim.openstreetmap.org').replace(/\/+$/, ''),
    timeoutMs: Number(process.env.RASTREADOR_GEOCODER_TIMEOUT_MS) || 6000,
  },
  // WhatsApp pela Evolution API (a mesma do manager). Sem URL, os avisos ficam só no painel.
  whatsapp: {
    url: String(process.env.RASTREADOR_EVOLUTION_URL || '').replace(/\/+$/, ''),
    instancia: process.env.RASTREADOR_EVOLUTION_INSTANCIA || '',
    chave: process.env.RASTREADOR_EVOLUTION_CHAVE || '',
  },
  // Endereço público do painel (ex.: https://seu-dominio/rastreador), usado nos links das mensagens.
  urlPublica: String(process.env.RASTREADOR_URL_PUBLICA || '').replace(/\/+$/, ''),
  // Assistente com IA (Anthropic). Sem chave, o assistente fica desligado.
  ia: {
    chave: process.env.RASTREADOR_IA_CHAVE || '',
    modelo: process.env.RASTREADOR_IA_MODELO || 'claude-opus-5-5',
  },
  // Mapas do Google (Map Tiles API). Com a chave, o mapa de ruas e o satélite passam a ser os do Google; sem ela, os gratuitos.
  google: {
    chave: process.env.RASTREADOR_GOOGLE_MAPS_CHAVE || '',
    // Chave do Google Maps no navegador (Maps JavaScript API), como a "chave de demonstração": só o mapa e o satélite, sem
    // faturamento, mas com limite de uso. Vai para o navegador: restrinja-a ao endereço do site no Google Cloud.
    js_chave: process.env.RASTREADOR_GOOGLE_MAPS_JS_CHAVE || '',
  },
  admin: {
    nome: process.env.RASTREADOR_ADMIN_NOME || 'Master',
    email: process.env.RASTREADOR_ADMIN_EMAIL || 'master@rastreador.com.br',
    senha: process.env.RASTREADOR_ADMIN_SENHA || 'master123',
  },
};
