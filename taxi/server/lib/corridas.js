'use strict';

const { transacao, lerConfig, agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { distancia, estimarRota } = require('./geo');
const tarifa = require('./tarifa');
const fin = require('./financeiro');
const pag = require('./pagamentos');
const emp = require('./empresas');
const v = require('./validacao');
const { hoje } = require('./datas');

const ATIVAS = ['aguardando_pagamento', 'solicitada', 'aceita', 'chegou', 'em_andamento'];
const CATEGORIAS = ['comum', 'executivo'];
const FORMAS = ['pix', 'cartao', 'empresa'];
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

/**
 * Encerra a corrida como cancelada: cancela cobranças em aberto e devolve o que o passageiro já pagou.
 */
function encerrar(db, c, quem, motivo) {
  db.prepare(`UPDATE corridas SET status = 'cancelada', cancelada_em = ?, cancelada_por = ?, motivo_cancelamento = ? WHERE id = ?`).run(agora(), quem, motivo, c.id);
  pag.cancelarPendentes(db, c.id);
  if (c.valor_pago_centavos > 0) {
    pag.criar(db, c, 'estorno', c.valor_pago_centavos, `Corrida cancelada (${quem})`);
    db.prepare(`UPDATE corridas SET pagamento_status = 'estornado' WHERE id = ?`).run(c.id);
  }
}

/** Pedidos sem pagamento e solicitações sem motorista há mais tempo que o limite são cancelados pelo sistema (com estorno). */
function expirarSolicitacoes(db) {
  const cfg = lerConfig(db);
  const corte = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const vencidas = [
    ...db.prepare(`SELECT * FROM corridas WHERE status = 'aguardando_pagamento' AND criada_em < ?`).all(corte(cfg.expirar_pagamento_min))
      .map((c) => [c, 'Pagamento não confirmado a tempo.']),
    ...db.prepare(`SELECT * FROM corridas WHERE status = 'solicitada' AND solicitada_em < ?`).all(corte(cfg.expirar_solicitacao_min))
      .map((c) => [c, 'Nenhum motorista disponível.']),
  ];
  if (vencidas.length) transacao(db, () => { for (const [c, motivo] of vencidas) encerrar(db, c, 'sistema', motivo); });
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
  if (c.empresa_id) out.empresa = db.prepare('SELECT razao_social FROM empresas WHERE id = ?').get(c.empresa_id)?.razao_social;
  out.cobrancas = db.prepare('SELECT id, tipo, forma, valor_centavos, status, motivo, criada_em, concluida_em FROM cobrancas WHERE corrida_id = ? ORDER BY id').all(c.id);
  const p = db.prepare('SELECT nome, telefone FROM usuarios WHERE id = ?').get(c.passageiro_id);
  const notaP = db.prepare('SELECT AVG(nota_do_motorista) AS media FROM corridas WHERE passageiro_id = ?').get(c.passageiro_id).media;
  out.passageiro = { ...p, nota_media: notaP === null ? null : Math.round(notaP * 10) / 10 };
  return out;
}

/** Corrida em curso do passageiro ou a última finalizada que ainda tem complemento a pagar ou avaliação. */
const corridaAtivaPassageiro = (db, id) => db.prepare(`SELECT * FROM corridas WHERE passageiro_id = ?
  AND (status IN ('aguardando_pagamento','solicitada','aceita','chegou','em_andamento')
  OR (status = 'finalizada' AND (pagamento_status = 'pendente' OR nota_do_passageiro IS NULL) AND finalizada_em > ?)) ORDER BY id DESC LIMIT 1`)
  .get(id, new Date(Date.now() - 6 * 3_600_000).toISOString());

const corridaAtivaMotorista = (db, id) => db.prepare(`SELECT * FROM corridas WHERE motorista_id = ? AND status IN ('aceita','chegou','em_andamento')
  ORDER BY id DESC LIMIT 1`).get(id);

function solicitar(db, passageiroId, dados) {
  const origem = v.ponto(dados.origem, 'a origem');
  const destino = v.ponto(dados.destino, 'o destino');
  const categoria = v.opcao(dados.categoria ?? 'comum', 'a categoria', CATEGORIAS);
  const forma = v.opcao(dados.forma_pagamento, 'a forma de pagamento', FORMAS);
  v.exigir(distancia(origem, destino) >= 100, 'Origem e destino estão muito próximos.');
  v.exigir(distancia(origem, destino) <= 300_000, 'Destino fora da área atendida (mais de 300 km).');
  expirarSolicitacoes(db);
  return transacao(db, () => {
    const ativa = db.prepare(`SELECT id FROM corridas WHERE passageiro_id = ? AND status IN ('aguardando_pagamento','solicitada','aceita','chegou','em_andamento')`).get(passageiroId);
    if (ativa) throw new ErroNegocio('Você já tem uma corrida em andamento.', 409);
    const est = estimar(db, origem, destino).find((e) => e.categoria === categoria);
    const empresa = forma === 'empresa' ? emp.exigirAutorizacao(db, passageiroId, dados.empresa_id, est.valor_centavos) : null;
    // PIX e cartão: a corrida espera o pagamento antes de ir para os taxistas. Empresa: sai direto (é faturada).
    const status = empresa ? 'solicitada' : 'aguardando_pagamento';
    const quando = agora();
    const r = db.prepare(`INSERT INTO corridas (passageiro_id, categoria, origem_endereco, origem_lat, origem_lng, destino_endereco, destino_lat, destino_lng,
      distancia_estimada_m, duracao_estimada_s, bandeira, valor_estimado_centavos, forma_pagamento, empresa_id, modelo_cobranca, status,
      pagamento_status, criada_em, solicitada_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(passageiroId, categoria, origem.endereco, origem.lat, origem.lng,
      destino.endereco, destino.lat, destino.lng, est.distancia_m, est.duracao_s, est.bandeira, est.valor_centavos, forma, empresa?.id ?? null,
      lerConfig(db).modelo_cobranca, status, empresa ? 'faturado' : 'pendente', quando, quando);
    const id = Number(r.lastInsertRowid);
    const cobranca = empresa ? null : pag.criar(db, buscar(db, id), 'corrida', est.valor_centavos);
    return { id, cobranca_id: cobranca };
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
const ROTULO = { aguardando_pagamento: 'aguardando o pagamento', solicitada: 'aguardando motorista', aceita: 'aceita', chegou: 'com o motorista no local', em_andamento: 'em andamento', finalizada: 'finalizada', cancelada: 'cancelada' };

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
 * Finaliza a corrida. O taxímetro (distância percorrida pelo GPS e tempo real, na bandeira do pedido) é sempre registrado;
 * sem trajeto (GPS desligado), usa a distância estimada. O valor final depende do modelo de cobrança do pedido:
 * - 'estimativa' (preço fechado): vale o valor estimado, já pago antes;
 * - 'taximetro': vale o taxímetro; se ficou abaixo do pago, a diferença é estornada; acima, gera um complemento a pagar.
 * Empresa: o valor final entra na fatura do mês. A parte do motorista (valor final menos a taxa) vai para o saldo dele.
 */
function finalizar(db, motoristaId, corridaId) {
  return transacao(db, () => {
    const c = daMotorista(db, motoristaId, corridaId);
    exigirStatus(c, 'em_andamento');
    const cfg = lerConfig(db);
    const fim = agora();
    const duracao = Math.max(0, Math.round((Date.parse(fim) - Date.parse(c.iniciada_em)) / 1000));
    const dist = c.distancia_percorrida_m > 0 ? c.distancia_percorrida_m : c.distancia_estimada_m;
    const taximetro = tarifa.calcular(tarifas(db)[c.categoria], { distancia_m: dist, duracao_s: duracao, bandeira: c.bandeira });
    const valor = c.modelo_cobranca === 'taximetro' ? taximetro : c.valor_estimado_centavos;
    const partes = tarifa.dividir(valor, cfg.taxa_plataforma_bp);
    db.prepare(`UPDATE corridas SET status = 'finalizada', finalizada_em = ?, duracao_real_s = ?, distancia_percorrida_m = ?, valor_taximetro_centavos = ?,
      valor_final_centavos = ?, taxa_plataforma_centavos = ?, valor_motorista_centavos = ? WHERE id = ?`)
      .run(fim, duracao, dist, taximetro, valor, partes.taxa_plataforma_centavos, partes.valor_motorista_centavos, c.id);
    if (c.forma_pagamento !== 'empresa') {
      const diferenca = valor - c.valor_pago_centavos;
      if (diferenca < 0) {
        pag.criar(db, c, 'estorno', -diferenca, 'Taxímetro abaixo do valor pago');
        db.prepare('UPDATE corridas SET valor_pago_centavos = ? WHERE id = ?').run(valor, c.id);
      } else if (diferenca > 0) {
        pag.criar(db, c, 'complemento', diferenca, 'Taxímetro acima do valor pago');
        db.prepare(`UPDATE corridas SET pagamento_status = 'pendente' WHERE id = ?`).run(c.id);
      }
    }
    const final = buscar(db, c.id);
    fin.creditarCorrida(db, final);
    return final;
  });
}

/**
 * Cancelamento (o que já foi pago é estornado). Passageiro: antes de a corrida começar. Motorista: desiste antes do início e a corrida
 * volta a ser oferecida aos outros. Central: a qualquer momento antes da finalização.
 */
function cancelar(db, quem, corridaId, motivo, ator = {}) {
  return transacao(db, () => {
    const c = buscar(db, corridaId);
    const texto = v.opcional(motivo, 'o motivo', 300);
    if (quem === 'passageiro') {
      if (c.passageiro_id !== ator.id) throw naoEncontrado('Corrida');
      exigirStatus(c, 'aguardando_pagamento', 'solicitada', 'aceita', 'chegou');
    } else if (quem === 'motorista') {
      if (c.motorista_id !== ator.id) throw naoEncontrado('Corrida');
      exigirStatus(c, 'aceita', 'chegou');
      recusar(db, ator.id, c.id);
      db.prepare(`UPDATE corridas SET status = 'solicitada', motorista_id = NULL, veiculo_id = NULL, aceita_em = NULL, chegou_em = NULL, solicitada_em = ? WHERE id = ?`)
        .run(agora(), c.id);
      return 'redistribuida';
    } else {
      exigirStatus(c, 'aguardando_pagamento', 'solicitada', 'aceita', 'chegou', 'em_andamento');
    }
    encerrar(db, c, quem, texto);
    return 'cancelada';
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
  solicitar, motoristaApto, ofertas, aceitar, recusar, chegou, iniciar, posicao, finalizar, cancelar, avaliar,
};
