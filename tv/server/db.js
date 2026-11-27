'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { hashSenha } = require('./lib/senha');

// Valores em centavos (inteiros), durações em segundos e tamanhos em bytes. Carimbos de tempo em ISO 8601 (UTC).
// Classificação indicativa como número: 0 = Livre, 10, 12, 14, 16 e 18 anos (assim o perfil infantil compara direto).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  telefone TEXT,
  senha_hash TEXT NOT NULL,
  -- admin: tudo; curador: conteúdo e grade, sem financeiro nem equipe; assinante: só assiste.
  perfil TEXT NOT NULL CHECK (perfil IN ('admin','curador','assinante')),
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_acesso TEXT,
  criado_em TEXT NOT NULL
);

-- Perfis de visualização da conta (como na TV: "Família", "Infantil"). Cada um tem sua lista e seu progresso.
CREATE TABLE IF NOT EXISTS perfis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  cor TEXT NOT NULL DEFAULT '#E50914',
  -- Mascote escolhido como foto do perfil (arquivo em public/img/mascotes). É obrigatório na
  -- criação; perfis antigos recebem um na migração, para nenhum ficar sem foto.
  avatar TEXT,
  infantil INTEGER NOT NULL DEFAULT 0,
  classificacao_max INTEGER NOT NULL DEFAULT 18 CHECK (classificacao_max IN (0,10,12,14,16,18)),
  pin_hash TEXT,
  principal INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL,
  UNIQUE (usuario_id, nome)
);

CREATE TABLE IF NOT EXISTS planos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  descricao TEXT,
  preco_centavos INTEGER NOT NULL CHECK (preco_centavos >= 0),
  periodicidade TEXT NOT NULL DEFAULT 'mensal' CHECK (periodicidade IN ('mensal','anual')),
  telas INTEGER NOT NULL DEFAULT 1 CHECK (telas BETWEEN 1 AND 10),
  perfis_max INTEGER NOT NULL DEFAULT 4 CHECK (perfis_max BETWEEN 1 AND 10),
  qualidade TEXT NOT NULL DEFAULT 'hd' CHECK (qualidade IN ('sd','hd','fullhd','4k')),
  downloads INTEGER NOT NULL DEFAULT 0,
  canais_ao_vivo INTEGER NOT NULL DEFAULT 1,
  -- Nível do plano: um título ou canal com plano mínimo exige assinatura deste nível ou acima.
  nivel INTEGER NOT NULL DEFAULT 1 CHECK (nivel BETWEEN 1 AND 9),
  ordem INTEGER NOT NULL DEFAULT 0,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assinaturas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  plano_id INTEGER NOT NULL REFERENCES planos(id),
  -- pendente: aguardando o primeiro pagamento; ativa; suspensa (fatura vencida); cancelada.
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','ativa','suspensa','cancelada')),
  inicio TEXT,
  -- Dia em que o acesso vale até (pago até) e a data da próxima cobrança.
  acesso_ate TEXT,
  proxima_cobranca TEXT,
  cancelar_no_fim INTEGER NOT NULL DEFAULT 0,
  motivo TEXT,
  criada_em TEXT NOT NULL,
  atualizada_em TEXT NOT NULL,
  cancelada_em TEXT
);
-- Uma assinatura viva por conta (a cancelada fica no histórico).
CREATE UNIQUE INDEX IF NOT EXISTS idx_assinatura_viva ON assinaturas(usuario_id) WHERE status <> 'cancelada';

CREATE TABLE IF NOT EXISTS faturas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assinatura_id INTEGER NOT NULL REFERENCES assinaturas(id),
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  competencia TEXT NOT NULL,
  descricao TEXT NOT NULL,
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos >= 0),
  vencimento TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','paga','cancelada')),
  forma TEXT NOT NULL DEFAULT 'pix' CHECK (forma IN ('pix','cartao')),
  txid TEXT,
  pix_copia_cola TEXT,
  criada_em TEXT NOT NULL,
  paga_em TEXT,
  confirmada_por INTEGER REFERENCES usuarios(id)
);
-- Uma fatura viva por competência; a cancelada sai do caminho e deixa emitir outra.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fatura_competencia ON faturas(assinatura_id, competencia) WHERE status <> 'cancelada';
CREATE INDEX IF NOT EXISTS idx_faturas_status ON faturas(status, vencimento);
CREATE INDEX IF NOT EXISTS idx_faturas_usuario ON faturas(usuario_id, id);

