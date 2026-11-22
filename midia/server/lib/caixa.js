'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { agora, transacao } = require('../db');
const { ErroNegocio } = require('./erros');
const mime = require('./mime');
const crm = require('./crm');
const email = require('./email');

/**
 * A caixa de entrada do CRM.
 *
 * O que chega pelo servidor de e-mail da plataforma (lib/smtp-servidor.js) para aqui, e o que a equipe
 * responde sai daqui. A razão de existir é simples: a conversa com o cliente estava espalhada na caixa
 * pessoal de cada um. Com ela dentro do CRM, **a mensagem fica grudada no lead** — quem pega a conversa
 * amanhã vê o que foi dito ontem, sem pedir print para ninguém.
 *
 * O corpo em texto fica no banco (é o que o painel mostra e o que a busca encontra); a mensagem original
 * inteira, com anexos e cabeçalhos, fica em disco como `.eml`. Essa é a cópia que vale como prova — e é
 * dela que os anexos são extraídos na hora do download, sem ocupar espaço duas vezes.
 *
 * Nada de HTML de fora é renderizado no painel: o que se lê é o texto. Mensagem de origem desconhecida
 * não executa nada aqui dentro.
 */

const LIMITE_TEXTO = 60_000;
// A prévia mostra o que a pessoa escreveu agora, não o trecho citado da mensagem anterior.
const semCitacao = (texto) => {
  const linhas = String(texto ?? '').split('\n');
  const corte = linhas.findIndex((l) => /^\s*>/.test(l) || /^(Em .+ escreveu:|On .+ wrote:)\s*$/i.test(l.trim()));
  return (corte > 0 ? linhas.slice(0, corte) : linhas).join('\n');
};
const previaDe = (texto) => (semCitacao(texto).replace(/\s+/g, ' ').trim() || String(texto ?? '').replace(/\s+/g, ' ').trim()).slice(0, 180);

const pastaDoMes = (quando) => path.join(config.entrada.pasta, String(quando).slice(0, 7));

/** Guarda a mensagem original em disco e devolve o caminho relativo. */
function guardarOriginal(bruto, quando) {
  const pasta = pastaDoMes(quando);
  fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
  const nome = `${quando.replace(/[^0-9]/g, '').slice(0, 14)}-${crypto.randomBytes(8).toString('hex')}.eml`;
  fs.writeFileSync(path.join(pasta, nome), bruto, { mode: 0o600 });
  return path.join(String(quando).slice(0, 7), nome);
}

const caminhoOriginal = (relativo) => path.join(config.entrada.pasta, relativo);

/**
 * A quem esta mensagem pertence. Pelo endereço de quem escreveu, acha o lead em aberto, o anunciante ou
 * o ponto já cadastrado. Não cria lead sozinho de propósito: caixa de e-mail recebe spam, e lead que
 * nasce sozinho entope o funil. Quem decide é a equipe, com um botão.
 */
function vincular(db, endereco) {
  if (!endereco) return {};
  const lead = db.prepare(`SELECT id FROM leads WHERE lower(email) = ?
    ORDER BY CASE WHEN etapa IN ('ganho','perdido') THEN 1 ELSE 0 END, atualizado_em DESC LIMIT 1`).get(endereco);
  const anunciante = db.prepare('SELECT id FROM anunciantes WHERE lower(email) = ? LIMIT 1').get(endereco);
  const local = db.prepare('SELECT id FROM locais WHERE lower(email) = ? LIMIT 1').get(endereco);
  return { lead_id: lead?.id ?? null, anunciante_id: anunciante?.id ?? null, local_id: local?.id ?? null };
}

/** O endereço da empresa para o qual a mensagem veio (o primeiro destinatário que for um endereço cadastrado). */
function enderecoDe(db, destinos) {
  const achar = db.prepare('SELECT * FROM enderecos_email WHERE endereco = ? AND ativo = 1');
  for (const d of destinos) {
    const e = achar.get(String(d ?? '').trim().toLowerCase());
    if (e) return e;
  }
  return null;
}

