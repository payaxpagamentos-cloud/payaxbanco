'use strict';

const { agora } = require('../db');

/** Versão da regra vigente para o tipo de serviço no instante informado. */
function versaoVigente(db, org, tipo, em = agora()) {
  return db.prepare(`SELECT v.*, r.nome AS regra_nome FROM comissao_versoes v JOIN comissao_regras r ON r.id = v.regra_id
    WHERE r.organizacao_id = ? AND r.tipo_servico = ? AND r.ativa = 1 AND v.vigente_desde <= ? ORDER BY v.versao DESC LIMIT 1`).get(org, tipo, em) ?? null;
}

/** Divide o valor entre a equipe pelos percentuais; o resto dos centavos vai ao maior percentual. Nunca ultrapassa o total. */
function ratear(total, equipe) {
  const partes = equipe.map((e) => ({ ...e, valor: Math.floor((total * e.percentual) / 100) }));
  const resto = total - partes.reduce((a, p) => a + p.valor, 0);
  if (partes.length) partes.reduce((m, p) => (p.percentual > m.percentual ? p : m), partes[0]).valor += resto;
  return partes;
}

/**
 * Gera as comissões de um chamado aprovado, com a versão da regra vigente na aprovação. É idempotente: a restrição
 * única (chamado, técnico, regra) impede duplicar; uma comissão suspensa por reabertura volta para aprovação.
 */
function gerarComissoes(db, req, chamado) {
  const versao = versaoVigente(db, chamado.organizacao_id, chamado.tipo);
  if (!versao) return { geradas: [], aviso: `Sem regra de comissão ativa para o tipo "${chamado.tipo}".` };
  let quantidade = 1;
  let base = `${versao.regra_nome} v${versao.versao}: valor fixo por serviço`;
  if (versao.modo === 'por_unidade') {
    const resp = db.prepare('SELECT valor FROM chamado_respostas WHERE chamado_id = ? AND chave = ?').get(chamado.id, versao.campo_unidade);
    quantidade = Math.max(0, Math.floor(Number(String(resp?.valor ?? '').replace(',', '.')) || 0));
    base = `${versao.regra_nome} v${versao.versao}: ${quantidade} × valor por unidade (${versao.campo_unidade})`;
    if (!quantidade) return { geradas: [], aviso: `O item "${versao.campo_unidade}" do checklist não tem quantidade: comissão não gerada.` };
  }
  const total = versao.valor_centavos * quantidade;
  let equipe = db.prepare('SELECT tecnico_id, percentual FROM chamado_equipe WHERE chamado_id = ?').all(chamado.id);
  if (!equipe.length) equipe = [{ tecnico_id: chamado.tecnico_id, percentual: 100 }];
  const geradas = [];
  for (const p of ratear(total, equipe)) {
    const r = db.prepare(`INSERT OR IGNORE INTO comissoes (organizacao_id, chamado_id, tecnico_id, regra_id, versao_id, base, quantidade, percentual_rateio, valor_centavos, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(chamado.organizacao_id, chamado.id, p.tecnico_id, versao.regra_id, versao.id, base, quantidade, p.percentual, p.valor, agora());
    if (r.changes) {
      const id = Number(r.lastInsertRowid);
      db.prepare("INSERT INTO comissao_eventos (comissao_id, de, para, motivo, usuario_id, em) VALUES (?, NULL, 'aguardando_aprovacao', 'Chamado aprovado', ?, ?)").run(id, req.usuario.id, agora());
      geradas.push(id);
    } else {
      const c = db.prepare('SELECT id, status FROM comissoes WHERE chamado_id = ? AND tecnico_id = ? AND regra_id = ?').get(chamado.id, p.tecnico_id, versao.regra_id);
      if (c?.status === 'suspensa') {
        db.prepare("UPDATE comissoes SET status = 'aguardando_aprovacao' WHERE id = ?").run(c.id);
        db.prepare("INSERT INTO comissao_eventos (comissao_id, de, para, motivo, usuario_id, em) VALUES (?, 'suspensa', 'aguardando_aprovacao', 'Chamado aprovado novamente', ?, ?)")
          .run(c.id, req.usuario.id, agora());
      }
    }
  }
  return { geradas, aviso: null };
}

/** Saldo de uma comissão = valor + ajustes (positivos ou negativos). */
const saldo = (db, c) => c.valor_centavos + (db.prepare('SELECT COALESCE(SUM(valor_centavos), 0) AS s FROM comissao_ajustes WHERE comissao_id = ?').get(c.id).s);

module.exports = { versaoVigente, ratear, gerarComissoes, saldo };
