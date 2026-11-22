'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

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
    // estadoRele: false = o bit de corte das mensagens de estado do J16 não é confiável (muda sem o relé mudar); a situação na
    // tela segue o último bloqueio/desbloqueio confirmado pelo aparelho.
    nome: 'J16 4G', protocolo: 'gt06', reconhece: /\bj16\b/i, estadoRele: false,
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
  // Relé invertido na ficha do equipamento: o corte e o desbloqueio trocam de texto.
  const t = rastreador.rele_invertido && (tipo === 'bloquear' || tipo === 'desbloquear') ? (tipo === 'bloquear' ? 'desbloquear' : 'bloquear') : tipo;
  return modeloDe(rastreador.modelo)?.comandos[t] ?? cfg[`gt06_cmd_${t}`] ?? PADRAO_GT06[t];
}

/**
 * Novo comando para o rastreador do veículo. Bloquear exige digitar a placa (corta o combustível ou a ignição do veículo).
 * Um bloqueio ou desbloqueio ainda não enviado é substituído pelo novo.
 */
// `doSistema`: texto montado pelo próprio sistema (funções do equipamento, ex.: anti-jammer com JAMRELAY), nunca o digitado.
/** Texto livre de quem não é da plataforma: só consulta, sem parâmetro (nada depois do nome além do #). */
const CONSULTAS_LIVRES = /^(STATUS|PARAM|WHERE|URL|VERSION|GPRSSET|CXZT|IMEI|ICCID|SCXSZ|RESET)#?$/i;

