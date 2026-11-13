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
  -- Quanto esta empresa aceita gastar com a Meta por mês, em milésimos de real (0 = sem teto).
  -- Estourado o teto, só sai mensagem grátis: a conta não passa do que a gestão aprovou.
  orcamento_milesimos INTEGER NOT NULL DEFAULT 0 CHECK (orcamento_milesimos >= 0),
  -- Marketing tem orçamento próprio: é nove vezes mais caro e não pode comer o dinheiro da cobrança.
  orcamento_marketing_milesimos INTEGER NOT NULL DEFAULT 0 CHECK (orcamento_marketing_milesimos >= 0),
  -- Em que moeda a Meta cobra a conta desta empresa. Em dólar, o custo de cada mensagem é guardado
  -- também em dólar (exato), para conferir com a fatura sem câmbio no meio.
  meta_moeda TEXT NOT NULL DEFAULT 'BRL' CHECK (meta_moeda IN ('BRL','USD')),
  -- 1: usa o dólar do dia (PTAX de venda do Banco Central, buscado sozinho). 0: usa a cotação informada à mão.
  cotacao_auto INTEGER NOT NULL DEFAULT 1,
  -- Cotação informada à mão (reais por dólar ×10000). Também é a reserva se o Banco Central não responder.
  cotacao_x10000 INTEGER CHECK (cotacao_x10000 IS NULL OR cotacao_x10000 > 0),
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
  -- Ramal da pessoa na central telefônica. Quando uma ligação que passou pela ZOE toca e é atendida
  -- neste ramal, o painel dela abre sozinho com tudo o que o cliente já disse.
  ramal TEXT,
  visto_em TEXT,
  ultimo_acesso TEXT,
  criado_em TEXT NOT NULL,
  CHECK ((perfil IN ('master','suporte')) = (empresa_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_ramal ON usuarios(empresa_id, ramal) WHERE ramal IS NOT NULL;

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

-- Filas (departamentos): para onde a ZOE transfere o que não resolve.
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

-- O atendimento. 'bot': a ZOE está conduzindo. 'aguardando': na fila, esperando um humano.
-- 'humano': um atendente assumiu. 'encerrada': terminou.
CREATE TABLE IF NOT EXISTS conversas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  contato_id INTEGER NOT NULL REFERENCES contatos(id),
  numero_id INTEGER NOT NULL REFERENCES numeros(id),
  estado TEXT NOT NULL DEFAULT 'bot' CHECK (estado IN ('bot','aguardando','humano','encerrada')),
  -- Por onde a conversa acontece. A ZOE é uma só nos dois canais: mesmas regras, mesmas ferramentas,
  -- mesmo portão de identidade. Muda só a forma de entregar a resposta (mensagem ou fala).
  canal TEXT NOT NULL DEFAULT 'whatsapp' CHECK (canal IN ('whatsapp','telefone')),
  -- O identificador da ligação na central telefônica (uniqueid do Asterisk), quando é telefone.
  ligacao_uid TEXT,
  -- Ligação por teclas: 1 enquanto o cliente está no menu principal (a próxima tecla é uma opção dele).
  voz_no_menu INTEGER NOT NULL DEFAULT 0,
  -- Ligação transferida: em que ramal foi atendida e quando. passagem_vista_em marca que o atendente
  -- já viu a passagem (o que o cliente disse e o que a ZOE fez), para o aviso não abrir de novo.
  ligacao_ramal TEXT,
  ligacao_atendida_em TEXT,
  passagem_vista_em TEXT,
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversa_aberta ON conversas(contato_id, canal) WHERE estado <> 'encerrada';

-- Todas as mensagens, nos dois sentidos. As de saída passam pela fila de envio (status 'fila').
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversas_ligacao ON conversas (empresa_id, ligacao_uid) WHERE ligacao_uid IS NOT NULL;

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
  -- O que a Meta cobra por esta mensagem. 'servico' é de graça (o cliente falou primeiro e a
  -- resposta saiu dentro de 24 h); as outras custam, em milésimos de real.
  categoria TEXT CHECK (categoria IN ('servico','utilidade','autenticacao','marketing')),
  custo_milesimos INTEGER NOT NULL DEFAULT 0,
  -- Identificadores da Meta: o da mensagem e o da mensagem respondida.
  wa_id TEXT,
  responde_wa_id TEXT,
  -- 'falada': resposta dada por voz numa ligação. Nunca entra na fila de envio do WhatsApp.
  status TEXT NOT NULL DEFAULT 'recebida' CHECK (status IN ('recebida','fila','enviada','entregue','lida','falhou','falada')),
  erro TEXT,
  -- Áudio do cliente vira texto aqui, sem tocar na coluna texto — assim fica registrado que a
  -- mensagem veio falada, e quem lê sabe que pode ter erro de transcrição.
  -- Custo exato em milionésimos de dólar, quando a conta da Meta é em dólar.
  custo_usd_micro INTEGER,
  transcricao TEXT,
  transcricao_status TEXT CHECK (transcricao_status IN ('pronta','falhou','longa','desligada')),
  transcricao_ms INTEGER,
  tentativas INTEGER NOT NULL DEFAULT 0,
  proxima_em TEXT,
  criada_em TEXT NOT NULL,
  enviada_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_mensagens_conversa ON mensagens(conversa_id, id);
CREATE INDEX IF NOT EXISTS idx_mensagens_fila ON mensagens(status, proxima_em);
-- Gasto do mês por empresa (freio do orçamento, a cada destinatário de régua) e relatórios de custo.
CREATE INDEX IF NOT EXISTS idx_mensagens_empresa_data ON mensagens(empresa_id, criada_em);
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

-- Configuração da ZOE, por empresa.
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
  -- Resolver antes de transferir: quando o cliente pede uma pessoa sem dizer o assunto, a ZOE
  -- pergunta o assunto UMA vez e tenta resolver. Pediu de novo, transfere na hora.
  tentar_antes INTEGER NOT NULL DEFAULT 1,
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
  -- Como o cliente responde numa ligação: falando ('fala') ou pelo teclado ('teclas').
  -- Nos dois modos é a mesma ZOE; muda só a forma de perguntar e de ouvir.
  voz_modo TEXT NOT NULL DEFAULT 'fala' CHECK (voz_modo IN ('fala','teclas')),
  -- Menu principal do modo teclas: [{ "tecla": "1", "rotulo": "Segunda via", "pedido": "Quero a segunda via..." }].
  -- Vazio usa o menu padrão. Cada tecla vira o pedido, que passa pelo cérebro como se fosse dito.
  voz_menu TEXT,
  atualizada_em TEXT
);

-- Régua: mensagens que a empresa dispara (cobrança, manutenção, campanha). É onde a conta da Meta
-- é feita ou desfeita, porque toda mensagem ativa é cobrada.
CREATE TABLE IF NOT EXISTS reguas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'cobranca' CHECK (tipo IN ('cobranca','manutencao','aviso','campanha')),
  categoria TEXT NOT NULL DEFAULT 'utilidade' CHECK (categoria IN ('utilidade','marketing','autenticacao')),
  template TEXT NOT NULL,
  idioma TEXT NOT NULL DEFAULT 'pt_BR',
  -- Como preencher as variáveis do template: lista de campos ({{1}}, {{2}}...), um por linha.
  -- Campos: nome, primeiro_nome, vencimento, valor, plano, dias_atraso, protocolo, empresa.
  parametros TEXT,
  -- Texto equivalente para quando a janela de 24 h estiver aberta (sai de graça, como serviço).
  texto_janela TEXT,
  -- Quando dispara, em relação ao vencimento da fatura.
  gatilho TEXT NOT NULL DEFAULT 'dias_antes_vencimento'
    CHECK (gatilho IN ('dias_antes_vencimento','no_vencimento','dias_apos_vencimento','manual')),
  dias INTEGER NOT NULL DEFAULT 3 CHECK (dias >= 0),
  hora TEXT NOT NULL DEFAULT '09:00',
  dias_semana TEXT NOT NULL DEFAULT '0111110',
  -- As decisões que derrubam a conta. Todas ligadas por padrão.
  preferir_janela INTEGER NOT NULL DEFAULT 1,
  pular_se_conversa_aberta INTEGER NOT NULL DEFAULT 1,
  pular_se_pago INTEGER NOT NULL DEFAULT 1,
  repetir_apos_dias INTEGER NOT NULL DEFAULT 5 CHECK (repetir_apos_dias >= 0),
  -- Horas que vale esperar pela janela de 24 h antes de gastar um template (0 = manda agora).
  -- Aviso que tem folga não precisa ser pago: se o cliente escrever antes do prazo, sai de graça.
  esperar_janela_h INTEGER NOT NULL DEFAULT 0 CHECK (esperar_janela_h BETWEEN 0 AND 168),
  -- Teto de gasto por execução, em milésimos de real (0 = sem teto).
  teto_milesimos INTEGER NOT NULL DEFAULT 0 CHECK (teto_milesimos >= 0),
  ativa INTEGER NOT NULL DEFAULT 0,
  ultima_execucao_em TEXT,
  criada_em TEXT NOT NULL,
  UNIQUE (empresa_id, nome)
);

