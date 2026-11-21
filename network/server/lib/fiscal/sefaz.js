'use strict';

const https = require('node:https');
const zlib = require('node:zlib');
const { ErroNegocio } = require('../erros');
const t = require('./tabelas');
const x = require('./xml');

/*
 * Conversa com a SEFAZ.
 *
 * O QUE ESTÁ CONFIRMADO no manual (MOC NFCom, Visão Geral, 3.1 a 3.4):
 *   - SOAP 1.2, estilo Document/Literal, SEM cabeçalho SOAP;
 *   - a recepção é SÍNCRONA, uma nota por vez, sem lote;
 *   - na recepção, o XML vai COMPACTADO em GZip e codificado em Base64;
 *   - no evento, o XML vai sem compactação;
 *   - TLS 1.2 com autenticação mútua: o certificado A1 do provedor identifica quem transmite.
 *
 * O QUE NÃO ESTÁ CONFIRMADO, e por que: os nomes exatos dos elementos do envelope e seus namespaces
 * saem do WSDL de cada serviço, e o WSDL não pôde ser lido do ambiente onde este código foi escrito —
 * os servidores da SEFAZ apresentam certificado da cadeia ICP-Brasil, que não está no conjunto padrão
 * de autoridades. Os valores em SERVICOS seguem a convenção da família de documentos fiscais
 * eletrônicos, e são CONFIGURÁVEIS justamente porque não foram conferidos na fonte.
 *
 * Isso tem consequência prática e ela está no código: se a SEFAZ devolver uma falha SOAP reclamando de
 * elemento desconhecido, a mensagem de erro diz que o nome do envelope pode estar errado e manda conferir
 * o WSDL, em vez de deixar o operador diante de um erro que não explica nada. A primeira transmissão em
 * homologação é o que fecha essa lacuna — e é exatamente para isso que existe o ambiente de homologação.
 */

/* Nome do elemento de mensagem e namespace do WSDL, por serviço. Ajustáveis por variável de ambiente. */
const SERVICOS = {
  recepcao: { elemento: 'nfcomDadosMsg', ns: 'http://www.portalfiscal.inf.br/nfcom/wsdl/NFComRecepcao', comprime: true },
  consulta: { elemento: 'nfcomDadosMsg', ns: 'http://www.portalfiscal.inf.br/nfcom/wsdl/NFComConsulta', comprime: false },
  evento: { elemento: 'nfcomDadosMsg', ns: 'http://www.portalfiscal.inf.br/nfcom/wsdl/NFComRecepcaoEvento', comprime: false },
  status: { elemento: 'nfcomDadosMsg', ns: 'http://www.portalfiscal.inf.br/nfcom/wsdl/NFComStatusServico', comprime: false },
};

const NS_SOAP12 = 'http://www.w3.org/2003/05/soap-envelope';
const TIMEOUT_MS = Number(process.env.NETWORK_SEFAZ_TIMEOUT_MS) || 60_000;

/*
 * Cadeia de autoridades para validar o SERVIDOR da SEFAZ. Os servidores da SEFAZ são assinados pela
 * ICP-Brasil, que não vem na lista padrão do sistema operacional nem do Node. Quem instalar aponta
 * NETWORK_SEFAZ_CA para o arquivo da cadeia. Sem isso, a conexão falha na validação — e falhar é o
 * certo: desligar a validação significaria aceitar qualquer servidor que se diga a SEFAZ.
 */
const caConfigurada = () => {
  const caminho = process.env.NETWORK_SEFAZ_CA;
  if (!caminho) return null;
  try { return require('node:fs').readFileSync(caminho); } catch { return null; }
};

/** O envelope SOAP 1.2, sem cabeçalho, como o manual determina. */
function envelope(servico, conteudo) {
  const s = SERVICOS[servico];
  return x.documento(
    `<soap12:Envelope xmlns:soap12="${NS_SOAP12}"><soap12:Body>`
    + `<${s.elemento} xmlns="${s.ns}">${conteudo}</${s.elemento}>`
    + '</soap12:Body></soap12:Envelope>',
  );
}

