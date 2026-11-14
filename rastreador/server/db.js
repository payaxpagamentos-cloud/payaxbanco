'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/**
 * Banco criptografado (AES-256/SQLCipher) quando RASTREADOR_DB_CHAVE está definido no .env. Sem a chave, o arquivo do banco
 * é ilegível: copiá-lo para outro servidor não adianta sem a chave. Sem a variável, usa o SQLite comum (como antes).
 * O driver cifrado (better-sqlite3-multiple-ciphers) tem a mesma API (prepare/run/get/all/exec) usada aqui.
 */
const chaveBanco = process.env.RASTREADOR_DB_CHAVE || '';
function novoBanco(arquivo) {
  if (!chaveBanco) return new DatabaseSync(arquivo);
  let Cifrado;
  try {
    Cifrado = require('better-sqlite3-multiple-ciphers');
  } catch {
    throw new Error('[Rastreador] RASTREADOR_DB_CHAVE está definido, mas o driver de banco criptografado não está instalado '
      + '(better-sqlite3-multiple-ciphers). Reinstale as dependências ou remova a chave do .env para usar o banco sem criptografia.');
  }
  const db = new Cifrado(arquivo);
  // SQLCipher com AES-256. A chave do .env vira a chave do banco; sem ela, nenhuma leitura é possível.
  db.pragma(`cipher='sqlcipher'`);
  db.pragma(`key='${String(chaveBanco).replace(/'/g, "''")}'`);
  // Confere a chave logo de cara: com a chave errada (ou um banco não cifrado), esta leitura falha com uma mensagem clara.
  try {
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch {
    db.close();
    throw new Error('[Rastreador] Não foi possível abrir o banco com a RASTREADOR_DB_CHAVE informada. Confira a chave no .env '
      + '(se o banco foi criado sem criptografia, converta-o antes: scripts/cifrar-banco.js).');
  }
  return db;
}
const config = require('./config');
const { hashSenha } = require('./lib/senha');

// Distâncias em metros, velocidades em km/h, tempos em segundos, valores em centavos (inteiros). Carimbos de tempo em ISO 8601 (UTC).
const SCHEMA = `
-- Empresas clientes (frotas ou pessoas físicas). Regras dos alertas: ignição, horário de uso e tempo sem comunicação.
CREATE TABLE IF NOT EXISTS empresas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  documento TEXT,
  tipo TEXT NOT NULL DEFAULT 'frota' CHECK (tipo IN ('frota','pessoa','locadora')),
  status TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','bloqueada','excluida')),
  email TEXT,
  telefone TEXT,
  limite_veiculos INTEGER NOT NULL DEFAULT 10 CHECK (limite_veiculos >= 0),
  mensalidade_centavos INTEGER NOT NULL DEFAULT 0 CHECK (mensalidade_centavos >= 0),
  alertar_ignicao INTEGER NOT NULL DEFAULT 0,
  -- Horário de uso permitido ('HH:MM'), nos dias da semana listados (0 = domingo). Sem horário: sem alerta de uso fora do horário.
  horario_inicio TEXT,
  horario_fim TEXT,
  dias_uso TEXT NOT NULL DEFAULT '0123456',
  -- Alerta quando o veículo fica tanto tempo sem comunicar (0 desliga).
  sem_comunicacao_min INTEGER NOT NULL DEFAULT 120 CHECK (sem_comunicacao_min >= 0),
  motivo_bloqueio TEXT,
  criada_em TEXT NOT NULL
);

-- master e suporte: equipe da plataforma (empresa_id nulo). cliente (administrador) e operador (monitora e trata alertas): da empresa.
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL CHECK (perfil IN ('master','suporte','cliente','operador')),
  empresa_id INTEGER REFERENCES empresas(id),
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_acesso TEXT,
  criado_em TEXT NOT NULL,
  CHECK ((perfil IN ('master','suporte')) = (empresa_id IS NULL))
);

-- Equipamentos. Sem empresa: no estoque do master. O IMEI (ou o identificador do app) é como o equipamento se apresenta.
-- protocolo: gt06 (TCP), osmand (HTTP, app Traccar Client e compatíveis) ou api (enviado por outro sistema com a chave da empresa).
CREATE TABLE IF NOT EXISTS rastreadores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  imei TEXT NOT NULL UNIQUE,
  modelo TEXT,
  protocolo TEXT NOT NULL DEFAULT 'gt06' CHECK (protocolo IN ('gt06','osmand','api')),
  chip_numero TEXT,
  chip_operadora TEXT,
  empresa_id INTEGER REFERENCES empresas(id),
  observacoes TEXT,
  ultima_comunicacao TEXT,
  ultimo_ip TEXT,
  criado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS motoristas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  cpf TEXT,
  cnh TEXT,
  cnh_categoria TEXT,
  cnh_validade TEXT,
  telefone TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL,
  UNIQUE (empresa_id, cpf)
);

-- Veículos, com a última posição recebida (para o mapa ao vivo) e o hodômetro e o horímetro calculados pelas posições.
CREATE TABLE IF NOT EXISTS veiculos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  placa TEXT NOT NULL,
  descricao TEXT,
  marca TEXT,
  modelo TEXT,
  cor TEXT,
  ano INTEGER,
  tipo TEXT NOT NULL DEFAULT 'carro' CHECK (tipo IN ('carro','moto','caminhao','van','onibus','maquina','outro')),
  rastreador_id INTEGER UNIQUE REFERENCES rastreadores(id),
  motorista_id INTEGER REFERENCES motoristas(id),
  limite_velocidade_kmh INTEGER NOT NULL DEFAULT 0 CHECK (limite_velocidade_kmh BETWEEN 0 AND 300),
  hodometro_m INTEGER NOT NULL DEFAULT 0 CHECK (hodometro_m >= 0),
  horimetro_s INTEGER NOT NULL DEFAULT 0 CHECK (horimetro_s >= 0),
  ativo INTEGER NOT NULL DEFAULT 1,
  bloqueado INTEGER NOT NULL DEFAULT 0,
  lat REAL,
  lng REAL,
  velocidade_kmh REAL,
  curso INTEGER,
  ignicao INTEGER,
  tensao REAL,
  posicao_em TEXT,
  comunicacao_em TEXT,
  -- Estados dos alertas (para avisar uma vez por ocorrência).
  em_excesso INTEGER NOT NULL DEFAULT 0,
  fora_horario_alertado INTEGER NOT NULL DEFAULT 0,
  sem_comunicacao_alertado INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL,
  UNIQUE (empresa_id, placa)
);

-- Histórico de posições. gps_em: hora da posição no equipamento; recebido_em: chegada ao servidor.
CREATE TABLE IF NOT EXISTS posicoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  velocidade_kmh REAL NOT NULL DEFAULT 0,
  curso INTEGER,
  altitude REAL,
  satelites INTEGER,
  ignicao INTEGER,
  tensao REAL,
  evento TEXT,
  gps_em TEXT NOT NULL,
  recebido_em TEXT NOT NULL,
  UNIQUE (veiculo_id, gps_em)
);
CREATE INDEX IF NOT EXISTS idx_posicoes_gps ON posicoes(gps_em);

-- Uso por dia (no fuso configurado): quilômetros, tempo ligado e velocidade máxima, somados a cada posição.
-- Nota do motorista por veículo e dia já fechado (motor ligado parado, tempo acima do limite, variações bruscas): calculado uma
-- vez das posições e reaproveitado. Uma posição atrasada daquele dia apaga a linha (é recalculada na próxima consulta).
CREATE TABLE IF NOT EXISTS desempenho_dia (
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  limite_kmh INTEGER NOT NULL,
  ocioso_s INTEGER NOT NULL,
  acima_s INTEGER NOT NULL,
  bruscos INTEGER NOT NULL,
  PRIMARY KEY (veiculo_id, data)
);

CREATE TABLE IF NOT EXISTS uso_diario (
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  distancia_m INTEGER NOT NULL DEFAULT 0,
  ligado_s INTEGER NOT NULL DEFAULT 0,
  velocidade_max_kmh REAL NOT NULL DEFAULT 0,
  posicoes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (veiculo_id, data)
);

-- Cercas eletrônicas: círculo (centro e raio) ou polígono ([[lat, lng], ...]). Sem veículos escolhidos, valem para todos da empresa.
CREATE TABLE IF NOT EXISTS cercas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('circulo','poligono')),
  lat REAL,
  lng REAL,
  raio_m INTEGER,
  pontos TEXT,
  alertar_entrada INTEGER NOT NULL DEFAULT 1,
  alertar_saida INTEGER NOT NULL DEFAULT 1,
  cor TEXT NOT NULL DEFAULT '#1E88E5',
  ativa INTEGER NOT NULL DEFAULT 1,
  criada_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cerca_veiculos (
  cerca_id INTEGER NOT NULL REFERENCES cercas(id) ON DELETE CASCADE,
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  PRIMARY KEY (cerca_id, veiculo_id)
);
CREATE TABLE IF NOT EXISTS cerca_estado (
  cerca_id INTEGER NOT NULL REFERENCES cercas(id) ON DELETE CASCADE,
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  dentro INTEGER NOT NULL,
  desde TEXT NOT NULL,
  PRIMARY KEY (cerca_id, veiculo_id)
);

-- Alertas: velocidade, cercas, ignição, uso fora do horário, pânico, bateria e falta de comunicação.
CREATE TABLE IF NOT EXISTS alertas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('velocidade','cerca_entrada','cerca_saida','ignicao_ligada','ignicao_desligada','fora_horario','panico',
    'bateria_desconectada','bateria_baixa','sem_comunicacao','violacao','sumico_suspeito','voltou_comunicar','estacionado_violado','vibracao','deslocamento')),
  mensagem TEXT NOT NULL,
  lat REAL,
  lng REAL,
  velocidade_kmh REAL,
  ocorrido_em TEXT NOT NULL,
  tratado_em TEXT,
  tratado_por INTEGER REFERENCES usuarios(id),
  observacao TEXT
);
CREATE INDEX IF NOT EXISTS idx_alertas_empresa ON alertas(empresa_id, ocorrido_em);
CREATE INDEX IF NOT EXISTS idx_alertas_veiculo ON alertas(veiculo_id, ocorrido_em);
CREATE INDEX IF NOT EXISTS idx_alertas_pendentes ON alertas(empresa_id) WHERE tratado_em IS NULL;

-- Comandos para o equipamento (bloqueio, desbloqueio, localização, reinício ou texto livre).
CREATE TABLE IF NOT EXISTS comandos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  rastreador_id INTEGER NOT NULL REFERENCES rastreadores(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('bloquear','desbloquear','localizar','reiniciar','status','parametros','personalizado')),
  texto TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','enviado','confirmado','falhou','expirado','cancelado')),
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  enviado_em TEXT,
  respondido_em TEXT,
  resposta TEXT
);
CREATE INDEX IF NOT EXISTS idx_comandos_abertos ON comandos(rastreador_id) WHERE status IN ('pendente','enviado');

-- Plano de manutenção por veículo (a cada X km e/ou Y dias) e o histórico do que foi feito.
CREATE TABLE IF NOT EXISTS manutencoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  descricao TEXT NOT NULL,
  intervalo_km INTEGER CHECK (intervalo_km > 0),
  intervalo_dias INTEGER CHECK (intervalo_dias > 0),
  ultima_km INTEGER NOT NULL DEFAULT 0,
  ultima_data TEXT NOT NULL,
  criada_em TEXT NOT NULL,
  CHECK (intervalo_km IS NOT NULL OR intervalo_dias IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS manutencao_registros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manutencao_id INTEGER REFERENCES manutencoes(id) ON DELETE SET NULL,
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  descricao TEXT NOT NULL,
  data TEXT NOT NULL,
  km INTEGER NOT NULL,
  custo_centavos INTEGER NOT NULL DEFAULT 0 CHECK (custo_centavos >= 0),
  observacao TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL
);

-- Link público e temporário da localização de um veículo. Só o hash do código fica guardado.
CREATE TABLE IF NOT EXISTS compartilhamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  hash TEXT NOT NULL UNIQUE,
  expira_em TEXT NOT NULL,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  revogado_em TEXT
);

-- Equipamentos que se apresentaram sem estar cadastrados (para o master cadastrar).
CREATE TABLE IF NOT EXISTS desconhecidos (
  imei TEXT PRIMARY KEY,
  protocolo TEXT NOT NULL,
  ip TEXT,
  primeiro_contato TEXT NOT NULL,
  ultimo_contato TEXT NOT NULL,
  mensagens INTEGER NOT NULL DEFAULT 1
);

-- Mensagens recebidas por dia e protocolo (dashboard e diagnóstico).
CREATE TABLE IF NOT EXISTS recepcao_diaria (
  data TEXT NOT NULL,
  protocolo TEXT NOT NULL,
  mensagens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (data, protocolo)
);

-- Chaves da API de integração (uma empresa por chave). Só o hash fica guardado.
CREATE TABLE IF NOT EXISTS chaves_api (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  prefixo TEXT NOT NULL UNIQUE,
  hash TEXT NOT NULL,
  criada_em TEXT NOT NULL,
  criada_por INTEGER REFERENCES usuarios(id),
  ultimo_uso TEXT,
  revogada_em TEXT
);

CREATE TABLE IF NOT EXISTS configuracoes (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER REFERENCES usuarios(id),
  empresa_id INTEGER REFERENCES empresas(id),
  acao TEXT NOT NULL,
  detalhes TEXT,
  ip TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auditoria ON auditoria(id DESC);

-- Módulo de roubo: a ocorrência (com o bloqueio inteligente, que espera a velocidade segura) e a linha do tempo dela.
CREATE TABLE IF NOT EXISTS ocorrencias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('aguardando','bloqueio_enviado','bloqueado','encerrada')),
  observacao TEXT,
  comando_id INTEGER,
  aviso_em TEXT,
  criada_por INTEGER REFERENCES usuarios(id),
  criada_em TEXT NOT NULL,
  encerrada_por INTEGER REFERENCES usuarios(id),
  encerrada_em TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ocorrencia_aberta ON ocorrencias(veiculo_id) WHERE status <> 'encerrada';
CREATE INDEX IF NOT EXISTS idx_ocorrencias_empresa ON ocorrencias(empresa_id, criada_em);
CREATE TABLE IF NOT EXISTS ocorrencia_eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ocorrencia_id INTEGER NOT NULL REFERENCES ocorrencias(id) ON DELETE CASCADE,
  em TEXT NOT NULL,
  texto TEXT NOT NULL,
  lat REAL,
  lng REAL,
  velocidade_kmh REAL
);
CREATE INDEX IF NOT EXISTS idx_ocorrencia_eventos ON ocorrencia_eventos(ocorrencia_id, id);

-- Modo Estacionado: o ponto vigiado (sai do raio ou liga a ignição = alerta). Um armado por veículo.
CREATE TABLE IF NOT EXISTS estacionamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  raio_m INTEGER NOT NULL,
  armado_em TEXT NOT NULL,
  armado_por INTEGER REFERENCES usuarios(id),
  automatico INTEGER NOT NULL DEFAULT 0,
  violado_em TEXT,
  motivo_violacao TEXT,
  desarmado_em TEXT,
  desarmado_por INTEGER REFERENCES usuarios(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_estacionado_armado ON estacionamentos(veiculo_id) WHERE desarmado_em IS NULL;

-- Bloqueio programado: horário diário de bloqueio por veículo (pode virar a noite: 23:00 às 06:00).
CREATE TABLE IF NOT EXISTS bloqueio_agendas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  veiculo_id INTEGER NOT NULL UNIQUE REFERENCES veiculos(id) ON DELETE CASCADE,
  dias TEXT NOT NULL DEFAULT '0123456',
  inicio TEXT NOT NULL,
  fim TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1,
  -- Janela já tratada (início do horário em que o corte foi pedido), para não repetir o corte na mesma noite.
  janela_bloqueada TEXT,
  criado_em TEXT NOT NULL
);

-- Liberação fora do horário: o motorista gera o código no app e o gestor aplica (libera por N horas).
CREATE TABLE IF NOT EXISTS liberacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  motorista_id INTEGER REFERENCES motoristas(id),
  codigo_hash TEXT NOT NULL,
  horas_pedidas INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'aguardando' CHECK (status IN ('aguardando','ativa','expirada','encerrada','cancelada')),
  criado_em TEXT NOT NULL,
  expira_em TEXT NOT NULL,
  aplicada_em TEXT,
  aplicada_por INTEGER REFERENCES usuarios(id),
  horas INTEGER,
  libera_ate TEXT,
  aviso_enviado INTEGER NOT NULL DEFAULT 0,
  encerrada_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_liberacoes_empresa ON liberacoes(empresa_id, criado_em);
CREATE INDEX IF NOT EXISTS idx_liberacoes_abertas ON liberacoes(status) WHERE status IN ('aguardando','ativa');

-- Quem recebe os avisos pelo WhatsApp (empresa_id nulo: equipe da plataforma, recebe a segurança de todas as empresas).
CREATE TABLE IF NOT EXISTS contatos_notificacao (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER REFERENCES empresas(id),
  nome TEXT NOT NULL,
  numero TEXT NOT NULL,
  tipos TEXT NOT NULL DEFAULT '',
  silencio_inicio TEXT,
  silencio_fim TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL
);

-- Fila de mensagens do WhatsApp (texto e, opcional, um PDF), com novas tentativas se a Evolution falhar.
CREATE TABLE IF NOT EXISTS mensagens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER REFERENCES empresas(id),
  numero TEXT NOT NULL,
  texto TEXT NOT NULL,
  arquivo TEXT,
  arquivo_nome TEXT,
  origem TEXT,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','enviada','falhou')),
  tentativas INTEGER NOT NULL DEFAULT 0,
  proxima_em TEXT NOT NULL,
  erro TEXT,
  criado_em TEXT NOT NULL,
  enviado_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_mensagens_pendentes ON mensagens(proxima_em) WHERE status = 'pendente';
CREATE INDEX IF NOT EXISTS idx_mensagens_empresa ON mensagens(empresa_id, criado_em);

-- Relatórios programados (PDF pelo WhatsApp) e o histórico de envios.
CREATE TABLE IF NOT EXISTS relatorios_agenda (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  frequencia TEXT NOT NULL CHECK (frequencia IN ('diario','semanal','quinzenal','mensal')),
  conteudo TEXT NOT NULL DEFAULT 'frota,seguranca,motoristas,custos',
  contatos TEXT NOT NULL DEFAULT '',
  ativo INTEGER NOT NULL DEFAULT 1,
  proximo_em TEXT NOT NULL,
  ultimo_em TEXT,
  criado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS relatorios_envios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agenda_id INTEGER REFERENCES relatorios_agenda(id) ON DELETE SET NULL,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  de TEXT NOT NULL,
  ate TEXT NOT NULL,
  destinos INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  erro TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relatorios_envios ON relatorios_envios(empresa_id, criado_em);

-- App do motorista: quem está com o veículo (assumido pelo QR code), para a nota e o custo saírem por motorista.
CREATE TABLE IF NOT EXISTS condutores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  motorista_id INTEGER NOT NULL REFERENCES motoristas(id) ON DELETE CASCADE,
  inicio TEXT NOT NULL,
  fim TEXT
);
CREATE INDEX IF NOT EXISTS idx_condutores_veiculo ON condutores(veiculo_id, inicio);
CREATE UNIQUE INDEX IF NOT EXISTS idx_condutor_aberto ON condutores(veiculo_id) WHERE fim IS NULL;

-- Checklist de saída, abastecimentos e avarias enviados pelo app do motorista (as fotos ficam em fotos).
CREATE TABLE IF NOT EXISTS checklists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  motorista_id INTEGER REFERENCES motoristas(id) ON DELETE SET NULL,
  itens TEXT NOT NULL,
  aprovado INTEGER NOT NULL,
  km INTEGER,
  observacao TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checklists_empresa ON checklists(empresa_id, criado_em);
CREATE TABLE IF NOT EXISTS abastecimentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  motorista_id INTEGER REFERENCES motoristas(id) ON DELETE SET NULL,
  litros REAL NOT NULL CHECK (litros > 0),
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  km INTEGER,
  hodometro_km INTEGER,
  posto TEXT,
  completo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_abastecimentos_veiculo ON abastecimentos(veiculo_id, criado_em);
CREATE TABLE IF NOT EXISTS avarias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  motorista_id INTEGER REFERENCES motoristas(id) ON DELETE SET NULL,
  descricao TEXT NOT NULL,
  gravidade TEXT NOT NULL CHECK (gravidade IN ('baixa','media','alta')),
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','em_andamento','resolvida')),
  observacao TEXT,
  resolvida_em TEXT,
  resolvida_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_avarias_empresa ON avarias(empresa_id, status);
CREATE TABLE IF NOT EXISTS fotos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  origem TEXT NOT NULL CHECK (origem IN ('checklist','abastecimento','avaria')),
  origem_id INTEGER NOT NULL,
  arquivo TEXT NOT NULL,
  tipo TEXT NOT NULL,
  tamanho INTEGER NOT NULL,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fotos_origem ON fotos(origem, origem_id);

-- Avisos no celular do motorista (notificações do navegador) e as chaves do servidor que as assinam.
CREATE TABLE IF NOT EXISTS push_inscricoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  motorista_id INTEGER NOT NULL REFERENCES motoristas(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  criado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chaves_servidor (
  nome TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
-- Avisos já mandados ao motorista (não repete o "bloqueio começa em 15 min" na mesma noite).
CREATE TABLE IF NOT EXISTS avisos_motorista (
  chave TEXT PRIMARY KEY,
  criado_em TEXT NOT NULL
);

-- Perguntas ao assistente por empresa e dia (limite diário).
CREATE TABLE IF NOT EXISTS ia_uso (
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  data TEXT NOT NULL,
  perguntas INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (empresa_id, data)
);

-- Seguros. Catálogo de tipos editável pelo master; integra com uma plataforma externa que emite as apólices.
-- produto_externo: código do produto na plataforma externa (preenchido quando a integração for ligada).
CREATE TABLE IF NOT EXISTS seguros_tipos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  descricao TEXT,
  icone TEXT NOT NULL DEFAULT 'seguro',
  produto_externo TEXT,
  custo_centavos INTEGER,
  ativo INTEGER NOT NULL DEFAULT 1,
  ordem INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL
);

-- Portfólio da empresa: quais tipos o master liberou para cada empresa ver e contratar.
-- margem_percent: percentual de revenda que a empresa cobra sobre o custo (preço de venda = custo × (1 + margem/100)).
CREATE TABLE IF NOT EXISTS empresa_seguros (
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  tipo_id INTEGER NOT NULL REFERENCES seguros_tipos(id),
  margem_percent REAL NOT NULL DEFAULT 0,
  habilitado_em TEXT NOT NULL,
  PRIMARY KEY (empresa_id, tipo_id)
);

-- Permissão por usuário: quais tipos cada operador pode contratar (o administrador da empresa define).
-- O administrador (cliente) pode contratar todo o portfólio sem precisar de linha aqui.
CREATE TABLE IF NOT EXISTS usuario_seguros (
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  tipo_id INTEGER NOT NULL REFERENCES seguros_tipos(id),
  liberado_em TEXT NOT NULL,
  PRIMARY KEY (usuario_id, tipo_id)
);

-- Contratações (apólices). Nascem 'pendente' e seguem para a plataforma externa, que emite e devolve o número.
CREATE TABLE IF NOT EXISTS seguros_contratacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  tipo_id INTEGER NOT NULL REFERENCES seguros_tipos(id),
  usuario_id INTEGER REFERENCES usuarios(id),
  veiculo_id INTEGER REFERENCES veiculos(id),
  motorista_id INTEGER REFERENCES motoristas(id),
  usuario_final_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','enviada','emitida','recusada','cancelada')),
  referencia_externa TEXT,
  apolice_numero TEXT,
  custo_centavos INTEGER,
  margem_percent REAL,
  valor_centavos INTEGER,
  dados TEXT,
  observacao TEXT,
  criada_em TEXT NOT NULL,
  atualizada_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_seg_contr_empresa ON seguros_contratacoes(empresa_id, criada_em);
CREATE INDEX IF NOT EXISTS idx_seg_contr_status ON seguros_contratacoes(status);

-- Usuário final (dono do veículo): entra no app do cliente com e-mail ou CPF + senha e vê só o que é dele.
CREATE TABLE IF NOT EXISTS usuarios_finais (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  email TEXT COLLATE NOCASE,
  cpf TEXT,
  telefone TEXT,
  senha_hash TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_acesso TEXT,
  criado_em TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_uf_email ON usuarios_finais(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_uf_cpf ON usuarios_finais(empresa_id, cpf) WHERE cpf IS NOT NULL;

-- Veículos que cada usuário final pode acompanhar (só os da própria empresa).
CREATE TABLE IF NOT EXISTS usuario_final_veiculos (
  usuario_final_id INTEGER NOT NULL REFERENCES usuarios_finais(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id),
  PRIMARY KEY (usuario_final_id, veiculo_id)
);

-- Teste de bloqueio feito na instalação (o técnico confirma que o motor corta e volta).
CREATE TABLE IF NOT EXISTS testes_bloqueio (
  id INTEGER PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id),
  usuario_id INTEGER REFERENCES usuarios(id),
  corte_ok INTEGER NOT NULL,
  volta_ok INTEGER NOT NULL,
  resposta_corte TEXT,
  resposta_volta TEXT,
  observacao TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_testes_bloqueio_veiculo ON testes_bloqueio (veiculo_id, id);

-- Central de multas: a consulta automática (DETRAN/SENATRAN, por um serviço contratado) ou o cadastro manual.
CREATE TABLE IF NOT EXISTS multas (
  id INTEGER PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  veiculo_id INTEGER REFERENCES veiculos(id),
  placa TEXT NOT NULL,
  auto_infracao TEXT,
  orgao TEXT,
  infracao_codigo TEXT,
  descricao TEXT NOT NULL,
  gravidade TEXT CHECK (gravidade IN ('leve','media','grave','gravissima')),
  pontos INTEGER,
  valor_centavos INTEGER,
  ocorrida_em TEXT NOT NULL,
  local_texto TEXT,
  municipio TEXT,
  prazo_indicacao TEXT,
  vencimento TEXT,
  situacao TEXT NOT NULL DEFAULT 'notificada' CHECK (situacao IN ('notificada','condutor_indicado','em_recurso','a_pagar','paga','cancelada')),
  motorista_id INTEGER REFERENCES motoristas(id),
  fonte TEXT NOT NULL DEFAULT 'manual' CHECK (fonte IN ('manual','consulta')),
  observacao TEXT,
  criada_por INTEGER REFERENCES usuarios(id),
  criada_em TEXT NOT NULL,
  atualizada_em TEXT
);
CREATE INDEX IF NOT EXISTS ix_multas_empresa ON multas (empresa_id, ocorrida_em);
CREATE INDEX IF NOT EXISTS ix_multas_veiculo ON multas (veiculo_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_multas_auto ON multas (empresa_id, auto_infracao) WHERE auto_infracao IS NOT NULL;
-- Consultas feitas na hora ("Consultar multas"): o que voltou de multas e apontamentos (débitos, restrições, roubo/furto).
CREATE TABLE IF NOT EXISTS multas_consultas (
  id INTEGER PRIMARY KEY,
  empresa_id INTEGER REFERENCES empresas(id),
  placa TEXT NOT NULL,
  renavam TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  multas INTEGER NOT NULL DEFAULT 0,
  apontamentos INTEGER NOT NULL DEFAULT 0,
  novas INTEGER NOT NULL DEFAULT 0,
  resultado TEXT,
  erro TEXT,
  criado_em TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok'
);
CREATE INDEX IF NOT EXISTS ix_multas_consultas ON multas_consultas (empresa_id, id);
-- Créditos da central de multas: o extrato de cada empresa (recargas +, consultas −, estornos +, ajustes do master).
CREATE TABLE IF NOT EXISTS multas_creditos (
  id INTEGER PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('recarga','consulta','estorno','ajuste')),
  valor_centavos INTEGER NOT NULL,
  saldo_centavos INTEGER NOT NULL,
  descricao TEXT,
  consulta_id INTEGER,
  pix_id INTEGER,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_multas_creditos ON multas_creditos (empresa_id, id);
-- Recargas por PIX: o código gerado com o valor; o master confirma o pagamento (ou o intermediário, quando houver).
CREATE TABLE IF NOT EXISTS pix_cobrancas (
  id INTEGER PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  valor_centavos INTEGER NOT NULL,
  txid TEXT NOT NULL,
  copia_cola TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','informado','pago','cancelado')),
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  informado_em TEXT,
  pago_em TEXT,
  confirmado_por INTEGER REFERENCES usuarios(id)
);
CREATE INDEX IF NOT EXISTS ix_pix_cobrancas ON pix_cobrancas (status, id);
CREATE TABLE IF NOT EXISTS multa_arquivos (
  id INTEGER PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  multa_id INTEGER NOT NULL REFERENCES multas(id) ON DELETE CASCADE,
  arquivo TEXT NOT NULL,
  tipo TEXT NOT NULL,
  tamanho INTEGER NOT NULL,
  criado_em TEXT NOT NULL
);
`;

const CONFIG_PADRAO = {
  nome_plataforma: 'Rastreador',
  // Veículo que comunicou há até N minutos conta como online.
  online_min: '10',
  // Parado por N minutos (ou com a ignição desligada) encerra a viagem nos relatórios.
  parada_min: '5',
  // Posições mais antigas que isso são apagadas.
  retencao_dias: '180',
  // Salto entre duas posições acima desta velocidade é erro do GPS: a posição é descartada.
  velocidade_max_plausivel_kmh: '250',
  // Comandos não confirmados nesse prazo expiram.
  comando_expira_horas: '24',
  limite_veiculos_padrao: '10',
  mensalidade_padrao_centavos: '4990',
  sem_comunicacao_padrao_min: '120',
  // Bloqueio inteligente (modo roubo): o corte só é enviado com o veículo abaixo desta velocidade.
  bloqueio_velocidade_segura_kmh: '20',
  // Modo Estacionado: distância do ponto que dispara o alerta.
  estacionado_raio_m: '100',
  // Sumiço suspeito: andando ou ligado e sem comunicar por N minutos.
  sumico_min: '5',
  // Código de liberação do app do motorista: validade e aviso antes de a liberação acabar.
  liberacao_codigo_min: '10',
  liberacao_aviso_min: '15',
  // Perguntas ao assistente por empresa, por dia.
  ia_limite_dia: '50',
  // Textos enviados aos rastreadores GT06 (variam por fabricante: ex. DYD,000000# e HFYD,000000#).
  gt06_cmd_bloquear: 'RELAY,1#',
  gt06_cmd_desbloquear: 'RELAY,0#',
  gt06_cmd_localizar: 'WHERE#',
  gt06_cmd_reiniciar: 'RESET#',
  // Consulta automática de multas: a cada quantos dias cada veículo é consultado (0 = manual, só pelo Consultar multas; 1, 7 ou 15 dias).
  multas_consulta_dias: '0',
  // Central de multas como produto: preço de venda padrão de cada consulta (centavos) e a chave PIX que recebe as recargas.
  multas_preco_completa: '1200',
  multas_preco_renainf: '600',
  multas_preco_resumida: '600',
  pix_chave: '',
  pix_nome: '',
  pix_cidade: 'SAO PAULO',
};
const CONFIG_TEXTO = ['pix_chave', 'pix_nome', 'pix_cidade', 'nome_plataforma', 'gt06_cmd_bloquear', 'gt06_cmd_desbloquear', 'gt06_cmd_localizar', 'gt06_cmd_reiniciar'];

const agora = () => new Date().toISOString();

function abrir(arquivo = config.dbFile) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = novoBanco(arquivo);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrar(db);

  const cfg = db.prepare('INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES (?, ?)');
  for (const [k, val] of Object.entries(CONFIG_PADRAO)) cfg.run(k, val);

  if (!db.prepare("SELECT 1 FROM usuarios WHERE perfil = 'master' LIMIT 1").get()) {
    db.prepare("INSERT INTO usuarios (nome, email, senha_hash, perfil, criado_em) VALUES (?, ?, ?, 'master', ?)")
      .run(config.admin.nome, config.admin.email, hashSenha(config.admin.senha), agora());
  }

  // Catálogo inicial de seguros (editável pelo master): 6 tipos. Só semeia se a tabela estiver vazia.
  if (!db.prepare('SELECT 1 FROM seguros_tipos LIMIT 1').get()) {
    const insSeg = db.prepare('INSERT INTO seguros_tipos (nome, descricao, icone, ativo, ordem, criado_em) VALUES (?, ?, ?, 1, ?, ?)');
    [
      ['Seguro de Guincho e Assistência 24h', 'Reboque, chaveiro, pane seca e socorro mecânico na estrada.', 'manutencao'],
      ['Proteção de Renda', 'Renda garantida ao motorista em caso de afastamento ou imprevisto.', 'carteira'],
      ['Seguro para Motorista de App', 'Cobertura para quem roda em aplicativo (Uber, 99, iFood).', 'motoristas'],
      ['Seguro do Veículo', 'Cobertura do veículo rastreado: roubo, furto e colisão.', 'veiculos'],
      ['Seguro de Acidentes Pessoais', 'Indenização por acidente com o motorista ou passageiros.', 'seguranca'],
      ['Seguro de Vida', 'Amparo à família do motorista em caso de morte ou invalidez.', 'estrela'],
    ].forEach(([nome, desc, ic], i) => insSeg.run(nome, desc, ic, i, agora()));
  }
  return db;
}

