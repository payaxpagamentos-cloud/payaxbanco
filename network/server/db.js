'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { hashSenha } = require('./lib/senha');

/*
 * Convenções do banco:
 * - Toda entidade de negócio carrega organizacao_id; a unicidade de códigos, placas e números vale dentro da organização.
 * - Carimbos de tempo em ISO 8601 UTC; datas de calendário em 'AAAA-MM-DD' (no fuso da operação).
 * - Dinheiro em centavos (inteiros). Volume em mililitros. Preço por litro em milésimos de real (R$ 5,899 = 5899).
 * - Quilometragem em km inteiros. Potência óptica em dBm (REAL), sempre com equipamento, ponto e instante.
 * - Nada que tenha histórico é apagado: vínculos ganham data de fim; correções guardam o valor original.
 */
const MIGRACOES = [
  {
    versao: 1,
    nome: 'fundacao',
    sql: `
CREATE TABLE organizacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  fuso TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  -- Organização de demonstração: os dados são fictícios e a interface mostra o selo "Ambiente demonstrativo".
  demonstracao INTEGER NOT NULL DEFAULT 0,
  -- Ordens de manutenção com orçamento acima deste valor só o administrador aprova (0 = qualquer valor exige o administrador).
  aprovacao_manutencao_centavos INTEGER NOT NULL DEFAULT 100000 CHECK (aprovacao_manutencao_centavos >= 0),
  -- Incidente que volta a falhar dentro desta janela após a recuperação é reaberto (recorrência) em vez de duplicado.
  janela_recorrencia_min INTEGER NOT NULL DEFAULT 30 CHECK (janela_recorrencia_min >= 0),
  -- Leitura mais antiga que isso aparece como desatualizada.
  desatualizado_min INTEGER NOT NULL DEFAULT 15 CHECK (desatualizado_min > 0),
  -- Reserva de porta expira depois deste prazo (horas).
  reserva_porta_horas INTEGER NOT NULL DEFAULT 72 CHECK (reserva_porta_horas > 0),
  criada_em TEXT NOT NULL
);

CREATE TABLE usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL CHECK (perfil IN ('admin','gestor','noc','frota','tecnico','comissoes','consulta')),
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_acesso TEXT,
  criado_em TEXT NOT NULL
);

CREATE TABLE auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER REFERENCES organizacoes(id),
  usuario_id INTEGER REFERENCES usuarios(id),
  acao TEXT NOT NULL,
  recurso TEXT,
  recurso_id INTEGER,
  antes TEXT,
  depois TEXT,
  request_id TEXT,
  ip TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX idx_auditoria_org ON auditoria(organizacao_id, id DESC);
CREATE INDEX idx_auditoria_recurso ON auditoria(organizacao_id, recurso, recurso_id);

-- Respostas guardadas por chave de idempotência (cabeçalho Idempotency-Key): repetir o comando devolve a mesma resposta.
CREATE TABLE idempotencia (
  organizacao_id INTEGER NOT NULL,
  usuario_id INTEGER NOT NULL,
  chave TEXT NOT NULL,
  rota TEXT NOT NULL,
  status INTEGER,
  corpo TEXT,
  criado_em TEXT NOT NULL,
  PRIMARY KEY (organizacao_id, usuario_id, chave)
);

CREATE TABLE contadores (
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  nome TEXT NOT NULL,
  valor INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (organizacao_id, nome)
);

-- Arquivos privados (fora da pasta pública, nome aleatório, SHA-256 conferido). recurso: a que o arquivo pertence.
CREATE TABLE anexos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  recurso TEXT NOT NULL CHECK (recurso IN ('chamado','abastecimento','veiculo_documento','manutencao','comissao_pagamento','ativo')),
  recurso_id INTEGER,
  nome TEXT NOT NULL,
  mime TEXT NOT NULL,
  tamanho INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  arquivo TEXT NOT NULL UNIQUE,
  enviado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL
);
CREATE INDEX idx_anexos_recurso ON anexos(organizacao_id, recurso, recurso_id);

-- ===================== Equipe =====================
CREATE TABLE tecnicos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  usuario_id INTEGER UNIQUE REFERENCES usuarios(id),
  nome TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','afastado','inativo')),
  especialidades TEXT,
  regioes TEXT,
  equipe TEXT,
  telefone TEXT,
  criado_em TEXT NOT NULL
);

-- ===================== Frota =====================
CREATE TABLE fornecedores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('oficina','posto','lavagem','pecas','outro')),
  documento TEXT,
  contato TEXT,
  telefone TEXT,
  email TEXT,
  endereco TEXT,
  especialidades TEXT,
  observacoes TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL
);

-- status_base: estado escolhido pelo gestor. O estado exibido considera as restrições ativas (oficina, documento...).
CREATE TABLE veiculos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  placa TEXT NOT NULL,
  identificacao TEXT,
  marca TEXT,
  modelo TEXT NOT NULL,
  ano INTEGER,
  categoria TEXT NOT NULL DEFAULT 'utilitario' CHECK (categoria IN ('passeio','utilitario','picape','van','caminhao','moto','outro')),
  combustivel TEXT NOT NULL DEFAULT 'flex' CHECK (combustivel IN ('flex','gasolina','etanol','diesel','gnv','eletrico')),
  tanque_litros INTEGER CHECK (tanque_litros IS NULL OR tanque_litros > 0),
  odometro_km INTEGER CHECK (odometro_km IS NULL OR odometro_km >= 0),
  odometro_fonte TEXT CHECK (odometro_fonte IN ('manual','abastecimento','manutencao','rastreador')),
  odometro_em TEXT,
  status_base TEXT NOT NULL DEFAULT 'disponivel' CHECK (status_base IN ('disponivel','em_operacao','reservado','inativo')),
  observacoes TEXT,
  criado_em TEXT NOT NULL,
  versao INTEGER NOT NULL DEFAULT 1,
  UNIQUE (organizacao_id, placa)
);

CREATE TABLE veiculo_responsaveis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id),
  tecnico_id INTEGER NOT NULL REFERENCES tecnicos(id),
  inicio TEXT NOT NULL,
  fim TEXT,
  motivo TEXT,
  criado_por INTEGER REFERENCES usuarios(id)
);
CREATE UNIQUE INDEX uq_responsavel_ativo ON veiculo_responsaveis(veiculo_id) WHERE fim IS NULL;

-- Restrições que impedem a escala do veículo. Ficam ativas até a liberação (fim), com quem liberou e por quê.
CREATE TABLE veiculo_restricoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('oficina','manutencao','documento','sinistro','administrativa')),
  motivo TEXT NOT NULL,
  ordem_id INTEGER,
  inicio TEXT NOT NULL,
  fim TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  liberado_por INTEGER REFERENCES usuarios(id),
  motivo_liberacao TEXT
);
CREATE INDEX idx_restricoes_ativas ON veiculo_restricoes(veiculo_id) WHERE fim IS NULL;

CREATE TABLE veiculo_documentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('crlv','seguro','licenciamento','ipva','vistoria','outro')),
  numero TEXT,
  vencimento TEXT,
  observacoes TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL
);

-- Plano preventivo por item: periodicidade em dias e/ou km. Alerta pelo primeiro limite atingido.
CREATE TABLE planos_preventivos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id),
  item TEXT NOT NULL CHECK (item IN ('oleo','filtros','pneus','freios','revisao','correia','bateria','outro')),
  descricao TEXT,
  intervalo_dias INTEGER CHECK (intervalo_dias IS NULL OR intervalo_dias > 0),
  intervalo_km INTEGER CHECK (intervalo_km IS NULL OR intervalo_km > 0),
  antecedencia_dias INTEGER NOT NULL DEFAULT 15 CHECK (antecedencia_dias >= 0),
  antecedencia_km INTEGER NOT NULL DEFAULT 500 CHECK (antecedencia_km >= 0),
  tolerancia_dias INTEGER NOT NULL DEFAULT 0 CHECK (tolerancia_dias >= 0),
  tolerancia_km INTEGER NOT NULL DEFAULT 0 CHECK (tolerancia_km >= 0),
  ultima_data TEXT NOT NULL,
  ultimo_km INTEGER CHECK (ultimo_km IS NULL OR ultimo_km >= 0),
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL,
  CHECK (intervalo_dias IS NOT NULL OR intervalo_km IS NOT NULL)
);

-- Ordens de manutenção, mecânico e lavagem. Custo previsto (orçamento) e realizado ficam separados.
CREATE TABLE manutencoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('preventiva','corretiva','lavagem')),
  plano_id INTEGER REFERENCES planos_preventivos(id),
  lavagem_tipo TEXT,
  fornecedor_id INTEGER REFERENCES fornecedores(id),
  descricao TEXT NOT NULL,
  data_planejada TEXT,
  km_planejado INTEGER,
  indisponivel_inicio TEXT,
  indisponivel_fim TEXT,
  custo_previsto_centavos INTEGER CHECK (custo_previsto_centavos IS NULL OR custo_previsto_centavos >= 0),
  custo_realizado_centavos INTEGER CHECK (custo_realizado_centavos IS NULL OR custo_realizado_centavos >= 0),
  status TEXT NOT NULL DEFAULT 'solicitado' CHECK (status IN ('solicitado','orcado','aprovado','agendado','em_execucao','concluido','cancelado')),
  aprovado_por INTEGER REFERENCES usuarios(id),
  aprovado_em TEXT,
  concluido_em TEXT,
  km_execucao INTEGER,
  observacoes TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  versao INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_manutencoes_veiculo ON manutencoes(organizacao_id, veiculo_id, status);

CREATE TABLE manutencao_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manutencao_id INTEGER NOT NULL REFERENCES manutencoes(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('peca','servico')),
  descricao TEXT NOT NULL,
  previsto_centavos INTEGER CHECK (previsto_centavos IS NULL OR previsto_centavos >= 0),
  realizado_centavos INTEGER CHECK (realizado_centavos IS NULL OR realizado_centavos >= 0)
);

CREATE TABLE manutencao_eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manutencao_id INTEGER NOT NULL REFERENCES manutencoes(id),
  de TEXT,
  para TEXT NOT NULL,
  observacao TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  em TEXT NOT NULL
);

CREATE TABLE abastecimentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id),
  tecnico_id INTEGER REFERENCES tecnicos(id),
  data_hora TEXT NOT NULL,
  combustivel TEXT NOT NULL CHECK (combustivel IN ('gasolina','etanol','diesel','gnv','eletrico')),
  fornecedor_id INTEGER REFERENCES fornecedores(id),
  posto TEXT,
  odometro_km INTEGER NOT NULL CHECK (odometro_km >= 0),
  litros_ml INTEGER NOT NULL CHECK (litros_ml > 0),
  preco_milesimos INTEGER NOT NULL CHECK (preco_milesimos > 0),
  total_centavos INTEGER NOT NULL CHECK (total_centavos > 0),
  tanque_cheio INTEGER NOT NULL DEFAULT 0,
  alerta_volume INTEGER NOT NULL DEFAULT 0,
  observacoes TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL
);
CREATE INDEX idx_abastecimentos_veiculo ON abastecimentos(organizacao_id, veiculo_id, data_hora);

-- Correções autorizadas: o valor original continua guardado aqui.
CREATE TABLE abastecimento_correcoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  abastecimento_id INTEGER NOT NULL REFERENCES abastecimentos(id),
  campo TEXT NOT NULL,
  valor_anterior TEXT,
  valor_novo TEXT,
  motivo TEXT NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id),
  em TEXT NOT NULL
);

-- ===================== Rede óptica =====================
-- Equipamentos ativos (OLT, switch, roteador) de um POP. monitoramento_id: o identificador usado pela plataforma de monitoramento.
CREATE TABLE equipamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  ativo_id INTEGER,
  tipo TEXT NOT NULL CHECK (tipo IN ('olt','switch','roteador','servidor','outro')),
  nome TEXT NOT NULL,
  fabricante TEXT,
  modelo TEXT,
  monitoramento_id TEXT,
  ip_gerencia TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL,
  UNIQUE (organizacao_id, monitoramento_id)
);

-- CTOs, caixas de emenda (CEO) e POPs. CTO e CEO são passivas: o status guarda a origem (inspeção manual ou inferência) e a evidência.
CREATE TABLE ativos_rede (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  codigo TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('pop','ceo','cto')),
  nome TEXT,
  endereco TEXT,
  bairro TEXT,
  lat REAL,
  lng REAL,
  referencia_acesso TEXT,
  capacidade INTEGER CHECK (capacidade IS NULL OR capacidade > 0),
  splitter TEXT,
  equipamento_id INTEGER REFERENCES equipamentos(id),
  pon TEXT,
  observacoes TEXT,
  status_operacional TEXT NOT NULL DEFAULT 'nao_avaliado' CHECK (status_operacional IN ('operacional','atencao','indisponivel','nao_avaliado')),
  status_origem TEXT NOT NULL DEFAULT 'sem_avaliacao' CHECK (status_origem IN ('sem_avaliacao','inspecao_manual','inferencia','monitoramento')),
  status_evidencia TEXT,
  status_em TEXT,
  status_por INTEGER REFERENCES usuarios(id),
  ativo INTEGER NOT NULL DEFAULT 1,
  versao INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL,
  UNIQUE (organizacao_id, codigo)
);
CREATE INDEX idx_ativos_org ON ativos_rede(organizacao_id, tipo, ativo);

CREATE TABLE portas_rede (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ativo_id INTEGER NOT NULL REFERENCES ativos_rede(id),
  numero INTEGER NOT NULL CHECK (numero > 0),
  situacao TEXT NOT NULL DEFAULT 'livre' CHECK (situacao IN ('livre','reservada','ocupada','defeito')),
  cliente_ref TEXT,
  onu_ref TEXT,
  reservado_por INTEGER REFERENCES usuarios(id),
  reserva_expira_em TEXT,
  desde TEXT,
  observacao TEXT,
  -- Porta acima da capacidade atual (após redução): fora de uso, com o histórico preservado.
  em_uso INTEGER NOT NULL DEFAULT 1,
  versao INTEGER NOT NULL DEFAULT 1,
  UNIQUE (ativo_id, numero)
);

CREATE TABLE porta_historico (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  porta_id INTEGER NOT NULL REFERENCES portas_rede(id),
  situacao_anterior TEXT,
  situacao TEXT NOT NULL,
  cliente_ref TEXT,
  onu_ref TEXT,
  motivo TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  em TEXT NOT NULL
);

CREATE TABLE cabos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  codigo TEXT NOT NULL,
  fibras INTEGER NOT NULL CHECK (fibras > 0),
  tipo TEXT,
  comprimento_m INTEGER,
  observacoes TEXT,
  criado_em TEXT NOT NULL,
  UNIQUE (organizacao_id, codigo)
);

-- Ligação de um ativo (origem, mais perto do cliente) ao ativo que o alimenta (destino, mais perto do POP).
-- Um ativo tem no máximo uma ligação ativa para cima; encerrar uma ligação guarda o fim e o motivo.
CREATE TABLE enlaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  origem_id INTEGER NOT NULL REFERENCES ativos_rede(id),
  destino_id INTEGER NOT NULL REFERENCES ativos_rede(id),
  cabo_id INTEGER REFERENCES cabos(id),
  fibras TEXT,
  inicio TEXT NOT NULL,
  fim TEXT,
  motivo_fim TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  encerrado_por INTEGER REFERENCES usuarios(id),
  CHECK (origem_id <> destino_id)
);
CREATE UNIQUE INDEX uq_enlace_ativo ON enlaces(origem_id) WHERE fim IS NULL;
CREATE INDEX idx_enlaces_destino ON enlaces(destino_id) WHERE fim IS NULL;

CREATE TABLE bandejas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ceo_id INTEGER NOT NULL REFERENCES ativos_rede(id),
  numero INTEGER NOT NULL CHECK (numero > 0),
  capacidade INTEGER NOT NULL DEFAULT 12 CHECK (capacidade > 0),
  UNIQUE (ceo_id, numero)
);

-- Fusões de uma caixa de emenda: extremidade A e B (cabo, tubo, fibra, cor). Uma extremidade só pode estar numa fusão ativa.
CREATE TABLE fusoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  ceo_id INTEGER NOT NULL REFERENCES ativos_rede(id),
  bandeja_id INTEGER NOT NULL REFERENCES bandejas(id),
  a_cabo_id INTEGER NOT NULL REFERENCES cabos(id),
  a_tubo INTEGER NOT NULL,
  a_fibra INTEGER NOT NULL,
  a_cor TEXT,
  b_cabo_id INTEGER NOT NULL REFERENCES cabos(id),
  b_tubo INTEGER NOT NULL,
  b_fibra INTEGER NOT NULL,
  b_cor TEXT,
  ativa INTEGER NOT NULL DEFAULT 1,
  observacao TEXT,
  inicio TEXT NOT NULL,
  fim TEXT,
  motivo_fim TEXT,
  criado_por INTEGER REFERENCES usuarios(id)
);
CREATE TABLE fusao_extremidades (
  fusao_id INTEGER NOT NULL REFERENCES fusoes(id),
  ceo_id INTEGER NOT NULL,
  cabo_id INTEGER NOT NULL,
  tubo INTEGER NOT NULL,
  fibra INTEGER NOT NULL,
  ativa INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX uq_extremidade_ativa ON fusao_extremidades(ceo_id, cabo_id, tubo, fibra) WHERE ativa = 1;

-- ===================== Chamados =====================
-- Checklist versionado por tipo de serviço. itens: [{ chave, rotulo, tipo: confirmacao|numero|texto|foto, obrigatorio, unidade? }].
CREATE TABLE checklist_modelos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  tipo_servico TEXT NOT NULL,
  versao INTEGER NOT NULL,
  itens TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  UNIQUE (organizacao_id, tipo_servico, versao)
);

CREATE TABLE chamados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  numero INTEGER NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('instalacao','reparo','fusao','manutencao_rede','vistoria','retirada','outro')),
  titulo TEXT NOT NULL,
  descricao TEXT,
  prioridade TEXT NOT NULL DEFAULT 'media' CHECK (prioridade IN ('baixa','media','alta','critica')),
  bairro TEXT,
  cliente_ref TEXT,
  endereco TEXT,
  lat REAL,
  lng REAL,
  ativo_id INTEGER REFERENCES ativos_rede(id),
  incidente_id INTEGER,
  tecnico_id INTEGER REFERENCES tecnicos(id),
  veiculo_id INTEGER REFERENCES veiculos(id),
  agendado_para TEXT,
  prazo TEXT,
  status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','atribuido','em_rota','em_execucao','em_validacao','aprovado','retornado','cancelado')),
  checklist_id INTEGER REFERENCES checklist_modelos(id),
  iniciado_em TEXT,
  concluido_em TEXT,
  aprovado_em TEXT,
  aprovado_por INTEGER REFERENCES usuarios(id),
  retrabalho INTEGER NOT NULL DEFAULT 0,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  versao INTEGER NOT NULL DEFAULT 1,
  UNIQUE (organizacao_id, numero)
);
CREATE INDEX idx_chamados_org ON chamados(organizacao_id, status);
CREATE INDEX idx_chamados_tecnico ON chamados(organizacao_id, tecnico_id, agendado_para);

-- Rateio da comissão entre os técnicos da equipe (percentuais somando 100). Vazio: 100% para o técnico principal.
CREATE TABLE chamado_equipe (
  chamado_id INTEGER NOT NULL REFERENCES chamados(id),
  tecnico_id INTEGER NOT NULL REFERENCES tecnicos(id),
  percentual INTEGER NOT NULL CHECK (percentual > 0 AND percentual <= 100),
  PRIMARY KEY (chamado_id, tecnico_id)
);

CREATE TABLE chamado_eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chamado_id INTEGER NOT NULL REFERENCES chamados(id),
  acao TEXT NOT NULL,
  de TEXT,
  para TEXT,
  observacao TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  em TEXT NOT NULL
);

CREATE TABLE chamado_respostas (
  chamado_id INTEGER NOT NULL REFERENCES chamados(id),
  chave TEXT NOT NULL,
  valor TEXT,
  anexo_id INTEGER REFERENCES anexos(id),
  usuario_id INTEGER REFERENCES usuarios(id),
  em TEXT NOT NULL,
  PRIMARY KEY (chamado_id, chave)
);

-- ===================== Comissões =====================
CREATE TABLE comissao_regras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  tipo_servico TEXT NOT NULL,
  nome TEXT NOT NULL,
  ativa INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL,
  UNIQUE (organizacao_id, tipo_servico)
);
-- Cada alteração cria uma versão nova; vale para os chamados aprovados depois dela. modo fixo: valor por serviço;
-- por_unidade: valor × quantidade lida do item numérico do checklist (campo_unidade), ex.: fibras fundidas.
CREATE TABLE comissao_versoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  regra_id INTEGER NOT NULL REFERENCES comissao_regras(id),
  versao INTEGER NOT NULL,
  modo TEXT NOT NULL CHECK (modo IN ('fixo','por_unidade')),
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos >= 0),
  campo_unidade TEXT,
  vigente_desde TEXT NOT NULL,
  criado_por INTEGER REFERENCES usuarios(id),
  UNIQUE (regra_id, versao)
);

CREATE TABLE comissoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  chamado_id INTEGER NOT NULL REFERENCES chamados(id),
  tecnico_id INTEGER NOT NULL REFERENCES tecnicos(id),
  regra_id INTEGER NOT NULL REFERENCES comissao_regras(id),
  versao_id INTEGER NOT NULL REFERENCES comissao_versoes(id),
  base TEXT NOT NULL,
  quantidade INTEGER NOT NULL DEFAULT 1,
  percentual_rateio INTEGER NOT NULL DEFAULT 100,
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos >= 0),
  moeda TEXT NOT NULL DEFAULT 'BRL',
  status TEXT NOT NULL DEFAULT 'aguardando_aprovacao' CHECK (status IN ('aguardando_aprovacao','aprovada','rejeitada','suspensa','paga')),
  aprovado_por INTEGER REFERENCES usuarios(id),
  aprovado_em TEXT,
  motivo TEXT,
  criado_em TEXT NOT NULL,
  UNIQUE (chamado_id, tecnico_id, regra_id)
);
CREATE INDEX idx_comissoes_org ON comissoes(organizacao_id, status);

CREATE TABLE comissao_ajustes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comissao_id INTEGER NOT NULL REFERENCES comissoes(id),
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos <> 0),
  motivo TEXT NOT NULL,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL
);

CREATE TABLE comissao_eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comissao_id INTEGER NOT NULL REFERENCES comissoes(id),
  de TEXT,
  para TEXT NOT NULL,
  motivo TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  em TEXT NOT NULL
);

-- Registro administrativo de pagamento (comprovante, data, referência). Não executa transferência bancária.
CREATE TABLE comissao_pagamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  data_pagamento TEXT NOT NULL,
  referencia TEXT NOT NULL,
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  observacoes TEXT,
  registrado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL
);
CREATE TABLE comissao_pagamento_itens (
  pagamento_id INTEGER NOT NULL REFERENCES comissao_pagamentos(id),
  comissao_id INTEGER NOT NULL UNIQUE REFERENCES comissoes(id),
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  PRIMARY KEY (pagamento_id, comissao_id)
);

-- ===================== Rastreamento =====================
-- Vínculo do dispositivo externo (IMEI no rastreador) ao veículo, com vigência. A placa só ajuda a conciliar.
CREATE TABLE dispositivos_vinculos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  fonte TEXT NOT NULL DEFAULT 'rastreador',
  dispositivo_id TEXT NOT NULL,
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id),
  inicio TEXT NOT NULL,
  fim TEXT,
  criado_por INTEGER REFERENCES usuarios(id)
);
CREATE UNIQUE INDEX uq_dispositivo_ativo ON dispositivos_vinculos(organizacao_id, fonte, dispositivo_id) WHERE fim IS NULL;
CREATE UNIQUE INDEX uq_veiculo_dispositivo_ativo ON dispositivos_vinculos(veiculo_id) WHERE fim IS NULL;

-- Dispositivos vistos na fonte (para vincular), com a placa informada por ela.
CREATE TABLE dispositivos_externos (
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  fonte TEXT NOT NULL,
  dispositivo_id TEXT NOT NULL,
  placa TEXT,
  descricao TEXT,
  ultimo_visto TEXT NOT NULL,
  PRIMARY KEY (organizacao_id, fonte, dispositivo_id)
);

-- Posições: horário da medição (origem) e do recebimento. Campos não informados pela origem ficam nulos (nunca 0 ou "desligado").
CREATE TABLE posicoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id),
  fonte TEXT NOT NULL,
  dispositivo_id TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  velocidade_kmh REAL,
  ignicao INTEGER,
  precisao_m REAL,
  odometro_km REAL,
  observado_em TEXT NOT NULL,
  recebido_em TEXT NOT NULL,
  UNIQUE (organizacao_id, fonte, dispositivo_id, observado_em)
);
CREATE INDEX idx_posicoes_veiculo ON posicoes(veiculo_id, observado_em);

CREATE TABLE posicao_atual (
  veiculo_id INTEGER PRIMARY KEY REFERENCES veiculos(id),
  organizacao_id INTEGER NOT NULL,
  posicao_id INTEGER NOT NULL REFERENCES posicoes(id),
  observado_em TEXT NOT NULL,
  recebido_em TEXT NOT NULL
);

-- ===================== Monitoramento e NOC =====================
-- Tokens dos coletores (agente na rede do provedor ou a plataforma de monitoramento). Só o hash fica guardado.
CREATE TABLE coletores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  nome TEXT NOT NULL,
  prefixo TEXT NOT NULL UNIQUE,
  hash TEXT NOT NULL,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  ultimo_uso TEXT,
  revogado_em TEXT
);

-- Regra que transforma amostras em incidente: limiar, limiar de recuperação (histerese) e número de amostras para confirmar.
CREATE TABLE regras_monitoramento (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  nome TEXT NOT NULL,
  metrica TEXT NOT NULL,
  comparacao TEXT NOT NULL CHECK (comparacao IN ('menor','maior')),
  limiar REAL NOT NULL,
  limiar_recuperacao REAL NOT NULL,
  confirmacoes INTEGER NOT NULL DEFAULT 2 CHECK (confirmacoes >= 1),
  severidade TEXT NOT NULL CHECK (severidade IN ('critica','alta','media','baixa')),
  equipamento_id INTEGER REFERENCES equipamentos(id),
  versao INTEGER NOT NULL DEFAULT 1,
  ativa INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

CREATE TABLE amostras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  fonte TEXT NOT NULL,
  origem_evento_id TEXT NOT NULL,
  equipamento_id INTEGER REFERENCES equipamentos(id),
  alvo_id TEXT NOT NULL,
  ponto TEXT,
  metrica TEXT NOT NULL,
  valor REAL NOT NULL,
  unidade TEXT,
  observado_em TEXT NOT NULL,
  recebido_em TEXT NOT NULL,
  UNIQUE (organizacao_id, fonte, origem_evento_id)
);
CREATE INDEX idx_amostras_alvo ON amostras(organizacao_id, equipamento_id, metrica, observado_em);

-- Estado de cada alvo × regra (contagem de violações e de recuperações seguidas).
CREATE TABLE alvo_estado (
  organizacao_id INTEGER NOT NULL,
  regra_id INTEGER NOT NULL REFERENCES regras_monitoramento(id),
  equipamento_id INTEGER NOT NULL REFERENCES equipamentos(id),
  ponto TEXT NOT NULL DEFAULT '',
  violacoes INTEGER NOT NULL DEFAULT 0,
  recuperacoes INTEGER NOT NULL DEFAULT 0,
  ultima_amostra_em TEXT,
  PRIMARY KEY (regra_id, equipamento_id, ponto)
);

CREATE TABLE incidentes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  chave_dedup TEXT NOT NULL,
  origem TEXT NOT NULL CHECK (origem IN ('monitoramento','manual')),
  regra_id INTEGER REFERENCES regras_monitoramento(id),
  regra_versao INTEGER,
  equipamento_id INTEGER REFERENCES equipamentos(id),
  ativo_id INTEGER REFERENCES ativos_rede(id),
  ponto TEXT,
  titulo TEXT NOT NULL,
  metrica TEXT,
  severidade TEXT NOT NULL CHECK (severidade IN ('critica','alta','media','baixa')),
  status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','reconhecido','em_atendimento','resolvido')),
  primeira_observacao TEXT NOT NULL,
  ultima_observacao TEXT NOT NULL,
  inicio TEXT NOT NULL,
  reconhecido_em TEXT,
  reconhecido_por INTEGER REFERENCES usuarios(id),
  resolvido_em TEXT,
  resolvido_por INTEGER REFERENCES usuarios(id),
  resolucao TEXT,
  causa_provavel TEXT,
  causa_confirmada INTEGER NOT NULL DEFAULT 0,
  responsavel_id INTEGER REFERENCES usuarios(id),
  incidente_pai_id INTEGER REFERENCES incidentes(id),
  confianca_correlacao TEXT,
  recorrencias INTEGER NOT NULL DEFAULT 0,
  evidencias TEXT,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_incidente_aberto ON incidentes(organizacao_id, chave_dedup) WHERE status <> 'resolvido';
CREATE INDEX idx_incidentes_org ON incidentes(organizacao_id, status, severidade);

CREATE TABLE incidente_eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incidente_id INTEGER NOT NULL REFERENCES incidentes(id),
  tipo TEXT NOT NULL,
  detalhes TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  em TEXT NOT NULL
);

-- ===================== Integrações =====================
-- Configuração por organização e tipo. As credenciais ficam cifradas (AES-256-GCM) e nunca voltam nas respostas.
CREATE TABLE integracoes (
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('rastreador','downdetector')),
  habilitada INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL DEFAULT '{}',
  segredo_cifrado TEXT,
  estado TEXT NOT NULL DEFAULT 'nao_configurada' CHECK (estado IN ('nao_configurada','testando','conectada','parcial','desatualizada','sem_permissao','limite_atingido','falha','desabilitada')),
  ultimo_sucesso TEXT,
  ultima_tentativa TEXT,
  ultimo_erro TEXT,
  erro_id TEXT,
  proxima_tentativa TEXT,
  falhas_consecutivas INTEGER NOT NULL DEFAULT 0,
  atualizado_em TEXT NOT NULL,
  PRIMARY KEY (organizacao_id, tipo)
);

CREATE TABLE sincronizacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  tipo TEXT NOT NULL,
  iniciado_em TEXT NOT NULL,
  terminado_em TEXT,
  resultado TEXT,
  itens INTEGER NOT NULL DEFAULT 0,
  duracao_ms INTEGER,
  erro TEXT,
  erro_id TEXT
);
CREATE INDEX idx_sincronizacoes ON sincronizacoes(organizacao_id, tipo, id DESC);

-- Serviços externos acompanhados (Downdetector): o identificador vem do acesso autorizado do contrato.
CREATE TABLE servicos_externos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  nome TEXT NOT NULL,
  referencia TEXT NOT NULL,
  regiao TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL,
  UNIQUE (organizacao_id, referencia)
);
CREATE TABLE amostras_servico_externo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  servico_id INTEGER NOT NULL REFERENCES servicos_externos(id),
  regiao TEXT,
  periodo_inicio TEXT,
  periodo_fim TEXT,
  relatos INTEGER,
  baseline REAL,
  sinal TEXT NOT NULL CHECK (sinal IN ('sem_relatos_relevantes','indicio_externo','sem_dados')),
  coletado_em TEXT NOT NULL
);
CREATE INDEX idx_amostras_servico ON amostras_servico_externo(servico_id, id DESC);
`,
  },
  {
    versao: 2,
    nome: 'trafego_antiddos',
    sql: `
-- ===================== Tráfego, Anti-DDoS, sessões dos assinantes e avisos =====================
-- Escopos do token do coletor: amostras (monitoramento), sessoes (RADIUS por API), bgp (leitura dos anúncios pelo ExaBGP).
ALTER TABLE coletores ADD COLUMN escopos TEXT NOT NULL DEFAULT 'amostras';

-- Roteadores de borda, BRAS e core que exportam flows. O pacote é aceito só se vier do IP cadastrado.
-- papel: borda (tráfego de/para a internet, usado no Anti-DDoS), bras (sessões dos assinantes), core (tráfego interno).
CREATE TABLE exportadores_fluxo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  nome TEXT NOT NULL,
  ip TEXT NOT NULL UNIQUE,
  papel TEXT NOT NULL DEFAULT 'borda' CHECK (papel IN ('borda','bras','core')),
  -- Usada quando o pacote não informa a amostragem (1 = sem amostragem).
  taxa_amostragem INTEGER NOT NULL DEFAULT 1 CHECK (taxa_amostragem >= 1),
  ativo INTEGER NOT NULL DEFAULT 1,
  observacao TEXT,
  formato TEXT,
  ultimo_pacote TEXT,
  pacotes INTEGER NOT NULL DEFAULT 0,
  fluxos INTEGER NOT NULL DEFAULT 0,
  erros INTEGER NOT NULL DEFAULT 0,
  sem_template INTEGER NOT NULL DEFAULT 0,
  ultimo_erro TEXT,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

-- Parâmetros do Anti-DDoS e da sessão BGP por organização.
CREATE TABLE ddos_config (
  organizacao_id INTEGER PRIMARY KEY REFERENCES organizacoes(id),
  -- Avaliações seguidas (a cada 5 s) acima do limite para abrir o ataque.
  confirmacoes INTEGER NOT NULL DEFAULT 2 CHECK (confirmacoes BETWEEN 1 AND 12),
  -- O ataque só conta como normalizado abaixo de limite × fator (histerese), por encerrar_apos_s segundos seguidos.
  fator_recuperacao REAL NOT NULL DEFAULT 0.8 CHECK (fator_recuperacao > 0 AND fator_recuperacao <= 1),
  encerrar_apos_s INTEGER NOT NULL DEFAULT 120 CHECK (encerrar_apos_s BETWEEN 10 AND 3600),
  max_acoes_simultaneas INTEGER NOT NULL DEFAULT 10 CHECK (max_acoes_simultaneas >= 1),
  duracao_padrao_min INTEGER NOT NULL DEFAULT 30 CHECK (duracao_padrao_min BETWEEN 1 AND 10080),
  max_duracao_min INTEGER NOT NULL DEFAULT 1440 CHECK (max_duracao_min BETWEEN 1 AND 10080),
  bgp_next_hop_blackhole TEXT NOT NULL DEFAULT '192.0.2.1',
  bgp_next_hop_blackhole_v6 TEXT NOT NULL DEFAULT '100::1',
  bgp_community_blackhole TEXT NOT NULL DEFAULT '65535:666',
  bgp_next_hop_limpeza TEXT,
  bgp_community_limpeza TEXT,
  limpeza_prefixo_v4 INTEGER NOT NULL DEFAULT 24 CHECK (limpeza_prefixo_v4 BETWEEN 8 AND 32),
  limpeza_prefixo_v6 INTEGER NOT NULL DEFAULT 48 CHECK (limpeza_prefixo_v6 BETWEEN 16 AND 128),
  flowspec_acao TEXT NOT NULL DEFAULT 'discard' CHECK (flowspec_acao IN ('discard','rate-limit')),
  flowspec_taxa_bps INTEGER,
  retencao_minuto_dias INTEGER NOT NULL DEFAULT 8 CHECK (retencao_minuto_dias BETWEEN 1 AND 90),
  retencao_hora_dias INTEGER NOT NULL DEFAULT 400 CHECK (retencao_hora_dias BETWEEN 30 AND 1100),
  -- Marco Civil da Internet (art. 13): registros de conexão por 1 ano, no mínimo.
  retencao_sessoes_dias INTEGER NOT NULL DEFAULT 400 CHECK (retencao_sessoes_dias >= 366),
  versao INTEGER NOT NULL DEFAULT 1,
  atualizado_em TEXT NOT NULL
);

-- Grupos de IPs protegidos (ex.: Clientes residenciais, Corporativos, Servidores), com a política de mitigação.
CREATE TABLE grupos_ip (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  nome TEXT NOT NULL,
  descricao TEXT,
  mitigacao_modo TEXT NOT NULL DEFAULT 'manual' CHECK (mitigacao_modo IN ('desligada','manual','automatica')),
  mitigacao_tipo TEXT NOT NULL DEFAULT 'flowspec' CHECK (mitigacao_tipo IN ('blackhole','flowspec','limpeza')),
  mitigacao_duracao_min INTEGER CHECK (mitigacao_duracao_min IS NULL OR mitigacao_duracao_min BETWEEN 1 AND 10080),
  ativo INTEGER NOT NULL DEFAULT 1,
  versao INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  UNIQUE (organizacao_id, nome)
);

CREATE TABLE grupo_prefixos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  grupo_id INTEGER NOT NULL REFERENCES grupos_ip(id),
  prefixo TEXT NOT NULL,
  versao_ip INTEGER NOT NULL CHECK (versao_ip IN (4,6)),
  criado_em TEXT NOT NULL,
  UNIQUE (organizacao_id, prefixo)
);

-- Limites por grupo. escopo ip = cada IP do grupo; grupo = soma do grupo. janela_s: média de 5, 10 ou 60 s.
CREATE TABLE ddos_limites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  grupo_id INTEGER NOT NULL REFERENCES grupos_ip(id),
  escopo TEXT NOT NULL CHECK (escopo IN ('ip','grupo')),
  direcao TEXT NOT NULL CHECK (direcao IN ('entrada','saida')),
  metrica TEXT NOT NULL CHECK (metrica IN ('bps','pps','fps','tcp_bps','udp_bps','syn_pps','icmp_pps')),
  limite REAL NOT NULL CHECK (limite > 0),
  janela_s INTEGER NOT NULL CHECK (janela_s IN (5,10,60)),
  severidade TEXT NOT NULL DEFAULT 'alta' CHECK (severidade IN ('critica','alta','media','baixa')),
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);
CREATE INDEX idx_ddos_limites ON ddos_limites(organizacao_id, grupo_id);

-- IPs e blocos que nenhuma ação de bloqueio pode atingir (DNS, gerência, clientes críticos, o próprio next-hop).
CREATE TABLE nunca_bloquear (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  prefixo TEXT NOT NULL,
  versao_ip INTEGER NOT NULL CHECK (versao_ip IN (4,6)),
  motivo TEXT NOT NULL,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  UNIQUE (organizacao_id, prefixo)
);

CREATE TABLE ataques (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  numero INTEGER NOT NULL,
  grupo_id INTEGER REFERENCES grupos_ip(id),
  alvo TEXT NOT NULL,
  alvo_tipo TEXT NOT NULL CHECK (alvo_tipo IN ('ip','grupo')),
  versao_ip INTEGER,
  -- entrada: de fora para dentro; saida: de dentro para fora; interno: dentro da rede (módulo de ataques internos).
  direcao TEXT NOT NULL CHECK (direcao IN ('entrada','saida','interno')),
  vetor TEXT,
  metrica TEXT NOT NULL,
  limite REAL NOT NULL,
  janela_s INTEGER NOT NULL,
  severidade TEXT NOT NULL CHECK (severidade IN ('critica','alta','media','baixa')),
  status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','encerrado')),
  inicio TEXT NOT NULL,
  fim TEXT,
  ultima_atualizacao TEXT NOT NULL,
  atual_bps REAL NOT NULL DEFAULT 0,
  atual_pps REAL NOT NULL DEFAULT 0,
  pico_bps REAL NOT NULL DEFAULT 0,
  pico_pps REAL NOT NULL DEFAULT 0,
  pico_fps REAL NOT NULL DEFAULT 0,
  total_bytes REAL NOT NULL DEFAULT 0,
  origens TEXT,
  portas_origem TEXT,
  portas_destino TEXT,
  protocolos TEXT,
  encerrado_por INTEGER REFERENCES usuarios(id),
  motivo_encerramento TEXT,
  criado_em TEXT NOT NULL,
  UNIQUE (organizacao_id, numero)
);
CREATE UNIQUE INDEX uq_ataque_ativo ON ataques(organizacao_id, alvo, direcao) WHERE status = 'ativo';
CREATE INDEX idx_ataques_org ON ataques(organizacao_id, status, inicio DESC);

-- Medições do ataque a cada 10 s (gráfico e relatório).
CREATE TABLE ataque_serie (
  ataque_id INTEGER NOT NULL REFERENCES ataques(id),
  em TEXT NOT NULL,
  bps REAL NOT NULL,
  pps REAL NOT NULL,
  PRIMARY KEY (ataque_id, em)
) WITHOUT ROWID;

CREATE TABLE ataque_eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ataque_id INTEGER NOT NULL REFERENCES ataques(id),
  tipo TEXT NOT NULL,
  detalhes TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  em TEXT NOT NULL
);

-- Ações de bloqueio por BGP. O sistema gera o anúncio; o ExaBGP do provedor lê os anúncios ativos e os aplica.
CREATE TABLE mitigacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  ataque_id INTEGER REFERENCES ataques(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('blackhole','flowspec','limpeza')),
  prefixo TEXT NOT NULL,
  versao_ip INTEGER NOT NULL CHECK (versao_ip IN (4,6)),
  regra TEXT,
  status TEXT NOT NULL CHECK (status IN ('aguardando_aprovacao','ativa','retirada','recusada','bloqueada')),
  origem TEXT NOT NULL CHECK (origem IN ('automatica','manual')),
  motivo TEXT,
  duracao_min INTEGER NOT NULL,
  solicitada_em TEXT NOT NULL,
  solicitada_por INTEGER REFERENCES usuarios(id),
  aprovada_em TEXT,
  aprovada_por INTEGER REFERENCES usuarios(id),
  ativada_em TEXT,
  expira_em TEXT,
  retirada_em TEXT,
  retirada_por INTEGER REFERENCES usuarios(id),
  motivo_retirada TEXT,
  versao INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL
);
CREATE INDEX idx_mitigacoes_org ON mitigacoes(organizacao_id, status);
CREATE UNIQUE INDEX uq_mitigacao_vigente ON mitigacoes(organizacao_id, tipo, prefixo) WHERE status IN ('aguardando_aprovacao','ativa');

-- Tráfego somado por minuto, por grupo e direção (curto prazo) e por IP e hora (longo prazo).
CREATE TABLE trafego_minuto (
  organizacao_id INTEGER NOT NULL,
  minuto TEXT NOT NULL,
  grupo_id INTEGER NOT NULL,
  direcao TEXT NOT NULL,
  bytes REAL NOT NULL,
  pacotes REAL NOT NULL,
  fluxos REAL NOT NULL,
  bytes_tcp REAL NOT NULL DEFAULT 0,
  bytes_udp REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (organizacao_id, minuto, grupo_id, direcao)
) WITHOUT ROWID;

CREATE TABLE trafego_ip_hora (
  organizacao_id INTEGER NOT NULL,
  hora TEXT NOT NULL,
  ip TEXT NOT NULL,
  direcao TEXT NOT NULL,
  grupo_id INTEGER,
  bytes REAL NOT NULL,
  pacotes REAL NOT NULL,
  fluxos REAL NOT NULL,
  PRIMARY KEY (organizacao_id, hora, ip, direcao)
) WITHOUT ROWID;
CREATE INDEX idx_trafego_ip ON trafego_ip_hora(organizacao_id, ip, hora);

-- Servidores de acesso (BRAS/NAS) que enviam a contabilidade RADIUS (cópia do accounting) para o Manager Network.
CREATE TABLE radius_nas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  nome TEXT NOT NULL,
  ip TEXT NOT NULL UNIQUE,
  segredo_cifrado TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_pacote TEXT,
  pacotes INTEGER NOT NULL DEFAULT 0,
  erros INTEGER NOT NULL DEFAULT 0,
  ultimo_erro TEXT,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

-- Sessões PPPoE/IPoE: qual login usou qual IP, de quando a quando.
CREATE TABLE sessoes_assinantes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  login TEXT NOT NULL,
  ip TEXT,
  ipv6_prefixo TEXT,
  ipv6_delegado TEXT,
  nas_ip TEXT NOT NULL,
  sessao_id TEXT NOT NULL,
  mac TEXT,
  nas_porta TEXT,
  inicio TEXT NOT NULL,
  fim TEXT,
  ultima_atualizacao TEXT NOT NULL,
  bytes_entrada REAL NOT NULL DEFAULT 0,
  bytes_saida REAL NOT NULL DEFAULT 0,
  motivo_fim TEXT,
  fonte TEXT NOT NULL CHECK (fonte IN ('radius','api')),
  UNIQUE (organizacao_id, nas_ip, sessao_id)
);
CREATE INDEX idx_sessoes_ip ON sessoes_assinantes(organizacao_id, ip, inicio);
CREATE INDEX idx_sessoes_login ON sessoes_assinantes(organizacao_id, login, inicio);
CREATE INDEX idx_sessoes_ativas ON sessoes_assinantes(organizacao_id, fim);

-- Canais de aviso (Telegram, WhatsApp, webhook) e a fila de envios com tentativas.
CREATE TABLE avisos_canais (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('telegram','whatsapp','webhook')),
  nome TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  segredo_cifrado TEXT,
  eventos TEXT NOT NULL DEFAULT '[]',
  severidade_min TEXT NOT NULL DEFAULT 'baixa' CHECK (severidade_min IN ('critica','alta','media','baixa')),
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_envio TEXT,
  ultimo_erro TEXT,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

CREATE TABLE avisos_envios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizacao_id INTEGER NOT NULL REFERENCES organizacoes(id),
  canal_id INTEGER NOT NULL REFERENCES avisos_canais(id),
  evento TEXT NOT NULL,
  recurso TEXT,
  recurso_id INTEGER,
  texto TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','enviado','falha')),
  tentativas INTEGER NOT NULL DEFAULT 0,
  proxima_tentativa TEXT NOT NULL,
  erro TEXT,
  erro_id TEXT,
  criado_em TEXT NOT NULL,
  enviado_em TEXT
);
CREATE INDEX idx_avisos_fila ON avisos_envios(status, proxima_tentativa);
CREATE INDEX idx_avisos_org ON avisos_envios(organizacao_id, id DESC);
`,
  },
];

