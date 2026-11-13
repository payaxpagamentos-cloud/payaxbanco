'use strict';

const { agora, transacao } = require('../db');
const conversas = require('./conversas');
const envio = require('./envio');
const custo = require('./custo');
const wa = require('./whatsapp');

/**
 * A sala de espera da janela — a regra que mais derruba a conta da Meta.
 *
 * Um aviso de vencimento com três dias de folga não precisa ser pago hoje. Em vez de gastar
 * R$ 0,035 num template agora, a régua guarda o aviso aqui com um prazo. Então, uma de duas:
 *
 *   • o cliente escreve qualquer coisa antes do prazo → a janela de 24 h abre e o aviso sai
 *     de carona, como texto livre, de graça. Vários avisos do mesmo cliente saem juntos,
 *     numa mensagem só.
 *   • o prazo chega sem o cliente escrever → aí sim paga o template, no último momento útil.
 *
 * Num provedor, metade da base fala no WhatsApp em qualquer semana (suporte, boleto, dúvida).
 * Essa metade passa a receber os avisos de graça, sem ninguém fazer nada diferente.
 */

const esperando = (db, contatoId) => db.prepare(
  `SELECT * FROM pendencias WHERE contato_id = ? AND status = 'esperando' ORDER BY prazo, id`).all(contatoId);

/** Guarda o aviso na sala de espera. Devolve a pendência, ou null se já havia uma igual. */
function guardar(db, { empresa, regua, contato, alvo, texto, prazo }) {
  const referencia = String(alvo?.fatura_id ?? alvo?.vencimento ?? agora().slice(0, 10));
  // Confere antes de inserir em vez de usar INSERT OR IGNORE: o OR IGNORE engoliria também
  // um erro de verdade, e o aviso sumiria sem ninguém saber.
  const igual = db.prepare('SELECT 1 FROM pendencias WHERE regua_id = ? AND contato_id = ? AND referencia = ?')
    .get(regua.id, contato.id, referencia);
  if (igual) return null;
  const r = db.prepare(`INSERT INTO pendencias
      (empresa_id, regua_id, contato_id, referencia, dados, texto, prazo, status, criada_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'esperando', ?)`)
    .run(empresa.id, regua.id, contato.id, referencia, JSON.stringify(alvo ?? {}), texto, prazo, agora());
  return db.prepare('SELECT * FROM pendencias WHERE id = ?').get(Number(r.lastInsertRowid));
}

/**
 * O cliente escreveu: a janela abriu. Entrega agora, de graça, tudo o que estava esperando por ele.
 * Várias pendências viram UMA mensagem — três avisos numa conversa não custam nada, mas três
 * mensagens seguidas cansam o cliente.
 */
function aproveitarJanela(db, contatoId, { prefixo = null, respeitarHumano = true } = {}) {
  const lista = esperando(db, contatoId);
  if (!lista.length) return null;
  const conversa = conversas.abertaDoContato(db, contatoId);
  if (!conversa || !wa.janelaAberta(conversa)) return null;
  // Conversa com gente de verdade na linha não recebe aviso de cobrança por cima:
  // o aviso continua esperando, e não custa nada ficar esperando.
  if (respeitarHumano && conversa.estado === 'humano') return null;

  const precos = custo.precos(db, conversa.empresa_id);
  return transacao(db, () => {
    const textos = lista.map((p) => String(p.texto).trim()).filter(Boolean);
    const juntos = textos.length === 1 ? textos[0] : textos.map((t) => `• ${t}`).join('\n');
    const corpo = prefixo ? `${prefixo}\n\n${juntos}` : juntos;
    const mensagemId = envio.enfileirar(db, conversa, { autor: 'sistema', tipo: 'texto', texto: corpo });

    let economia = 0;
    for (const p of lista) {
      const regua = db.prepare('SELECT categoria FROM reguas WHERE id = ?').get(p.regua_id);
      const preco = precos[regua?.categoria ?? 'utilidade'] ?? 0;
      economia += preco;
      const disparo = db.prepare(`INSERT INTO disparos
          (empresa_id, regua_id, contato_id, conversa_id, mensagem_id, referencia, categoria, status, motivo, custo_milesimos, economia_milesimos, criado_em)
        VALUES (?, ?, ?, ?, ?, ?, 'servico', 'enviado', ?, 0, ?, ?)`)
        .run(p.empresa_id, p.regua_id, p.contato_id, conversa.id, mensagemId, p.referencia,
          'o cliente escreveu antes do prazo: o aviso saiu de graça pela janela', preco, agora());
      db.prepare(`UPDATE pendencias SET status = 'entregue', resolucao = 'janela', resolvida_em = ?, disparo_id = ? WHERE id = ?`)
        .run(agora(), Number(disparo.lastInsertRowid), p.id);
    }
    return { mensagem_id: mensagemId, pendencias: lista.length, economia_milesimos: economia };
  });
}

/** As pendências cujo prazo acabou: agora é pagar o template ou perder o aviso. */
const vencidas = (db, instante = agora()) => db.prepare(`SELECT p.*, r.empresa_id AS r_empresa,
    r.nome AS regua_nome, r.template, r.idioma, r.parametros, r.categoria, r.ativa
  FROM pendencias p JOIN reguas r ON r.id = p.regua_id
  WHERE p.status = 'esperando' AND p.prazo <= ? ORDER BY p.prazo, p.id LIMIT 2000`).all(instante);

/** Cancela o que não faz mais sentido mandar (fatura paga, contato bloqueado, régua desligada). */
function cancelar(db, pendenciaId, motivo) {
  db.prepare(`UPDATE pendencias SET status = 'cancelada', resolucao = ?, resolvida_em = ? WHERE id = ? AND status = 'esperando'`)
    .run(String(motivo).slice(0, 300), agora(), pendenciaId);
}

/** Painel: o que está esperando, por quanto tempo, e quanto já deixou de ser gasto esperando. */
function resumo(db, empresaId) {
  const precos = custo.precos(db, empresaId);
  const fila = db.prepare(`SELECT p.id, p.prazo, p.criada_em, p.referencia, r.nome AS regua, r.categoria,
      COALESCE(ct.nome, ct.nome_perfil) AS contato_nome, ct.telefone
    FROM pendencias p JOIN reguas r ON r.id = p.regua_id JOIN contatos ct ON ct.id = p.contato_id
    WHERE p.empresa_id = ? AND p.status = 'esperando' ORDER BY p.prazo LIMIT 200`).all(empresaId)
    .map((x) => ({ ...x, preco_milesimos: precos[x.categoria] ?? 0 }));
  const porFim = db.prepare(`SELECT resolucao, COUNT(*) AS quantos FROM pendencias
    WHERE empresa_id = ? AND status <> 'esperando' GROUP BY resolucao`).all(empresaId);
  const entregues = db.prepare(`SELECT COUNT(*) AS n FROM pendencias WHERE empresa_id = ? AND resolucao = 'janela'`).get(empresaId);
  return {
    esperando: fila.length,
    em_risco_milesimos: fila.reduce((s, x) => s + (precos[x.categoria] ?? 0), 0),
    salvas_pela_janela: Number(entregues?.n ?? 0),
    fila,
    por_fim: porFim,
  };
}

module.exports = { guardar, esperando, aproveitarJanela, vencidas, cancelar, resumo };