-- Cada destinatário de cada execução: o que foi feito, quanto custou e quanto deixou de custar.
CREATE TABLE IF NOT EXISTS disparos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  regua_id INTEGER REFERENCES reguas(id) ON DELETE SET NULL,
  contato_id INTEGER REFERENCES contatos(id),
  conversa_id INTEGER REFERENCES conversas(id) ON DELETE SET NULL,
  mensagem_id INTEGER REFERENCES mensagens(id) ON DELETE SET NULL,
  referencia TEXT,
  categoria TEXT CHECK (categoria IN ('servico','utilidade','autenticacao','marketing')),
  -- 'esperando': foi para a sala de espera da janela em vez de virar template pago agora.
  status TEXT NOT NULL CHECK (status IN ('enviado','pulado','falhou','esperando')),
  motivo TEXT,
  custo_milesimos INTEGER NOT NULL DEFAULT 0,
  economia_milesimos INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_disparos_empresa ON disparos(empresa_id, criado_em);
CREATE INDEX IF NOT EXISTS idx_disparos_regua ON disparos(regua_id, criado_em);
CREATE INDEX IF NOT EXISTS idx_disparos_contato ON disparos(contato_id, regua_id, criado_em);

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
  -- Retenção: todo caso em que o cliente ameaçou sair (não só o pedido de cancelamento — também a
  -- reclamação ou o Procon com "vou trocar de provedor"). O motivo diz por que ele queria sair.
  ameaca_saida INTEGER NOT NULL DEFAULT 0,
  motivo_saida TEXT CHECK (motivo_saida IN ('preco','qualidade','atendimento','mudanca','concorrente','financeiro','sem_uso','outro')),
  motivo_detalhe TEXT,
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

