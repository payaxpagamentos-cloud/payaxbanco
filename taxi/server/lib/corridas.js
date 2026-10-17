'use strict';

const { transacao, lerConfig, agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { distancia, estimarRota } = require('./geo');
const tarifa = require('./tarifa');
const fin = require('./financeiro');
const v = require('./validacao');
const { hoje } = require('./datas');

const ATIVAS = ['solicitada', 'aceita', 'chegou', 'em_andamento'];
const CATEGORIAS = ['comum', 'executivo'];
const FORMAS = ['pix', 'cartao', 'dinheiro'];
// Posições de GPS com velocidade aparente acima disto são descartadas do trajeto (salto de sinal).
const VELOCIDADE_MAXIMA_KMH = 150;

const tarifas = (db) => Object.fromEntries(db.prepare('SELECT * FROM tarifas').all().map((t) => [t.categoria, t]));

/** Estimativa de cada categoria entre dois pontos, com a bandeira de agora. */
function estimar(db, origem, destino, instante = new Date()) {
  const cfg = lerConfig(db);
  const rota = estimarRota(origem, destino, cfg);
  const b = tarifa.bandeira(instante, cfg);
  const ts = tarifas(db);
  return CATEGORIAS.map((c) => ({ categoria: c, bandeira: b, ...rota, valor_centavos: tarifa.calcular(ts[c], { ...rota, bandeira: b }) }));
}

/** Solicitações sem motorista há mais tempo que o limite são canceladas pelo sistema. */
function expirarSolicitacoes(db) {
  const { expirar_solicitacao_min: min } = lerConfig(db);
  const corte = new Date(Date.now() - min * 60_000).toISOString();
  db.prepare(`UPDATE corridas SET status = 'cancelada', cancelada_em = ?, cancelada_por = 'sistema', motivo_cancelamento = 'Nenhum motorista disponível.'
    WHERE status = 'solicitada' AND solicitada_em < ?`).run(agora(), corte);
}

function buscar(db, id) {
  const c = db.prepare('SELECT * FROM corridas WHERE id = ?').get(id);
  if (!c) throw naoEncontrado('Corrida');
  return c;
}

const notaMedia = (db, motoristaId) => {
  const r = db.prepare('SELECT AVG(nota_do_passageiro) AS media, COUNT(nota_do_passageiro) AS total FROM corridas WHERE motorista_id = ?').get(motoristaId);
  return { nota_media: r.media === null ? null : Math.round(r.media * 10) / 10, avaliacoes: r.total };
};

/** Corrida com os dados do motorista e do veículo (para o passageiro) ou do passageiro (para o motorista). */
function detalhar(db, c) {
  if (!c) return null;
  const out = { ...c };
  if (c.motorista_id) {
    const m = db.prepare(`SELECT u.nome, u.telefone, m.lat, m.lng, m.posicao_em, v.placa, v.marca_modelo, v.cor
      FROM motoristas m JOIN usuarios u ON u.id = m.usuario_id LEFT JOIN veiculos v ON v.id = ? WHERE m.usuario_id = ?`).get(c.veiculo_id, c.motorista_id);
    out.motorista = { ...m, ...notaMedia(db, c.motorista_id) };
    if (['aceita'].includes(c.status) && m.lat !== null) {
      const cfg = lerConfig(db);
      const r = estimarRota({ lat: m.lat, lng: m.lng }, { lat: c.origem_lat, lng: c.origem_lng }, cfg);
      out.motorista.chegada_s = r.duracao_s;
      out.motorista.distancia_ate_origem_m = r.distancia_m;
    }
  }
  const p = db.prepare('SELECT nome, telefone FROM usuarios WHERE id = ?').get(c.passageiro_id);
  const notaP = db.prepare('SELECT AVG(nota_do_motorista) AS media FROM corridas WHERE passageiro_id = ?').get(c.passageiro_id).media;
  out.passageiro = { ...p, nota_media: notaP === null ? null : Math.round(notaP * 10) / 10 };
  return out;
}

const corridaAtivaPassageiro = (db, id) => db.prepare(`SELECT * FROM corridas WHERE passageiro_id = ? AND (status IN ('solicitada','aceita','chegou','em_andamento')
  OR (status = 'finalizada' AND (pagamento_status = 'pendente' OR nota_do_passageiro IS NULL) AND finalizada_em > ?)) ORDER BY id DESC LIMIT 1`)
  .get(id, new Date(Date.now() - 6 * 3_600_000).toISOString());

const corridaAtivaMotorista = (db, id) => db.prepare(`SELECT * FROM corridas WHERE motorista_id = ? AND (status IN ('aceita','chegou','em_andamento')
  OR (status = 'finalizada' AND pagamento_status = 'pendente')) ORDER BY id DESC LIMIT 1`).get(id);

function solicitar(db, passageiroId, dados) {
  const origem = v.ponto(dados.origem, 'a origem');
  const destino = v.ponto(dados.destino, 'o destino');
  const categoria = v.opcao(dados.categoria ?? 'comum', 'a categoria', CATEGORIAS);
  const forma = v.opcao(dados.forma_pagamento, 'a forma de pagamento', FORMAS);
  v.exigir(distancia(origem, destino) >= 100, 'Origem e destino estão muito próximos.');
  v.exigir(distancia(origem, destino) <= 300_000, 'Destino fora da área atendida (mais de 300 km).');
  return transacao(db, () => {
    expirarSolicitacoes(db);
    const ativa = db.prepare(`SELECT id FROM corridas WHERE passageiro_id = ? AND status IN ('solicitada','aceita','chegou','em_andamento')`).get(passageiroId);
    if (ativa) throw new ErroNegocio('Você já tem uma corrida em andamento.', 409);
    const est = estimar(db, origem, destino).find((e) => e.categoria === categoria);
    const r = db.prepare(`INSERT INTO corridas (passageiro_id, categoria, origem_endereco, origem_lat, origem_lng, destino_endereco, destino_lat, destino_lng,
      distancia_estimada_m, duracao_estimada_s, bandeira, valor_estimado_centavos, forma_pagamento, solicitada_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(passageiroId, categoria, origem.endereco, origem.lat, origem.lng,
      destino.endereco, destino.lat, destino.lng, est.distancia_m, est.duracao_s, est.bandeira, est.valor_centavos, forma, agora());
    return Number(r.lastInsertRowid);
  });
}

/** Motorista apto a receber corridas: aprovado, CNH no prazo, veículo aprovado. */
function motoristaApto(db, motoristaId) {
  const m = db.prepare(`SELECT m.*, v.categoria AS veiculo_categoria, v.situacao AS veiculo_situacao FROM motoristas m
    LEFT JOIN veiculos v ON v.id = m.veiculo_id AND v.motorista_id = m.usuario_id WHERE m.usuario_id = ?`).get(motoristaId);
  if (!m) throw naoEncontrado('Motorista');
  if (m.situacao !== 'aprovado') throw new ErroNegocio(m.situacao === 'pendente' ? 'Seu cadastro ainda está em análise pela central.' : 'Seu cadastro não está liberado. Fale com a central.', 403);
  if (m.cnh_validade < hoje()) throw new ErroNegocio('Sua CNH está vencida. Atualize o cadastro com a central.', 403);
  if (!m.veiculo_id || m.veiculo_situacao !== 'aprovado') throw new ErroNegocio('Escolha um veículo aprovado pela central.', 403);
  return m;
}

/** Corridas solicitadas perto do motorista, da categoria do veículo (executivo também atende comum). */
function ofertas(db, motoristaId) {
  expirarSolicitacoes(db);
  const m = motoristaApto(db, motoristaId);
  if (!m.online || m.lat === null) return [];
  if (corridaAtivaMotorista(db, motoristaId)) return [];
  const cfg = lerConfig(db);
  const categorias = m.veiculo_categoria === 'executivo' ? CATEGORIAS : ['comum'];
  const lista = db.prepare(`SELECT * FROM corridas c WHERE status = 'solicitada' AND categoria IN (${categorias.map(() => '?').join(',')})
    AND NOT EXISTS (SELECT 1 FROM recusas r WHERE r.corrida_id = c.id AND r.motorista_id = ?) ORDER BY solicitada_em`).all(...categorias, motoristaId);
  return lista
    .map((c) => {
      const ate = estimarRota({ lat: m.lat, lng: m.lng }, { lat: c.origem_lat, lng: c.origem_lng }, cfg);
      const { valor_motorista_centavos } = tarifa.dividir(c.valor_estimado_centavos, cfg.taxa_plataforma_bp);
      return {
        id: c.id, categoria: c.categoria, origem_endereco: c.origem_endereco, origem_lat: c.origem_lat, origem_lng: c.origem_lng,
        destino_endereco: c.destino_endereco, destino_lat: c.destino_lat, destino_lng: c.destino_lng,
        distancia_estimada_m: c.distancia_estimada_m, duracao_estimada_s: c.duracao_estimada_s, bandeira: c.bandeira,
        valor_estimado_centavos: c.valor_estimado_centavos, ganho_estimado_centavos: valor_motorista_centavos, forma_pagamento: c.forma_pagamento,
        solicitada_em: c.solicitada_em, distancia_ate_origem_m: ate.distancia_m, chegada_s: ate.duracao_s,
        linha_reta_m: distancia({ lat: m.lat, lng: m.lng }, { lat: c.origem_lat, lng: c.origem_lng }),
      };
    })
    .filter((o) => o.linha_reta_m <= cfg.raio_busca_km * 1000)
    .sort((a, b) => a.linha_reta_m - b.linha_reta_m)
    .map(({ linha_reta_m, ...o }) => o);
}

function aceitar(db, motoristaId, corridaId) {
  return transacao(db, () => {
    const oferta = ofertas(db, motoristaId).find((o) => o.id === corridaId);
    if (!oferta) {
      const c = db.prepare('SELECT status FROM corridas WHERE id = ?').get(corridaId);
      if (c && c.status !== 'solicitada') throw new ErroNegocio('Esta corrida já foi aceita por outro motorista ou cancelada.', 409);
      throw new ErroNegocio('Corrida indisponível para você.', 409);
    }
    const m = db.prepare('SELECT veiculo_id FROM motoristas WHERE usuario_id = ?').get(motoristaId);
    const r = db.prepare(`UPDATE corridas SET status = 'aceita', motorista_id = ?, veiculo_id = ?, aceita_em = ? WHERE id = ? AND status = 'solicitada'`)
      .run(motoristaId, m.veiculo_id, agora(), corridaId);
    if (!r.changes) throw new ErroNegocio('Esta corrida já foi aceita por outro motorista.', 409);
  });
}

function recusar(db, motoristaId, corridaId) {
  db.prepare('INSERT OR IGNORE INTO recusas (corrida_id, motorista_id) VALUES (?, ?)').run(corridaId, motoristaId);
}

function daMotorista(db, motoristaId, corridaId) {
  const c = buscar(db, corridaId);
  if (c.motorista_id !== motoristaId) throw naoEncontrado('Corrida');
  return c;
}

function exigirStatus(c, ...status) {
  if (!status.includes(c.status)) throw new ErroNegocio(`Operação indisponível: a corrida está ${ROTULO[c.status]}.`, 409);
}
const ROTULO = { solicitada: 'aguardando motorista', aceita: 'aceita', chegou: 'com o motorista no local', em_andamento: 'em andamento', finalizada: 'finalizada', cancelada: 'cancelada' };

function chegou(db, motoristaId, corridaId) {
  const c = daMotorista(db, motoristaId, corridaId);
  exigirStatus(c, 'aceita');
  db.prepare(`UPDATE corridas SET status = 'chegou', chegou_em = ? WHERE id = ?`).run(agora(), c.id);
}

function iniciar(db, motoristaId, corridaId) {
  const c = daMotorista(db, motoristaId, corridaId);
  exigirStatus(c, 'aceita', 'chegou');
  const m = db.prepare('SELECT lat, lng FROM motoristas WHERE usuario_id = ?').get(motoristaId);
  db.prepare(`UPDATE corridas SET status = 'em_andamento', iniciada_em = ?, ultima_lat = ?, ultima_lng = ?, ultima_posicao_em = ? WHERE id = ?`)
    .run(agora(), m.lat ?? c.origem_lat, m.lng ?? c.origem_lng, agora(), c.id);
}

/** Atualiza a posição do motorista e, em corrida, soma o trecho percorrido. */
function posicao(db, motoristaId, lat, lng) {
  const quando = agora();
  transacao(db, () => {
    db.prepare('UPDATE motoristas SET lat = ?, lng = ?, posicao_em = ? WHERE usuario_id = ?').run(lat, lng, quando, motoristaId);
    const c = db.prepare(`SELECT id, ultima_lat, ultima_lng, ultima_posicao_em FROM corridas WHERE motorista_id = ? AND status = 'em_andamento'`).get(motoristaId);
    if (!c) return;
    const trecho = c.ultima_lat === null ? 0 : distancia({ lat: c.ultima_lat, lng: c.ultima_lng }, { lat, lng });
    const segundos = Math.max(1, (Date.parse(quando) - Date.parse(c.ultima_posicao_em ?? quando)) / 1000);
    if ((trecho / segundos) * 3.6 > VELOCIDADE_MAXIMA_KMH) return; // salto do GPS: ignora e mantém a última posição válida
    db.prepare('UPDATE corridas SET distancia_percorrida_m = distancia_percorrida_m + ?, ultima_lat = ?, ultima_lng = ?, ultima_posicao_em = ? WHERE id = ?')
      .run(Math.round(trecho), lat, lng, quando, c.id);
  });
}

/**
 * Finaliza pela distância percorrida (GPS) e pelo tempo real, na bandeira do início.
 * Sem trajeto registrado (GPS desligado), usa a distância estimada até o destino.
 */
function finalizar(db, motoristaId, corridaId) {
  return transacao(db, () => {
    const c = daMotorista(db, motoristaId, corridaId);
    exigirStatus(c, 'em_andamento');
    const cfg = lerConfig(db);
    const fim = agora();
    const duracao = Math.max(0, Math.round((Date.parse(fim) - Date.parse(c.iniciada_em)) / 1000));
    const dist = c.distancia_percorrida_m > 0 ? c.distancia_percorrida_m : c.distancia_estimada_m;
    const valor = tarifa.calcular(tarifas(db)[c.categoria], { distancia_m: dist, duracao_s: duracao, bandeira: c.bandeira });
    const partes = tarifa.dividir(valor, cfg.taxa_plataforma_bp);
    db.prepare(`UPDATE corridas SET status = 'finalizada', finalizada_em = ?, duracao_real_s = ?, distancia_percorrida_m = ?, valor_final_centavos = ?,
      taxa_plataforma_centavos = ?, valor_motorista_centavos = ? WHERE id = ?`)
      .run(fim, duracao, dist, valor, partes.taxa_plataforma_centavos, partes.valor_motorista_centavos, c.id);
    return buscar(db, c.id);
  });
}

/**
 * Cancelamento. Passageiro: antes de a corrida começar. Motorista: desiste antes do início e a corrida
 * volta a ser oferecida aos outros. Central: a qualquer momento antes da finalização.
 */
function cancelar(db, quem, corridaId, motivo, ator = {}) {
  return transacao(db, () => {
    const c = buscar(db, corridaId);
    const texto = v.opcional(motivo, 'o motivo', 300);
    if (quem === 'passageiro') {
      if (c.passageiro_id !== ator.id) throw naoEncontrado('Corrida');
      exigirStatus(c, 'solicitada', 'aceita', 'chegou');
    } else if (quem === 'motorista') {
      if (c.motorista_id !== ator.id) throw naoEncontrado('Corrida');
      exigirStatus(c, 'aceita', 'chegou');
      recusar(db, ator.id, c.id);
      db.prepare(`UPDATE corridas SET status = 'solicitada', motorista_id = NULL, veiculo_id = NULL, aceita_em = NULL, chegou_em = NULL, solicitada_em = ? WHERE id = ?`)
        .run(agora(), c.id);
      return 'redistribuida';
    } else {
      exigirStatus(c, 'solicitada', 'aceita', 'chegou', 'em_andamento');
    }
    db.prepare(`UPDATE corridas SET status = 'cancelada', cancelada_em = ?, cancelada_por = ?, motivo_cancelamento = ? WHERE id = ?`).run(agora(), quem, texto, c.id);
    return 'cancelada';
  });
}

/** Confirma o pagamento e lança na conta do motorista (crédito do PIX ou débito da taxa do dinheiro/cartão). */
function confirmarPagamento(db, corridaId, usuario) {
  return transacao(db, () => {
    const c = buscar(db, corridaId);
    if (usuario.perfil === 'motorista' && c.motorista_id !== usuario.id) throw naoEncontrado('Corrida');
    exigirStatus(c, 'finalizada');
    if (c.pagamento_status === 'pago') throw new ErroNegocio('Pagamento já confirmado.', 409);
    db.prepare(`UPDATE corridas SET pagamento_status = 'pago', pago_em = ?, pagamento_confirmado_por = ? WHERE id = ?`).run(agora(), usuario.id, c.id);
    fin.lancarCorrida(db, { ...c, pagamento_status: 'pago' }, usuario.id);
  });
}

function avaliar(db, quem, corridaId, ator, { nota, comentario }) {
  const c = buscar(db, corridaId);
  const n = v.inteiro(nota, 'a nota', { min: 1, max: 5 });
  exigirStatus(c, 'finalizada');
  if (quem === 'passageiro') {
    if (c.passageiro_id !== ator.id) throw naoEncontrado('Corrida');
    if (c.nota_do_passageiro !== null) throw new ErroNegocio('Corrida já avaliada.', 409);
    db.prepare('UPDATE corridas SET nota_do_passageiro = ?, comentario_do_passageiro = ? WHERE id = ?').run(n, v.opcional(comentario, 'o comentário', 500), c.id);
  } else {
    if (c.motorista_id !== ator.id) throw naoEncontrado('Corrida');
    if (c.nota_do_motorista !== null) throw new ErroNegocio('Passageiro já avaliado.', 409);
    db.prepare('UPDATE corridas SET nota_do_motorista = ? WHERE id = ?').run(n, c.id);
  }
}

module.exports = {
  ATIVAS, CATEGORIAS, FORMAS, tarifas, estimar, expirarSolicitacoes, buscar, detalhar, notaMedia, corridaAtivaPassageiro, corridaAtivaMotorista,
  solicitar, motoristaApto, ofertas, aceitar, recusar, chegou, iniciar, posicao, finalizar, cancelar, confirmarPagamento, avaliar,
};
