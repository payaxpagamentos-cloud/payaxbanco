'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { hashSenha } = require('./lib/senha');

// Carimbos de tempo em ISO 8601 (UTC). Valores em centavos (inteiros). Horários de atendimento em 'HH:MM' no fuso da plataforma.
const SCHEMA = `
-- Empresas clientes da plataforma. Limites: atendentes humanos e mensagens da IA por mês.
CREATE TABLE IF NOT EXISTS empresas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  documento TEXT,
  status TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','bloqueada','excluida')),
  email TEXT,
  telefone TEXT,
  limite_atendentes INTEGER NOT NULL DEFAULT 5 CHECK (limite_atendentes >= 0),
  limite_ia_mes INTEGER NOT NULL DEFAULT 2000 CHECK (limite_ia_mes >= 0),
  motivo_bloqueio TEXT,
  criada_em TEXT NOT NULL
);

-- master e suporte: equipe da plataforma (empresa_id nulo).
-- cliente (administrador da empresa), supervisor (só consulta) e atendente (atende conversas): da empresa.
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL CHECK (perfil IN ('master','suporte','cliente','supervisor','atendente')),
  empresa_id INTEGER REFERENCES empresas(id),
  ativo INTEGER NOT NULL DEFAULT 1,
  -- O atendente só entra na distribuição quando está disponível (botão no painel) e com vaga livre.
  disponivel INTEGER NOT NULL DEFAULT 0,
  max_simultaneas INTEGER NOT NULL DEFAULT 5 CHECK (max_simultaneas > 0),
  visto_em TEXT,
  ultimo_acesso TEXT,
  criado_em TEXT NOT NULL,
  CHECK ((perfil IN ('master','suporte')) = (empresa_id IS NULL))
);

-- Números de WhatsApp da empresa na Cloud API da Meta. O token e o segredo do app ficam cifrados.
CREATE TABLE IF NOT EXISTS numeros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  telefone TEXT NOT NULL,
  phone_number_id TEXT NOT NULL UNIQUE,
  waba_id TEXT,
  token_cifrado TEXT,
  app_secret_cifrado TEXT,
  verify_token TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_evento_em TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_numeros_empresa ON numeros(empresa_id);

-- Filas (departamentos): para onde a atendente virtual transfere o que não resolve.
CREATE TABLE IF NOT EXISTS filas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  descricao TEXT,
  -- Como a IA sabe quando mandar para esta fila (entra na descrição da ferramenta de transferência).
  quando_usar TEXT,
  dias TEXT NOT NULL DEFAULT '0111110',
  abre TEXT NOT NULL DEFAULT '08:00',
  fecha TEXT NOT NULL DEFAULT '18:00',
  ordem INTEGER NOT NULL DEFAULT 0,
  ativa INTEGER NOT NULL DEFAULT 1,
  criada_em TEXT NOT NULL,
  UNIQUE (empresa_id, nome)
);

-- Quem atende cada fila.
CREATE TABLE IF NOT EXISTS fila_usuarios (
  fila_id INTEGER NOT NULL REFERENCES filas(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  PRIMARY KEY (fila_id, usuario_id)
);

-- O cliente final, identificado pelo número do WhatsApp (wa_id).
CREATE TABLE IF NOT EXISTS contatos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  telefone TEXT NOT NULL,
  nome TEXT,
  nome_perfil TEXT,
  documento TEXT,
  email TEXT,
  -- Identificador do cliente no sistema da empresa (preenchido pela IA ou pela integração).
  codigo_externo TEXT,
  observacoes TEXT,
  bloqueado INTEGER NOT NULL DEFAULT 0,
  -- Opt-out: o contato pediu para não receber mensagens ativas.
  aceita_ativo INTEGER NOT NULL DEFAULT 1,
  primeiro_contato_em TEXT NOT NULL,
  ultimo_contato_em TEXT,
  UNIQUE (empresa_id, telefone)
);
CREATE INDEX IF NOT EXISTS idx_contatos_empresa ON contatos(empresa_id, ultimo_contato_em DESC);

-- O atendimento. 'bot': a atendente virtual está conduzindo. 'aguardando': na fila, esperando um humano.
-- 'humano': um atendente assumiu. 'encerrada': terminou.
CREATE TABLE IF NOT EXISTS conversas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  contato_id INTEGER NOT NULL REFERENCES contatos(id),
  numero_id INTEGER NOT NULL REFERENCES numeros(id),
  estado TEXT NOT NULL DEFAULT 'bot' CHECK (estado IN ('bot','aguardando','humano','encerrada')),
  fila_id INTEGER REFERENCES filas(id),
  atendente_id INTEGER REFERENCES usuarios(id),
  assunto TEXT,
  -- O que a IA entendeu que o cliente queria.
  intencao TEXT,
  -- Quem concluiu: 'ia' (resolveu sozinha), 'humano', 'abandono' (cliente parou de responder) ou 'cliente'.
  resolvida_por TEXT CHECK (resolvida_por IN ('ia','humano','abandono','cliente')),
  -- Por que saiu da IA para o humano (preenchido na transferência).
  motivo_transferencia TEXT,
  -- Resumo que a IA entrega ao atendente ao transferir.
  resumo TEXT,
  prioridade TEXT NOT NULL DEFAULT 'normal' CHECK (prioridade IN ('baixa','normal','alta')),
  -- Identificação no sistema do provedor (IXC). identidade_confirmada é o portão: enquanto for 0,
  -- nenhuma ferramenta conta nada do contrato, por mais que o cliente (ou o modelo) insista.
  ixc_cliente_id TEXT,
  ixc_contrato_id TEXT,
  ixc_cliente_nome TEXT,
  identidade_confirmada INTEGER NOT NULL DEFAULT 0,
  identidade_metodo TEXT CHECK (identidade_metodo IN ('cpf3','nascimento','documento')),
  identidade_tentativas INTEGER NOT NULL DEFAULT 0,
  identidade_em TEXT,
  -- Janela de 24 h da Cloud API: fora dela, só template aprovado.
  janela_expira_em TEXT,
  mensagens_ia INTEGER NOT NULL DEFAULT 0,
  aberta_em TEXT NOT NULL,
  transferida_em TEXT,
  assumida_em TEXT,
  primeira_resposta_humana_em TEXT,
  encerrada_em TEXT,
  ultima_mensagem_em TEXT,
  ultima_mensagem_cliente_em TEXT,
  csat_pedido_em TEXT,
  csat_nota INTEGER CHECK (csat_nota BETWEEN 1 AND 5),
  csat_comentario TEXT
);
CREATE INDEX IF NOT EXISTS idx_conversas_empresa ON conversas(empresa_id, estado, ultima_mensagem_em DESC);
CREATE INDEX IF NOT EXISTS idx_conversas_contato ON conversas(contato_id, aberta_em DESC);
CREATE INDEX IF NOT EXISTS idx_conversas_atendente ON conversas(atendente_id, estado);
-- Um contato tem no máximo uma conversa aberta por vez.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversa_aberta ON conversas(contato_id) WHERE estado <> 'encerrada';

-- Todas as mensagens, nos dois sentidos. As de saída passam pela fila de envio (status 'fila').
CREATE TABLE IF NOT EXISTS mensagens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversa_id INTEGER NOT NULL REFERENCES conversas(id) ON DELETE CASCADE,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  direcao TEXT NOT NULL CHECK (direcao IN ('entrada','saida')),
  autor TEXT NOT NULL CHECK (autor IN ('cliente','ia','atendente','sistema')),
  usuario_id INTEGER REFERENCES usuarios(id),
  tipo TEXT NOT NULL DEFAULT 'texto'
    CHECK (tipo IN ('texto','imagem','audio','video','documento','figurinha','localizacao','contato','botao','template','sistema','nao_suportado')),
  texto TEXT,
  -- Mídia: fica no disco (data/arquivos), nunca no banco.
  midia_id TEXT,
  midia_arquivo TEXT,
  midia_nome TEXT,
  midia_mime TEXT,
  midia_bytes INTEGER,
  -- Corpo pronto da Cloud API quando a mensagem não é texto simples (botões, lista, template, mídia).
  payload TEXT,
  -- Identificadores da Meta: o da mensagem e o da mensagem respondida.
  wa_id TEXT,
  responde_wa_id TEXT,
  status TEXT NOT NULL DEFAULT 'recebida' CHECK (status IN ('recebida','fila','enviada','entregue','lida','falhou')),
  erro TEXT,
  tentativas INTEGER NOT NULL DEFAULT 0,
  proxima_em TEXT,
  criada_em TEXT NOT NULL,
  enviada_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_mensagens_conversa ON mensagens(conversa_id, id);
CREATE INDEX IF NOT EXISTS idx_mensagens_fila ON mensagens(status, proxima_em);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mensagens_wa ON mensagens(wa_id) WHERE wa_id IS NOT NULL;

-- Notas internas da conversa (o cliente não vê).
CREATE TABLE IF NOT EXISTS notas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversa_id INTEGER NOT NULL REFERENCES conversas(id) ON DELETE CASCADE,
  usuario_id INTEGER REFERENCES usuarios(id),
  texto TEXT NOT NULL,
  criada_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notas_conversa ON notas(conversa_id, id);

CREATE TABLE IF NOT EXISTS etiquetas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  cor TEXT NOT NULL DEFAULT 'azul',
  criada_em TEXT NOT NULL,
  UNIQUE (empresa_id, nome)
);
CREATE TABLE IF NOT EXISTS conversa_etiquetas (
  conversa_id INTEGER NOT NULL REFERENCES conversas(id) ON DELETE CASCADE,
  etiqueta_id INTEGER NOT NULL REFERENCES etiquetas(id) ON DELETE CASCADE,
  PRIMARY KEY (conversa_id, etiqueta_id)
);

-- Atalhos do atendente humano (ex.: /boleto).
CREATE TABLE IF NOT EXISTS respostas_rapidas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  atalho TEXT NOT NULL,
  titulo TEXT NOT NULL,
  texto TEXT NOT NULL,
  ativa INTEGER NOT NULL DEFAULT 1,
  usos INTEGER NOT NULL DEFAULT 0,
  criada_em TEXT NOT NULL,
  UNIQUE (empresa_id, atalho)
);

-- Configuração da atendente virtual, por empresa.
CREATE TABLE IF NOT EXISTS ia_config (
  empresa_id INTEGER PRIMARY KEY REFERENCES empresas(id) ON DELETE CASCADE,
  ativa INTEGER NOT NULL DEFAULT 1,
  nome_assistente TEXT NOT NULL DEFAULT 'ZOE',
  saudacao TEXT,
  -- Como a atendente deve falar e o que ela pode e não pode fazer (entra no prompt do sistema).
  tom TEXT,
  regras TEXT,
  -- Quantas mensagens a IA pode trocar antes de transferir por conta própria.
  max_turnos INTEGER NOT NULL DEFAULT 12 CHECK (max_turnos > 0),
  -- Transferir quando a IA não souber responder (em vez de insistir).
  transferir_sem_resposta INTEGER NOT NULL DEFAULT 1,
  -- Fila usada quando a IA transfere sem escolher uma.
  fila_padrao_id INTEGER REFERENCES filas(id),
  pedir_csat INTEGER NOT NULL DEFAULT 1,
  -- Minutos sem resposta do cliente para encerrar a conversa por abandono (0 = não encerra).
  encerrar_apos_min INTEGER NOT NULL DEFAULT 180 CHECK (encerrar_apos_min >= 0),
  mensagem_transferencia TEXT,
  mensagem_fora_horario TEXT,
  mensagem_encerramento TEXT,
  mensagem_csat TEXT,
  -- Modelo e esforço: em branco usa o padrão do servidor.
  modelo TEXT,
  esforco TEXT CHECK (esforco IN ('low','medium','high','xhigh','max')),
  atualizada_em TEXT
);

-- Ouvidoria: reclamação, cancelamento, Procon, Anatel. Caso com protocolo, prazo e desfecho.
-- É o lugar onde o provedor trata o que não pode se perder numa conversa de WhatsApp.
CREATE TABLE IF NOT EXISTS ouvidoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  protocolo TEXT NOT NULL,
  contato_id INTEGER NOT NULL REFERENCES contatos(id),
  conversa_id INTEGER REFERENCES conversas(id) ON DELETE SET NULL,
  ixc_cliente_id TEXT,
  tipo TEXT NOT NULL CHECK (tipo IN ('reclamacao','cancelamento','procon','anatel','elogio','sugestao')),
  origem TEXT NOT NULL DEFAULT 'ia' CHECK (origem IN ('ia','atendente','api')),
  assunto TEXT NOT NULL,
  relato TEXT,
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','em_tratativa','resolvida','improcedente')),
  prioridade TEXT NOT NULL DEFAULT 'normal' CHECK (prioridade IN ('baixa','normal','alta')),
  -- Prazo de resposta (SLA): Procon e Anatel têm prazo legal; os outros, o que a empresa definir.
  prazo_em TEXT,
  responsavel_id INTEGER REFERENCES usuarios(id),
  -- Fotografia do score no momento da abertura: depois o cliente muda, mas a decisão foi tomada com estes números.
  risco_na_abertura INTEGER,
  valor_na_abertura TEXT,
  mensalidade_centavos INTEGER NOT NULL DEFAULT 0,
  -- Desfecho: o cliente ficou? Quanto de receita anual foi salvo (ou perdido)?
  desfecho TEXT,
  retido INTEGER,
  valor_anual_centavos INTEGER NOT NULL DEFAULT 0,
  aberta_em TEXT NOT NULL,
  assumida_em TEXT,
  resolvida_em TEXT,
  UNIQUE (empresa_id, protocolo)
);
CREATE INDEX IF NOT EXISTS idx_ouvidoria_empresa ON ouvidoria(empresa_id, status, aberta_em DESC);
CREATE INDEX IF NOT EXISTS idx_ouvidoria_contato ON ouvidoria(contato_id, aberta_em DESC);

-- Cada tratativa do caso: quem falou o quê e quando.
CREATE TABLE IF NOT EXISTS ouvidoria_eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ouvidoria_id INTEGER NOT NULL REFERENCES ouvidoria(id) ON DELETE CASCADE,
  usuario_id INTEGER REFERENCES usuarios(id),
  tipo TEXT NOT NULL DEFAULT 'tratativa' CHECK (tipo IN ('abertura','tratativa','contato','proposta','desfecho','prazo')),
  texto TEXT NOT NULL,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ouvidoria_eventos ON ouvidoria_eventos(ouvidoria_id, id);

-- Integração com o IXC Provedor, por empresa. O token fica cifrado.
CREATE TABLE IF NOT EXISTS ixc_config (
  empresa_id INTEGER PRIMARY KEY REFERENCES empresas(id) ON DELETE CASCADE,
  ativo INTEGER NOT NULL DEFAULT 0,
  url TEXT,
  token_cifrado TEXT,
  timeout_ms INTEGER NOT NULL DEFAULT 8000 CHECK (timeout_ms BETWEEN 1000 AND 30000),
  -- Nomes de recurso sobrescritos (JSON), para versões do IXC que usam outros.
  recursos TEXT,
  -- Identificação: quantos dígitos do documento pedir quando o telefone já está no cadastro.
  confirmar_por TEXT NOT NULL DEFAULT 'cpf3' CHECK (confirmar_por IN ('cpf3','nascimento')),
  max_tentativas INTEGER NOT NULL DEFAULT 3 CHECK (max_tentativas BETWEEN 1 AND 6),
  -- Desbloqueio de confiança: liga/desliga e o limite por cliente no período.
  desbloqueio_ativo INTEGER NOT NULL DEFAULT 1,
  desbloqueio_limite INTEGER NOT NULL DEFAULT 1 CHECK (desbloqueio_limite >= 0),
  desbloqueio_periodo_dias INTEGER NOT NULL DEFAULT 30 CHECK (desbloqueio_periodo_dias > 0),
  -- A IA pode abrir chamado técnico no IXC?
  chamado_ativo INTEGER NOT NULL DEFAULT 1,
  assunto_chamado_id TEXT,
  -- Filas para onde transferir quando o assunto é do IXC.
  fila_financeira_id INTEGER REFERENCES filas(id),
  fila_tecnica_id INTEGER REFERENCES filas(id),
  -- Resultado da última sonda de capacidades (JSON) e quando ela rodou.
  capacidades TEXT,
  testado_em TEXT,
  atualizado_em TEXT
);

-- O que a atendente virtual fez no IXC: auditoria para o provedor e base do limite de desbloqueios.
CREATE TABLE IF NOT EXISTS ixc_acoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  conversa_id INTEGER REFERENCES conversas(id) ON DELETE SET NULL,
  contato_id INTEGER REFERENCES contatos(id),
  ixc_cliente_id TEXT,
  tipo TEXT NOT NULL CHECK (tipo IN ('identificacao','confirmacao','contrato','faturas','boleto','desbloqueio','conexao','chamado','erro')),
  sucesso INTEGER NOT NULL DEFAULT 1,
  detalhe TEXT,
  ms INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ixc_acoes_empresa ON ixc_acoes(empresa_id, criado_em);
CREATE INDEX IF NOT EXISTS idx_ixc_acoes_cliente ON ixc_acoes(empresa_id, ixc_cliente_id, tipo, criado_em);

-- Base de conhecimento: o que a atendente virtual usa para responder sozinha.
CREATE TABLE IF NOT EXISTS conhecimento (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  titulo TEXT NOT NULL,
  resposta TEXT NOT NULL,
  -- Perguntas de exemplo e palavras-chave, uma por linha, usadas na busca.
  perguntas TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  usos INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_conhecimento_empresa ON conhecimento(empresa_id, ativo);

-- Intenções determinísticas: resolvem antes de chamar a IA (barato, previsível e auditável).
CREATE TABLE IF NOT EXISTS intencoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  -- Palavras ou expressões, uma por linha. A comparação ignora acentos e maiúsculas.
  palavras TEXT NOT NULL,
  acao TEXT NOT NULL DEFAULT 'responder' CHECK (acao IN ('responder','transferir','encerrar')),
  resposta TEXT,
  fila_id INTEGER REFERENCES filas(id),
  ordem INTEGER NOT NULL DEFAULT 0,
  ativa INTEGER NOT NULL DEFAULT 1,
  usos INTEGER NOT NULL DEFAULT 0,
  criada_em TEXT NOT NULL,
  UNIQUE (empresa_id, nome)
);

-- Ferramentas da empresa: a IA consulta o sistema do cliente por HTTP (fatura, pedido, contrato...).
CREATE TABLE IF NOT EXISTS ferramentas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  descricao TEXT NOT NULL,
  -- Parâmetros em JSON Schema (objeto com properties e required).
  parametros TEXT NOT NULL DEFAULT '{"type":"object","properties":{},"required":[],"additionalProperties":false}',
  metodo TEXT NOT NULL DEFAULT 'POST' CHECK (metodo IN ('GET','POST')),
  url TEXT NOT NULL,
  cabecalhos_cifrados TEXT,
  timeout_ms INTEGER NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 1000 AND 30000),
  ativa INTEGER NOT NULL DEFAULT 1,
  usos INTEGER NOT NULL DEFAULT 0,
  criada_em TEXT NOT NULL,
  UNIQUE (empresa_id, nome)
);

-- Chamados abertos pela atendente virtual quando não há solução imediata.
CREATE TABLE IF NOT EXISTS chamados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  conversa_id INTEGER REFERENCES conversas(id),
  contato_id INTEGER NOT NULL REFERENCES contatos(id),
  protocolo TEXT NOT NULL,
  assunto TEXT NOT NULL,
  descricao TEXT,
  fila_id INTEGER REFERENCES filas(id),
  status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','andamento','resolvido','cancelado')),
  aberto_por TEXT NOT NULL DEFAULT 'ia' CHECK (aberto_por IN ('ia','atendente')),
  usuario_id INTEGER REFERENCES usuarios(id),
  resolucao TEXT,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT,
  UNIQUE (empresa_id, protocolo)
);
CREATE INDEX IF NOT EXISTS idx_chamados_empresa ON chamados(empresa_id, status, id DESC);

-- O que a atendente virtual fez em cada passo: dá para auditar e medir custo.
CREATE TABLE IF NOT EXISTS ia_eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  conversa_id INTEGER REFERENCES conversas(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('intencao','conhecimento','ferramenta','resposta','transferencia','encerramento','limite','erro','desligada')),
  nome TEXT,
  detalhe TEXT,
  tokens_entrada INTEGER NOT NULL DEFAULT 0,
  tokens_saida INTEGER NOT NULL DEFAULT 0,
  tokens_cache INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ia_eventos_empresa ON ia_eventos(empresa_id, criado_em);
CREATE INDEX IF NOT EXISTS idx_ia_eventos_conversa ON ia_eventos(conversa_id, id);

-- Chaves de API da empresa (integração com o ERP: abrir conversa, enviar mensagem ativa, consultar).
CREATE TABLE IF NOT EXISTS chaves_api (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  prefixo TEXT NOT NULL,
  chave_hash TEXT NOT NULL,
  ativa INTEGER NOT NULL DEFAULT 1,
  ultimo_uso TEXT,
  criada_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chaves_empresa ON chaves_api(empresa_id);

-- Eventos do webhook já processados (a Meta reenvia): evita responder duas vezes à mesma mensagem.
CREATE TABLE IF NOT EXISTS webhook_vistos (
  wa_id TEXT PRIMARY KEY,
  criado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER REFERENCES empresas(id),
  usuario_id INTEGER REFERENCES usuarios(id),
  usuario_nome TEXT,
  acao TEXT NOT NULL,
  alvo TEXT,
  detalhe TEXT,
  ip TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auditoria_criado ON auditoria(criado_em DESC);

CREATE TABLE IF NOT EXISTS acessos_recusados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT,
  ip TEXT,
  motivo TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recusados_criado ON acessos_recusados(criado_em DESC);

CREATE TABLE IF NOT EXISTS ips_bloqueados (
  ip TEXT PRIMARY KEY,
  motivo TEXT,
  criado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS configuracoes (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
`;