-- As ofertas feitas para o cliente ficar, e se ele aceitou. É daqui que sai qual oferta segura
-- mais cliente para cada motivo de saída — e quanto a retenção custou.
CREATE TABLE IF NOT EXISTS ouvidoria_ofertas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ouvidoria_id INTEGER NOT NULL REFERENCES ouvidoria(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('desconto','upgrade','visita_tecnica','isencao','troca_equipamento','downgrade','pausa','outro')),
  descricao TEXT,
  -- Quanto a oferta custa por mês (desconto) e por quantos meses; isenção é valor único em meses = 1.
  valor_mensal_centavos INTEGER NOT NULL DEFAULT 0,
  meses INTEGER NOT NULL DEFAULT 0,
  -- null: o cliente ainda não respondeu.
  aceita INTEGER,
  usuario_id INTEGER REFERENCES usuarios(id),
  criada_em TEXT NOT NULL,
  respondida_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_ouvidoria_ofertas ON ouvidoria_ofertas(ouvidoria_id);

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

-- O que a ZOE fez no IXC: auditoria para o provedor e base do limite de desbloqueios.
CREATE TABLE IF NOT EXISTS ixc_acoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  conversa_id INTEGER REFERENCES conversas(id) ON DELETE SET NULL,
  contato_id INTEGER REFERENCES contatos(id),
  ixc_cliente_id TEXT,
  tipo TEXT NOT NULL CHECK (tipo IN ('identificacao','confirmacao','contrato','faturas','boleto','desbloqueio','conexao','chamado','alerta','erro')),
  sucesso INTEGER NOT NULL DEFAULT 1,
  detalhe TEXT,
  ms INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ixc_acoes_empresa ON ixc_acoes(empresa_id, criado_em);
CREATE INDEX IF NOT EXISTS idx_ixc_acoes_cliente ON ixc_acoes(empresa_id, ixc_cliente_id, tipo, criado_em);

