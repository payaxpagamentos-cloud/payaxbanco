'use strict';

const crypto = require('node:crypto');
const { agora } = require('../db');
const { ErroNegocio } = require('./erros');
const { cifrar, decifrar } = require('./cripto');
const { validarHost } = require('../drivers/base');
const config = require('./../config');
const cwmp = require('./cwmp');

/*
 * ACS: o lado do servidor da conversa com o roteador do assinante.
 *
 * Quem liga é o CPE. O sistema não "configura o Wi-Fi agora": ele guarda o pedido e, para não esperar a
 * próxima ligação (que pode demorar horas), bate na porta do aparelho pedindo que ele ligue já. Se o aparelho
 * não atender — assinante com o roteador desligado, CGNAT sem porta aberta —, o pedido continua guardado e é
 * aplicado no primeiro contato. A tela diz qual dos dois aconteceu, em vez de prometer.
 *
 * "Entregue" é o ACS ter mandado o comando. Só "concluída" é o aparelho ter confirmado. Nenhuma tela diz
 * "Wi-Fi alterado" antes da confirmação.
 */

/*
 * Os dois dialetos de parâmetro que os CPEs falam. O aparelho diz qual é o dele no primeiro Inform
 * (quem começa a árvore com "Device." é TR-181; com "InternetGatewayDevice." é TR-098).
 */
const MODELOS = {
  tr098: {
    raiz: 'InternetGatewayDevice',
    wlan: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1',
    ssid: (w) => `${w}.SSID`,
    senha: (w) => `${w}.PreSharedKey.1.KeyPassphrase`,
    canal: (w) => `${w}.Channel`,
    ligado: (w) => `${w}.Enable`,
    leitura: [
      'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
      'InternetGatewayDevice.DeviceInfo.UpTime',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Channel',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations',
    ],
  },
  tr181: {
    raiz: 'Device',
    wlan: 'Device.WiFi',
    ssid: () => 'Device.WiFi.SSID.1.SSID',
    senha: () => 'Device.WiFi.AccessPoint.1.Security.KeyPassphrase',
    canal: () => 'Device.WiFi.Radio.1.Channel',
    ligado: () => 'Device.WiFi.SSID.1.Enable',
    leitura: [
      'Device.DeviceInfo.SoftwareVersion',
      'Device.DeviceInfo.UpTime',
      'Device.WiFi.SSID.1.SSID',
      'Device.WiFi.Radio.1.Channel',
      'Device.WiFi.SSID.1.Enable',
      'Device.WiFi.AccessPoint.1.AssociatedDeviceNumberOfEntries',
    ],
  },
};

const modeloDe = (cpe) => MODELOS[cpe?.modelo_dados ?? 'tr098'] ?? MODELOS.tr098;

/* Onde fica a credencial que o ACS usa para bater na porta do aparelho. */
const PARAM_CHAMADO = {
  tr098: { usuario: 'InternetGatewayDevice.ManagementServer.ConnectionRequestUsername', senha: 'InternetGatewayDevice.ManagementServer.ConnectionRequestPassword' },
  tr181: { usuario: 'Device.ManagementServer.ConnectionRequestUsername', senha: 'Device.ManagementServer.ConnectionRequestPassword' },
};

/**
 * Garante que o ACS consegue fazer o aparelho ligar agora.
 *
 * O CPE informa o ENDEREÇO e o USUÁRIO da chamada no Inform, mas nunca a senha: ela é de escrita, e quem a
 * define é o ACS. Sem definir, "aplicar agora" nunca funcionaria — o aparelho responderia 401 a toda chamada
 * e tudo ficaria esperando o Inform periódico, que pode levar horas.
 *
 * Então, na primeira conversa, o sistema sorteia uma senha, manda gravar no aparelho e guarda cifrada.
 * Se a gravação falhar, a senha guardada é descartada e tudo é tentado de novo no próximo contato.
 */
function garantirChamado(db, org, cpe) {
  if (cpe.senha_chamado_cifrada) return null;
  const senha = crypto.randomBytes(12).toString('base64url');
  const usuario = cpe.usuario_chamado || 'acs';
  const p = PARAM_CHAMADO[cpe.modelo_dados ?? 'tr098'] ?? PARAM_CHAMADO.tr098;
  db.prepare('UPDATE cpes SET usuario_chamado = ?, senha_chamado_cifrada = ? WHERE id = ?').run(usuario, cifrar(senha), cpe.id);
  return enfileirar(db, { org, cpeId: cpe.id, rpc: 'SetParameterValues', origem: 'sistema',
    parametros: { chamado: true, pares: [{ nome: p.usuario, valor: usuario }, { nome: p.senha, valor: senha }] },
    descricao: 'Credencial de chamada do ACS (é o que permite aplicar mudanças na hora)' });
}

