'use strict';

/* Remessa e retorno (CNAB 400): acompanhamento, geração sob demanda e envio manual de um retorno. */
const express = require('express');
const config = require('../config');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { exigir } = require('../auth');
const arquivos = require('../lib/arquivosBanco');
const boletosLib = require('../lib/boletos');
const auditoria = require('../lib/auditoria');

module.exports = (db) => {
  const r = express.Router();

  r.get('/', exigir('conciliacao.ver'), (_req, res) => {
    res.json({
      ...arquivos.situacao(db),
      remessas: db.prepare(`SELECT m.*, u.nome AS criado_por_nome FROM remessas m LEFT JOIN usuarios u ON u.id = m.criado_por
        ORDER BY m.id DESC LIMIT 50`).all(),
      retornos: db.prepare(`SELECT t.*, u.nome AS criado_por_nome FROM retornos t LEFT JOIN usuarios u ON u.id = t.criado_por
        ORDER BY t.id DESC LIMIT 50`).all(),
    });
  });

  /** Gera a remessa agora com o que estiver esperando (a rotina já faz isso sozinha em dia útil). */
  r.post('/remessas', exigir('conciliacao.operar'), (req, res) => {
    const conta = boletosLib.contaDe(db, req.body?.conta_id);
    const out = arquivos.gerarRemessa(db, conta, { usuario: req.usuario, automatica: false });
    if (out.vazia) throw new ErroNegocio('Não há títulos esperando para ir ao banco.', 422);
    auditoria.registrar(db, req, { acao: 'remessa.gerada', entidade: 'remessa', entidade_id: out.id, depois: { nome: out.nome, titulos: out.titulos } });
    res.status(201).json(out);
  });

  r.get('/remessas/:id', exigir('conciliacao.ver'), (req, res) => {
    const a = arquivos.conteudoRemessa(db, req.params.id);
    if (!a) throw naoEncontrado('Arquivo de remessa');
    auditoria.registrar(db, req, { acao: 'remessa.baixada', entidade: 'remessa', entidade_id: Number(req.params.id) });
    res.set('Content-Type', 'text/plain; charset=latin1').attachment(a.nome).send(Buffer.from(a.conteudo, 'latin1'));
  });

  /** Varre a pasta de entrada agora (a rotina já faz a cada ciclo). */
  r.post('/varrer', exigir('conciliacao.operar'), (req, res) => {
    const out = arquivos.varrerRetornos(db, { usuario: req.usuario });
    auditoria.registrar(db, req, { acao: 'retorno.varredura', depois: { arquivos: out.arquivos } });
    res.json(out);
  });

  /**
   * Envio manual de um retorno — rede fora do ar, arquivo que chegou por e-mail, reprocesso.
   * O caminho normal é a pasta; isto é a saída de emergência.
   */
  r.post('/retornos', exigir('conciliacao.operar'), (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new ErroNegocio('Envie o arquivo de retorno no corpo da requisição.', 400);
    if (req.body.length > 10 * 1024 * 1024) throw new ErroNegocio('Arquivo grande demais.', 413);
    const nome = decodeURIComponent(req.get('x-nome-arquivo') ?? 'retorno.RET');
    const out = arquivos.processarRetorno(db, req.body.toString('latin1'), { nome, origem: 'upload', usuario: req.usuario });
    auditoria.registrar(db, req, { acao: 'retorno.processado', entidade: 'retorno', entidade_id: out.id,
      depois: { nome, liquidados: out.liquidados, rejeitados: out.rejeitados, ja_processado: out.ja_processado ?? false } });
    res.status(out.ja_processado ? 200 : 201).json(out);
  });

  return r;
};
