'use strict';

/*
 * Alçadas da equipe: o que cada perfil pode fazer no Banqueiro e até que valor.
 *
 * O administrador tem acesso total e define, na tela Alçadas, as regras de gerente e operador.
 * Uma permissão sem regra gravada usa o padrão do catálogo. Limite de valor nulo significa "sem teto".
 * Gerenciar usuários e as próprias alçadas é sempre exclusivo do administrador.
 */

const { ErroNegocio } = require('./erros');

const PERFIS_CONFIGURAVEIS = ['gerente', 'operador', 'ouvidoria', 'antifraude'];

/** padrao: [permitido, limite em centavos ou null] por perfil. `valor`: a permissão tem teto em reais. */
const CATALOGO = [
  { grupo: 'Clientes', chave: 'clientes.cadastrar', rotulo: 'Cadastrar e editar clientes', padrao: { gerente: [true, null], operador: [true, null] } },
  { grupo: 'Clientes', chave: 'clientes.status', rotulo: 'Bloquear e desbloquear clientes', padrao: { gerente: [true, null], operador: [false, null] } },
  { grupo: 'Clientes', chave: 'clientes.excluir', rotulo: 'Excluir cliente sem contas', padrao: { gerente: [false, null], operador: [false, null] } },
  { grupo: 'Contas', chave: 'contas.abrir', rotulo: 'Abrir contas', padrao: { gerente: [true, null], operador: [true, null] } },
  { grupo: 'Contas', chave: 'contas.limite', rotulo: 'Conceder limite de cheque especial', valor: true, ajudaValor: 'Limite máximo por conta',
    padrao: { gerente: [true, null], operador: [false, null] } },
  { grupo: 'Contas', chave: 'contas.gerente', rotulo: 'Definir o gerente da conta', padrao: { gerente: [true, null], operador: [false, null] } },
  { grupo: 'Contas', chave: 'contas.status', rotulo: 'Bloquear, desbloquear e encerrar contas', padrao: { gerente: [true, null], operador: [false, null] } },
  { grupo: 'Abertura de contas', chave: 'aberturas.decidir', rotulo: 'Aprovar e recusar propostas de abertura', padrao: { gerente: [true, null], operador: [false, null] } },
  { grupo: 'Internet Banking', chave: 'ib.habilitar', rotulo: 'Liberar acesso e redefinir a senha do cliente', padrao: { gerente: [true, null], operador: [true, null] } },
  { grupo: 'Internet Banking', chave: 'ib.gerenciar', rotulo: 'Bloquear acesso e alterar o limite diário do cliente', valor: true, ajudaValor: 'Limite diário máximo',
    padrao: { gerente: [true, null], operador: [false, null] } },
  { grupo: 'Internet Banking', chave: 'favorecidos.cadastrar', rotulo: 'Cadastrar e excluir favorecidos', padrao: { gerente: [true, null], operador: [true, null] } },
  { grupo: 'PIX', chave: 'pix.chaves', rotulo: 'Cadastrar e excluir chaves PIX', padrao: { gerente: [true, null], operador: [true, null] } },
  { grupo: 'Crédito', chave: 'emprestimos.conceder', rotulo: 'Conceder empréstimos', valor: true, ajudaValor: 'Valor máximo por empréstimo',
    padrao: { gerente: [true, null], operador: [false, null] } },
  { grupo: 'Operações', chave: 'operacoes.estornar', rotulo: 'Estornar transações', valor: true, ajudaValor: 'Valor máximo por estorno',
    padrao: { gerente: [true, null], operador: [false, null] } },
  { grupo: 'Bradesco', chave: 'bradesco.cobrancas', rotulo: 'Gerar cobranças PIX para clientes', padrao: { gerente: [true, null], operador: [true, null] } },
  { grupo: 'Bradesco', chave: 'bradesco.conciliar', rotulo: 'Conciliação e PIX recebidos sem cobrança', padrao: { gerente: [true, null], operador: [false, null] } },
  { grupo: 'Relacionamento', chave: 'relacionamento.atender', rotulo: 'Atender a própria carteira (mensagens dos clientes e painel)',
    padrao: { gerente: [true, null], operador: [false, null], ouvidoria: [false, null] } },
  { grupo: 'Ouvidoria', chave: 'ouvidoria.decidir', rotulo: 'Analisar solicitações (aprovar ou recusar)',
    padrao: { gerente: [false, null], operador: [false, null], ouvidoria: [true, null] } },
  { grupo: 'Antifraude', chave: 'antifraude.analisar', rotulo: 'Antifraude: painel, alertas e tentativas de acesso',
    padrao: { gerente: [false, null], operador: [false, null], ouvidoria: [false, null], antifraude: [true, null] } },
  { grupo: 'Gestão', chave: 'relatorios.ver', rotulo: 'Ver relatórios', padrao: { gerente: [true, null], operador: [false, null], ouvidoria: [true, null], antifraude: [true, null] } },
  { grupo: 'Gestão', chave: 'auditoria.ver', rotulo: 'Ver auditoria', padrao: { gerente: [true, null], operador: [false, null], ouvidoria: [true, null], antifraude: [true, null] } },
];
const POR_CHAVE = new Map(CATALOGO.map((p) => [p.chave, p]));

