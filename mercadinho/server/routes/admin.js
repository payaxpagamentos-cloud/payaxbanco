'use strict';

const { Router } = require('express');
const { agora, lerConfig, gravarConfig, CONFIG_PADRAO } = require('../db');
const maquininha = require('../lib/maquininha');
const { hashSenha } = require('../lib/senha');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const v = require('../lib/validacao');

const PERFIS = ['admin', 'gerente', 'caixa', 'estoque'];
// Configurações guardadas como número inteiro (o restante é texto livre ou liga/desliga).
const NUMERICAS = { limite_fiado_padrao_centavos: [0, 10_000_000], vencimento_fatura_dia: [1, 28], alerta_validade_dias: [1, 365], margem_padrao_bp: [0, 100_000] };
const BOOLEANAS = ['permitir_estoque_negativo', 'autoatendimento'];

/** Configurações da loja, maquininhas, usuários e auditoria. */
module.exports = (db, { admin }) => {
  const r = Router();

  r.get('/config', (_req, res) => res.json(lerConfig(db)));

  r.patch('/config', (req, res) => {
    for (const [chave, valor] of Object.entries(req.body ?? {})) {
      if (!(chave in CONFIG_PADRAO)) throw new ErroNegocio(`Configuração desconhecida: ${chave}.`, 422);
      if (NUMERICAS[chave]) {
        const [min, max] = NUMERICAS[chave];
        gravarConfig(db, chave, v.inteiro(valor, `o valor de ${chave}`, { min, max }));
      } else if (BOOLEANAS.includes(chave)) {
        gravarConfig(db, chave, valor ? '1' : '0');
      } else {
        gravarConfig(db, chave, String(valor ?? '').slice(0, 200));
      }
    }
    registrar(db, req, 'config_alterada', Object.keys(req.body ?? {}).join(', '));
    res.json(lerConfig(db));
  });

  r.get('/maquininhas', (_req, res) => res.json(db.prepare(`SELECT id, nome, provedor, identificador, url, (token IS NOT NULL AND token <> '') AS tem_token,
    taxa_debito_bp, taxa_credito_bp, taxa_parcelado_bp, prazo_debito_dias, prazo_credito_dias, ativa, criada_em,
    (SELECT COUNT(*) FROM transacoes_cartao t WHERE t.maquininha_id = maquininhas.id AND t.status = 'aprovada') AS aprovadas
    FROM maquininhas ORDER BY ativa DESC, nome`).all()));

  const dadosMaquininha = (d, novo) => {
    const campos = {};
    if (novo || d.nome !== undefined) campos.nome = v.texto(d.nome, 'o nome da maquininha', 80);
    if (novo || d.provedor !== undefined) campos.provedor = v.opcao(d.provedor ?? 'simulado', 'o provedor', ['simulado', 'ponte', 'mercadopago']);
    if (novo || d.identificador !== undefined) campos.identificador = v.opcional(d.identificador, 'o número de série', 80);
    if (novo || d.url !== undefined) {
      const url = v.opcional(d.url, 'o endereço da ponte', 200);
      if (url) v.exigir(/^https?:\/\//.test(url), 'O endereço da ponte deve começar com http:// ou https://.');
      campos.url = url ? url.replace(/\/+$/, '') : null;
    }
    if (d.token !== undefined) campos.token = v.opcional(d.token, 'o token', 400);
    for (const [campo, nome, max] of [['taxa_debito_bp', 'a taxa do débito', 5000], ['taxa_credito_bp', 'a taxa do crédito', 5000],
      ['taxa_parcelado_bp', 'a taxa do parcelado', 5000], ['prazo_debito_dias', 'o prazo do débito', 180], ['prazo_credito_dias', 'o prazo do crédito', 180]]) {
      if (novo || d[campo] !== undefined) campos[campo] = v.inteiro(d[campo] ?? (campo.startsWith('taxa') ? 0 : 1), nome, { min: 0, max });
    }
    if (d.ativa !== undefined) campos.ativa = d.ativa ? 1 : 0;
    return campos;
  };

  r.post('/maquininhas', (req, res) => {
    const campos = dadosMaquininha(req.body, true);
    const colunas = Object.keys(campos);
    const id = Number(db.prepare(`INSERT INTO maquininhas (${colunas.join(', ')}, criada_em) VALUES (${colunas.map(() => '?').join(', ')}, ?)`)
      .run(...colunas.map((c) => campos[c]), agora()).lastInsertRowid);
    registrar(db, req, 'maquininha_criada', campos.nome);
    res.status(201).json({ id, ...campos });
  });

  r.patch('/maquininhas/:id', (req, res) => {
    if (!db.prepare('SELECT 1 FROM maquininhas WHERE id = ?').get(req.params.id)) throw naoEncontrado('Maquininha');
    const campos = dadosMaquininha(req.body, false);
    const colunas = Object.keys(campos);
    if (colunas.length) db.prepare(`UPDATE maquininhas SET ${colunas.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...colunas.map((c) => campos[c]), req.params.id);
    registrar(db, req, 'maquininha_alterada', `#${req.params.id}`);
    res.json({ id: Number(req.params.id), ...campos });
  });

  r.post('/maquininhas/:id/testar', async (req, res) => res.json(await maquininha.testar(db, Number(req.params.id))));

  r.get('/transacoes', (req, res) => res.json(maquininha.listar(db, { status: req.query.status || null, limite: Math.min(Number(req.query.limite) || 100, 500) })));

  r.get('/usuarios', admin, (_req, res) => res.json(db.prepare(`SELECT u.id, u.nome, u.email, u.telefone, u.perfil, u.ativo, u.ultimo_acesso, u.criado_em,
    m.nome AS morador FROM usuarios u LEFT JOIN moradores m ON m.id = u.morador_id ORDER BY u.ativo DESC, u.nome`).all()));

  r.post('/usuarios', admin, (req, res) => {
    const d = req.body;
    const email = v.email(d.email);
    if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) throw new ErroNegocio('Já existe uma conta com este e-mail.', 409);
    const id = Number(db.prepare('INSERT INTO usuarios (nome, email, telefone, senha_hash, perfil, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
      .run(v.texto(d.nome, 'o nome', 120), email, v.telefoneOpcional(d.telefone), hashSenha(v.senha(d.senha)), v.opcao(d.perfil, 'o perfil', PERFIS), agora()).lastInsertRowid);
    registrar(db, req, 'usuario_criado', `${email} (${d.perfil})`);
    res.status(201).json(db.prepare('SELECT id, nome, email, telefone, perfil, ativo FROM usuarios WHERE id = ?').get(id));
  });

  r.patch('/usuarios/:id', admin, (req, res) => {
    const alvo = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id);
    if (!alvo) throw naoEncontrado('Usuário');
    const d = req.body;
    const campos = {};
    if (d.nome !== undefined) campos.nome = v.texto(d.nome, 'o nome', 120);
    if (d.telefone !== undefined) campos.telefone = v.telefoneOpcional(d.telefone);
    if (d.perfil !== undefined) {
      if (alvo.perfil === 'morador') throw new ErroNegocio('O acesso do morador é gerenciado na ficha dele.', 409);
      campos.perfil = v.opcao(d.perfil, 'o perfil', PERFIS);
    }
    if (d.senha !== undefined) campos.senha_hash = hashSenha(v.senha(d.senha));
    if (d.ativo !== undefined) {
      if (!d.ativo && alvo.id === req.usuario.id) throw new ErroNegocio('Você não pode desativar a própria conta.', 409);
      if (!d.ativo && alvo.perfil === 'admin' && db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE perfil = 'admin' AND ativo = 1").get().n <= 1) {
        throw new ErroNegocio('O sistema precisa de pelo menos um administrador ativo.', 409);
      }
      campos.ativo = d.ativo ? 1 : 0;
    }
    const colunas = Object.keys(campos);
    if (colunas.length) db.prepare(`UPDATE usuarios SET ${colunas.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...colunas.map((c) => campos[c]), req.params.id);
    registrar(db, req, 'usuario_alterado', `#${req.params.id}`);
    res.json(db.prepare('SELECT id, nome, email, telefone, perfil, ativo FROM usuarios WHERE id = ?').get(req.params.id));
  });

  r.get('/auditoria', (req, res) => res.json(db.prepare(`SELECT a.*, u.nome AS usuario FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
    ${req.query.acao ? 'WHERE a.acao = ?' : ''} ORDER BY a.id DESC LIMIT ?`).all(...(req.query.acao ? [req.query.acao] : []), Math.min(Number(req.query.limite) || 200, 1000))));

  return r;
};
