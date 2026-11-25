'use strict';

const crypto = require('node:crypto');
const { agora } = require('../db');
const { hoje } = require('./datas');
const { ErroNegocio } = require('./erros');
const { digitos, cpfValido } = require('./validacao');

/**
 * Controle de senha (fila de atendimento) do ponto.
 *
 * O cliente tira a senha no totem (informa o CPF e escolhe o atendimento: Comercial, Suporte…). A senha
 * fica aguardando e vai SOZINHA para o atendente que está disponível e há mais tempo sem atender; aí ela
 * aparece na TV com o guichê dele. Sem totem também funciona: o atendente aperta "chamar próxima".
 * As senhas são numeradas por tipo — N (normal) e P (preferencial) — e recomeçam do 0001 a cada dia.
 * De cada atendimento ficam o assunto, quanto o cliente esperou e quanto tempo durou.
 */
const TIPOS = { N: 'Normal', P: 'Preferencial' };
const MAXIMO = 9999;
const SERVICOS_PADRAO = ['Comercial', 'Suporte'];
// A tela do atendente dá sinal a cada poucos segundos; sem sinal por este tempo, ele não recebe senha.
// (Folga grande de propósito: o navegador atrasa o sinal de aba que está em segundo plano.)
const PRESENCA_MS = 150_000;
const formatar = (tipo, numero) => `${tipo}${String(numero).padStart(4, '0')}`;
const codigo = (s) => formatar(s.tipo, s.numero);

const limpar = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const segundos = (de, ate) => Math.max(0, Math.round((Date.parse(ate) - Date.parse(de)) / 1000));
const cpfFormatado = (c) => (c && c.length === 11 ? `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}` : null);

const publica = (s) => ({
  id: s.id, codigo: codigo(s), tipo: s.tipo, numero: s.numero, guiche: s.guiche, chamada_em: s.espera ? null : s.chamada_em, repetida_em: s.repetida_em,
  assunto: s.assunto ?? null, encerrada_em: s.encerrada_em ?? null,
  servico: s.servico ?? null, cpf: cpfFormatado(s.cpf), emitida_em: s.emitida_em ?? null, aguardando: Boolean(s.espera),
  // Quanto o cliente esperou (do totem até ser chamado) e quanto durou o atendimento (só depois de encerrado).
  espera_s: s.emitida_em && !s.espera ? segundos(s.emitida_em, s.chamada_em) : null,
  duracao_s: s.encerrada_em ? segundos(s.chamada_em, s.encerrada_em) : null,
});

/** Os atendimentos que o totem oferece neste ponto. */
function servicosDoPonto(db, localId) {
  const bruto = db.prepare('SELECT senha_servicos FROM locais WHERE id = ?').get(localId)?.senha_servicos;
  const lista = String(bruto ?? '').split('\n').map((x) => limpar(x, 40)).filter(Boolean);
  return lista.length ? lista : SERVICOS_PADRAO;
}

const doDia = (db, localId) => db.prepare('SELECT * FROM senhas WHERE local_id = ? AND data = ?').all(localId, hoje());
// Ordem da fila: preferencial primeiro, depois quem tirou a senha antes.
const naFila = (lista) => lista.filter((s) => s.espera).sort((a, b) => (a.tipo === b.tipo ? a.id - b.id : a.tipo === 'P' ? -1 : 1));
const presente = (o) => o.visto_em && Date.now() - Date.parse(o.visto_em) < PRESENCA_MS;

/** A tela do atendente deu sinal: guarda que ele está ali (e em qual guichê). */
function presenca(db, localId, usuarioId, guiche) {
  if (!usuarioId) return;
  const onde = limpar(guiche, 30) || 'Guichê 1';
  db.prepare(`INSERT INTO senha_operadores (local_id, usuario_id, guiche, visto_em) VALUES (?, ?, ?, ?)
    ON CONFLICT (local_id, usuario_id) DO UPDATE SET guiche = excluded.guiche, visto_em = excluded.visto_em`).run(localId, usuarioId, onde, agora());
}

/**
 * Entrega as senhas que estão aguardando: cada uma vai para o atendente disponível que está há mais
 * tempo sem atender. Roda sempre que algo muda (senha nova, atendimento encerrado, atendente disponível).
 */
function distribuir(db, localId) {
  for (;;) {
    const dia = doDia(db, localId);
    const proxima = naFila(dia)[0];
    if (!proxima) return;
    const ocupados = new Set(dia.filter((s) => !s.espera && !s.encerrada_em).map((s) => s.guiche));
    const livre = db.prepare('SELECT * FROM senha_operadores WHERE local_id = ? AND disponivel = 1').all(localId)
      .filter((o) => presente(o) && !ocupados.has(o.guiche))
      .sort((a, b) => String(a.livre_desde ?? '').localeCompare(String(b.livre_desde ?? '')) || a.usuario_id - b.usuario_id)[0];
    if (!livre) return;
    db.prepare('UPDATE senhas SET espera = 0, guiche = ?, chamada_em = ?, operador_id = ? WHERE id = ?').run(livre.guiche, agora(), livre.usuario_id, proxima.id);
  }
}