const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Regra efetiva de um perfil para uma permissão: { permitido, limite_centavos }. */
function regra(db, perfil, chave) {
  const p = POR_CHAVE.get(chave);
  if (!p) throw new Error(`Permissão desconhecida: ${chave}`);
  if (perfil === 'admin') return { permitido: true, limite_centavos: null };
  if (!PERFIS_CONFIGURAVEIS.includes(perfil)) return { permitido: false, limite_centavos: null };
  const gravada = db.prepare('SELECT permitido, limite_centavos FROM alcadas WHERE perfil = ? AND permissao = ?').get(perfil, chave);
  if (gravada) return { permitido: Boolean(gravada.permitido), limite_centavos: p.valor ? gravada.limite_centavos : null };
  // Perfil sem padrão no catálogo (ex.: Ouvidoria nas operações do dia a dia): não pode.
  const [permitido, limite] = p.padrao[perfil] ?? [false, null];
  return { permitido, limite_centavos: limite };
}

/** Todas as regras de um perfil, para o Banqueiro mostrar só o que o usuário pode fazer. */
function mapa(db, perfil) {
  return Object.fromEntries(CATALOGO.map((p) => [p.chave, regra(db, perfil, p.chave)]));
}

function exigir(db, req, chave) {
  if (!regra(db, req.usuario?.perfil, chave).permitido) {
    throw new ErroNegocio(`Seu perfil não tem alçada para: ${POR_CHAVE.get(chave).rotulo.toLowerCase()}.`, 403);
  }
}

/** Confere a permissão e o teto de valor (em centavos) da alçada do usuário. */
function exigirValor(db, req, chave, valorCentavos) {
  exigir(db, req, chave);
  const { limite_centavos: limite } = regra(db, req.usuario.perfil, chave);
  if (limite !== null && valorCentavos > limite) {
    throw new ErroNegocio(`Valor acima da sua alçada (até ${brl(limite)}). Solicite a um usuário com alçada maior.`, 403);
  }
}

/** Middleware de rota: permite seguir só quem tem a permissão. */
const alcada = (db, chave) => (req, _res, next) => {
  try { exigir(db, req, chave); next(); } catch (err) { next(err); }
};

/** Catálogo com as regras atuais de gerente e operador (tela Alçadas). */
function listar(db) {
  return CATALOGO.map((p) => ({
    grupo: p.grupo, chave: p.chave, rotulo: p.rotulo, valor: Boolean(p.valor), ajuda_valor: p.ajudaValor ?? null,
    regras: Object.fromEntries(PERFIS_CONFIGURAVEIS.map((perfil) => [perfil, regra(db, perfil, p.chave)])),
    padrao: Object.fromEntries(PERFIS_CONFIGURAVEIS.map((perfil) => [perfil, { permitido: (p.padrao[perfil] ?? [false])[0], limite_centavos: (p.padrao[perfil] ?? [false, null])[1] }])),
  }));
}

/**
 * Grava as regras enviadas pelo administrador. `dados` = { gerente: { chave: { permitido, limite_centavos } }, operador: {...} }.
 * Devolve a lista de mudanças (para a auditoria).
 */
function salvar(db, usuarioId, dados) {
  const mudancas = [];
  const gravar = db.prepare(`INSERT INTO alcadas (perfil, permissao, permitido, limite_centavos, atualizado_por, atualizado_em)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (perfil, permissao) DO UPDATE SET permitido = excluded.permitido, limite_centavos = excluded.limite_centavos,
      atualizado_por = excluded.atualizado_por, atualizado_em = excluded.atualizado_em`);
  for (const [perfil, regras] of Object.entries(dados ?? {})) {
    if (!PERFIS_CONFIGURAVEIS.includes(perfil)) throw new ErroNegocio(`Perfil sem alçada configurável: ${perfil}.`, 422);
    for (const [chave, nova] of Object.entries(regras ?? {})) {
      const p = POR_CHAVE.get(chave);
      if (!p) throw new ErroNegocio(`Permissão desconhecida: ${chave}.`, 422);
      const permitido = Boolean(nova?.permitido);
      const limite = p.valor && permitido && nova?.limite_centavos !== null && nova?.limite_centavos !== undefined && nova?.limite_centavos !== ''
        ? Number(nova.limite_centavos) : null;
      if (limite !== null && !(Number.isInteger(limite) && limite >= 0 && limite <= 100_000_000_000)) {
        throw new ErroNegocio(`Valor máximo inválido em "${p.rotulo}".`, 422);
      }
      const atual = regra(db, perfil, chave);
      if (atual.permitido === permitido && atual.limite_centavos === limite) continue;
      gravar.run(perfil, chave, permitido ? 1 : 0, limite, usuarioId);
      mudancas.push({ perfil, permissao: chave, de: atual, para: { permitido, limite_centavos: limite } });
    }
  }
  return mudancas;
}

/** Volta todas as regras de gerente e operador ao padrão do catálogo. */
function restaurar(db) {
  return db.prepare('DELETE FROM alcadas').run().changes;
}

module.exports = { restaurar, CATALOGO, PERFIS_CONFIGURAVEIS, regra, mapa, exigir, exigirValor, alcada, listar, salvar };