-- Arquivos enviados pelo painel: vídeos, artes e legendas. Guardados fora da pasta pública, com nome aleatório.
CREATE TABLE IF NOT EXISTS midias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL CHECK (tipo IN ('video','imagem','legenda')),
  arquivo TEXT NOT NULL,
  nome_original TEXT NOT NULL,
  mime TEXT NOT NULL,
  tamanho INTEGER NOT NULL DEFAULT 0,
  recebido INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  duracao_s INTEGER,
  largura INTEGER,
  altura INTEGER,
  qualidade TEXT CHECK (qualidade IS NULL OR qualidade IN ('sd','hd','fullhd','4k')),
  idioma TEXT,
  rotulo TEXT,
  -- enviando: upload em pedaços em andamento; pronta: fechada e conferida; erro.
  status TEXT NOT NULL DEFAULT 'enviando' CHECK (status IN ('enviando','pronta','erro')),
  enviado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  concluido_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_midias_status ON midias(status, id);

CREATE TABLE IF NOT EXISTS canais (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero INTEGER NOT NULL UNIQUE,
  nome TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  descricao TEXT,
  categoria TEXT NOT NULL DEFAULT 'aberta'
    CHECK (categoria IN ('aberta','noticias','esportes','filmes','series','infantil','documentarios','musica','variedades','religioso','local')),
  -- Como o canal chega ao assinante:
  --   'hls'   = sinal próprio ou contratado, em lista .m3u8 (com ou sem transmissão nossa);
  --   'rtmp'  = sinal entregue em RTMP pelo fornecedor; o servidor converte para HLS (lib/aovivo.js);
  --   'embed' = player oficial e público da emissora (abrimos o player dela, com os anúncios dela).
  fonte TEXT NOT NULL DEFAULT 'hls' CHECK (fonte IN ('hls','rtmp','embed')),
  -- Endereço de onde o sinal vem: a lista .m3u8 (fonte 'hls') ou o rtmp:// do fornecedor
  -- (fonte 'rtmp'). Vazio enquanto o sinal não chega.
  url_hls TEXT,
  -- Endereço do player oficial da emissora (quando fonte = 'embed').
  url_embed TEXT,
  -- Recado da operação: de quem pedir o sinal, número do contrato, contato da afiliada.
  observacao TEXT,
  -- Alguns sinais só respondem com cabeçalhos próprios (User-Agent, Referer). JSON, usado pela transmissão.
  cabecalhos TEXT,
  -- 1: o sinal passa pelos nossos servidores; 0: o player vai direto na origem.
  relay INTEGER NOT NULL DEFAULT 1,
  logo_midia_id INTEGER REFERENCES midias(id),
  -- Claridade do logo, de 0 (preto) a 1 (branco), medida quando ele é salvo.
  -- Serve para a tela escolher o fundo: logo escuro sobre fundo preto simplesmente some, e
  -- fundo branco para todos faria sumir os logos claros. Medir cada um é o único jeito.
  logo_luz REAL,
  -- Identificador do canal na lista pública (iptv-org): serve para buscar o logo oficial.
  id_publico TEXT,
  -- Identificador do canal no XMLTV da grade (varia conforme o provedor de EPG).
  id_epg TEXT,
  plano_minimo_id INTEGER REFERENCES planos(id),
  classificacao INTEGER NOT NULL DEFAULT 0 CHECK (classificacao IN (0,10,12,14,16,18)),
  regiao TEXT,
  ordem INTEGER NOT NULL DEFAULT 0,
  ativo INTEGER NOT NULL DEFAULT 1,
  -- Última verificação automática do sinal (a operação vê o canal fora do ar no painel).
  sinal_status TEXT CHECK (sinal_status IS NULL OR sinal_status IN ('ok','falha')),
  sinal_detalhe TEXT,
  sinal_em TEXT,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_canais_ativo ON canais(ativo, ordem, numero);

-- Grade de programação (EPG) de cada canal.
CREATE TABLE IF NOT EXISTS programas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canal_id INTEGER NOT NULL REFERENCES canais(id) ON DELETE CASCADE,
  titulo TEXT NOT NULL,
  subtitulo TEXT,
  descricao TEXT,
  inicio TEXT NOT NULL,
  fim TEXT NOT NULL,
  categoria TEXT,
  classificacao INTEGER NOT NULL DEFAULT 0 CHECK (classificacao IN (0,10,12,14,16,18)),
  ao_vivo INTEGER NOT NULL DEFAULT 0,
  temporada INTEGER,
  episodio INTEGER,
  criado_em TEXT NOT NULL,
  UNIQUE (canal_id, inicio)
);
CREATE INDEX IF NOT EXISTS idx_programas_grade ON programas(canal_id, inicio, fim);
CREATE INDEX IF NOT EXISTS idx_programas_agora ON programas(inicio, fim);

