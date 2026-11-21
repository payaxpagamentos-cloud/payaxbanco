'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { hashSenha } = require('./lib/senha');

// Valores em centavos (inteiros), durações em segundos, percentuais em centésimos (1500 = 15,00%).
// Carimbos de tempo em ISO 8601 (UTC); datas 'AAAA-MM-DD' e competências 'AAAA-MM' no fuso configurado.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS configuracoes (chave TEXT PRIMARY KEY, valor TEXT NOT NULL);

-- Quem paga pela publicidade.
CREATE TABLE IF NOT EXISTS anunciantes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  documento TEXT,
  contato TEXT,
  email TEXT,
  telefone TEXT,
  status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','inativo')),
  observacao TEXT,
  criado_em TEXT NOT NULL
);

-- Pontos de mídia: onde a TV fica (condomínio, prédio comercial, academia, comércio, hospital...).
-- publico_dia = passagens de pessoas por dia na frente da tela (base dos impactos).
-- A contrapartida ao ponto pode ser comissão sobre a receita, um valor fixo por mês ou nenhuma
-- (em condomínio, muitas vezes a contrapartida é o espaço para os comunicados do prédio).
-- A lista de categorias fica na validação (server/lib/validacao.js), para crescer sem mexer no banco.
CREATE TABLE IF NOT EXISTS locais (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  categoria TEXT NOT NULL DEFAULT 'outro',
  administradora TEXT,
  -- Logo da administradora (ou do próprio ponto), que aparece no alto do comunicado na tela.
  logo_arquivo TEXT,
  logo_mime TEXT,
  -- Assinatura do rodapé do comunicado (padrão: "Administração / Síndico" com o nome do ponto).
  assinatura TEXT,
  unidades INTEGER NOT NULL DEFAULT 0 CHECK (unidades >= 0),
  repasse_tipo TEXT NOT NULL DEFAULT 'comissao' CHECK (repasse_tipo IN ('comissao','fixo','nenhum')),
  repasse_fixo_centavos INTEGER NOT NULL DEFAULT 0 CHECK (repasse_fixo_centavos >= 0),
  documento TEXT,
  cep TEXT,
  logradouro TEXT,
  numero TEXT,
  bairro TEXT,
  cidade TEXT NOT NULL DEFAULT '',
  uf TEXT NOT NULL DEFAULT '',
  responsavel TEXT,
  telefone TEXT,
  email TEXT,
  publico_dia INTEGER NOT NULL DEFAULT 0 CHECK (publico_dia >= 0),
  comissao_percentual INTEGER NOT NULL DEFAULT 0 CHECK (comissao_percentual BETWEEN 0 AND 10000),
  status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','pausado','encerrado')),
  inicio_parceria TEXT,
  observacao TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_locais_cidade ON locais (cidade, status);

-- Funcionamento do ponto (a TV só é cobrada e contada como online no horário aberto).
CREATE TABLE IF NOT EXISTS local_horarios (
  local_id INTEGER NOT NULL REFERENCES locais(id) ON DELETE CASCADE,
  dia_semana INTEGER NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  abre TEXT NOT NULL,
  fecha TEXT NOT NULL,
  PRIMARY KEY (local_id, dia_semana)
);

-- Cada TV instalada. O aparelho (TV box, Fire Stick, mini PC, smart TV) abre o player e se pareia com um código.
CREATE TABLE IF NOT EXISTS telas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  local_id INTEGER NOT NULL REFERENCES locais(id),
  nome TEXT NOT NULL,
  -- Onde a tela está dentro do ponto: elevador social, hall, portaria, recepção, academia, fachada...
  posicao TEXT,
  -- 'cheia': a publicidade ocupa a tela inteira e o comunicado entra no meio do carrossel.
  -- 'dividida': o comunicado do ponto fica parado numa metade e a publicidade gira na outra (padrão de elevador).
  layout TEXT NOT NULL DEFAULT 'cheia' CHECK (layout IN ('cheia','dividida')),
  orientacao TEXT NOT NULL DEFAULT 'paisagem' CHECK (orientacao IN ('paisagem','retrato')),
  status TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','manutencao','inativa')),
  som INTEGER NOT NULL DEFAULT 0,
  relogio INTEGER NOT NULL DEFAULT 1,
  legenda TEXT,
  aviso TEXT,
  aviso_ate TEXT,
  -- Pareamento: o aparelho mostra um código na TV, a equipe confirma no painel e a TV guarda o token.
  -- Despareá-la aumenta token_versao e o token antigo deixa de valer.
  token_versao INTEGER NOT NULL DEFAULT 0,
  pareada_em TEXT,
  aparelho TEXT,
  largura INTEGER,
  altura INTEGER,
  versao_player TEXT,
  ip TEXT,
  ultimo_contato TEXT,
  grade_versao TEXT,
  item_atual TEXT,
  observacao TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telas_local ON telas (local_id, status);

-- Aparelho esperando pareamento: o código aparece na TV e vale por alguns minutos.
CREATE TABLE IF NOT EXISTS pareamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE,
  aparelho TEXT,
  largura INTEGER,
  altura INTEGER,
  versao TEXT,
  ip TEXT,
  tela_id INTEGER REFERENCES telas(id) ON DELETE CASCADE,
  pareado_em TEXT,
  entregue_em TEXT,
  expira_em TEXT NOT NULL,
  criado_em TEXT NOT NULL
);

