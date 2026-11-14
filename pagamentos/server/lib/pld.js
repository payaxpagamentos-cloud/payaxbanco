'use strict';

/*
 * PLD — prevenção à lavagem de dinheiro (Lei 9.613/1998).
 *
 * A PAY AX recebe na conta dela o dinheiro dos clientes e o repassa: é "intermediação de recursos
 * financeiros de terceiros" (art. 9º, I). Por isso o sistema cumpre, por padrão, o que os arts. 10
 * e 11 pedem a quem está nessa lista — o jurídico confirma o enquadramento, mas o conservador é
 * cumprir desde já:
 *
 *   - art. 10, I e § 1º — identificar os clientes e manter o cadastro atualizado; cliente pessoa
 *     jurídica inclui quem a representa e os proprietários (sócios). → CONHEÇA SEU CLIENTE
 *   - art. 10, II e § 2º — registrar as transações e guardar por no mínimo 5 anos a partir da
 *     conclusão. → boletos e lançamentos nunca são apagados; a retenção da LGPD respeita os 5 anos
 *   - art. 11, I — dar especial atenção às operações que possam indicar os crimes da lei.
 *     → MONITORAMENTO: regras que geram alertas para análise
 *   - art. 11, II — comunicar ao Coaf em 24 horas, ABSTENDO-SE DE DAR CIÊNCIA a qualquer pessoa,
 *     inclusive àquela a que se refere a informação. → decisão de comunicar abre prazo de 24 h;
 *     nada daqui chega à Área do Cliente; só quem tem pld.ver (administrador) vê
 *   - art. 11, III — comunicar a não ocorrência, na periodicidade da regulamentação.
 *     → declaração anual registrada aqui
 *
 * A comunicação em si é feita no SISCOAF (sistema do Coaf); aqui fica o registro: quem analisou,
 * o que decidiu, quando comunicou e o protocolo. Nada é apagado.
 *
 * Os limites das regras são parâmetros (tela PLD → Parâmetros), não constantes: a política de PLD
 * da empresa é quem os define, e eles ajustam ao porte da operação (art. 10, III).
 */
const config = require('../config');
const datas = require('./datas');
const { transacao, agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const v = require('./validacao');
const { parametro, gravarParametro } = require('./doisfatores');

const hoje = () => datas.dataLocal(config.fusoPadrao);
const brl = (c) => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBr = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '—');
const mesBr = (m) => m.split('-').reverse().join('/');

// ---------------------------------------------------------------- Parâmetros
const PARAMETROS = Object.freeze({
  valor_alto_centavos: { padrao: 1_000_000, rotulo: 'Boleto pago de valor alto (R$)', dinheiro: true },
  fator_atipico: { padrao: 5, rotulo: 'Valor fora do padrão do cliente: vezes a média' },
  minimo_atipico_centavos: { padrao: 100_000, rotulo: 'Valor fora do padrão: só acima de (R$)', dinheiro: true },
  fracionamento_qtd: { padrao: 5, rotulo: 'Fracionamento: boletos do mesmo pagador' },
  fracionamento_dias: { padrao: 7, rotulo: 'Fracionamento: em quantos dias' },
  fracionamento_valor_centavos: { padrao: 1_000_000, rotulo: 'Fracionamento: ou soma acima de (R$)', dinheiro: true },
  volume_fator: { padrao: 3, rotulo: 'Volume do mês: vezes a média dos 3 meses anteriores' },
  volume_minimo_centavos: { padrao: 500_000, rotulo: 'Volume do mês: só se a média passar de (R$)', dinheiro: true },
  cliente_novo_dias: { padrao: 90, rotulo: 'Cliente novo: cadastrado há menos de (dias)' },
  cliente_novo_volume_centavos: { padrao: 5_000_000, rotulo: 'Cliente novo: volume no mês acima de (R$)', dinheiro: true },
  multiplos_clientes: { padrao: 3, rotulo: 'Mesmo pagador pagando clientes diferentes em 30 dias' },
  prazo_analise_dias: { padrao: 30, rotulo: 'Prazo para analisar um alerta (dias, política interna)' },
  kyc_revisao_dias: { padrao: 365, rotulo: 'Revisão do cadastro do cliente a cada (dias)' },
});