/** Situação do dia: a senha na TV, as últimas chamadas, a fila, a próxima de cada tipo e os atendimentos. */
function situacao(db, localId, guiche = null, usuarioId = null) {
  if (usuarioId) { presenca(db, localId, usuarioId, guiche); distribuir(db, localId); }
  const dia = doDia(db, localId);
  const chamadas = dia.filter((s) => !s.espera);
  const porChamada = [...chamadas].sort((a, b) => (b.repetida_em ?? b.chamada_em).localeCompare(a.repetida_em ?? a.chamada_em) || b.id - a.id);
  const maior = (tipo) => dia.filter((s) => s.tipo === tipo).reduce((m, s) => Math.max(m, s.numero), 0);
  const encerradas = chamadas.filter((s) => s.encerrada_em);
  const comEspera = chamadas.filter((s) => s.emitida_em);
  const onde = limpar(guiche, 30);
  const fila = naFila(dia);
  const proximaDaFila = (tipo) => fila.find((s) => s.tipo === tipo);
  // A senha que este guichê está atendendo agora (chamada e ainda não encerrada).
  const aberta = onde ? chamadas.filter((s) => s.guiche === onde && !s.encerrada_em).sort((a, b) => b.id - a.id)[0] : null;
  const emAberto = new Map(chamadas.filter((s) => !s.encerrada_em).map((s) => [s.guiche, s]));
  const eu = usuarioId ? db.prepare('SELECT * FROM senha_operadores WHERE local_id = ? AND usuario_id = ?').get(localId, usuarioId) : null;
  return {
    atual: porChamada[0] ? publica(porChamada[0]) : null,
    ultimas: porChamada.slice(1, 5).map(publica),
    // O botão "chamar próxima" pega quem está na fila; sem fila, segue a numeração.
    proxima: {
      N: proximaDaFila('N') ? codigo(proximaDaFila('N')) : formatar('N', maior('N') + 1),
      P: proximaDaFila('P') ? codigo(proximaDaFila('P')) : formatar('P', maior('P') + 1),
    },
    chamadas_hoje: chamadas.length,
    fila: fila.slice(0, 40).map(publica),
    aguardando: fila.length,
    em_atendimento: aberta ? publica(aberta) : null,
    disponivel: Boolean(eu?.disponivel),
    // Quem está com a tela de atendimento aberta agora, na ordem em que vai receber a próxima senha.
    operadores: db.prepare(`SELECT o.*, u.nome FROM senha_operadores o JOIN usuarios u ON u.id = o.usuario_id WHERE o.local_id = ?`).all(localId)
      .filter(presente)
      .map((o) => ({ nome: o.nome, guiche: o.guiche, disponivel: Boolean(o.disponivel), atendendo: emAberto.get(o.guiche) ? codigo(emAberto.get(o.guiche)) : null, livre_desde: o.livre_desde }))
      .sort((a, b) => (Boolean(a.atendendo) - Boolean(b.atendendo)) || (b.disponivel - a.disponivel) || String(a.livre_desde ?? '').localeCompare(String(b.livre_desde ?? ''))),
    atendimentos: [...chamadas].sort((a, b) => b.chamada_em.localeCompare(a.chamada_em) || b.id - a.id).slice(0, 60).map(publica),
    encerrados_hoje: encerradas.length,
    tempo_medio_s: encerradas.length ? Math.round(encerradas.reduce((t, s) => t + segundos(s.chamada_em, s.encerrada_em), 0) / encerradas.length) : null,
    espera_media_s: comEspera.length ? Math.round(comEspera.reduce((t, s) => t + segundos(s.emitida_em, s.chamada_em), 0) / comEspera.length) : null,
    servicos: servicosDoPonto(db, localId),
    // Sugestões de assunto: os mais usados neste ponto.
    assuntos: db.prepare(`SELECT assunto FROM senhas WHERE local_id = ? AND assunto IS NOT NULL AND assunto <> ''
      GROUP BY assunto ORDER BY COUNT(*) DESC, MAX(id) DESC LIMIT 12`).all(localId).map((a) => a.assunto),
  };
}

