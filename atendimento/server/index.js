'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');
const { manutencao } = require('./lib/manutencao');
const regua = require('./lib/regua');
const orcamento = require('./lib/orcamento');
const fechamento = require('./lib/fechamento');
const { processarFila } = require('./lib/envio');

const db = abrir();
criarApp(db).listen(config.port, () => {
  console.log(`[ZOE Atende] Painel: http://localhost:${config.port}${config.basePath}/`);
  if (!config.ia.chave) console.log('[ZOE Atende] Sem ATEND_IA_CHAVE: a ZOE roda só com as intenções e a base de conhecimento.');
});

// A fila de saída também gira sozinha: uma mensagem que falhou volta a ser tentada mesmo sem ninguém no painel.
setInterval(() => { processarFila(db).catch((err) => console.error('[ZOE Atende] Falha na fila de envio:', err.message)); }, 20_000).unref();

// Telefonia: encerra chamadas presas e marca offline os ramais que pararam de se registrar.
setInterval(() => {
  try { require('./telefonia/chamadas').manutencao(db); } catch (err) { console.error('[ZOE] Falha na manutenção da telefonia:', err.message); }
}, 60_000).unref();

// Encerra conversas abandonadas, cobra o CSAT e limpa os registros antigos.
setInterval(() => {
  manutencao(db).catch((err) => console.error('[ZOE Atende] Falha na manutenção:', err.message));
}, 60_000).unref();


// Réguas de mensagens ativas: cada uma roda na hora que a empresa marcou, uma vez por dia.
setInterval(async () => {
  for (const r of regua.devemRodar(db)) {
    const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(r.empresa_id);
    try {
      const resultado = await regua.executar(db, empresa, r);
      console.log(`[ZOE Atende] Régua "${r.nome}" (${r.empresa_nome}): ${resultado.enviados} enviada(s), `
        + `${resultado.pela_janela} pela janela, ${resultado.esperando} esperando a janela, ${resultado.pulados} pulada(s), `
        + `custo ${(resultado.custo_milesimos / 1000).toFixed(2)}, economia ${(resultado.economia_milesimos / 1000).toFixed(2)}`
        + `${resultado.teto_atingido ? ' — PAROU NO TETO DE GASTO' : ''}`);
    } catch (err) {
      console.error(`[ZOE Atende] Falha na régua "${r.nome}":`, err.message);
    }
  }
}, 60_000).unref();

// A sala de espera da janela: de dez em dez minutos, o que venceu o prazo é pago — e só o que
// ainda fizer sentido pagar. Até aqui, cada aviso que esperou e saiu pela janela foi de graça.
setInterval(() => {
  regua.pagarVencidas(db)
    .then((r) => {
      if (r.pagas || r.pela_janela || r.canceladas) {
        console.log(`[ZOE Atende] Sala de espera: ${r.pela_janela} saiu pela janela (grátis), ${r.pagas} pagou template, `
          + `${r.canceladas} cancelada(s) — custo ${(r.custo_milesimos / 1000).toFixed(2)}, economia ${(r.economia_milesimos / 1000).toFixed(2)}`);
      }
    })
    .catch((err) => console.error('[ZOE Atende] Falha ao varrer a sala de espera:', err.message));
}, 600_000).unref();

// O dólar do dia: busca a PTAX no Banco Central ao subir e de hora em hora. O boletim sai por volta
// das 13h; até lá vale o do último dia útil. Se o Banco Central não responder, segue com o guardado.
const cotacao = require('./lib/cotacao');
let ultimoBoletim = null;
const buscarDolar = () => cotacao.atualizar(db)
  .then((c) => {
    if (c && c.data !== ultimoBoletim) {
      ultimoBoletim = c.data;
      console.log(`[ZOE Atende] Dólar do dia (PTAX de venda, ${c.data}): R$ ${(c.venda_x10000 / 10_000).toFixed(4).replace(".", ",")}`);
    }
  })
  .catch((err) => console.error('[ZOE Atende] Não consegui buscar o dólar no Banco Central:', err.message));
buscarDolar();
setInterval(buscarDolar, 3_600_000).unref();

// Orçamento: marca 50%, 80% e 100% uma vez por mês, para a gestão ver antes de estourar.
// E no dia 1º fecha o mês anterior de todas as empresas, para o número parar de se mover.
setInterval(() => {
  try {
    for (const e of db.prepare("SELECT id, nome FROM empresas WHERE status = 'ativa'").all()) {
      for (const aviso of orcamento.conferirMarcos(db, e.id)) {
        console.log(`[ZOE Atende] Orçamento de "${e.nome}": ${aviso.marco}% do mês `
          + `(${(aviso.gasto_milesimos / 1000).toFixed(2)} de ${(aviso.orcamento_milesimos / 1000).toFixed(2)})`
          + `${aviso.marco === 100 ? ' — a partir daqui só sai mensagem grátis' : ''}`);
      }
    }
    const hojeData = require('./lib/datas').hoje();
    if (hojeData.slice(8, 10) === '01') {
      for (const f of fechamento.fecharTodas(db)) {
        if (f.erro) console.error(`[ZOE Atende] Falha ao fechar o mês de "${f.empresa}":`, f.erro);
        else if (!f.recalculado) console.log(`[ZOE Atende] Mês ${f.mes} fechado para "${f.empresa}": gasto ${(f.gasto_milesimos / 1000).toFixed(2)}.`);
      }
    }
  } catch (err) {
    console.error('[ZOE Atende] Falha no controle de orçamento:', err.message);
  }
}, 900_000).unref();
