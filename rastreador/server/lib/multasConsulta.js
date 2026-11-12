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
  // "2026-09-23 10:45" → com hora; "2026-09-23" (sem hora) → meio-dia de Brasília, marcado como sem_hora (a tela mostra só a data).
  // Com fuso (ex.: "2026-09-23T03:00:00.000Z") vale o instante informado; sem fuso, é hora de Brasília.
  const comFuso = (t) => /(Z|[+-]\d{2}:?\d{2})$/i.test(t);
  const hora = (x) => {
    const t = String(x ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return `${t}T12:00:00-03:00`;
    if (comFuso(t) && Number.isFinite(Date.parse(t))) {
      const d = new Date(t);
      // Meia-noite de Brasília = o DETRAN só informou o dia: grava ao meio-dia (a tela mostra só a data).
      return d.getUTCHours() === 3 && d.getUTCMinutes() === 0 ? `${new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 10)}T12:00:00-03:00` : d.toISOString();
    }
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?/.exec(t);
    return m ? `${m[1]}T${m[2]}${m[3] ?? ':00'}-03:00` : null;
  };
  const semHora = (x) => {
    const t = String(x ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return true;
    if (comFuso(t) && Number.isFinite(Date.parse(t))) { const d = new Date(t); return d.getUTCHours() === 3 && d.getUTCMinutes() === 0; }
    return /^\d{4}-\d{2}-\d{2}[ T]00:00(:00)?$/.test(t);
  };
  // "Multa - 7RA1502937 - TRANSITAR ..." → "TRANSITAR ..." (o número já vai no auto de infração).
  const limparDescricao = (d, id) => String(d ?? '').replace(new RegExp(`^\\s*multa\\s*-\\s*${String(id ?? '').replace(/[^\w]/g, '')}\\s*-\\s*`, 'i'), '').replace(/^\s*multa\s*-\s*/i, '').trim();
  const multas = listaMultas.map((m) => ({
    auto_infracao: m.identificador ?? null, orgao: m.fonte ?? null, infracao_codigo: null, descricao: limparDescricao(m.descricao, m.identificador) || 'Infração de trânsito', gravidade: null, pontos: null, sem_hora: semHora(m.dataHoraMulta),
    linha_digitavel: m.linhaDigitavel && m.linhaDigitavel !== 'null' ? String(m.linhaDigitavel) : null,
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
  // PDF da consulta (quando a API Brasil gera): link https direto, aberto numa aba nova.
  const pdf = typeof d.pdf === 'string' && /^https:\/\//i.test(d.pdf) ? d.pdf : null;
  return { multas, apontamentos, pdf, custo: j.valor_consulta ?? null, homolog: Boolean(j.homolog) };
}

/** Pergunta ao serviço contratado, tentando de novo (até 2 vezes) quando a fonte (DETRAN) está fora do ar ou demora (502/503/504). */
async function perguntar(placa, renavam, { tentativas = 3, espera: pausa = Number(process.env.RASTREADOR_MULTAS_ESPERA_MS) || 15_000, urlRetorno, tipo } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await perguntarUmaVez(placa, renavam, { urlRetorno, tipo });
    } catch (err) {
      if (!err.instavel || i >= tentativas) throw err;
      await espera(pausa);
    }
  }
}

/**
 * Consulta rápida: API Brasil "Multas (Renainf)" (tipo "renainf", R$ 3,45): só as multas do Renainf (sem IPVA/licenciamento).
 * O formato da resposta não está na documentação: a leitura procura a lista de infrações em qualquer lugar da resposta.
 */
function lerRenainf(j) {
  if (j?.error) throw new ErroNegocio(`API Brasil: ${j.message || 'a consulta falhou'}.`, 502);
  const achar = (o, prof = 0) => {
    if (!o || typeof o !== 'object' || prof > 6) return null;
    if (Array.isArray(o)) return o.length && o.every((x) => x && typeof x === 'object' && !Array.isArray(x)) && o.some((x) => Object.keys(x).some((k) => /infra|descri|auto|ait|valor/i.test(k))) ? o : null;
    for (const v of Object.values(o)) { const a = achar(v, prof + 1); if (a) return a; }
    return null;
  };
  const lista = achar(j?.data ?? j) ?? [];
  const campo = (x, re) => { const k = Object.keys(x).find((c) => re.test(c)); return k ? x[k] : null; };
  const reais = (v) => { if (v === null || v === undefined || v === '') return null; const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 100) : null; };
  const quando = (v) => { const t = String(v ?? '').trim(); const br = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}:\d{2}))?/.exec(t); if (br) return { em: `${br[3]}-${br[2]}-${br[1]}T${br[4] ?? '12:00'}:00-03:00`, sem: !br[4] }; const iso = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(t); return iso ? { em: `${iso[1]}T${iso[2] ?? '12:00'}:00-03:00`, sem: !iso[2] } : { em: null, sem: false }; };
  const multas = lista.map((x) => {
    const q = quando(campo(x, /^data.?hora|datahora|data.?infra|^data$|data_?ocorr/i));
    return { auto_infracao: campo(x, /auto|ait|identificador|^numero/i), orgao: campo(x, /orgao|autuador|fonte/i), infracao_codigo: campo(x, /^cod/i),
      descricao: String(campo(x, /descri|infra(cao|ção)?$/i) ?? 'Infração de trânsito'), gravidade: null, pontos: null, valor_centavos: reais(campo(x, /valor/i)),
      ocorrida_em: q.em, sem_hora: q.sem, local_texto: campo(x, /local|endere/i), municipio: campo(x, /munic/i), prazo_indicacao: null, vencimento: null };
  });
  return { multas, apontamentos: [], pdf: null, custo: j?.valor_consulta ?? null, homolog: Boolean(j?.homolog),
    estrutura: { chaves: Object.keys(j ?? {}), chaves_data: j?.data && typeof j.data === 'object' ? Object.keys(j.data) : null, campos_item: lista[0] ? Object.keys(lista[0]) : null } };
}

