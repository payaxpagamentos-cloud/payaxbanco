'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

/**
 * Consulta automática de multas (DETRAN/SENATRAN) por um serviço contratado. Pronta para ligar: com o endereço e a chave no
 * .env do servidor (RASTREADOR_MULTAS_URL e RASTREADOR_MULTAS_CHAVE), o sistema consulta cada veículo uma vez por dia e cadastra
 * as multas novas. O formato abaixo é o do adaptador; ao contratar o serviço, a tradução da resposta dele fica em `traduzir`.
 *   Pedido:  POST {URL}  { placa, renavam }   (cabeçalho Authorization: Bearer {CHAVE})
 *   Resposta: { multas: [{ auto_infracao, orgao, codigo, descricao, gravidade, pontos, valor, data_hora, local, municipio, prazo_indicacao, vencimento }] }
 */
const { agora } = require('../db');
const multas = require('./multas');
const { avisar } = require('./notificacoes');

const URL_SERVICO = process.env.RASTREADOR_MULTAS_URL || '';
const CHAVE = process.env.RASTREADOR_MULTAS_CHAVE || '';
const configurado = () => Boolean(URL_SERVICO && CHAVE);
const POR_RODADA = 10; // veículos por minuto (o serviço cobra por consulta e tem limite de pedidos)
const INTERVALO_MS = 24 * 3600_000;

function traduzir(x) {
  const valor = x.valor_centavos ?? (x.valor !== undefined && x.valor !== null ? Math.round(Number(String(x.valor).replace(',', '.')) * 100) : null);
  return {
    auto_infracao: x.auto_infracao ?? x.auto ?? x.ait, orgao: x.orgao ?? x.orgao_autuador, infracao_codigo: x.codigo ?? x.infracao_codigo,
    descricao: x.descricao ?? x.infracao ?? 'Infração de trânsito', gravidade: x.gravidade ? String(x.gravidade).normalize('NFD').replace(/[^a-z]/gi, '').toLowerCase() : null,
    pontos: x.pontos, valor_centavos: Number.isFinite(valor) ? valor : null, ocorrida_em: x.data_hora ?? x.ocorrida_em, local_texto: x.local, municipio: x.municipio,
    prazo_indicacao: x.prazo_indicacao, vencimento: x.vencimento,
  };
}

async function consultarVeiculo(db, veic) {
  const r = await fetch(URL_SERVICO, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CHAVE}` },
    body: JSON.stringify({ placa: veic.placa, renavam: veic.renavam || undefined }), signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`serviço de multas respondeu ${r.status}`);
  const lista = (await r.json())?.multas ?? [];
  let novas = 0;
  for (const item of lista) {
    const d = { ...traduzir(item), placa: veic.placa };
    if (!['leve', 'media', 'grave', 'gravissima'].includes(d.gravidade)) d.gravidade = null;
    if (d.auto_infracao && db.prepare('SELECT 1 FROM multas WHERE empresa_id = ? AND auto_infracao = ?').get(veic.empresa_id, String(d.auto_infracao).trim())) continue;
    try {
      multas.criar(db, veic.empresa_id, d, { fonte: 'consulta' });
      novas++;
      avisar(db, veic.empresa_id, 'multas', { titulo: `Nova multa · ${veic.placa}`, texto: `${d.descricao}${d.valor_centavos ? ` · R$ ${(d.valor_centavos / 100).toFixed(2).replace('.', ',')}` : ''}. Veja na Central de Multas.` });
    } catch (err) {
      console.error(`[Rastreador] Multa de ${veic.placa} não cadastrada: ${err.message}`);
    }
  }
  db.prepare('UPDATE veiculos SET multas_consulta_em = ? WHERE id = ?').run(agora(), veic.id);
  return novas;
}

/** Rodada da manutenção: consulta os veículos ativos que não foram consultados nas últimas 24 h (poucos por vez). */
let rodando = false;
async function rodada(db, { empresaId = null, forcar = false } = {}) {
  if (!configurado() || rodando) return { configurado: configurado(), consultados: 0, novas: 0 };
  rodando = true;
  try {
    const corte = forcar ? agora() : new Date(Date.now() - INTERVALO_MS).toISOString();
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

module.exports = { configurado, rodada, traduzir };