-- Base de conhecimento: o que a ZOE usa para responder sozinha.
-- O que a ZOE não conseguiu resolver sozinha: cada transferência feita por ela vira uma lacuna,
-- com o tema, o motivo e o que faltou. Quem atendeu conta como resolveu, e as lacunas do mesmo
-- tema viram um artigo na base de conhecimento — é assim que ela aprende para os próximos casos.
CREATE TABLE IF NOT EXISTS lacunas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  conversa_id INTEGER REFERENCES conversas(id) ON DELETE SET NULL,
  canal TEXT NOT NULL DEFAULT 'whatsapp',
  tema TEXT NOT NULL,
  -- O tema normalizado, para juntar "Mudança de endereço" e "mudanca de endereco".
  tema_chave TEXT NOT NULL,
  categoria TEXT NOT NULL CHECK (categoria IN ('nao_sabia','precisa_de_pessoa','regra_da_empresa','sistema_falhou',
    'cliente_pediu','nao_entendeu','limite','outro')),
  pergunta TEXT,
  motivo TEXT,
  o_que_faltou TEXT,
  solucao TEXT,
  solucao_por INTEGER REFERENCES usuarios(id),
  solucao_em TEXT,
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','ensinada','ignorada')),
  conhecimento_id INTEGER REFERENCES conhecimento(id) ON DELETE SET NULL,
  criada_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lacunas_empresa ON lacunas(empresa_id, status, tema_chave);
CREATE INDEX IF NOT EXISTS idx_lacunas_conversa ON lacunas(conversa_id);

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

-- Chamados abertos pela ZOE quando não há solução imediata.
CREATE TABLE IF NOT EXISTS chamados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  conversa_id INTEGER REFERENCES conversas(id) ON DELETE SET NULL,
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

-- O que a ZOE fez em cada passo: dá para auditar e medir custo.
CREATE TABLE IF NOT EXISTS ia_eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  conversa_id INTEGER REFERENCES conversas(id) ON DELETE SET NULL,
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

-- O dólar do dia: PTAX do Banco Central, um boletim por dia útil. Guardar o histórico permite
-- fechar o mês pela média do mês, e não pelo dólar do dia em que alguém clicou em "fechar".
CREATE TABLE IF NOT EXISTS cotacoes (
  data TEXT PRIMARY KEY,
  venda_x10000 INTEGER NOT NULL CHECK (venda_x10000 > 0),
  compra_x10000 INTEGER NOT NULL CHECK (compra_x10000 > 0),
  boletim_em TEXT NOT NULL,
  obtida_em TEXT NOT NULL
);

-- Ajustes de permissão por pessoa.
--
-- Guarda só a DIFERENÇA contra o padrão do perfil: 1 concede algo que o perfil não dá,
-- 0 tira algo que o perfil dava. Guardando a diferença, mudar o padrão de um perfil alcança
-- todo mundo que nunca foi ajustado à mão — se guardássemos a lista inteira, cada pessoa
-- ficaria congelada no dia em que foi cadastrada.
CREATE TABLE IF NOT EXISTS usuario_permissoes (
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  permissao TEXT NOT NULL,
  concedida INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (usuario_id, permissao)
);

-- Alertas de rede cadastrados à mão pela equipe.
--
-- O IXC nem sempre está atualizado, e a ZOE não pode afirmar o que o cadastro diz errado.
-- Aqui a equipe escreve o que está acontecendo de verdade, com período e abrangência, e a ZOE
-- só conta para quem está dentro do alerta. É a ponte até a correlação automática de massiva:
-- enquanto o cadastro não estiver confiável, quem sabe da falha é a equipe, não o sistema.
CREATE TABLE IF NOT EXISTS alertas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  -- Título é interno (a equipe vê); mensagem é o que a ZOE fala com o cliente.
  titulo TEXT NOT NULL,
  mensagem TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'massiva' CHECK (tipo IN ('massiva','manutencao','aviso')),
  -- 'todos': a base inteira. 'chave': só quem bate com uma das chaves (bairro, OLT, CTO...).
  -- 'clientes': só os códigos listados.
  abrangencia TEXT NOT NULL DEFAULT 'chave' CHECK (abrangencia IN ('todos','chave','clientes')),
  -- Campos do cadastro do IXC a comparar, um por linha. Vazio = a lista padrão.
  campos TEXT,
  -- Valores que definem a área afetada, um por linha.
  chaves TEXT,
  -- Códigos de cliente ou de contrato, um por linha.
  clientes TEXT,
  -- Previsão de normalização, em texto curto ("até as 18h de hoje").
  previsao TEXT,
  -- Mesmo com alerta, ainda abre chamado? Em massiva confirmada normalmente não: são 40 chamados
  -- do mesmo problema. Em manutenção programada também não.
  abre_chamado INTEGER NOT NULL DEFAULT 0,
  inicio TEXT NOT NULL,
  fim TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1,
  -- Quantas vezes a ZOE já usou este alerta: mostra se ele está pegando gente de verdade.
  avisados INTEGER NOT NULL DEFAULT 0,
  criado_por TEXT,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_alertas_vigencia ON alertas (empresa_id, ativo, inicio, fim);

