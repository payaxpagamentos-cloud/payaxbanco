'use strict';

/*
 * PLD (Backoffice). Só o administrador: sigilo da Lei 9.613/1998, art. 11, II.
 * A auditoria registra só identificadores e a situação, nunca o conteúdo da análise.
 */
const express = require('express');
const { exigir } = require('../auth');
const pld = require('../lib/pld');
const consultaDados = require('../lib/consultaDados');
const auditoria = require('../lib/auditoria');
const { naoEncontrado } = require('../lib/erros');

module.exports = (db) => {
  const r = express.Router();
  const ver = exigir('pld.ver', '*');
  const analisar = exigir('pld.analisar', '*');

  r.get('/', ver, (_req, res) => {
    res.json({ resumo: pld.resumo(db), regras: pld.REGRAS.map((x) => ({ id: x.id, titulo: x.titulo, porque: x.porque })) });
  });

  r.get('/alertas', ver, (req, res) => {
    res.json({ itens: pld.listar(db, { situacao: req.query.situacao || null, regra: req.query.regra || null, cliente_id: req.query.cliente_id || null }) });
  });

  r.get('/alertas/:id', ver, (req, res) => res.json(pld.alerta(db, Number(req.params.id))));

  const passo = (acao, fn) => (req, res) => {
    const out = fn(db, Number(req.params.id), req.body ?? {}, req.usuario);
    auditoria.registrar(db, req, { acao: `pld.${acao}`, entidade: 'pld_alerta', entidade_id: out.id, depois: { situacao: out.situacao } });
    res.json(out);
  };
  r.post('/alertas/:id/assumir', analisar, passo('assumido', (d, id, _b, u) => pld.assumir(d, id, u)));
  r.post('/alertas/:id/arquivar', analisar, passo('arquivado', pld.arquivar));
  r.post('/alertas/:id/comunicar', analisar, passo('decidido_comunicar', pld.decidirComunicar));
  r.post('/alertas/:id/comunicado', analisar, passo('comunicado', pld.registrarComunicacao));

  /** Roda as regras agora (normalmente roda sozinho, de hora em hora). */
  r.post('/monitorar', analisar, (req, res) => {
    const out = pld.monitorar(db);
    auditoria.registrar(db, req, { acao: 'pld.monitorado', entidade: 'pld', depois: { novos: out.novos } });
    res.json(out);
  });

  // ---------------------------------------------------------------- Conheça seu cliente
  r.get('/clientes', ver, (_req, res) => res.json({ itens: pld.listarKyc(db) }));

  r.put('/clientes/:id', analisar, (req, res) => {
    const out = pld.salvarKyc(db, Number(req.params.id), req.body ?? {}, req.usuario);
    auditoria.registrar(db, req, { acao: 'pld.cadastro_revisado', entidade: 'cliente', entidade_id: out.id, cliente_id: out.id });
    res.json(out);
  });

  /** Sócios na Receita, para preencher o cadastro (só aqui: é obrigação legal, art. 10, § 1º). */
  r.get('/clientes/:id/receita', analisar, async (req, res) => {
    const c = db.prepare('SELECT cnpj FROM clientes WHERE id = ?').get(Number(req.params.id));
    if (!c) throw naoEncontrado('Cliente');
    res.json(await consultaDados.consultarSocios(db, c.cnpj));
  });

  r.post('/clientes/:id/suspender-repasse', analisar, (req, res) => {
    const out = pld.suspenderRepasse(db, Number(req.params.id), req.body ?? {}, req.usuario);
    auditoria.registrar(db, req, { acao: 'repasse.suspenso_ordem_legal', entidade: 'cliente', entidade_id: out.cliente_id, cliente_id: out.cliente_id, depois: out });
    res.json(out);
  });

  r.post('/clientes/:id/liberar-repasse', analisar, (req, res) => {
    const out = pld.liberarRepasse(db, Number(req.params.id), req.body ?? {}, req.usuario);
    auditoria.registrar(db, req, { acao: 'repasse.liberado_ordem_legal', entidade: 'cliente', entidade_id: out.cliente_id, cliente_id: out.cliente_id, depois: out });
    res.json(out);
  });

  // ---------------------------------------------------------------- Não ocorrência e parâmetros
  r.get('/declaracoes', ver, (_req, res) => res.json({ itens: pld.declaracoes(db) }));
  r.post('/declaracoes', analisar, (req, res) => {
    const out = pld.registrarDeclaracao(db, req.body ?? {}, req.usuario);
    auditoria.registrar(db, req, { acao: 'pld.nao_ocorrencia', entidade: 'pld', depois: { ano: out.ano } });
    res.status(201).json(out);
  });

  r.get('/parametros', ver, (_req, res) => {
    const atual = pld.parametros(db);
    res.json(Object.entries(pld.PARAMETROS).map(([k, p]) => ({ chave: k, rotulo: p.rotulo, dinheiro: Boolean(p.dinheiro), valor: atual[k], padrao: p.padrao })));
  });
  r.put('/parametros', analisar, (req, res) => {
    const out = pld.gravarParametros(db, req.body ?? {});
    auditoria.registrar(db, req, { acao: 'pld.parametros', entidade: 'pld', depois: out });
    res.json(out);
  });

  return r;
};