/**
 * Quem pode ver: o e-mail de um endereço que é de uma pessoa aparece para ela, para o administrador e
 * para o master. O operador vê os dele e os de endereços sem dono (comercial@, contato@…).
 */
function escopo(filtros) {
  const onde = [];
  const p = [];
  if (filtros._empresa != null) { onde.push('e.empresa_id = ?'); p.push(filtros._empresa); }
  if (filtros._operador) {
    onde.push('(e.endereco_id IS NULL OR e.endereco_id IN (SELECT id FROM enderecos_email WHERE usuario_id IS NULL OR usuario_id = ?))');
    p.push(filtros._operador);
  }
  return [onde, p];
}

function podeVer(db, id, usuario) {
  if (usuario.perfil !== 'operador') return true;
  const e = db.prepare(`SELECT en.usuario_id FROM emails e LEFT JOIN enderecos_email en ON en.id = e.endereco_id WHERE e.id = ?`).get(id);
  return !e || !e.usuario_id || e.usuario_id === usuario.id;
}

/** A conversa a que esta mensagem pertence (pergunta e resposta ficam juntas). */
function acharThread(db, lida) {
  const candidatos = [lida.em_resposta_a, ...(lida.referencias ?? [])].filter(Boolean);
  for (const id of candidatos) {
    const achado = db.prepare('SELECT thread FROM emails WHERE message_id = ? AND thread IS NOT NULL LIMIT 1').get(id);
    if (achado?.thread) return achado.thread;
  }
  return lida.message_id ?? crypto.randomUUID();
}

/** Uma mensagem que chegou: lê, guarda e liga a quem for de direito. */
function receber(db, { bruto, de, para, ip = null }) {
  const lida = mime.ler(bruto);
  const quando = lida.data ?? agora();
  const remetente = lida.de || String(de ?? '').toLowerCase();
  const destinos = (lida.para.length ? lida.para : [].concat(para ?? [])).join(', ');
  const arquivo = guardarOriginal(bruto, quando);

  return transacao(db, () => {
    const vinculo = vincular(db, remetente);
    // O envelope (para quem o servidor entregou) vale mais que o cabeçalho, que o remetente escreve como quer.
    const endereco = enderecoDe(db, [].concat(para ?? [], lida.para));
    const campos = {
      direcao: 'entrada',
      de: remetente || 'desconhecido',
      de_nome: lida.de_nome || null,
      para: destinos,
      assunto: lida.assunto || '(sem assunto)',
      previa: previaDe(lida.texto),
      texto: String(lida.texto ?? '').slice(0, LIMITE_TEXTO),
      message_id: lida.message_id,
      em_resposta_a: lida.em_resposta_a,
      thread: acharThread(db, lida),
      arquivo,
      tamanho: Buffer.byteLength(bruto),
      anexos: lida.anexos.length,
      ...vinculo,
      ...(endereco ? { endereco_id: endereco.id, ...(endereco.empresa_id ? { empresa_id: endereco.empresa_id } : {}) } : {}),
      ip,
      recebido_em: quando,
      criado_em: agora(),
    };
    const id = Number(db.prepare(`INSERT INTO emails (${Object.keys(campos).join(', ')})
      VALUES (${Object.keys(campos).map(() => '?').join(', ')})`).run(...Object.values(campos)).lastInsertRowid);

    // Chegou e-mail de alguém do funil: entra no histórico do lead na hora.
    if (vinculo.lead_id) {
      crm.anotar(db, vinculo.lead_id, { tipo: 'email', texto: `Recebido: ${campos.assunto} — ${campos.previa}` });
    }
    return { id, ...campos };
  });
}

