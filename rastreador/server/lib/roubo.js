'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

const { agora, lerConfig, transacao } = require('../db');
const { ErroNegocio } = require('./erros');
const com = require('./comandos');

/**
 * Módulo de roubo com bloqueio inteligente: o cliente aciona o modo roubo e o sistema só manda o corte quando o veículo estiver
 * abaixo da velocidade segura (parâmetro `bloqueio_velocidade_segura_kmh`, padrão 20 km/h), para não cortar o motor em movimento.
 *
 * Situações da ocorrência: aguardando (esperando a velocidade segura) → bloqueio_enviado (corte enviado ao equipamento) →
 * bloqueado (o equipamento confirmou) → encerrada. Cada passo vira um evento na linha do tempo.
 */
// Posição mais velha que isso não serve para decidir: espera a próxima (com a ignição desligada, o veículo está parado).
const POSICAO_RECENTE_MS = 3 * 60_000;
// Enquanto espera, registra a velocidade na linha do tempo no máximo uma vez por minuto.
const AVISO_MS = 60_000;

const kmh = (x) => `${Math.round(Number(x) || 0)} km/h`;

function evento(db, ocorrenciaId, texto, pos = {}, { avisar = true } = {}) {
  db.prepare('INSERT INTO ocorrencia_eventos (ocorrencia_id, em, texto, lat, lng, velocidade_kmh) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ocorrenciaId, agora(), texto, pos.lat ?? null, pos.lng ?? null, pos.velocidade_kmh ?? null);
  // Cada passo do Modo Roubo vai pelo WhatsApp (o bloqueio programado só registra, para não avisar toda noite).
  const oc = db.prepare('SELECT o.empresa_id, o.tipo, v.placa, v.lat, v.lng FROM ocorrencias o JOIN veiculos v ON v.id = o.veiculo_id WHERE o.id = ?').get(ocorrenciaId);
  if (avisar && oc?.tipo === 'roubo') {
    require('./notificacoes').avisar(db, oc.empresa_id, 'roubo', { titulo: `🚨 Modo Roubo · ${oc.placa}`, texto, lat: pos.lat ?? oc.lat, lng: pos.lng ?? oc.lng,
      caminho: `/empresa/${oc.empresa_id}/roubo` });
  }
}

const limiteSeguro = (db) => lerConfig(db).bloqueio_velocidade_segura_kmh || 20;

/** Manda o corte (o comando de bloqueio do modelo do rastreador) e passa a ocorrência para "bloqueio_enviado". */
function enviarCorte(db, oc, veiculo, motivo, pos) {
  const comandoId = com.criar(db, veiculo, { tipo: 'bloquear', confirmacao: veiculo.placa }, oc.criada_por);
  db.prepare("UPDATE ocorrencias SET status = 'bloqueio_enviado', comando_id = ? WHERE id = ?").run(comandoId, oc.id);
  evento(db, oc.id, motivo, pos);
  return comandoId;
}

/**
 * Decide se dá para cortar agora: com uma posição recente abaixo da velocidade segura, ou com a ignição desligada
 * (parado). Senão, continua esperando.
 */
function seguroAgora(v, limite) {
  const recente = v.posicao_em && Date.now() - Date.parse(v.posicao_em) <= POSICAO_RECENTE_MS;
  if (recente && (v.velocidade_kmh ?? 0) < limite) return `Velocidade de ${kmh(v.velocidade_kmh)}, abaixo de ${kmh(limite)}: corte enviado.`;
  // Ignição desligada só vale com o aparelho falando agora: um aviso antigo (horas sem sinal) não garante que o veículo segue parado.
  const falouAgora = v.comunicacao_em && Date.now() - Date.parse(v.comunicacao_em) <= POSICAO_RECENTE_MS;
  if (v.ignicao === 0 && falouAgora) return 'Ignição desligada (veículo parado): corte enviado.';
  return null;
}

/** Aciona o modo roubo no veículo. Exige a placa digitada, como o bloqueio comum. */
function abrir(db, veiculo, d, usuarioId) {
  const digitada = String(d.confirmacao ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (digitada !== veiculo.placa) throw new ErroNegocio('Para acionar o modo roubo, digite a placa do veículo para confirmar.', 422);
  const aberta = db.prepare("SELECT * FROM ocorrencias WHERE veiculo_id = ? AND status <> 'encerrada'").get(veiculo.id);
  v_exigir(!aberta || aberta.tipo !== 'roubo', 'Este veículo já está em modo roubo.');
  return transacao(db, () => {
    // Já no bloqueio programado: a mesma ocorrência vira Modo Roubo (o corte já pedido continua valendo).
    if (aberta) {
      db.prepare("UPDATE ocorrencias SET tipo = 'roubo', criada_por = ?, observacao = ? WHERE id = ?").run(usuarioId ?? null, d.observacao ? String(d.observacao).slice(0, 500) : null, aberta.id);
      evento(db, aberta.id, 'Modo roubo acionado (o veículo estava no bloqueio programado).', { lat: veiculo.lat, lng: veiculo.lng, velocidade_kmh: veiculo.velocidade_kmh });
      perseguir(db, aberta.id, veiculo, usuarioId);
      return aberta.id;
    }
    const id = abrirInterno(db, veiculo, { tipo: 'roubo', usuarioId, observacao: d.observacao });
    perseguir(db, id, veiculo, usuarioId);
    return id;
  });
}

/** Modo Roubo aberto pelo sistema (ex.: saída de cerca com a ação "acionar Modo Roubo"), sem a placa digitada. */
function abrirAutomatico(db, veiculo, motivo) {
  const aberta = db.prepare("SELECT * FROM ocorrencias WHERE veiculo_id = ? AND status <> 'encerrada'").get(veiculo.id);
  if (aberta?.tipo === 'roubo') return aberta.id;
  if (aberta) {
    db.prepare("UPDATE ocorrencias SET tipo = 'roubo' WHERE id = ?").run(aberta.id);
    evento(db, aberta.id, `Modo roubo acionado automaticamente: ${motivo}.`);
    perseguir(db, aberta.id, veiculo, null);
    return aberta.id;
  }
  const id = abrirInterno(db, veiculo, { tipo: 'roubo', observacao: motivo });
  evento(db, id, `Acionado automaticamente: ${motivo}.`);
  perseguir(db, id, veiculo, null);
  return id;
}

/** Modo perseguição: o J16 passa a mandar posição a cada 10 s enquanto a ocorrência estiver aberta. */
function perseguir(db, ocorrenciaId, veiculo, usuarioId) {
  const r = db.prepare('SELECT protocolo FROM rastreadores WHERE id = ?').get(veiculo.rastreador_id);
  if (!r || r.protocolo !== 'gt06') return;
  const [a, b] = require('./equipamento').PERSEGUICAO;
  com.criar(db, veiculo, { tipo: 'personalizado', texto: `TIMER,${a},${b}#`, rotulo: 'Modo perseguição: posição a cada 10 s' }, usuarioId);
  db.prepare('UPDATE ocorrencias SET perseguicao = 1 WHERE id = ?').run(ocorrenciaId);
  evento(db, ocorrenciaId, 'Modo perseguição: o rastreador passa a mandar posição a cada 10 s.', {}, { avisar: false });
}

/** Volta o J16 ao perfil de envio da ficha, depois da perseguição. */
function voltarPerfil(db, veiculo, usuarioId) {
  const r = db.prepare('SELECT protocolo, perfil FROM rastreadores WHERE id = ?').get(veiculo.rastreador_id);
  if (!r || r.protocolo !== 'gt06') return;
  for (const c of require('./equipamento').AJUSTES.perfil(r.perfil)) com.criar(db, veiculo, { tipo: 'personalizado', ...c }, usuarioId);
}

/**
 * Abre a ocorrência (roubo ou bloqueio programado) e já manda o corte se o veículo estiver seguro; senão, espera.
 * Usada dentro de uma transação.
 */
function abrirInterno(db, veiculo, { tipo, usuarioId = null, observacao = null }) {
  v_exigir(veiculo.rastreador_id, 'O veículo não tem rastreador instalado.');
  v_exigir(!veiculo.bloqueio_desativado, 'O bloqueio deste veículo está desativado (instalação do relé em revisão). Para usar, reative em Veículos → Editar.');
  const r = db.prepare('SELECT protocolo FROM rastreadores WHERE id = ?').get(veiculo.rastreador_id);
  v_exigir(r && r.protocolo !== 'osmand', 'Este rastreador (aplicativo no celular) não recebe o comando de bloqueio.');
  const limite = limiteSeguro(db);
  {
    const id = Number(db.prepare(`INSERT INTO ocorrencias (empresa_id, veiculo_id, tipo, status, observacao, criada_por, criada_em)
      VALUES (?, ?, ?, 'aguardando', ?, ?, ?)`).run(veiculo.empresa_id, veiculo.id, tipo, observacao ? String(observacao).slice(0, 500) : null, usuarioId, agora()).lastInsertRowid);
    const pos = { lat: veiculo.lat, lng: veiculo.lng, velocidade_kmh: veiculo.velocidade_kmh };
    evento(db, id, { roubo: 'Modo roubo acionado.', agenda: 'Início do horário de bloqueio programado.', manual: 'Bloqueio pedido pelo painel.' }[tipo] ?? 'Bloqueio aberto.', pos);
    const oc = db.prepare('SELECT * FROM ocorrencias WHERE id = ?').get(id);
    if (veiculo.bloqueado) {
      db.prepare("UPDATE ocorrencias SET status = 'bloqueado' WHERE id = ?").run(id);
      evento(db, id, 'O veículo já estava bloqueado.', pos);
      return id;
    }
    const motivo = seguroAgora(veiculo, limite);
    if (motivo) enviarCorte(db, oc, veiculo, motivo, pos);
    else evento(db, id, `Bloqueio inteligente: aguardando a velocidade baixar de ${kmh(limite)} (agora ${kmh(veiculo.velocidade_kmh)}).`, pos);
    return id;
  }
}

function v_exigir(cond, msg) {
  if (!cond) throw new ErroNegocio(msg, 422);
}

/**
 * Chamado a cada mensagem do rastreador (dentro da transação da posição), com o veículo já atualizado: se há ocorrência
 * esperando e o veículo ficou seguro, manda o corte.
 */
function aoReceber(db, veiculoId) {
  const oc = db.prepare("SELECT * FROM ocorrencias WHERE veiculo_id = ? AND status = 'aguardando'").get(veiculoId);
  if (!oc) return;
  const veiculo = db.prepare('SELECT * FROM veiculos WHERE id = ?').get(veiculoId);
  if (veiculo.bloqueio_desativado) return; // nunca derruba a gravação da posição
  const pos = { lat: veiculo.lat, lng: veiculo.lng, velocidade_kmh: veiculo.velocidade_kmh };
  const limite = limiteSeguro(db);
  const motivo = seguroAgora(veiculo, limite);
  if (motivo) {
    enviarCorte(db, oc, veiculo, motivo, pos);
  } else if (!oc.aviso_em || Date.now() - Date.parse(oc.aviso_em) >= AVISO_MS) {
    db.prepare('UPDATE ocorrencias SET aviso_em = ? WHERE id = ?').run(agora(), oc.id);
    evento(db, oc.id, `Veículo a ${kmh(veiculo.velocidade_kmh)}: aguardando ficar abaixo de ${kmh(limite)} para cortar.`, pos);
  }
}

/** Resposta do equipamento ao corte: confirmado → bloqueado; recusado → volta a esperar e tenta de novo na próxima posição segura. */
function aoResponder(db, comando, sucesso, resposta) {
  if (comando.tipo !== 'bloquear') return;
  const oc = db.prepare("SELECT * FROM ocorrencias WHERE comando_id = ? AND status = 'bloqueio_enviado'").get(comando.id);
  if (!oc) return;
  if (sucesso) {
    db.prepare("UPDATE ocorrencias SET status = 'bloqueado' WHERE id = ?").run(oc.id);
    evento(db, oc.id, `O rastreador confirmou o bloqueio${resposta ? `: ${String(resposta).slice(0, 120)}` : '.'}`);
  } else {
    db.prepare("UPDATE ocorrencias SET status = 'aguardando', comando_id = NULL WHERE id = ?").run(oc.id);
    evento(db, oc.id, `O rastreador recusou o corte${resposta ? ` (${String(resposta).slice(0, 120)})` : ''}: tentando de novo na próxima posição segura.`);
  }
}

/**
 * Bloquear (botão comum): com o veículo seguro (devagar ou desligado) o comando sai na hora, como sempre (devolve null).
 * Andando acima da velocidade segura, abre um bloqueio inteligente "manual": o corte espera, igual ao Modo Roubo, mas sem
 * perseguição e sem avisos de roubo. Devolve o id da ocorrência.
 */
function bloquearComSeguranca(db, veiculo, d, usuarioId) {
  if (veiculo.bloqueado || seguroAgora(veiculo, limiteSeguro(db))) return null;
  const digitada = String(d.confirmacao ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (digitada !== veiculo.placa) throw new ErroNegocio('Para bloquear, digite a placa do veículo para confirmar.', 422);
  v_exigir(!db.prepare("SELECT 1 FROM ocorrencias WHERE veiculo_id = ? AND status <> 'encerrada'").get(veiculo.id),
    'Já há um bloqueio em andamento neste veículo (veja em Segurança).');
  return transacao(db, () => abrirInterno(db, veiculo, { tipo: 'manual', usuarioId }));
}

/** Desbloquear (botão comum) com um bloqueio manual aberto: encerra a ocorrência (e só desbloqueia se o corte já saiu). */
function desbloquearManual(db, veiculo, usuarioId) {
  const oc = db.prepare("SELECT * FROM ocorrencias WHERE veiculo_id = ? AND tipo = 'manual' AND status <> 'encerrada'").get(veiculo.id);
  if (!oc) return false;
  encerrar(db, oc, { desbloquear: oc.status !== 'aguardando', texto: oc.status === 'aguardando' ? 'Bloqueio cancelado antes do corte.' : 'Desbloqueio pedido pelo painel.' }, usuarioId);
  return true;
}

/**
 * Corte que ficou sem resposta (comando expirado pela manutenção ou cancelado por outro comando): a ocorrência volta a esperar e
 * o corte sai de novo na próxima posição segura, em vez de ficar parada em "bloqueio enviado" para sempre.
 */
function aoExpirar(db) {
  const lista = db.prepare(`SELECT o.id FROM ocorrencias o JOIN comandos c ON c.id = o.comando_id
    WHERE o.status = 'bloqueio_enviado' AND c.status IN ('expirado', 'cancelado', 'falhou')`).all();
  for (const { id } of lista) {
    db.prepare("UPDATE ocorrencias SET status = 'aguardando', comando_id = NULL WHERE id = ?").run(id);
    evento(db, id, 'O rastreador não respondeu ao corte a tempo: tentando de novo na próxima posição segura.');
  }
  return lista.length;
}

/** Corte imediato, sem esperar a velocidade (o cliente assume o risco; exige a placa digitada). */
function forcar(db, oc, d) {
  const veiculo = db.prepare('SELECT * FROM veiculos WHERE id = ?').get(oc.veiculo_id);
  const digitada = String(d.confirmacao ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (digitada !== veiculo.placa) throw new ErroNegocio('Para forçar o corte, digite a placa do veículo para confirmar.', 422);
  v_exigir(oc.status === 'aguardando', 'O corte já foi enviado.');
  return transacao(db, () => enviarCorte(db, oc, veiculo, `Corte forçado pelo usuário com o veículo a ${kmh(veiculo.velocidade_kmh)}.`,
    { lat: veiculo.lat, lng: veiculo.lng, velocidade_kmh: veiculo.velocidade_kmh }));
}

/** Encerra a ocorrência; com `desbloquear`, manda o desbloqueio (o veículo volta a funcionar). */
function encerrar(db, oc, d, usuarioId) {
  v_exigir(oc.status !== 'encerrada', 'A ocorrência já foi encerrada.');
  return transacao(db, () => {
    const veiculo = db.prepare('SELECT * FROM veiculos WHERE id = ?').get(oc.veiculo_id);
    if (oc.status === 'aguardando' || oc.status === 'bloqueio_enviado') {
      // Um corte ainda não entregue não sai mais.
      db.prepare("UPDATE comandos SET status = 'cancelado', respondido_em = ? WHERE veiculo_id = ? AND tipo = 'bloquear' AND status = 'pendente'").run(agora(), veiculo.id);
    }
    if (d.desbloquear && veiculo.rastreador_id) com.criar(db, veiculo, { tipo: 'desbloquear' }, usuarioId);
    if (oc.perseguicao) voltarPerfil(db, veiculo, usuarioId);
    db.prepare("UPDATE ocorrencias SET status = 'encerrada', encerrada_por = ?, encerrada_em = ? WHERE id = ?").run(usuarioId ?? null, agora(), oc.id);
    evento(db, oc.id, d.texto ?? (d.desbloquear ? 'Ocorrência encerrada e desbloqueio enviado.' : 'Ocorrência encerrada (o veículo continua como está).'));
  });
}

/** Ocorrências da empresa: as em andamento (com o veículo e a linha do tempo) e as últimas encerradas. */
function listar(db, empresaId, tipo = 'roubo') {
  const lista = db.prepare(`SELECT o.*, v.placa, v.descricao, v.lat, v.lng, v.velocidade_kmh, v.ignicao, v.bloqueado, v.posicao_em, v.comunicacao_em,
      u.nome AS criada_por_nome, ue.nome AS encerrada_por_nome, c.status AS comando_status
    FROM ocorrencias o JOIN veiculos v ON v.id = o.veiculo_id LEFT JOIN usuarios u ON u.id = o.criada_por LEFT JOIN usuarios ue ON ue.id = o.encerrada_por
    LEFT JOIN comandos c ON c.id = o.comando_id
    WHERE o.empresa_id = ? AND o.tipo = ? AND (o.status <> 'encerrada' OR o.encerrada_em >= ?) ORDER BY o.status = 'encerrada', o.criada_em DESC LIMIT 100`)
    .all(empresaId, tipo, new Date(Date.now() - 90 * 24 * 3_600_000).toISOString());
  const eventos = db.prepare('SELECT em, texto, lat, lng, velocidade_kmh FROM ocorrencia_eventos WHERE ocorrencia_id = ? ORDER BY id DESC LIMIT 50');
  return lista.map((o) => ({ ...o, eventos: o.status === 'encerrada' ? [] : eventos.all(o.id) }));
}

module.exports = { abrir, abrirAutomatico, abrirInterno, aoReceber, aoResponder, aoExpirar, forcar, encerrar, listar, limiteSeguro, bloquearComSeguranca, desbloquearManual };
