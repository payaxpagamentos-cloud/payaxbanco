'use strict';

const { agora, transacao } = require('../db');
const { hoje } = require('./datas');
const { ErroNegocio } = require('./erros');

/**
 * CRM: o que acontece antes de existir cliente.
 *
 * O sistema já cuidava bem de quem assina: campanha, fatura, repasse, contrato. O que faltava era o
 * começo — a lista de quem ainda não é cliente, em que pé está cada conversa e, principalmente, **qual é o
 * próximo passo e quando**. Lead sem próximo passo marcado é lead que morre numa coluna do quadro.
 *
 * Duas pontas entram aqui, porque o negócio tem dois lados:
 *  - quem quer **anunciar** (vira anunciante, proposta, contrato e campanha);
 *  - o **condomínio ou comércio** que quer tela (vira ponto na rede).
 *
 * O lead ganho não some: ele aponta para o cliente ou o ponto que nasceu dele, e é assim que se sabe de
 * onde veio cada contrato — inclusive os que chegaram pelo formulário do site.
 */

const ETAPAS = ['novo', 'contato', 'proposta', 'negociacao', 'ganho', 'perdido'];
const ETAPAS_ABERTAS = ['novo', 'contato', 'proposta', 'negociacao'];
const ORIGENS = ['site', 'indicacao', 'prospeccao', 'evento', 'outro'];
const TIPOS_INTERACAO = ['nota', 'ligacao', 'email', 'whatsapp', 'reuniao', 'visita', 'etapa'];

const SELECT = `SELECT l.*, u.nome AS responsavel, a.nome AS cliente, p.nome AS ponto,
    (SELECT COUNT(*) FROM propostas pr WHERE pr.lead_id = l.id) AS propostas,
    (SELECT MAX(i.criado_em) FROM lead_interacoes i WHERE i.lead_id = l.id) AS ultimo_contato
  FROM leads l LEFT JOIN usuarios u ON u.id = l.responsavel_id
  LEFT JOIN anunciantes a ON a.id = l.anunciante_id LEFT JOIN locais p ON p.id = l.local_id`;

/** Acrescenta o que o painel usa para destacar o que está atrasado. */
function comPrazo(lead, data = hoje()) {
  return {
    ...lead,
    atrasado: Boolean(lead.proximo_em && lead.proximo_em < data && ETAPAS_ABERTAS.includes(lead.etapa)),
    para_hoje: Boolean(lead.proximo_em === data && ETAPAS_ABERTAS.includes(lead.etapa)),
    aberto: ETAPAS_ABERTAS.includes(lead.etapa),
  };
}

/** Registra uma conversa (ou a mudança de etapa) no histórico do lead. */
function anotar(db, leadId, { tipo = 'nota', texto, usuarioId = null }) {
  if (!texto) return null;
  db.prepare('INSERT INTO lead_interacoes (lead_id, tipo, texto, criado_por, criado_em) VALUES (?, ?, ?, ?, ?)')
    .run(leadId, tipo, String(texto).slice(0, 500), usuarioId, agora());
  db.prepare('UPDATE leads SET atualizado_em = ? WHERE id = ?').run(agora(), leadId);
  return true;
}

function detalhe(db, id) {
  const l = db.prepare(`${SELECT} WHERE l.id = ?`).get(id);
  if (!l) throw new ErroNegocio('Lead não encontrado.', 404);
  return {
    ...comPrazo(l),
    interacoes: db.prepare(`SELECT i.*, u.nome AS quem FROM lead_interacoes i LEFT JOIN usuarios u ON u.id = i.criado_por
      WHERE i.lead_id = ? ORDER BY i.criado_em DESC, i.id DESC`).all(id),
    propostas_lista: db.prepare(`SELECT id, numero, titulo, status, total_centavos, valida_ate, contrato_id
      FROM propostas WHERE lead_id = ? ORDER BY criado_em DESC`).all(id),
  };
}

