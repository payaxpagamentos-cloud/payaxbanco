'use strict';

const { EventEmitter } = require('node:events');
const { agora, lerConfig, transacao } = require('../db');
const { ErroNegocio } = require('./erros');
const v = require('./validacao');

const TIPOS = {
  bloquear: 'Bloquear o veículo',
  desbloquear: 'Desbloquear o veículo',
  localizar: 'Pedir a posição agora',
  reiniciar: 'Reiniciar o equipamento',
  status: 'Consultar o estado do equipamento',
  parametros: 'Consultar a configuração do equipamento',
  personalizado: 'Comando personalizado',
};

/**
 * Modelos conhecidos e os textos dos comandos de cada um (o modelo do rastreador é reconhecido pelo nome cadastrado).
 * J16 4G: comandos do manual da Indica Planos (relé de corte no fio de bloqueio; o J16 só corta com o veículo devagar ou parado).
 */
const MODELOS = {
  j16: {
    nome: 'J16 4G', protocolo: 'gt06', reconhece: /\bj16\b/i,
    comandos: { bloquear: 'RELAY,1#', desbloquear: 'RELAY,0#', localizar: 'WHERE#', reiniciar: 'RESET#', status: 'STATUS#', parametros: 'PARAM#' },
  },
};
const modeloDe = (nome) => Object.values(MODELOS).find((m) => m.reconhece.test(String(nome ?? ''))) ?? null;
// Comandos de consulta que não têm texto configurável: o padrão do protocolo GT06.
const PADRAO_GT06 = { status: 'STATUS#', parametros: 'PARAM#' };

/** Avisa o servidor GT06 de um comando novo, para entregar na hora se o equipamento estiver conectado. */
const canal = new EventEmitter();

/**
 * Texto enviado ao equipamento: o do modelo conhecido (ex.: J16), senão o configurado para o GT06;
 * na API, o próprio tipo (o sistema integrador traduz).
 */
function textoComando(cfg, tipo, rastreador, texto) {
  if (tipo === 'personalizado') return v.texto(texto, 'o comando', 120);
  if (rastreador.protocolo !== 'gt06') return tipo;
  return modeloDe(rastreador.modelo)?.comandos[tipo] ?? cfg[`gt06_cmd_${tipo}`] ?? PADRAO_GT06[tipo];
}

/**
 * Novo comando para o rastreador do veículo. Bloquear exige digitar a placa (corta o combustível ou a ignição do veículo).
 * Um bloqueio ou desbloqueio ainda não enviado é substituído pelo novo.
 */
function criar(db, veiculo, d, usuarioId) {
  v.exigir(veiculo.rastreador_id, 'O veículo não tem rastreador instalado.');
  const r = db.prepare('SELECT * FROM rastreadores WHERE id = ?').get(veiculo.rastreador_id);
  v.exigir(r.protocolo !== 'osmand', 'Este rastreador (aplicativo no celular) não recebe comandos.');
  const tipo = v.opcao(d.tipo, 'o comando', Object.keys(TIPOS));
  if (tipo === 'bloquear') {
    const digitada = String(d.confirmacao ?? '').toUpperCase().replace(/[\s-]/g, '');
    if (digitada !== veiculo.placa) throw new ErroNegocio('Para bloquear, digite a placa do veículo para confirmar.', 422);
  }
  const texto = textoComando(lerConfig(db), tipo, r, d.texto);
  const id = transacao(db, () => {
    if (tipo === 'bloquear' || tipo === 'desbloquear') {
      db.prepare("UPDATE comandos SET status = 'cancelado', respondido_em = ? WHERE veiculo_id = ? AND status = 'pendente' AND tipo IN ('bloquear','desbloquear')")
        .run(agora(), veiculo.id);
    }
    return Number(db.prepare(`INSERT INTO comandos (empresa_id, veiculo_id, rastreador_id, tipo, texto, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(veiculo.empresa_id, veiculo.id, r.id, tipo, texto, usuarioId ?? null, agora()).lastInsertRowid);
  });
  canal.emit('comando', { id, imei: r.imei, protocolo: r.protocolo });
  return id;
}

const pendentes = (db, rastreadorId) => db.prepare("SELECT * FROM comandos WHERE rastreador_id = ? AND status = 'pendente' ORDER BY id").all(rastreadorId);

function marcarEnviado(db, id) {
  db.prepare("UPDATE comandos SET status = 'enviado', enviado_em = ? WHERE id = ? AND status = 'pendente'").run(agora(), id);
}

/** Resposta do equipamento. Bloqueio ou desbloqueio confirmado muda a situação do veículo. */
function responder(db, id, { sucesso, resposta }) {
  return transacao(db, () => {
    const c = db.prepare("SELECT * FROM comandos WHERE id = ? AND status IN ('pendente','enviado')").get(id);
    if (!c) return false;
    db.prepare('UPDATE comandos SET status = ?, respondido_em = ?, resposta = ?, enviado_em = COALESCE(enviado_em, ?) WHERE id = ?')
      .run(sucesso ? 'confirmado' : 'falhou', agora(), resposta ? String(resposta).slice(0, 500) : null, agora(), id);
    if (sucesso && (c.tipo === 'bloquear' || c.tipo === 'desbloquear')) {
      db.prepare('UPDATE veiculos SET bloqueado = ? WHERE id = ?').run(c.tipo === 'bloquear' ? 1 : 0, c.veiculo_id);
    }
    return true;
  });
}

/** Resposta de texto do equipamento: falha quando fala em erro; senão, confirmado. */
const respostaSucesso = (texto) => !/fail|error|erro|invalid|inv[aá]lid/i.test(String(texto ?? ''));

/** Comandos sem resposta dentro do prazo expiram. */
function expirar(db, horas) {
  const corte = new Date(Date.now() - horas * 3_600_000).toISOString();
  return db.prepare("UPDATE comandos SET status = 'expirado', respondido_em = ? WHERE status IN ('pendente','enviado') AND criado_em < ?").run(agora(), corte).changes;
}

module.exports = { TIPOS, MODELOS, modeloDe, canal, criar, pendentes, marcarEnviado, responder, respostaSucesso, expirar };
