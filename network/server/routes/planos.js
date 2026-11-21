'use strict';

const { Router } = require('express');
const { agora } = require('../db');
const { exigir } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { conferirVersao } = require('../lib/http');
const v = require('../lib/validacao');

const TIPOS_PLANO = ['internet', 'voz', 'sva', 'combo'];
const TECNOLOGIAS = ['fibra', 'radio', 'cabo', 'satelite'];

function dadosPlano(b, atual = {}) {
  const val = (k, f) => (b[k] !== undefined ? f(b[k]) : atual[k] ?? null);
  const tipo = val('tipo', (x) => v.opcao(x, 'o tipo', TIPOS_PLANO)) ?? 'internet';
  const d = {
    nome: val('nome', (x) => v.texto(x, 'o nome', 120)),
    tipo,
    tecnologia: val('tecnologia', (x) => (x ? v.opcao(x, 'a tecnologia', TECNOLOGIAS) : null)),
    download_mbps: val('download_mbps', (x) => v.inteiroOpcional(x, 'o download', { min: 1, max: 100_000 })),
    upload_mbps: val('upload_mbps', (x) => v.inteiroOpcional(x, 'o upload', { min: 1, max: 100_000 })),
    mensalidade_centavos: b.mensalidade !== undefined ? v.centavos(b.mensalidade, 'a mensalidade') : atual.mensalidade_centavos ?? 0,
    instalacao_centavos: b.instalacao !== undefined ? v.centavos(b.instalacao, 'a taxa de instalação') : atual.instalacao_centavos ?? 0,
    fidelidade_meses: b.fidelidade_meses !== undefined ? v.inteiro(b.fidelidade_meses, 'a fidelidade', { max: 60 }) : atual.fidelidade_meses ?? 0,
    descricao: val('descricao', (x) => v.opcional(x, 'a descrição', 500)),
    ativo: b.ativo !== undefined ? (v.booleano(b.ativo) ? 1 : 0) : atual.ativo ?? 1,
  };
  if (tipo === 'internet' || tipo === 'combo') v.exigir(d.download_mbps, 'Informe a velocidade de download do plano de internet.');
  return d;
}

/*
 * Planos comerciais. Alterar um plano nunca altera o que já foi contratado: cada contrato guarda a própria
 * mensalidade, porque o preço acordado com o assinante é dele, não da tabela de preços de hoje.
 */
module.exports = (db) => {
  const r = Router();

  // ---------------- Planos ----------------
  r.get('/', exigir('contratos.ver', 'faturamento.ver'), (req, res) => {
    const f = ['organizacao_id = ?'];
    const p = [req.org];
    if (req.query.ativos !== '0') f.push('ativo = 1');
    if (req.query.tipo) { f.push('tipo = ?'); p.push(String(req.query.tipo)); }
    const planos = db.prepare(`SELECT * FROM planos WHERE ${f.join(' AND ')} ORDER BY nome`).all(...p);
    const emUso = db.prepare('SELECT plano_id, COUNT(*) AS n FROM contratos WHERE organizacao_id = ? GROUP BY plano_id').all(req.org);
    const mapa = new Map(emUso.map((x) => [x.plano_id, x.n]));
    res.json(planos.map((x) => ({ ...x, contratos: mapa.get(x.id) ?? 0 })));
  });

  r.post('/', exigir('planos.editar'), (req, res) => {
    const d = dadosPlano(req.body ?? {});
    v.exigir(d.nome, 'Informe o nome do plano.');
    if (db.prepare('SELECT 1 FROM planos WHERE organizacao_id = ? AND nome = ?').get(req.org, d.nome)) {
      throw new ErroNegocio(`Já existe um plano chamado ${d.nome}.`, 409);
    }
    const id = Number(db.prepare(`INSERT INTO planos (organizacao_id, nome, tipo, tecnologia, download_mbps, upload_mbps, mensalidade_centavos, instalacao_centavos,
      fidelidade_meses, descricao, ativo, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.org, d.nome, d.tipo, d.tecnologia, d.download_mbps, d.upload_mbps, d.mensalidade_centavos, d.instalacao_centavos, d.fidelidade_meses,
        d.descricao, d.ativo, agora()).lastInsertRowid);
    registrar(db, req, 'plano_criado', { recurso: 'plano', recursoId: id, depois: d });
    res.status(201).json(db.prepare('SELECT * FROM planos WHERE id = ?').get(id));
  });

  r.patch('/:id', exigir('planos.editar'), (req, res) => {
    const antes = db.prepare('SELECT * FROM planos WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!antes) throw new ErroNegocio('Plano não encontrado.', 404);
    conferirVersao(antes.versao, req.body?.versao);
    const d = dadosPlano(req.body ?? {}, antes);
    if (d.nome !== antes.nome && db.prepare('SELECT 1 FROM planos WHERE organizacao_id = ? AND nome = ? AND id <> ?').get(req.org, d.nome, antes.id)) {
      throw new ErroNegocio(`Já existe um plano chamado ${d.nome}.`, 409);
    }
    db.prepare(`UPDATE planos SET nome = ?, tipo = ?, tecnologia = ?, download_mbps = ?, upload_mbps = ?, mensalidade_centavos = ?, instalacao_centavos = ?,
      fidelidade_meses = ?, descricao = ?, ativo = ?, versao = versao + 1 WHERE id = ?`)
      .run(d.nome, d.tipo, d.tecnologia, d.download_mbps, d.upload_mbps, d.mensalidade_centavos, d.instalacao_centavos, d.fidelidade_meses, d.descricao, d.ativo, antes.id);
    registrar(db, req, 'plano_alterado', { recurso: 'plano', recursoId: antes.id, antes, depois: d });
    // Alterar o plano não altera o que já foi contratado: cada contrato guarda o próprio valor.
    res.json({ ...db.prepare('SELECT * FROM planos WHERE id = ?').get(antes.id), aviso: 'Os contratos em vigor mantêm o valor contratado; o novo valor vale para contratos novos.' });
  });


  return r;
};
