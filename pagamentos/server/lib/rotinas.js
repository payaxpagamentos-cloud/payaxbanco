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
const pld = require('./pld');
const lgpd = require('./lgpd');

let ultimaImportacao = null;
let ultimoPld = 0;
let ultimaRetencao = null;

async function rodar(db, { forcar = false } = {}) {
  const hoje = datas.dataLocal(config.fusoPadrao);
  const out = { hoje };

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

  // Repasses: a cada ciclo, todos os dias. O que o banco creditou vai para o cliente agora —
  // a PAY AX não guarda dinheiro de cliente. Roda depois da leitura do retorno, para os títulos
  // pagos que acabaram de chegar já saírem nesta mesma rodada.
  try {
    out.repasses = await repasses.rotinaAutomatica(db);
    if (out.repasses.criados || out.repasses.falhas) {
      console.log(`[PAY AX] Repasses: ${out.repasses.enviados} enviado(s), ${out.repasses.falhas} falha(s).`);
    }
  } catch (err) {
    console.error('[PAY AX] Falha na rodada de repasses:', err.message);
  }

  // PLD: as regras de operação atípica, de hora em hora (Lei 9.613/1998, art. 11, I).
  if (forcar || Date.now() - ultimoPld > 3_600_000) {
    ultimoPld = Date.now();
    try {
      out.pld = pld.monitorar(db);
      if (out.pld.novos) console.log(`[PAY AX] PLD: ${out.pld.novos} alerta(s) novo(s) para análise.`);
    } catch (err) {
      console.error('[PAY AX] Falha no monitoramento de PLD:', err.message);
    }
  }

  // LGPD: anonimiza o que passou do prazo de guarda, uma vez por dia.
  if (forcar || ultimaRetencao !== hoje) {
    ultimaRetencao = hoje;
    try {
      out.retencao = lgpd.aplicarRetencao(db);
      if (out.retencao.boletos || out.retencao.ips) {
        console.log(`[PAY AX] LGPD: ${out.retencao.boletos} título(s) anonimizado(s), ${out.retencao.ips} IP(s) apagado(s) da auditoria.`);
      }
    } catch (err) {
      console.error('[PAY AX] Falha na retenção da LGPD:', err.message);
    }
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