CREATE TABLE IF NOT EXISTS generos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  ordem INTEGER NOT NULL DEFAULT 0
);

-- Filmes e séries do catálogo sob demanda (conteúdo próprio ou licenciado).
CREATE TABLE IF NOT EXISTS titulos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL CHECK (tipo IN ('filme','serie')),
  nome TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  nome_original TEXT,
  sinopse TEXT,
  ano INTEGER,
  pais TEXT,
  classificacao INTEGER NOT NULL DEFAULT 0 CHECK (classificacao IN (0,10,12,14,16,18)),
  duracao_s INTEGER,
  elenco TEXT,
  direcao TEXT,
  -- rascunho: só o painel vê; publicado: no ar; arquivado: sai do catálogo sem perder o histórico.
  situacao TEXT NOT NULL DEFAULT 'rascunho' CHECK (situacao IN ('rascunho','publicado','arquivado')),
  capa_midia_id INTEGER REFERENCES midias(id),
  banner_midia_id INTEGER REFERENCES midias(id),
  trailer_midia_id INTEGER REFERENCES midias(id),
  video_midia_id INTEGER REFERENCES midias(id),
  plano_minimo_id INTEGER REFERENCES planos(id),
  original INTEGER NOT NULL DEFAULT 0,
  estreia TEXT,
  publicado_em TEXT,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_titulos_situacao ON titulos(situacao, publicado_em);
CREATE INDEX IF NOT EXISTS idx_titulos_tipo ON titulos(tipo, situacao);

CREATE TABLE IF NOT EXISTS titulo_generos (
  titulo_id INTEGER NOT NULL REFERENCES titulos(id) ON DELETE CASCADE,
  genero_id INTEGER NOT NULL REFERENCES generos(id) ON DELETE CASCADE,
  PRIMARY KEY (titulo_id, genero_id)
);

CREATE TABLE IF NOT EXISTS temporadas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo_id INTEGER NOT NULL REFERENCES titulos(id) ON DELETE CASCADE,
  numero INTEGER NOT NULL CHECK (numero > 0),
  nome TEXT,
  sinopse TEXT,
  ano INTEGER,
  UNIQUE (titulo_id, numero)
);

CREATE TABLE IF NOT EXISTS episodios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo_id INTEGER NOT NULL REFERENCES titulos(id) ON DELETE CASCADE,
  temporada_id INTEGER NOT NULL REFERENCES temporadas(id) ON DELETE CASCADE,
  numero INTEGER NOT NULL CHECK (numero > 0),
  nome TEXT NOT NULL,
  sinopse TEXT,
  duracao_s INTEGER,
  video_midia_id INTEGER REFERENCES midias(id),
  thumb_midia_id INTEGER REFERENCES midias(id),
  estreia TEXT,
  situacao TEXT NOT NULL DEFAULT 'rascunho' CHECK (situacao IN ('rascunho','publicado')),
  criado_em TEXT NOT NULL,
  UNIQUE (temporada_id, numero)
);
CREATE INDEX IF NOT EXISTS idx_episodios_titulo ON episodios(titulo_id, temporada_id, numero);

