'use strict';

const { agora, lerConfig: lerConfigPlataforma } = require('../db');
const { ErroNegocio } = require('./erros');
const { clienteIxc, lerConfig, tiposRecebimento, ixcPronto } = require('./ixcEmpresa');
const { ErroIxc } = require('./ixc');
const { buscar, detalhe } = require('./recebimentos');
const v = require('./validacao');

/** Forma de pagamento com o maior valor no recebimento (é a que vai como tipo de recebimento no IXC). */
function formaPrincipal(db, recebimentoId) {
  return db.prepare(`SELECT forma FROM pagamentos WHERE recebimento_id = ? GROUP BY forma ORDER BY SUM(valor_centavos) DESC LIMIT 1`)
    .get(recebimentoId)?.forma ?? 'dinheiro';
}

const situacaoRecebimento = (titulos) => {
  const doIxc = titulos.filter((t) => t.fatura_ixc_id);
  if (!doIxc.length) return 'avulso';
  const ok = doIxc.filter((t) => t.ixc_status === 'baixado' || t.ixc_status === 'manual').length;
  if (ok === doIxc.length) return 'baixado';
  return ok ? 'parcial' : 'erro';
};

/**
 * Envia ao IXC a baixa dos títulos de um recebimento. Cada título é marcado por si:
 * se um falhar, os outros continuam baixados e o recebimento fica como parcial (com o erro guardado).
 */
async function enviarRecebimento(db, empresa, recebimentoId) {
  const r = buscar(db, empresa.id, recebimentoId);
  if (r.status !== 'confirmado') throw new ErroNegocio('Recebimento cancelado: não há baixa a enviar.', 409);
  const titulos = db.prepare("SELECT * FROM recebimento_titulos WHERE recebimento_id = ? AND fatura_ixc_id IS NOT NULL AND ixc_status IN ('pendente','erro')").all(r.id);
  if (!titulos.length) {
    const todos = db.prepare('SELECT * FROM recebimento_titulos WHERE recebimento_id = ?').all(r.id);
    const situacao = situacaoRecebimento(todos);
    db.prepare('UPDATE recebimentos SET ixc_status = ?, ixc_erro = NULL WHERE id = ?').run(situacao, r.id);
    return detalhe(db, empresa.id, r.id);
  }

  const { ixc, config: cfg } = clienteIxc(db, empresa.id);
  const tipos = tiposRecebimento(cfg);
  const forma = formaPrincipal(db, r.id);
  const loja = db.prepare('SELECT nome, ixc_filial_id FROM lojas WHERE id = ?').get(r.loja_id);
  const operador = db.prepare('SELECT nome FROM usuarios WHERE id = ?').get(r.operador_id);
  const historico = `PDV ${loja?.nome ?? ''} · recebimento ${r.numero} · ${operador?.nome ?? ''}`.trim();

  db.prepare("UPDATE recebimentos SET ixc_status = 'enviando', ixc_tentativas = ixc_tentativas + 1, ixc_enviado_em = ? WHERE id = ?").run(agora(), r.id);
  let ultimoErro = null;
  for (const t of titulos) {
    try {
      await ixc.baixar({
        faturaId: t.fatura_ixc_id,
        valorCentavos: t.total_centavos,
        dataPagamento: r.data,
        tipoRecebimento: tipos[forma] || null,
        contaId: cfg.ixc_conta_id || null,
        historico,
        jurosCentavos: t.acrescimo_centavos,
        descontoCentavos: t.desconto_centavos,
      });
      db.prepare("UPDATE recebimento_titulos SET ixc_status = 'baixado', ixc_erro = NULL, ixc_baixado_em = ? WHERE id = ?").run(agora(), t.id);
    } catch (err) {
      ultimoErro = err.message;
      db.prepare("UPDATE recebimento_titulos SET ixc_status = 'erro', ixc_erro = ? WHERE id = ?").run(String(err.message).slice(0, 300), t.id);
      // Erro de conexão ou tempo esgotado: não adianta insistir nos outros títulos agora.
      if (err instanceof ErroIxc && (err.tempoEsgotado || !err.status)) break;
    }
  }
  const todos = db.prepare('SELECT * FROM recebimento_titulos WHERE recebimento_id = ?').all(r.id);
  const situacao = situacaoRecebimento(todos);
  db.prepare('UPDATE recebimentos SET ixc_status = ?, ixc_erro = ? WHERE id = ?').run(situacao, situacao === 'baixado' ? null : ultimoErro, r.id);
  return detalhe(db, empresa.id, r.id);
}

/** Marca a baixa como feita à mão no IXC (quando a integração ficou fora do ar e alguém baixou pelo sistema). */
function marcarManual(db, { empresa, usuario, recebimentoId, motivo }) {
  const r = buscar(db, empresa.id, recebimentoId);
  if (r.ixc_status === 'baixado') throw new ErroNegocio('Este recebimento já consta baixado no IXC.', 409);
  const razao = v.texto(motivo, 'o motivo', 300);
  db.prepare("UPDATE recebimento_titulos SET ixc_status = 'manual', ixc_baixado_em = ?, ixc_erro = NULL WHERE recebimento_id = ? AND fatura_ixc_id IS NOT NULL AND ixc_status <> 'baixado'")
    .run(agora(), r.id);
  db.prepare("UPDATE recebimentos SET ixc_status = 'manual', ixc_erro = NULL, observacao = TRIM(COALESCE(observacao || ' · ', '') || ?) WHERE id = ?")
    .run(`Baixa manual no IXC por ${usuario.nome}: ${razao}`, r.id);
  return detalhe(db, empresa.id, r.id);
}

