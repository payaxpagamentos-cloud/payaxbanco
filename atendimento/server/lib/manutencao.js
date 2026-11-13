'use strict';

const { lerConfig, transacao } = require('../db');
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
    // Na fila é diferente: o cliente foi transferido à noite e ouviu "a equipe responde quando abrir".
    // Encerrar por silêncio dele em 3 h esconderia a conversa da equipe. Na fila, só depois de 48 h
    // (a janela do WhatsApp já fechou há um dia). Ligação na fila tem regra própria (encerrarLigacoesEsquecidas).
    const corteFila = new Date(Date.now() - Math.max(minutos, 48 * 60) * 60_000).toISOString();
    const alvos = db.prepare(`SELECT * FROM conversas WHERE empresa_id = ? AND (
        (estado = 'bot' AND COALESCE(ultima_mensagem_cliente_em, aberta_em) < ?)
        OR (estado = 'aguardando' AND canal <> 'telefone' AND COALESCE(ultima_mensagem_cliente_em, aberta_em) < ?))`).all(e.id, corte, corteFila);
    for (const c of alvos) {
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
    // Primeiro o banco, numa transação; os arquivos só depois que a exclusão deu certo — ao contrário,
    // uma falha deixaria mensagens apontando para arquivos que já não existem.
    const alvo = "SELECT id FROM conversas WHERE estado = 'encerrada' AND encerrada_em < ?";
    const arquivos = db.prepare(`SELECT midia_arquivo FROM mensagens WHERE midia_arquivo IS NOT NULL AND conversa_id IN (${alvo})`).all(corte).map((m) => m.midia_arquivo);
    resultado.conversas = transacao(db, () => {
      // O histórico da IA (custo do mês) e os chamados ficam; só perdem o vínculo com a conversa.
      // Feito à mão porque bancos instalados antes não têm o ON DELETE SET NULL nessas colunas.
      db.prepare(`UPDATE ia_eventos SET conversa_id = NULL WHERE conversa_id IN (${alvo})`).run(corte);
      db.prepare(`UPDATE chamados SET conversa_id = NULL WHERE conversa_id IN (${alvo})`).run(corte);
      return Number(db.prepare("DELETE FROM conversas WHERE estado = 'encerrada' AND encerrada_em < ?").run(corte).changes);
    });
    for (const f of arquivos) midia.apagar(f);
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
