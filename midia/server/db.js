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

-- Empresas que usam o sistema. Cada uma só enxerga os próprios pontos, TVs, clientes, campanhas e
-- financeiro; o master enxerga todas. O dado "raiz" de cada coisa carrega a empresa (empresa_id).
CREATE TABLE IF NOT EXISTS empresas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  documento TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL
);

-- Quem paga pela publicidade.
CREATE TABLE IF NOT EXISTS anunciantes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER REFERENCES empresas(id),
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
  empresa_id INTEGER REFERENCES empresas(id),
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
  -- Prova visual: a última foto do que estava na tela (o próprio player desenha e envia).
  foto_arquivo TEXT,
  foto_em TEXT,
  foto_item TEXT,
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
  empresa_id INTEGER REFERENCES empresas(id),
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
  empresa_id INTEGER REFERENCES empresas(id),
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
  empresa_id INTEGER REFERENCES empresas(id),
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
  -- Quando o fato acontece (assembleia, dedetização, entrega). Alimenta a agenda na tela.
  evento_em TEXT,
  evento_hora TEXT,
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
  contrato_id INTEGER REFERENCES contratos(id),
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

-- Fila de comandos para a tela, entregues na batida (que acontece de minuto em minuto):
-- recarregar o player (para subir uma versão nova), limpar o cache dos arquivos ou reiniciar.
CREATE TABLE IF NOT EXISTS tela_comandos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tela_id INTEGER NOT NULL REFERENCES telas(id) ON DELETE CASCADE,
  comando TEXT NOT NULL CHECK (comando IN ('recarregar','limpar_cache','reiniciar')),
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  entregue_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_comandos_tela ON tela_comandos (tela_id, entregue_em);

-- Vida da TV: pareamento, quedas, voltas e erros do player (base do tempo no ar).
CREATE TABLE IF NOT EXISTS telas_eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tela_id INTEGER NOT NULL REFERENCES telas(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('pareada','online','offline','erro','reinicio','desparear','comando')),
  detalhe TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eventos_tela ON telas_eventos (tela_id, criado_em);

-- Contrato do cliente: o acordo comercial que sustenta as campanhas dele. Fica na ficha do anunciante.
CREATE TABLE IF NOT EXISTS contratos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  anunciante_id INTEGER NOT NULL REFERENCES anunciantes(id),
  agencia_id INTEGER REFERENCES agencias(id),
  numero TEXT NOT NULL,
  objeto TEXT,
  inicio TEXT NOT NULL,
  fim TEXT,
  cobranca TEXT NOT NULL DEFAULT 'mensal' CHECK (cobranca IN ('mensal','cpm','pacote','cortesia')),
  valor_centavos INTEGER NOT NULL DEFAULT 0 CHECK (valor_centavos >= 0),
  vencimento_dia INTEGER NOT NULL DEFAULT 10 CHECK (vencimento_dia BETWEEN 1 AND 28),
  -- Reajuste: o índice é só o nome do combinado ("IPCA a cada 12 meses"); o que o sistema usa são os
  -- meses de periodicidade e, quando o percentual é fixo, o percentual (em centésimos: 450 = 4,5%).
  -- Sem percentual fixo o sistema avisa na data e a equipe decide quanto aplicar.
  reajuste TEXT,
  reajuste_meses INTEGER NOT NULL DEFAULT 12 CHECK (reajuste_meses BETWEEN 0 AND 120),
  reajuste_percentual INTEGER NOT NULL DEFAULT 0 CHECK (reajuste_percentual BETWEEN 0 AND 10000),
  ultimo_reajuste TEXT,
  renovacao_automatica INTEGER NOT NULL DEFAULT 0,
  renovado_em TEXT,
  renovacoes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('rascunho','ativo','suspenso','encerrado')),
  observacao TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  UNIQUE (numero),
  CHECK (fim IS NULL OR fim >= inicio)
);
CREATE INDEX IF NOT EXISTS idx_contratos_anunciante ON contratos (anunciante_id, status);

