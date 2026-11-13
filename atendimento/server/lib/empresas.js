'use strict';

const crypto = require('node:crypto');
const { agora, transacao, lerConfig } = require('../db');
const { cifrar } = require('./cifra');
const { hashSenha } = require('./senha');
const { ErroNegocio, naoEncontrado } = require('./erros');
const v = require('./validacao');

/**
 * Cadastro de empresas. Uma empresa nova já nasce pronta para atender: configuração da atendente
 * virtual, duas filas (Atendimento e Financeiro), etiquetas e algumas intenções que valem para todo mundo.
 */

const FILAS_PADRAO = [
  { nome: 'Atendimento', descricao: 'Dúvidas e pedidos gerais', quando_usar: 'dúvidas gerais, pedidos, informações, qualquer assunto sem time específico', ordem: 1 },
  { nome: 'Financeiro', descricao: 'Boletos, pagamentos e cobrança', quando_usar: 'boleto, fatura, pagamento, cobrança, atraso, negociação, estorno, nota fiscal', ordem: 2 },
];

const ETIQUETAS_PADRAO = [['Urgente', 'vermelho'], ['Reclamação', 'laranja'], ['Elogio', 'verde'], ['Acompanhar', 'azul']];

const INTENCOES_PADRAO = [
  { nome: 'Falar com o financeiro', palavras: 'financeiro\nsegunda via\n2 via\nboleto\nfatura\npagamento\nnota fiscal', acao: 'transferir', fila: 'Financeiro', ordem: 10 },
  { nome: 'Cancelamento', palavras: 'cancelar\ncancelamento\nquero cancelar\nencerrar contrato', acao: 'transferir', fila: 'Atendimento', ordem: 5 },
];

const CONHECIMENTO_EXEMPLO = [
  { titulo: 'Horário de atendimento', resposta: 'Nosso atendimento humano funciona de segunda a sexta, das 8h às 18h. Fora desse horário eu registro o seu pedido e a equipe responde na abertura.', perguntas: 'que horas vocês abrem?\nvocês atendem no fim de semana?\nqual o horário de atendimento?' },
];

