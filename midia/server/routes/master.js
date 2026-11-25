'use strict';

const { Router } = require('express');
const { empresaDe } = require('../lib/empresas');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');

/**
 * De que empresa é cada coisa. O "raiz" carrega a empresa; o resto herda (TV e comunicado do ponto,
 * campanha, contrato e fatura do anunciante, repasse do ponto).
 */
const EMPRESA_DE = {
  locais: 'SELECT empresa_id FROM locais WHERE id = ?',
  telas: 'SELECT l.empresa_id FROM telas t JOIN locais l ON l.id = t.local_id WHERE t.id = ?',
  comunicados: 'SELECT l.empresa_id FROM comunicados c JOIN locais l ON l.id = c.local_id WHERE c.id = ?',
  anunciantes: 'SELECT empresa_id FROM anunciantes WHERE id = ?',
  agencias: 'SELECT empresa_id FROM agencias WHERE id = ?',
  circuitos: 'SELECT empresa_id FROM circuitos WHERE id = ?',
  campanhas: 'SELECT a.empresa_id FROM campanhas c JOIN anunciantes a ON a.id = c.anunciante_id WHERE c.id = ?',
  midias: 'SELECT empresa_id FROM midias WHERE id = ?',
  leads: 'SELECT empresa_id FROM leads WHERE id = ?',
  propostas: 'SELECT empresa_id FROM propostas WHERE id = ?',
  emails: 'SELECT empresa_id FROM emails WHERE id = ?',
  enderecos_email: 'SELECT empresa_id FROM enderecos_email WHERE id = ?',
  contratos: 'SELECT a.empresa_id FROM contratos c JOIN anunciantes a ON a.id = c.anunciante_id WHERE c.id = ?',
  faturas: 'SELECT a.empresa_id FROM faturas f JOIN anunciantes a ON a.id = f.anunciante_id WHERE f.id = ?',
  repasses: 'SELECT l.empresa_id FROM repasses r JOIN locais l ON l.id = r.local_id WHERE r.id = ?',
  despesas: 'SELECT empresa_id FROM despesas WHERE id = ?',
  // Usuário de portal herda do anunciante ou do ponto; master não tem empresa e só o master o enxerga.
  usuarios: `SELECT COALESCE(u.empresa_id, a.empresa_id, l.empresa_id) AS empresa_id FROM usuarios u
    LEFT JOIN anunciantes a ON a.id = u.anunciante_id LEFT JOIN locais l ON l.id = u.local_id WHERE u.id = ?`,
};

// Endereço → tabela do id que vem nele.
const ROTAS = [
  [/^\/locais\/(\d+)/, 'locais'], [/^\/telas\/(\d+)/, 'telas'], [/^\/grade\/(\d+)/, 'telas'],
  [/^\/comunicados\/(\d+)/, 'comunicados'], [/^\/anunciantes\/(\d+)/, 'anunciantes'], [/^\/agencias\/(\d+)/, 'agencias'],
  [/^\/circuitos\/(\d+)/, 'circuitos'], [/^\/campanhas\/(\d+)/, 'campanhas'], [/^\/campanhas\/\d+\/criativos\/(\d+)/, 'midias'],
  [/^\/midias\/(\d+)/, 'midias'], [/^\/crm\/leads\/(\d+)/, 'leads'], [/^\/propostas\/(\d+)/, 'propostas'],
  [/^\/crm\/emails\/(\d+)/, 'emails'], [/^\/contratos\/(\d+)/, 'contratos'], [/^\/faturas\/(\d+)/, 'faturas'],
  [/^\/repasses\/(\d+)/, 'repasses'], [/^\/despesas\/(\d+)/, 'despesas'], [/^\/usuarios\/(\d+)/, 'usuarios'],
  [/^\/enderecos-email\/(\d+)/, 'enderecos_email'],
];

// Campos do corpo (ou da URL) que apontam para outra coisa: também precisam ser da mesma empresa.
const CAMPOS = {
  anunciante_id: 'anunciantes', local_id: 'locais', agencia_id: 'agencias', circuito_id: 'circuitos', lead_id: 'leads',
  tela_id: 'telas', midia_id: 'midias', contrato_id: 'contratos', proposta_id: 'propostas', campanha_id: 'campanhas',
};

/** Painel da equipe (master, administrador e operador): cadastros, campanhas, criativos, relatórios, faturamento e administração. */
module.exports = (db) => {
  const r = Router();
  const consultas = Object.fromEntries(Object.entries(EMPRESA_DE).map(([t, sql]) => [t, db.prepare(sql)]));
  const empresaDaLinha = (tabela, id) => consultas[tabela].get(Number(id));

  // Trava central: quem não é master só abre, altera ou apaga o que é da própria empresa — e só aponta
  // (no corpo do pedido) para coisas da própria empresa. De outra empresa, é como se não existisse.
  r.use((req, _res, next) => {
    const minha = empresaDe(req);
    if (minha === null) return next();
    for (const [re, tabela] of ROTAS) {
      const m = req.path.match(re);
      if (!m) continue;
      const linha = empresaDaLinha(tabela, m[1]);
      // Usuário master (sem empresa): a própria rota responde que só o master mexe nele.
      if (tabela === 'usuarios' && linha && linha.empresa_id === null) continue;
      if (linha && linha.empresa_id !== minha) return next(naoEncontrado('Registro'));
    }
    const conferir = (campo, valor) => {
      if (valor === undefined || valor === null || valor === '') return;
      const linha = empresaDaLinha(CAMPOS[campo], valor);
      if (linha && linha.empresa_id !== minha) throw new ErroNegocio('Não encontrado.', 404);
    };
    try {
      const origens = [req.query ?? {}, (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) ? req.body : {}];
      for (const o of origens) {
        for (const campo of Object.keys(CAMPOS)) conferir(campo, o[campo]);
        for (const c of Array.isArray(o.criativos) ? o.criativos : []) conferir('midia_id', c?.midia_id);
        for (const a of Array.isArray(o.alvos) ? o.alvos : []) {
          if (a?.tipo === 'tela') conferir('tela_id', a.valor);
          if (a?.tipo === 'local') conferir('local_id', a.valor);
        }
        for (const id of Array.isArray(o.telas) ? o.telas : []) conferir('tela_id', id);
        // Empresa só o master escolhe.
        if (o.empresa_id !== undefined) delete o.empresa_id;
      }
    } catch (err) {
      return next(err);
    }
    next();
  });

  r.use(require('./cadastros')(db));
  r.use(require('./campanhas')(db));
  r.use(require('./financeiro')(db));
  r.use(require('./gestao')(db));
  r.use(require('./crm')(db));
  return r;
};