-- Arquivos de publicidade (e conteúdo institucional / do lojista). Ficam fora da pasta pública, com nome aleatório.
-- uso: 'campanha' (entra nas campanhas do anunciante) ou 'institucional' (preenche a grade quando falta publicidade).
CREATE TABLE IF NOT EXISTS midias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  anunciante_id INTEGER REFERENCES anunciantes(id),
  local_id INTEGER REFERENCES locais(id),
  nome TEXT NOT NULL,
  uso TEXT NOT NULL DEFAULT 'campanha' CHECK (uso IN ('campanha','institucional')),
  tipo TEXT NOT NULL CHECK (tipo IN ('imagem','video')),
  arquivo TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  largura INTEGER,
  altura INTEGER,
  duracao_s INTEGER NOT NULL CHECK (duracao_s BETWEEN 1 AND 600),
  orientacao TEXT CHECK (orientacao IN ('paisagem','retrato')),
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','aprovada','recusada')),
  motivo TEXT,
  validade_ate TEXT,
  enviada_por INTEGER REFERENCES usuarios(id),
  aprovada_por INTEGER REFERENCES usuarios(id),
  aprovada_em TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_midias_anunciante ON midias (anunciante_id, status);

-- Agências de publicidade: compram mídia para os anunciantes e ficam com uma comissão sobre o valor da veiculação.
CREATE TABLE IF NOT EXISTS agencias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  documento TEXT,
  contato TEXT,
  email TEXT,
  telefone TEXT,
  comissao_percentual INTEGER NOT NULL DEFAULT 2000 CHECK (comissao_percentual BETWEEN 0 AND 10000),
  status TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','inativa')),
  criado_em TEXT NOT NULL
);

-- Circuito: o pacote que o comercial vende (ex.: "Residencial Campinas", "Academias"). Junta telas por regra
-- e carrega o preço de tabela. A campanha pode aplicar um circuito, que vira os alvos dela.
CREATE TABLE IF NOT EXISTS circuitos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  descricao TEXT,
  valor_mes_centavos INTEGER NOT NULL DEFAULT 0 CHECK (valor_mes_centavos >= 0),
  cpm_centavos INTEGER NOT NULL DEFAULT 0 CHECK (cpm_centavos >= 0),
  insercoes_hora INTEGER NOT NULL DEFAULT 6 CHECK (insercoes_hora BETWEEN 1 AND 120),
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS circuito_alvos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  circuito_id INTEGER NOT NULL REFERENCES circuitos(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('tela','local','categoria','cidade')),
  valor TEXT NOT NULL,
  UNIQUE (circuito_id, tipo, valor)
);

-- Comunicado do ponto (a contrapartida do condomínio): o síndico escreve, a equipe aprova e ele entra
-- no carrossel entre os anúncios. O player desenha na hora — não existe arquivo.
CREATE TABLE IF NOT EXISTS comunicados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  local_id INTEGER NOT NULL REFERENCES locais(id) ON DELETE CASCADE,
  titulo TEXT NOT NULL,
  texto TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'aviso' CHECK (tipo IN ('aviso','manutencao','assembleia','entrega','urgente')),
  inicio TEXT NOT NULL,
  fim TEXT NOT NULL,
  duracao_s INTEGER NOT NULL DEFAULT 10 CHECK (duracao_s BETWEEN 5 AND 60),
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','aprovado','recusado')),
  motivo TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  aprovado_por INTEGER REFERENCES usuarios(id),
  aprovado_em TEXT,
  criado_em TEXT NOT NULL,
  CHECK (fim >= inicio)
);
CREATE INDEX IF NOT EXISTS idx_comunicados_local ON comunicados (local_id, status, fim);

