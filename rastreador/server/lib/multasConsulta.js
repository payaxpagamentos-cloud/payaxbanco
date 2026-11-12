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

// Fornecedor: "apibrasil" (API Brasil · Débitos V4) ou "generico" (o formato do adaptador abaixo, com RASTREADOR_MULTAS_URL).
const FORNECEDOR = () => (process.env.RASTREADOR_MULTAS_FORNECEDOR || (process.env.RASTREADOR_MULTAS_URL ? 'generico' : 'apibrasil')).toLowerCase();
const URL_SERVICO = () => process.env.RASTREADOR_MULTAS_URL || (FORNECEDOR() === 'apibrasil' ? 'https://gateway.apibrasil.io/api/v2/consulta/veiculos/credits' : '');
const CHAVE = () => process.env.RASTREADOR_MULTAS_CHAVE || '';
// Homologação da API Brasil: responde com dados de exemplo e não cobra (para testar a ligação).
const HOMOLOG = () => process.env.RASTREADOR_MULTAS_HOMOLOG === '1';
// API Brasil: versão assíncrona (recomendada por eles; evita o 504 quando o DETRAN demora). RASTREADOR_MULTAS_MODO=sync volta à síncrona.
const ASSINCRONA = () => FORNECEDOR() === 'apibrasil' && (process.env.RASTREADOR_MULTAS_MODO || 'async') !== 'sync';
const URL_ASYNC = () => process.env.RASTREADOR_MULTAS_URL_ASYNC || 'https://gateway.apibrasil.io/api/v2/consulta/vehicles/credits';
const espera = (ms) => new Promise((ok) => { setTimeout(ok, ms); });
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

/**
 * API Brasil (Débitos V4, tipo "debitos-v4"): data.debitosMultas.ocorrencia[] com dataHoraMulta, dataVencimento, descricao, fonte,
 * identificador, local, uf, valor; e totais de IPVA, licenciamento, DPVAT, outros e as restrições. O erro vem com HTTP 200 e error=true.
 */
function traduzirApiBrasil(j) {
  if (j?.error) throw new ErroNegocio(`API Brasil: ${j.message || 'a consulta falhou'}.`, 502);
  const d = j?.data ?? {};
  const listaMultas = d.debitosMultas?.ocorrencia ?? [];
  const hora = (x) => (x ? `${String(x).replace(' ', 'T')}${String(x).length <= 16 ? ':00' : ''}-03:00` : null);
  const multas = listaMultas.map((m) => ({
    auto_infracao: m.identificador ?? null, orgao: m.fonte ?? null, infracao_codigo: null, descricao: m.descricao || 'Infração de trânsito', gravidade: null, pontos: null,
    valor_centavos: Number.isFinite(Number(m.valor)) ? Math.round(Number(m.valor) * 100) : null, ocorrida_em: hora(m.dataHoraMulta), local_texto: m.local ?? null,
    municipio: m.uf ? `(${m.uf})` : null, prazo_indicacao: null, vencimento: m.dataVencimento ?? null,
  }));
  const apontamentos = [];
  const total = (blk, tipo, rot) => {
    const v = Number(blk?.totalDebito ?? 0);
    const itens = Array.isArray(blk?.ocorrencia) ? blk.ocorrencia : [];
    if (itens.length) for (const it of itens) apontamentos.push({ tipo, descricao: it.descricao ?? it.exercicio ?? rot, valor_centavos: Number.isFinite(Number(it.valor)) ? Math.round(Number(it.valor) * 100) : null, situacao: it.situacao ?? 'em aberto' });
    else if (v > 0) apontamentos.push({ tipo, descricao: rot, valor_centavos: Math.round(v * 100), situacao: 'em aberto' });
  };
  total(d.debitosIPVA, 'ipva', 'IPVA em aberto');
  total(d.debitosLicenciamento, 'licenciamento', 'Licenciamento em aberto');
  total(d.debitosDPVAT, 'dpvat', 'DPVAT em aberto');
  total(d.outrosDebitos, 'outros', 'Outros débitos');
  const restr = d.restricoes;
  if (Array.isArray(restr)) for (const r of restr) apontamentos.push({ tipo: 'restricao', descricao: typeof r === 'string' ? r : (r.descricao ?? r.tipo ?? JSON.stringify(r)), valor_centavos: null, situacao: r.situacao ?? 'ativa' });
  else if (restr && typeof restr === 'object') for (const [k, val] of Object.entries(restr)) if (val && val !== 'NADA CONSTA') apontamentos.push({ tipo: 'restricao', descricao: `${k}: ${typeof val === 'string' ? val : JSON.stringify(val)}`, valor_centavos: null, situacao: 'ativa' });
  return { multas, apontamentos, custo: j.valor_consulta ?? null, homolog: Boolean(j.homolog) };
}

