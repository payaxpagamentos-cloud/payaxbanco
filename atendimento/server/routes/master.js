'use strict';

const express = require('express');
const { agora, auditar, lerConfig, CONFIG_PADRAO } = require('../db');
const { permitir } = require('../auth');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { hashSenha } = require('../lib/senha');
const empresasLib = require('../lib/empresas');
const relatorios = require('../lib/relatorios');
const wa = require('../lib/whatsapp');
const { hoje, inicioMes } = require('../lib/datas');
const v = require('../lib/validacao');

/** Painel do master: a plataforma inteira. O suporte vê quase tudo, menos usuários e configurações. */
module.exports = function rotasMaster(db) {
  const r = express.Router();
  const soMaster = permitir('master');
  r.use(permitir('master', 'suporte'));

  // ---------- Dashboard ----------
  r.get('/painel', (_req, res) => res.json(relatorios.painelMaster(db)));

  // ---------- Empresas ----------
  r.get('/empresas', (req, res) => {
    const busca = String(req.query.busca ?? '').trim();
    const status = String(req.query.status ?? '').trim();
    const onde = ["e.status <> 'excluida'"];
    const args = [];
    if (busca) { onde.push('(e.nome LIKE ? OR e.documento LIKE ?)'); args.push(`%${busca}%`, `%${busca}%`); }
    if (status) { onde.push('e.status = ?'); args.push(status); }
    const mes = require('../lib/datas').intervalo(inicioMes(), hoje())[0];
    res.json({
      itens: db.prepare(`SELECT e.*,
          (SELECT COUNT(*) FROM usuarios u WHERE u.empresa_id = e.id AND u.ativo = 1 AND u.perfil IN ('atendente','cliente')) AS atendentes,
          (SELECT COUNT(*) FROM conversas c WHERE c.empresa_id = e.id AND c.estado <> 'encerrada') AS conversas_abertas,
          (SELECT COUNT(*) FROM conversas c WHERE c.empresa_id = e.id AND c.aberta_em >= ?) AS conversas_mes,
          (SELECT COUNT(*) FROM ia_eventos i WHERE i.empresa_id = e.id AND i.tipo = 'resposta' AND i.criado_em >= ?) AS ia_mes,
          (SELECT COUNT(*) FROM numeros n WHERE n.empresa_id = e.id AND n.ativo = 1) AS numeros,
          (SELECT ativa FROM ia_config i WHERE i.empresa_id = e.id) AS ia_ativa
        FROM empresas e WHERE ${onde.join(' AND ')} ORDER BY e.nome`).all(mes, mes, ...args),
    });
  });

  r.post('/empresas', soMaster, (req, res, next) => {
    try {
      const empresa = empresasLib.criar(db, req.body ?? {});
      auditar(db, { usuario: req.usuario, empresaId: empresa.id, acao: 'criou a empresa', alvo: empresa.nome, ip: req.ip });
      res.status(201).json(empresa);
    } catch (err) { next(err); }
  });

  r.patch('/empresas/:id', soMaster, (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const atual = db.prepare("SELECT * FROM empresas WHERE id = ? AND status <> 'excluida'").get(id);
      if (!atual) throw naoEncontrado('Empresa');
      const d = req.body ?? {};
      const campos = {
        nome: d.nome === undefined ? atual.nome : v.texto(d.nome, 'o nome da empresa', 160),
        documento: d.documento === undefined ? atual.documento : (d.documento ? v.digitos(d.documento) : null),
        email: d.email === undefined ? atual.email : (d.email ? v.email(d.email) : null),
        telefone: d.telefone === undefined ? atual.telefone : (d.telefone ? v.telefone(d.telefone) : null),
        limite_atendentes: d.limite_atendentes === undefined ? atual.limite_atendentes : v.inteiro(d.limite_atendentes, 'o limite de atendentes'),
        limite_ia_mes: d.limite_ia_mes === undefined ? atual.limite_ia_mes : v.inteiro(d.limite_ia_mes, 'o limite de mensagens da IA'),
      };
      if (campos.documento) {
        v.exigir((campos.documento.length === 14 && v.cnpjValido(campos.documento)) || (campos.documento.length === 11 && v.cpfValido(campos.documento)), 'CNPJ ou CPF inválido.');
      }
      db.prepare('UPDATE empresas SET nome = ?, documento = ?, email = ?, telefone = ?, limite_atendentes = ?, limite_ia_mes = ? WHERE id = ?')
        .run(campos.nome, campos.documento, campos.email, campos.telefone, campos.limite_atendentes, campos.limite_ia_mes, id);
      auditar(db, { usuario: req.usuario, empresaId: id, acao: 'alterou a empresa', alvo: campos.nome, detalhe: { antes: atual, depois: campos }, ip: req.ip });
      res.json(db.prepare('SELECT * FROM empresas WHERE id = ?').get(id));
    } catch (err) { next(err); }
  });

  /** Bloquear tira o acesso dos usuários da empresa e para o webhook dela na hora. */
  r.post('/empresas/:id/bloquear', soMaster, (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const empresa = db.prepare("SELECT * FROM empresas WHERE id = ? AND status <> 'excluida'").get(id);
      if (!empresa) throw naoEncontrado('Empresa');
      const bloquear = v.booleano(req.body?.bloquear ?? true);
      const motivo = bloquear ? v.texto(req.body?.motivo, 'o motivo do bloqueio', 300) : null;
      db.prepare('UPDATE empresas SET status = ?, motivo_bloqueio = ? WHERE id = ?').run(bloquear ? 'bloqueada' : 'ativa', motivo, id);
      auditar(db, { usuario: req.usuario, empresaId: id, acao: bloquear ? 'bloqueou a empresa' : 'desbloqueou a empresa', alvo: empresa.nome, detalhe: motivo, ip: req.ip });
      res.json({ status: bloquear ? 'bloqueada' : 'ativa' });
    } catch (err) { next(err); }
  });

  r.delete('/empresas/:id', soMaster, (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const empresa = db.prepare("SELECT * FROM empresas WHERE id = ? AND status <> 'excluida'").get(id);
      if (!empresa) throw naoEncontrado('Empresa');
      if (v.texto(req.body?.confirmar_nome, 'o nome da empresa para confirmar', 160) !== empresa.nome) {
        throw new ErroNegocio('Digite o nome exato da empresa para confirmar a exclusão.');
      }
      // Exclusão lógica: o histórico de atendimento fica, mas ninguém mais entra nem recebe mensagem.
      db.prepare("UPDATE empresas SET status = 'excluida' WHERE id = ?").run(id);
      db.prepare('UPDATE usuarios SET ativo = 0 WHERE empresa_id = ?').run(id);
      db.prepare('UPDATE numeros SET ativo = 0 WHERE empresa_id = ?').run(id);
      auditar(db, { usuario: req.usuario, empresaId: id, acao: 'excluiu a empresa', alvo: empresa.nome, ip: req.ip });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ---------- Usuários da plataforma e das empresas ----------
  r.get('/usuarios', soMaster, (_req, res) => res.json({
    itens: db.prepare(`SELECT u.id, u.nome, u.email, u.perfil, u.empresa_id, u.ativo, u.disponivel, u.max_simultaneas, u.ultimo_acesso, u.criado_em,
        e.nome AS empresa_nome FROM usuarios u LEFT JOIN empresas e ON e.id = u.empresa_id
      WHERE e.status IS NULL OR e.status <> 'excluida' ORDER BY (u.empresa_id IS NOT NULL), e.nome, u.nome`).all(),
  }));

  r.post('/usuarios', soMaster, (req, res, next) => {
    try {
      const d = req.body ?? {};
      const perfil = v.opcao(d.perfil, 'o perfil', ['master', 'suporte', 'cliente', 'supervisor', 'atendente']);
      if (perfil === 'master' || perfil === 'suporte') {
        const senha = v.senha(d.senha);
        const id = Number(db.prepare('INSERT INTO usuarios (nome, email, senha_hash, perfil, criado_em) VALUES (?, ?, ?, ?, ?)')
          .run(v.texto(d.nome, 'o nome', 160), v.email(d.email), hashSenha(senha), perfil, agora()).lastInsertRowid);
        auditar(db, { usuario: req.usuario, acao: 'criou usuário da plataforma', alvo: d.email, detalhe: perfil, ip: req.ip });
        return res.status(201).json({ usuario: db.prepare('SELECT id, nome, email, perfil FROM usuarios WHERE id = ?').get(id) });
      }
      const empresaId = v.inteiro(d.empresa_id, 'a empresa', { min: 1 });
      const criado = empresasLib.criarUsuario(db, empresaId, d);
      auditar(db, { usuario: req.usuario, empresaId, acao: 'criou usuário da empresa', alvo: d.email, detalhe: perfil, ip: req.ip });
      return res.status(201).json(criado);
    } catch (err) { return next(err); }
  });

  r.patch('/usuarios/:id', soMaster, (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
      if (!u) throw naoEncontrado('Usuário');
      const d = req.body ?? {};
      const ativo = d.ativo === undefined ? u.ativo : (v.booleano(d.ativo) ? 1 : 0);
      // Sempre sobra um master ativo.
      if (u.perfil === 'master' && !ativo) {
        const outros = Number(db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE perfil = 'master' AND ativo = 1 AND id <> ?").all(id)[0].n);
        if (!outros) throw new ErroNegocio('É preciso manter pelo menos um master ativo.');
      }
      db.prepare('UPDATE usuarios SET nome = ?, ativo = ?, max_simultaneas = ? WHERE id = ?')
        .run(d.nome === undefined ? u.nome : v.texto(d.nome, 'o nome', 160), ativo,
          d.max_simultaneas === undefined ? u.max_simultaneas : v.inteiro(d.max_simultaneas, 'o máximo de conversas', { min: 1, max: 50 }), id);
      if (d.senha) db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hashSenha(v.senha(d.senha)), id);
      auditar(db, { usuario: req.usuario, empresaId: u.empresa_id, acao: 'alterou usuário', alvo: u.email, ip: req.ip });
      res.json(db.prepare('SELECT id, nome, email, perfil, ativo, max_simultaneas FROM usuarios WHERE id = ?').get(id));
    } catch (err) { next(err); }
  });

  // ---------- Segurança ----------
  r.get('/seguranca', soMaster, (_req, res) => res.json({
    recusados: db.prepare('SELECT email, ip, motivo, criado_em FROM acessos_recusados WHERE criado_em >= ? ORDER BY id DESC LIMIT 200')
      .all(new Date(Date.now() - 86_400_000).toISOString()),
    ips: db.prepare('SELECT ip, motivo, criado_em FROM ips_bloqueados ORDER BY criado_em DESC').all(),
    auditoria: db.prepare(`SELECT a.acao, a.alvo, a.detalhe, a.ip, a.criado_em, a.usuario_nome, e.nome AS empresa_nome
      FROM auditoria a LEFT JOIN empresas e ON e.id = a.empresa_id ORDER BY a.id DESC LIMIT 200`).all(),
  }));

  r.post('/seguranca/ips', soMaster, (req, res, next) => {
    try {
      const ip = v.texto(req.body?.ip, 'o IP', 60);
      db.prepare('INSERT OR REPLACE INTO ips_bloqueados (ip, motivo, criado_em) VALUES (?, ?, ?)')
        .run(ip, v.opcional(req.body?.motivo, 'o motivo', 200), agora());
      auditar(db, { usuario: req.usuario, acao: 'bloqueou IP', alvo: ip, ip: req.ip });
      res.status(201).json({ ip });
    } catch (err) { next(err); }
  });

  r.delete('/seguranca/ips/:ip', soMaster, (req, res) => {
    db.prepare('DELETE FROM ips_bloqueados WHERE ip = ?').run(req.params.ip);
    auditar(db, { usuario: req.usuario, acao: 'desbloqueou IP', alvo: req.params.ip, ip: req.ip });
    res.json({ ok: true });
  });

  // ---------- Relatórios da plataforma ----------
  r.get('/relatorios', (req, res) => {
    const de = req.query.de ? v.data(req.query.de, 'a data inicial') : inicioMes();
    const ate = req.query.ate ? v.data(req.query.ate, 'a data final') : hoje();
    const empresaId = req.query.empresa_id ? Number(req.query.empresa_id) : null;
    res.json({
      periodo: { de, ate },
      resumo: relatorios.resumo(db, { empresaId, de, ate }),
      por_dia: relatorios.porDia(db, { empresaId, de, ate }),
      por_hora: relatorios.porHora(db, { empresaId, de, ate }),
      motivos: relatorios.motivosTransferencia(db, { empresaId, de, ate }),
      por_empresa: db.prepare(`SELECT e.id, e.nome,
          COUNT(c.id) AS conversas,
          SUM(CASE WHEN c.resolvida_por IN ('ia','cliente') THEN 1 ELSE 0 END) AS resolvidas_ia,
          SUM(CASE WHEN c.transferida_em IS NOT NULL THEN 1 ELSE 0 END) AS transferidas,
          AVG(c.csat_nota) AS csat
        FROM empresas e LEFT JOIN conversas c ON c.empresa_id = e.id AND c.aberta_em >= ? AND c.aberta_em < ?
        WHERE e.status <> 'excluida' GROUP BY e.id ORDER BY conversas DESC, e.nome`)
        .all(...require('../lib/datas').intervalo(de, ate))
        .map((x) => ({ ...x, csat: x.csat === null ? null : Number(Number(x.csat).toFixed(2)) })),
    });
  });

  // ---------- Diagnóstico ----------
  r.get('/diagnostico', async (_req, res) => {
    const verificacoes = [];
    const ok = (nome, detalhe) => verificacoes.push({ nome, situacao: 'ok', detalhe });
    const aviso = (nome, detalhe) => verificacoes.push({ nome, situacao: 'aviso', detalhe });
    const erro = (nome, detalhe) => verificacoes.push({ nome, situacao: 'erro', detalhe });

    try { db.prepare('SELECT 1').get(); ok('Banco de dados', 'respondendo'); } catch (e) { erro('Banco de dados', e.message); }

    const config = require('../config');
    if (config.ia.chave) ok('Chave da Claude API', `configurada · modelo ${config.ia.modelo} · esforço ${config.ia.esforco}`);
    else aviso('Chave da Claude API', 'não configurada: as ZOEs rodam só com intenções e base de conhecimento');

    const semSegredo = db.prepare('SELECT COUNT(*) AS n FROM numeros WHERE ativo = 1 AND app_secret_cifrado IS NULL').get();
    if (Number(semSegredo.n)) erro('Segredo do app (webhook)', `${semSegredo.n} número(s) ativo(s) sem App secret: o webhook deles recusa todo evento`);
    else ok('Segredo do app (webhook)', 'todos os números ativos têm App secret');

    const semFila = db.prepare(`SELECT COUNT(*) AS n FROM empresas e WHERE e.status = 'ativa'
      AND NOT EXISTS (SELECT 1 FROM filas f WHERE f.empresa_id = e.id AND f.ativa = 1)`).get();
    if (Number(semFila.n)) aviso('Filas de atendimento', `${semFila.n} empresa(s) ativa(s) sem fila: a IA não tem para onde transferir`);
    else ok('Filas de atendimento', 'todas as empresas ativas têm fila');

    const paradas = Number(db.prepare("SELECT COUNT(*) AS n FROM mensagens WHERE status = 'fila' AND proxima_em < ?").all(new Date(Date.now() - 600_000).toISOString())[0].n);
    if (paradas) erro('Fila de envio', `${paradas} mensagem(ns) presa(s) há mais de 10 minutos`);
    else ok('Fila de envio', 'sem mensagens presas');

    const falhas = Number(db.prepare("SELECT COUNT(*) AS n FROM mensagens WHERE status = 'falhou' AND criada_em >= ?").all(new Date(Date.now() - 86_400_000).toISOString())[0].n);
    if (falhas) aviso('Envios com falha (24 h)', `${falhas} mensagem(ns) não foram entregues`);
    else ok('Envios com falha (24 h)', 'nenhuma');

    const esperando = Number(db.prepare("SELECT COUNT(*) AS n FROM conversas WHERE estado = 'aguardando' AND transferida_em < ?")
      .all(new Date(Date.now() - lerConfig(db).alerta_espera_min * 60_000).toISOString())[0].n);
    if (esperando) aviso('Clientes na fila', `${esperando} conversa(s) esperando além do tempo configurado`);
    else ok('Clientes na fila', 'ninguém esperando além do limite');

    // Conexão de cada número com a Meta.
    const numeros = [];
    for (const n of db.prepare('SELECT * FROM numeros WHERE ativo = 1').all()) {
      const situacao = await wa.situacao(n);
      numeros.push({ id: n.id, nome: n.nome, telefone: n.telefone, empresa_id: n.empresa_id, ...situacao });
      if (!situacao.ok) erro(`Número ${n.nome}`, situacao.erro ?? situacao.estado);
    }
    res.json({ verificacoes, numeros });
  });

  // ---------- Configurações da plataforma ----------
  r.get('/configuracoes', soMaster, (_req, res) => res.json(lerConfig(db)));

  r.patch('/configuracoes', soMaster, (req, res, next) => {
    try {
      const d = req.body ?? {};
      const gravar = db.prepare('UPDATE configuracoes SET valor = ? WHERE chave = ?');
      for (const chave of Object.keys(CONFIG_PADRAO)) {
        if (d[chave] === undefined) continue;
        const valor = chave === 'nome_plataforma'
          ? v.texto(d[chave], 'o nome da plataforma', 60)
          : String(v.inteiro(d[chave], chave.replace(/_/g, ' '), { min: 0, max: 10_000_000 }));
        gravar.run(valor, chave);
      }
      auditar(db, { usuario: req.usuario, acao: 'alterou as configurações da plataforma', detalhe: d, ip: req.ip });
      res.json(lerConfig(db));
    } catch (err) { next(err); }
  });

  return r;
};
