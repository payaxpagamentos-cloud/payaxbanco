'use strict';

/*
 * Tabelas oficiais da NFCom.
 *
 * Tudo aqui foi transcrito das fontes oficiais, e cada bloco diz de onde veio. Nada foi completado de
 * memória: um código inventado não dá erro em lugar nenhum do sistema — ele dá erro na SEFAZ, depois que
 * a nota já foi emitida para o cliente.
 *
 * Fontes:
 *   - Tabela de Código de Itens da NFCom (cClass): portal nacional da NFCom, SVRS — /NFCOM/tabelacclass
 *   - CFOP, domínios e alíquotas da Reforma: MOC NFCom, "Tabelas e Códigos"
 *   - Leiaute e domínios: MOC NFCom, "Leiaute"
 *   - Endereços dos serviços: portal nacional da NFCom, SVRS — /NFCOM/Servicos
 */

/* ------------------------------------------------------------------ *
 * Códigos de classificação do item (cClass), 7 dígitos.
 *
 * Para um provedor de internet, os que importam no dia a dia estão marcados em PARA_O_PROVEDOR, abaixo.
 * ------------------------------------------------------------------ */
const CCLASS = {
  // 010 Assinatura
  '0100101': 'Assinatura de serviços de telefonia',
  '0100201': 'Assinatura de serviços de comunicação de dados',
  '0100301': 'Assinatura de serviços de TV por assinatura',
  '0100401': 'Assinatura de serviços de comunicação multimídia',
  // 020 Habilitação
  '0200101': 'Habilitação de serviços de telefonia',
  '0200201': 'Habilitação de serviços de comunicação de dados',
  '0200301': 'Habilitação de TV por assinatura',
  // 030 Serviço medido
  '0300101': 'Chamadas locais',
  '0300102': 'Chamadas longa distância nacional',
  '0300103': 'Chamadas longa distância internacionais',
  '0300104': 'Chamadas originadas em roaming',
  '0300105': 'Chamadas recebidas em roaming',
  '0300106': 'Adicional de chamada',
  '0300107': 'Números especiais',
  '0300108': 'Mensagem SMS',
  '0300109': 'Mensagem MMS',
  '0300201': 'Comunicação de dados',
  '0300301': 'Pay-per-view (programação de TV)',
  '0300401': 'Comunicação multimídia',
  // 040 Serviço não medido
  '0400101': 'Telefonia',
  '0400201': 'Comunicação de dados',
  '0400301': 'TV por assinatura',
  '0400401': 'Provimento à internet',
  '0400501': 'Comunicação multimídia',
  // 045 Serviços combinados
  '0450101': 'Serviços combinados (dados, voz, mensagens e outros)',
  // 050 Serviço pré-pago
  '0500101': 'Cartão telefônico — telefonia fixa',
  '0500102': 'Carga/recarga — telefonia fixa',
  '0500201': 'Carga/recarga — telefonia móvel',
  '0500301': 'Carga/recarga — comunicação multimídia',
  '0500401': 'Carga/recarga — TV por assinatura',
  '0500501': 'Recarga de créditos — antecipação',
  '0500601': 'Repasse de pré-pago',
  // 060 Outros serviços
  '0600101': 'Facilidades adicionais',
  '0600201': 'Streaming de vídeo e áudio',
  '0600301': 'Serviço de rastreamento',
  '0600401': 'Veiculação de publicidade e propaganda em qualquer meio',
  '0600402': 'Veiculação de publicidade por rádio e TV de recepção livre e gratuita',
  '0600501': 'Outros serviços (substituição de número, troca de aparelho, instalação, software, visita técnica)',
  '0600601': 'Outros serviços de valor adicionado',
  // 070 Cessão de meios de rede
  '0700101': 'Interconexão',
  '0700201': 'Roaming',
  '0700301': 'EILD',
  '0700401': 'Cessão de meios de rede — lançamento de ICMS',
  '0700501': 'Cessão de meios de rede — lançamento de ICMS',
  '0700601': 'Cessão de meios de rede — lançamento de ICMS',
  // 080 Disponibilização de equipamentos e infraestrutura
  '0800101': 'Aparelho telefônico',
  '0800201': 'Aparelho identificador de chamadas',
  '0800301': 'Modem',
  '0800401': 'Rack',
  '0800501': 'Sala/recinto',
  '0800601': 'Roteador',
  '0800701': 'Servidor',
  '0800801': 'Multiplexador',
  '0800901': 'Decodificador/conversor',
  '0801001': 'Outros equipamentos',
  '0801101': 'Fibra apagada',
  '0801201': 'Capacidade satelital',
  '0801301': 'Antenas',
  '0801401': 'Dutos e postes',
  // 100 Cobrança própria
  '1000101': 'Cobrança de seguros',
  '1000201': 'Cobrança de parcelamento',
  '1000301': 'Cobrança de juros de mora',
  '1000401': 'Cobrança de multa de mora',
  '1000402': 'Cobrança de multa por descumprimento de contrato (fidelização)',
  '1000501': 'Cobrança de conta de meses anteriores',
  '1000601': 'Correção monetária',
  '1000701': 'Taxas',
  '1000801': 'Adiantamento relativo a serviços de comunicação por radiodifusão',
  '1000901': 'Cobrança por venda de mercadorias',
  // 110 Cobrança de terceiros
  '1100101': 'Cobrança de serviços de terceiros',
  '1100201': 'Cobrança de seguros',
  '1100301': 'Cobrança de juros de mora',
  '1100401': 'Cobrança de multa de mora',
  '1100501': 'Cobrança de conta de meses anteriores',
  '1100601': 'Correção monetária',
  '1100701': 'Doações',
  '1100801': 'Cobrança por disponibilização de equipamentos',
  '1100901': 'Cobrança por venda de mercadorias',
  // 120 / 130 Cobrança centralizada e cofaturamento
  '1200101': 'Item lançado em outra NFCom — cobrança centralizada',
  '1300101': 'Item lançado em outra NFCom — cobrança por cofaturamento',
  // 590 Deduções
  '5900101': 'Dedução relativa a impugnação de serviços',
  '5900201': 'Dedução referente a ajuste de conta',
  '5900301': 'Dedução relativa à multa pela interrupção de fornecimento',
  '5900401': 'Dedução por pagamento em duplicidade',
  '5900501': 'Outras deduções',
};