/** Extrai o conteúdo de uma tag do retorno. Basta para ler cStat, xMotivo e nProt. */
function pegar(xml, tag) {
  const m = new RegExp(`<(?:\\w+:)?${tag}>([\\s\\S]*?)</(?:\\w+:)?${tag}>`).exec(String(xml ?? ''));
  return m ? m[1].trim() : null;
}

/** Extrai um bloco inteiro com as tags, para guardar o protocolo como veio. */
function pegarBloco(xml, tag) {
  const m = new RegExp(`<(?:\\w+:)?${tag}[\\s>][\\s\\S]*?</(?:\\w+:)?${tag}>`).exec(String(xml ?? ''));
  return m ? m[0] : null;
}

/** O endereço do serviço, ou uma recusa que diz por que não há endereço. */
function endereco(cfg, servico) {
  // Endereço informado pelo provedor tem precedência: é o caminho para as UFs que autorizam sozinhas.
  if (cfg.urls) {
    try {
      const proprios = JSON.parse(cfg.urls);
      if (proprios?.[servico]) return String(proprios[servico]);
    } catch { /* JSON inválido cai no caminho normal, e o erro aparece lá */ }
  }
  const autorizador = t.AUTORIZADORES[cfg.autorizador];
  if (!autorizador) throw new ErroNegocio(`Autorizador "${cfg.autorizador}" desconhecido.`, 422);
  if (!autorizador.confirmado) {
    throw new ErroNegocio(`${autorizador.nome} autoriza a NFCom por conta própria, e o endereço do serviço dele não `
      + 'consta das fontes oficiais que este sistema leu. Peça o endereço à SEFAZ e configure-o antes de transmitir — '
      + 'inventar um endereço mandaria a nota para lugar nenhum.', 422);
  }
  const url = autorizador[cfg.ambiente]?.[servico];
  if (!url) throw new ErroNegocio(`Sem endereço para o serviço "${servico}" em ${t.TP_AMB[cfg.ambiente]}.`, 422);
  return url;
}

/**
 * Envia e devolve o corpo da resposta.
 *
 * O certificado vai como identidade do cliente (TLS mútua). `ca` permite informar a cadeia ICP-Brasil
 * quando o ambiente não a tiver: o servidor da SEFAZ é assinado por ela, e sem a cadeia a conexão falha
 * na validação — o que não é motivo para desligar a validação.
 */