/** Cria a empresa com tudo o que ela precisa para começar. Devolve a empresa. */
function criar(db, dados, { comExemplos = true } = {}) {
  const cfg = lerConfig(db);
  const nome = v.texto(dados.nome, 'o nome da empresa', 160);
  const documento = dados.documento ? v.digitos(dados.documento) : null;
  if (documento) {
    v.exigir((documento.length === 14 && v.cnpjValido(documento)) || (documento.length === 11 && v.cpfValido(documento)), 'CNPJ ou CPF inválido.');
  }
  return transacao(db, () => {
    const id = Number(db.prepare(`INSERT INTO empresas (nome, documento, email, telefone, limite_atendentes, limite_ia_mes, criada_em)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(nome, documento, dados.email ? v.email(dados.email) : null,
      dados.telefone ? v.telefone(dados.telefone) : null,
      dados.limite_atendentes === undefined ? cfg.limite_atendentes_padrao : v.inteiro(dados.limite_atendentes, 'o limite de atendentes'),
      dados.limite_ia_mes === undefined ? cfg.limite_ia_mes_padrao : v.inteiro(dados.limite_ia_mes, 'o limite de mensagens da IA'),
      agora()).lastInsertRowid);

    const filaId = new Map();
    for (const f of FILAS_PADRAO) {
      filaId.set(f.nome, Number(db.prepare('INSERT INTO filas (empresa_id, nome, descricao, quando_usar, ordem, criada_em) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, f.nome, f.descricao, f.quando_usar, f.ordem, agora()).lastInsertRowid));
    }
    db.prepare(`INSERT INTO ia_config (empresa_id, ativa, nome_assistente, fila_padrao_id, atualizada_em) VALUES (?, 1, 'ZOE', ?, ?)`)
      .run(id, filaId.get('Atendimento'), agora());
    for (const [etiqueta, cor] of ETIQUETAS_PADRAO) {
      db.prepare('INSERT INTO etiquetas (empresa_id, nome, cor, criada_em) VALUES (?, ?, ?, ?)').run(id, etiqueta, cor, agora());
    }
    if (comExemplos) {
      for (const i of INTENCOES_PADRAO) {
        db.prepare('INSERT INTO intencoes (empresa_id, nome, palavras, acao, fila_id, ordem, criada_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, i.nome, i.palavras, i.acao, filaId.get(i.fila) ?? null, i.ordem, agora());
      }
      for (const k of CONHECIMENTO_EXEMPLO) {
        db.prepare('INSERT INTO conhecimento (empresa_id, titulo, resposta, perguntas, criado_em) VALUES (?, ?, ?, ?, ?)')
          .run(id, k.titulo, k.resposta, k.perguntas, agora());
      }
    }
    return db.prepare('SELECT * FROM empresas WHERE id = ?').get(id);
  });
}

/** Cria um usuário da empresa (administrador, supervisor ou atendente) e devolve a senha provisória. */
function criarUsuario(db, empresaId, dados) {
  const perfil = v.opcao(dados.perfil ?? 'atendente', 'o perfil', ['cliente', 'supervisor', 'atendente']);
  const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(empresaId);
  if (!empresa) throw naoEncontrado('Empresa');
  if (perfil === 'atendente' || perfil === 'cliente') {
    const usados = Number(db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE empresa_id = ? AND ativo = 1 AND perfil IN ('atendente','cliente')").all(empresaId)[0].n);
    if (empresa.limite_atendentes > 0 && usados >= empresa.limite_atendentes) {
      throw new ErroNegocio(`A empresa já tem ${usados} atendente(s), o limite do plano. Fale com o suporte para aumentar.`);
    }
  }
  // Provisória forte (12 caracteres aleatórios): "atende" + 4 dígitos seriam só 9 mil chutes.
  const senha = dados.senha ? v.senha(dados.senha) : crypto.randomBytes(9).toString('base64url');
  const ramal = lerRamal(db, empresaId, dados.ramal);
  const id = Number(db.prepare(`INSERT INTO usuarios (nome, email, senha_hash, perfil, empresa_id, max_simultaneas, ramal, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(v.texto(dados.nome, 'o nome', 160), v.email(dados.email), hashSenha(senha), perfil, empresaId,
    dados.max_simultaneas === undefined ? 5 : v.inteiro(dados.max_simultaneas, 'o máximo de conversas ao mesmo tempo', { min: 1, max: 50 }), ramal, agora()).lastInsertRowid);
  // Atendente novo já entra em todas as filas ativas; o administrador ajusta depois.
  for (const f of db.prepare('SELECT id FROM filas WHERE empresa_id = ? AND ativa = 1').all(empresaId)) {
    db.prepare('INSERT OR IGNORE INTO fila_usuarios (fila_id, usuario_id) VALUES (?, ?)').run(f.id, id);
  }
  return { usuario: db.prepare('SELECT id, nome, email, perfil, empresa_id, max_simultaneas, ramal FROM usuarios WHERE id = ?').get(id), senha_provisoria: senha };
}

/**
 * O ramal da pessoa na central (só números). Vazio tira o ramal. Dois usuários da mesma empresa
 * não podem ter o mesmo: a ligação abriria no painel de quem não atendeu.
 */
function lerRamal(db, empresaId, valor, { usuarioId = null } = {}) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return null;
  const r = String(valor).trim();
  v.exigir(/^\d{2,8}$/.test(r), 'O ramal tem só números, de 2 a 8 dígitos (ex.: 201).');
  const dono = db.prepare('SELECT nome FROM usuarios WHERE empresa_id = ? AND ramal = ? AND id IS NOT ?').get(empresaId, r, usuarioId);
  v.exigir(!dono, `O ramal ${r} já é de ${dono?.nome}.`);
  return r;
}

/** Cadastra ou atualiza o número de WhatsApp da empresa (Cloud API). */
function salvarNumero(db, empresaId, dados, { id = null } = {}) {
  const phoneNumberId = v.texto(dados.phone_number_id, 'o Phone number ID do WhatsApp', 64).replace(/\D/g, '');
  v.exigir(phoneNumberId.length >= 5, 'Phone number ID inválido (são só números, do painel da Meta).');
  const campos = {
    nome: v.texto(dados.nome, 'o nome do número', 80),
    telefone: v.whatsapp(dados.telefone),
    phone_number_id: phoneNumberId,
    waba_id: dados.waba_id ? v.texto(dados.waba_id, 'o WABA ID', 64) : null,
  };
  if (id) {
    const atual = db.prepare('SELECT * FROM numeros WHERE id = ? AND empresa_id = ?').get(Number(id), empresaId);
    if (!atual) throw naoEncontrado('Número');
    const token = dados.token ? cifrar(v.texto(dados.token, 'o token de acesso', 500), 'whatsapp') : atual.token_cifrado;
    const segredo = dados.app_secret ? cifrar(v.texto(dados.app_secret, 'o App secret', 200), 'whatsapp') : atual.app_secret_cifrado;
    db.prepare(`UPDATE numeros SET nome = ?, telefone = ?, phone_number_id = ?, waba_id = ?, token_cifrado = ?, app_secret_cifrado = ?,
        verify_token = ?, ativo = ? WHERE id = ?`)
      .run(campos.nome, campos.telefone, campos.phone_number_id, campos.waba_id, token, segredo,
        dados.verify_token ? v.texto(dados.verify_token, 'o token de verificação', 120) : atual.verify_token,
        dados.ativo === undefined ? atual.ativo : (v.booleano(dados.ativo) ? 1 : 0), atual.id);
    return db.prepare('SELECT * FROM numeros WHERE id = ?').get(atual.id);
  }
  v.exigir(dados.token, 'Informe o token de acesso permanente do WhatsApp (painel da Meta).');
  const verify = dados.verify_token ? v.texto(dados.verify_token, 'o token de verificação', 120) : crypto.randomBytes(16).toString('hex');
  const novo = Number(db.prepare(`INSERT INTO numeros (empresa_id, nome, telefone, phone_number_id, waba_id, token_cifrado, app_secret_cifrado, verify_token, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(empresaId, campos.nome, campos.telefone, campos.phone_number_id, campos.waba_id,
    cifrar(v.texto(dados.token, 'o token de acesso', 500), 'whatsapp'),
    dados.app_secret ? cifrar(v.texto(dados.app_secret, 'o App secret', 200), 'whatsapp') : null, verify, agora()).lastInsertRowid);
  return db.prepare('SELECT * FROM numeros WHERE id = ?').get(novo);
}

/** O número sem os segredos, para o painel. */
const numeroPublico = (n) => n && ({
  id: n.id, nome: n.nome, telefone: n.telefone, phone_number_id: n.phone_number_id, waba_id: n.waba_id,
  verify_token: n.verify_token, ativo: Boolean(n.ativo), ultimo_evento_em: n.ultimo_evento_em, criado_em: n.criado_em,
  token_configurado: Boolean(n.token_cifrado), app_secret_configurado: Boolean(n.app_secret_cifrado),
});

/** Gera uma chave de API para a empresa. A chave em claro aparece uma única vez. */
function criarChaveApi(db, empresaId, nome) {
  const chave = `atd_${crypto.randomBytes(24).toString('base64url')}`;
  const id = Number(db.prepare('INSERT INTO chaves_api (empresa_id, nome, prefixo, chave_hash, criada_em) VALUES (?, ?, ?, ?, ?)')
    .run(empresaId, v.texto(nome, 'o nome da chave', 80), chave.slice(0, 12), crypto.createHash('sha256').update(chave).digest('hex'), agora()).lastInsertRowid);
  return { id, chave, prefixo: chave.slice(0, 12) };
}

module.exports = {
  lerRamal, criar, criarUsuario, salvarNumero, numeroPublico, criarChaveApi, FILAS_PADRAO, ETIQUETAS_PADRAO, INTENCOES_PADRAO };
