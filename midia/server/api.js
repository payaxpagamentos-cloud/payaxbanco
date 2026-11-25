'use strict';

const express = require('express');
const { autenticar, permitir, EQUIPE } = require('./auth');
const { ErroNegocio } = require('./lib/erros');
const { lerConfig } = require('./db');

function criarApi(db) {
  const api = express.Router();
  const autenticado = autenticar(db);

  api.get('/saude', (_req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  });
  // Lido pela tela de entrada e pelo player antes de parear (só o nome da plataforma).
  api.get('/publico', (_req, res) => {
    const c = lerConfig(db);
    res.json({ nome: c.nome_plataforma, slogan: c.slogan, whatsapp: c.whatsapp || null });
  });

  /**
   * A proposta aberta pelo link do WhatsApp. Público de propósito: quem recebeu o link é o cliente,
   * e exigir senha de quem ainda nem fechou negócio é o jeito mais rápido de perder a venda.
   * O link é aleatório e a folha é só de leitura — nada do painel vai junto.
   */
  api.get('/publico/proposta/:token', require('./lib/limitador').limitar({ janelaMs: 60_000, maximo: 30, todos: true }), (req, res) => {
    const c = lerConfig(db);
    res.json({ ...require('./lib/propostas').porToken(db, req.params.token), whatsapp: c.whatsapp || null });
  });

  /**
   * Totem de senha do ponto: o cliente digita o CPF e escolhe o atendimento. Sem login — quem abre é o
   * aparelho do totem, pelo link com a chave do ponto (gerado na tela Senhas). Tem limite por IP.
   */
  const limiteTotem = require('./lib/limitador').limitar({ janelaMs: 60_000, maximo: 40, todos: true });
  const totem = (req) => {
    const p = require('./lib/senhas').pontoDoTotem(db, req.params.chave);
    if (!p) throw new ErroNegocio('Totem não reconhecido. Abra de novo pelo link da tela Senhas.', 404);
    return p;
  };
  api.get('/totem/:chave', limiteTotem, (req, res) => {
    const p = totem(req);
    const c = lerConfig(db);
    res.json({ ponto: p.nome, plataforma: c.nome_plataforma, servicos: require('./lib/senhas').servicosDoPonto(db, p.id) });
  });
  api.post('/totem/:chave/senha', limiteTotem, (req, res) => {
    res.status(201).json(require('./lib/senhas').emitir(db, totem(req).id, req.body));
  });

  /**
   * Números da rede para o site: só agregados, nenhum nome de ponto ou cliente.
   * É o que mantém a página sempre atual sem ninguém editar HTML.
   */
  api.get('/publico/rede', (_req, res) => {
    const n = db.prepare(`SELECT COUNT(DISTINCT t.id) AS telas, COUNT(DISTINCT l.id) AS pontos,
        COUNT(DISTINCT l.cidade) AS cidades, COALESCE(SUM(DISTINCT 0), 0) AS zero
      FROM telas t JOIN locais l ON l.id = t.local_id WHERE t.status = 'ativa' AND l.status = 'ativo'`).get();
    const publico = db.prepare(`SELECT COALESCE(SUM(l.publico_dia), 0) AS dia FROM locais l
      WHERE l.status = 'ativo' AND EXISTS (SELECT 1 FROM telas t WHERE t.local_id = l.id AND t.status = 'ativa')`).get().dia;
    res.json({ telas: n.telas, pontos: n.pontos, cidades: n.cidades, publico_mes: publico * 30 });
  });

  /**
   * Formulário do site: quem pede contato entra direto no CRM como lead.
   * É público de propósito (não há login para quem ainda não é cliente), então tem limite por IP
   * e grava só o que o formulário manda — nada daqui vai para a tela sem alguém da equipe aprovar.
   */
  api.post('/contato', require('./lib/limitador').limitar({ janelaMs: 60_000, maximo: 5 }), (req, res) => {
    const v = require('./lib/validacao');
    const { agora } = require('./db');
    const d = {
      nome: v.texto(req.body.nome, 'o nome', 120),
      tipo: v.opcao(req.body.tipo ?? 'anunciante', 'o tipo', ['anunciante', 'ponto']),
      contato: v.opcional(req.body.contato, 'o contato', 120),
      email: req.body.email ? v.email(req.body.email) : null,
      telefone: v.opcional(req.body.telefone, 'o telefone', 20),
      cidade: v.opcional(req.body.cidade, 'a cidade', 80),
      mensagem: v.opcional(req.body.mensagem, 'a mensagem', 500),
      origem: 'site',
      criado_em: agora(),
      atualizado_em: agora(),
    };
    if (!d.email && !d.telefone) throw new ErroNegocio('Deixe um e-mail ou um telefone para a gente responder.', 422);
    const id = Number(db.prepare(`INSERT INTO leads (${Object.keys(d).join(', ')})
      VALUES (${Object.keys(d).map(() => '?').join(', ')})`).run(...Object.values(d)).lastInsertRowid);
    if (d.mensagem) {
      db.prepare("INSERT INTO lead_interacoes (lead_id, tipo, texto, criado_em) VALUES (?, 'nota', ?, ?)")
        .run(id, `Pedido pelo site: ${d.mensagem}`, agora());
    }
    res.status(201).json({ ok: true, mensagem: 'Recebemos o seu contato. A equipe responde em breve.' });
  });

  api.use('/auth', require('./routes/auth')(db, autenticado));
  // A TV fala por aqui: pareamento e, depois, com o token do aparelho.
  api.use('/player', require('./routes/player')(db));
  api.use('/painel', autenticado, permitir(...EQUIPE), require('./routes/master')(db));
  api.use('/anunciante', autenticado, permitir('anunciante'), require('./routes/anunciante')(db));
  api.use('/ponto', autenticado, permitir('lojista'), require('./routes/lojista')(db));
  api.use((_req, _res, next) => next(new ErroNegocio('Rota não encontrada.', 404)));
  return api;
}

function tratarErro(err, res) {
  if (err instanceof ErroNegocio) return res.status(err.status).json({ erro: err.message, detalhes: err.detalhes });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ erro: 'Requisição grande demais.' });
  if (/UNIQUE constraint failed/i.test(err.message)) return res.status(409).json({ erro: 'Já existe um cadastro com esses dados.' });
  if (/constraint failed/i.test(err.message)) return res.status(409).json({ erro: 'Operação viola uma restrição de integridade.' });
  console.error(err);
  return res.status(500).json({ erro: 'Erro interno do servidor.' });
}

module.exports = { criarApi, tratarErro };