function parametros(db) {
  return Object.fromEntries(Object.entries(PARAMETROS).map(([k, p]) => [k, Number(parametro(db, `pld_${k}`, p.padrao))]));
}

function gravarParametros(db, dados) {
  const atual = parametros(db);
  for (const [k, p] of Object.entries(PARAMETROS)) {
    if (dados[k] === undefined || dados[k] === '') continue;
    const n = p.dinheiro ? v.centavos(dados[k], p.rotulo) : v.inteiro(dados[k], p.rotulo, { min: 1, max: 100_000 });
    if (n <= 0) throw new ErroNegocio(`${p.rotulo}: precisa ser maior que zero.`, 422);
    atual[k] = n;
    gravarParametro(db, `pld_${k}`, String(n));
  }
  return atual;
}

// ---------------------------------------------------------------- Monitoramento (art. 11, I)
const PAGOS = "b.situacao = 'liquidado' AND b.pago_em IS NOT NULL";
const mes = (data) => data.slice(0, 7);

/**
 * Regras de operação atípica. Cada uma devolve alertas com uma CHAVE: a mesma situação não gera
 * dois alertas, e rodar o monitoramento várias vezes é seguro.
 */
const REGRAS = [
  {
    id: 'valor-alto',
    titulo: 'Boleto pago de valor alto',
    porque: 'Cobrança de provedor é, em geral, de valor baixo e recorrente. Um pagamento muito acima disso merece análise.',
    gerar(db, p, data) {
      return db.prepare(`SELECT b.id, b.cliente_id, b.pago_valor_centavos AS valor, b.pagador_nome, b.pago_em
        FROM boletos b WHERE ${PAGOS} AND b.pago_em >= ? AND b.pago_valor_centavos >= ?`)
        .all(datas.somarDias(data, -60), p.valor_alto_centavos)
        .map((b) => ({ chave: `valor-alto:boleto:${b.id}`, cliente_id: b.cliente_id, boleto_id: b.id, valor_centavos: b.valor,
          descricao: `Boleto de ${brl(b.valor)} pago em ${dataBr(b.pago_em)} por ${b.pagador_nome} (limite da regra: ${brl(p.valor_alto_centavos)}).` }));
    },
  },
  {
    id: 'valor-atipico',
    titulo: 'Valor fora do padrão do cliente',
    porque: 'Um pagamento muitas vezes maior que a média do próprio cliente foge do perfil dele.',
    gerar(db, p, data) {
      return db.prepare(`SELECT b.id, b.cliente_id, b.pago_valor_centavos AS valor, b.pagador_nome, b.pago_em,
          (SELECT AVG(x.pago_valor_centavos) FROM boletos x WHERE x.cliente_id = b.cliente_id AND x.situacao = 'liquidado'
            AND x.id <> b.id AND x.pago_em BETWEEN date(b.pago_em, '-90 day') AND b.pago_em) AS media,
          (SELECT COUNT(*) FROM boletos x WHERE x.cliente_id = b.cliente_id AND x.situacao = 'liquidado'
            AND x.id <> b.id AND x.pago_em BETWEEN date(b.pago_em, '-90 day') AND b.pago_em) AS base
        FROM boletos b WHERE ${PAGOS} AND b.pago_em >= ? AND b.pago_valor_centavos >= ?`)
        .all(datas.somarDias(data, -60), p.minimo_atipico_centavos)
        // Só compara com histórico de verdade: com poucos títulos, a média não diz nada.
        .filter((b) => b.base >= 20 && b.media > 0 && b.valor >= b.media * p.fator_atipico)
        .map((b) => ({ chave: `valor-atipico:boleto:${b.id}`, cliente_id: b.cliente_id, boleto_id: b.id, valor_centavos: b.valor,
          descricao: `Boleto de ${brl(b.valor)} pago em ${dataBr(b.pago_em)}: ${(b.valor / b.media).toFixed(1)}× a média do cliente nos 90 dias anteriores (${brl(Math.round(b.media))}).` }));
    },
  },
  {
    id: 'fracionamento',
    titulo: 'Fracionamento: o mesmo pagador, muitos boletos em poucos dias',
    porque: 'Dividir um valor grande em vários pagamentos menores é a forma clássica de fugir de um limite de atenção.',
    gerar(db, p, data) {
      return db.prepare(`SELECT b.cliente_id, b.pagador_documento AS doc,
          (SELECT x.pagador_nome FROM boletos x WHERE x.pagador_documento = b.pagador_documento ORDER BY x.id DESC LIMIT 1) AS nome,
          COUNT(*) AS n, SUM(b.pago_valor_centavos) AS soma, MIN(b.pago_em) AS de, MAX(b.pago_em) AS ate
        FROM boletos b WHERE ${PAGOS} AND b.pago_em >= ?
        GROUP BY b.cliente_id, b.pagador_documento
        HAVING n >= ? OR soma >= ?`)
        .all(datas.somarDias(data, -(p.fracionamento_dias - 1)), p.fracionamento_qtd, p.fracionamento_valor_centavos)
        .filter((x) => x.n >= 2)
        .map((x) => ({ chave: `fracionamento:${x.cliente_id}:${x.doc}:${x.de}`, cliente_id: x.cliente_id, valor_centavos: x.soma,
          detalhes: { pagador_documento: x.doc, boletos: x.n, de: x.de, ate: x.ate },
          descricao: `${x.nome} pagou ${x.n} boletos que somam ${brl(x.soma)} entre ${dataBr(x.de)} e ${dataBr(x.ate)} (janela de ${p.fracionamento_dias} dias).` }));
    },
  },
  {
    id: 'volume-mensal',
    titulo: 'Volume do mês muito acima do histórico',
    porque: 'Um salto de volume sem explicação comercial pode indicar uso da conta para passar recursos de terceiros.',
    gerar(db, p, data) {
      const atual = mes(data);
      // Os três meses anteriores ao atual, como "AAAA-MM".
      const meses = [1, 2, 3].map((i) => {
        const d = new Date(`${atual}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - i); return d.toISOString().slice(0, 7);
      });
      return db.prepare(`SELECT c.id AS cliente_id,
          (SELECT IFNULL(SUM(pago_valor_centavos), 0) FROM boletos WHERE cliente_id = c.id AND situacao = 'liquidado' AND substr(pago_em, 1, 7) = ?) AS mes_atual,
          (SELECT IFNULL(SUM(pago_valor_centavos), 0) / 3.0 FROM boletos WHERE cliente_id = c.id AND situacao = 'liquidado' AND substr(pago_em, 1, 7) IN (?, ?, ?)) AS media
        FROM clientes c`).all(atual, ...meses)
        .filter((x) => x.media >= p.volume_minimo_centavos && x.mes_atual >= x.media * p.volume_fator)
        .map((x) => ({ chave: `volume-mensal:${x.cliente_id}:${atual}`, cliente_id: x.cliente_id, valor_centavos: x.mes_atual,
          descricao: `Recebido em ${mesBr(atual)}: ${brl(x.mes_atual)}, ${(x.mes_atual / x.media).toFixed(1)}× a média dos três meses anteriores (${brl(Math.round(x.media))}).` }));
    },
  },
  {
    id: 'cliente-novo',
    titulo: 'Cliente novo com volume alto',
    porque: 'Conta recém-aberta que já movimenta muito é um padrão comum de uso indevido.',
    gerar(db, p, data) {
      const atual = mes(data);
      return db.prepare(`SELECT c.id AS cliente_id, substr(c.criado_em, 1, 10) AS desde,
          (SELECT IFNULL(SUM(pago_valor_centavos), 0) FROM boletos WHERE cliente_id = c.id AND situacao = 'liquidado' AND substr(pago_em, 1, 7) = ?) AS volume
        FROM clientes c WHERE substr(c.criado_em, 1, 10) >= ?`).all(atual, datas.somarDias(data, -p.cliente_novo_dias))
        .filter((x) => x.volume >= p.cliente_novo_volume_centavos)
        .map((x) => ({ chave: `cliente-novo:${x.cliente_id}:${atual}`, cliente_id: x.cliente_id, valor_centavos: x.volume,
          descricao: `Cliente cadastrado em ${dataBr(x.desde)} já recebeu ${brl(x.volume)} em ${mesBr(atual)}.` }));
    },
  },
  {
    id: 'pagador-e-o-cliente',
    titulo: 'O próprio cliente pagando o boleto',
    porque: 'O cliente pagar a si mesmo faz o dinheiro dar uma volta pela PAY AX sem cobrança real por trás.',
    gerar(db, _p, data) {
      return db.prepare(`SELECT b.id, b.cliente_id, b.pago_valor_centavos AS valor, b.pago_em FROM boletos b
        JOIN clientes c ON c.id = b.cliente_id
        WHERE ${PAGOS} AND b.pago_em >= ? AND b.pagador_documento = c.cnpj`).all(datas.somarDias(data, -60))
        .map((b) => ({ chave: `pagador-e-o-cliente:boleto:${b.id}`, cliente_id: b.cliente_id, boleto_id: b.id, valor_centavos: b.valor,
          descricao: `Boleto de ${brl(b.valor)} pago em ${dataBr(b.pago_em)} pelo próprio CNPJ do cliente.` }));
    },
  },
  {
    id: 'pagador-varios-clientes',
    titulo: 'O mesmo pagador pagando vários clientes',
    porque: 'Uma pessoa costuma ter um provedor. A mesma pessoa pagando vários clientes da PAY AX em pouco tempo foge do comum.',
    gerar(db, p, data) {
      const de = datas.somarDias(data, -29);
      return db.prepare(`SELECT b.pagador_documento AS doc, COUNT(DISTINCT b.cliente_id) AS clientes,
          (SELECT x.pagador_nome FROM boletos x WHERE x.pagador_documento = b.pagador_documento ORDER BY x.id DESC LIMIT 1) AS nome,
          SUM(b.pago_valor_centavos) AS soma, MIN(b.cliente_id) AS um_cliente, GROUP_CONCAT(DISTINCT b.cliente_id) AS ids
        FROM boletos b WHERE ${PAGOS} AND b.pago_em >= ?
        GROUP BY b.pagador_documento HAVING clientes >= ?`).all(de, p.multiplos_clientes)
        .map((x) => ({ chave: `pagador-varios-clientes:${x.doc}:${mes(data)}`, cliente_id: x.um_cliente, valor_centavos: x.soma,
          detalhes: { pagador_documento: x.doc, clientes: String(x.ids).split(',').map(Number) },
          descricao: `${x.nome} pagou boletos de ${x.clientes} clientes diferentes nos últimos 30 dias, somando ${brl(x.soma)}.` }));
    },
  },
];

const REGRA_POR_ID = new Map(REGRAS.map((r) => [r.id, r]));

/** Roda todas as regras e grava os alertas novos. Idempotente. */
function monitorar(db, { data = hoje() } = {}) {
  const p = parametros(db);
  const inserir = db.prepare(`INSERT OR IGNORE INTO pld_alertas (regra, chave, cliente_id, boleto_id, descricao, valor_centavos,
      detalhes, situacao, prazo_analise, criado_em, atualizado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'novo', ?, ?, ?)`);
  const prazo = datas.somarDias(data, p.prazo_analise_dias);
  let novos = 0;
  const porRegra = {};
  transacao(db, () => {
    for (const regra of REGRAS) {
      const achados = regra.gerar(db, p, data);
      porRegra[regra.id] = achados.length;
      for (const a of achados) {
        const r = inserir.run(regra.id, a.chave, a.cliente_id, a.boleto_id ?? null, a.descricao, a.valor_centavos ?? null,
          a.detalhes ? JSON.stringify(a.detalhes) : null, prazo, agora(), agora());
        novos += r.changes;
      }
    }
    gravarParametro(db, 'pld_ultimo_monitoramento', agora());
  });
  return { novos, por_regra: porRegra, em: agora() };
}

// ---------------------------------------------------------------- Análise e comunicação (art. 11, II)
const SITUACOES = ['novo', 'em_analise', 'a_comunicar', 'comunicado', 'arquivado'];

function alerta(db, id) {
  const a = db.prepare(`SELECT a.*, COALESCE(c.nome_fantasia, c.razao_social) AS cliente, c.cnpj AS cliente_cnpj,
      u.nome AS analista, d.nome AS decidido_por_nome
    FROM pld_alertas a JOIN clientes c ON c.id = a.cliente_id
    LEFT JOIN usuarios u ON u.id = a.analista_id LEFT JOIN usuarios d ON d.id = a.decidido_por
    WHERE a.id = ?`).get(id);
  if (!a) throw naoEncontrado('Alerta');
  return { ...a, detalhes: a.detalhes ? JSON.parse(a.detalhes) : null, regra_titulo: REGRA_POR_ID.get(a.regra)?.titulo ?? a.regra,
    regra_porque: REGRA_POR_ID.get(a.regra)?.porque ?? null };
}

function exigirSituacao(a, permitidas, acao) {
  if (!permitidas.includes(a.situacao)) throw new ErroNegocio(`Não dá para ${acao}: o alerta está "${a.situacao}".`, 409);
}

/** Alguém da equipe assume a análise. */
function assumir(db, id, usuario) {
  const a = alerta(db, id);
  exigirSituacao(a, ['novo', 'em_analise'], 'assumir a análise');
  db.prepare("UPDATE pld_alertas SET situacao = 'em_analise', analista_id = ?, atualizado_em = ? WHERE id = ?").run(usuario.id, agora(), id);
  return alerta(db, id);
}

/** Arquiva com justificativa: a análise concluiu que há explicação para a operação. */
function arquivar(db, id, { justificativa }, usuario) {
  const a = alerta(db, id);
  exigirSituacao(a, ['novo', 'em_analise'], 'arquivar');
  const texto = v.texto(justificativa, 'a justificativa', 2000);
  if (texto.length < 20) throw new ErroNegocio('Escreva a justificativa do arquivamento (pelo menos 20 caracteres): ela fica guardada por 5 anos.', 422);
  db.prepare(`UPDATE pld_alertas SET situacao = 'arquivado', analise = ?, analista_id = COALESCE(analista_id, ?), decidido_por = ?,
      decidido_em = ?, atualizado_em = ? WHERE id = ?`).run(texto, usuario.id, usuario.id, agora(), agora(), id);
  return alerta(db, id);
}

/**
 * Decide comunicar ao Coaf. A partir daqui correm as 24 horas do art. 11, II: o prazo fica gravado,
 * e passa a ser alerta no painel e fora da norma na Conformidade se vencer sem o protocolo.
 */
function decidirComunicar(db, id, { fundamentacao }, usuario) {
  const a = alerta(db, id);
  exigirSituacao(a, ['novo', 'em_analise'], 'decidir a comunicação');
  const texto = v.texto(fundamentacao, 'a fundamentação', 4000);
  if (texto.length < 20) throw new ErroNegocio('Escreva a fundamentação da comunicação (pelo menos 20 caracteres).', 422);
  const prazo = new Date(Date.now() + 24 * 3_600_000).toISOString();
  db.prepare(`UPDATE pld_alertas SET situacao = 'a_comunicar', analise = ?, analista_id = COALESCE(analista_id, ?), decidido_por = ?,
      decidido_em = ?, prazo_comunicacao = ?, atualizado_em = ? WHERE id = ?`).run(texto, usuario.id, usuario.id, agora(), prazo, agora(), id);
  return alerta(db, id);
}

/** Registra o protocolo do SISCOAF. */
function registrarComunicacao(db, id, { protocolo, comunicado_em }, usuario) {
  const a = alerta(db, id);
  exigirSituacao(a, ['a_comunicar'], 'registrar a comunicação');
  const proto = v.texto(protocolo, 'o protocolo do SISCOAF', 80);
  const quando = comunicado_em ? new Date(comunicado_em).toISOString() : agora();
  if (Number.isNaN(Date.parse(quando))) throw new ErroNegocio('Data da comunicação inválida.', 422);
  db.prepare(`UPDATE pld_alertas SET situacao = 'comunicado', coaf_protocolo = ?, comunicado_em = ?, comunicado_por = ?, atualizado_em = ?
    WHERE id = ?`).run(proto, quando, usuario.id, agora(), id);
  return alerta(db, id);
}

function listar(db, { situacao = null, regra = null, cliente_id = null, limite = 200 } = {}) {
  const cond = []; const p = [];
  if (situacao === 'abertos') cond.push("a.situacao IN ('novo','em_analise','a_comunicar')");
  else if (situacao) { cond.push('a.situacao = ?'); p.push(situacao); }
  if (regra) { cond.push('a.regra = ?'); p.push(regra); }
  if (cliente_id) { cond.push('a.cliente_id = ?'); p.push(Number(cliente_id)); }
  return db.prepare(`SELECT a.id, a.regra, a.cliente_id, a.boleto_id, a.descricao, a.valor_centavos, a.situacao, a.prazo_analise,
      a.prazo_comunicacao, a.coaf_protocolo, a.criado_em, COALESCE(c.nome_fantasia, c.razao_social) AS cliente, u.nome AS analista
    FROM pld_alertas a JOIN clientes c ON c.id = a.cliente_id LEFT JOIN usuarios u ON u.id = a.analista_id
    ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
    ORDER BY CASE a.situacao WHEN 'a_comunicar' THEN 0 WHEN 'novo' THEN 1 WHEN 'em_analise' THEN 2 ELSE 3 END, a.id DESC
    LIMIT ?`).all(...p, limite).map((x) => ({ ...x, regra_titulo: REGRA_POR_ID.get(x.regra)?.titulo ?? x.regra }));
}

/** Prazos estourados: análise além da política interna, comunicação além das 24 h. */
function atrasos(db, data = hoje()) {
  return {
    analise: db.prepare("SELECT COUNT(*) AS n FROM pld_alertas WHERE situacao IN ('novo','em_analise') AND prazo_analise < ?").get(data).n,
    comunicacao: db.prepare("SELECT COUNT(*) AS n FROM pld_alertas WHERE situacao = 'a_comunicar' AND prazo_comunicacao < ?").get(agora()).n,
  };
}

// ---------------------------------------------------------------- Conheça seu cliente (art. 10, I e § 1º)
const lerLista = (x) => { try { return x ? JSON.parse(x) : []; } catch { return []; } };

function kycDe(c, p) {
  const socios = lerLista(c.kyc_socios);
  const representantes = lerLista(c.kyc_representantes);
  const pendencias = [];
  if (!socios.length) pendencias.push('sócios (proprietários) não identificados');
  if (!representantes.length) pendencias.push('representante legal não identificado');
  if (!c.kyc_revisado_em) pendencias.push('cadastro nunca revisado');
  else if (datas.diasEntre(c.kyc_revisado_em.slice(0, 10), hoje()) > p.kyc_revisao_dias) pendencias.push('revisão do cadastro vencida');
  if (c.kyc_situacao_receita && !/ativa/i.test(c.kyc_situacao_receita)) pendencias.push(`CNPJ ${c.kyc_situacao_receita.toLowerCase()} na Receita`);
  return { socios, representantes, situacao_receita: c.kyc_situacao_receita ?? null, revisado_em: c.kyc_revisado_em ?? null,
    pendencias, completo: pendencias.length === 0 };
}

function listarKyc(db) {
  const p = parametros(db);
  return db.prepare(`SELECT c.*, u.nome AS revisado_por_nome FROM clientes c LEFT JOIN usuarios u ON u.id = c.kyc_revisado_por
    WHERE c.situacao <> 'encerrado' ORDER BY c.razao_social`).all()
    .map((c) => ({ id: c.id, cliente: c.nome_fantasia || c.razao_social, razao_social: c.razao_social, cnpj: c.cnpj, situacao: c.situacao,
      revisado_por: c.revisado_por_nome, bloqueio_repasse: c.bloqueio_repasse ?? null, ...kycDe(c, p) }));
}

const pessoa = (x, i, tipo) => {
  const nome = v.texto(x?.nome, `o nome do ${tipo} ${i + 1}`, 120);
  return {
    nome,
    qualificacao: v.opcional(x?.qualificacao, `a qualificação do ${tipo} ${i + 1}`, 80),
    documento: x?.documento ? v.documento(x.documento, `o CPF/CNPJ do ${tipo} ${i + 1}`) : null,
  };
};

/** Grava sócios, representantes e a situação na Receita, e marca o cadastro como revisado agora. */
function salvarKyc(db, clienteId, dados, usuario) {
  const c = db.prepare('SELECT * FROM clientes WHERE id = ?').get(clienteId);
  if (!c) throw naoEncontrado('Cliente');
  const socios = (Array.isArray(dados.socios) ? dados.socios : []).filter((x) => x?.nome).map((x, i) => pessoa(x, i, 'sócio'));
  const representantes = (Array.isArray(dados.representantes) ? dados.representantes : []).filter((x) => x?.nome).map((x, i) => pessoa(x, i, 'representante'));
  if (!socios.length) throw new ErroNegocio('Informe pelo menos um sócio (art. 10, § 1º, da Lei 9.613/1998).', 422);
  if (!representantes.length) throw new ErroNegocio('Informe quem representa a empresa (art. 10, § 1º, da Lei 9.613/1998).', 422);
  const receita = v.opcional(dados.situacao_receita, 'a situação na Receita', 60);
  db.prepare(`UPDATE clientes SET kyc_socios = ?, kyc_representantes = ?, kyc_situacao_receita = ?, kyc_revisado_em = ?, kyc_revisado_por = ?
    WHERE id = ?`).run(JSON.stringify(socios), JSON.stringify(representantes), receita, agora(), usuario.id, clienteId);
  return listarKyc(db).find((x) => x.id === clienteId);
}

// ---------------------------------------------------------------- Ordem legal: suspensão de repasse
/**
 * Suspende os repasses de um cliente por ordem legal (decisão judicial ou indisponibilidade de
 * ativos determinada em lei). É a única exceção ao repasse imediato — fica registrada com o motivo
 * e o documento, e a Conformidade mostra o valor retido à parte, não como "dinheiro parado".
 * Não é medida de PLD por si só: a lei pede comunicar ao Coaf, não bloquear.
 */
function suspenderRepasse(db, clienteId, { motivo, documento }, usuario) {
  const c = db.prepare('SELECT * FROM clientes WHERE id = ?').get(clienteId);
  if (!c) throw naoEncontrado('Cliente');
  const texto = `${v.texto(motivo, 'o motivo', 300)} · documento: ${v.texto(documento, 'o número do ofício ou processo', 120)}`;
  db.prepare('UPDATE clientes SET bloqueio_repasse = ?, bloqueio_em = ?, bloqueio_por = ? WHERE id = ?').run(texto, agora(), usuario.id, clienteId);
  return { cliente_id: clienteId, bloqueio_repasse: texto };
}

function liberarRepasse(db, clienteId, { motivo }, usuario) {
  const c = db.prepare('SELECT * FROM clientes WHERE id = ?').get(clienteId);
  if (!c) throw naoEncontrado('Cliente');
  if (!c.bloqueio_repasse) throw new ErroNegocio('Os repasses deste cliente não estão suspensos.', 409);
  const texto = v.texto(motivo, 'o motivo da liberação', 300);
  db.prepare('UPDATE clientes SET bloqueio_repasse = NULL, bloqueio_em = NULL, bloqueio_por = NULL WHERE id = ?').run(clienteId);
  // Quem liberou e por quê ficam na auditoria (a rota registra antes/depois).
  return { cliente_id: clienteId, bloqueio_repasse: null, liberado_por: usuario.id, motivo: texto };
}

// ---------------------------------------------------------------- Não ocorrência (art. 11, III)
function declaracoes(db) {
  return db.prepare(`SELECT d.*, u.nome AS registrado_por_nome FROM pld_declaracoes d LEFT JOIN usuarios u ON u.id = d.registrado_por
    ORDER BY d.ano DESC`).all();
}

function comunicacoesNoAno(db, ano) {
  return db.prepare("SELECT COUNT(*) AS n FROM pld_alertas WHERE situacao = 'comunicado' AND substr(comunicado_em, 1, 4) = ?").get(String(ano)).n;
}

function registrarDeclaracao(db, { ano, protocolo, enviado_em }, usuario) {
  const a = v.inteiro(ano, 'o ano', { min: 2020, max: 2100 });
  if (comunicacoesNoAno(db, a)) {
    throw new ErroNegocio(`Houve comunicação ao Coaf em ${a}: a declaração de não ocorrência não se aplica a esse ano.`, 409);
  }
  const proto = v.texto(protocolo, 'o protocolo do SISCOAF', 80);
  const quando = v.data(enviado_em ?? hoje(), 'a data do envio');
  db.prepare(`INSERT INTO pld_declaracoes (ano, protocolo, enviado_em, registrado_por, registrado_em) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(ano) DO UPDATE SET protocolo = excluded.protocolo, enviado_em = excluded.enviado_em,
      registrado_por = excluded.registrado_por, registrado_em = excluded.registrado_em`)
    .run(a, proto, quando, usuario.id, agora());
  return declaracoes(db).find((d) => d.ano === a);
}

// ---------------------------------------------------------------- Resumo
function resumo(db) {
  const contagem = Object.fromEntries(SITUACOES.map((s) => [s, 0]));
  for (const x of db.prepare('SELECT situacao, COUNT(*) AS n FROM pld_alertas GROUP BY situacao').all()) contagem[x.situacao] = x.n;
  const kyc = listarKyc(db);
  return {
    alertas: contagem,
    abertos: contagem.novo + contagem.em_analise + contagem.a_comunicar,
    atrasos: atrasos(db),
    kyc: { clientes: kyc.length, incompletos: kyc.filter((k) => !k.completo).length },
    suspensos: kyc.filter((k) => k.bloqueio_repasse).length,
    ultimo_monitoramento: parametro(db, 'pld_ultimo_monitoramento'),
  };
}

module.exports = {
  PARAMETROS, REGRAS, SITUACOES, parametros, gravarParametros, monitorar, alerta, listar, assumir, arquivar,
  decidirComunicar, registrarComunicacao, atrasos, listarKyc, salvarKyc, kycDe, suspenderRepasse, liberarRepasse,
  declaracoes, registrarDeclaracao, comunicacoesNoAno, resumo,
};