-- Campanha: o que vai ao ar, quando, onde e quanto custa.
-- cobranca: 'mensal' (valor fechado por mês), 'cpm' (por mil impactos) ou 'cortesia' (não fatura).
CREATE TABLE IF NOT EXISTS campanhas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  anunciante_id INTEGER NOT NULL REFERENCES anunciantes(id),
  agencia_id INTEGER REFERENCES agencias(id),
  circuito_id INTEGER REFERENCES circuitos(id),
  -- Número do PI (pedido de inserção) que a agência emitiu.
  pi TEXT,
  comissao_agencia_percentual INTEGER NOT NULL DEFAULT 0 CHECK (comissao_agencia_percentual BETWEEN 0 AND 10000),
  nome TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','aguardando','ativa','pausada','encerrada')),
  inicio TEXT NOT NULL,
  fim TEXT,
  cobranca TEXT NOT NULL DEFAULT 'mensal' CHECK (cobranca IN ('mensal','cpm','cortesia')),
  valor_centavos INTEGER NOT NULL DEFAULT 0 CHECK (valor_centavos >= 0),
  cpm_centavos INTEGER NOT NULL DEFAULT 0 CHECK (cpm_centavos >= 0),
  insercoes_hora INTEGER NOT NULL DEFAULT 6 CHECK (insercoes_hora BETWEEN 1 AND 120),
  prioridade INTEGER NOT NULL DEFAULT 3 CHECK (prioridade BETWEEN 1 AND 5),
  dias_semana TEXT NOT NULL DEFAULT '0123456',
  hora_inicio TEXT NOT NULL DEFAULT '00:00',
  hora_fim TEXT NOT NULL DEFAULT '00:00',
  limite_dia INTEGER NOT NULL DEFAULT 0 CHECK (limite_dia >= 0),
  motivo TEXT,
  criada_por INTEGER REFERENCES usuarios(id),
  aprovada_por INTEGER REFERENCES usuarios(id),
  aprovada_em TEXT,
  criado_em TEXT NOT NULL,
  CHECK (fim IS NULL OR fim >= inicio)
);
CREATE INDEX IF NOT EXISTS idx_campanhas_periodo ON campanhas (status, inicio, fim);

-- Criativos da campanha (a duração pode ser diferente da padrão da mídia).
CREATE TABLE IF NOT EXISTS campanha_midias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campanha_id INTEGER NOT NULL REFERENCES campanhas(id) ON DELETE CASCADE,
  midia_id INTEGER NOT NULL REFERENCES midias(id),
  duracao_s INTEGER CHECK (duracao_s IS NULL OR duracao_s BETWEEN 1 AND 600),
  ordem INTEGER NOT NULL DEFAULT 0,
  UNIQUE (campanha_id, midia_id)
);

-- Onde a campanha vai ao ar. Sem nenhum alvo, vai em todas as telas ativas.
CREATE TABLE IF NOT EXISTS campanha_alvos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campanha_id INTEGER NOT NULL REFERENCES campanhas(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('tela','local','categoria','cidade')),
  valor TEXT NOT NULL,
  UNIQUE (campanha_id, tipo, valor)
);