/** A caixa: o que chegou, o que foi respondido, quem está sem resposta. */
function listar(db, filtros = {}) {
  const onde = [];
  const p = [];
  if (filtros.caixa === 'tudo') { /* a conversa inteira: entrada e saída */ }
  else if (filtros.caixa === 'arquivados') onde.push('e.arquivado_em IS NOT NULL');
  else if (filtros.caixa === 'enviados') onde.push("e.direcao = 'saida'");
  else if (filtros.caixa === 'nao_lidos') onde.push("e.direcao = 'entrada' AND e.lido_em IS NULL AND e.arquivado_em IS NULL");
  else onde.push("e.arquivado_em IS NULL AND e.direcao = 'entrada'");
  if (filtros.lead_id) { onde.push('e.lead_id = ?'); p.push(Number(filtros.lead_id)); }
  if (filtros.caixa === 'meus') { onde.push('e.endereco_id IN (SELECT id FROM enderecos_email WHERE usuario_id = ?)'); p.push(filtros._usuario ?? 0); }
  const [ondeEscopo, pEscopo] = escopo(filtros);
  onde.push(...ondeEscopo); p.push(...pEscopo);
  if (filtros.busca) {
    onde.push('(e.de LIKE ? OR e.assunto LIKE ? OR e.previa LIKE ? OR e.para LIKE ?)');
    const b = `%${String(filtros.busca).trim()}%`;
    p.push(b, b, b, b);
  }
  const itens = db.prepare(`SELECT e.id, e.direcao, e.de, e.de_nome, e.para, e.assunto, e.previa, e.anexos, e.tamanho,
      e.lead_id, e.anunciante_id, e.local_id, e.lido_em, e.arquivado_em, e.recebido_em, e.thread,
      l.nome AS lead, l.etapa AS lead_etapa, a.nome AS anunciante, pt.nome AS ponto
    FROM emails e LEFT JOIN leads l ON l.id = e.lead_id LEFT JOIN anunciantes a ON a.id = e.anunciante_id
    LEFT JOIN locais pt ON pt.id = e.local_id
    ${onde.length ? `WHERE ${onde.join(' AND ')}` : ''}
    ORDER BY e.recebido_em DESC, e.id DESC LIMIT 200`).all(...p);

  const e2 = ondeEscopo.length ? ` AND ${ondeEscopo.join(' AND ')}` : '';
  const n = db.prepare(`SELECT
      COUNT(*) FILTER (WHERE direcao = 'entrada' AND lido_em IS NULL AND arquivado_em IS NULL) AS nao_lidos,
      COUNT(*) FILTER (WHERE direcao = 'entrada' AND arquivado_em IS NULL) AS na_caixa,
      COUNT(*) FILTER (WHERE direcao = 'entrada' AND lead_id IS NULL AND arquivado_em IS NULL) AS sem_vinculo,
      COUNT(*) FILTER (WHERE direcao = 'saida') AS enviados
    FROM emails e WHERE 1 = 1${e2}`).get(...pEscopo);

  // Quem escreveu e ainda não teve resposta: é a fila que não pode crescer.
  const semResposta = db.prepare(`SELECT COUNT(*) AS n FROM emails e WHERE e.direcao = 'entrada' AND e.arquivado_em IS NULL
    AND NOT EXISTS (SELECT 1 FROM emails r WHERE r.direcao = 'saida' AND r.thread = e.thread AND r.recebido_em > e.recebido_em)
    ${e2}`).get(...pEscopo).n;

  return { itens, totais: { ...n, sem_resposta: semResposta }, servidor: estado() };
}

function ler(db, id) {
  const e = db.prepare(`SELECT e.*, l.nome AS lead, l.etapa AS lead_etapa, a.nome AS anunciante, pt.nome AS ponto
    FROM emails e LEFT JOIN leads l ON l.id = e.lead_id LEFT JOIN anunciantes a ON a.id = e.anunciante_id
    LEFT JOIN locais pt ON pt.id = e.local_id WHERE e.id = ?`).get(id);
  if (!e) throw new ErroNegocio('Mensagem não encontrada.', 404);
  const anexos = listarAnexos(e).map(({ nome, mime: tipo, tamanho }, indice) => ({ indice, nome, mime: tipo, tamanho }));
  const conversa = e.thread
    ? db.prepare(`SELECT id, direcao, de, para, assunto, previa, recebido_em FROM emails
        WHERE thread = ? AND id <> ? ORDER BY recebido_em`).all(e.thread, e.id)
    : [];
  return { ...e, anexos, conversa };
}

