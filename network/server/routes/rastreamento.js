'use strict';

const { Router } = require('express');
const { agora } = require('../db');
const { exigir } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const base = require('../conectores/base');
const rastreador = require('../conectores/rastreador');
const v = require('../lib/validacao');

/** Distância em linha reta (m). Não é estimativa de chegada: rota viária e trânsito dependem de fonte contratada. */
function distancia(a, b) {
  const r = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * r * Math.asin(Math.sqrt(h)));
}

module.exports = (db) => {
  const r = Router();
  const org = (req) => db.prepare('SELECT * FROM organizacoes WHERE id = ?').get(req.org);

  /**
   * Veículos com a última posição recebida: idade da posição, e "desatualizada" quando passa do limite.
   * Parado ≠ sem comunicação; ignição ausente fica "desconhecida" (nunca "desligada").
   */
  function veiculosMapa(req) {
    const o = org(req);
    const lista = db.prepare(`SELECT v.id, v.placa, v.modelo, v.identificacao, v.status_base, l.dispositivo_id, p.lat, p.lng, p.velocidade_kmh, p.ignicao, p.odometro_km,
      p.observado_em, p.recebido_em, t.nome AS responsavel
      FROM veiculos v LEFT JOIN dispositivos_vinculos l ON l.veiculo_id = v.id AND l.fim IS NULL LEFT JOIN posicao_atual pa ON pa.veiculo_id = v.id
      LEFT JOIN posicoes p ON p.id = pa.posicao_id LEFT JOIN veiculo_responsaveis vr ON vr.veiculo_id = v.id AND vr.fim IS NULL LEFT JOIN tecnicos t ON t.id = vr.tecnico_id
      WHERE v.organizacao_id = ? AND v.status_base <> 'inativo' ORDER BY v.placa`).all(req.org);
    return lista.map((x) => {
      const idadeS = x.observado_em ? Math.round((Date.now() - Date.parse(x.observado_em)) / 1000) : null;
      let situacao = 'sem_dispositivo';
      if (x.dispositivo_id) situacao = !x.observado_em ? 'sem_posicao' : idadeS > o.desatualizado_min * 60 ? 'desatualizada'
        : x.velocidade_kmh === null ? 'atualizada' : x.velocidade_kmh >= 3 ? 'em_movimento' : 'parado';
      return { ...x, idade_s: idadeS, situacao, ignicao: x.ignicao === null ? 'desconhecida' : x.ignicao ? 'ligada' : 'desligada' };
    });
  }

  r.get('/mapa', exigir('rastreamento.ver'), (req, res) => {
    const o = org(req);
    const x = base.ler(db, req.org, 'rastreador');
    res.json({ gerado_em: agora(), limite_desatualizado_min: o.desatualizado_min, conexao: {
      estado: base.estadoAtual(x, o.desatualizado_min, rastreador.intervalo(x?.config ?? {})), ultimo_sucesso: x?.ultimo_sucesso ?? null, ultimo_erro: x?.ultimo_erro ?? null,
      fonte: 'Rastreador de Veículos (API de integração)' }, veiculos: veiculosMapa(req) });
  });

  /** Trajeto no período (até 7 dias), consultado na fonte pelo backend. */
  r.get('/veiculos/:id/trajeto', exigir('rastreamento.ver'), async (req, res, next) => {
    try {
      const vei = db.prepare('SELECT id FROM veiculos WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
      if (!vei) throw new ErroNegocio('Veículo não encontrado.', 404);
      const ate = req.query.ate ? v.instante(req.query.ate, 'o fim') : agora();
      const de = req.query.de ? v.instante(req.query.de, 'o início') : new Date(Date.parse(ate) - 24 * 3600_000).toISOString();
      v.exigir(de < ate && Date.parse(ate) - Date.parse(de) <= 7 * 86400_000, 'Período de até 7 dias.');
      try {
        res.json({ de, ate, fonte: 'rastreador', pontos: await rastreador.trajeto(db, req.org, vei.id, de, ate) });
      } catch (err) {
        if (!(err instanceof base.ErroConector)) throw err;
        // Sem a fonte, mostra o que já foi coletado, deixando claro que veio do armazenamento local.
        const locais = db.prepare('SELECT lat, lng, velocidade_kmh, ignicao, observado_em FROM posicoes WHERE veiculo_id = ? AND observado_em >= ? AND observado_em < ? ORDER BY observado_em LIMIT 20000')
          .all(vei.id, de, ate).map((p) => ({ ...p, ignicao: p.ignicao === null ? null : Boolean(p.ignicao) }));
        res.json({ de, ate, fonte: 'armazenamento_local', aviso: `Fonte indisponível (${err.message}). Exibindo as posições já coletadas.`, estado: err.estado, pontos: locais });
      }
    } catch (err) { next(err); }
  });

  /** Chamados abertos com coordenadas, por distância em linha reta da última posição do veículo (não é ETA). */
  r.get('/veiculos/:id/chamados-proximos', exigir('rastreamento.ver'), (req, res) => {
    const vm = veiculosMapa(req).find((x) => x.id === Number(req.params.id));
    if (!vm) throw new ErroNegocio('Veículo não encontrado.', 404);
    if (vm.lat === null) return res.json({ aviso: 'Veículo sem posição.', chamados: [] });
    const lista = db.prepare(`SELECT id, numero, titulo, prioridade, status, bairro, lat, lng FROM chamados WHERE organizacao_id = ? AND lat IS NOT NULL
      AND status IN ('aberto','atribuido','retornado')`).all(req.org).map((c) => ({ ...c, distancia_linha_reta_m: distancia(vm, c) }))
      .sort((a, b) => a.distancia_linha_reta_m - b.distancia_linha_reta_m).slice(0, 10);
    res.json({ posicao_em: vm.observado_em, situacao: vm.situacao, chamados: lista, observacao: 'Distância em linha reta, não é tempo estimado de chegada.' });
  });

  // ---------------- Vínculos dispositivo ↔ veículo ----------------
  r.get('/dispositivos', exigir('rastreamento.ver'), (req, res) => {
    res.json(db.prepare(`SELECT d.*, l.id AS vinculo_id, l.veiculo_id, l.inicio AS vinculado_em, v.placa AS veiculo_placa,
      (SELECT s.id FROM veiculos s WHERE s.organizacao_id = d.organizacao_id AND s.placa = d.placa AND l.id IS NULL
        AND NOT EXISTS (SELECT 1 FROM dispositivos_vinculos x WHERE x.veiculo_id = s.id AND x.fim IS NULL)) AS sugestao_veiculo_id
      FROM dispositivos_externos d LEFT JOIN dispositivos_vinculos l ON l.organizacao_id = d.organizacao_id AND l.fonte = d.fonte AND l.dispositivo_id = d.dispositivo_id AND l.fim IS NULL
      LEFT JOIN veiculos v ON v.id = l.veiculo_id WHERE d.organizacao_id = ? ORDER BY d.placa`).all(req.org));
  });

  r.post('/vinculos', exigir('rastreamento.vincular'), (req, res) => {
    const dispositivo = v.texto(req.body?.dispositivo_id, 'o dispositivo', 60);
    const vei = db.prepare('SELECT id, placa FROM veiculos WHERE id = ? AND organizacao_id = ?').get(Number(req.body?.veiculo_id), req.org);
    if (!vei) throw new ErroNegocio('Veículo não encontrado.', 422);
    if (db.prepare("SELECT 1 FROM dispositivos_vinculos WHERE organizacao_id = ? AND fonte = 'rastreador' AND dispositivo_id = ? AND fim IS NULL").get(req.org, dispositivo)) {
      throw new ErroNegocio('Este dispositivo já está vinculado. Encerre o vínculo atual antes.', 409);
    }
    if (db.prepare('SELECT 1 FROM dispositivos_vinculos WHERE veiculo_id = ? AND fim IS NULL').get(vei.id)) throw new ErroNegocio('O veículo já tem um dispositivo vinculado.', 409);
    const id = Number(db.prepare("INSERT INTO dispositivos_vinculos (organizacao_id, fonte, dispositivo_id, veiculo_id, inicio, criado_por) VALUES (?, 'rastreador', ?, ?, ?, ?)")
      .run(req.org, dispositivo, vei.id, agora(), req.usuario.id).lastInsertRowid);
    registrar(db, req, 'dispositivo_vinculado', { recurso: 'veiculo', recursoId: vei.id, depois: { dispositivo_id: dispositivo, vinculo_id: id } });
    res.status(201).json({ id, dispositivo_id: dispositivo, veiculo_id: vei.id });
  });

  r.post('/vinculos/:id/encerrar', exigir('rastreamento.vincular'), (req, res) => {
    const l = db.prepare('SELECT * FROM dispositivos_vinculos WHERE id = ? AND organizacao_id = ? AND fim IS NULL').get(Number(req.params.id), req.org);
    if (!l) throw new ErroNegocio('Vínculo não encontrado.', 404);
    const motivo = v.texto(req.body?.motivo, 'o motivo', 300);
    db.prepare('UPDATE dispositivos_vinculos SET fim = ? WHERE id = ?').run(agora(), l.id);
    registrar(db, req, 'dispositivo_desvinculado', { recurso: 'veiculo', recursoId: l.veiculo_id, antes: l, depois: { motivo } });
    res.json({ ok: true });
  });

  return r;
};
module.exports.distancia = distancia;
