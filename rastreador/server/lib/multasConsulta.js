'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

/**
 * Consulta de multas e apontamentos (DETRAN/SENATRAN) por um serviço contratado. Funciona de dois jeitos:
 *  - automático: a manutenção consulta cada veículo ativo uma vez por dia e cadastra as multas novas na central;
 *  - na hora ("Consultar multas"): uma placa (com ou sem RENAVAM) devolve as multas e os apontamentos (débitos de IPVA e
 *    licenciamento, restrições, roubo/furto, recall…), e as multas de veículos da empresa já entram na central.
 * Ligar: RASTREADOR_MULTAS_URL e RASTREADOR_MULTAS_CHAVE no .env do servidor. Formato do adaptador (a tradução da resposta do
 * serviço contratado fica em `traduzir` / `traduzirApontamento`):
 *   Pedido:   POST {URL}  { placa, renavam, uf }   (uf = RASTREADOR_MULTAS_UF, padrão SP; cabeçalho Authorization: Bearer {CHAVE})
 *   Resposta: { multas: [{ auto_infracao, orgao, codigo, descricao, gravidade, pontos, valor, data_hora, local, municipio, prazo_indicacao, vencimento }],
 *               apontamentos: [{ tipo, descricao, valor, situacao }] }
 */
const { agora, lerConfig } = require('../db');
const { ErroNegocio } = require('./erros');
const multas = require('./multas');
const { avisar } = require('./notificacoes');

const URL_SERVICO = () => process.env.RASTREADOR_MULTAS_URL || '';
const CHAVE = () => process.env.RASTREADOR_MULTAS_CHAVE || '';
const configurado = () => Boolean(URL_SERVICO() && CHAVE());
const POR_RODADA = 10; // veículos por minuto (o serviço cobra por consulta e tem limite de pedidos)
const intervaloDias = (db) => ([0, 1, 7, 15].includes(lerConfig(db).multas_consulta_dias) ? lerConfig(db).multas_consulta_dias : 0);
// Estado do DETRAN consultado (os veículos da operação são de SP).
const UF = () => (process.env.RASTREADOR_MULTAS_UF || 'SP').toUpperCase();
const intervaloMs = (db) => intervaloDias(db) * 24 * 3600_000;
const reaisParaCentavos = (x) => (x === undefined || x === null || x === '' ? null : Math.round(Number(String(x).replace(/\./g, '').replace(',', '.')) * 100));

function traduzir(x) {
  const valor = x.valor_centavos ?? reaisParaCentavos(typeof x.valor === 'number' ? String(x.valor).replace('.', ',') : x.valor);
  const grav = x.gravidade ? String(x.gravidade).normalize('NFD').replace(/[^a-z]/gi, '').toLowerCase() : null;
  return {
    auto_infracao: x.auto_infracao ?? x.auto ?? x.ait ?? null, orgao: x.orgao ?? x.orgao_autuador ?? null, infracao_codigo: x.codigo ?? x.infracao_codigo ?? null,
    descricao: x.descricao ?? x.infracao ?? 'Infração de trânsito', gravidade: ['leve', 'media', 'grave', 'gravissima'].includes(grav) ? grav : null,
    pontos: x.pontos ?? null, valor_centavos: Number.isFinite(valor) ? valor : null, ocorrida_em: x.data_hora ?? x.ocorrida_em, local_texto: x.local ?? null,
    municipio: x.municipio ?? null, prazo_indicacao: x.prazo_indicacao ?? null, vencimento: x.vencimento ?? null,
  };
}
const traduzirApontamento = (x) => {
  const valor = x.valor_centavos ?? reaisParaCentavos(typeof x.valor === 'number' ? String(x.valor).replace('.', ',') : x.valor);
  return { tipo: String(x.tipo ?? 'apontamento'), descricao: String(x.descricao ?? x.tipo ?? ''), valor_centavos: Number.isFinite(valor) ? valor : null, situacao: x.situacao ?? null };
};

