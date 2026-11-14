'use strict';

const express = require('express');
const config = require('../config');
const datas = require('../lib/datas');
const razao = require('../lib/razao');
const consultas = require('../lib/consultas');
const { podeEquipe } = require('../lib/permissoes');
const backup = require('../lib/backup');
const arquivosBanco = require('../lib/arquivosBanco');
const conformidade = require('../lib/conformidade');
const pld = require('../lib/pld');

/** Visão geral da plataforma: o que entrou, quanto ficou conosco e o que está pendente. */
module.exports = (db) => {
  const r = express.Router();

  r.get('/', async (req, res) => {
    // Custo com o banco e margem só para quem tem relatorios.margem (administrador e financeiro).
    const comMargem = podeEquipe(req.usuario.perfil, 'relatorios.margem');
    const talvez = (x) => (comMargem ? x : consultas.semMargem(x));
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
      // Títulos vencidos em aberto de TODOS os períodos (é o que a operação precisa olhar, não só o mês).
      vencidos_total: db.prepare(`SELECT COUNT(*) AS titulos, IFNULL(SUM(valor_centavos), 0) AS valor_centavos
        FROM boletos WHERE situacao = 'registrado' AND vencimento < ?`).get(hoje),
      pode_ver_margem: comMargem,
      liquidacoes: talvez(consultas.resumoLiquidacoes(db, periodo)),
      hoje_liquidado: talvez(consultas.resumoLiquidacoes(db, { de: hoje, ate: hoje })),
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
      alertas: await alertas(db, hoje, req.usuario.perfil),
    });
  });

  return r;
};

/** Pendências que exigem ação da equipe. */
async function alertas(db, hoje, perfil) {
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

  // Troca de arquivos com o banco: título que foi na remessa e nunca voltou confirmado é título
  // que o banco pode não ter registrado — o pagador recebeu um boleto que não existe lá.
  if (config.banco.modo === 'cnab') {
    const a = arquivosBanco.situacao(db);
    if (a.nao_confirmados) {
      lista.push({ tipo: 'cnab_sem_confirmacao', severidade: 'erro', quantidade: a.nao_confirmados,
        texto: `${a.nao_confirmados} título(s) na remessa há mais de 2 dias sem confirmação do banco` });
    }
    if (a.aguardando_remessa.titulos > 0 && !datas.ehDiaUtil(hoje)) {
      lista.push({ tipo: 'cnab_aguardando', severidade: 'info', quantidade: a.aguardando_remessa.titulos,
        texto: `${a.aguardando_remessa.titulos} título(s) esperando a remessa do próximo dia útil` });
    }
  }

  // Conformidade: regra fora da norma é o alerta mais grave do painel. Backup e registro no banco
  // já têm alerta próprio neste painel, então não contam duas vezes.
  const c = await conformidade.verificar(db);
  const regras = c.grupos.flatMap((g) => g.regras);
  const foraDaNorma = regras.filter((x) => x.situacao === 'fora' && !['backup', 'registro'].includes(x.id)).length;
  if (foraDaNorma) lista.push({ tipo: 'conformidade', severidade: 'erro', quantidade: foraDaNorma,
    texto: `${foraDaNorma} regra(s) de conformidade fora da norma` });
  if (c.resumo.prazos_vencidos) lista.push({ tipo: 'conformidade_prazo', severidade: 'aviso', quantidade: c.resumo.prazos_vencidos,
    texto: `${c.resumo.prazos_vencidos} pendência(s) de conformidade com prazo vencido` });

  // PLD: só para quem pode ver (sigilo da Lei 9.613/1998, art. 11, II).
  if (podeEquipe(perfil, 'pld.ver')) {
    const r = pld.resumo(db);
    if (r.atrasos.comunicacao) lista.push({ tipo: 'pld_comunicacao', severidade: 'erro', quantidade: r.atrasos.comunicacao,
      texto: `${r.atrasos.comunicacao} comunicação(ões) ao Coaf com o prazo de 24 horas vencido` });
    if (r.abertos) lista.push({ tipo: 'pld', severidade: r.atrasos.analise ? 'erro' : 'aviso', quantidade: r.abertos,
      texto: `${r.abertos} alerta(s) de PLD para analisar${r.atrasos.analise ? ` (${r.atrasos.analise} com prazo vencido)` : ''}` });
  }

  // O razão é o dinheiro dos clientes: backup atrasado ou que não conferiu é assunto urgente.
  const b = backup.situacao(db);
  if (!b.ultimo) lista.push({ tipo: 'backup', severidade: 'erro', texto: 'Nenhum backup do banco foi gerado ainda' });
  else if (!b.ultimo.confere) lista.push({ tipo: 'backup', severidade: 'erro', texto: `O último backup não conferiu: ${b.ultimo.divergencia}` });
  else if (b.atrasado) lista.push({ tipo: 'backup', severidade: 'aviso', texto: `O último backup foi há ${b.horas_desde} h` });
  return lista;
}
