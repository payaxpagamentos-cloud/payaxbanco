'use strict';

const { lerConfig } = require('../db');
const conversas = require('./conversas');
const filas = require('./filas');
const midia = require('./midia');

/**
 * Rotina de minuto. Faz o que ninguém fica olhando: encerra conversa abandonada, entrega o que
 * ficou na fila quando um atendente volta a ficar disponível e limpa registros antigos.
 */

/** Conversa com a IA ou na fila, sem o cliente responder há tempo demais: encerra como abandono. */
function encerrarAbandonadas(db) {
  const cfg = lerConfig(db);
  const encerradas = [];
  const empresas = db.prepare("SELECT id, nome FROM empresas WHERE status = 'ativa'").all();
  for (const e of empresas) {
    const ia = db.prepare('SELECT encerrar_apos_min FROM ia_config WHERE empresa_id = ?').get(e.id);
    const minutos = Number(ia?.encerrar_apos_min ?? cfg.abandono_min);
    if (!minutos) continue;
    const corte = new Date(Date.now() - minutos * 60_000).toISOString();
    const alvos = db.prepare(`SELECT * FROM conversas WHERE empresa_id = ? AND estado IN ('bot','aguardando')
      AND COALESCE(ultima_mensagem_cliente_em, aberta_em) < ?`).all(e.id, corte);
    for (const c of alvos) {
      // Na fila, só encerra se ninguém assumiu e o cliente também desapareceu: a espera não é culpa dele.
      conversas.encerrar(db, c, { resolvidaPor: 'abandono', avisar: false });
      encerradas.push(c.id);
    }
  }
  return encerradas;
}

/**
 * Ligação que ficou aberta porque a central não avisou o fim (o "h" do plano de discagem não está
 * configurado, ou o servidor caiu no meio). Nenhuma ligação dura quatro horas: fecha, para não
 * prender o atendente nem a conversa do cliente.
 */
function encerrarLigacoesEsquecidas(db, { horas = 4 } = {}) {
  const corte = new Date(Date.now() - horas * 3_600_000).toISOString();
  const alvos = db.prepare("SELECT * FROM conversas WHERE canal = 'telefone' AND estado <> 'encerrada' AND aberta_em < ?").all(corte);
  for (const c of alvos) {
    conversas.encerrar(db, c, { resolvidaPor: c.ligacao_atendida_em || c.estado === 'humano' ? 'humano' : 'abandono', avisar: false, pedirCsat: false });
  }
  return alvos.map((c) => c.id);
}

/** Quem ficou disponível recebe o que estava esperando. */
function distribuirPendentes(db) {
  const entregues = [];
  for (const e of db.prepare("SELECT id FROM empresas WHERE status = 'ativa'").all()) entregues.push(...filas.girarFila(db, e.id));
  return entregues;
}

/** Atendente que fechou o painel e não aparece há 15 minutos sai da distribuição. */
function soltarAtendentesAusentes(db) {
  const corte = new Date(Date.now() - 15 * 60_000).toISOString();
  const r = db.prepare("UPDATE usuarios SET disponivel = 0 WHERE disponivel = 1 AND perfil IN ('atendente','cliente') AND (visto_em IS NULL OR visto_em < ?)").run(corte);
  return Number(r.changes);
}

/** Limpa o que não serve mais: eventos de webhook vistos, acessos recusados e, se configurado, conversas antigas. */
function limpar(db) {
  const cfg = lerConfig(db);
  const resultado = {};
  resultado.webhook_vistos = Number(db.prepare('DELETE FROM webhook_vistos WHERE criado_em < ?').run(new Date(Date.now() - 7 * 86_400_000).toISOString()).changes);
  resultado.acessos_recusados = Number(db.prepare('DELETE FROM acessos_recusados WHERE criado_em < ?').run(new Date(Date.now() - 90 * 86_400_000).toISOString()).changes);
  if (cfg.retencao_dias > 0) {
    const corte = new Date(Date.now() - cfg.retencao_dias * 86_400_000).toISOString();
    // Apaga primeiro os arquivos; o banco cai em cascata pela conversa.
    for (const m of db.prepare("SELECT midia_arquivo FROM mensagens WHERE midia_arquivo IS NOT NULL AND conversa_id IN (SELECT id FROM conversas WHERE estado = 'encerrada' AND encerrada_em < ?)").all(corte)) {
      midia.apagar(m.midia_arquivo);
    }
    resultado.conversas = Number(db.prepare("DELETE FROM conversas WHERE estado = 'encerrada' AND encerrada_em < ?").run(corte).changes);
  }
  return resultado;
}

async function manutencao(db) {
  const r = {};
  try { r.abandonadas = encerrarAbandonadas(db); } catch (err) { console.error('[ZOE Atende] abandono:', err.message); }
  try { r.ligacoes = encerrarLigacoesEsquecidas(db); } catch (err) { console.error('[ZOE Atende] ligações:', err.message); }
  try { r.ausentes = soltarAtendentesAusentes(db); } catch (err) { console.error('[ZOE Atende] ausentes:', err.message); }
  try { r.entregues = distribuirPendentes(db); } catch (err) { console.error('[ZOE Atende] distribuição:', err.message); }
  // A limpeza roda uma vez por hora, não a cada minuto.
  if (new Date().getUTCMinutes() === 7) { try { r.limpeza = limpar(db); } catch (err) { console.error('[ZOE Atende] limpeza:', err.message); } }
  return r;
}

module.exports = { manutencao, encerrarAbandonadas, encerrarLigacoesEsquecidas, distribuirPendentes, soltarAtendentesAusentes, limpar };