function criar(db, veiculo, d, usuarioId, { doSistema = false, plataforma = false } = {}) {
  v.exigir(veiculo.rastreador_id, 'O veículo não tem rastreador instalado.');
  const r = db.prepare('SELECT * FROM rastreadores WHERE id = ?').get(veiculo.rastreador_id);
  v.exigir(r.protocolo !== 'osmand', 'Este rastreador (aplicativo no celular) não recebe comandos.');
  const tipo = v.opcao(d.tipo, 'o comando', Object.keys(TIPOS));
  if ((tipo === 'bloquear' || tipo === 'desbloquear') && db.prepare('SELECT bloqueio_desativado FROM veiculos WHERE id = ?').get(veiculo.id)?.bloqueio_desativado) {
    throw new ErroNegocio('O bloqueio deste veículo está desativado (instalação do relé em revisão). Para usar, reative em Veículos → Editar.', 422);
  }
  if (tipo === 'bloquear') {
    const digitada = String(d.confirmacao ?? '').toUpperCase().replace(/[\s-]/g, '');
    if (digitada !== veiculo.placa) throw new ErroNegocio('Para bloquear, digite a placa do veículo para confirmar.', 422);
  }
  if (tipo === 'personalizado' && !doSistema) {
    const livre = String(d.texto ?? '').trim();
    // Só letras, números e pontuação comuns: o aparelho recebe 1 byte por caractere, e um caractere "parecido" (ex.: Œ) chegaria
    // lá como outra letra (R), passando pelo filtro abaixo sem ser visto.
    if (!/^[\x20-\x7E]{1,120}$/.test(livre)) throw new ErroNegocio('O comando só pode ter letras sem acento, números e pontuação simples (até 120 caracteres).', 422);
    // Corte e desbloqueio só pelos botões (placa, velocidade segura, relé invertido e o estado na tela); nunca por texto livre.
    if (/RELAY|DYD|HFYD/i.test(livre)) throw new ErroNegocio('Para cortar ou liberar o veículo, use os botões Bloquear e Desbloquear.', 422);
    // Quem não é da plataforma só envia consultas (sem parâmetros): servidor, APN, fábrica, números e intervalos mudam o aparelho
    // e um erro tira ele do ar.
    if (!plataforma && !CONSULTAS_LIVRES.test(livre)) {
      throw new ErroNegocio('Por aqui só vão as consultas (STATUS#, PARAM#, WHERE#, URL#, VERSION#, GPRSSET#, RESET#). Ajustes do aparelho ficam na ficha do veículo ou com o suporte.', 403);
    }
  }
  const texto = textoComando(lerConfig(db), tipo, r, d.texto);
  const id = transacao(db, () => {
    if (tipo === 'bloquear' || tipo === 'desbloquear') {
      // O último pedido é o que vale: um corte/desbloqueio anterior ainda sem confirmação (na fila, enviado sem resposta ou
      // adiado pelo aparelho) é cancelado. Assim ele não é reenviado numa reconexão nem confirmado depois do pedido novo.
      db.prepare("UPDATE comandos SET status = 'cancelado', respondido_em = ? WHERE veiculo_id = ? AND status IN ('pendente','enviado') AND tipo IN ('bloquear','desbloquear')")
        .run(agora(), veiculo.id);
    }
    return Number(db.prepare(`INSERT INTO comandos (empresa_id, veiculo_id, rastreador_id, tipo, texto, rotulo, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(veiculo.empresa_id, veiculo.id, r.id, tipo, texto, d.rotulo ? String(d.rotulo).slice(0, 120) : null, usuarioId ?? null, agora()).lastInsertRowid);
  });
  // Depois de gravado de vez (a rota pode estar dentro de uma transação maior): o serviço GT06 lê o banco ao ser avisado.
  setImmediate(() => canal.emit('comando', { id, imei: r.imei, protocolo: r.protocolo }));
  return id;
}

const pendentes = (db, rastreadorId) => db.prepare("SELECT * FROM comandos WHERE rastreador_id = ? AND status = 'pendente' ORDER BY id").all(rastreadorId);

/** Marca como enviado só se ainda estiver na fila (um cancelamento de última hora vence). Devolve se pode enviar. */
function marcarEnviado(db, id) {
  return db.prepare("UPDATE comandos SET status = 'enviado', enviado_em = ? WHERE id = ? AND status = 'pendente'").run(agora(), id).changes > 0;
}

/** Resposta do equipamento. Bloqueio ou desbloqueio confirmado muda a situação do veículo. */
function responder(db, id, { sucesso, resposta }) {
  return transacao(db, () => {
    const c = db.prepare("SELECT * FROM comandos WHERE id = ? AND status IN ('pendente','enviado')").get(id);
    if (!c) return false;
    // Corte/desbloqueio aceito mas ADIADO pelo aparelho ("será executado quando tiver GPS e abaixo de 20 km/h"): o relé ainda não
    // mudou. O comando continua em andamento (a tela mostra "bloqueando…") e é confirmado quando o aparelho informar o novo estado.
    if (sucesso && (c.tipo === 'bloquear' || c.tipo === 'desbloquear') && respostaAdiada(resposta)) {
      db.prepare("UPDATE comandos SET status = 'enviado', resposta = ?, enviado_em = COALESCE(enviado_em, ?) WHERE id = ?").run(String(resposta).slice(0, 500), agora(), id);
      return true;
    }
    db.prepare('UPDATE comandos SET status = ?, respondido_em = ?, resposta = ?, enviado_em = COALESCE(enviado_em, ?) WHERE id = ?')
      .run(sucesso ? 'confirmado' : 'falhou', agora(), resposta ? String(resposta).slice(0, 500) : null, agora(), id);
    if (sucesso && (c.tipo === 'bloquear' || c.tipo === 'desbloquear')) {
      db.prepare('UPDATE veiculos SET bloqueado = ? WHERE id = ?').run(c.tipo === 'bloquear' ? 1 : 0, c.veiculo_id);
    }
    // Corte do modo roubo: a ocorrência acompanha a resposta (carregado aqui para não haver dependência circular).
    require('./roubo').aoResponder(db, c, sucesso, resposta);
    // Consultas do equipamento (STATUS#, PARAM#, CXZT): os campos lidos vão para a ficha do rastreador.
    if (resposta && /^(STATUS#|PARAM#|CXZT)$/i.test(c.texto)) {
      const lido = require('./equipamento').lerResposta(resposta);
      if (Object.keys(lido).length) {
        const r = db.prepare('SELECT saude FROM rastreadores WHERE id = ?').get(c.rastreador_id);
        const saude = { ...(r?.saude ? JSON.parse(r.saude) : {}), ...lido };
        db.prepare('UPDATE rastreadores SET saude = ?, saude_em = ?, firmware = COALESCE(?, firmware) WHERE id = ?')
          .run(JSON.stringify(saude), agora(), lido.firmware ?? null, c.rastreador_id);
      }
    }
    return true;
  });
}

/** O aparelho aceitou, mas só vai executar depois (GPS fixo e velocidade baixa). */
function respostaAdiada(texto) { return /will be executed|be executed after|after gps|aguard|ser[aá] executad/i.test(String(texto ?? '')); }

/**
 * A resposta do aparelho em português claro, para o operador (a resposta crua continua guardada e aparece pequena embaixo).
 * Ex.: "Battery:4.22V;GPRS:Online;GSM Signal Level:26;ACC:OFF;GPS:Successful positioning" →
 * "Bateria 4,2 V · internet ligada · sinal 26 de 31 · ignição desligada · GPS com posição".
 */
function explicarResposta(c) {
  const t = String(c.resposta ?? '').trim();
  const situacao = {
    pendente: 'Esperando o rastreador conectar para enviar.',
    enviado: 'Enviado. Esperando a resposta do rastreador.',
    cancelado: 'Cancelado: não foi enviado.',
    expirado: 'Sem resposta do rastreador no prazo.',
  };
  if (!t) return situacao[c.status] ?? (c.status === 'confirmado' ? 'Confirmado pelo rastreador.' : 'O rastreador não respondeu.');
  if (/^Confirmado pelo estado|^(Corte|Desbloqueio) executado/.test(t)) return t;
  if (c.status === 'falhou' || !respostaSucesso(t)) return `O rastreador recusou o comando: "${t.slice(0, 80)}".`;
  if (c.tipo === 'bloquear' || c.tipo === 'desbloquear') {
    if (respostaAdiada(t) && c.status !== 'confirmado') return 'O rastreador aceitou: corta assim que tiver GPS e estiver abaixo de 20 km/h.';
    return c.tipo === 'bloquear' ? 'Bloqueio confirmado pelo rastreador.' : 'Desbloqueio confirmado pelo rastreador.';
  }
  const s = require('./equipamento').lerResposta(t);
  const partes = [];
  if (s.bateria_v) partes.push(`bateria ${s.bateria_v.toFixed(1).replace('.', ',')} V`);
  if (s.gprs) partes.push(/online|link ?up|ok/i.test(s.gprs) ? 'internet ligada' : 'internet desligada');
  if (s.sinal !== undefined) partes.push(`sinal ${s.sinal} de 31${s.sinal < 10 ? ' (fraco)' : ''}`);
  if (s.acc) partes.push(/on/i.test(s.acc) ? 'ignição ligada' : 'ignição desligada');
  if (s.gps) partes.push(/success|ok|fix|on/i.test(s.gps) && !/^off$/i.test(s.gps) ? 'GPS com posição' : 'GPS sem posição');
  if (s.timer) partes.push(`posição a cada ${s.timer[0]} s ligado e ${s.timer[1] >= 60 ? `${Math.round(s.timer[1] / 60)} min` : `${s.timer[1]} s`} desligado`);
  const srv = t.match(/SERVER\s*:\s*\d\s*,\s*([\w.-]+)\s*,\s*(\d+)/i);
  if (s.servidor || srv) partes.push(`servidor ${s.servidor ?? `${srv[1]}:${srv[2]}`}`);
  const apn = t.match(/APN\s*:\s*([\w.-]+)/i);
  if (apn) partes.push(`APN ${apn[1]}`);
  if (s.firmware) partes.push(`versão ${s.firmware}`);
  if (partes.length) { const x = partes.join(' · '); return x[0].toUpperCase() + x.slice(1) + '.'; }
  const pos = t.match(/Lat\s*:\s*([NS]?-?[\d.]+).*?Lon\s*:\s*([EW]?-?[\d.]+)/i);
  if (pos) return `Posição enviada pelo rastreador (${pos[1]}, ${pos[2]}).`;
  if (/reset|restart|reboot/i.test(t)) return 'O rastreador está reiniciando (volta em cerca de 1 minuto).';
  if (/^(ok|success|set ok|.*\bok\b.*)$/i.test(t)) return 'Ajuste aceito pelo rastreador.';
  return `Resposta do rastreador: "${t.slice(0, 80)}".`;
}

/** Resposta de texto do equipamento: falha quando fala em erro; senão, confirmado. */
const respostaSucesso = (texto) => !/fail|error|erro|invalid|inv[aá]lid|unknown|not ?support|unsupport|wrong|denied|refus|recusad|失败|错误/i.test(String(texto ?? ''));

/** Comandos sem resposta dentro do prazo expiram. */
function expirar(db, horas) {
  const corte = new Date(Date.now() - horas * 3_600_000).toISOString();
  return db.prepare("UPDATE comandos SET status = 'expirado', respondido_em = ? WHERE status IN ('pendente','enviado') AND criado_em < ?").run(agora(), corte).changes;
}

module.exports = { TIPOS, MODELOS, modeloDe, canal, criar, pendentes, marcarEnviado, responder, respostaSucesso, respostaAdiada, expirar, explicarResposta };
