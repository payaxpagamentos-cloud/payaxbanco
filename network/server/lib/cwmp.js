'use strict';

const { ErroNegocio } = require('./erros');

/*
 * CWMP (TR-069): o SOAP que o roteador do assinante fala.
 *
 * Aqui não há biblioteca de XML de propósito. O endpoint do ACS é PÚBLICO — quem chega nele é um aparelho
 * na casa do assinante, e qualquer um pode mandar o que quiser para ele. Um analisador genérico aceitaria
 * entidades externas, recursão e documentos gigantes; este lê só o punhado de elementos que o protocolo usa,
 * com tamanho limitado e sem seguir nada que o documento mande seguir.
 *
 * O que é tratado:
 *   recebe  Inform, SetParameterValuesResponse, GetParameterValuesResponse, RebootResponse, Fault
 *   envia   InformResponse, SetParameterValues, GetParameterValues, Reboot, FactoryReset
 */

const TAMANHO_MAXIMO = 512 * 1024;
const MAXIMO_PARAMETROS = 2000;

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Texto de XML para texto puro. Entidade desconhecida fica como veio, em vez de virar outra coisa. */
function decodificar(s) {
  return String(s ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (inteiro, corpo) => {
    if (corpo[0] === '#') {
      const n = corpo[1] === 'x' || corpo[1] === 'X' ? Number.parseInt(corpo.slice(2), 16) : Number.parseInt(corpo.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : inteiro;
    }
    return ENTIDADES[corpo.toLowerCase()] ?? inteiro;
  });
}

/** Texto puro para XML. Tudo que vai para o aparelho passa por aqui. */
const codificar = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' }[c]};`);

/**
 * Confere que o corpo é um envelope SOAP que dá para tratar, antes de olhar o conteúdo.
 * DOCTYPE e ENTITY são recusados de saída: é por aí que um XML vira leitura de arquivo do servidor.
 */
function conferir(xml) {
  const t = String(xml ?? '');
  if (t.length > TAMANHO_MAXIMO) throw new ErroNegocio('Envelope grande demais.', 413);
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(t)) throw new ErroNegocio('Envelope recusado: declaração não permitida.', 400);
  // Esta conferência continua tolerante de propósito: é só a triagem de "parece um envelope".
  if (!/<(\w+:)?Envelope[\s>]/i.test(t)) throw new ErroNegocio('Não é um envelope SOAP.', 400);
  return t;
}

/*
 * Conteúdo do primeiro elemento com este nome local (ignorando o prefixo de namespace).
 *
 * A busca é SENSÍVEL A MAIÚSCULAS porque XML é. E não é detalhe: numa falha, o SOAP usa <faultcode> e o
 * CWMP usa <FaultCode> dentro do detalhe — ignorar a caixa faria o sistema ler "Client" no lugar do código
 * que explica de verdade por que o aparelho recusou.
 */
function conteudo(xml, nome) {
  const m = new RegExp(`<(?:\\w+:)?${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${nome}>`).exec(xml);
  return m ? m[1] : null;
}

/** Texto do primeiro elemento com este nome local, já decodificado. */
function valor(xml, nome) {
  const c = conteudo(xml, nome);
  if (c === null) return null;
  // Elemento que contém outros elementos não é um valor de texto.
  return /<[a-z]/i.test(c) ? null : decodificar(c.trim());
}

/** Nome local do primeiro elemento dentro do Body: é ele que diz qual mensagem chegou. */
function mensagem(xml) {
  const corpo = conteudo(xml, 'Body');
  if (!corpo) return null;
  const m = /<(?:(\w+):)?([A-Za-z][\w.]*)(?:\s[^>]*)?(?:\/>|>)/.exec(corpo);
  return m ? m[2] : null;
}