-- Cada reajuste aplicado, para saber de onde veio o valor de hoje (e para o cliente poder conferir).
CREATE TABLE IF NOT EXISTS contrato_reajustes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contrato_id INTEGER NOT NULL REFERENCES contratos(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  percentual INTEGER NOT NULL,
  indice TEXT,
  de_centavos INTEGER NOT NULL,
  para_centavos INTEGER NOT NULL,
  campanhas INTEGER NOT NULL DEFAULT 0,
  automatico INTEGER NOT NULL DEFAULT 0,
  aplicado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reajustes_contrato ON contrato_reajustes (contrato_id, data);

-- Clima por cidade (uma consulta serve todas as telas da cidade). Ver lib/clima.js.
CREATE TABLE IF NOT EXISTS clima (
  cidade TEXT NOT NULL,
  uf TEXT NOT NULL,
  temperatura REAL NOT NULL,
  maxima REAL,
  minima REAL,
  codigo INTEGER NOT NULL DEFAULT 0,
  atualizado_em TEXT NOT NULL,
  PRIMARY KEY (cidade, uf)
);

-- CRM: quem ainda não é cliente. Um lead pode ser quem quer anunciar ou um condomínio que quer tela.
-- É de onde nascem a proposta, o contrato e a campanha — e, do outro lado, o ponto novo na rede.
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER REFERENCES empresas(id),
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'anunciante' CHECK (tipo IN ('anunciante','ponto')),
  contato TEXT,
  email TEXT,
  telefone TEXT,
  cidade TEXT,
  uf TEXT,
  origem TEXT NOT NULL DEFAULT 'prospeccao' CHECK (origem IN ('site','indicacao','prospeccao','evento','outro')),
  etapa TEXT NOT NULL DEFAULT 'novo' CHECK (etapa IN ('novo','contato','proposta','negociacao','ganho','perdido')),
  responsavel_id INTEGER REFERENCES usuarios(id),
  valor_estimado_centavos INTEGER NOT NULL DEFAULT 0 CHECK (valor_estimado_centavos >= 0),
  -- O próximo passo combinado e quando: é o que impede o lead de morrer esquecido numa coluna.
  proximo_passo TEXT,
  proximo_em TEXT,
  mensagem TEXT,
  observacao TEXT,
  motivo TEXT,
  anunciante_id INTEGER REFERENCES anunciantes(id),
  local_id INTEGER REFERENCES locais(id),
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  ganho_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_leads_etapa ON leads (etapa, proximo_em);

-- Cada conversa com o lead: o histórico que faz a próxima ligação começar de onde a última parou.
CREATE TABLE IF NOT EXISTS lead_interacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL DEFAULT 'nota' CHECK (tipo IN ('nota','ligacao','email','whatsapp','reuniao','visita','etapa')),
  texto TEXT NOT NULL,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interacoes_lead ON lead_interacoes (lead_id, criado_em);

-- Caixa de entrada do CRM: as mensagens que chegam no servidor de e-mail da própria plataforma e as
-- respostas que saem daqui. O corpo fica no banco (texto limpo) e a mensagem original inteira, com anexos,
-- fica em disco (.eml) — é ela que vale como prova do que o cliente escreveu.
-- A ligação com o lead é por e-mail do remetente: a conversa aparece na ficha de quem está no funil.
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER REFERENCES empresas(id),
  direcao TEXT NOT NULL CHECK (direcao IN ('entrada','saida')),
  de TEXT NOT NULL,
  de_nome TEXT,
  para TEXT NOT NULL,
  assunto TEXT NOT NULL DEFAULT '',
  previa TEXT NOT NULL DEFAULT '',
  texto TEXT,
  -- Identificadores do próprio e-mail, que amarram pergunta e resposta na mesma conversa.
  message_id TEXT,
  em_resposta_a TEXT,
  thread TEXT,
  arquivo TEXT,
  tamanho INTEGER NOT NULL DEFAULT 0,
  anexos INTEGER NOT NULL DEFAULT 0,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  anunciante_id INTEGER REFERENCES anunciantes(id) ON DELETE SET NULL,
  local_id INTEGER REFERENCES locais(id) ON DELETE SET NULL,
  lido_em TEXT,
  arquivado_em TEXT,
  ip TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  recebido_em TEXT NOT NULL,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_caixa ON emails (arquivado_em, recebido_em);
CREATE INDEX IF NOT EXISTS idx_emails_lead ON emails (lead_id, recebido_em);
CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails (thread, recebido_em);
CREATE INDEX IF NOT EXISTS idx_emails_de ON emails (de);

-- Propostas comerciais. A proposta guarda o CÁLCULO DO DIA em que foi feita (a coluna folha, um JSON):
-- a rede muda toda semana, e reimprimir uma proposta de dois meses atrás tem de mostrar o que foi oferecido,
-- não o inventário de hoje. Quando o cliente aceita, ela vira contrato e campanha sem ninguém redigitar nada.
CREATE TABLE IF NOT EXISTS propostas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER REFERENCES empresas(id),
  numero TEXT NOT NULL,
  anunciante_id INTEGER REFERENCES anunciantes(id),
  agencia_id INTEGER REFERENCES agencias(id),
  circuito_id INTEGER REFERENCES circuitos(id),
  titulo TEXT NOT NULL,
  meses INTEGER NOT NULL DEFAULT 3 CHECK (meses BETWEEN 1 AND 36),
  desconto_percentual INTEGER NOT NULL DEFAULT 0 CHECK (desconto_percentual BETWEEN 0 AND 5000),
  insercoes_hora INTEGER NOT NULL DEFAULT 6,
  mes_centavos INTEGER NOT NULL DEFAULT 0,
  total_centavos INTEGER NOT NULL DEFAULT 0,
  valida_ate TEXT NOT NULL,
  observacao TEXT,
  status TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','enviada','aceita','recusada')),
  motivo TEXT,
  folha TEXT NOT NULL,
  -- Endereço público da proposta (o que vai no WhatsApp). Quem tem o link vê a folha; ninguém mais.
  link_token TEXT,
  aberta_em TEXT,
  aberturas INTEGER NOT NULL DEFAULT 0,
  contrato_id INTEGER REFERENCES contratos(id),
  campanha_id INTEGER REFERENCES campanhas(id),
  enviada_em TEXT,
  respondida_em TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  UNIQUE (numero)
);
CREATE INDEX IF NOT EXISTS idx_propostas_status ON propostas (status, criado_em);

