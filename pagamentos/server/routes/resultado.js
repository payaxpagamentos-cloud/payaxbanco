'use strict';

const express = require('express');
const config = require('../config');
const { agora } = require('../db');
const { exigir } = require('../auth');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { conferirVersao } = require('../lib/http');
const v = require('../lib/validacao');
const auditoria = require('../lib/auditoria');
const datas = require('../lib/datas');
const resultado = require('../lib/resultado');

const mesAtual = () => datas.dataLocal(config.fusoPadrao).slice(0, 7);

function lerMes(valor, nome) {
  const m = String(valor ?? '').trim();
  if (!resultado.mesValido(m)) throw new ErroNegocio(`Informe ${nome} no formato AAAA-MM.`, 422);
  return m;
}

/** Valida o corpo de uma despesa (criação ou edição completa). */
function lerDespesa(b) {
  const d = {
    categoria: v.opcao(b.categoria, 'a categoria', Object.keys(resultado.CATEGORIAS)),
    descricao: v.texto(b.descricao, 'a descrição', 120),
    valor_centavos: v.centavos(b.valor, 'o valor'),
    recorrencia: v.opcao(b.recorrencia ?? 'mensal', 'a recorrência', ['mensal', 'unica']),
    inicio: lerMes(b.inicio, 'o mês de início'),
    fim: b.fim ? lerMes(b.fim, 'o último mês') : null,
    observacao: v.opcional(b.observacao, 'a observação', 300),
  };
  if (d.valor_centavos <= 0) throw new ErroNegocio('Informe o valor da despesa.', 422);
  if (d.recorrencia === 'unica') d.fim = null;
  if (d.fim && d.fim < d.inicio) throw new ErroNegocio('O último mês não pode ser antes do início.', 422);
  return d;
}

module.exports = (db) => {
  const r = express.Router();

  /** Demonstrativo do mês, histórico e as despesas cadastradas. */
  r.get('/', exigir('resultado.ver'), (req, res) => {
    const mes = req.query.mes ? lerMes(req.query.mes, 'o mês') : mesAtual();
    res.json({
      ...resultado.doMes(db, mes),
      historico: resultado.historico(db, mes, 6),
      categorias: resultado.CATEGORIAS,
      despesas_cadastradas: db.prepare(`SELECT d.*, u.nome AS criado_por_nome FROM despesas d LEFT JOIN usuarios u ON u.id = d.criado_por
        ORDER BY (d.recorrencia = 'mensal' AND (d.fim IS NULL OR d.fim >= ?)) DESC, d.categoria, d.descricao`).all(mes),
    });
  });

  r.post('/despesas', exigir('despesas.editar'), (req, res) => {
    const d = lerDespesa(req.body ?? {});
    const nova = db.prepare(`INSERT INTO despesas (categoria, descricao, valor_centavos, recorrencia, inicio, fim, observacao, criado_em, criado_por)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
      .get(d.categoria, d.descricao, d.valor_centavos, d.recorrencia, d.inicio, d.fim, d.observacao, agora(), req.usuario.id);
    auditoria.registrar(db, req, { acao: 'despesa.criada', entidade: 'despesa', entidade_id: nova.id, depois: d });
    res.status(201).json(nova);
  });

  r.put('/despesas/:id', exigir('despesas.editar'), (req, res) => {
    const atual = db.prepare('SELECT * FROM despesas WHERE id = ?').get(Number(req.params.id));
    if (!atual) throw naoEncontrado('Despesa');
    conferirVersao(atual.versao, req.body?.versao);
    const d = lerDespesa(req.body ?? {});
    const nova = db.prepare(`UPDATE despesas SET categoria = ?, descricao = ?, valor_centavos = ?, recorrencia = ?, inicio = ?, fim = ?,
        observacao = ?, atualizado_em = ?, versao = versao + 1 WHERE id = ? RETURNING *`)
      .get(d.categoria, d.descricao, d.valor_centavos, d.recorrencia, d.inicio, d.fim, d.observacao, agora(), atual.id);
    auditoria.registrar(db, req, { acao: 'despesa.alterada', entidade: 'despesa', entidade_id: atual.id, antes: atual, depois: d });
    res.json(nova);
  });

  /**
   * Remove a despesa. Uma despesa mensal que já valeu em meses fechados deve ser ENCERRADA (último mês),
   * não apagada — senão os meses passados mudam. Por isso a exclusão só vale para a despesa que nunca entrou
   * num mês anterior ao atual.
   */
  r.delete('/despesas/:id', exigir('despesas.editar'), (req, res) => {
    const atual = db.prepare('SELECT * FROM despesas WHERE id = ?').get(Number(req.params.id));
    if (!atual) throw naoEncontrado('Despesa');
    if (atual.inicio < mesAtual()) {
      throw new ErroNegocio('Esta despesa já entrou em meses anteriores: encerre (informe o último mês) em vez de excluir.', 409);
    }
    db.prepare('DELETE FROM despesas WHERE id = ?').run(atual.id);
    auditoria.registrar(db, req, { acao: 'despesa.excluida', entidade: 'despesa', entidade_id: atual.id, antes: atual });
    res.json({ excluida: true });
  });

  /** Alíquota de impostos sobre a receita (ex.: a efetiva do Simples Nacional, informada pela contabilidade). */
  r.put('/imposto', exigir('despesas.editar'), (req, res) => {
    const ppm = v.percentual(req.body?.percentual ?? '0', 'a alíquota', { max: 50 });
    const antes = resultado.impostoPpm(db);
    resultado.gravarImposto(db, ppm);
    auditoria.registrar(db, req, { acao: 'resultado.imposto', antes: { ppm: antes }, depois: { ppm } });
    res.json({ ppm });
  });

  return r;
};