/** Pergunta ao serviço contratado, tentando de novo (até 2 vezes) quando a fonte (DETRAN) está fora do ar ou demora (502/503/504). */
async function perguntar(placa, renavam, { tentativas = 3, espera: pausa = Number(process.env.RASTREADOR_MULTAS_ESPERA_MS) || 15_000, urlRetorno } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await perguntarUmaVez(placa, renavam, { urlRetorno });
    } catch (err) {
      if (!err.instavel || i >= tentativas) throw err;
      await espera(pausa);
    }
  }
}

async function perguntarUmaVez(placa, renavam, opcoes = {}) {
  if (ASSINCRONA()) return perguntarAssincrona(placa, opcoes);
  if (!configurado()) throw new ErroNegocio('A consulta de multas ainda não foi ligada: falta contratar o serviço de consulta (DETRAN/SENATRAN).', 422);
  let r;
  try {
    r = await fetch(URL_SERVICO(), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CHAVE()}` },
      body: JSON.stringify(FORNECEDOR() === 'apibrasil' ? { tipo: 'debitos-v4', placa, homolog: HOMOLOG() } : { placa, renavam: renavam || undefined, uf: UF() }),
      // A API Brasil busca no DETRAN, na prefeitura e no Renainf na hora: pode passar de 1 minuto (a tela espera em segundo plano).
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    throw new ErroNegocio(`O serviço de consulta de multas não respondeu (${err.name === 'TimeoutError' ? 'demorou demais' : 'sem conexão'}). Tente de novo.`, 502);
  }
  if (r.status === 402) throw new ErroNegocio('Sem saldo no serviço de consulta de multas: recarregue a conta (API Brasil → Recarregar).', 402);
  if (r.status === 401 || r.status === 403) throw new ErroNegocio('A chave do serviço de consulta de multas foi recusada: confira o token no .env do servidor.', 502);
  if ([502, 503, 504].includes(r.status)) {
    const e = new ErroNegocio('O DETRAN não respondeu agora (instabilidade na fonte). O sistema tentou 3 vezes; tente de novo em alguns minutos.', 502);
    e.instavel = true;
    throw e;
  }
  if (!r.ok) throw new ErroNegocio(`O serviço de consulta de multas recusou o pedido (${r.status}).`, 502);
  const j = await r.json().catch(() => ({}));
  if (FORNECEDOR() === 'apibrasil') return traduzirApiBrasil(j);
  return { multas: (j.multas ?? []).map(traduzir), apontamentos: (j.apontamentos ?? []).map(traduzirApontamento) };
}

/** Chamada à API Brasil com o tratamento dos erros comuns (saldo, chave, fonte fora do ar). */
async function postarApiBrasil(url, corpo, tempo = 60_000) {
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CHAVE()}` }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(tempo) });
  } catch (err) {
    const e = new ErroNegocio(`O serviço de consulta de multas não respondeu (${err.name === 'TimeoutError' ? 'demorou demais' : 'sem conexão'}).`, 502);
    e.instavel = true;
    throw e;
  }
  if (r.status === 402) throw new ErroNegocio('Sem saldo no serviço de consulta de multas: recarregue a conta (API Brasil → Recarregar).', 402);
  if (r.status === 401 || r.status === 403) throw new ErroNegocio('A chave do serviço de consulta de multas foi recusada: confira o token no .env do servidor.', 502);
  if ([502, 503, 504].includes(r.status)) {
    const e = new ErroNegocio('O DETRAN não respondeu agora (instabilidade na fonte). O sistema tentou 3 vezes; tente de novo em alguns minutos.', 502);
    e.instavel = true;
    throw e;
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.error === true) throw new ErroNegocio(`API Brasil: ${j?.message || `pedido recusado (${r.status})`}.`, 502);
  return j;
}

/**
 * API Brasil assíncrona (tipo "debitos-v4-async"): o pedido devolve um job-id; o resultado é buscado de graça com "consulta-chave"
 * até ficar pronto (a cobrança de R$ 8 só acontece quando a consulta conclui). O aviso por webhook não é necessário: a URL de
 * retorno aponta para este servidor, que só confirma o recebimento (o resultado vem sempre da busca autenticada pelo job-id).
 */