-- Contas a pagar da operação (o que não é repasse ao ponto): internet do prédio, aparelho, manutenção,
-- comissão de vendedor, aluguel de espaço. Repasse tem tabela própria e aparece junto na tela.
CREATE TABLE IF NOT EXISTS despesas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER REFERENCES empresas(id),
  descricao TEXT NOT NULL,
  fornecedor TEXT,
  categoria TEXT NOT NULL DEFAULT 'outros',
  local_id INTEGER REFERENCES locais(id),
  competencia TEXT,
  vencimento TEXT NOT NULL,
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos >= 0),
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','paga','cancelada')),
  pago_em TEXT,
  repete_meses INTEGER NOT NULL DEFAULT 0 CHECK (repete_meses >= 0),
  observacao TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_despesas_vencimento ON despesas (status, vencimento);

-- Faturas do anunciante (uma por competência) e o detalhe por campanha.
CREATE TABLE IF NOT EXISTS faturas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  anunciante_id INTEGER NOT NULL REFERENCES anunciantes(id),
  agencia_id INTEGER REFERENCES agencias(id),
  contrato_id INTEGER REFERENCES contratos(id),
  competencia TEXT NOT NULL,
  vencimento TEXT NOT NULL,
  -- bruto = soma das veiculações; valor = o que a plataforma recebe (bruto menos a comissão da agência).
  bruto_centavos INTEGER NOT NULL DEFAULT 0 CHECK (bruto_centavos >= 0),
  comissao_agencia_centavos INTEGER NOT NULL DEFAULT 0 CHECK (comissao_agencia_centavos >= 0),
  valor_centavos INTEGER NOT NULL DEFAULT 0 CHECK (valor_centavos >= 0),
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','paga','cancelada')),
  pago_em TEXT,
  -- Nota fiscal de serviço: a emissão é feita no sistema da prefeitura (exige certificado digital),
  -- e aqui fica o registro de qual nota corresponde a esta fatura.
  nf_numero TEXT,
  nf_emitida_em TEXT,
  nf_link TEXT,
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
  empresa_id INTEGER REFERENCES empresas(id),
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL CHECK (perfil IN ('master','administrador','operador','anunciante','lojista')),
  anunciante_id INTEGER REFERENCES anunciantes(id),
  local_id INTEGER REFERENCES locais(id),
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_acesso TEXT,
  criado_em TEXT NOT NULL,
  -- Segurança do acesso: trocar a senha aumenta a versão e derruba as sessões antigas;
  -- senha errada várias vezes seguidas trava a conta por alguns minutos.
  sessao_versao INTEGER NOT NULL DEFAULT 0,
  falhas INTEGER NOT NULL DEFAULT 0,
  bloqueado_ate TEXT,
  -- Verificação em duas etapas (aplicativo autenticador) e os códigos de reserva (resumos, uso único).
  totp_segredo TEXT,
  totp_ativo INTEGER NOT NULL DEFAULT 0,
  totp_reserva TEXT,
  CHECK ((perfil = 'anunciante') = (anunciante_id IS NOT NULL)),
  CHECK ((perfil = 'lojista') = (local_id IS NOT NULL))
);