const CONFIG_PADRAO = {
  nome_plataforma: 'ZOE Atende',
  // Padrões aplicados a cada empresa nova.
  limite_atendentes_padrao: '5',
  limite_ia_mes_padrao: '2000',
  // Dias que as mensagens e as conversas encerradas ficam guardadas (0 = para sempre).
  retencao_dias: '0',
  // Minutos sem resposta do cliente para a conversa contar como abandonada.
  abandono_min: '180',
  // Minutos na fila sem ninguém assumir que acendem o alerta de espera no painel.
  alerta_espera_min: '10',
  // Prazo de resposta da ouvidoria, em horas, por tipo de caso.
  // Procon e Anatel seguem o prazo legal da notificação; aqui fica o alerta interno.
  ouvidoria_prazo_horas: '48',
  ouvidoria_prazo_horas_formal: '24',
  // Preço da IA em centavos de real por milhão de tokens, para o custo estimado dos relatórios.
  // Padrão do claude-opus-5-5 (US$ 4,00 / US$ 20,00 / US$ 0,20 por milhão) a ~R$ 5,40 o dólar.
  // O master ajusta no painel quando a tabela da Anthropic ou o câmbio mudarem.
  ia_preco_entrada_milhao: '2160',
  ia_preco_saida_milhao: '10800',
  ia_preco_cache_milhao: '108',
};