async function perguntarAssincrona(placa, { urlRetorno } = {}) {
  if (!configurado()) throw new ErroNegocio('A consulta de multas ainda não foi ligada: falta contratar o serviço de consulta (DETRAN/SENATRAN).', 422);
  const homolog = HOMOLOG();
  const ini = await postarApiBrasil(URL_ASYNC(), { tipo: 'debitos-v4-async', placa, webhook_url: urlRetorno || 'https://127.0.0.1/sem-retorno', homolog });
  const job = ini?.data?.['job-id'] ?? ini?.['job-id'];
  if (!job) throw new ErroNegocio(`API Brasil: ${ini?.data?.msg || ini?.message || 'a consulta não foi aceita'}.`, 502);
  const intervalo = Number(process.env.RASTREADOR_MULTAS_INTERVALO_MS) || 5000;
  const limite = Date.now() + (Number(process.env.RASTREADOR_MULTAS_LIMITE_MS) || 5 * 60_000);
  let ultima = null;
  while (Date.now() < limite) {
    await espera(intervalo);
    let j;
    try { j = await postarApiBrasil(URL_ASYNC(), { tipo: 'consulta-chave', 'job-id': job, homolog }, 30_000); } catch (err) { if (err.instavel) continue; throw err; }
    // Formatos aceitos: data.{job_status|status, payload} (documentado), ou o mesmo no topo, ou data.data / resultado.
    const d = j?.data?.payload || j?.data?.job_status || j?.data?.status ? j.data : (j?.payload || j?.job_status || j?.status ? j : (j?.data?.data ?? j?.data ?? {}));
    const st = String(d.job_status ?? d.status ?? '').toLowerCase();
    ultima = { status: st || null, chaves: Object.keys(j ?? {}), chaves_data: j?.data && typeof j.data === 'object' ? Object.keys(j.data) : null, msg: d.msg ?? j?.message ?? null };
    if (['completed', 'concluido', 'concluída', 'concluida', 'done', 'success', 'finished'].includes(st) || d.payload || d.resultado || d.dadosDoVeiculo) {
      if (d.dadosDoVeiculo) return traduzirApiBrasil({ error: false, homolog, data: d });
      const p = d.payload ?? d.resultado ?? {};
      if (p.success === false) throw new ErroNegocio(`API Brasil: ${p.msg || 'a consulta não foi concluída'}.`, 502);
      const dados = Array.isArray(p.dados) ? p.dados[0] : p.dados;
      return traduzirApiBrasil({ error: false, homolog, valor_consulta: j.valor_consulta ?? null, data: dados ?? {} });
    }
    if (['failed', 'error', 'erro', 'falhou', 'cancelled', 'canceled'].includes(st)) throw new ErroNegocio(`API Brasil: ${d.msg || d.payload?.msg || 'a consulta falhou'}.`, 502);
  }
  console.error('[Rastreador] Consulta de multas (API Brasil) sem conclusão em 5 min. Última resposta:', JSON.stringify(ultima));
  throw new ErroNegocio(`O DETRAN passou de 5 minutos sem responder (última situação na API Brasil: ${ultima?.status || ultima?.msg || 'sem resposta'}). Tente de novo mais tarde.`, 504);
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
  if (r.homolog) return 0;
  const { novas } = importar(db, veic.empresa_id, veic.placa, r.multas);
  db.prepare('UPDATE veiculos SET multas_consulta_em = ? WHERE id = ?').run(agora(), veic.id);
  return novas;
}

/**
 * "Consultar multas" na hora: uma placa (da frota ou não). As multas de veículos da empresa entram na central; tudo fica
 * registrado no histórico de consultas.
 */
// Consultas rodando agora (id → promessa), para o clique duplo não pagar duas vezes.
const emAndamento = new Map();