-- Pedidos de nova senha: o link vale por pouco tempo e só serve uma vez. Guardamos o resumo do código,
-- nunca ele mesmo — quem puser as mãos no banco não consegue entrar na conta de ninguém.
CREATE TABLE IF NOT EXISTS senha_pedidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  codigo_hash TEXT NOT NULL,
  expira_em TEXT NOT NULL,
  usado_em TEXT,
  ip TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_senha_pedidos ON senha_pedidos (usuario_id, usado_em);

-- Marca o que já foi avisado por e-mail, para não repetir o mesmo aviso todo ciclo.
CREATE TABLE IF NOT EXISTS avisos (
  chave TEXT PRIMARY KEY,
  criado_em TEXT NOT NULL
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

-- Empresa de quem não informou: herda do anunciante, do ponto ou do lead ligado; sem nada, a empresa inicial.
-- (O painel grava a empresa de quem está criando; isto cobre o site, os portais e a caixa de e-mail.)
CREATE TRIGGER IF NOT EXISTS empresa_anunciantes AFTER INSERT ON anunciantes WHEN NEW.empresa_id IS NULL
BEGIN UPDATE anunciantes SET empresa_id = (SELECT MIN(id) FROM empresas WHERE ativo = 1) WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS empresa_locais AFTER INSERT ON locais WHEN NEW.empresa_id IS NULL
BEGIN UPDATE locais SET empresa_id = (SELECT MIN(id) FROM empresas WHERE ativo = 1) WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS empresa_agencias AFTER INSERT ON agencias WHEN NEW.empresa_id IS NULL
BEGIN UPDATE agencias SET empresa_id = (SELECT MIN(id) FROM empresas WHERE ativo = 1) WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS empresa_circuitos AFTER INSERT ON circuitos WHEN NEW.empresa_id IS NULL
BEGIN UPDATE circuitos SET empresa_id = (SELECT MIN(id) FROM empresas WHERE ativo = 1) WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS empresa_leads AFTER INSERT ON leads WHEN NEW.empresa_id IS NULL
BEGIN UPDATE leads SET empresa_id = (SELECT MIN(id) FROM empresas WHERE ativo = 1) WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS empresa_despesas AFTER INSERT ON despesas WHEN NEW.empresa_id IS NULL
BEGIN UPDATE despesas SET empresa_id = (SELECT MIN(id) FROM empresas WHERE ativo = 1) WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS empresa_midias AFTER INSERT ON midias WHEN NEW.empresa_id IS NULL
BEGIN UPDATE midias SET empresa_id = COALESCE((SELECT empresa_id FROM anunciantes WHERE id = NEW.anunciante_id), (SELECT empresa_id FROM locais WHERE id = NEW.local_id), (SELECT MIN(id) FROM empresas WHERE ativo = 1)) WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS empresa_propostas AFTER INSERT ON propostas WHEN NEW.empresa_id IS NULL
BEGIN UPDATE propostas SET empresa_id = COALESCE((SELECT empresa_id FROM leads WHERE id = NEW.lead_id), (SELECT empresa_id FROM anunciantes WHERE id = NEW.anunciante_id), (SELECT MIN(id) FROM empresas WHERE ativo = 1)) WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS empresa_emails AFTER INSERT ON emails WHEN NEW.empresa_id IS NULL
BEGIN UPDATE emails SET empresa_id = COALESCE((SELECT empresa_id FROM leads WHERE id = NEW.lead_id), (SELECT MIN(id) FROM empresas WHERE ativo = 1)) WHERE id = NEW.id; END;
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
  // Avisos automáticos por e-mail (tela fora do ar, fatura vencida, fila de aprovação parada).
  avisos_email: '1',
  // Por quantos dias a prova de exibição detalhada é guardada (o resumo por dia, que alimenta
  // relatórios e faturamento, nunca é apagado). 0 = guardar tudo.
  prova_dias: '180',
  // Clima do dia na tela (Open-Meteo, sem chave). Depende de internet no servidor, por isso vem desligado.
  clima_ligado: '0',
  // De quanto em quanto tempo a TV manda uma foto do que está na tela (0 desliga).
  foto_minutos: '30',
  // Quantos dias antes do fim do contrato a equipe é avisada.
  contrato_aviso_dias: '30',
  // WhatsApp da empresa: é o canal que aparece para o cliente no site, nos portais e na proposta.
  whatsapp: '',
  // CNPJ da empresa (prestador do serviço), usado na planilha que vai ao contador para emitir as notas.
  empresa_documento: '',
  // Dados do PIX impresso na fatura do anunciante.
  pix_chave: '',
  pix_nome: '',
  pix_cidade: '',
};
const TEXTO = new Set(['nome_plataforma', 'slogan', 'whatsapp', 'empresa_documento', 'pix_chave', 'pix_nome', 'pix_cidade']);

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

  // Empresas: a primeira instalação (ou a atualização que trouxe as empresas) cria a empresa inicial
  // com o nome da plataforma, e tudo o que já existia passa a ser dela — uma vez só.
  if (!db.prepare('SELECT 1 FROM empresas LIMIT 1').get()) {
    db.prepare('INSERT INTO empresas (nome, criado_em) VALUES (?, ?)')
      .run(db.prepare("SELECT valor FROM configuracoes WHERE chave = 'nome_plataforma'").get()?.valor || CONFIG_PADRAO.nome_plataforma, agora());
  }
  if (!db.prepare("SELECT 1 FROM configuracoes WHERE chave = '_empresas_migradas'").get()) {
    const inicial = db.prepare('SELECT id FROM empresas ORDER BY id LIMIT 1').get().id;
    for (const t of ['locais', 'anunciantes', 'agencias', 'circuitos', 'leads', 'propostas', 'despesas', 'midias', 'emails']) {
      db.prepare(`UPDATE ${t} SET empresa_id = ? WHERE empresa_id IS NULL`).run(inicial);
    }
    db.prepare("UPDATE usuarios SET empresa_id = ? WHERE empresa_id IS NULL AND perfil IN ('administrador','operador')").run(inicial);
    db.prepare("INSERT INTO configuracoes (chave, valor) VALUES ('_empresas_migradas', '1')").run();
  }

  if (!db.prepare("SELECT 1 FROM usuarios WHERE perfil = 'master' LIMIT 1").get()) {
    db.prepare("INSERT INTO usuarios (nome, email, senha_hash, perfil, criado_em) VALUES (?, ?, ?, 'master', ?)")
      .run(config.admin.nome, config.admin.email, hashSenha(config.admin.senha), agora());
  }
  return db;
}