const agora = () => new Date().toISOString();

function abrir(arquivo = config.dbFile) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const cfg = db.prepare('INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES (?, ?)');
  for (const [k, val] of Object.entries(CONFIG_PADRAO)) cfg.run(k, val);

  if (!db.prepare("SELECT 1 FROM usuarios WHERE perfil = 'master' LIMIT 1").get()) {
    db.prepare("INSERT INTO usuarios (nome, email, senha_hash, perfil, criado_em) VALUES (?, ?, ?, 'master', ?)")
      .run(config.admin.nome, config.admin.email, hashSenha(config.admin.senha), agora());
  }
  return db;
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

/** Configurações da plataforma: números, exceto o nome. */
function lerConfig(db) {
  const c = Object.fromEntries(db.prepare('SELECT chave, valor FROM configuracoes').all().map((r) => [r.chave, r.valor]));
  return Object.fromEntries(Object.keys(CONFIG_PADRAO).map((k) => [k, k === 'nome_plataforma' ? c[k] : Number(c[k])]));
}

/** Registra uma ação da equipe na auditoria (valores antes/depois vão em `detalhe`). */
function auditar(db, { usuario, empresaId = null, acao, alvo = null, detalhe = null, ip = null }) {
  db.prepare('INSERT INTO auditoria (empresa_id, usuario_id, usuario_nome, acao, alvo, detalhe, ip, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(empresaId ?? usuario?.empresa_id ?? null, usuario?.id ?? null, usuario?.nome ?? null, acao, alvo,
      detalhe === null || typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe), ip, agora());
}

module.exports = { abrir, transacao, lerConfig, auditar, agora, CONFIG_PADRAO, SCHEMA };