/** A gravação da credencial de chamada falhou: esquece a senha guardada para tentar de novo depois. */
const esquecerChamado = (db, cpeId) => db.prepare('UPDATE cpes SET senha_chamado_cifrada = NULL WHERE id = ?').run(cpeId);

/** Parâmetros a escrever para deixar o Wi-Fi como pedido. O que não foi informado não é tocado. */
function parametrosWifi(cpe, { ssid, senha, canal, ligado }) {
  const m = modeloDe(cpe);
  const w = m.wlan;
  const pares = [];
  if (ssid) pares.push({ nome: m.ssid(w), valor: ssid });
  if (senha) pares.push({ nome: m.senha(w), valor: senha });
  if (canal !== null && canal !== undefined && canal !== '') pares.push({ nome: m.canal(w), valor: Number(canal) });
  if (ligado !== undefined) pares.push({ nome: m.ligado(w), valor: Boolean(ligado) });
  return pares;
}

/** Aparelho sem nada de segredo, para API e tela. */
function publico(cpe) {
  if (!cpe) return null;
  const { senha_chamado_cifrada: s, ...resto } = cpe;
  return { ...resto, chamado_configurado: Boolean(s && resto.url_chamado), parametros: resto.parametros ? JSON.parse(resto.parametros) : null };
}

// ---------------- Registro do aparelho ----------------