/** Colunas que entraram depois da primeira versão (bancos antigos recebem cada uma por ALTER TABLE). */
const COLUNAS_NOVAS = [
  ['usuarios', 'sessao_versao', 'INTEGER NOT NULL DEFAULT 0'],
  ['usuarios', 'falhas', 'INTEGER NOT NULL DEFAULT 0'],
  ['usuarios', 'bloqueado_ate', 'TEXT'],
  ['usuarios', 'totp_segredo', 'TEXT'],
  ['usuarios', 'totp_ativo', 'INTEGER NOT NULL DEFAULT 0'],
  ['usuarios', 'totp_reserva', 'TEXT'],
  ['usuarios', 'empresa_id', 'INTEGER REFERENCES empresas(id)'],
  ['locais', 'empresa_id', 'INTEGER REFERENCES empresas(id)'],
  ['anunciantes', 'empresa_id', 'INTEGER REFERENCES empresas(id)'],
  ['agencias', 'empresa_id', 'INTEGER REFERENCES empresas(id)'],
  ['circuitos', 'empresa_id', 'INTEGER REFERENCES empresas(id)'],
  ['leads', 'empresa_id', 'INTEGER REFERENCES empresas(id)'],
  ['propostas', 'empresa_id', 'INTEGER REFERENCES empresas(id)'],
  ['despesas', 'empresa_id', 'INTEGER REFERENCES empresas(id)'],
  ['midias', 'empresa_id', 'INTEGER REFERENCES empresas(id)'],
  ['emails', 'empresa_id', 'INTEGER REFERENCES empresas(id)'],
  ['locais', 'administradora', 'TEXT'],
  ['locais', 'unidades', 'INTEGER NOT NULL DEFAULT 0'],
  ['locais', 'repasse_tipo', "TEXT NOT NULL DEFAULT 'comissao'"],
  ['locais', 'repasse_fixo_centavos', 'INTEGER NOT NULL DEFAULT 0'],
  ['telas', 'posicao', 'TEXT'],
  ['telas', 'layout', "TEXT NOT NULL DEFAULT 'cheia'"],
  ['locais', 'logo_arquivo', 'TEXT'],
  ['comunicados', 'imagem_arquivo', 'TEXT'],
  ['comunicados', 'imagem_mime', 'TEXT'],
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
  ['campanhas', 'contrato_id', 'INTEGER REFERENCES contratos(id)'],
  ['faturas', 'contrato_id', 'INTEGER REFERENCES contratos(id)'],
  ['contratos', 'reajuste_meses', 'INTEGER NOT NULL DEFAULT 12'], ['contratos', 'reajuste_percentual', 'INTEGER NOT NULL DEFAULT 0'],
  ['contratos', 'ultimo_reajuste', 'TEXT'], ['contratos', 'renovado_em', 'TEXT'], ['contratos', 'renovacoes', 'INTEGER NOT NULL DEFAULT 0'],
  ['propostas', 'lead_id', 'INTEGER REFERENCES leads(id)'],
  ['propostas', 'link_token', 'TEXT'], ['propostas', 'aberta_em', 'TEXT'], ['propostas', 'aberturas', 'INTEGER NOT NULL DEFAULT 0'],
  ['locais', 'latitude', 'REAL'], ['locais', 'longitude', 'REAL'],
  ['comunicados', 'evento_em', 'TEXT'], ['comunicados', 'evento_hora', 'TEXT'],
  ['telas', 'foto_arquivo', 'TEXT'], ['telas', 'foto_em', 'TEXT'], ['telas', 'foto_item', 'TEXT'],
  ['faturas', 'nf_numero', 'TEXT'], ['faturas', 'nf_emitida_em', 'TEXT'], ['faturas', 'nf_link', 'TEXT'],
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
  // Perfil administrador (tudo menos atualizar o sistema e o backup): bancos antigos não aceitavam o valor.
  if (!/'administrador'/.test(sqlDaTabela(db, 'usuarios'))) refazerTabela(db, 'usuarios');
  if (!/'comando'/.test(sqlDaTabela(db, 'telas_eventos'))) refazerTabela(db, 'telas_eventos');
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
