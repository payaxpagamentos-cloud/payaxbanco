'use strict';

const crypto = require('node:crypto');
const express = require('express');
const config = require('../config');
const { agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { exigir } = require('../auth');
const { cifrar, decifrar } = require('../lib/cripto');
const v = require('../lib/validacao');
const sincronismo = require('../lib/sincronismo');
const boletosLib = require('../lib/boletos');
const { criarBanco } = require('../lib/bradesco');
const auditoria = require('../lib/auditoria');

/** Guarda credenciais cifradas de um escopo. */
function gravar(db, { escopo, cliente_id = null, conta_id = null, credenciais, cfg, usuario }) {
  const existente = db.prepare('SELECT * FROM integracoes WHERE escopo = ? AND IFNULL(cliente_id, 0) = ? AND IFNULL(conta_id, 0) = ?')
    .get(escopo, cliente_id ?? 0, conta_id ?? 0);
  const cifradas = credenciais ? cifrar(JSON.stringify(credenciais)) : existente?.credenciais ?? null;
  if (existente) {
    db.prepare("UPDATE integracoes SET credenciais = ?, config = ?, estado = 'nao_configurada', atualizado_em = ?, atualizado_por = ? WHERE id = ?")
      .run(cifradas, JSON.stringify(cfg ?? {}), agora(), usuario.id, existente.id);
    return existente.id;
  }
  return db.prepare(`INSERT INTO integracoes (escopo, cliente_id, conta_id, credenciais, config, atualizado_em, atualizado_por)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(escopo, cliente_id, conta_id, cifradas, JSON.stringify(cfg ?? {}), agora(), usuario.id).id;
}

const semSegredo = (i) => (i ? {
  id: i.id, escopo: i.escopo, cliente_id: i.cliente_id, conta_id: i.conta_id, estado: i.estado,
  configurada: Boolean(i.credenciais), config: JSON.parse(i.config || '{}'),
  ultimo_teste: i.ultimo_teste, ultimo_erro: i.ultimo_erro, atualizado_em: i.atualizado_em,
} : null);

module.exports = (db) => {
  const r = express.Router();

  r.get('/', exigir('integracoes.ver', 'precos.ver'), (_req, res) => {
    const banco = db.prepare("SELECT * FROM integracoes WHERE escopo = 'banco' ORDER BY id LIMIT 1").get();
    res.json({
      banco: { ...semSegredo(banco), modo: config.banco.modo, ambiente: config.banco.ambiente },
      ixc: db.prepare(`SELECT i.*, c.razao_social, c.nome_fantasia FROM integracoes i JOIN clientes c ON c.id = i.cliente_id
        WHERE i.escopo = 'ixc' ORDER BY c.razao_social`).all().map((i) => ({ ...semSegredo(i), razao_social: i.razao_social, nome_fantasia: i.nome_fantasia })),
      sincronismos: db.prepare(`SELECT s.*, c.razao_social FROM sincronismos s JOIN clientes c ON c.id = s.cliente_id
        ORDER BY s.id DESC LIMIT 30`).all(),
    });
  });

  // ---------------------------------------------------------------- Bradesco
  r.put('/banco', exigir('*'), (req, res) => {
    const b = req.body ?? {};
    const conta = b.conta_id ? db.prepare('SELECT id FROM contas_bancarias WHERE id = ?').get(Number(b.conta_id)) : null;
    const credenciais = b.client_id ? {
      client_id: v.texto(b.client_id, 'o client_id', 200),
      client_secret: v.opcional(b.client_secret, 'o client_secret', 400),
      certificado_pem: v.opcional(b.certificado_pem, 'o certificado', 20000),
      chave_privada_pem: v.opcional(b.chave_privada_pem, 'a chave privada', 20000),
      chave_senha: v.opcional(b.chave_senha, 'a senha da chave', 200),
    } : null;
    if (credenciais?.chave_privada_pem && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(credenciais.chave_privada_pem)) {
      throw new ErroNegocio('A chave privada precisa estar no formato PEM (-----BEGIN PRIVATE KEY-----).', 422);
    }
    const cfg = {
      ambiente: v.opcao(b.ambiente ?? config.banco.ambiente, 'o ambiente', ['homologacao', 'producao']),
      webhook_token: b.webhook_token ? v.texto(b.webhook_token, 'o token do webhook', 100) : crypto.randomBytes(24).toString('base64url'),
    };
    const id = gravar(db, { escopo: 'banco', conta_id: conta?.id ?? null, credenciais, cfg, usuario: req.usuario });
    auditoria.registrar(db, req, { acao: 'integracao.banco.configurada', entidade: 'integracao', entidade_id: id, depois: { ambiente: cfg.ambiente, conta_id: conta?.id ?? null } });
    res.json({ ...semSegredo(db.prepare('SELECT * FROM integracoes WHERE id = ?').get(id)),
      webhook_caminho: `${config.basePath}/api/publico/webhook/${cfg.webhook_token}` });
  });

  r.post('/banco/testar', exigir('integracoes.ver', '*'), async (req, res) => {
    const conta = boletosLib.contaDe(db, req.body?.conta_id);
    const i = db.prepare("SELECT * FROM integracoes WHERE escopo = 'banco' ORDER BY id LIMIT 1").get();
    try {
      const banco = criarBanco(conta, boletosLib.credenciaisDaConta(db, conta.id));
      const out = await banco.testar();
      if (i) db.prepare("UPDATE integracoes SET estado = 'conectada', ultimo_teste = ?, ultimo_erro = NULL WHERE id = ?").run(agora(), i.id);
      res.json({ ...out, modo: banco.modo });
    } catch (err) {
      if (i) db.prepare("UPDATE integracoes SET estado = 'falha', ultimo_teste = ?, ultimo_erro = ? WHERE id = ?").run(agora(), err.message, i.id);
      throw new ErroNegocio(err.message, err.status === 401 ? 401 : 502);
    }
  });

  // ---------------------------------------------------------------- IXC por cliente
  r.put('/ixc/:clienteId', exigir('integracoes.ixc', '*'), (req, res) => {
    const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(Number(req.params.clienteId));
    if (!cliente) throw naoEncontrado('Cliente');
    const b = req.body ?? {};
    const credenciais = b.token ? { url: v.url(b.url, 'o endereço do IXC'), token: v.texto(b.token, 'o token', 200) } : null;
    const cfg = {
      url: b.url ? v.url(b.url, 'o endereço do IXC') : undefined,
      tipo_padrao: v.opcao(b.tipo_padrao ?? 'bolepix', 'o tipo padrão', ['boleto', 'bolepix']),
      juros_mes: b.juros_mes === undefined || b.juros_mes === '' ? 1 : Number(String(b.juros_mes).replace(',', '.')),
      multa: b.multa === undefined || b.multa === '' ? 2 : Number(String(b.multa).replace(',', '.')),
      mensagem: v.opcional(b.mensagem, 'a mensagem do boleto', 160),
      anotar_no_ixc: b.anotar_no_ixc === undefined ? true : v.booleano(b.anotar_no_ixc),
      importacao_automatica: v.booleano(b.importacao_automatica),
      dias_a_frente: v.inteiroOpcional(b.dias_a_frente, 'os dias à frente', { min: 1, max: 90 }) ?? 10,
    };
    const id = gravar(db, { escopo: 'ixc', cliente_id: cliente.id, credenciais, cfg, usuario: req.usuario });
    auditoria.registrar(db, req, { acao: 'integracao.ixc.configurada', entidade: 'integracao', entidade_id: id, cliente_id: cliente.id, depois: cfg });
    res.json(semSegredo(db.prepare('SELECT * FROM integracoes WHERE id = ?').get(id)));
  });

  r.post('/ixc/:clienteId/testar', exigir('integracoes.ixc', '*'), async (req, res) => {
    res.json(await sincronismo.testar(db, Number(req.params.clienteId)));
  });

  r.post('/ixc/:clienteId/importar', exigir('boletos.emitir'), async (req, res) => {
    const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(Number(req.params.clienteId));
    if (!cliente) throw naoEncontrado('Cliente');
    const hoje = sincronismo.hoje();
    const out = await sincronismo.importar(db, cliente, {
      de: req.body?.de ? v.data(req.body.de, 'a data inicial') : hoje,
      ate: req.body?.ate ? v.data(req.body.ate, 'a data final') : require('../lib/datas').somarDias(hoje, 10),
      limite: v.inteiroOpcional(req.body?.limite, 'o limite', { min: 1, max: 500 }) ?? 200,
      usuario: req.usuario,
    });
    auditoria.registrar(db, req, { acao: 'ixc.importacao', entidade: 'sincronismo', entidade_id: out.sincronismo_id, cliente_id: cliente.id,
      depois: { lidos: out.lidos, criados: out.criados, ignorados: out.ignorados, erros: out.erros } });
    res.json(out);
  });

  r.get('/ixc/:clienteId/credenciais', exigir('*'), (req, res) => {
    // Devolve só o endereço (nunca o token), para a tela mostrar o que está configurado.
    const i = db.prepare("SELECT * FROM integracoes WHERE escopo = 'ixc' AND cliente_id = ?").get(Number(req.params.clienteId));
    if (!i?.credenciais) return res.json({ configurada: false });
    try {
      const c = JSON.parse(decifrar(i.credenciais));
      res.json({ configurada: true, url: c.url, token_final: String(c.token ?? '').slice(-4) });
    } catch {
      res.json({ configurada: false, erro: 'Não foi possível decifrar as credenciais (a chave mudou?).' });
    }
  });

  return r;
};