/**
 * Atualiza um banco criado por uma versão anterior: colunas novas (ALTER TABLE ADD COLUMN) e a lista de tipos de alerta
 * (a tabela de alertas é recriada com os dados, porque o SQLite não altera um CHECK).
 */
function migrar(db) {
  const colunas = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
  const NOVAS = {
    veiculos: { bloqueio_desativado: 'INTEGER NOT NULL DEFAULT 0', multas_auto: 'INTEGER NOT NULL DEFAULT 0', renavam: 'TEXT', multas_consulta_em: 'TEXT', teste_bloqueio_ok: 'INTEGER', teste_bloqueio_em: 'TEXT', consumo_km_l: 'REAL', sumico_alertado: 'INTEGER NOT NULL DEFAULT 0', estacionado_auto: 'INTEGER NOT NULL DEFAULT 0', codigo_qr: 'TEXT' },
    empresas: { preco_combustivel_centavos: 'INTEGER NOT NULL DEFAULT 0', ocioso_l_h: 'REAL NOT NULL DEFAULT 0.8', app_ranking: 'INTEGER NOT NULL DEFAULT 0',
      plano_nome: 'TEXT', plano_valor_centavos: 'INTEGER', atend_whatsapp: 'TEXT', atend_telefone: 'TEXT', atend_horario: 'TEXT',
      multas_auto_dias: 'INTEGER NOT NULL DEFAULT 0', multas_auto_tipo: "TEXT NOT NULL DEFAULT 'completa'",
      multas_credito_centavos: 'INTEGER NOT NULL DEFAULT 0', multas_preco_completa: 'INTEGER', multas_preco_renainf: 'INTEGER', multas_preco_resumida: 'INTEGER' },
    cercas: { horario_inicio: 'TEXT', horario_fim: 'TEXT', acao_saida: "TEXT NOT NULL DEFAULT 'avisar'" },
    motoristas: { senha_hash: 'TEXT', app_ultimo_acesso: 'TEXT' },
    rastreadores: { configurado_em: 'TEXT', rele_invertido: 'INTEGER NOT NULL DEFAULT 0', sinal_gsm: 'INTEGER', firmware: 'TEXT', perfil: "TEXT NOT NULL DEFAULT 'padrao'", saude: 'TEXT', saude_em: 'TEXT' },
    comandos: { rotulo: 'TEXT' },
    ocorrencias: { tipo: "TEXT NOT NULL DEFAULT 'roubo'", perseguicao: 'INTEGER NOT NULL DEFAULT 0' },
    ia_uso: { tokens_entrada: 'INTEGER NOT NULL DEFAULT 0', tokens_saida: 'INTEGER NOT NULL DEFAULT 0' },
    seguros_tipos: { custo_centavos: 'INTEGER' },
    empresa_seguros: { margem_percent: 'REAL NOT NULL DEFAULT 0' },
    seguros_contratacoes: { custo_centavos: 'INTEGER', margem_percent: 'REAL', usuario_final_id: 'INTEGER' },
    multas_consultas: { status: "TEXT NOT NULL DEFAULT 'ok'", cobrado_centavos: 'INTEGER NOT NULL DEFAULT 0' },
    multas: { sem_hora: 'INTEGER NOT NULL DEFAULT 0' },
  };
  for (const [tabela, cols] of Object.entries(NOVAS)) {
    const tem = colunas(tabela);
    for (const [nome, def] of Object.entries(cols)) {
      if (tem.has(nome)) continue;
      db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${nome} ${def}`);
      // Os rastreadores que já estavam instalados não são reconfigurados sozinhos (o gestor pode ter escolhido outro sono ou
      // perfil): a configuração automática vale só para aparelho novo ou trocado.
      if (tabela === 'rastreadores' && nome === 'configurado_em') {
        db.exec("UPDATE rastreadores SET configurado_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id IN (SELECT rastreador_id FROM veiculos WHERE rastreador_id IS NOT NULL)");
      }
    }
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_veiculo_qr ON veiculos(codigo_qr) WHERE codigo_qr IS NOT NULL');
  const sqlAlertas = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'alertas'").get()?.sql ?? '';
  if (!sqlAlertas.includes('sumico_suspeito')) {
    const criar = SCHEMA.slice(SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS alertas'), SCHEMA.indexOf('CREATE INDEX IF NOT EXISTS idx_alertas_empresa'));
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec('ALTER TABLE alertas RENAME TO alertas_antiga');
      db.exec(criar);
      db.exec(`INSERT INTO alertas (id, empresa_id, veiculo_id, tipo, mensagem, lat, lng, velocidade_kmh, ocorrido_em, tratado_em, tratado_por, observacao)
        SELECT id, empresa_id, veiculo_id, tipo, mensagem, lat, lng, velocidade_kmh, ocorrido_em, tratado_em, tratado_por, observacao FROM alertas_antiga`);
      db.exec('DROP TABLE alertas_antiga');
      db.exec(`CREATE INDEX IF NOT EXISTS idx_alertas_empresa ON alertas(empresa_id, ocorrido_em);
        CREATE INDEX IF NOT EXISTS idx_alertas_veiculo ON alertas(veiculo_id, ocorrido_em);
        CREATE INDEX IF NOT EXISTS idx_alertas_pendentes ON alertas(empresa_id) WHERE tratado_em IS NULL;`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
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

/** Configurações: números, exceto os textos (nome da plataforma e comandos GT06). */
function lerConfig(db) {
  const c = Object.fromEntries(db.prepare('SELECT chave, valor FROM configuracoes').all().map((r) => [r.chave, r.valor]));
  return Object.fromEntries(Object.keys(CONFIG_PADRAO).map((k) => [k, CONFIG_TEXTO.includes(k) ? c[k] : Number(c[k])]));
}

module.exports = { abrir, transacao, lerConfig, agora, CONFIG_PADRAO, CONFIG_TEXTO };
