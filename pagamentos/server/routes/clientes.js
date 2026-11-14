'use strict';

const express = require('express');
const config = require('../config');
const { agora, transacao } = require('../db');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { exigir } = require('../auth');
const { listaPaginada, like, conferirVersao, csv } = require('../lib/http');
const { hashSenha } = require('../lib/senha');
const v = require('../lib/validacao');
const datas = require('../lib/datas');
const razao = require('../lib/razao');
const precos = require('../lib/precos');
const consultas = require('../lib/consultas');
const repasses = require('../lib/repasses');
const auditoria = require('../lib/auditoria');
const { podeEquipe } = require('../lib/permissoes');
const contaInterna = require('../lib/contaInterna');

const hoje = () => datas.dataLocal(config.fusoPadrao);

/** Campos do cadastro que a equipe pode gravar. */
function corpoCliente(body, { novo = false } = {}) {
  const d = {};
  if (novo || body.razao_social !== undefined) d.razao_social = v.texto(body.razao_social, 'a razão social', 120);
  if (novo || body.cnpj !== undefined) d.cnpj = v.cnpj(body.cnpj);
  if (body.nome_fantasia !== undefined) d.nome_fantasia = v.opcional(body.nome_fantasia, 'o nome fantasia', 120);
  if (body.email !== undefined) d.email = body.email ? v.email(body.email) : null;
  if (body.telefone !== undefined) d.telefone = body.telefone ? v.telefone(body.telefone) : null;
  if (body.responsavel !== undefined) d.responsavel = v.opcional(body.responsavel, 'o responsável', 120);
  if (body.cep !== undefined) d.cep = body.cep ? v.cep(body.cep) : null;
  if (body.endereco !== undefined) d.endereco = v.opcional(body.endereco, 'o endereço', 120);
  if (body.numero !== undefined) d.numero = v.opcional(body.numero, 'o número', 10);
  if (body.complemento !== undefined) d.complemento = v.opcional(body.complemento, 'o complemento', 60);
  if (body.bairro !== undefined) d.bairro = v.opcional(body.bairro, 'o bairro', 60);
  if (body.cidade !== undefined) d.cidade = v.opcional(body.cidade, 'a cidade', 60);
  if (body.uf !== undefined) d.uf = v.ufOpcional(body.uf);
  if (body.situacao !== undefined) d.situacao = v.opcao(body.situacao, 'a situação', ['implantacao', 'ativo', 'suspenso', 'encerrado']);
  // Retenção, repasse mínimo e limite de aprovação deixaram de existir: o valor recebido vai
  // para o cliente assim que o banco credita. As colunas continuam no banco de dados, sem uso.
  if (body.limite_boleto !== undefined) {
    d.limite_boleto_centavos = v.centavos(body.limite_boleto, 'o limite por boleto');
    if (d.limite_boleto_centavos <= 0) throw new ErroNegocio('O limite por boleto precisa ser maior que zero.', 422);
  }
  if (body.observacoes !== undefined) d.observacoes = v.opcional(body.observacoes, 'as observações', 1000);
  // A chave PIX de repasse só muda pela nossa equipe (é o destino do dinheiro): o cliente não altera sozinho.
  if (body.pix_chave !== undefined) {
    if (!body.pix_chave) { d.pix_chave = null; d.pix_tipo = null; }
    else {
      const k = v.chavePix(body.pix_chave, body.pix_tipo);
      d.pix_chave = k.chave;
      d.pix_tipo = k.tipo;
    }
  }
  if (body.pix_titular !== undefined) d.pix_titular = v.opcional(body.pix_titular, 'o titular da chave PIX', 120);
  if (body.pix_documento !== undefined) d.pix_documento = body.pix_documento ? v.documento(body.pix_documento, 'o CPF/CNPJ do titular') : null;
  return d;
}