/** Os anexos saem do arquivo original na hora do download: não há cópia guardada duas vezes. */
function listarAnexos(e) {
  if (!e.arquivo || !e.anexos) return [];
  try {
    return mime.ler(fs.readFileSync(caminhoOriginal(e.arquivo))).anexos;
  } catch {
    return [];
  }
}

function anexo(db, id, indice) {
  const e = db.prepare('SELECT arquivo, anexos FROM emails WHERE id = ?').get(id);
  if (!e) throw new ErroNegocio('Mensagem não encontrada.', 404);
  const achado = listarAnexos(e)[Number(indice)];
  if (!achado) throw new ErroNegocio('Anexo não encontrado.', 404);
  return achado;
}

/** A mensagem original, como chegou. É o que se guarda quando a conversa vira discussão. */
function original(db, id) {
  const e = db.prepare('SELECT arquivo, assunto FROM emails WHERE id = ?').get(id);
  if (!e?.arquivo) throw new ErroNegocio('Mensagem original não encontrada.', 404);
  return { conteudo: fs.readFileSync(caminhoOriginal(e.arquivo)), nome: `${String(e.assunto).replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'mensagem'}.eml` };
}

const marcarLido = (db, id, lido = true) => {
  db.prepare('UPDATE emails SET lido_em = ? WHERE id = ?').run(lido ? agora() : null, id);
  return ler(db, id);
};

const arquivar = (db, id, arquivado = true) => {
  db.prepare('UPDATE emails SET arquivado_em = ?, lido_em = COALESCE(lido_em, ?) WHERE id = ?')
    .run(arquivado ? agora() : null, arquivado ? agora() : null, id);
  return ler(db, id);
};

/** Liga (ou desliga) a mensagem de um lead. */
function vincularLead(db, id, leadId) {
  if (leadId && !db.prepare('SELECT 1 FROM leads WHERE id = ?').get(leadId)) throw new ErroNegocio('Lead não encontrado.', 422);
  db.prepare('UPDATE emails SET lead_id = ? WHERE id = ?').run(leadId ?? null, id);
  if (leadId) {
    const e = db.prepare('SELECT assunto, previa FROM emails WHERE id = ?').get(id);
    crm.anotar(db, leadId, { tipo: 'email', texto: `E-mail ligado a este lead: ${e.assunto} — ${e.previa}` });
  }
  return ler(db, id);
}

/** Lead novo a partir de quem escreveu: o caminho de quem chegou pela caixa e virou conversa. */
function virarLead(db, id, { usuarioId = null, tipo = 'anunciante' } = {}) {
  const e = db.prepare('SELECT * FROM emails WHERE id = ?').get(id);
  if (!e) throw new ErroNegocio('Mensagem não encontrada.', 404);
  if (e.lead_id) throw new ErroNegocio('Esta mensagem já está ligada a um lead.', 409);
  if (!e.de || e.de === 'desconhecido') throw new ErroNegocio('Esta mensagem não tem um remetente válido.', 422);
  return transacao(db, () => {
    const campos = {
      nome: e.de_nome || e.de.split('@')[0],
      tipo,
      email: e.de,
      origem: 'site',
      etapa: 'novo',
      mensagem: String(e.texto ?? '').slice(0, 500),
      criado_por: usuarioId,
      empresa_id: e.empresa_id ?? null,
      criado_em: agora(),
      atualizado_em: agora(),
    };
    const leadId = Number(db.prepare(`INSERT INTO leads (${Object.keys(campos).join(', ')})
      VALUES (${Object.keys(campos).map(() => '?').join(', ')})`).run(...Object.values(campos)).lastInsertRowid);
    crm.anotar(db, leadId, { tipo: 'email', texto: `Chegou por e-mail: ${e.assunto} — ${e.previa}`, usuarioId });
    // As outras mensagens do mesmo endereço vão junto: a conversa inteira fica na ficha.
    db.prepare('UPDATE emails SET lead_id = ? WHERE lead_id IS NULL AND lower(de) = ?').run(leadId, e.de);
    return { lead_id: leadId, email: ler(db, id) };
  });
}