/** Lista de pares nome/valor de um ParameterList (ParameterValueStruct). */
function parametros(xml) {
  const lista = [];
  const re = /<(?:\w+:)?ParameterValueStruct(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?ParameterValueStruct>/g;
  let m;
  while ((m = re.exec(xml)) !== null && lista.length < MAXIMO_PARAMETROS) {
    const nome = valor(m[1], 'Name');
    if (nome) lista.push({ nome, valor: valor(m[1], 'Value') ?? '' });
  }
  return lista;
}

/** Eventos do Inform (2 PERIODIC, 0 BOOTSTRAP, 6 CONNECTION REQUEST...). */
function eventos(xml) {
  const bloco = conteudo(xml, 'Event');
  if (!bloco) return [];
  return [...bloco.matchAll(/<(?:\w+:)?EventCode(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?EventCode>/g)]
    .map((m) => decodificar(m[1].trim())).filter(Boolean).slice(0, 16);
}

/** O Inform inteiro, já traduzido para o que o sistema guarda. */
function lerInform(xml) {
  const corpo = conteudo(xml, 'Inform') ?? xml;
  const id = conteudo(corpo, 'DeviceId') ?? conteudo(corpo, 'DeviceID') ?? '';
  const lista = parametros(corpo);
  const porNome = (sufixo) => lista.find((p) => p.nome.endsWith(sufixo))?.valor ?? null;
  const raiz = lista.find((p) => p.nome.startsWith('Device.')) ? 'tr181'
    : lista.find((p) => p.nome.startsWith('InternetGatewayDevice.')) ? 'tr098' : null;
  return {
    serial: valor(id, 'SerialNumber'),
    oui: valor(id, 'OUI'),
    classe: valor(id, 'ProductClass'),
    fabricante: valor(id, 'Manufacturer'),
    eventos: eventos(corpo),
    modelo_dados: raiz,
    url_chamado: porNome('ManagementServer.ConnectionRequestURL'),
    usuario_chamado: porNome('ManagementServer.ConnectionRequestUsername'),
    modelo: porNome('DeviceInfo.ModelName') ?? porNome('.ProductClass'),
    versao_firmware: porNome('DeviceInfo.SoftwareVersion'),
    ip: porNome('.ExternalIPAddress') ?? porNome('.IPAddress'),
    parametros: lista,
  };
}

/** Pares nome/valor de um GetParameterValuesResponse. */
const lerParametros = (xml) => parametros(conteudo(xml, 'GetParameterValuesResponse') ?? xml);

/** Status de um SetParameterValuesResponse: 0 = aplicado na hora, 1 = aplicado depois de reiniciar. */
const lerStatus = (xml) => Number(valor(conteudo(xml, 'SetParameterValuesResponse') ?? xml, 'Status') ?? 0);

/** Falha devolvida pelo aparelho (o código do CWMP explica mais que o do SOAP). */
function lerFalha(xml) {
  const corpo = conteudo(xml, 'Fault');
  if (!corpo) return null;
  const detalhe = conteudo(corpo, 'FaultStruct') ?? corpo;
  return {
    codigo: valor(detalhe, 'FaultCode') ?? valor(corpo, 'faultcode') ?? '?',
    mensagem: valor(detalhe, 'FaultString') ?? valor(corpo, 'faultstring') ?? 'Falha sem descrição.',
  };
}

// ---------------- Envelopes enviados ao aparelho ----------------

const ENVELOPE = (id, corpo) => `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<soapenv:Header><cwmp:ID soapenv:mustUnderstand="1">${codificar(id)}</cwmp:ID></soapenv:Header>
<soapenv:Body>${corpo}</soapenv:Body></soapenv:Envelope>`;

/** Resposta ao Inform. MaxEnvelopes é sempre 1 no CWMP 1.0. */
const informResponse = (id) => ENVELOPE(id, '<cwmp:InformResponse><MaxEnvelopes>1</MaxEnvelopes></cwmp:InformResponse>');

/** Tipo do parâmetro para o aparelho não recusar o valor (senha e SSID são texto; canal é inteiro). */
const tipoDe = (v) => (typeof v === 'number' ? 'xsd:unsignedInt' : typeof v === 'boolean' ? 'xsd:boolean' : 'xsd:string');

function setParameterValues(id, pares, chave = `mn-${Date.now()}`) {
  const itens = pares.map(({ nome, valor: v }) =>
    `<ParameterValueStruct><Name>${codificar(nome)}</Name><Value xsi:type="${tipoDe(v)}">${codificar(v)}</Value></ParameterValueStruct>`).join('');
  return ENVELOPE(id, `<cwmp:SetParameterValues><ParameterList soapenv:arrayType="cwmp:ParameterValueStruct[${pares.length}]">${itens}</ParameterList>`
    + `<ParameterKey>${codificar(chave)}</ParameterKey></cwmp:SetParameterValues>`);
}

function getParameterValues(id, nomes) {
  const itens = nomes.map((n) => `<string>${codificar(n)}</string>`).join('');
  return ENVELOPE(id, `<cwmp:GetParameterValues><ParameterNames soapenv:arrayType="xsd:string[${nomes.length}]">${itens}</ParameterNames></cwmp:GetParameterValues>`);
}

const reboot = (id, chave = `mn-${Date.now()}`) => ENVELOPE(id, `<cwmp:Reboot><CommandKey>${codificar(chave)}</CommandKey></cwmp:Reboot>`);
const factoryReset = (id) => ENVELOPE(id, '<cwmp:FactoryReset></cwmp:FactoryReset>');

module.exports = { TAMANHO_MAXIMO, conferir, mensagem, valor, conteudo, parametros, eventos, decodificar, codificar,
  lerInform, lerParametros, lerStatus, lerFalha, informResponse, setParameterValues, getParameterValues, reboot, factoryReset };
