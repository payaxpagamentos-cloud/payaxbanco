'use strict';

const express = require('express');
const config = require('../config');
const { agora, transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { exigir } = require('../auth');
const { conferirVersao } = require('../lib/http');
const v = require('../lib/validacao');
const datas = require('../lib/datas');
const precos = require('../lib/precos');
const auditoria = require('../lib/auditoria');

const hoje = () => datas.dataLocal(config.fusoPadrao);

function corpoConta(b, { novo = false } = {}) {
  const d = {};
  if (novo || b.apelido !== undefined) d.apelido = v.texto(b.apelido, 'o apelido da conta', 60);
  if (novo || b.agencia !== undefined) d.agencia = v.digitos(b.agencia).slice(0, 5) || v.falhar('Informe a agência.');
  if (novo || b.conta !== undefined) d.conta = v.digitos(b.conta).slice(0, 12) || v.falhar('Informe a conta.');
  if (novo || b.cedente !== undefined) d.cedente = v.digitos(b.cedente).slice(0, 10) || v.falhar('Informe o código do beneficiário (cedente).');
  if (novo || b.beneficiario_nome !== undefined) d.beneficiario_nome = v.texto(b.beneficiario_nome, 'o nome do beneficiário', 70);
  if (novo || b.beneficiario_documento !== undefined) d.beneficiario_documento = v.documento(b.beneficiario_documento, 'o CNPJ do beneficiário');
  if (b.agencia_dv !== undefined) d.agencia_dv = v.opcional(b.agencia_dv, 'o dígito da agência', 2);
  if (b.conta_dv !== undefined) d.conta_dv = v.opcional(b.conta_dv, 'o dígito da conta', 2);
  if (b.carteira !== undefined) d.carteira = v.digitos(b.carteira).padStart(2, '0').slice(0, 2);
  if (b.beneficiario_endereco !== undefined) d.beneficiario_endereco = v.opcional(b.beneficiario_endereco, 'o endereço', 120);
  if (b.beneficiario_cidade !== undefined) d.beneficiario_cidade = v.opcional(b.beneficiario_cidade, 'a cidade', 60);
  if (b.beneficiario_uf !== undefined) d.beneficiario_uf = v.ufOpcional(b.beneficiario_uf);
  if (b.beneficiario_cep !== undefined) d.beneficiario_cep = b.beneficiario_cep ? v.cep(b.beneficiario_cep) : null;
  if (b.pix_chave !== undefined) {
    if (!b.pix_chave) { d.pix_chave = null; d.pix_tipo = null; }
    else { const k = v.chavePix(b.pix_chave, b.pix_tipo); d.pix_chave = k.chave; d.pix_tipo = k.tipo; }
  }
  if (b.nosso_numero_inicial !== undefined) d.nosso_numero_inicial = v.inteiro(b.nosso_numero_inicial, 'o início da faixa', { min: 1, max: 99999999999 });
  if (b.nosso_numero_final !== undefined) d.nosso_numero_final = v.inteiro(b.nosso_numero_final, 'o fim da faixa', { min: 1, max: 99999999999 });
  if (b.custo_emissao !== undefined) d.custo_emissao_centavos = v.centavos(b.custo_emissao, 'o custo de emissão');
  if (b.custo_liquidacao !== undefined) d.custo_liquidacao_centavos = v.centavos(b.custo_liquidacao, 'o custo de liquidação');
  if (b.custo_pix !== undefined) d.custo_pix_centavos = v.centavos(b.custo_pix, 'o custo do PIX');
  if (b.ativa !== undefined) d.ativa = v.booleano(b.ativa) ? 1 : 0;
  return d;
}

module.exports = (db) => {
  const r = express.Router();

  r.get('/', exigir('clientes.ver'), (req, res) => {
    res.json({
      itens: db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM boletos b WHERE b.conta_id = c.id) AS boletos,
          c.nosso_numero_final - MAX(c.nosso_numero_atual, c.nosso_numero_inicial - 1) AS faixa_restante
        FROM contas_bancarias c ORDER BY c.padrao DESC, c.apelido`).all(),
      modo_banco: config.banco.modo,
      ambiente: config.banco.ambiente,
    });
  });

  r.post('/', exigir('*'), (req, res) => {
    const d = corpoConta(req.body ?? {}, { novo: true });
    if ((d.nosso_numero_final ?? 99999999999) <= (d.nosso_numero_inicial ?? 1)) throw new ErroNegocio('A faixa de nosso número está invertida.', 422);
    const campos = Object.keys(d);
    const id = transacao(db, () => {
      const novo = db.prepare(`INSERT INTO contas_bancarias (${campos.join(', ')}, criado_em) VALUES (${campos.map(() => '?').join(', ')}, ?) RETURNING id`)
        .get(...campos.map((k) => d[k]), agora()).id;
      if (!db.prepare('SELECT COUNT(*) AS n FROM contas_bancarias WHERE padrao = 1').get().n) {
        db.prepare('UPDATE contas_bancarias SET padrao = 1 WHERE id = ?').run(novo);
      }
      return novo;
    });
    auditoria.registrar(db, req, { acao: 'conta.criada', entidade: 'conta_bancaria', entidade_id: id, depois: d });
    res.status(201).json(db.prepare('SELECT * FROM contas_bancarias WHERE id = ?').get(id));
  });

  r.patch('/:id', exigir('*'), (req, res) => {
    const c = db.prepare('SELECT * FROM contas_bancarias WHERE id = ?').get(Number(req.params.id));
    if (!c) throw naoEncontrado('Conta');
    conferirVersao(c.versao, req.body?.versao);
    const d = corpoConta(req.body ?? {});
    if (d.nosso_numero_inicial !== undefined && d.nosso_numero_inicial - 1 < c.nosso_numero_atual) {
      throw new ErroNegocio('O início da faixa não pode ser menor que o nosso número já utilizado.', 422);
    }
    if (!Object.keys(d).length) throw new ErroNegocio('Nada para alterar.', 422);
    const campos = Object.keys(d);
    db.prepare(`UPDATE contas_bancarias SET ${campos.map((k) => `${k} = ?`).join(', ')}, versao = versao + 1 WHERE id = ?`).run(...campos.map((k) => d[k]), c.id);
    if (v.booleano(req.body?.padrao)) {
      transacao(db, () => {
        db.prepare('UPDATE contas_bancarias SET padrao = 0').run();
        db.prepare('UPDATE contas_bancarias SET padrao = 1 WHERE id = ?').run(c.id);
      });
    }
    auditoria.registrar(db, req, { acao: 'conta.alterada', entidade: 'conta_bancaria', entidade_id: c.id,
      antes: Object.fromEntries(campos.map((k) => [k, c[k]])), depois: d });
    res.json(db.prepare('SELECT * FROM contas_bancarias WHERE id = ?').get(c.id));
  });

  // Tabela de preços padrão da plataforma (cliente_id nulo): vale para quem não tem tabela própria.
  r.get('/precos-padrao', exigir('precos.ver'), (_req, res) => {
    res.json({
      vigente: precos.vigente(db, null, hoje()),
      historico: db.prepare('SELECT * FROM precos WHERE cliente_id IS NULL ORDER BY vigencia_inicio DESC, id DESC').all(),
    });
  });

  r.post('/precos-padrao', exigir('precos.editar'), (req, res) => {
    const b = req.body ?? {};
    const inicio = b.vigencia_inicio ? v.data(b.vigencia_inicio, 'o início da vigência') : hoje();
    const d = {
      tarifa_emissao_centavos: v.centavos(b.tarifa_emissao ?? 0, 'a tarifa de emissão'),
      tarifa_liquidacao_centavos: v.centavos(b.tarifa_liquidacao ?? 0, 'a tarifa de liquidação'),
      percentual_ppm: b.percentual === undefined || b.percentual === '' ? 0 : v.percentual(b.percentual, 'o percentual', { max: 50 }),
      comissao_minima_centavos: v.centavos(b.comissao_minima ?? 0, 'a tarifa mínima'),
      comissao_maxima_centavos: v.centavosOpcional(b.comissao_maxima, 'a tarifa máxima'),
      tarifa_repasse_centavos: v.centavos(b.tarifa_repasse ?? 0, 'a tarifa de repasse'),
      observacao: v.opcional(b.observacao, 'a observação', 200),
    };
    const id = transacao(db, () => {
      db.prepare(`UPDATE precos SET vigencia_fim = date(?, '-1 day') WHERE cliente_id IS NULL AND vigencia_fim IS NULL AND vigencia_inicio < ?`).run(inicio, inicio);
      return db.prepare(`INSERT INTO precos (cliente_id, vigencia_inicio, tarifa_emissao_centavos, tarifa_liquidacao_centavos,
          percentual_ppm, comissao_minima_centavos, comissao_maxima_centavos, tarifa_repasse_centavos, observacao, criado_em, criado_por)
        VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
        .get(inicio, d.tarifa_emissao_centavos, d.tarifa_liquidacao_centavos, d.percentual_ppm, d.comissao_minima_centavos,
          d.comissao_maxima_centavos, d.tarifa_repasse_centavos, d.observacao, agora(), req.usuario.id).id;
    });
    auditoria.registrar(db, req, { acao: 'preco.padrao.definido', entidade: 'preco', entidade_id: id, depois: { ...d, vigencia_inicio: inicio } });
    res.status(201).json(db.prepare('SELECT * FROM precos WHERE id = ?').get(id));
  });

  return r;
};