/** Pergunta ao serviço contratado: devolve { multas, apontamentos } já traduzidos. */
async function perguntar(placa, renavam) {
  if (!configurado()) throw new ErroNegocio('A consulta de multas ainda não foi ligada: falta contratar o serviço de consulta (DETRAN/SENATRAN).', 422);
  let r;
  try {
    r = await fetch(URL_SERVICO(), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CHAVE()}` },
      body: JSON.stringify({ placa, renavam: renavam || undefined, uf: UF() }), signal: AbortSignal.timeout(25_000),
    });
  } catch (err) {
    throw new ErroNegocio(`O serviço de consulta de multas não respondeu (${err.name === 'TimeoutError' ? 'demorou demais' : 'sem conexão'}). Tente de novo.`, 502);
  }
  if (!r.ok) throw new ErroNegocio(`O serviço de consulta de multas recusou o pedido (${r.status}).`, 502);
  const j = await r.json().catch(() => ({}));
  return { multas: (j.multas ?? []).map(traduzir), apontamentos: (j.apontamentos ?? []).map(traduzirApontamento) };
}

/** Cadastra na central as multas que ainda não estão lá (pelo número do auto). Devolve cada multa com { na_central, nova }. */
function importar(db, empresaId, placa, lista, { avisarNovas = true } = {}) {
  let novas = 0;
  const resultado = lista.map((d) => {
    const auto = d.auto_infracao ? String(d.auto_infracao).trim() : null;
    if (auto && db.prepare('SELECT 1 FROM multas WHERE empresa_id = ? AND auto_infracao = ?').get(empresaId, auto)) return { ...d, na_central: true, nova: false };
    try {
      multas.criar(db, empresaId, { ...d, placa }, { fonte: 'consulta' });
      novas++;
      if (avisarNovas) avisar(db, empresaId, 'multas', { titulo: `Nova multa · ${placa}`, texto: `${d.descricao}${d.valor_centavos ? ` · R$ ${(d.valor_centavos / 100).toFixed(2).replace('.', ',')}` : ''}. Veja na Central de Multas.` });
      return { ...d, na_central: true, nova: true };
    } catch (err) {
      return { ...d, na_central: false, nova: false, erro: err.message };
    }
  });
  return { novas, resultado };
}

async function consultarVeiculo(db, veic) {
  const r = await perguntar(veic.placa, veic.renavam);
  const { novas } = importar(db, veic.empresa_id, veic.placa, r.multas);
  db.prepare('UPDATE veiculos SET multas_consulta_em = ? WHERE id = ?').run(agora(), veic.id);
  return novas;
}

/**
 * "Consultar multas" na hora: uma placa (da frota ou não). As multas de veículos da empresa entram na central; tudo fica
 * registrado no histórico de consultas.
 */
async function consultarPlaca(db, { empresaId = null, placa, renavam, usuarioId = null }) {
  const p = multas.placaLimpa(placa);
  if (!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(p)) throw new ErroNegocio('Informe uma placa válida (ex.: ABC1D23).', 422);
  const ren = String(renavam ?? '').replace(/\D/g, '') || null;
  const veic = empresaId ? db.prepare('SELECT id, empresa_id, renavam FROM veiculos WHERE empresa_id = ? AND placa = ?').get(empresaId, p)
    : db.prepare('SELECT id, empresa_id, renavam FROM veiculos WHERE placa = ? ORDER BY ativo DESC LIMIT 1').get(p);
  const reg = (dados) => db.prepare(`INSERT INTO multas_consultas (empresa_id, placa, renavam, usuario_id, multas, apontamentos, novas, resultado, erro, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(empresaId ?? veic?.empresa_id ?? null, p, ren ?? veic?.renavam ?? null, usuarioId, dados.multas ?? 0, dados.apontamentos ?? 0,
    dados.novas ?? 0, dados.resultado ? JSON.stringify(dados.resultado) : null, dados.erro ?? null, agora()).lastInsertRowid;
  let r;
  try {
    r = await perguntar(p, ren ?? veic?.renavam);
  } catch (err) {
    reg({ erro: err.message });
    throw err;
  }
  const imp = veic ? importar(db, veic.empresa_id, p, r.multas) : { novas: 0, resultado: r.multas.map((m) => ({ ...m, na_central: false, nova: false })) };
  if (veic) db.prepare('UPDATE veiculos SET multas_consulta_em = ? WHERE id = ?').run(agora(), veic.id);
  const resultado = { placa: p, veiculo_da_frota: Boolean(veic), multas: imp.resultado, apontamentos: r.apontamentos, novas: imp.novas, consultado_em: agora() };
  const id = reg({ multas: r.multas.length, apontamentos: r.apontamentos.length, novas: imp.novas, resultado });
  return { id: Number(id), ...resultado };
}

function historico(db, { empresaId = null, limite = 30 } = {}) {
  return db.prepare(`SELECT c.id, c.placa, c.multas, c.apontamentos, c.novas, c.erro, c.criado_em, u.nome AS usuario, e.nome AS empresa
    FROM multas_consultas c LEFT JOIN usuarios u ON u.id = c.usuario_id LEFT JOIN empresas e ON e.id = c.empresa_id
    ${empresaId ? 'WHERE c.empresa_id = ?' : ''} ORDER BY c.id DESC LIMIT ${Number(limite)}`).all(...(empresaId ? [empresaId] : []));
}
function consulta(db, id, { empresaId = null } = {}) {
  const c = db.prepare(`SELECT * FROM multas_consultas WHERE id = ? ${empresaId ? 'AND empresa_id = ?' : ''}`).get(...[Number(id), ...(empresaId ? [empresaId] : [])]);
  if (!c) throw new ErroNegocio('Consulta não encontrada.', 404);
  return { ...c, resultado: c.resultado ? JSON.parse(c.resultado) : null };
}

/** Rodada da manutenção: consulta os veículos ativos cuja última consulta passou do intervalo (semanal por padrão), poucos por vez. */
let rodando = false;
async function rodada(db, { empresaId = null, forcar = false } = {}) {
  // Manual (intervalo 0): só o "Consultar multas" e o "Consultar agora" (forcar) consultam.
  if (!configurado() || rodando || (!forcar && intervaloDias(db) === 0)) return { configurado: configurado(), consultados: 0, novas: 0 };
  rodando = true;
  try {
    const corte = forcar ? agora() : new Date(Date.now() - intervaloMs(db)).toISOString();
    const lista = db.prepare(`SELECT v.id, v.empresa_id, v.placa, v.renavam FROM veiculos v JOIN empresas e ON e.id = v.empresa_id
      WHERE v.ativo = 1 AND e.status = 'ativa' ${empresaId ? 'AND v.empresa_id = ?' : ''} AND (v.multas_consulta_em IS NULL OR v.multas_consulta_em < ?)
      ORDER BY v.multas_consulta_em LIMIT ?`).all(...[...(empresaId ? [empresaId] : []), corte, forcar ? 200 : POR_RODADA]);
    let novas = 0;
    for (const veic of lista) {
      try { novas += await consultarVeiculo(db, veic); } catch (err) { console.error(`[Rastreador] Consulta de multas (${veic.placa}): ${err.message}`); }
    }
    return { configurado: true, consultados: lista.length, novas };
  } finally {
    rodando = false;
  }
}

/** Situação da consulta automática para a tela: ligada? última rodada? veículos consultados hoje? */
function situacao(db, empresaId = null) {
  const onde = empresaId ? 'AND empresa_id = ?' : '';
  const p = empresaId ? [empresaId] : [];
  const tot = db.prepare(`SELECT COUNT(*) AS n, SUM(multas_consulta_em >= ?) AS em_dia, MAX(multas_consulta_em) AS ultima FROM veiculos WHERE ativo = 1 ${onde}`)
    .get(new Date(Date.now() - (intervaloMs(db) || 7 * 86_400_000)).toISOString(), ...p);
  return { ligada: configurado(), uf: UF(), intervalo_dias: intervaloDias(db), veiculos: tot.n, em_dia: tot.em_dia ?? 0, ultima: tot.ultima };
}

/** O master escolhe o intervalo da consulta automática: 1 (diária), 7 (semanal) ou 15 (quinzenal). */
function definirIntervalo(db, dias) {
  const d = Number(dias);
  if (![0, 1, 7, 15].includes(d)) throw new ErroNegocio('Escolha manual, diária, semanal ou quinzenal.', 422);
  db.prepare('INSERT INTO configuracoes (chave, valor) VALUES (?, ?) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor').run('multas_consulta_dias', String(d));
  return d;
}

module.exports = { definirIntervalo, configurado, rodada, traduzir, consultarPlaca, historico, consulta, situacao, importar };