module.exports = (db) => {
  const r = express.Router();
  const buscar = (id) => {
    const c = db.prepare('SELECT * FROM clientes WHERE id = ?').get(Number(id));
    if (!c) throw naoEncontrado('Cliente');
    return c;
  };

  // ------------------------------------------------------------------ lista e cadastro
  r.get('/', exigir('clientes.ver'), (req, res) => {
    const cond = [];
    const p = [];
    if (req.query.situacao) { cond.push('c.situacao = ?'); p.push(req.query.situacao); }
    if (req.query.busca) {
      const d = String(req.query.busca).replace(/\D/g, '');
      cond.push(`(c.razao_social LIKE ? ESCAPE '\\' OR c.nome_fantasia LIKE ? ESCAPE '\\' OR c.cnpj LIKE ?
        OR c.conta_interna = ? OR (c.conta_interna || c.conta_interna_dv) = ?)`);
      // Código do cliente: "0003" ou "3" acha pelo número; "0003-7" acha pelo número com o dígito.
      p.push(like(req.query.busca), like(req.query.busca), `%${d || '@'}%`, d.padStart(4, '0'), d.padStart(5, '0'));
    }
    const data = hoje();
    const sql = `SELECT c.*,
        c.conta_interna || '-' || c.conta_interna_dv AS codigo_cliente,
        (SELECT COUNT(*) FROM boletos b WHERE b.cliente_id = c.id AND b.situacao = 'registrado') AS boletos_abertos,
        (SELECT IFNULL(SUM(l.valor_centavos), 0) FROM lancamentos l WHERE l.cliente_id = c.id AND l.data_liberacao <= '${data}') AS disponivel_centavos,
        (SELECT IFNULL(SUM(l.valor_centavos), 0) FROM lancamentos l WHERE l.cliente_id = c.id AND l.data_liberacao > '${data}') AS a_liberar_centavos
      FROM clientes c${cond.length ? ` WHERE ${cond.join(' AND ')}` : ''} ORDER BY c.razao_social`;
    res.json(listaPaginada(db, sql, p, req.query));
  });

  r.post('/', exigir('clientes.editar'), (req, res) => {
    const d = corpoCliente(req.body ?? {}, { novo: true });
    if (db.prepare('SELECT 1 FROM clientes WHERE cnpj = ?').get(d.cnpj)) throw new ErroNegocio('Já existe um cliente com este CNPJ.', 409);
    const campos = Object.keys(d);
    const id = transacao(db, () => {
      const novo = db.prepare(`INSERT INTO clientes (${campos.join(', ')}, criado_em, criado_por) VALUES (${campos.map(() => '?').join(', ')}, ?, ?) RETURNING id`)
        .get(...campos.map((k) => d[k]), agora(), req.usuario.id).id;
      // Código do cliente: sequencial, atribuído uma vez e nunca alterado.
      contaInterna.atribuir(db, novo);
      return novo;
    });
    auditoria.registrar(db, req, { acao: 'cliente.criado', entidade: 'cliente', entidade_id: id, cliente_id: id, depois: d });
    res.status(201).json(buscar(id));
  });

  r.get('/:id', exigir('clientes.ver'), (req, res) => {
    const c = buscar(req.params.id);
    const data = hoje();
    res.json({
      ...c,
      codigo_cliente: contaInterna.formatar(c.agencia_interna, c.conta_interna, c.conta_interna_dv),
      saldo: razao.saldo(db, c.id, data),
      preco: precos.vigente(db, c.id, data),
      agenda: razao.agenda(db, c.id, data, 30),
      acessos: db.prepare('SELECT id, nome, email, perfil, ativo, senha_provisoria, ultimo_acesso FROM usuarios_cliente WHERE cliente_id = ? ORDER BY nome').all(c.id),
      ixc: (() => {
        const i = db.prepare("SELECT estado, config, ultimo_teste, ultimo_erro FROM integracoes WHERE escopo = 'ixc' AND cliente_id = ?").get(c.id);
        return i ? { estado: i.estado, ...(JSON.parse(i.config || '{}')), ultimo_teste: i.ultimo_teste, ultimo_erro: i.ultimo_erro } : { estado: 'nao_configurada' };
      })(),
      resumo_mes: consultas.resumoBoletos(db, { de: datas.primeiroDiaMes(data), ate: data, clienteId: c.id, hoje: data }),
      pode_ver_margem: podeEquipe(req.usuario.perfil, 'relatorios.margem'),
      liquidacoes_mes: (() => {
        const l = consultas.resumoLiquidacoes(db, { de: datas.primeiroDiaMes(data), ate: data, clienteId: c.id });
        return podeEquipe(req.usuario.perfil, 'relatorios.margem') ? l : consultas.semMargem(l);
      })(),
    });
  });

  r.patch('/:id', exigir('clientes.editar'), (req, res) => {
    const c = buscar(req.params.id);
    conferirVersao(c.versao, req.body?.versao);
    const d = corpoCliente(req.body ?? {});
    if (!Object.keys(d).length) throw new ErroNegocio('Nada para alterar.', 422);
    if (d.cnpj && d.cnpj !== c.cnpj && db.prepare('SELECT 1 FROM clientes WHERE cnpj = ? AND id <> ?').get(d.cnpj, c.id)) {
      throw new ErroNegocio('Já existe outro cliente com este CNPJ.', 409);
    }
    const campos = Object.keys(d);
    db.prepare(`UPDATE clientes SET ${campos.map((k) => `${k} = ?`).join(', ')}, versao = versao + 1 WHERE id = ?`).run(...campos.map((k) => d[k]), c.id);
    auditoria.registrar(db, req, { acao: 'cliente.alterado', entidade: 'cliente', entidade_id: c.id, cliente_id: c.id,
      antes: Object.fromEntries(campos.map((k) => [k, c[k]])), depois: d });
    res.json(buscar(c.id));
  });

  // ------------------------------------------------------------------ conta gráfica
  r.get('/:id/extrato', exigir('razao.ver'), (req, res) => {
    const c = buscar(req.params.id);
    const data = hoje();
    const de = req.query.de || datas.primeiroDiaMes(data);
    const ate = req.query.ate || data;
    res.json({
      cliente: { id: c.id, razao_social: c.razao_social },
      saldo: razao.saldo(db, c.id, data),
      periodo: { de, ate },
      ...razao.extrato(db, c.id, { de, ate, tipo: req.query.tipo || null, limite: Number(req.query.limite) || 500 }),
      totais: razao.totaisPorTipo(db, c.id, de, ate),
    });
  });

  r.get('/:id/extrato.csv', exigir('razao.ver'), (req, res) => {
    const c = buscar(req.params.id);
    const data = hoje();
    const de = req.query.de || datas.primeiroDiaMes(data);
    const ate = req.query.ate || data;
    const e = razao.extrato(db, c.id, { de, ate, limite: 20000 });
    const linhas = [['Data', 'Liberação', 'Tipo', 'Descrição', 'Valor (R$)', 'Saldo (R$)']];
    for (const i of e.itens) linhas.push([i.data_competencia, i.data_liberacao, i.tipo_nome, i.descricao,
      (i.valor_centavos / 100).toFixed(2).replace('.', ','), (i.saldo_acumulado_centavos / 100).toFixed(2).replace('.', ',')]);
    res.type('text/csv; charset=utf-8').attachment(`extrato-${c.cnpj}-${de}-a-${ate}.csv`).send(csv(linhas));
  });

  /** Ajuste manual na conta gráfica (crédito ou débito), sempre com motivo e auditoria. */
  r.post('/:id/ajustes', exigir('razao.ajustar'), (req, res) => {
    const c = buscar(req.params.id);
    const valor = v.centavos(req.body?.valor, 'o valor', { min: -1_000_000 });
    const sentido = v.opcao(req.body?.sentido, 'o sentido', ['credito', 'debito']);
    const motivo = v.texto(req.body?.motivo, 'o motivo', 200);
    if (valor <= 0) throw new ErroNegocio('Informe um valor maior que zero e escolha crédito ou débito.', 422);
    const data = hoje();
    const id = razao.lancar(db, {
      cliente_id: c.id, tipo: 'ajuste', valor_centavos: sentido === 'credito' ? valor : -valor,
      descricao: `Ajuste manual · ${motivo}`, data_competencia: data, data_liberacao: data, criado_por: req.usuario.id,
    });
    auditoria.registrar(db, req, { acao: 'razao.ajuste', entidade: 'lancamento', entidade_id: id, cliente_id: c.id,
      depois: { sentido, valor_centavos: valor, motivo } });
    res.status(201).json({ id, saldo: razao.saldo(db, c.id, data) });
  });

  r.get('/:id/boletos', exigir('boletos.ver'), (req, res) => {
    const c = buscar(req.params.id);
    res.json(consultas.listarBoletos(db, req.query, hoje(), { clienteId: c.id }));
  });

  r.get('/:id/repasses', exigir('repasses.ver'), (req, res) => {
    const c = buscar(req.params.id);
    res.json({
      disponivel: repasses.disponivel(db, c, hoje()),
      itens: db.prepare('SELECT * FROM repasses WHERE cliente_id = ? ORDER BY id DESC LIMIT 200').all(c.id),
    });
  });

  // ------------------------------------------------------------------ preços
  r.get('/:id/precos', exigir('precos.ver'), (req, res) => {
    const c = buscar(req.params.id);
    res.json({
      vigente: precos.vigente(db, c.id, hoje()),
      historico: db.prepare('SELECT * FROM precos WHERE cliente_id = ? ORDER BY vigencia_inicio DESC, id DESC').all(c.id),
      padrao: precos.vigente(db, null, hoje()),
    });
  });

  r.post('/:id/precos', exigir('precos.editar'), (req, res) => {
    const c = buscar(req.params.id);
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
    if (d.comissao_maxima_centavos !== null && d.comissao_maxima_centavos < d.comissao_minima_centavos) {
      throw new ErroNegocio('A tarifa máxima não pode ser menor que a mínima.', 422);
    }
    const id = transacao(db, () => {
      // Encerra a vigência anterior no dia anterior ao início da nova.
      db.prepare(`UPDATE precos SET vigencia_fim = date(?, '-1 day') WHERE cliente_id = ? AND vigencia_fim IS NULL AND vigencia_inicio < ?`)
        .run(inicio, c.id, inicio);
      return db.prepare(`INSERT INTO precos (cliente_id, vigencia_inicio, tarifa_emissao_centavos, tarifa_liquidacao_centavos,
          percentual_ppm, comissao_minima_centavos, comissao_maxima_centavos, tarifa_repasse_centavos, observacao, criado_em, criado_por)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
        .get(c.id, inicio, d.tarifa_emissao_centavos, d.tarifa_liquidacao_centavos, d.percentual_ppm,
          d.comissao_minima_centavos, d.comissao_maxima_centavos, d.tarifa_repasse_centavos, d.observacao, agora(), req.usuario.id).id;
    });
    auditoria.registrar(db, req, { acao: 'preco.definido', entidade: 'preco', entidade_id: id, cliente_id: c.id, depois: { ...d, vigencia_inicio: inicio } });
    res.status(201).json(db.prepare('SELECT * FROM precos WHERE id = ?').get(id));
  });

  // ------------------------------------------------------------------ acessos à Área do Cliente
  r.post('/:id/acessos', exigir('acessos.gerenciar', 'clientes.editar'), (req, res) => {
    const c = buscar(req.params.id);
    const nome = v.texto(req.body?.nome, 'o nome', 120);
    const email = v.email(req.body?.email);
    const perfil = v.opcao(req.body?.perfil ?? 'operador', 'o perfil', ['admin', 'operador', 'consulta']);
    if (db.prepare('SELECT 1 FROM usuarios_cliente WHERE email = ?').get(email)) throw new ErroNegocio('Já existe um acesso com este e-mail.', 409);
    // Senha provisória gerada aqui e mostrada uma única vez à equipe, que a entrega ao cliente.
    const provisoria = `${Math.random().toString(36).slice(2, 8)}-${Math.random().toString(36).slice(2, 6)}`;
    const id = db.prepare(`INSERT INTO usuarios_cliente (cliente_id, nome, email, senha_hash, perfil, senha_provisoria, criado_em)
      VALUES (?, ?, ?, ?, ?, 1, ?) RETURNING id`).get(c.id, nome, email, hashSenha(provisoria), perfil, agora()).id;
    auditoria.registrar(db, req, { acao: 'acesso.criado', entidade: 'usuario_cliente', entidade_id: id, cliente_id: c.id, depois: { nome, email, perfil } });
    res.status(201).json({ id, nome, email, perfil, senha_provisoria: provisoria });
  });

  r.patch('/:id/acessos/:acessoId', exigir('acessos.gerenciar', 'clientes.editar'), (req, res) => {
    const c = buscar(req.params.id);
    const a = db.prepare('SELECT * FROM usuarios_cliente WHERE id = ? AND cliente_id = ?').get(Number(req.params.acessoId), c.id);
    if (!a) throw naoEncontrado('Acesso');
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
    const campos = Object.keys(d);
    db.prepare(`UPDATE usuarios_cliente SET ${campos.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...campos.map((k) => d[k]), a.id);
    auditoria.registrar(db, req, { acao: 'acesso.alterado', entidade: 'usuario_cliente', entidade_id: a.id, cliente_id: c.id,
      depois: { ...d, senha_hash: undefined } });
    res.json({ id: a.id, ...(provisoria ? { senha_provisoria: provisoria } : {}) });
  });

  return r;
};