/** Grava (ou atualiza) o aparelho a partir do que ele contou no Inform. */
function registrar(db, org, dados, { ip, senhaChamado = null } = {}) {
  if (!dados.serial) throw new ErroNegocio('Inform sem número de série.', 400);
  const existente = db.prepare('SELECT * FROM cpes WHERE organizacao_id = ? AND serial = ?').get(org, dados.serial);
  const t = agora();
  const evento = dados.eventos.join(' ');
  if (existente) {
    db.prepare(`UPDATE cpes SET oui = COALESCE(?, oui), classe = COALESCE(?, classe), fabricante = COALESCE(?, fabricante),
      modelo = COALESCE(?, modelo), versao_firmware = COALESCE(?, versao_firmware), modelo_dados = COALESCE(?, modelo_dados),
      url_chamado = COALESCE(?, url_chamado), usuario_chamado = COALESCE(?, usuario_chamado), ip = COALESCE(?, ip),
      senha_chamado_cifrada = COALESCE(?, senha_chamado_cifrada), ultimo_contato = ?, ultimo_evento = ?, informs = informs + 1 WHERE id = ?`)
      .run(dados.oui, dados.classe, dados.fabricante, dados.modelo, dados.versao_firmware, dados.modelo_dados, dados.url_chamado,
        dados.usuario_chamado, dados.ip ?? ip, senhaChamado ? cifrar(senhaChamado) : null, t, evento, existente.id);
    return db.prepare('SELECT * FROM cpes WHERE id = ?').get(existente.id);
  }
  // Aparelho novo: se o serial já está num serviço, o vínculo com o contrato nasce feito.
  const servico = db.prepare('SELECT id FROM servicos WHERE organizacao_id = ? AND cpe_serial = ?').get(org, dados.serial);
  const id = Number(db.prepare(`INSERT INTO cpes (organizacao_id, serial, oui, classe, fabricante, modelo, versao_firmware, modelo_dados,
    url_chamado, usuario_chamado, senha_chamado_cifrada, ip, servico_id, ultimo_contato, ultimo_evento, informs, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
    .run(org, dados.serial, dados.oui, dados.classe, dados.fabricante, dados.modelo, dados.versao_firmware, dados.modelo_dados,
      dados.url_chamado, dados.usuario_chamado, senhaChamado ? cifrar(senhaChamado) : null, dados.ip ?? ip, servico?.id ?? null, t, evento, t).lastInsertRowid);
  return db.prepare('SELECT * FROM cpes WHERE id = ?').get(id);
}

/** Guarda o retrato dos parâmetros lidos, juntando com o que já se sabia. */
function guardarParametros(db, cpeId, pares) {
  const atual = db.prepare('SELECT parametros FROM cpes WHERE id = ?').get(cpeId);
  const mapa = { ...(atual?.parametros ? JSON.parse(atual.parametros) : {}) };
  for (const p of pares) mapa[p.nome] = p.valor;
  db.prepare('UPDATE cpes SET parametros = ?, lido_em = ? WHERE id = ?').run(JSON.stringify(mapa), agora(), cpeId);
  return mapa;
}

// ---------------- Fila por aparelho ----------------

function enfileirar(db, { org, cpeId, rpc, parametros = null, descricao = null, origem = 'usuario', usuarioId = null }) {
  const id = Number(db.prepare(`INSERT INTO cpe_tarefas (organizacao_id, cpe_id, rpc, parametros, descricao, origem, usuario_id, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(org, cpeId, rpc, parametros ? JSON.stringify(parametros) : null, descricao, origem, usuarioId, agora()).lastInsertRowid);
  return db.prepare('SELECT * FROM cpe_tarefas WHERE id = ?').get(id);
}

const proximaTarefa = (db, cpeId) => db.prepare("SELECT * FROM cpe_tarefas WHERE cpe_id = ? AND situacao = 'pendente' ORDER BY id LIMIT 1").get(cpeId);

/** Monta o envelope da tarefa. O ID do CWMP é o id da tarefa: a resposta do aparelho se correlaciona sozinha. */
function envelopeDa(cpe, tarefa) {
  const id = `t${tarefa.id}`;
  const p = tarefa.parametros ? JSON.parse(tarefa.parametros) : {};
  if (tarefa.rpc === 'SetParameterValues') return cwmp.setParameterValues(id, p.pares ?? [], `mn-${tarefa.id}`);
  if (tarefa.rpc === 'GetParameterValues') return cwmp.getParameterValues(id, p.nomes ?? modeloDe(cpe).leitura);
  if (tarefa.rpc === 'Reboot') return cwmp.reboot(id, `mn-${tarefa.id}`);
  if (tarefa.rpc === 'FactoryReset') return cwmp.factoryReset(id);
  throw new ErroNegocio(`RPC não implementada: ${tarefa.rpc}.`, 500);
}

const marcarEntregue = (db, id) => db.prepare("UPDATE cpe_tarefas SET situacao = 'entregue', entregue_em = ?, tentativas = tentativas + 1 WHERE id = ?").run(agora(), id);
const marcarConcluida = (db, id, resultado) => db.prepare("UPDATE cpe_tarefas SET situacao = 'concluida', resultado = ?, erro = NULL, concluido_em = ? WHERE id = ?")
  .run(JSON.stringify(resultado ?? {}), agora(), id);
const marcarFalha = (db, id, erro) => db.prepare("UPDATE cpe_tarefas SET situacao = 'falhou', erro = ?, concluido_em = ? WHERE id = ?").run(String(erro).slice(0, 300), agora(), id);

/** Tarefa entregue e sem resposta por tempo demais volta para a fila: a sessão do aparelho caiu no meio. */
function devolverEntreguesParadas(db, { minutos = 10 } = {}) {
  const corte = new Date(Date.now() - minutos * 60_000).toISOString();
  return db.prepare(`UPDATE cpe_tarefas SET situacao = CASE WHEN tentativas >= 4 THEN 'falhou' ELSE 'pendente' END,
    erro = CASE WHEN tentativas >= 4 THEN 'O aparelho não confirmou depois de 4 tentativas.' ELSE erro END
    WHERE situacao = 'entregue' AND entregue_em < ?`).run(corte).changes;
}

// ---------------- Bater na porta do aparelho (Connection Request) ----------------

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

/** Cabeçalho Digest da segunda tentativa, a partir do desafio que o aparelho mandou no 401. */
function respostaDigest({ desafio, usuario, senha, metodo, uri }) {
  const campos = Object.fromEntries([...desafio.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g)].map((m) => [m[1].toLowerCase(), m[2] ?? m[3]]));
  const qop = (campos.qop ?? '').split(',').map((x) => x.trim()).includes('auth') ? 'auth' : null;
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = '00000001';
  const ha1 = md5(`${usuario}:${campos.realm ?? ''}:${senha}`);
  const ha2 = md5(`${metodo}:${uri}`);
  const resposta = qop ? md5(`${ha1}:${campos.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${campos.nonce}:${ha2}`);
  const partes = [`username="${usuario}"`, `realm="${campos.realm ?? ''}"`, `nonce="${campos.nonce ?? ''}"`, `uri="${uri}"`, `response="${resposta}"`];
  if (campos.opaque) partes.push(`opaque="${campos.opaque}"`);
  if (qop) partes.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${partes.join(', ')}`;
}

/**
 * Pede ao aparelho que abra sessão agora. Devolve { atendeu, motivo }: não atender é comum e não é erro —
 * roteador desligado, assinante atrás de CGNAT sem porta aberta, firewall. O pedido continua na fila.
 */
async function chamar(db, cpe) {
  if (!cpe.url_chamado) return { atendeu: false, motivo: 'O aparelho não informou endereço de chamada; o pedido vale no próximo contato dele.' };
  let url;
  try {
    url = new URL(cpe.url_chamado);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocolo');
    validarHost(url.hostname);
  } catch {
    return { atendeu: false, motivo: 'O endereço de chamada informado pelo aparelho não é utilizável.' };
  }
  const usuario = cpe.usuario_chamado ?? '';
  const senha = cpe.senha_chamado_cifrada ? decifrar(cpe.senha_chamado_cifrada) : '';
  const caminho = `${url.pathname}${url.search}`;

  const tentar = (autorizacao) => new Promise((resolver) => {
    const transporte = require(url.protocol === 'https:' ? 'node:https' : 'node:http');
    const req = transporte.request({
      host: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: caminho, method: 'GET',
      headers: { 'User-Agent': 'ManagerProvedor-ACS/1.0', ...(autorizacao ? { Authorization: autorizacao } : {}) },
      timeout: config.acsChamadoTimeoutMs,
      ...(url.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
    }, (resp) => {
      resp.resume();
      resolver({ status: resp.statusCode, desafio: resp.headers['www-authenticate'] ?? null });
    });
    req.on('timeout', () => { req.destroy(); resolver({ status: 0, erro: 'tempo esgotado' }); });
    req.on('error', (e) => resolver({ status: 0, erro: e.code || e.message }));
    req.end();
  });

  let r = await tentar(null);
  if (r.status === 401 && r.desafio && /digest/i.test(r.desafio)) {
    r = await tentar(respostaDigest({ desafio: r.desafio, usuario, senha, metodo: 'GET', uri: caminho }));
  } else if (r.status === 401 && r.desafio) {
    r = await tentar(`Basic ${Buffer.from(`${usuario}:${senha}`).toString('base64')}`);
  }
  // O TR-069 manda o CPE responder 200 (ou 204) e abrir a sessão logo depois.
  if (r.status === 200 || r.status === 204) return { atendeu: true };
  if (r.status === 401) return { atendeu: false, motivo: 'O aparelho recusou a credencial de chamada. O pedido fica guardado para o próximo contato dele.' };
  if (r.status === 0) return { atendeu: false, motivo: `Não foi possível alcançar o aparelho (${r.erro}). O pedido fica guardado para o próximo contato dele.` };
  return { atendeu: false, motivo: `O aparelho respondeu HTTP ${r.status} à chamada. O pedido fica guardado para o próximo contato dele.` };
}

// ---------------- Sessões em andamento ----------------

/*
 * Uma sessão CWMP dura segundos e serve só para saber de qual aparelho é o POST seguinte (que chega vazio).
 * Fica em memória de propósito: reiniciar o servidor no meio de uma sessão apenas faz o aparelho tentar de novo.
 */
const sessoes = new Map();
const TTL_SESSAO = 5 * 60_000;

function abrirSessao(cpeId, org) {
  const id = crypto.randomBytes(16).toString('hex');
  sessoes.set(id, { cpeId, org, em: Date.now() });
  if (sessoes.size > 5000) for (const [k, v] of sessoes) if (Date.now() - v.em > TTL_SESSAO) sessoes.delete(k);
  return id;
}
function lerSessao(id) {
  const s = sessoes.get(id);
  if (!s) return null;
  if (Date.now() - s.em > TTL_SESSAO) { sessoes.delete(id); return null; }
  s.em = Date.now();
  return s;
}
const fecharSessao = (id) => sessoes.delete(id);

module.exports = { MODELOS, PARAM_CHAMADO, modeloDe, garantirChamado, esquecerChamado, parametrosWifi, publico, registrar, guardarParametros, enfileirar, proximaTarefa, envelopeDa,
  marcarEntregue, marcarConcluida, marcarFalha, devolverEntreguesParadas, chamar, respostaDigest, abrirSessao, lerSessao, fecharSessao };