-- Prova de exibição: cada vez que um criativo foi ao ar numa TV (enviado pelo player em lote).
CREATE TABLE IF NOT EXISTS exibicoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tela_id INTEGER NOT NULL REFERENCES telas(id) ON DELETE CASCADE,
  local_id INTEGER NOT NULL REFERENCES locais(id),
  campanha_id INTEGER REFERENCES campanhas(id),
  anunciante_id INTEGER REFERENCES anunciantes(id),
  midia_id INTEGER REFERENCES midias(id),
  comunicado_id INTEGER REFERENCES comunicados(id),
  -- 'midia': criativo ou institucional; 'comunicado': recado do ponto; 'marca': a tela da própria rede.
  -- As duas últimas são tempo não vendido, e entram no cálculo para a divisão dos impactos ficar honesta.
  tipo TEXT NOT NULL DEFAULT 'midia',
  data TEXT NOT NULL,
  exibida_em TEXT NOT NULL,
  duracao_s INTEGER NOT NULL CHECK (duracao_s >= 0),
  criado_em TEXT NOT NULL,
  -- Uma tela exibe uma coisa de cada vez: tela + instante identificam a exibição (e barram o reenvio repetido).
  UNIQUE (tela_id, exibida_em)
);
CREATE INDEX IF NOT EXISTS idx_exibicoes_data ON exibicoes (data, tela_id);
CREATE INDEX IF NOT EXISTS idx_exibicoes_periodo ON exibicoes (data, exibida_em);
CREATE INDEX IF NOT EXISTS idx_exibicoes_campanha ON exibicoes (campanha_id, data);

-- Resumo por dia (campanha_id 0 = institucional / conteúdo do ponto): a base dos relatórios e do faturamento.
CREATE TABLE IF NOT EXISTS resumo_dia (
  data TEXT NOT NULL,
  tela_id INTEGER NOT NULL REFERENCES telas(id) ON DELETE CASCADE,
  campanha_id INTEGER NOT NULL DEFAULT 0,
  local_id INTEGER NOT NULL,
  insercoes INTEGER NOT NULL DEFAULT 0,
  segundos INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (data, tela_id, campanha_id)
);
CREATE INDEX IF NOT EXISTS idx_resumo_campanha ON resumo_dia (campanha_id, data);

-- Vida da TV: pareamento, quedas, voltas e erros do player (base do tempo no ar).
CREATE TABLE IF NOT EXISTS telas_eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tela_id INTEGER NOT NULL REFERENCES telas(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('pareada','online','offline','erro','reinicio','desparear')),
  detalhe TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eventos_tela ON telas_eventos (tela_id, criado_em);

-- Faturas do anunciante (uma por competência) e o detalhe por campanha.
CREATE TABLE IF NOT EXISTS faturas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  anunciante_id INTEGER NOT NULL REFERENCES anunciantes(id),
  agencia_id INTEGER REFERENCES agencias(id),
  competencia TEXT NOT NULL,
  vencimento TEXT NOT NULL,
  -- bruto = soma das veiculações; valor = o que a plataforma recebe (bruto menos a comissão da agência).
  bruto_centavos INTEGER NOT NULL DEFAULT 0 CHECK (bruto_centavos >= 0),
  comissao_agencia_centavos INTEGER NOT NULL DEFAULT 0 CHECK (comissao_agencia_centavos >= 0),
  valor_centavos INTEGER NOT NULL DEFAULT 0 CHECK (valor_centavos >= 0),
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','paga','cancelada')),
  pago_em TEXT,
  observacao TEXT,
  criado_em TEXT NOT NULL,
  UNIQUE (anunciante_id, competencia)
);
CREATE TABLE IF NOT EXISTS fatura_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fatura_id INTEGER NOT NULL REFERENCES faturas(id) ON DELETE CASCADE,
  campanha_id INTEGER REFERENCES campanhas(id),
  descricao TEXT NOT NULL,
  insercoes INTEGER NOT NULL DEFAULT 0,
  impactos INTEGER NOT NULL DEFAULT 0,
  telas INTEGER NOT NULL DEFAULT 0,
  valor_centavos INTEGER NOT NULL DEFAULT 0
);

-- Repasse ao lojista: comissão sobre a receita das telas do ponto no mês.
CREATE TABLE IF NOT EXISTS repasses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  local_id INTEGER NOT NULL REFERENCES locais(id),
  competencia TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'comissao',
  base_centavos INTEGER NOT NULL DEFAULT 0,
  comissao_percentual INTEGER NOT NULL DEFAULT 0,
  valor_centavos INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'a_pagar' CHECK (status IN ('a_pagar','pago','cancelado')),
  pago_em TEXT,
  observacao TEXT,
  criado_em TEXT NOT NULL,
  UNIQUE (local_id, competencia)
);