-- Versões do mesmo conteúdo em qualidades diferentes (SD, HD, Full HD e 4K).
-- O título (ou o episódio) aponta para a versão principal em video_midia_id; aqui ficam todas,
-- e o player escolhe a melhor que o plano do assinante permite.
CREATE TABLE IF NOT EXISTS versoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo_id INTEGER REFERENCES titulos(id) ON DELETE CASCADE,
  episodio_id INTEGER REFERENCES episodios(id) ON DELETE CASCADE,
  midia_id INTEGER NOT NULL REFERENCES midias(id),
  qualidade TEXT NOT NULL CHECK (qualidade IN ('sd','hd','fullhd','4k')),
  criado_em TEXT NOT NULL,
  CHECK ((titulo_id IS NULL) <> (episodio_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_versao_titulo ON versoes(titulo_id, qualidade) WHERE titulo_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_versao_episodio ON versoes(episodio_id, qualidade) WHERE episodio_id IS NOT NULL;

-- Fila de conversão: a partir de um arquivo enviado, o servidor gera as versões menores
-- (Full HD, HD e SD) com o ffmpeg, uma de cada vez, sem travar o painel.
CREATE TABLE IF NOT EXISTS conversoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  midia_id INTEGER NOT NULL REFERENCES midias(id) ON DELETE CASCADE,
  titulo_id INTEGER REFERENCES titulos(id) ON DELETE CASCADE,
  episodio_id INTEGER REFERENCES episodios(id) ON DELETE CASCADE,
  qualidade TEXT NOT NULL CHECK (qualidade IN ('sd','hd','fullhd','4k')),
  -- fila: esperando a vez; convertendo: ffmpeg rodando; pronta; erro; cancelada.
  situacao TEXT NOT NULL DEFAULT 'fila' CHECK (situacao IN ('fila','convertendo','pronta','erro','cancelada')),
  progresso INTEGER NOT NULL DEFAULT 0,
  erro TEXT,
  saida_midia_id INTEGER REFERENCES midias(id),
  criado_em TEXT NOT NULL,
  concluido_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_conversoes_situacao ON conversoes(situacao, id);

-- Legendas de um filme ou episódio (arquivo .vtt).
CREATE TABLE IF NOT EXISTS legendas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo_id INTEGER REFERENCES titulos(id) ON DELETE CASCADE,
  episodio_id INTEGER REFERENCES episodios(id) ON DELETE CASCADE,
  midia_id INTEGER NOT NULL REFERENCES midias(id),
  idioma TEXT NOT NULL DEFAULT 'pt-BR',
  rotulo TEXT NOT NULL DEFAULT 'Português',
  padrao INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_legendas_item ON legendas(titulo_id, episodio_id);

-- Destaques do topo da home (o "hero" que passa sozinho).
CREATE TABLE IF NOT EXISTS destaques (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo_id INTEGER REFERENCES titulos(id) ON DELETE CASCADE,
  canal_id INTEGER REFERENCES canais(id) ON DELETE CASCADE,
  chamada TEXT,
  descricao TEXT,
  arte_midia_id INTEGER REFERENCES midias(id),
  ordem INTEGER NOT NULL DEFAULT 0,
  inicio TEXT,
  fim TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL,
  CHECK (titulo_id IS NOT NULL OR canal_id IS NOT NULL)
);

-- Fileiras da home, montadas pela curadoria ("Em alta", "Novidades", "Ação", "Canais ao vivo").
CREATE TABLE IF NOT EXISTS fileiras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('manual','novidades','em_alta','genero','originais','canais','filmes','series')),
  genero_id INTEGER REFERENCES generos(id) ON DELETE CASCADE,
  limite INTEGER NOT NULL DEFAULT 20 CHECK (limite BETWEEN 1 AND 60),
  ordem INTEGER NOT NULL DEFAULT 0,
  ativa INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fileira_itens (
  fileira_id INTEGER NOT NULL REFERENCES fileiras(id) ON DELETE CASCADE,
  titulo_id INTEGER NOT NULL REFERENCES titulos(id) ON DELETE CASCADE,
  ordem INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (fileira_id, titulo_id)
);

-- Minha lista, por perfil de visualização.
CREATE TABLE IF NOT EXISTS favoritos (
  perfil_id INTEGER NOT NULL REFERENCES perfis(id) ON DELETE CASCADE,
  titulo_id INTEGER NOT NULL REFERENCES titulos(id) ON DELETE CASCADE,
  criado_em TEXT NOT NULL,
  PRIMARY KEY (perfil_id, titulo_id)
);

-- Continuar assistindo. episodio_id = 0 quando é filme (assim a chave única funciona no SQLite).
CREATE TABLE IF NOT EXISTS progresso (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  perfil_id INTEGER NOT NULL REFERENCES perfis(id) ON DELETE CASCADE,
  titulo_id INTEGER NOT NULL REFERENCES titulos(id) ON DELETE CASCADE,
  episodio_id INTEGER NOT NULL DEFAULT 0,
  segundos INTEGER NOT NULL DEFAULT 0 CHECK (segundos >= 0),
  duracao_s INTEGER NOT NULL DEFAULT 0,
  concluido INTEGER NOT NULL DEFAULT 0,
  atualizado_em TEXT NOT NULL,
  UNIQUE (perfil_id, titulo_id, episodio_id)
);
CREATE INDEX IF NOT EXISTS idx_progresso_perfil ON progresso(perfil_id, atualizado_em);

-- Cada tela assistindo. Serve para o limite de telas simultâneas do plano e para a audiência.
CREATE TABLE IF NOT EXISTS sessoes_player (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  perfil_id INTEGER NOT NULL REFERENCES perfis(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('canal','filme','episodio','trailer')),
  canal_id INTEGER REFERENCES canais(id) ON DELETE SET NULL,
  titulo_id INTEGER REFERENCES titulos(id) ON DELETE SET NULL,
  episodio_id INTEGER REFERENCES episodios(id) ON DELETE SET NULL,
  dispositivo TEXT,
  ip TEXT,
  qualidade TEXT,
  segundos INTEGER NOT NULL DEFAULT 0,
  iniciada_em TEXT NOT NULL,
  ultimo_ping TEXT NOT NULL,
  encerrada_em TEXT,
  motivo_fim TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessoes_vivas ON sessoes_player(usuario_id, encerrada_em, ultimo_ping);
CREATE INDEX IF NOT EXISTS idx_sessoes_audiencia ON sessoes_player(iniciada_em);

CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER REFERENCES usuarios(id),
  acao TEXT NOT NULL,
  detalhes TEXT,
  ip TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auditoria_data ON auditoria(criado_em);

CREATE TABLE IF NOT EXISTS configuracoes (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
`;

// Planos iniciais (a operação ajusta preços e limites no painel).
const PLANOS_PADRAO = [
  // slug, nome, descrição, preço, telas, perfis, qualidade, downloads, nível, ordem
  ['essencial', 'Essencial', 'Todos os canais ao vivo e o catálogo completo em uma tela, em HD.', 1990, 1, 2, 'hd', 0, 1, 1],
  ['familia', 'Família', 'Quatro telas ao mesmo tempo, Full HD e downloads para assistir sem internet.', 3990, 4, 5, 'fullhd', 1, 2, 2],
  ['cinema', 'Cinema 4K', 'Seis telas, 4K com HDR, downloads e os lançamentos em primeira mão.', 5990, 6, 6, '4k', 1, 3, 3],
];

const GENEROS_PADRAO = ['Ação', 'Aventura', 'Comédia', 'Documentário', 'Drama', 'Esportes', 'Fantasia', 'Infantil', 'Jornalismo',
  'Novela', 'Reality', 'Romance', 'Suspense', 'Terror', 'Variedades'];

const FILEIRAS_PADRAO = [
  // nome, tipo, limite, ordem
  ['Canais ao vivo agora', 'canais', 20, 1],
  ['Em alta na PLAY TECH VIP', 'em_alta', 20, 2],
  ['Novidades', 'novidades', 20, 3],
  ['Originais PLAY TECH VIP', 'originais', 20, 4],
  ['Séries para maratonar', 'series', 20, 5],
  ['Filmes', 'filmes', 20, 6],
];

const CONFIG_PADRAO = {
  pix_chave: '',
  pix_recebedor: 'PLAY TECH VIP',
  pix_cidade: 'SAO PAULO',
  // Dias entre o vencimento da fatura e a suspensão do acesso.
  carencia_dias: '5',
  // Dias de antecedência para gerar a próxima fatura.
  antecedencia_fatura_dias: '5',
  // Marca o título como "concluído" quando falta menos que isto para o fim (segundos).
  creditos_s: '90',
  // Quanto do começo é descartado ao retomar (volta um pouco atrás, como nos grandes streamings).
  retomar_folga_s: '5',
  aviso_home: '',
  // Grade dos canais abertos: endereço de um arquivo XMLTV que a plataforma importa sozinha,
  // uma vez por dia (o provedor é escolhido pela operação).
  epg_url: '',
  epg_importado_em: '',
};

const agora = () => new Date().toISOString();

function abrir(arquivo = config.dbFile) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  migrar(db);

  const plano = db.prepare(`INSERT OR IGNORE INTO planos (slug, nome, descricao, preco_centavos, telas, perfis_max, qualidade, downloads, nivel, ordem, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const p of PLANOS_PADRAO) plano.run(...p, agora());
  const genero = db.prepare('INSERT OR IGNORE INTO generos (nome, slug, ordem) VALUES (?, ?, ?)');
  GENEROS_PADRAO.forEach((nome, i) => genero.run(nome, slug(nome), i + 1));
  if (!db.prepare('SELECT 1 FROM fileiras LIMIT 1').get()) {
    const fileira = db.prepare('INSERT INTO fileiras (nome, tipo, limite, ordem, criado_em) VALUES (?, ?, ?, ?, ?)');
    for (const f of FILEIRAS_PADRAO) fileira.run(...f, agora());
  }
  const cfg = db.prepare('INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES (?, ?)');
  for (const [k, val] of Object.entries(CONFIG_PADRAO)) cfg.run(k, val);

  const temAdmin = db.prepare("SELECT 1 FROM usuarios WHERE perfil = 'admin' LIMIT 1").get();
  if (!temAdmin) {
    db.prepare("INSERT INTO usuarios (nome, email, senha_hash, perfil, criado_em) VALUES (?, ?, ?, 'admin', ?)")
      .run(config.admin.nome, config.admin.email, hashSenha(config.admin.senha), agora());
  }
  return db;
}

/** Acrescenta colunas que entraram depois, em bancos já criados. */
/**
 * Abre espaço para 'fullhd' no CHECK de uma tabela que já existe.
 * Mexer no texto do schema é o caminho curto: a alternativa seria recriar a tabela, e midias
 * é apontada por meia dúzia de outras.
 */
function aceitarFullHd(db, tabela) {
  const linha = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tabela);
  if (!linha || String(linha.sql).includes("'fullhd'")) return;
  try {
    db.exec('PRAGMA writable_schema = ON');
    db.prepare("UPDATE sqlite_master SET sql = replace(sql, ?, ?) WHERE type = 'table' AND name = ?")
      .run("'sd','hd','4k'", "'sd','hd','fullhd','4k'", tabela);
    db.exec('PRAGMA writable_schema = RESET');
  } catch {
    db.exec('PRAGMA writable_schema = OFF');
  }
}

/**
 * Abre espaço para 'rtmp' no CHECK de fonte, em canais que já existem.
 * Mesmo caminho do aceitarFullHd: recriar a tabela canais custaria mais (programas, destaques e
 * sessões apontam para ela) do que acertar o texto do schema.
 */
function aceitarRtmp(db) {
  const linha = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'canais'").get();
  if (!linha || String(linha.sql).includes("'rtmp'")) return;
  try {
    db.exec('PRAGMA writable_schema = ON');
    db.prepare("UPDATE sqlite_master SET sql = replace(sql, ?, ?) WHERE type = 'table' AND name = 'canais'")
      .run("'hls','embed'", "'hls','rtmp','embed'");
    db.exec('PRAGMA writable_schema = RESET');
  } catch {
    db.exec('PRAGMA writable_schema = OFF');
  }
}

function migrar(db) {
  aceitarFullHd(db, 'planos');
  aceitarFullHd(db, 'midias');
  aceitarRtmp(db);
  const colunas = db.prepare('PRAGMA table_info(canais)').all().map((c) => c.name);
  if (!colunas.includes('fonte')) db.exec("ALTER TABLE canais ADD COLUMN fonte TEXT NOT NULL DEFAULT 'hls'");
  if (!colunas.includes('url_embed')) db.exec('ALTER TABLE canais ADD COLUMN url_embed TEXT');
  if (!colunas.includes('observacao')) db.exec('ALTER TABLE canais ADD COLUMN observacao TEXT');
  if (!colunas.includes('cabecalhos')) db.exec('ALTER TABLE canais ADD COLUMN cabecalhos TEXT');
  if (!colunas.includes('id_publico')) db.exec('ALTER TABLE canais ADD COLUMN id_publico TEXT');
  if (!colunas.includes('id_epg')) db.exec('ALTER TABLE canais ADD COLUMN id_epg TEXT');
  if (!colunas.includes('logo_luz')) db.exec('ALTER TABLE canais ADD COLUMN logo_luz REAL');
  // Codecs que a origem entrega, guardados no último teste de sinal. Servem para a conversão
  // escolher o que fazer com cada canal sem abrir uma segunda conexão na origem (muito
  // fornecedor só aceita uma). Canal com áudio em AC-3, por exemplo, sai mudo no Android se for
  // copiado como está — e custa 1% de processador converter só o áudio para AAC.
  if (!colunas.includes('sinal_video')) db.exec('ALTER TABLE canais ADD COLUMN sinal_video TEXT');
  if (!colunas.includes('sinal_audio')) db.exec('ALTER TABLE canais ADD COLUMN sinal_audio TEXT');

  const colunasPerfis = db.prepare('PRAGMA table_info(perfis)').all().map((c) => c.name);
  if (!colunasPerfis.includes('avatar')) {
    db.exec('ALTER TABLE perfis ADD COLUMN avatar TEXT');
    // Perfil que já existia não pode ficar sem foto: recebe um mascote escolhido pelo nome,
    // sempre o mesmo para o mesmo nome, para não mudar a cada atualização.
    const perfis = db.prepare('SELECT id, nome FROM perfis').all();
    const põe = db.prepare('UPDATE perfis SET avatar = ? WHERE id = ?');
    for (const p of perfis) põe.run(MASCOTES[somaDoNome(p.nome) % MASCOTES.length], p.id);
  }
}

/** Mascotes disponíveis (os arquivos em public/img/mascotes). */
const MASCOTES = ['leao', 'raposa', 'panda', 'coruja', 'gato', 'robo',
  'astronauta', 'dino', 'urso', 'pinguim', 'tigre', 'alien'];

const somaDoNome = (nome) => [...String(nome ?? '')].reduce((a, c) => a + c.charCodeAt(0), 0);

/** Mascote para o perfil criado automaticamente (cadastro, balcão, demonstração).
 *  Sempre o mesmo para o mesmo nome, para não trocar de cara a cada reinstalação. */
const mascoteDe = (nome) => MASCOTES[somaDoNome(nome) % MASCOTES.length];

/** Endereço amigável: "Cine Aberta 2" -> "cine-aberta-2". */
function slug(texto) {
  return String(texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
}

const abertas = new WeakSet();
/** Executa fn numa transação (aninhada vira parte da externa). */
function transacao(db, fn) {
  if (abertas.has(db)) return fn();
  db.exec('BEGIN IMMEDIATE');
  abertas.add(db);
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    abertas.delete(db);
  }
}

/** Configurações como números, menos as de texto. */
function lerConfig(db) {
  const c = Object.fromEntries(db.prepare('SELECT chave, valor FROM configuracoes').all().map((r) => [r.chave, r.valor]));
  return {
    pix_chave: c.pix_chave ?? '',
    pix_recebedor: c.pix_recebedor ?? 'PLAY TECH VIP',
    pix_cidade: c.pix_cidade ?? 'SAO PAULO',
    carencia_dias: Number(c.carencia_dias),
    antecedencia_fatura_dias: Number(c.antecedencia_fatura_dias),
    creditos_s: Number(c.creditos_s),
    retomar_folga_s: Number(c.retomar_folga_s),
    aviso_home: c.aviso_home ?? '',
    epg_url: c.epg_url ?? '',
    epg_importado_em: c.epg_importado_em ?? '',
  };
}

/** Grava configurações (só as chaves conhecidas). */
function gravarConfig(db, valores) {
  const upd = db.prepare('UPDATE configuracoes SET valor = ? WHERE chave = ?');
  for (const [k, val] of Object.entries(valores)) if (k in CONFIG_PADRAO) upd.run(String(val), k);
}

module.exports = {
  MASCOTES, mascoteDe, abrir, transacao, lerConfig, gravarConfig, agora, slug, CONFIG_PADRAO, PLANOS_PADRAO };