const agora = () => new Date().toISOString();

/** Aplica as migrações pendentes, em ordem, cada uma numa transação. */
function migrar(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migracoes (versao INTEGER PRIMARY KEY, nome TEXT NOT NULL, aplicada_em TEXT NOT NULL)');
  const feitas = new Set(db.prepare('SELECT versao FROM schema_migracoes').all().map((r) => r.versao));
  const aplicadas = [];
  for (const m of MIGRACOES) {
    if (feitas.has(m.versao)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migracoes (versao, nome, aplicada_em) VALUES (?, ?, ?)').run(m.versao, m.nome, agora());
      db.exec('COMMIT');
      aplicadas.push(m.versao);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migração ${m.versao} (${m.nome}) falhou: ${err.message}`);
    }
  }
  return aplicadas;
}

function abrir(arquivo = config.dbFile, { semAdmin = false } = {}) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrar(db);
  if (!semAdmin && !db.prepare("SELECT 1 FROM usuarios WHERE perfil = 'admin' LIMIT 1").get()) {
    const { criarOrganizacao } = require('./lib/organizacoes');
    const org = criarOrganizacao(db, { nome: config.admin.organizacao, fuso: config.fusoPadrao });
    db.prepare("INSERT INTO usuarios (organizacao_id, nome, email, senha_hash, perfil, criado_em) VALUES (?, ?, ?, ?, 'admin', ?)")
      .run(org, config.admin.nome, config.admin.email, hashSenha(config.admin.senha), agora());
  }
  return db;
}

const abertas = new WeakSet();
/** Executa fn numa transação IMMEDIATE (aninhada vira parte da externa). */
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

/** Próximo número sequencial da organização (ex.: número da OS). */
function proximoNumero(db, organizacaoId, nome) {
  db.prepare('INSERT INTO contadores (organizacao_id, nome, valor) VALUES (?, ?, 0) ON CONFLICT DO NOTHING').run(organizacaoId, nome);
  db.prepare('UPDATE contadores SET valor = valor + 1 WHERE organizacao_id = ? AND nome = ?').run(organizacaoId, nome);
  return db.prepare('SELECT valor FROM contadores WHERE organizacao_id = ? AND nome = ?').get(organizacaoId, nome).valor;
}

module.exports = { abrir, migrar, transacao, proximoNumero, agora, MIGRACOES };