-- master: tudo. operador: opera sem usuários/configurações. anunciante: portal do próprio anunciante. lojista: portal do próprio ponto.
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL CHECK (perfil IN ('master','operador','anunciante','lojista')),
  anunciante_id INTEGER REFERENCES anunciantes(id),
  local_id INTEGER REFERENCES locais(id),
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_acesso TEXT,
  criado_em TEXT NOT NULL,
  CHECK ((perfil = 'anunciante') = (anunciante_id IS NOT NULL)),
  CHECK ((perfil = 'lojista') = (local_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER REFERENCES usuarios(id),
  acao TEXT NOT NULL,
  detalhes TEXT,
  ip TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auditoria_data ON auditoria (criado_em);
`;

// Configurações da plataforma (texto ou número; TEXTO lista as que não são número).
const CONFIG_PADRAO = {
  nome_plataforma: 'Vai Mídia',
  // Frase da marca: aparece na entrada do painel e na tela de espera do player.
  slogan: 'Sua marca em movimento.',
  // Duração padrão de uma imagem no ar, em segundos.
  duracao_imagem_s: '12',
  // Inserções por hora sugeridas numa campanha nova.
  insercoes_hora_padrao: '6',
  // O loop de cada TV tem no mínimo este tempo (preenchido com institucional quando falta publicidade)…
  bloco_minimo_s: '120',
  // …e no máximo este (campanhas de menor prioridade entram com menos inserções se passar).
  bloco_maximo_s: '600',
  // De quanto em quanto tempo a TV fala com o servidor.
  batida_intervalo_s: '60',
  // Sem contato por mais tempo que isto, a TV conta como offline.
  offline_minutos: '5',
  // Preço de tabela: mensalidade por tela e CPM (mil impactos) sugeridos nas campanhas novas.
  mensalidade_tela_centavos: '25000',
  cpm_centavos: '1500',
  // Comissão sugerida ao lojista num ponto novo (centésimos: 1500 = 15%).
  comissao_local_percentual: '1500',
  // Dia de vencimento das faturas e quantos dias antes elas são geradas.
  vencimento_dia: '10',
  // O responsável pelo ponto (lojista ou síndico) pode escrever o aviso que passa na faixa da própria TV.
  aviso_lojista: '1',
  // Comunicado publicado pelo ponto entra no ar direto (1) ou espera a equipe aprovar (0).
  comunicado_automatico: '0',
  // A tela da própria rede (logo, frase e o símbolo) entra quando falta conteúdo para completar o loop,
  // e é o que aparece numa tela que ainda não tem campanha. 0 desliga.
  marca_preenche: '1',
  marca_duracao_s: '10',
  // Por quantos dias a prova de exibição detalhada é guardada (o resumo por dia, que alimenta
  // relatórios e faturamento, nunca é apagado). 0 = guardar tudo.
  prova_dias: '180',
  // Dados do PIX impresso na fatura do anunciante.
  pix_chave: '',
  pix_nome: '',
  pix_cidade: '',
};
const TEXTO = new Set(['nome_plataforma', 'slogan', 'pix_chave', 'pix_nome', 'pix_cidade']);

const agora = () => new Date().toISOString();

function abrir(arquivo = config.dbFile) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  migrar(db);

  const cfg = db.prepare('INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES (?, ?)');
  for (const [k, val] of Object.entries(CONFIG_PADRAO)) cfg.run(k, val);
  // Instalações que ainda estavam com o nome genérico anterior passam a usar a marca (um nome escolhido no painel não muda).
  db.prepare("UPDATE configuracoes SET valor = ? WHERE chave = 'nome_plataforma' AND valor = 'Vai Mídia'").run(CONFIG_PADRAO.nome_plataforma);

  if (!db.prepare("SELECT 1 FROM usuarios WHERE perfil = 'master' LIMIT 1").get()) {
    db.prepare("INSERT INTO usuarios (nome, email, senha_hash, perfil, criado_em) VALUES (?, ?, ?, 'master', ?)")
      .run(config.admin.nome, config.admin.email, hashSenha(config.admin.senha), agora());
  }
  return db;
}

/** Colunas que entraram depois da primeira versão (bancos antigos recebem cada uma por ALTER TABLE). */
const COLUNAS_NOVAS = [
  ['locais', 'administradora', 'TEXT'],
  ['locais', 'unidades', 'INTEGER NOT NULL DEFAULT 0'],
  ['locais', 'repasse_tipo', "TEXT NOT NULL DEFAULT 'comissao'"],
  ['locais', 'repasse_fixo_centavos', 'INTEGER NOT NULL DEFAULT 0'],
  ['telas', 'posicao', 'TEXT'],
  ['telas', 'layout', "TEXT NOT NULL DEFAULT 'cheia'"],
  ['locais', 'logo_arquivo', 'TEXT'],
  ['locais', 'logo_mime', 'TEXT'],
  ['locais', 'assinatura', 'TEXT'],
  ['campanhas', 'agencia_id', 'INTEGER REFERENCES agencias(id)'],
  ['campanhas', 'circuito_id', 'INTEGER REFERENCES circuitos(id)'],
  ['campanhas', 'pi', 'TEXT'],
  ['campanhas', 'comissao_agencia_percentual', 'INTEGER NOT NULL DEFAULT 0'],
  ['exibicoes', 'comunicado_id', 'INTEGER REFERENCES comunicados(id)'],
  ['exibicoes', 'tipo', "TEXT NOT NULL DEFAULT 'midia'"],
  ['faturas', 'agencia_id', 'INTEGER REFERENCES agencias(id)'],
  ['faturas', 'bruto_centavos', 'INTEGER NOT NULL DEFAULT 0'],
  ['faturas', 'comissao_agencia_centavos', 'INTEGER NOT NULL DEFAULT 0'],
  ['repasses', 'tipo', "TEXT NOT NULL DEFAULT 'comissao'"],
];

const temColuna = (db, tabela, coluna) => db.prepare(`PRAGMA table_info(${tabela})`).all().some((c) => c.name === coluna);
const sqlDaTabela = (db, tabela) => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tabela)?.sql ?? '';

/**
 * Migrações de bancos criados por versões anteriores. Duas delas refazem a tabela, porque o SQLite não altera
 * restrições: a lista fixa de categorias do ponto (agora a lista vive na validação) e a chave de exibição
 * (era tela+mídia+instante; comunicado não tem mídia, então passou a ser tela+instante).
 */
function migrar(db) {
  for (const [tabela, coluna, tipo] of COLUNAS_NOVAS) {
    if (!temColuna(db, tabela, coluna)) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`);
  }

  if (/CHECK \(categoria IN/.test(sqlDaTabela(db, 'locais'))) refazerTabela(db, 'locais');
  if (/UNIQUE \(tela_id, midia_id, exibida_em\)/.test(sqlDaTabela(db, 'exibicoes'))) refazerTabela(db, 'exibicoes');
}