/*
 * O que um provedor de internet usa, por tipo de item do contrato. É a sugestão que o sistema oferece ao
 * configurar — a palavra final é da contabilidade do provedor, porque a classificação depende de como o
 * serviço foi contratado (um combo de internet com voz, por exemplo, é 0450101, não 0400401).
 */
const PARA_O_PROVEDOR = {
  mensalidade: '0400401',      // Serviço não medido · provimento à internet
  combo: '0450101',            // Serviços combinados (internet + voz + streaming no mesmo plano)
  instalacao: '0600501',       // Outros serviços (inclui instalação e visita técnica)
  equipamento: '0800601',      // Roteador em comodato/aluguel
  sva: '0600601',              // Outros serviços de valor adicionado
  ponto_adicional: '0400401',
  juros: '1000301',
  multa: '1000401',
  desconto: '5900201',         // Dedução referente a ajuste de conta
  avulso: '0600501',
};

/**
 * Item que DEDUZ do total da nota em vez de somar.
 * MOC, "Tabelas e Códigos", seção 3: códigos iniciados por 5 deduzem; os iniciados por zero somam.
 * (O manual não trata dos iniciados por 1 — grupos 100 a 130 —, que somam.)
 */
const deduz = (cClass) => String(cClass ?? '').startsWith('5');

/* ------------------------------------------------------------------ *
 * CFOP aceitos na NFCom (MOC, "Tabelas e Códigos", seção 2).
 * ------------------------------------------------------------------ */
const CFOP = {
  1205: 'Anulação de valor relativo a prestação de serviço de comunicação',
  5301: 'Prestação de serviço de comunicação para execução de serviço da mesma natureza',
  5302: 'Prestação de serviço de comunicação a estabelecimento industrial',
  5303: 'Prestação de serviço de comunicação a estabelecimento comercial',
  5304: 'Prestação de serviço de comunicação a estabelecimento de prestador de serviço de transporte',
  5305: 'Prestação de serviço de comunicação a estabelecimento de geradora ou distribuidora de energia elétrica',
  5306: 'Prestação de serviço de comunicação a estabelecimento de produtor rural',
  5307: 'Prestação de serviço de comunicação a não contribuinte',
  5933: 'Prestação de serviço tributado pelo ISSQN',
  6301: 'Prestação de serviço de comunicação para execução de serviço da mesma natureza (interestadual)',
  6302: 'Prestação de serviço de comunicação a estabelecimento industrial (interestadual)',
  6303: 'Prestação de serviço de comunicação a estabelecimento comercial (interestadual)',
  6304: 'Prestação de serviço de comunicação a estabelecimento de prestador de serviço de transporte (interestadual)',
  6305: 'Prestação de serviço de comunicação a estabelecimento de geradora ou distribuidora de energia elétrica (interestadual)',
  6306: 'Prestação de serviço de comunicação a estabelecimento de produtor rural (interestadual)',
  6307: 'Prestação de serviço de comunicação a não contribuinte (interestadual)',
  7301: 'Prestação de serviço de comunicação para execução de serviço da mesma natureza (exterior)',
};