/** Estorno no IXC das faturas de um recebimento cancelado (reabre os títulos). */
async function estornarRecebimento(db, empresa, recebimentoId) {
  const r = buscar(db, empresa.id, recebimentoId);
  if (r.status !== 'cancelado') throw new ErroNegocio('Só um recebimento cancelado pode ser estornado no IXC.', 409);
  const titulos = db.prepare("SELECT * FROM recebimento_titulos WHERE recebimento_id = ? AND fatura_ixc_id IS NOT NULL AND ixc_status IN ('baixado','manual')").all(r.id);
  const { ixc } = clienteIxc(db, empresa.id);
  let erro = null;
  for (const t of titulos) {
    try {
      await ixc.estornar({ faturaId: t.fatura_ixc_id, valorCentavos: t.valor_centavos, historico: `Estorno do recebimento ${r.numero} cancelado no PDV` });
      db.prepare("UPDATE recebimento_titulos SET ixc_status = 'estornado', ixc_erro = NULL WHERE id = ?").run(t.id);
    } catch (err) {
      erro = err.message;
      db.prepare('UPDATE recebimento_titulos SET ixc_erro = ? WHERE id = ?').run(String(err.message).slice(0, 300), t.id);
    }
  }
  const restam = db.prepare("SELECT COUNT(*) AS n FROM recebimento_titulos WHERE recebimento_id = ? AND ixc_status IN ('baixado','manual')").get(r.id).n;
  if (!restam) {
    db.prepare("UPDATE recebimentos SET ixc_status = 'estornado', ixc_erro = NULL WHERE id = ?").run(r.id);
    db.prepare("UPDATE divergencias SET status = 'resolvida', resolucao = 'Faturas reabertas no IXC.', resolvido_em = ? WHERE recebimento_id = ? AND tipo = 'cancelado_com_baixa' AND status = 'aberta'")
      .run(agora(), r.id);
  } else {
    db.prepare('UPDATE recebimentos SET ixc_erro = ? WHERE id = ?').run(erro, r.id);
  }
  return detalhe(db, empresa.id, r.id);
}

/**
 * Fila de baixas: percorre os recebimentos ainda não baixados das empresas com o IXC ligado e tenta de novo.
 * Roda de tempos em tempos no servidor e também pode ser chamada pelo painel ("tentar agora").
 */
async function processarFila(db, { empresaId = null, limite = 20 } = {}) {
  const max = lerConfigPlataforma(db).baixa_tentativas;
  const empresas = db.prepare(`SELECT * FROM empresas WHERE status = 'ativa'${empresaId ? ' AND id = ?' : ''}`).all(...(empresaId ? [empresaId] : []));
  const resultado = { enviados: 0, baixados: 0, erros: 0 };
  for (const empresa of empresas) {
    if (!ixcPronto(db, empresa.id)) continue;
    const cfg = lerConfig(db, empresa.id);
    if (!cfg.baixa_automatica) continue;
    const pendentes = db.prepare(`SELECT id FROM recebimentos WHERE empresa_id = ? AND status = 'confirmado'
      AND ixc_status IN ('pendente','erro','parcial','enviando') AND ixc_tentativas < ? ORDER BY id LIMIT ?`).all(empresa.id, max, limite);
    for (const p of pendentes) {
      resultado.enviados += 1;
      try {
        const r = await enviarRecebimento(db, empresa, p.id);
        if (r.ixc_status === 'baixado') resultado.baixados += 1; else resultado.erros += 1;
      } catch (err) {
        resultado.erros += 1;
        db.prepare("UPDATE recebimentos SET ixc_status = 'erro', ixc_erro = ?, ixc_tentativas = ixc_tentativas + 1 WHERE id = ?")
          .run(String(err.message).slice(0, 300), p.id);
      }
    }
    // Cancelados que já tinham baixa: tenta reabrir no IXC.
    const cancelados = db.prepare(`SELECT DISTINCT r.id FROM recebimentos r JOIN recebimento_titulos t ON t.recebimento_id = r.id
      WHERE r.empresa_id = ? AND r.status = 'cancelado' AND t.ixc_status IN ('baixado','manual') LIMIT ?`).all(empresa.id, limite);
    for (const c of cancelados) {
      try { await estornarRecebimento(db, empresa, c.id); } catch { /* fica para a próxima rodada */ }
    }
  }
  return resultado;
}

/** Quantos recebimentos estão esperando baixa ou deram erro (aviso no painel). */
const pendencias = (db, empresaId) => db.prepare(`SELECT
    COALESCE(SUM(ixc_status IN ('pendente','enviando')), 0) AS pendentes,
    COALESCE(SUM(ixc_status IN ('erro','parcial')), 0) AS com_erro,
    COALESCE(SUM(ixc_status IN ('pendente','enviando','erro','parcial')), 0) AS total
  FROM recebimentos WHERE empresa_id = ? AND status = 'confirmado'`).get(empresaId);

module.exports = { enviarRecebimento, marcarManual, estornarRecebimento, processarFila, pendencias, formaPrincipal };