function enviar(url, corpo, { pfx, passphrase, ca = null, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const alvo = new URL(url);
    const dados = Buffer.from(corpo, 'utf8');
    const req = https.request({
      hostname: alvo.hostname,
      port: alvo.port || 443,
      path: alvo.pathname + alvo.search,
      method: 'POST',
      pfx,
      passphrase,
      ...(ca ? { ca } : {}),
      minVersion: 'TLSv1.2',
      headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8',
        'Content-Length': dados.length,
      },
      timeout,
    }, (res) => {
      const pedacos = [];
      res.on('data', (d) => pedacos.push(d));
      res.on('end', () => resolve({ status: res.statusCode, corpo: Buffer.concat(pedacos).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(new Error(`A SEFAZ não respondeu em ${Math.round(timeout / 1000)} segundos.`)); });
    req.on('error', reject);
    req.end(dados);
  });
}

/** Traduz a falha de rede ou de TLS numa frase que diz o que fazer. */
function traduzirFalha(err) {
  const m = String(err?.message ?? err);
  if (/UNABLE_TO_(GET|VERIFY)|SELF_SIGNED|unable to (get|verify)/i.test(m)) {
    return 'Não foi possível validar o certificado do servidor da SEFAZ. Os servidores da SEFAZ usam a cadeia '
      + 'ICP-Brasil, que não vem na lista padrão de autoridades: instale a cadeia ICP-Brasil nesta máquina '
      + '(ou aponte NODE_EXTRA_CA_CERTS para ela) e tente de novo.';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return 'O endereço da SEFAZ não resolveu. Confira a saída de rede deste servidor.';
  if (/ECONNREFUSED|ECONNRESET|EPIPE/i.test(m)) return 'A SEFAZ recusou ou derrubou a conexão. Costuma ser indisponibilidade do serviço; tente de novo.';
  if (/não respondeu em/i.test(m)) return m;
  if (/alert|handshake|SSL|TLS/i.test(m)) {
    return `Falha no handshake TLS com a SEFAZ (${m}). Em geral é o certificado de transmissão: confira se o A1 `
      + 'instalado é o da empresa credenciada e se ainda está no prazo.';
  }
  return `Falha ao falar com a SEFAZ: ${m}`;
}

/**
 * Lê o retorno: devolve sempre `{ cStat, xMotivo, ... }`, ou uma recusa legível.
 *
 * O caso que esta função existe para tratar: a SEFAZ devolve uma falha SOAP em vez do retorno esperado.
 * Quando a falha fala de elemento desconhecido, o problema quase certamente é o nome do envelope — e a
 * mensagem diz isso, porque esse é o ponto do código que não pôde ser conferido contra o WSDL.
 */
function lerRetorno(resposta) {
  const { status, corpo } = resposta;
  const falha = pegarBloco(corpo, 'Fault');
  if (falha) {
    const texto = pegar(falha, 'Text') ?? pegar(falha, 'faultstring') ?? falha.slice(0, 300);
    if (/element|elemento|not recognized|unexpected|unknown/i.test(texto)) {
      throw new ErroNegocio(`A SEFAZ recusou o envelope: "${texto}". O nome do elemento ou o namespace do envelope `
        + 'pode estar diferente do WSDL deste autorizador. Baixe o WSDL do serviço e ajuste em lib/fiscal/sefaz.js.', 502);
    }
    throw new ErroNegocio(`A SEFAZ devolveu uma falha SOAP: ${texto}`, 502);
  }
  if (status >= 400) throw new ErroNegocio(`A SEFAZ respondeu HTTP ${status}.`, 502);

  const cStat = pegar(corpo, 'cStat');
  if (!cStat) throw new ErroNegocio('A SEFAZ respondeu, mas sem o código de situação (cStat). Resposta guardada para conferência.', 502);
  return {
    cStat,
    xMotivo: pegar(corpo, 'xMotivo'),
    nProt: pegar(corpo, 'nProt'),
    chNFCom: pegar(corpo, 'chNFCom'),
    dhRecbto: pegar(corpo, 'dhRecbto'),
    protocolo: pegarBloco(corpo, 'protNFCom') ?? pegarBloco(corpo, 'retEvento'),
    corpo,
  };
}

/** Chama um serviço: monta o envelope, envia e lê. */
async function chamar(servico, cfg, conteudo, credenciais) {
  const url = endereco(cfg, servico);
  const ca = credenciais?.ca ?? caConfigurada();
  const s = SERVICOS[servico];
  const carga = s.comprime ? zlib.gzipSync(Buffer.from(conteudo, 'utf8')).toString('base64') : conteudo;
  let resposta;
  try {
    resposta = await enviar(url, envelope(servico, carga), { ...credenciais, ...(ca ? { ca } : {}) });
  } catch (err) {
    throw new ErroNegocio(traduzirFalha(err), 502);
  }
  return { ...lerRetorno(resposta), url };
}

/** Consulta se o serviço está no ar. É o teste de conexão mais barato que existe. */
const statusServico = (cfg, credenciais) => chamar('status', cfg, x.documento(
  x.grupo('consStatServNFCom', [
    x.tag('tpAmb', cfg.ambiente),
    x.tag('xServ', 'STATUS'),
  ], { attrs: { xmlns: t.NAMESPACE, versao: t.VERSAO_LEIAUTE } }),
), credenciais);

/** Consulta uma nota pela chave. */
const consultarChave = (cfg, chave, credenciais) => chamar('consulta', cfg, x.documento(
  x.grupo('consSitNFCom', [
    x.tag('tpAmb', cfg.ambiente),
    x.tag('xServ', 'CONSULTAR'),
    x.tag('chNFCom', chave),
  ], { attrs: { xmlns: t.NAMESPACE, versao: t.VERSAO_LEIAUTE } }),
), credenciais);

module.exports = {
  SERVICOS, NS_SOAP12, envelope, pegar, pegarBloco, endereco, enviar, lerRetorno, caConfigurada,
  chamar, statusServico, consultarChave, traduzirFalha,
};