/** O quadro inteiro: as colunas do funil e os números que importam. */
function funil(db, filtros = {}) {
  const data = hoje();
  const onde = [];
  const p = [];
  if (filtros.tipo) { onde.push('l.tipo = ?'); p.push(filtros.tipo); }
  if (filtros.responsavel_id) { onde.push('l.responsavel_id = ?'); p.push(Number(filtros.responsavel_id)); }
  if (filtros.origem) { onde.push('l.origem = ?'); p.push(filtros.origem); }
  if (filtros.busca) {
    onde.push('(l.nome LIKE ? OR l.contato LIKE ? OR l.email LIKE ? OR l.cidade LIKE ?)');
    const b = `%${String(filtros.busca).trim()}%`;
    p.push(b, b, b, b);
  }
  const itens = db.prepare(`${SELECT} ${onde.length ? `WHERE ${onde.join(' AND ')}` : ''}
    ORDER BY CASE WHEN l.proximo_em IS NULL THEN 1 ELSE 0 END, l.proximo_em, l.atualizado_em DESC`).all(...p)
    .map((l) => comPrazo(l, data));

  const abertos = itens.filter((l) => l.aberto);
  const mes = data.slice(0, 7);
  const ganhos = itens.filter((l) => l.etapa === 'ganho');
  const respondidos = itens.filter((l) => l.etapa === 'ganho' || l.etapa === 'perdido').length;
  return {
    etapas: ETAPAS.map((etapa) => ({
      etapa,
      itens: itens.filter((l) => l.etapa === etapa).slice(0, etapa === 'ganho' || etapa === 'perdido' ? 12 : 60),
      total: itens.filter((l) => l.etapa === etapa).length,
      valor_centavos: itens.filter((l) => l.etapa === etapa).reduce((t, l) => t + l.valor_estimado_centavos, 0),
    })),
    totais: {
      abertos: abertos.length,
      no_funil_centavos: abertos.reduce((t, l) => t + l.valor_estimado_centavos, 0),
      atrasados: abertos.filter((l) => l.atrasado).length,
      para_hoje: abertos.filter((l) => l.para_hoje).length,
      sem_proximo_passo: abertos.filter((l) => !l.proximo_em).length,
      ganhos_mes: ganhos.filter((l) => (l.ganho_em ?? '').startsWith(mes)).length,
      ganho_mes_centavos: ganhos.filter((l) => (l.ganho_em ?? '').startsWith(mes)).reduce((t, l) => t + l.valor_estimado_centavos, 0),
      conversao_percentual: respondidos ? Math.round((ganhos.length / respondidos) * 10_000) : 0,
    },
    // A agenda do dia: o que foi combinado para hoje e o que já passou da data.
    agenda: abertos.filter((l) => l.atrasado || l.para_hoje).slice(0, 20),
  };
}

/**
 * Lead ganho vira o que ele é: cliente que vai anunciar ou ponto na rede.
 * Fica apontando para o cadastro criado — é assim que se sabe de onde veio cada contrato.
 */
function ganhar(db, id, { usuarioId = null, criarCadastro = true } = {}) {
  const l = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!l) throw new ErroNegocio('Lead não encontrado.', 404);
  if (l.etapa === 'ganho') throw new ErroNegocio('Este lead já foi ganho.', 409);

  return transacao(db, () => {
    let anuncianteId = l.anunciante_id;
    let localId = l.local_id;
    if (criarCadastro && l.tipo === 'anunciante' && !anuncianteId) {
      anuncianteId = Number(db.prepare(`INSERT INTO anunciantes (nome, contato, email, telefone, status, observacao, criado_em)
        VALUES (?, ?, ?, ?, 'ativo', ?, ?)`)
        .run(l.nome, l.contato, l.email, l.telefone, `Veio do CRM (origem: ${l.origem}).`, agora()).lastInsertRowid);
    }
    if (criarCadastro && l.tipo === 'ponto' && !localId) {
      localId = Number(db.prepare(`INSERT INTO locais (nome, categoria, cidade, uf, responsavel, telefone, email, status, observacao, criado_em)
        VALUES (?, 'condominio_residencial', ?, ?, ?, ?, ?, 'ativo', ?, ?)`)
        .run(l.nome, l.cidade ?? '—', l.uf ?? 'SP', l.contato, l.telefone, l.email,
          `Veio do CRM (origem: ${l.origem}). Confira a categoria e a contrapartida combinada.`, agora()).lastInsertRowid);
    }
    db.prepare("UPDATE leads SET etapa = 'ganho', ganho_em = ?, anunciante_id = ?, local_id = ?, proximo_passo = NULL, proximo_em = NULL, atualizado_em = ? WHERE id = ?")
      .run(hoje(), anuncianteId, localId, agora(), id);
    anotar(db, id, {
      tipo: 'etapa',
      texto: l.tipo === 'anunciante'
        ? `Ganho! Cliente criado a partir do lead.${anuncianteId ? '' : ' (sem cadastro novo)'}`
        : `Ganho! Ponto criado a partir do lead.${localId ? '' : ' (sem cadastro novo)'}`,
      usuarioId,
    });
    return detalhe(db, id);
  });
}

module.exports = { ETAPAS, ETAPAS_ABERTAS, ORIGENS, TIPOS_INTERACAO, SELECT, comPrazo, anotar, detalhe, funil, ganhar };