-- A sala de espera da janela: avisos que têm folga ficam aqui em vez de virar template pago.
-- Quando o cliente escreve qualquer coisa, a janela abre e o aviso sai de graça, de carona.
-- Chegando o prazo sem o cliente escrever, aí sim paga o template.
CREATE TABLE IF NOT EXISTS pendencias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  regua_id INTEGER NOT NULL REFERENCES reguas(id),
  contato_id INTEGER NOT NULL REFERENCES contatos(id),
  -- Id da fatura (ou a data alvo): evita duas pendências para a mesma coisa.
  referencia TEXT NOT NULL,
  dados TEXT NOT NULL,
  texto TEXT NOT NULL,
  prazo TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'esperando' CHECK (status IN ('esperando','entregue','vencida','cancelada')),
  resolucao TEXT,
  resolvida_em TEXT,
  disparo_id INTEGER REFERENCES disparos(id),
  criada_em TEXT NOT NULL,
  UNIQUE (regua_id, contato_id, referencia)
);
CREATE INDEX IF NOT EXISTS idx_pendencias_espera ON pendencias (status, prazo);
CREATE INDEX IF NOT EXISTS idx_pendencias_contato ON pendencias (contato_id, status);

-- Fechamento do mês: foto do que foi gasto, imutável depois de fechada, e o espaço para
-- lançar o valor que a Meta cobrou de verdade. Sem essa conferência o número é só nosso.
CREATE TABLE IF NOT EXISTS custos_mensais (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  mes TEXT NOT NULL,
  mensagens INTEGER NOT NULL DEFAULT 0,
  por_categoria TEXT NOT NULL,
  gasto_milesimos INTEGER NOT NULL DEFAULT 0,
  economia_milesimos INTEGER NOT NULL DEFAULT 0,
  sem_otimizacao_milesimos INTEGER NOT NULL DEFAULT 0,
  orcamento_milesimos INTEGER NOT NULL DEFAULT 0,
  moeda TEXT NOT NULL DEFAULT 'BRL' CHECK (moeda IN ('BRL','USD')),
  gasto_usd_micro INTEGER,
  -- A cotação que valia quando o mês fechou: o número em reais não muda depois com o câmbio.
  cotacao_x10000 INTEGER,
  -- O que a Meta cobrou, na moeda da fatura. Em dólar: fatura_meta_usd_centavos; e o que saiu de
  -- fato da conta, em reais (com IOF e spread), em fatura_meta_centavos.
  fatura_meta_usd_centavos INTEGER,
  fatura_meta_centavos INTEGER,
  conferido_em TEXT,
  conferido_por TEXT,
  observacao TEXT,
  fechado_em TEXT NOT NULL,
  UNIQUE (empresa_id, mes)
);

-- Cada marco do orçamento é avisado uma vez só (50%, 80%, 100%).
CREATE TABLE IF NOT EXISTS orcamento_avisos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  mes TEXT NOT NULL,
  marco INTEGER NOT NULL CHECK (marco IN (50,80,100)),
  gasto_milesimos INTEGER NOT NULL,
  orcamento_milesimos INTEGER NOT NULL,
  criado_em TEXT NOT NULL,
  UNIQUE (empresa_id, mes, marco)
);