/** Recria a tabela no formato novo (do SCHEMA) e copia os dados pelas colunas que existem nas duas. */
function refazerTabela(db, tabela) {
  const criar = SCHEMA.split(/;\s*\n/).map((x) => `${x.trim()};`).find((x) => new RegExp(`CREATE TABLE IF NOT EXISTS ${tabela} \\(`).test(x));
  if (!criar) throw new Error(`[Vai Mídia] Não achei o CREATE TABLE de ${tabela} para migrar.`);
  const antigas = new Set(db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name));
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(criar.replace(`CREATE TABLE IF NOT EXISTS ${tabela} (`, `CREATE TABLE ${tabela}_novo (`));
    const colunas = db.prepare(`PRAGMA table_info(${tabela}_novo)`).all().map((c) => c.name).filter((c) => antigas.has(c));
    db.exec(`INSERT OR IGNORE INTO ${tabela}_novo (${colunas.join(', ')}) SELECT ${colunas.join(', ')} FROM ${tabela}`);
    db.exec(`DROP TABLE ${tabela}`);
    db.exec(`ALTER TABLE ${tabela}_novo RENAME TO ${tabela}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  // Os índices da tabela refeita são recriados pelo SCHEMA (CREATE INDEX IF NOT EXISTS).
  db.exec(SCHEMA);
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

function lerConfig(db) {
  const c = Object.fromEntries(db.prepare('SELECT chave, valor FROM configuracoes').all().map((r) => [r.chave, r.valor]));
  return Object.fromEntries(Object.keys(CONFIG_PADRAO).map((k) => [k, TEXTO.has(k) ? (c[k] ?? CONFIG_PADRAO[k]) : Number(c[k] ?? CONFIG_PADRAO[k])]));
}

function gravarConfig(db, chave, valor) {
  db.prepare('UPDATE configuracoes SET valor = ? WHERE chave = ?').run(String(valor), chave);
}

module.exports = { abrir, transacao, lerConfig, gravarConfig, agora, CONFIG_PADRAO, TEXTO };
