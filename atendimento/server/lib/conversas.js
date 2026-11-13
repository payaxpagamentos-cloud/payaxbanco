'use strict';

const { agora, transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const envio = require('./envio');
const filas = require('./filas');
const wa = require('./whatsapp');

/**
 * Ciclo de vida do atendimento:
 *
 *   bot ──(a IA não resolve, ou o cliente pede gente)──> aguardando ──(atendente assume)──> humano ──> encerrada
 *    └──────────────────(a IA resolve sozinha)────────────────────────────────────────────────┘
 *
 * Um contato tem no máximo uma conversa aberta por vez (índice único no banco). Encerrada, a próxima
 * mensagem do cliente abre uma conversa nova — exceto quando é só a nota do CSAT da anterior.
 */

const JANELA_MS = 24 * 60 * 60 * 1000;
// Depois de encerrar, por quanto tempo uma mensagem do cliente ainda vale como nota do CSAT.
const CSAT_VALE_MIN = 60;

const MSG = {
  transferencia: 'Vou te transferir para um de nossos atendentes. Só um momento, por favor.',
  fora_horario: 'Nosso atendimento humano está fechado agora. Já registrei o seu pedido e a equipe responde assim que abrir.',
  encerramento: 'Atendimento encerrado. Se precisar de mais alguma coisa, é só mandar mensagem. Obrigado!',
  csat: 'Antes de ir: de 1 a 5, quanto você ficou satisfeito com este atendimento? (1 = muito ruim, 5 = muito bom)',
  csat_obrigado: 'Obrigado pela avaliação!',
  fila: 'Você é o {posicao}º da fila. Já estamos chamando um atendente.',
};

const cfgIa = (db, empresaId) => db.prepare('SELECT * FROM ia_config WHERE empresa_id = ?').get(empresaId) ?? {};
const mensagemDe = (cfg, chave) => (cfg?.[`mensagem_${chave}`]?.trim() || MSG[chave]);

// ---------- Contato ----------

/** Encontra ou cria o contato pelo número do WhatsApp. Atualiza o nome do perfil quando a Meta informa. */
function garantirContato(db, empresaId, telefone, nomePerfil = null) {
  const achado = db.prepare('SELECT * FROM contatos WHERE empresa_id = ? AND telefone = ?').get(empresaId, telefone);
  if (achado) {
    if (nomePerfil && nomePerfil !== achado.nome_perfil) {
      db.prepare('UPDATE contatos SET nome_perfil = ? WHERE id = ?').run(nomePerfil, achado.id);
      achado.nome_perfil = nomePerfil;
    }
    return achado;
  }
  const id = Number(db.prepare('INSERT INTO contatos (empresa_id, telefone, nome_perfil, primeiro_contato_em) VALUES (?, ?, ?, ?)')
    .run(empresaId, telefone, nomePerfil, agora()).lastInsertRowid);
  return db.prepare('SELECT * FROM contatos WHERE id = ?').get(id);
}

const nomeContato = (c) => c?.nome?.trim() || c?.nome_perfil?.trim() || c?.telefone || 'Cliente';

// ---------- Abertura ----------

const abertaDoContato = (db, contatoId) => db.prepare("SELECT * FROM conversas WHERE contato_id = ? AND estado <> 'encerrada'").get(contatoId);

/** Abre a conversa (estado 'bot': quem atende primeiro é sempre a atendente virtual). */
function abrir(db, { empresa, numero, contato }) {
  const id = Number(db.prepare(`INSERT INTO conversas (empresa_id, contato_id, numero_id, estado, aberta_em, ultima_mensagem_em, janela_expira_em)
    VALUES (?, ?, ?, 'bot', ?, ?, ?)`).run(empresa.id, contato.id, numero.id, agora(), agora(), new Date(Date.now() + JANELA_MS).toISOString()).lastInsertRowid);
  return db.prepare('SELECT * FROM conversas WHERE id = ?').get(id);
}

/** Conversa aberta do contato, ou uma nova. */
const abrirOuRetomar = (db, { empresa, numero, contato }) => abertaDoContato(db, contato.id) ?? abrir(db, { empresa, numero, contato });

/** Toda mensagem do cliente reabre a janela de 24 h da Meta. */
function tocarJanela(db, conversa, instante = new Date()) {
  const ts = new Date(instante).toISOString();
  db.prepare('UPDATE conversas SET ultima_mensagem_cliente_em = ?, ultima_mensagem_em = ?, janela_expira_em = ? WHERE id = ?')
    .run(ts, ts, new Date(new Date(instante).getTime() + JANELA_MS).toISOString(), conversa.id);
  db.prepare('UPDATE contatos SET ultimo_contato_em = ? WHERE id = ?').run(ts, conversa.contato_id);
}

/** Grava a mensagem que chegou do cliente. Devolve o id, ou null se o wa_id já estava gravado. */
function registrarEntrada(db, conversa, { tipo = 'texto', texto = null, waId = null, respondeWaId = null, midiaId = null,
  midiaArquivo = null, midiaNome = null, midiaMime = null, midiaBytes = null, criadaEm = null } = {}) {
  if (waId && db.prepare('SELECT 1 FROM mensagens WHERE wa_id = ?').get(waId)) return null;
  return Number(db.prepare(`INSERT INTO mensagens
      (conversa_id, empresa_id, direcao, autor, tipo, texto, wa_id, responde_wa_id, midia_id, midia_arquivo, midia_nome, midia_mime, midia_bytes, status, criada_em)
    VALUES (?, ?, 'entrada', 'cliente', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recebida', ?)`)
    .run(conversa.id, conversa.empresa_id, tipo, texto, waId, respondeWaId, midiaId, midiaArquivo, midiaNome, midiaMime, midiaBytes, criadaEm ?? agora()).lastInsertRowid);
}

// ---------- Transferência para a equipe humana ----------

/**
 * Tira a conversa da atendente virtual e põe na fila. É o caminho de saída da IA:
 * ela chama isto quando não resolve, quando o cliente pede uma pessoa ou quando o assunto exige decisão humana.
 * Avisa o cliente, entrega ao atendente mais livre e, fora do horário, diz que a equipe responde depois.
 */
function transferir(db, conversa, { fila = null, motivo = null, resumo = null, assunto = null, por = 'ia', usuario = null, avisar = true } = {}) {
  if (conversa.estado === 'encerrada') throw new ErroNegocio('Esta conversa já foi encerrada.');
  const destino = fila ?? filas.buscar(db, conversa.empresa_id, conversa.fila_id) ?? filas.filaPadrao(db, conversa.empresa_id);
  if (!destino) throw new ErroNegocio('A empresa não tem nenhuma fila de atendimento cadastrada.');
  const cfg = cfgIa(db, conversa.empresa_id);

  db.prepare(`UPDATE conversas SET estado = 'aguardando', fila_id = ?, atendente_id = NULL, assumida_em = NULL,
      motivo_transferencia = COALESCE(?, motivo_transferencia), resumo = COALESCE(?, resumo), assunto = COALESCE(?, assunto), transferida_em = ?
    WHERE id = ?`).run(destino.id, motivo, resumo, assunto, agora(), conversa.id);

  const aberta = filas.dentroHorario(destino);
  if (avisar) {
    envio.enfileirar(db, conversa, { autor: 'ia', tipo: 'texto', texto: aberta ? mensagemDe(cfg, 'transferencia') : mensagemDe(cfg, 'fora_horario') });
  }
  envio.registrarSistema(db, conversa, por === 'ia'
    ? `A atendente virtual transferiu para a fila ${destino.nome}${motivo ? `: ${motivo}` : '.'}`
    : `${usuario?.nome ?? 'A equipe'} transferiu para a fila ${destino.nome}${motivo ? `: ${motivo}` : '.'}`, { usuarioId: usuario?.id ?? null });
  db.prepare("INSERT INTO ia_eventos (empresa_id, conversa_id, tipo, nome, detalhe, criado_em) VALUES (?, ?, 'transferencia', ?, ?, ?)")
    .run(conversa.empresa_id, conversa.id, destino.nome, motivo, agora());

  const atual = db.prepare('SELECT * FROM conversas WHERE id = ?').get(conversa.id);
  const quem = aberta ? filas.atribuir(db, atual) : null;
  return { fila: destino, dentro_horario: aberta, atendente: quem };
}

/** O atendente assume uma conversa que está na fila. */
function assumir(db, empresaId, conversaId, usuario) {
  return transacao(db, () => {
    const c = db.prepare('SELECT * FROM conversas WHERE id = ? AND empresa_id = ?').get(conversaId, empresaId);
    if (!c) throw naoEncontrado('Conversa');
    if (c.estado === 'encerrada') throw new ErroNegocio('Esta conversa já foi encerrada.');
    if (c.estado === 'humano' && c.atendente_id && c.atendente_id !== usuario.id) {
      throw new ErroNegocio('Outro atendente já está nesta conversa.', 409);
    }
    const fila = filas.buscar(db, c.empresa_id, c.fila_id);
    if (fila) filas.exigirAcessoFila(db, usuario, fila);
    db.prepare("UPDATE conversas SET estado = 'humano', atendente_id = ?, assumida_em = COALESCE(assumida_em, ?) WHERE id = ?").run(usuario.id, agora(), c.id);
    envio.registrarSistema(db, c, `${usuario.nome} assumiu o atendimento.`, { usuarioId: usuario.id });
    return db.prepare('SELECT * FROM conversas WHERE id = ?').get(c.id);
  });
}

/** Devolve a conversa para a fila (o atendente não vai seguir com ela). */
function devolver(db, conversa, usuario, motivo = null) {
  if (conversa.estado !== 'humano') throw new ErroNegocio('Só uma conversa em atendimento humano pode voltar para a fila.');
  db.prepare("UPDATE conversas SET estado = 'aguardando', atendente_id = NULL, assumida_em = NULL, transferida_em = ? WHERE id = ?").run(agora(), conversa.id);
  envio.registrarSistema(db, conversa, `${usuario.nome} devolveu para a fila${motivo ? `: ${motivo}` : '.'}`, { usuarioId: usuario.id });
  const atual = db.prepare('SELECT * FROM conversas WHERE id = ?').get(conversa.id);
  return filas.atribuir(db, atual);
}

/** Devolve a conversa para a atendente virtual (ex.: o cliente só queria uma informação simples). */
function voltarParaIa(db, conversa, usuario) {
  if (conversa.estado === 'encerrada') throw new ErroNegocio('Esta conversa já foi encerrada.');
  db.prepare("UPDATE conversas SET estado = 'bot', atendente_id = NULL, fila_id = NULL, assumida_em = NULL WHERE id = ?").run(conversa.id);
  envio.registrarSistema(db, conversa, `${usuario.nome} devolveu o atendimento para a atendente virtual.`, { usuarioId: usuario.id });
  return db.prepare('SELECT * FROM conversas WHERE id = ?').get(conversa.id);
}

// ---------- Encerramento e avaliação ----------

/**
 * Encerra o atendimento. `resolvidaPor`: 'ia' (resolveu sozinha), 'humano', 'abandono' (cliente parou de responder)
 * ou 'cliente'. Com o CSAT ligado e a janela aberta, pergunta a nota de 1 a 5.
 */
function encerrar(db, conversa, { resolvidaPor = 'humano', usuario = null, mensagem = null, avisar = true, pedirCsat = null } = {}) {
  if (conversa.estado === 'encerrada') return conversa;
  const cfg = cfgIa(db, conversa.empresa_id);
  const aberta = wa.janelaAberta(conversa);
  const comCsat = (pedirCsat ?? Boolean(cfg.pedir_csat)) && aberta && resolvidaPor !== 'abandono';

  if (avisar && aberta) {
    const texto = mensagem?.trim() || mensagemDe(cfg, 'encerramento');
    envio.enfileirar(db, conversa, { autor: usuario ? 'atendente' : 'ia', usuarioId: usuario?.id ?? null, tipo: 'texto', texto });
    if (comCsat) envio.enfileirar(db, conversa, { autor: 'ia', tipo: 'texto', texto: mensagemDe(cfg, 'csat') });
  }
  db.prepare("UPDATE conversas SET estado = 'encerrada', resolvida_por = ?, encerrada_em = ?, csat_pedido_em = ? WHERE id = ?")
    .run(resolvidaPor, agora(), comCsat ? agora() : null, conversa.id);
  envio.registrarSistema(db, conversa, usuario ? `${usuario.nome} encerrou o atendimento.`
    : resolvidaPor === 'abandono' ? 'Encerrada automaticamente: o cliente parou de responder.'
      : resolvidaPor === 'ia' ? 'A atendente virtual resolveu e encerrou o atendimento.' : 'Atendimento encerrado.', { usuarioId: usuario?.id ?? null });
  if (resolvidaPor === 'ia') {
    db.prepare("INSERT INTO ia_eventos (empresa_id, conversa_id, tipo, nome, criado_em) VALUES (?, ?, 'encerramento', 'resolvida pela IA', ?)")
      .run(conversa.empresa_id, conversa.id, agora());
  }
  // Libera a vaga do atendente para a próxima da fila.
  if (conversa.fila_id) filas.girarFila(db, conversa.empresa_id, conversa.fila_id);
  return db.prepare('SELECT * FROM conversas WHERE id = ?').get(conversa.id);
}

/**
 * A mensagem do cliente é a nota do CSAT de uma conversa que acabou de ser encerrada?
 * Nesse caso grava a nota e não abre conversa nova.
 */
function tentarCsat(db, contato, texto) {
  const pendente = db.prepare(`SELECT * FROM conversas WHERE contato_id = ? AND estado = 'encerrada' AND csat_pedido_em IS NOT NULL AND csat_nota IS NULL
    ORDER BY id DESC LIMIT 1`).get(contato.id);
  if (!pendente || Date.now() - Date.parse(pendente.csat_pedido_em) > CSAT_VALE_MIN * 60_000) return null;
  const nota = Number(String(texto ?? '').trim().match(/^([1-5])(\s|$|\.|!)/)?.[1]);
  if (!nota) return null;
  const cfg = cfgIa(db, pendente.empresa_id);
  db.prepare('UPDATE conversas SET csat_nota = ? WHERE id = ?').run(nota, pendente.id);
  envio.registrarSistema(db, pendente, `O cliente avaliou o atendimento com nota ${nota}.`);
  if (wa.janelaAberta(pendente)) envio.enfileirar(db, pendente, { autor: 'ia', tipo: 'texto', texto: mensagemDe(cfg, 'csat_obrigado') });
  return { conversa: pendente, nota };
}

/** Comentário escrito do CSAT (quando o cliente manda a nota e depois explica). */
function registrarComentarioCsat(db, conversa, texto) {
  if (conversa.csat_nota && !conversa.csat_comentario) {
    db.prepare('UPDATE conversas SET csat_comentario = ? WHERE id = ?').run(String(texto).slice(0, 500), conversa.id);
    return true;
  }
  return false;
}

// ---------- Leitura para o painel ----------

const COLUNAS_LISTA = `c.id, c.estado, c.fila_id, c.atendente_id, c.assunto, c.intencao, c.prioridade, c.resolvida_por, c.motivo_transferencia,
  c.aberta_em, c.transferida_em, c.assumida_em, c.encerrada_em, c.ultima_mensagem_em, c.ultima_mensagem_cliente_em, c.janela_expira_em, c.csat_nota,
  ct.id AS contato_id, ct.telefone, ct.nome AS contato_nome, ct.nome_perfil, ct.documento,
  f.nome AS fila_nome, u.nome AS atendente_nome`;

const JUNCOES = `FROM conversas c
  JOIN contatos ct ON ct.id = c.contato_id
  LEFT JOIN filas f ON f.id = c.fila_id
  LEFT JOIN usuarios u ON u.id = c.atendente_id`;

/** Última mensagem e quantas não foram lidas pela equipe (as do cliente depois da última resposta). */
function enriquecer(db, c) {
  const ultima = db.prepare("SELECT tipo, texto, autor, criada_em FROM mensagens WHERE conversa_id = ? AND tipo <> 'sistema' ORDER BY id DESC LIMIT 1").get(c.id);
  return {
    ...c,
    nome: c.contato_nome?.trim() || c.nome_perfil?.trim() || c.telefone,
    ultima_mensagem: ultima ? { autor: ultima.autor, tipo: ultima.tipo, texto: ultima.texto, criada_em: ultima.criada_em } : null,
    espera_s: c.estado === 'aguardando' && c.transferida_em ? Math.round((Date.now() - Date.parse(c.transferida_em)) / 1000) : 0,
    janela_aberta: wa.janelaAberta(c),
  };
}

/**
 * Caixa de entrada. `caixa`: 'minhas' (do atendente), 'aguardando' (na fila), 'bot' (com a atendente virtual),
 * 'abertas' (tudo que não encerrou) ou 'encerradas'.
 */
function listar(db, empresaId, { caixa = 'abertas', usuario = null, filaId = null, atendenteId = null, busca = '', de = null, ate = null,
  resolvidaPor = null, pagina = 1, porPagina = 30 } = {}) {
  const onde = ['c.empresa_id = ?'];
  const args = [empresaId];
  if (caixa === 'minhas') { onde.push("c.estado = 'humano' AND c.atendente_id = ?"); args.push(usuario.id); }
  else if (caixa === 'aguardando') onde.push("c.estado = 'aguardando'");
  else if (caixa === 'bot') onde.push("c.estado = 'bot'");
  else if (caixa === 'encerradas') onde.push("c.estado = 'encerrada'");
  else onde.push("c.estado <> 'encerrada'");
  if (filaId) { onde.push('c.fila_id = ?'); args.push(Number(filaId)); }
  if (atendenteId) { onde.push('c.atendente_id = ?'); args.push(Number(atendenteId)); }
  if (resolvidaPor) { onde.push('c.resolvida_por = ?'); args.push(resolvidaPor); }
  if (de) { onde.push('c.aberta_em >= ?'); args.push(de); }
  if (ate) { onde.push('c.aberta_em < ?'); args.push(ate); }
  if (busca) {
    onde.push('(ct.telefone LIKE ? OR ct.nome LIKE ? OR ct.nome_perfil LIKE ? OR c.assunto LIKE ? OR ct.documento LIKE ?)');
    const t = `%${busca}%`;
    args.push(t, t, t, t, t);
  }
  // O atendente só vê as filas que atende (e as próprias conversas).
  if (usuario?.perfil === 'atendente' && caixa !== 'minhas') {
    onde.push('(c.atendente_id = ? OR c.fila_id IS NULL OR c.fila_id IN (SELECT fila_id FROM fila_usuarios WHERE usuario_id = ?))');
    args.push(usuario.id, usuario.id);
  }
  const filtro = onde.join(' AND ');
  const total = Number(db.prepare(`SELECT COUNT(*) AS n ${JUNCOES} WHERE ${filtro}`).all(...args)[0].n);
  const p = Math.max(1, Number(pagina) || 1);
  const itens = db.prepare(`SELECT ${COLUNAS_LISTA} ${JUNCOES} WHERE ${filtro}
    ORDER BY CASE c.estado WHEN 'aguardando' THEN 0 WHEN 'humano' THEN 1 WHEN 'bot' THEN 2 ELSE 3 END,
      CASE c.prioridade WHEN 'alta' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
      COALESCE(c.ultima_mensagem_em, c.aberta_em) DESC
    LIMIT ? OFFSET ?`).all(...args, porPagina, (p - 1) * porPagina).map((c) => enriquecer(db, c));
  return { itens, total, pagina: p, por_pagina: porPagina };
}

/** A conversa no mesmo formato da caixa de entrada (com fila, atendente e nome do contato). */
function resumo(db, empresaId, conversaId) {
  const c = db.prepare(`SELECT ${COLUNAS_LISTA} ${JUNCOES} WHERE c.id = ? AND c.empresa_id = ?`).get(conversaId, empresaId);
  if (!c) throw naoEncontrado('Conversa');
  return enriquecer(db, c);
}

/** Conversa com o histórico completo, as notas e as etiquetas. */
function detalhe(db, empresaId, conversaId, { limiteMensagens = 300 } = {}) {
  const c = db.prepare(`SELECT ${COLUNAS_LISTA}, c.resumo, c.csat_comentario, c.mensagens_ia, c.numero_id, c.contato_id, c.empresa_id ${JUNCOES}
    WHERE c.id = ? AND c.empresa_id = ?`).get(conversaId, empresaId);
  if (!c) throw naoEncontrado('Conversa');
  const mensagens = db.prepare(`SELECT id, direcao, autor, usuario_id, tipo, texto, midia_arquivo, midia_nome, midia_mime, midia_bytes,
      wa_id, responde_wa_id, status, erro, criada_em, enviada_em,
      (SELECT nome FROM usuarios WHERE id = mensagens.usuario_id) AS usuario_nome
    FROM mensagens WHERE conversa_id = ? ORDER BY id DESC LIMIT ?`).all(conversaId, limiteMensagens).reverse();
  return {
    ...enriquecer(db, c),
    contato: db.prepare('SELECT * FROM contatos WHERE id = ?').get(c.contato_id),
    mensagens,
    notas: db.prepare(`SELECT n.id, n.texto, n.criada_em, u.nome AS usuario_nome FROM notas n LEFT JOIN usuarios u ON u.id = n.usuario_id
      WHERE n.conversa_id = ? ORDER BY n.id`).all(conversaId),
    etiquetas: db.prepare(`SELECT e.id, e.nome, e.cor FROM conversa_etiquetas ce JOIN etiquetas e ON e.id = ce.etiqueta_id
      WHERE ce.conversa_id = ? ORDER BY e.nome`).all(conversaId),
    eventos_ia: db.prepare(`SELECT tipo, nome, detalhe, tokens_entrada, tokens_saida, ms, criado_em FROM ia_eventos
      WHERE conversa_id = ? ORDER BY id`).all(conversaId),
    chamados: db.prepare('SELECT id, protocolo, assunto, status, criado_em FROM chamados WHERE conversa_id = ? ORDER BY id').all(conversaId),
  };
}

module.exports = {
  JANELA_MS, CSAT_VALE_MIN, MSG, mensagemDe, cfgIa,
  garantirContato, nomeContato, abertaDoContato, abrir, abrirOuRetomar, tocarJanela, registrarEntrada,
  transferir, assumir, devolver, voltarParaIa, encerrar, tentarCsat, registrarComentarioCsat,
  listar, detalhe, resumo, enriquecer,
};