/** Fecha o atendimento em aberto do guichê (com o assunto, se veio). Quem atendia volta a contar como livre a partir de agora. */
function fecharAberta(db, localId, guiche, assunto) {
  const texto = limpar(assunto, 80) || null;
  const r = db.prepare(`UPDATE senhas SET encerrada_em = ?, assunto = COALESCE(?, assunto)
    WHERE local_id = ? AND data = ? AND guiche = ? AND espera = 0 AND encerrada_em IS NULL`).run(agora(), texto, localId, hoje(), guiche);
  if (r.changes) db.prepare('UPDATE senha_operadores SET livre_desde = ? WHERE local_id = ? AND guiche = ?').run(agora(), localId, guiche);
}

/**
 * O cliente tira a senha no totem: CPF e o atendimento que ele quer. A senha entra na fila e, havendo
 * atendente livre, já sai chamada.
 */
function emitir(db, localId, { cpf, servico, preferencial } = {}) {
  const doc = digitos(cpf);
  if (!cpfValido(doc)) throw new ErroNegocio('CPF inválido. Confira os números.', 422);
  const servicos = servicosDoPonto(db, localId);
  const qual = servicos.find((s) => s === limpar(servico, 40));
  if (!qual) throw new ErroNegocio('Escolha o atendimento.', 422);
  const data = hoje();
  // Tocou duas vezes ou voltou ao totem: a senha que ainda aguarda é a mesma.
  let s = db.prepare('SELECT * FROM senhas WHERE local_id = ? AND data = ? AND cpf = ? AND espera = 1').get(localId, data, doc);
  if (!s) {
    const tipo = preferencial ? 'P' : 'N';
    const n = db.prepare('SELECT COALESCE(MAX(numero), 0) AS n FROM senhas WHERE local_id = ? AND data = ? AND tipo = ?').get(localId, data, tipo).n + 1;
    if (n > MAXIMO) throw new ErroNegocio('As senhas de hoje acabaram. Procure um atendente.', 409);
    const id = db.prepare(`INSERT INTO senhas (local_id, data, tipo, numero, guiche, chamada_em, espera, emitida_em, servico, cpf)
      VALUES (?, ?, ?, ?, '', ?, 1, ?, ?, ?)`).run(localId, data, tipo, n, agora(), agora(), qual, doc).lastInsertRowid;
    s = db.prepare('SELECT * FROM senhas WHERE id = ?').get(Number(id));
  }
  distribuir(db, localId);
  s = db.prepare('SELECT * FROM senhas WHERE id = ?').get(s.id);
  const naFrente = s.espera ? naFila(doDia(db, localId)).findIndex((x) => x.id === s.id) : 0;
  return { codigo: codigo(s), servico: s.servico, preferencial: s.tipo === 'P', guiche: s.espera ? null : s.guiche, na_frente: Math.max(0, naFrente), emitida_em: s.emitida_em };
}

/**
 * Chama a próxima senha do tipo: a que está aguardando na fila ou, sem fila, o número seguinte.
 * Com `numero`, chama uma senha específica (voltar numa que ficou para trás).
 * Chamar a próxima encerra o atendimento que este guichê tinha em aberto: é aí que o tempo dele fecha.
 */