/**
 * Responder (ou escrever do zero). Sai pelo servidor de envio configurado (MIDIA_SMTP_*), fica guardado
 * aqui como mensagem enviada e entra no histórico do lead. Responder mantém a conversa amarrada pelos
 * identificadores do e-mail, então a resposta cai na mesma thread no programa de quem recebe.
 */
async function enviar(db, { para, assunto, texto, responder_a = null, lead_id = null, usuarioId = null, empresa_id = null, remetente = null }) {
  const destino = String(para ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destino)) throw new ErroNegocio('Informe um e-mail de destino válido.', 422);
  if (!String(texto ?? '').trim()) throw new ErroNegocio('Escreva a mensagem.', 422);

  let anterior = null;
  if (responder_a) {
    anterior = db.prepare('SELECT * FROM emails WHERE id = ?').get(Number(responder_a));
    if (!anterior) throw new ErroNegocio('Mensagem respondida não encontrada.', 404);
  }
  const titulo = String(assunto ?? '').trim()
    || (anterior ? `Re: ${String(anterior.assunto).replace(/^(re:\s*)+/i, '')}` : '(sem assunto)');

  const r = await email.enviarDireto({
    para: destino,
    assunto: titulo,
    texto,
    // Quem tem endereço próprio escreve com ele; os demais, com o endereço geral do sistema.
    de: remetente ? { endereco: remetente.endereco, nome: remetente.nome, assinatura: remetente.assinatura } : null,
    emRespostaA: anterior?.message_id ?? null,
    referencias: anterior?.thread ? [anterior.thread, anterior.message_id].filter(Boolean) : [],
  });
  if (!r.enviado) throw new ErroNegocio(`Não foi possível enviar: ${r.motivo}`, 422);

  const leadId = lead_id ?? anterior?.lead_id ?? vincular(db, destino).lead_id ?? null;
  const campos = {
    direcao: 'saida',
    de: r.de,
    de_nome: null,
    para: destino,
    assunto: titulo,
    previa: previaDe(texto),
    texto: String(texto).slice(0, LIMITE_TEXTO),
    message_id: r.message_id,
    em_resposta_a: anterior?.message_id ?? null,
    thread: anterior?.thread ?? r.message_id,
    arquivo: null,
    tamanho: Buffer.byteLength(String(texto)),
    anexos: 0,
    lead_id: leadId,
    anunciante_id: anterior?.anunciante_id ?? null,
    local_id: anterior?.local_id ?? null,
    lido_em: agora(),
    criado_por: usuarioId,
    endereco_id: remetente?.id ?? null,
    empresa_id: anterior?.empresa_id ?? empresa_id ?? null,
    recebido_em: agora(),
    criado_em: agora(),
  };
  const id = Number(db.prepare(`INSERT INTO emails (${Object.keys(campos).join(', ')})
    VALUES (${Object.keys(campos).map(() => '?').join(', ')})`).run(...Object.values(campos)).lastInsertRowid);

  if (anterior && !anterior.lido_em) db.prepare('UPDATE emails SET lido_em = ? WHERE id = ?').run(agora(), anterior.id);
  if (leadId) crm.anotar(db, leadId, { tipo: 'email', texto: `Respondido: ${titulo} — ${campos.previa}`, usuarioId });
  return ler(db, id);
}

/** Como está o servidor de e-mail (o painel mostra isso no alto da caixa). */
let ligado = { ouvindo: false, porta: null, erro: null };
const registrarEstado = (novo) => { ligado = { ...ligado, ...novo }; };
const estado = () => ({
  dominios: config.entrada.dominios,
  configurado: config.entrada.dominios.length > 0,
  envio: email.configurado(),
  ...ligado,
});

module.exports = { podeVer, enderecoDe,
  receber, listar, ler, anexo, original, marcarLido, arquivar, vincularLead, virarLead, enviar,
  estado, registrarEstado, vincular, caminhoOriginal,
};