CREATE TABLE IF NOT EXISTS configuracoes (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
`;

const CONFIG_PADRAO = {
  nome_plataforma: 'ZOE Atende',
  // Quantas mensagens PAGAS um mesmo contato pode receber por dia, somando todas as réguas.
  // Duas réguas que caem no mesmo cliente no mesmo dia pagam duas vezes pelo mesmo recado.
  wa_max_pagas_contato_dia: 1,
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
  // Padrão do modelo de IA em uso (US$ 4,00 / US$ 20,00 / US$ 0,20 por milhão) a ~R$ 5,40 o dólar.
  // O master ajusta no painel quando a tabela da Anthropic ou o câmbio mudarem.
  ia_preco_entrada_milhao: '2160',
  ia_preco_saida_milhao: '10800',
  ia_preco_cache_milhao: '108',
  // Preço da Meta por mensagem ENTREGUE, em milésimos de real (R$ 0,035 = 35).
  // Serviço (o cliente falou primeiro, resposta em até 24 h) não entra: é de graça.
  // Confira a tabela do Brasil no painel da Meta — ela muda.
  wa_preco_utilidade: '35',
  wa_preco_autenticacao: '30',
  wa_preco_marketing: '320',
  // A mesma tabela em dólar, como a Meta publica, em MILIONÉSIMOS de dólar (US$ 0,0068 = 6800):
  // vale para as empresas cuja conta na Meta é cobrada em dólar. Confira a tabela do Brasil no
  // painel da Meta — ela muda.
  wa_preco_utilidade_usd: '6800',
  wa_preco_autenticacao_usd: '6800',
  wa_preco_marketing_usd: '62500',
  // Cotação usada quando a empresa não informou a dela: reais por dólar, ×10000 (5,4000 = 54000).
  wa_cotacao_padrao: '54000',
};

const agora = () => new Date().toISOString();

/**
 * Atualização do banco numa instalação que já existe. O esquema é um só (SCHEMA, com CREATE ... IF
 * NOT EXISTS): tabela nova nasce sozinha, mas coluna nova numa tabela que já existe, não. Aqui o
 * esquema atual é montado num banco em memória e comparado tabela a tabela com o de verdade; cada
 * coluna que falta é criada com a mesma definição (tipo, padrão, CHECK, REFERENCES). Roda antes do
 * SCHEMA porque os índices novos podem usar as colunas novas. Devolve o que foi criado.
 */
function atualizarEsquema(db) {
  const existentes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((t) => t.name);
  if (!existentes.length) return [];
  const modelo = new DatabaseSync(':memory:');
  modelo.exec(SCHEMA);
  const criadas = [];
  for (const { name: tabela, sql } of modelo.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
    if (!existentes.includes(tabela)) continue;
    const tem = new Set(db.prepare(`PRAGMA table_info("${tabela}")`).all().map((c) => c.name));
    for (const definicao of colunasDoCreate(sql)) {
      const nome = definicao.match(/^"?(\w+)"?/)[1];
      if (tem.has(nome)) continue;
      db.exec(`ALTER TABLE "${tabela}" ADD COLUMN ${definicao}`);
      criadas.push(`${tabela}.${nome}`);
    }
  }
  // Índice que mudou de definição (ex.: "uma conversa aberta por contato" virou "por contato e
  // canal", quando chegou o telefone): o antigo sai e o SCHEMA cria o novo logo em seguida.
  const normal = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
  for (const { name, sql } of modelo.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all()) {
    const real = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
    if (real && normal(real.sql) !== normal(sql)) {
      db.exec(`DROP INDEX "${name}"`);
      criadas.push(`índice ${name}`);
    }
  }
  modelo.close();
  return criadas;
}

/** As definições de coluna de um CREATE TABLE (sem comentários, sem as restrições da tabela). */
function colunasDoCreate(sql) {
  const corpo = sql.replace(/--[^\n]*/g, '').slice(sql.replace(/--[^\n]*/g, '').indexOf('(') + 1);
  const itens = [];
  let nivel = 0;
  let atual = '';
  let aspas = null;
  for (const ch of corpo) {
    if (aspas) { atual += ch; if (ch === aspas) aspas = null; continue; }
    if (ch === "'" || ch === '"') { aspas = ch; atual += ch; continue; }
    if (ch === '(') nivel++;
    if (ch === ')') { if (nivel === 0) break; nivel--; }
    if (ch === ',' && nivel === 0) { itens.push(atual); atual = ''; continue; }
    atual += ch;
  }
  itens.push(atual);
  return itens.map((i) => i.replace(/\s+/g, ' ').trim()).filter(Boolean)
    .filter((i) => !/^(CONSTRAINT|CHECK|PRIMARY|UNIQUE|FOREIGN)\b/i.test(i));
}

function abrir(arquivo = config.dbFile) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const novas = atualizarEsquema(db);
  if (novas.length) console.log(`[ZOE Atende] Banco atualizado: ${novas.length} mudança(s) (${novas.join(', ')}).`);
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

module.exports = { abrir, atualizarEsquema, colunasDoCreate, transacao, lerConfig, auditar, agora, CONFIG_PADRAO, SCHEMA };