function iniciarConsulta(db, { empresaId = null, placa, renavam, usuarioId = null, urlRetorno = null }) {
  const p = multas.placaLimpa(placa);
  if (!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(p)) throw new ErroNegocio('Informe uma placa válida (ex.: ABC1D23).', 422);
  if (!configurado()) throw new ErroNegocio('A consulta de multas ainda não foi ligada: falta contratar o serviço de consulta (DETRAN/SENATRAN).', 422);
  const ren = String(renavam ?? '').replace(/\D/g, '') || null;
  const veic = empresaId ? db.prepare('SELECT id, empresa_id, renavam FROM veiculos WHERE empresa_id = ? AND placa = ?').get(empresaId, p)
    : db.prepare('SELECT id, empresa_id, renavam FROM veiculos WHERE placa = ? ORDER BY ativo DESC LIMIT 1').get(p);
  // A mesma placa já está sendo consultada (clique duplo, outra aba): acompanha aquela, sem pagar de novo.
  const andamento = db.prepare("SELECT id FROM multas_consultas WHERE placa = ? AND status = 'consultando' AND criado_em > ?").get(p, new Date(Date.now() - 4 * 60_000).toISOString());
  if (andamento) return { id: andamento.id, status: 'consultando', placa: p, pronto: emAndamento.get(andamento.id) ?? Promise.resolve() };
  const id = Number(db.prepare(`INSERT INTO multas_consultas (empresa_id, placa, renavam, usuario_id, status, criado_em) VALUES (?, ?, ?, ?, 'consultando', ?)`)
    .run(empresaId ?? veic?.empresa_id ?? null, p, ren ?? veic?.renavam ?? null, usuarioId, agora()).lastInsertRowid);
  const fim = (campos) => db.prepare(`UPDATE multas_consultas SET status = ?, multas = ?, apontamentos = ?, novas = ?, resultado = ?, erro = ? WHERE id = ?`)
    .run(campos.erro ? 'erro' : 'ok', campos.multas ?? 0, campos.apontamentos ?? 0, campos.novas ?? 0, campos.resultado ? JSON.stringify(campos.resultado) : null, campos.erro ?? null, id);
  // Roda em segundo plano: a resposta do serviço pode demorar; a tela acompanha pelo id. O resultado é guardado mesmo se chegar tarde.
  const pronto = perguntar(p, ren ?? veic?.renavam, { urlRetorno }).then((r) => {
    // Em teste (homologação) os dados são de exemplo: nunca entram na central.
    const imp = veic && !r.homolog ? importar(db, veic.empresa_id, p, r.multas) : { novas: 0, resultado: r.multas.map((m) => ({ ...m, na_central: false, nova: false })) };
    if (veic) db.prepare('UPDATE veiculos SET multas_consulta_em = ? WHERE id = ?').run(agora(), veic.id);
    const resultado = { placa: p, veiculo_da_frota: Boolean(veic), multas: imp.resultado, apontamentos: r.apontamentos, novas: imp.novas, consultado_em: agora(), custo: r.custo ?? null, homolog: r.homolog ?? false };
    fim({ multas: r.multas.length, apontamentos: r.apontamentos.length, novas: imp.novas, resultado });
  }).catch((err) => { fim({ erro: err.message }); }).finally(() => emAndamento.delete(id));
  emAndamento.set(id, pronto);
  return { id, status: 'consultando', placa: p, pronto };
}

/** Consulta e espera o resultado (usado nos testes e pela rotina interna). */
async function consultarPlaca(db, args) {
  const { id, pronto } = iniciarConsulta(db, args);
  await pronto;
  const c = consulta(db, id);
  if (c.status === 'erro') throw new ErroNegocio(c.erro, 502);
  return { id, ...c.resultado };
}

function historico(db, { empresaId = null, limite = 30 } = {}) {
  return db.prepare(`SELECT c.id, c.placa, c.multas, c.apontamentos, c.novas, c.erro, c.status, c.criado_em, u.nome AS usuario, e.nome AS empresa
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
  return { ligada: configurado(), fornecedor: FORNECEDOR(), homolog: HOMOLOG(), uf: UF(), intervalo_dias: intervaloDias(db), veiculos: tot.n, em_dia: tot.em_dia ?? 0, ultima: tot.ultima };
}

/** O master escolhe o intervalo da consulta automática: 1 (diária), 7 (semanal) ou 15 (quinzenal). */
function definirIntervalo(db, dias) {
  const d = Number(dias);
  if (![0, 1, 7, 15].includes(d)) throw new ErroNegocio('Escolha manual, diária, semanal ou quinzenal.', 422);
  db.prepare('INSERT INTO configuracoes (chave, valor) VALUES (?, ?) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor').run('multas_consulta_dias', String(d));
  return d;
}

module.exports = { iniciarConsulta, traduzirApiBrasil, definirIntervalo, configurado, rodada, traduzir, consultarPlaca, historico, consulta, situacao, importar };