/* ------------------------------------------------------------------ *
 * Domínios do leiaute (MOC, "Leiaute" e "Tabelas e Códigos").
 * ------------------------------------------------------------------ */
const TP_AMB = { 1: 'Produção', 2: 'Homologação' };
const TP_EMIS = { 1: 'Normal', 2: 'Contingência off-line' };
const FIN_NFCOM = { 0: 'Normal', 3: 'Substituição', 4: 'Ajuste' };
const TP_FAT = { 0: 'Faturamento normal', 1: 'Faturamento centralizado', 2: 'Cofaturamento' };
const IND_IE_DEST = {
  1: 'Contribuinte do ICMS (informar a IE do destinatário)',
  2: 'Contribuinte isento de inscrição no cadastro de contribuintes do ICMS',
  9: 'Não contribuinte, que pode ou não ter inscrição estadual',
};
/* O domínio publicado tem só 1, 2 e 3; o MEI aparece como 4 nas regras de validação, não na tabela. */
const CRT = {
  1: 'Simples Nacional', 2: 'Simples Nacional, excesso de sublimite de receita bruta', 3: 'Regime normal', 4: 'MEI',
};
const U_MED = { 1: 'Minuto', 2: 'MB', 3: 'GB', 4: 'UN' };
const TP_SERV_UTIL = {
  1: 'Telefonia', 2: 'Comunicação de dados', 3: 'TV por assinatura',
  4: 'Provimento de acesso à internet', 5: 'Multimídia', 6: 'Outros', 7: 'Vários',
};
/*
 * Tipo de assinante (D16). Não é "pessoa física ou jurídica", como o nome sugere: é a natureza do
 * assinante para fins de ICMS, e por isso tem produtor rural, templo e missão diplomática no meio.
 * Para um provedor, o que vale no dia a dia é 3 (residencial) e 1 (comercial).
 */
const TP_ASSINANTE = {
  1: 'Comercial',
  2: 'Industrial',
  3: 'Residencial/pessoa física',
  4: 'Produtor rural',
  5: 'Órgão da administração pública estadual direta, suas fundações e autarquias (Convênio ICMS 107/95)',
  6: 'Prestador de serviço de telecomunicação responsável pelo recolhimento na cessão de meios de rede (Convênio ICMS 17/13)',
  7: 'Missões diplomáticas, repartições consulares e organismos internacionais (Convênio ICMS 158/94)',
  8: 'Igrejas e templos de qualquer natureza',
  99: 'Outros não especificados anteriormente',
};
const MOT_SUB = {
  '01': 'Erro de preço', '02': 'Erro cadastral', '03': 'Decisão judicial',
  '04': 'Erro de tributação', '05': 'Descontinuidade do serviço', '06': 'Regime especial',
};
const CST_ICMS = {
  '00': 'Tributada integralmente', 20: 'Com redução de base de cálculo', 40: 'Isenta',
  41: 'Não tributada', 51: 'Diferimento', 90: 'Outros',
};
const CST_PIS_COFINS = {
  '01': 'Operação tributável, alíquota básica', '02': 'Operação tributável, alíquota diferenciada',
  '06': 'Operação tributável, alíquota zero', '07': 'Operação isenta da contribuição',
  '08': 'Operação sem incidência da contribuição', '09': 'Operação com suspensão da contribuição',
  49: 'Outras operações de saída',
};

/* ------------------------------------------------------------------ *
 * Códigos de UF do IBGE (domínio D1 do leiaute).
 * ------------------------------------------------------------------ */
