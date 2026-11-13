'use strict';

/*
 * Rotinas automáticas:
 *   - repasses: o saldo liberado vira PIX para o cliente (uma vez por dia, em dia útil);
 *   - baixas pendentes no IXC: títulos liquidados cujo provedor ainda não foi avisado;
 *   - importação automática do IXC, para quem deixou ligada.
 *
 * Tudo roda em intervalos curtos e é idempotente: rodar duas vezes não duplica nada.
 */
const config = require('./../config');
const datas = require('./datas');
const repasses = require('./repasses');
const sincronismo = require('./sincronismo');
const arquivosBanco = require('./arquivosBanco');

let ultimoRepasse = null;
let ultimaImportacao = null;

async function rodar(db, { forcar = false } = {}) {
  const hoje = datas.dataLocal(config.fusoPadrao);
  const out = { hoje };

  // Repasses: uma vez por dia útil.
  if ((forcar || ultimoRepasse !== hoje) && datas.ehDiaUtil(hoje)) {
    ultimoRepasse = hoje;
    try {
      out.repasses = await repasses.rotinaAutomatica(db);
      if (out.repasses.criados || out.repasses.enviados) {
        console.log(`[PAY AX] Repasses automáticos: ${out.repasses.enviados} enviados, ${out.repasses.aguardando} aguardando aprovação.`);
      }
    } catch (err) {
      console.error('[PAY AX] Falha na rotina de repasses:', err.message);
    }
  }

  // Troca de arquivos com o banco (CNAB 400): manda o que está esperando e lê o que chegou.
  try {
    out.banco = await arquivosBanco.rodar(db);
    const lidos = out.banco.retorno?.processados?.filter((x) => !x.erro && !x.ja_processado) ?? [];
    for (const r of lidos) {
      console.log(`[PAY AX] Retorno ${r.nome}: ${r.liquidados} liquidado(s), ${r.confirmados} confirmado(s), ${r.rejeitados} rejeitado(s).`);
    }
    if (out.banco.remessa?.id) console.log(`[PAY AX] Remessa ${out.banco.remessa.nome} gerada com ${out.banco.remessa.titulos} título(s).`);
  } catch (err) {
    console.error('[PAY AX] Falha na troca de arquivos com o banco:', err.message);
  }

  // Baixas pendentes no IXC: a cada ciclo.
  try {
    out.baixas = await sincronismo.reprocessarBaixas(db, 50);
  } catch (err) {
    console.error('[PAY AX] Falha ao reprocessar baixas no IXC:', err.message);
  }

  // Importação automática do IXC, para os clientes que pediram.
  if (forcar || ultimaImportacao !== hoje) {
    ultimaImportacao = hoje;
    const clientes = db.prepare(`SELECT c.* FROM clientes c JOIN integracoes i ON i.cliente_id = c.id AND i.escopo = 'ixc'
      WHERE c.situacao = 'ativo' AND i.estado <> 'desabilitada' AND json_extract(i.config, '$.importacao_automatica') = 1`).all();
    out.importacoes = [];
    for (const c of clientes) {
      try {
        const cfg = JSON.parse(db.prepare("SELECT config FROM integracoes WHERE escopo = 'ixc' AND cliente_id = ?").get(c.id).config || '{}');
        const r = await sincronismo.importar(db, c, { de: hoje, ate: datas.somarDias(hoje, cfg.dias_a_frente ?? 10) });
        out.importacoes.push({ cliente_id: c.id, criados: r.criados, erros: r.erros });
      } catch (err) {
        out.importacoes.push({ cliente_id: c.id, erro: err.message });
      }
    }
  }
  return out;
}

function agendar(db) {
  const intervalo = Math.max(1, config.rotinaIntervaloMin) * 60_000;
  setTimeout(() => rodar(db).catch((err) => console.error('[PAY AX] Rotina:', err.message)), 30_000).unref();
  setInterval(() => rodar(db).catch((err) => console.error('[PAY AX] Rotina:', err.message)), intervalo).unref();
}

module.exports = { rodar, agendar };
