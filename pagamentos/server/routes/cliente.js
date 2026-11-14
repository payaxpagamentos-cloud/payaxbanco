'use strict';

/*
 * API da Área do Cliente (cliente final). Toda consulta e todo comando são presos ao cliente da sessão:
 * o cliente_id NUNCA vem do corpo da requisição — vem do token, resolvido no banco a cada chamada.
 */
const express = require('express');
const config = require('../config');
const { agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { emitirToken, emitirDesafio, lerDesafio, sessaoCliente, exigir } = require('../auth');
const { hashSenha, verificarSenha } = require('../lib/senha');
const { csv, listaPaginada } = require('../lib/http');
const v = require('../lib/validacao');
const datas = require('../lib/datas');
const razao = require('../lib/razao');
const precos = require('../lib/precos');
const boletosLib = require('../lib/boletos');
const repassesLib = require('../lib/repasses');
const consultas = require('../lib/consultas');
const impressao = require('../lib/impressao');
const sincronismo = require('../lib/sincronismo');
const auditoria = require('../lib/auditoria');
const contaInterna = require('../lib/contaInterna');
const contaDestino = require('../lib/contaDestino');
const dois = require('../lib/doisfatores');
const { detalhe, assinaturaFicha } = require('./boletos');

const hoje = () => datas.dataLocal(config.fusoPadrao);
const periodo = (q) => ({ de: q.de || datas.primeiroDiaMes(hoje()), ate: q.ate || hoje() });

/** O cliente vê o que paga (tarifa bancária e tarifa PAY AX), nunca o nosso custo com o banco nem a margem. */
const semMargem = (d) => ({
  ...d,
  custo_liquidacao_centavos: undefined,
  split: d.split ? { ...d.split, custo_banco_centavos: undefined, margem_centavos: undefined, receita_centavos: undefined } : undefined,
});

module.exports = (db, autenticado) => {
  const r = express.Router();
  const meuCliente = (req) => {
    const c = db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.clienteId);
    if (!c) throw naoEncontrado('Cliente');
    return c;
  };

  // ---------------------------------------------------------------- sessão
  r.post('/auth/login', (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const u = db.prepare(`SELECT uc.*, c.situacao AS cliente_situacao, c.razao_social, c.nome_fantasia, c.cnpj
      FROM usuarios_cliente uc JOIN clientes c ON c.id = uc.cliente_id WHERE uc.email = ?`).get(email);
    if (!u || !u.ativo || !verificarSenha(String(req.body?.senha ?? ''), u.senha_hash)) {
      throw new ErroNegocio('E-mail ou senha inválidos.', 401);
    }
    if (u.cliente_situacao === 'encerrado') throw new ErroNegocio('Conta encerrada. Fale com o seu gerente.', 403);
    if (u.totp_ativo) return res.json({ precisa_2fa: true, desafio: emitirDesafio(u.id, 'cliente') });
    return concluirLogin(req, res, u);
  });

  /** Segunda etapa do login do cliente. */
  r.post('/auth/2fa', (req, res) => {
    const d = lerDesafio(req.body?.desafio, 'cliente');
    if (!d) throw new ErroNegocio('A verificação expirou. Entre de novo.', 401);
    const u = db.prepare(`SELECT uc.*, c.situacao AS cliente_situacao, c.razao_social, c.nome_fantasia, c.cnpj
      FROM usuarios_cliente uc JOIN clientes c ON c.id = uc.cliente_id WHERE uc.id = ?`).get(d.sub);
    if (!u || !u.ativo) throw new ErroNegocio('Acesso inativo.', 401);
    if (!dois.conferir(db, 'cliente', u.id, req.body?.codigo)) {
      throw new ErroNegocio('Código inválido. Confira o horário do celular e tente de novo.', 401);
    }
    return concluirLogin(req, res, u);
  });

  function concluirLogin(req, res, u) {
    db.prepare('UPDATE usuarios_cliente SET ultimo_acesso = ? WHERE id = ?').run(agora(), u.id);
    auditoria.registrar(db, { ...req, usuario: u, usuarioTipo: 'cliente' },
      { acao: 'cliente.login', entidade: 'usuario_cliente', entidade_id: u.id, cliente_id: u.cliente_id });
    return res.json({ token: emitirToken(u.id, 'payax-cliente'), usuario: sessaoCliente(u) });
  }

  r.use(autenticado);

  r.get('/auth/eu', (req, res) => res.json({ usuario: sessaoCliente(req.usuario) }));

  // ---------------------------------------------------------------- 2FA do cliente
  r.post('/auth/2fa/iniciar', async (req, res) => res.json(await dois.iniciar(db, 'cliente', req.usuario, req.usuario.email)));

  r.post('/auth/2fa/ativar', (req, res) => {
    dois.ativar(db, 'cliente', req.usuario, req.body?.codigo);
    auditoria.registrar(db, req, { acao: 'cliente.2fa.ativada', entidade: 'usuario_cliente', entidade_id: req.usuario.id, cliente_id: req.clienteId });
    res.json({ ok: true });
  });

  r.post('/auth/2fa/desativar', (req, res) => {
    dois.desativar(db, 'cliente', req.usuario.id, req.body?.senha, req.body?.codigo);
    auditoria.registrar(db, req, { acao: 'cliente.2fa.desativada', entidade: 'usuario_cliente', entidade_id: req.usuario.id, cliente_id: req.clienteId });
    res.json({ ok: true });
  });

  // Consulta de CEP e CNPJ para preencher os dados do pagador.
  r.use('/consultas', require('./consultas')(db));

  r.post('/auth/senha', (req, res) => {
    const u = db.prepare('SELECT * FROM usuarios_cliente WHERE id = ?').get(req.usuario.id);
    if (!verificarSenha(String(req.body?.senha_atual ?? ''), u.senha_hash)) throw new ErroNegocio('Senha atual incorreta.', 401);
    const nova = v.senha(req.body?.senha_nova);
    if (nova === String(req.body?.senha_atual)) throw new ErroNegocio('A nova senha precisa ser diferente da atual.', 422);
    db.prepare('UPDATE usuarios_cliente SET senha_hash = ?, senha_provisoria = 0 WHERE id = ?').run(hashSenha(nova), u.id);
    auditoria.registrar(db, req, { acao: 'cliente.senha.trocada', entidade: 'usuario_cliente', entidade_id: u.id, cliente_id: req.clienteId });
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- painel
  r.get('/painel', exigir('painel.ver'), (req, res) => {
    const c = meuCliente(req);
    const data = hoje();
    const p = periodo(req.query);
    res.json({
      hoje: data,
      periodo: p,
      cliente: {
        razao_social: c.razao_social, nome_fantasia: c.nome_fantasia, cnpj: c.cnpj, situacao: c.situacao,
        codigo: contaInterna.formatar(c.agencia_interna, c.conta_interna, c.conta_interna_dv),
      },
      saldo: razao.saldo(db, c.id, data),
      agenda: razao.agenda(db, c.id, data, 30),
      boletos: consultas.resumoBoletos(db, { ...p, clienteId: c.id, hoje: data }),
      liquidacoes: (() => {
        const l = consultas.resumoLiquidacoes(db, { ...p, clienteId: c.id });
        // O cliente vê o que pagou de tarifa bancária e tarifa PAY AX, não o nosso custo nem a margem.
        return { titulos: l.titulos, bruto_centavos: l.bruto_centavos, comissao_centavos: l.comissao_centavos,
          tarifa_banco_centavos: l.tarifa_banco_centavos, tarifa_emissao_centavos: l.tarifa_emissao_centavos,
          liquido_centavos: l.liquido_cliente_centavos, repassado_centavos: l.repassado_centavos };
      })(),
      serie: consultas.serieDiaria(db, { ...p, clienteId: c.id }),
      proximos_vencimentos: db.prepare(`SELECT vencimento, COUNT(*) AS titulos, SUM(valor_centavos) AS valor_centavos
        FROM boletos WHERE cliente_id = ? AND situacao = 'registrado' AND vencimento >= ?
        GROUP BY vencimento ORDER BY vencimento LIMIT 15`).all(c.id, data),
      vencidos: db.prepare(`SELECT COUNT(*) AS titulos, IFNULL(SUM(valor_centavos), 0) AS valor_centavos
        FROM boletos WHERE cliente_id = ? AND situacao = 'registrado' AND vencimento < ?`).get(c.id, data),
      repasses: db.prepare('SELECT * FROM repasses WHERE cliente_id = ? ORDER BY id DESC LIMIT 5').all(c.id),
      disponivel: repassesLib.disponivel(db, c, data),
      transferencias: repassesLib.resumoCliente(db, c, data),
      preco: (() => {
        const pr = precos.vigente(db, c.id, data);
        return { tarifa_texto: precos.tarifaTexto(pr), tarifa_fixa_centavos: pr.tarifa_fixa_centavos ?? 0,
          tarifa_emissao_centavos: pr.tarifa_emissao_centavos, tarifa_liquidacao_centavos: pr.tarifa_liquidacao_centavos,
          percentual_ppm: pr.percentual_ppm, percentual_texto: precos.percentualTexto(pr.percentual_ppm),
          comissao_minima_centavos: pr.comissao_minima_centavos, comissao_maxima_centavos: pr.comissao_maxima_centavos,
          tarifa_repasse_centavos: pr.tarifa_repasse_centavos };
      })(),
    });
  });

  // ---------------------------------------------------------------- boletos
  r.get('/boletos', exigir('boletos.ver'), (req, res) => res.json(consultas.listarBoletos(db, req.query, hoje(), { clienteId: req.clienteId })));

  r.get('/boletos/export.csv', exigir('boletos.ver'), (req, res) => {
    const lista = consultas.listarBoletos(db, { ...req.query, por_pagina: 10000 }, hoje(), { clienteId: req.clienteId });
    const linhas = [['Nosso número', 'Documento', 'Pagador', 'CPF/CNPJ', 'Emissão', 'Vencimento', 'Valor (R$)', 'Situação', 'Pago em', 'Valor pago (R$)', 'Linha digitável']];
    for (const b of lista.itens) {
      linhas.push([b.nosso_numero_formatado, b.seu_numero ?? '', b.pagador_nome, b.pagador_documento, b.emissao, b.vencimento,
        (b.valor_centavos / 100).toFixed(2).replace('.', ','), b.situacao_visivel, b.pago_em ?? '',
        b.pago_valor_centavos ? (b.pago_valor_centavos / 100).toFixed(2).replace('.', ',') : '', b.linha_digitavel ?? '']);
    }
    res.type('text/csv; charset=utf-8').attachment(`boletos-${hoje()}.csv`).send(csv(linhas));
  });

  r.post('/boletos/simular', exigir('boletos.ver'), (req, res) => {
    const s = precos.simular(db, req.clienteId, v.centavos(req.body?.valor, 'o valor'), hoje());
    res.json({ ...s, margem_centavos: undefined, custo_banco_centavos: undefined });
  });

  r.post('/boletos', exigir('boletos.emitir'), async (req, res) => {
    const c = meuCliente(req);
    const out = await boletosLib.emitir(db, { cliente: c, dados: req.body ?? {}, usuarioCliente: req.usuario, origem: 'avulso' });
    auditoria.registrar(db, req, { acao: 'boleto.emitido', entidade: 'boleto', entidade_id: out.id, cliente_id: c.id,
      depois: { valor: req.body?.valor, vencimento: req.body?.vencimento, pagador: req.body?.pagador_nome } });
    res.status(201).json(semMargem(detalhe(db, out.id, c.id)));
  });

  r.get('/boletos/:id', exigir('boletos.ver'), (req, res) => res.json(semMargem(detalhe(db, req.params.id, req.clienteId))));

  r.get('/boletos/:id/ficha', exigir('boletos.ver'), async (req, res) => {
    const d = consultas.boletoCompleto(db, req.params.id, { clienteId: req.clienteId });
    if (!d) throw naoEncontrado('Boleto');
    res.type('html').send(await impressao.fichaCompensacao({ ...d, hoje: hoje(), base: config.clientePath }));
  });

  r.get('/boletos/:id/link', exigir('boletos.ver'), (req, res) => {
    const b = db.prepare('SELECT id, nosso_numero FROM boletos WHERE id = ? AND cliente_id = ?').get(Number(req.params.id), req.clienteId);
    if (!b) throw naoEncontrado('Boleto');
    const caminho = `${config.basePath}/api/publico/boleto/${b.id}/${assinaturaFicha(b.id, b.nosso_numero)}`;
    res.json({ caminho, url: config.urlPublica ? `${config.urlPublica}${caminho}` : null });
  });

  r.post('/boletos/:id/baixa', exigir('boletos.baixar'), async (req, res) => {
    const b = db.prepare('SELECT id FROM boletos WHERE id = ? AND cliente_id = ?').get(Number(req.params.id), req.clienteId);
    if (!b) throw naoEncontrado('Boleto');
    const motivo = v.texto(req.body?.motivo, 'o motivo da baixa', 160);
    const out = await boletosLib.baixar(db, b.id, motivo, {});
    auditoria.registrar(db, req, { acao: 'boleto.baixado', entidade: 'boleto', entidade_id: b.id, cliente_id: req.clienteId, depois: { motivo } });
    res.json(out);
  });

  // ---------------------------------------------------------------- conta (extrato e saldo)
  r.get('/conta', exigir('razao.ver'), (req, res) => {
    const c = meuCliente(req);
    const data = hoje();
    res.json({
      codigo: contaInterna.formatar(c.agencia_interna, c.conta_interna, c.conta_interna_dv),
      saldo: razao.saldo(db, c.id, data),
      agenda: razao.agenda(db, c.id, data, 60),
      disponivel: repassesLib.disponivel(db, c, data),
      transferencias: repassesLib.resumoCliente(db, c, data),
      pix: c.pix_chave ? { tipo: c.pix_tipo, chave: c.pix_chave, titular: c.pix_titular ?? c.razao_social } : null,
    });
  });

  r.get('/conta/extrato', exigir('razao.ver'), (req, res) => {
    const p = periodo(req.query);
    res.json({
      periodo: p,
      saldo: razao.saldo(db, req.clienteId, hoje()),
      ...razao.extrato(db, req.clienteId, { ...p, tipo: req.query.tipo || null, limite: Number(req.query.limite) || 500 }),
      totais: razao.totaisPorTipo(db, req.clienteId, p.de, p.ate),
    });
  });

  r.get('/conta/extrato.csv', exigir('razao.ver'), (req, res) => {
    const p = periodo(req.query);
    const e = razao.extrato(db, req.clienteId, { ...p, limite: 20000 });
    const linhas = [['Data', 'Liberação', 'Tipo', 'Descrição', 'Valor (R$)', 'Saldo (R$)']];
    for (const i of e.itens) linhas.push([i.data_competencia, i.data_liberacao, i.tipo_nome, i.descricao,
      (i.valor_centavos / 100).toFixed(2).replace('.', ','), (i.saldo_acumulado_centavos / 100).toFixed(2).replace('.', ',')]);
    res.type('text/csv; charset=utf-8').attachment(`extrato-${p.de}-a-${p.ate}.csv`).send(csv(linhas));
  });

  // ---------------------------------------------------------------- repasses
  r.get('/repasses', exigir('repasses.ver'), (req, res) => {
    const c = meuCliente(req);
    res.json({
      transferencias: repassesLib.resumoCliente(db, c, hoje()),
      // PIX enviados pela PAY AX + créditos que o próprio banco fez na conta do cliente (rateio).
      ...listaPaginada(db, `SELECT * FROM (
          SELECT 'pix' AS meio, id, criado_em, valor_liquido_centavos, taxa_centavos, pix_chave, destino_banco, destino_agencia,
            destino_conta, titular_nome, situacao, end_to_end, erro, confirmado_em, NULL AS nosso_numero
          FROM repasses WHERE cliente_id = ?
          UNION ALL
          SELECT 'rateio', l.id, l.criado_em, -l.valor_centavos, 0, NULL, NULL, NULL, NULL, NULL, 'confirmado', NULL, NULL,
            COALESCE(b.rateio_credito_em, l.data_liberacao), b.nosso_numero
          FROM lancamentos l LEFT JOIN boletos b ON b.id = l.boleto_id
          WHERE l.cliente_id = ? AND l.tipo = 'repasse' AND l.repasse_id IS NULL AND IFNULL(b.rateio_situacao, '') <> 'nao_efetuado'
        ) ORDER BY criado_em DESC, id DESC`, [c.id, c.id], req.query),
    });
  });
  // Não existe pedido de repasse: o valor recebido vai sozinho para a conta do cliente.

  // ---------------------------------------------------------------- cadastro e acessos
  r.get('/cadastro', exigir('cadastro.ver'), (req, res) => {
    const c = meuCliente(req);
    res.json({
      razao_social: c.razao_social, nome_fantasia: c.nome_fantasia, cnpj: c.cnpj, email: c.email, telefone: c.telefone,
      codigo_cliente: contaInterna.formatar(c.agencia_interna, c.conta_interna, c.conta_interna_dv),
      responsavel: c.responsavel, cep: c.cep, endereco: c.endereco, numero: c.numero, complemento: c.complemento,
      bairro: c.bairro, cidade: c.cidade, uf: c.uf, situacao: c.situacao,
      limite_boleto_centavos: c.limite_boleto_centavos,
      pix: c.pix_chave ? { tipo: c.pix_tipo, chave: c.pix_chave, titular: c.pix_titular, documento: c.pix_documento } : null,
      destino: contaDestino.descrever(c),
      destino_titular: c.destino_titular ?? c.pix_titular ?? c.razao_social,
      meio_entrega: contaDestino.meioAtual(db, c),
      versao: c.versao,
    });
  });

  /** O cliente atualiza contato e endereço. A chave PIX do repasse só muda pela equipe PAY AX. */
  r.patch('/cadastro', exigir('cadastro.editar'), (req, res) => {
    const c = meuCliente(req);
    const b = req.body ?? {};
    const d = {};
    if (b.nome_fantasia !== undefined) d.nome_fantasia = v.opcional(b.nome_fantasia, 'o nome fantasia', 120);
    if (b.email !== undefined) d.email = b.email ? v.email(b.email) : null;
    if (b.telefone !== undefined) d.telefone = b.telefone ? v.telefone(b.telefone) : null;
    if (b.responsavel !== undefined) d.responsavel = v.opcional(b.responsavel, 'o responsável', 120);
    if (b.cep !== undefined) d.cep = b.cep ? v.cep(b.cep) : null;
    if (b.endereco !== undefined) d.endereco = v.opcional(b.endereco, 'o endereço', 120);
    if (b.numero !== undefined) d.numero = v.opcional(b.numero, 'o número', 10);
    if (b.complemento !== undefined) d.complemento = v.opcional(b.complemento, 'o complemento', 60);
    if (b.bairro !== undefined) d.bairro = v.opcional(b.bairro, 'o bairro', 60);
    if (b.cidade !== undefined) d.cidade = v.opcional(b.cidade, 'a cidade', 60);
    if (b.uf !== undefined) d.uf = v.ufOpcional(b.uf);
    if (b.pix_chave !== undefined) throw new ErroNegocio('A chave PIX de repasse é alterada pela equipe PAY AX, por segurança. Fale com o seu gerente de conta.', 403);
    if (!Object.keys(d).length) throw new ErroNegocio('Nada para alterar.', 422);
    const campos = Object.keys(d);
    db.prepare(`UPDATE clientes SET ${campos.map((k) => `${k} = ?`).join(', ')}, versao = versao + 1 WHERE id = ?`).run(...campos.map((k) => d[k]), c.id);
    auditoria.registrar(db, req, { acao: 'cadastro.alterado.cliente', entidade: 'cliente', entidade_id: c.id, cliente_id: c.id,
      antes: Object.fromEntries(campos.map((k) => [k, c[k]])), depois: d });
    res.json({ ok: true });
  });

  r.get('/usuarios', exigir('usuarios.gerenciar'), (req, res) => {
    res.json(db.prepare('SELECT id, nome, email, perfil, ativo, senha_provisoria, ultimo_acesso FROM usuarios_cliente WHERE cliente_id = ? ORDER BY nome').all(req.clienteId));
  });

  r.post('/usuarios', exigir('usuarios.gerenciar'), (req, res) => {
    const nome = v.texto(req.body?.nome, 'o nome', 120);
    const email = v.email(req.body?.email);
    const perfil = v.opcao(req.body?.perfil ?? 'operador', 'o perfil', ['admin', 'operador', 'consulta']);
    if (db.prepare('SELECT 1 FROM usuarios_cliente WHERE email = ?').get(email)) throw new ErroNegocio('Já existe um acesso com este e-mail.', 409);
    const provisoria = `${Math.random().toString(36).slice(2, 8)}-${Math.random().toString(36).slice(2, 6)}`;
    const id = db.prepare(`INSERT INTO usuarios_cliente (cliente_id, nome, email, senha_hash, perfil, senha_provisoria, criado_em)
      VALUES (?, ?, ?, ?, ?, 1, ?) RETURNING id`).get(req.clienteId, nome, email, hashSenha(provisoria), perfil, agora()).id;
    auditoria.registrar(db, req, { acao: 'acesso.criado.cliente', entidade: 'usuario_cliente', entidade_id: id, cliente_id: req.clienteId, depois: { nome, email, perfil } });
    res.status(201).json({ id, nome, email, perfil, senha_provisoria: provisoria });
  });

  r.patch('/usuarios/:id', exigir('usuarios.gerenciar'), (req, res) => {
    const u = db.prepare('SELECT * FROM usuarios_cliente WHERE id = ? AND cliente_id = ?').get(Number(req.params.id), req.clienteId);
    if (!u) throw naoEncontrado('Acesso');
    const d = {};
    if (req.body?.nome !== undefined) d.nome = v.texto(req.body.nome, 'o nome', 120);
    if (req.body?.perfil !== undefined) d.perfil = v.opcao(req.body.perfil, 'o perfil', ['admin', 'operador', 'consulta']);
    if (req.body?.ativo !== undefined) d.ativo = v.booleano(req.body.ativo) ? 1 : 0;
    let provisoria = null;
    if (v.booleano(req.body?.redefinir_senha)) {
      provisoria = `${Math.random().toString(36).slice(2, 8)}-${Math.random().toString(36).slice(2, 6)}`;
      d.senha_hash = hashSenha(provisoria);
      d.senha_provisoria = 1;
    }
    if (!Object.keys(d).length) throw new ErroNegocio('Nada para alterar.', 422);
    if ((d.ativo === 0 || (d.perfil && d.perfil !== 'admin')) && u.perfil === 'admin') {
      const admins = db.prepare("SELECT COUNT(*) AS n FROM usuarios_cliente WHERE cliente_id = ? AND perfil = 'admin' AND ativo = 1 AND id <> ?").get(req.clienteId, u.id).n;
      if (!admins) throw new ErroNegocio('É preciso manter ao menos um administrador ativo.', 409);
    }
    const campos = Object.keys(d);
    db.prepare(`UPDATE usuarios_cliente SET ${campos.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...campos.map((k) => d[k]), u.id);
    auditoria.registrar(db, req, { acao: 'acesso.alterado.cliente', entidade: 'usuario_cliente', entidade_id: u.id, cliente_id: req.clienteId });
    res.json({ id: u.id, ...(provisoria ? { senha_provisoria: provisoria } : {}) });
  });

  // ---------------------------------------------------------------- IXC do próprio cliente
  r.get('/ixc', exigir('cadastro.ver'), (req, res) => {
    const i = db.prepare("SELECT * FROM integracoes WHERE escopo = 'ixc' AND cliente_id = ?").get(req.clienteId);
    const ultimos = db.prepare("SELECT * FROM sincronismos WHERE cliente_id = ? ORDER BY id DESC LIMIT 10").all(req.clienteId);
    res.json({
      configurada: Boolean(i?.credenciais),
      estado: i?.estado ?? 'nao_configurada',
      config: JSON.parse(i?.config || '{}'),
      ultimo_erro: i?.ultimo_erro ?? null,
      sincronismos: ultimos,
    });
  });

  r.post('/ixc/testar', exigir('ixc.configurar'), async (req, res) => res.json(await sincronismo.testar(db, req.clienteId)));

  r.post('/ixc/importar', exigir('boletos.emitir'), async (req, res) => {
    const c = meuCliente(req);
    const data = hoje();
    const out = await sincronismo.importar(db, c, {
      de: req.body?.de ? v.data(req.body.de, 'a data inicial') : data,
      ate: req.body?.ate ? v.data(req.body.ate, 'a data final') : datas.somarDias(data, 10),
      limite: v.inteiroOpcional(req.body?.limite, 'o limite', { min: 1, max: 300 }) ?? 100,
      usuario: null,
    });
    auditoria.registrar(db, req, { acao: 'ixc.importacao.cliente', entidade: 'sincronismo', entidade_id: out.sincronismo_id, cliente_id: c.id,
      depois: { lidos: out.lidos, criados: out.criados, erros: out.erros } });
    res.json(out);
  });

  return r;
};