/** Consulta simples: API Brasil "Débitos Resumidos" (tipo "consulta-debitos", R$ 3,78): só se tem débito e os totais, sem a lista. */
function lerResumida(j) {
  if (j?.error) throw new ErroNegocio(`API Brasil: ${j.message || 'a consulta falhou'}.`, 502);
  const d = j?.data && typeof j.data === 'object' ? j.data : {};
  const apontamentos = [];
  const visitar = (o, prefixo = '', prof = 0) => {
    if (!o || typeof o !== 'object' || prof > 3) return;
    for (const [k, v] of Object.entries(o)) {
      const nome = prefixo ? `${prefixo} › ${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) visitar(v, nome, prof + 1);
      else if (!Array.isArray(v) && v !== null && v !== '' && /debit|valor|total|multa|ipva|licenc|dpvat|possui/i.test(k)) {
        const num = typeof v === 'number' ? v : (/^[\d.,]+$/.test(String(v)) ? Number(String(v).replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')) : NaN);
        apontamentos.push({ tipo: 'resumo', descricao: `${nome.replace(/_/g, ' ')}${typeof v === 'boolean' ? `: ${v ? 'sim' : 'não'}` : Number.isFinite(num) ? '' : `: ${v}`}`,
          valor_centavos: typeof v !== 'boolean' && Number.isFinite(num) && /valor|total|debit/i.test(k) ? Math.round(num * 100) : null, situacao: null });
      }
    }
  };
  visitar(d);
  return { multas: [], apontamentos, pdf: null, custo: j?.valor_consulta ?? null, homolog: Boolean(j?.homolog), resumida: true,
    estrutura: { chaves: Object.keys(j ?? {}), chaves_data: Object.keys(d) } };
}

async function perguntarUmaVez(placa, renavam, opcoes = {}) {
  if (opcoes.tipo === 'resumida' && FORNECEDOR() === 'apibrasil') {
    if (!configurado()) throw new ErroNegocio('A consulta de multas ainda não foi ligada: falta contratar o serviço de consulta (DETRAN/SENATRAN).', 422);
    return lerResumida(await postarApiBrasil('https://gateway.apibrasil.io/api/v2/consulta/veiculos/credits', { tipo: 'consulta-debitos', placa, homolog: HOMOLOG() }, 120_000));
  }
  if (opcoes.tipo === 'renainf' && FORNECEDOR() === 'apibrasil') {
    if (!configurado()) throw new ErroNegocio('A consulta de multas ainda não foi ligada: falta contratar o serviço de consulta (DETRAN/SENATRAN).', 422);
    return lerRenainf(await postarApiBrasil('https://gateway.apibrasil.io/api/v2/consulta/veiculos/credits', { tipo: 'renainf', placa, homolog: HOMOLOG() }, 120_000));
  }
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
  const intervalo = Number(process.env.RASTREADOR_MULTAS_INTERVALO_MS) || 2000; // a busca do resultado é gratuita: confere de 2 em 2 s
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

function iniciarConsulta(db, { empresaId = null, placa, renavam, usuarioId = null, urlRetorno = null, forcar = false, tipo = 'completa' }) {
  tipo = ['renainf', 'resumida'].includes(tipo) ? tipo : 'completa';
  const p = multas.placaLimpa(placa);
  if (!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(p)) throw new ErroNegocio('Informe uma placa válida (ex.: ABC1D23).', 422);
  if (!configurado()) throw new ErroNegocio('A consulta de multas ainda não foi ligada: falta contratar o serviço de consulta (DETRAN/SENATRAN).', 422);
  const ren = String(renavam ?? '').replace(/\D/g, '') || null;
  const veic = empresaId ? db.prepare('SELECT id, empresa_id, renavam FROM veiculos WHERE empresa_id = ? AND placa = ?').get(empresaId, p)
    : db.prepare('SELECT id, empresa_id, renavam FROM veiculos WHERE placa = ? ORDER BY ativo DESC LIMIT 1').get(p);
  // A mesma placa já está sendo consultada (clique duplo, outra aba): acompanha aquela, sem pagar de novo.
  const andamento = db.prepare("SELECT id FROM multas_consultas WHERE placa = ? AND status = 'consultando' AND criado_em > ?").get(p, new Date(Date.now() - 4 * 60_000).toISOString());
  if (andamento) return { id: andamento.id, status: 'consultando', placa: p, pronto: emAndamento.get(andamento.id) ?? Promise.resolve() };
  // Consultada com sucesso nas últimas 24 h: devolve na hora o resultado guardado (sem esperar o DETRAN e sem pagar de novo).
  if (!forcar) {
    const recente = db.prepare(`SELECT id, criado_em FROM multas_consultas WHERE placa = ? AND status = 'ok' AND erro IS NULL AND resultado NOT LIKE '%"homolog":true%'
      AND (resultado LIKE '%"tipo":"${tipo}"%' ${tipo === 'completa' ? "OR resultado NOT LIKE '%\"tipo\":%'" : ''})
      AND criado_em > ? ${empresaId ? 'AND empresa_id = ?' : ''} ORDER BY id DESC LIMIT 1`).get(...[p, new Date(Date.now() - 24 * 3600_000).toISOString(), ...(empresaId ? [empresaId] : [])]);
    if (recente) return { id: recente.id, status: 'ok', placa: p, guardada: true, consultado_em: recente.criado_em, pronto: Promise.resolve() };
  }
  const id = Number(db.prepare(`INSERT INTO multas_consultas (empresa_id, placa, renavam, usuario_id, status, criado_em) VALUES (?, ?, ?, ?, 'consultando', ?)`)
    .run(empresaId ?? veic?.empresa_id ?? null, p, ren ?? veic?.renavam ?? null, usuarioId, agora()).lastInsertRowid);
  const fim = (campos) => db.prepare(`UPDATE multas_consultas SET status = ?, multas = ?, apontamentos = ?, novas = ?, resultado = ?, erro = ? WHERE id = ?`)
    .run(campos.erro ? 'erro' : 'ok', campos.multas ?? 0, campos.apontamentos ?? 0, campos.novas ?? 0, campos.resultado ? JSON.stringify(campos.resultado) : null, campos.erro ?? null, id);
  // Roda em segundo plano: a resposta do serviço pode demorar; a tela acompanha pelo id. O resultado é guardado mesmo se chegar tarde.
  const inicio = Date.now();
  const pronto = perguntar(p, ren ?? veic?.renavam, { urlRetorno, tipo }).then((r) => {
    // Em teste (homologação) os dados são de exemplo: nunca entram na central.
    const imp = veic && !r.homolog ? importar(db, veic.empresa_id, p, r.multas) : { novas: 0, resultado: r.multas.map((m) => ({ ...m, na_central: false, nova: false })) };
    if (veic) db.prepare('UPDATE veiculos SET multas_consulta_em = ? WHERE id = ?').run(agora(), veic.id);
    const resultado = { placa: p, veiculo_da_frota: Boolean(veic), multas: imp.resultado, apontamentos: r.apontamentos, novas: imp.novas, consultado_em: agora(), custo: r.custo ?? null, homolog: r.homolog ?? false, pdf: r.pdf ?? null,
      tipo, resumida: r.resumida ?? false, duracao_s: Math.round((Date.now() - inicio) / 1000), estrutura: r.estrutura ?? undefined };
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

/** Apaga do histórico as consultas com erro e as de teste (homologação); ficam só as que deram certo. */
function limparHistorico(db, { empresaId = null } = {}) {
  return db.prepare(`DELETE FROM multas_consultas WHERE status <> 'consultando' AND (erro IS NOT NULL OR status = 'erro' OR resultado LIKE '%"homolog":true%')
    ${empresaId ? 'AND empresa_id = ?' : ''}`).run(...(empresaId ? [empresaId] : [])).changes;
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

module.exports = { lerResumida, lerRenainf, limparHistorico, iniciarConsulta, traduzirApiBrasil, definirIntervalo, configurado, rodada, traduzir, consultarPlaca, historico, consulta, situacao, importar };
