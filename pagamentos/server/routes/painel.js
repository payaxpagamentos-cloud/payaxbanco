'use strict';

const express = require('express');
const config = require('../config');
const datas = require('../lib/datas');
const razao = require('../lib/razao');
const consultas = require('../lib/consultas');

/** Visão geral da plataforma: o que entrou, quanto ficou conosco e o que está pendente. */
module.exports = (db) => {
  const r = express.Router();

  r.get('/', (req, res) => {
    const hoje = datas.dataLocal(config.fusoPadrao);
    const inicioMes = datas.primeiroDiaMes(hoje);
    const periodo = { de: req.query.de || inicioMes, ate: req.query.ate || hoje };

    const clientes = db.prepare(`SELECT situacao, COUNT(*) AS n FROM clientes GROUP BY situacao`).all();
    const saldos = razao.saldosDosClientes(db, hoje);
    const repasses = db.prepare(`SELECT situacao, COUNT(*) AS n, IFNULL(SUM(valor_liquido_centavos), 0) AS valor_centavos
      FROM repasses GROUP BY situacao`).all();

    res.json({
      hoje,
      periodo,
      clientes: {
        total: clientes.reduce((s, c) => s + c.n, 0),
        por_situacao: Object.fromEntries(clientes.map((c) => [c.situacao, c.n])),
      },
      boletos: consultas.resumoBoletos(db, { ...periodo, hoje }),
      liquidacoes: consultas.resumoLiquidacoes(db, periodo),
      hoje_liquidado: consultas.resumoLiquidacoes(db, { de: hoje, ate: hoje }),
      serie: consultas.serieDiaria(db, { de: datas.somarDias(hoje, -29), ate: hoje }),
      saldo_clientes: {
        disponivel_centavos: saldos.reduce((s, c) => s + c.disponivel_centavos, 0),
        a_liberar_centavos: saldos.reduce((s, c) => s + c.a_liberar_centavos, 0),
      },
      repasses: Object.fromEntries(repasses.map((x) => [x.situacao, { quantidade: x.n, valor_centavos: x.valor_centavos }])),
      maiores_clientes: db.prepare(`SELECT c.id, c.razao_social, c.nome_fantasia, COUNT(b.id) AS titulos,
          IFNULL(SUM(b.pago_valor_centavos), 0) AS bruto_centavos
        FROM clientes c LEFT JOIN boletos b ON b.cliente_id = c.id AND b.situacao = 'liquidado' AND b.pago_em BETWEEN ? AND ?
        GROUP BY c.id ORDER BY bruto_centavos DESC LIMIT 8`).all(periodo.de, periodo.ate),
      alertas: alertas(db, hoje),
    });
  });

  return r;
};

/** Pendências que exigem ação da equipe. */
function alertas(db, hoje) {
  const lista = [];
  const esperando = db.prepare("SELECT COUNT(*) AS n, IFNULL(SUM(valor_liquido_centavos),0) AS v FROM repasses WHERE situacao = 'aguardando_aprovacao'").get();
  if (esperando.n) lista.push({ tipo: 'repasses_aprovacao', severidade: 'aviso', quantidade: esperando.n, valor_centavos: esperando.v,
    texto: `${esperando.n} repasse(s) aguardando aprovação` });
  const falhas = db.prepare("SELECT COUNT(*) AS n FROM boletos WHERE situacao = 'falha'").get().n;
  if (falhas) lista.push({ tipo: 'boletos_falha', severidade: 'erro', quantidade: falhas, texto: `${falhas} boleto(s) não registrados no banco` });
  const repasseFalho = db.prepare("SELECT COUNT(*) AS n FROM repasses WHERE situacao = 'falhou'").get().n;
  if (repasseFalho) lista.push({ tipo: 'repasses_falha', severidade: 'erro', quantidade: repasseFalho, texto: `${repasseFalho} repasse(s) com falha no envio` });
  const negativos = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT cliente_id, SUM(valor_centavos) AS s FROM lancamentos GROUP BY cliente_id HAVING s < 0)`).get().n;
  if (negativos) lista.push({ tipo: 'saldo_negativo', severidade: 'aviso', quantidade: negativos, texto: `${negativos} cliente(s) com saldo negativo` });
  const semConta = db.prepare('SELECT COUNT(*) AS n FROM contas_bancarias WHERE ativa = 1').get().n;
  if (!semConta) lista.push({ tipo: 'sem_conta', severidade: 'erro', texto: 'Nenhuma conta bancária ativa: não é possível emitir boletos' });
  const faixa = db.prepare('SELECT apelido, nosso_numero_final - nosso_numero_atual AS restam FROM contas_bancarias WHERE ativa = 1 ORDER BY restam LIMIT 1').get();
  if (faixa && faixa.restam < 1000) lista.push({ tipo: 'faixa_nosso_numero', severidade: 'aviso', texto: `Faixa de nosso número quase no fim na conta ${faixa.apelido} (restam ${faixa.restam})` });
  const vencidos = db.prepare("SELECT COUNT(*) AS n FROM boletos WHERE situacao = 'registrado' AND vencimento < ?").get(hoje).n;
  if (vencidos) lista.push({ tipo: 'vencidos', severidade: 'info', quantidade: vencidos, texto: `${vencidos} título(s) vencidos em aberto` });
  return lista;
}
