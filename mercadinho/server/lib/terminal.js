'use strict';

const crypto = require('node:crypto');
const { agora, transacao, lerConfig } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const { hashSenha, verificarSenha } = require('./senha');
const moradores = require('./moradores');

/**
 * Terminal de autoatendimento: o aparelho do balcão em que o próprio cliente registra o que levou e paga.
 * Ele nunca usa a senha de um funcionário — é pareado uma vez com um código gerado pela administração
 * e passa a usar um token só dele, que a administração pode desativar a qualquer momento.
 */

const CODIGO_ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem letras e números que se confundem (O/0, I/1)

/** Código de pareamento no formato XXXX-XXXX, mostrado uma única vez a quem cadastra o terminal. */
function gerarCodigo() {
  const letras = Array.from({ length: 8 }, () => CODIGO_ALFABETO[crypto.randomInt(CODIGO_ALFABETO.length)]);
  return `${letras.slice(0, 4).join('')}-${letras.slice(4).join('')}`;
}

const normalizar = (codigo) => String(codigo ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function criar(db, { nome, usuario_id }) {
  const codigo = gerarCodigo();
  const id = Number(db.prepare('INSERT INTO terminais (nome, codigo_hash, criado_em, criado_por) VALUES (?, ?, ?, ?)')
    .run(nome, hashSenha(normalizar(codigo)), agora(), usuario_id).lastInsertRowid);
  // O código só existe aqui: no banco fica o hash, como senha.
  return { terminal: obter(db, id), codigo };
}

const obter = (db, id) => db.prepare(`SELECT t.*, u.nome AS criado_por_nome,
  (SELECT COUNT(*) FROM vendas v WHERE v.terminal_id = t.id AND v.status = 'paga') AS vendas
  FROM terminais t LEFT JOIN usuarios u ON u.id = t.criado_por WHERE t.id = ?`).get(id);

const listar = (db) => db.prepare(`SELECT t.id, t.nome, t.pareado_em, t.ultimo_uso, t.ultimo_ip, t.ativo, t.criado_em,
  (SELECT COUNT(*) FROM vendas v WHERE v.terminal_id = t.id AND v.status = 'paga') AS vendas
  FROM terminais t ORDER BY t.ativo DESC, t.nome`).all();

/** Confere o código digitado no aparelho e marca o terminal como pareado. */
function parear(db, codigo, ip) {
  const limpo = normalizar(codigo);
  if (limpo.length !== 8) throw new ErroNegocio('Código inválido.', 422);
  for (const t of db.prepare("SELECT * FROM terminais WHERE ativo = 1").all()) {
    if (!verificarSenha(limpo, t.codigo_hash)) continue;
    db.prepare('UPDATE terminais SET pareado_em = ?, ultimo_uso = ?, ultimo_ip = ? WHERE id = ?').run(agora(), agora(), ip ?? null, t.id);
    return obter(db, t.id);
  }
  throw new ErroNegocio('Código não confere. Peça um novo à administração.', 401);
}

const revogar = (db, id, ativo) => {
  if (!db.prepare('SELECT 1 FROM terminais WHERE id = ?').get(id)) throw naoEncontrado('Terminal');
  db.prepare('UPDATE terminais SET ativo = ? WHERE id = ?').run(ativo ? 1 : 0, id);
  return obter(db, id);
};

/* ---------- conta do morador no terminal ---------- */

// Tentativas de PIN por morador, na memória do processo. Protege contra quem fica testando senhas no balcão.
const tentativas = new Map();
const MAXIMO_TENTATIVAS = 5;
const BLOQUEIO_MS = 10 * 60_000;

function registrarErro(morador_id) {
  const atual = tentativas.get(morador_id) ?? { erros: 0, ate: 0 };
  atual.erros += 1;
  if (atual.erros >= MAXIMO_TENTATIVAS) { atual.ate = Date.now() + BLOQUEIO_MS; atual.erros = 0; }
  tentativas.set(morador_id, atual);
}

function conferirBloqueio(morador_id) {
  const atual = tentativas.get(morador_id);
  if (atual?.ate > Date.now()) {
    throw new ErroNegocio(`Muitas tentativas. Tente de novo em ${Math.ceil((atual.ate - Date.now()) / 60_000)} minuto(s) ou fale com a administração.`, 429);
  }
}

/** Moradores de uma unidade (o cliente digita o número do apartamento; a lista não é pública). */
function moradoresDaUnidade(db, unidade, bloco = null) {
  const alvo = String(unidade ?? '').trim();
  if (!alvo) throw new ErroNegocio('Informe a unidade.', 422);
  const linhas = db.prepare(`SELECT id, nome, bloco, unidade, fiado_liberado, (pin_hash IS NOT NULL) AS tem_pin
    FROM moradores WHERE ativo = 1 AND unidade = ? COLLATE NOCASE AND (? IS NULL OR bloco = ? COLLATE NOCASE)
    ORDER BY nome`).all(alvo, bloco, bloco);
  if (!linhas.length) throw new ErroNegocio('Nenhum morador cadastrado nessa unidade. Procure a administração.', 404);
  return linhas.map((m) => ({ id: m.id, nome: m.nome, bloco: m.bloco, unidade: m.unidade, pode_usar: Boolean(m.fiado_liberado && m.tem_pin) }));
}

/** Confere o PIN e devolve o morador, com o saldo e o quanto ainda pode gastar. */
function identificar(db, { morador_id, pin }) {
  conferirBloqueio(morador_id);
  const m = db.prepare('SELECT * FROM moradores WHERE id = ? AND ativo = 1').get(morador_id);
  if (!m) throw naoEncontrado('Morador');
  if (!m.pin_hash) throw new ErroNegocio('Esta conta ainda não tem senha do terminal. Peça à administração.', 409);
  if (!m.fiado_liberado) throw new ErroNegocio('Esta conta não está liberada para compras.', 403);
  if (!/^\d{4,8}$/.test(String(pin ?? '')) || !verificarSenha(String(pin), m.pin_hash)) {
    registrarErro(morador_id);
    throw new ErroNegocio('Senha incorreta.', 401);
  }
  tentativas.delete(morador_id);
  return moradores.obter(db, morador_id);
}

/** Define (ou apaga) o PIN do morador. Só a equipe faz isso, pela ficha dele. */
function definirPin(db, morador_id, pin) {
  if (!db.prepare('SELECT 1 FROM moradores WHERE id = ?').get(morador_id)) throw naoEncontrado('Morador');
  if (pin === null) {
    db.prepare('UPDATE moradores SET pin_hash = NULL WHERE id = ?').run(morador_id);
    return { pin: false };
  }
  const limpo = String(pin ?? '').replace(/\D/g, '');
  if (!/^\d{4,8}$/.test(limpo)) throw new ErroNegocio('A senha do terminal deve ter de 4 a 8 números.', 422);
  if (/^(\d)\1+$/.test(limpo)) throw new ErroNegocio('Evite uma senha com todos os números iguais.', 422);
  db.prepare('UPDATE moradores SET pin_hash = ? WHERE id = ?').run(hashSenha(limpo), morador_id);
  tentativas.delete(morador_id);
  return { pin: true };
}

/** Formas de pagamento que o terminal aceita agora (dinheiro nunca: não há quem dê troco). */
function formasDisponiveis(db) {
  const cfg = lerConfig(db);
  const temMaquininha = Boolean(db.prepare('SELECT 1 FROM maquininhas WHERE ativa = 1 LIMIT 1').get());
  return {
    pix: cfg.terminal_pix && Boolean(cfg.pix_chave),
    debito: cfg.terminal_cartao && temMaquininha,
    credito: cfg.terminal_cartao && temMaquininha,
    fiado: cfg.terminal_conta,
  };
}

/** Marca o pagamento como conferido pela gestão (usado nos PIX confirmados pelo próprio cliente). */
function conferirPagamento(db, pagamento_id, usuario_id) {
  const p = db.prepare('SELECT * FROM pagamentos WHERE id = ?').get(pagamento_id);
  if (!p) throw naoEncontrado('Pagamento');
  return transacao(db, () => {
    db.prepare('UPDATE pagamentos SET conferido_em = ?, conferido_por = ? WHERE id = ?')
      .run(p.conferido_em ? null : agora(), p.conferido_em ? null : usuario_id, pagamento_id);
    return db.prepare('SELECT * FROM pagamentos WHERE id = ?').get(pagamento_id);
  });
}

/** Pagamentos do terminal que dependem de conferência no extrato (PIX confirmado pelo cliente). */
const paraConferir = (db, { de = null, ate = null, pendentes = false } = {}) => db.prepare(`SELECT pg.*, v.id AS venda, v.fechada_em, v.total_centavos,
    t.nome AS terminal, m.nome AS morador, u.nome AS conferido_por_nome
  FROM pagamentos pg JOIN vendas v ON v.id = pg.venda_id
  LEFT JOIN terminais t ON t.id = v.terminal_id LEFT JOIN moradores m ON m.id = v.morador_id
  LEFT JOIN usuarios u ON u.id = pg.conferido_por
  WHERE pg.forma = 'pix' AND v.origem = 'autoatendimento' AND v.status = 'paga'
    AND (? IS NULL OR v.fechada_em >= ?) AND (? IS NULL OR v.fechada_em < ?)
    AND (? = 0 OR pg.conferido_em IS NULL)
  ORDER BY pg.id DESC LIMIT 300`).all(de, de, ate, ate, pendentes ? 1 : 0);

module.exports = { gerarCodigo, criar, obter, listar, parear, revogar, moradoresDaUnidade, identificar, definirPin, formasDisponiveis, conferirPagamento, paraConferir };