function chamar(db, localId, { tipo = 'N', guiche, numero, assunto_anterior } = {}, usuarioId = null) {
  const t = String(tipo).toUpperCase();
  if (!TIPOS[t]) throw new ErroNegocio('Tipo de senha inválido.', 422);
  const onde = limpar(guiche, 30) || 'Guichê 1';
  const data = hoje();
  let n;
  let daFila = null;
  if (numero !== undefined && numero !== null && numero !== '') {
    n = Number(numero);
    if (!Number.isInteger(n) || n < 1 || n > MAXIMO) throw new ErroNegocio(`Informe um número de senha entre 1 e ${MAXIMO}.`, 422);
    daFila = db.prepare('SELECT * FROM senhas WHERE local_id = ? AND data = ? AND tipo = ? AND numero = ? AND espera = 1').get(localId, data, t, n) ?? null;
  } else {
    daFila = naFila(doDia(db, localId)).find((s) => s.tipo === t) ?? null;
    if (!daFila) {
      n = db.prepare('SELECT COALESCE(MAX(numero), 0) AS n FROM senhas WHERE local_id = ? AND data = ? AND tipo = ?').get(localId, data, t).n + 1;
      if (n > MAXIMO) throw new ErroNegocio(`As senhas de hoje chegaram a ${MAXIMO}. Zere a contagem para continuar.`, 409);
    }
  }
  fecharAberta(db, localId, onde, assunto_anterior);
  if (daFila) {
    db.prepare('UPDATE senhas SET espera = 0, guiche = ?, chamada_em = ?, operador_id = ? WHERE id = ?').run(onde, agora(), usuarioId, daFila.id);
  } else {
    db.prepare('INSERT INTO senhas (local_id, data, tipo, numero, guiche, chamada_em, criado_por, operador_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(localId, data, t, n, onde, agora(), usuarioId, usuarioId);
  }
  return situacao(db, localId, onde, usuarioId);
}

/** Encerra o atendimento em aberto do guichê. Se há senha aguardando e o atendente está disponível, a próxima já vem. */
function encerrar(db, localId, { guiche, assunto } = {}, usuarioId = null) {
  const onde = limpar(guiche, 30) || 'Guichê 1';
  if (!situacao(db, localId, onde).em_atendimento) throw new ErroNegocio('Este guichê não tem atendimento em aberto.', 409);
  fecharAberta(db, localId, onde, assunto);
  return situacao(db, localId, onde, usuarioId);
}

/** O atendente diz se está disponível para receber senha. Ao ficar disponível, entra no fim da vez. */
function disponibilidade(db, localId, usuarioId, { guiche, disponivel } = {}) {
  presenca(db, localId, usuarioId, guiche);
  db.prepare('UPDATE senha_operadores SET disponivel = ?, livre_desde = CASE WHEN ? = 1 THEN ? ELSE livre_desde END WHERE local_id = ? AND usuario_id = ?')
    .run(disponivel ? 1 : 0, disponivel ? 1 : 0, agora(), localId, usuarioId);
  return situacao(db, localId, guiche, usuarioId);
}

/** Corrige ou preenche o assunto de um atendimento (esqueceu de escrever na hora). */
function definirAssunto(db, localId, id, assunto, guiche = null) {
  const s = db.prepare('SELECT id FROM senhas WHERE id = ? AND local_id = ?').get(Number(id), localId);
  if (!s) throw new ErroNegocio('Senha não encontrada neste ponto.', 404);
  db.prepare('UPDATE senhas SET assunto = ? WHERE id = ?').run(limpar(assunto, 80) || null, s.id);
  return situacao(db, localId, guiche);
}

/** Chama de novo a senha do guichê (ou a que está na TV): o cliente não ouviu. Não mexe no tempo do atendimento. */
function repetir(db, localId, guiche = null) {
  const s = situacao(db, localId, guiche);
  const qual = s.em_atendimento ?? s.atual;
  if (!qual) throw new ErroNegocio('Ainda não há senha chamada hoje.', 409);
  db.prepare('UPDATE senhas SET repetida_em = ? WHERE id = ?').run(agora(), qual.id);
  return situacao(db, localId, guiche);
}

/** Recomeça a contagem do dia (apaga as senhas de hoje deste ponto, inclusive as que aguardam). */
function zerar(db, localId, guiche = null) {
  db.prepare('DELETE FROM senhas WHERE local_id = ? AND data = ?').run(localId, hoje());
  return situacao(db, localId, guiche);
}

// ------------------------------------------------------------------ Totem
/** O link do totem e os atendimentos oferecidos. A chave nasce na primeira consulta. */
function configuracao(db, localId) {
  let l = db.prepare('SELECT totem_chave FROM locais WHERE id = ?').get(localId);
  if (!l.totem_chave) {
    db.prepare('UPDATE locais SET totem_chave = ? WHERE id = ?').run(crypto.randomBytes(18).toString('base64url'), localId);
    l = db.prepare('SELECT totem_chave FROM locais WHERE id = ?').get(localId);
  }
  return { totem_chave: l.totem_chave, servicos: servicosDoPonto(db, localId) };
}

function configurar(db, localId, { servicos, novo_link } = {}) {
  if (servicos !== undefined) {
    const lista = [...new Set((Array.isArray(servicos) ? servicos : String(servicos).split('\n')).map((x) => limpar(x, 40)).filter(Boolean))];
    if (!lista.length) throw new ErroNegocio('Informe pelo menos um atendimento (ex.: Comercial).', 422);
    if (lista.length > 8) throw new ErroNegocio('No máximo 8 atendimentos, para caberem na tela do totem.', 422);
    db.prepare('UPDATE locais SET senha_servicos = ? WHERE id = ?').run(lista.join('\n'), localId);
  }
  // Link novo: o antigo para de funcionar (totem trocado, link que vazou).
  if (novo_link) db.prepare('UPDATE locais SET totem_chave = NULL WHERE id = ?').run(localId);
  return configuracao(db, localId);
}

/** O ponto dono da chave do totem (ou nada). */
function pontoDoTotem(db, chave) {
  if (typeof chave !== 'string' || chave.length < 16 || chave.length > 60) return null;
  return db.prepare("SELECT id, nome FROM locais WHERE totem_chave = ? AND status = 'ativo'").get(chave) ?? null;
}

module.exports = { TIPOS, situacao, chamar, emitir, encerrar, disponibilidade, definirAssunto, repetir, zerar, configuracao, configurar, pontoDoTotem, servicosDoPonto };