const CUF = {
  RO: 11, AC: 12, AM: 13, RR: 14, PA: 15, AP: 16, TO: 17,
  MA: 21, PI: 22, CE: 23, RN: 24, PB: 25, PE: 26, AL: 27, SE: 28, BA: 29,
  MG: 31, ES: 32, RJ: 33, SP: 35, PR: 41, SC: 42, RS: 43,
  MS: 50, MT: 51, GO: 52, DF: 53,
};
const UF_DE = Object.fromEntries(Object.entries(CUF).map(([uf, c]) => [c, uf]));

/* ------------------------------------------------------------------ *
 * Alíquotas da Reforma Tributária (IBS e CBS) por ano.
 * MOC, "Tabelas e Códigos", 4.2, conforme a LC 214/2025. Os anos sem lei publicada ficam nulos de
 * propósito: o sistema recusa emitir com alíquota que ninguém publicou, em vez de chutar zero.
 * ------------------------------------------------------------------ */
const RTC_POR_ANO = {
  2026: { pIBSUF: '0.10', pIBSMun: '0.00', pCBS: '0.90' },
  2027: { pIBSUF: '0.05', pIBSMun: '0.05', pCBS: null },
  2028: { pIBSUF: '0.05', pIBSMun: '0.05', pCBS: null },
};
const aliquotasRTC = (ano) => RTC_POR_ANO[ano] ?? null;

/* ------------------------------------------------------------------ *
 * Autorizadores.
 *
 * Só os endereços da SVRS estão confirmados no portal nacional. MG, MS e MT autorizam por conta própria
 * e os endereços deles não constam de nenhuma fonte que este sistema tenha lido — por isso ficam sem
 * endereço, e o sistema recusa transmitir dizendo o que falta, em vez de chutar uma URL.
 * ------------------------------------------------------------------ */
const AUTORIZADORES = {
  SVRS: {
    nome: 'SEFAZ Virtual do Rio Grande do Sul',
    confirmado: true,
    1: {
      recepcao: 'https://nfcom.svrs.rs.gov.br/WS/NFComRecepcao/NFComRecepcao.asmx',
      consulta: 'https://nfcom.svrs.rs.gov.br/WS/NFComConsulta/NFComConsulta.asmx',
      evento: 'https://nfcom.svrs.rs.gov.br/WS/NFComRecepcaoEvento/NFComRecepcaoEvento.asmx',
      status: 'https://nfcom.svrs.rs.gov.br/WS/NFComStatusServico/NFComStatusServico.asmx',
      qrcode: 'https://dfe-portal.svrs.rs.gov.br/nfcom/qrCode',
    },
    2: {
      recepcao: 'https://nfcom-homologacao.svrs.rs.gov.br/WS/NFComRecepcao/NFComRecepcao.asmx',
      consulta: 'https://nfcom-homologacao.svrs.rs.gov.br/WS/NFComConsulta/NFComConsulta.asmx',
      evento: 'https://nfcom-homologacao.svrs.rs.gov.br/WS/NFComRecepcaoEvento/NFComRecepcaoEvento.asmx',
      status: 'https://nfcom-homologacao.svrs.rs.gov.br/WS/NFComStatusServico/NFComStatusServico.asmx',
      qrcode: 'https://dfe-portal.svrs.rs.gov.br/nfcom/qrCode',
    },
  },
  MG: { nome: 'SEFAZ Minas Gerais', confirmado: false },
  MS: { nome: 'SEFAZ Mato Grosso do Sul', confirmado: false },
  MT: { nome: 'SEFAZ Mato Grosso', confirmado: false },
};

/** O autorizador de uma UF: MG, MS e MT por conta própria; todas as demais pela SVRS. */
const autorizadorDe = (uf) => (['MG', 'MS', 'MT'].includes(String(uf ?? '').toUpperCase()) ? String(uf).toUpperCase() : 'SVRS');

/** Versão do leiaute que este sistema monta. */
const VERSAO_LEIAUTE = '1.00';
const NAMESPACE = 'http://www.portalfiscal.inf.br/nfcom';

module.exports = {
  CCLASS, PARA_O_PROVEDOR, deduz, CFOP,
  TP_AMB, TP_EMIS, FIN_NFCOM, TP_FAT, IND_IE_DEST, CRT, U_MED, TP_SERV_UTIL, TP_ASSINANTE, MOT_SUB,
  CST_ICMS, CST_PIS_COFINS, CUF, UF_DE, RTC_POR_ANO, aliquotasRTC,
  AUTORIZADORES, autorizadorDe, VERSAO_LEIAUTE, NAMESPACE,
};
