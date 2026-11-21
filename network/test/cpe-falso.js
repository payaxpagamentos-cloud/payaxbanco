'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

/*
 * CPE de mentira para os testes: fala CWMP como um roteador de verdade.
 *
 * Ele faz o que o TR-069 manda o aparelho fazer, e é isso que torna o teste útil: LIGA para o ACS (o ACS
 * nunca liga para ele por SOAP), manda o Inform, depois um POST vazio, responde cada comando e encerra no 204.
 * Também sobe o servidor do Connection Request com autenticação Digest, para o "bate na porta" ser exercitado.
 *
 * O que ele NÃO é: um emulador de firmware. Ele guarda os parâmetros num objeto e responde o que o ACS pede.
 */
function criarCpeFalso({ serial = 'CPE0001ABC', oui = '00AABB', fabricante = 'Exemplo', modelo = 'RX-1200',
  firmware = '1.4.2', modeloDados = 'tr098', usuarioChamado: usuarioInicial = 'acs', senhaChamado = 'chamada-secreta' } = {}) {
  let usuarioChamado = usuarioInicial;
  const raiz = modeloDados === 'tr181' ? 'Device' : 'InternetGatewayDevice';
  const wlan = modeloDados === 'tr181' ? 'Device.WiFi' : 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1';
  const nomeSsid = modeloDados === 'tr181' ? 'Device.WiFi.SSID.1.SSID' : `${wlan}.SSID`;
  const nomeSenha = modeloDados === 'tr181' ? 'Device.WiFi.AccessPoint.1.Security.KeyPassphrase' : `${wlan}.PreSharedKey.1.KeyPassphrase`;
  const nomeCanal = modeloDados === 'tr181' ? 'Device.WiFi.Radio.1.Channel' : `${wlan}.Channel`;
  const nomeLigado = modeloDados === 'tr181' ? 'Device.WiFi.SSID.1.Enable' : `${wlan}.Enable`;

  const parametros = {
    [`${raiz}.DeviceInfo.SoftwareVersion`]: firmware,
    [`${raiz}.DeviceInfo.UpTime`]: '86400',
    [nomeSsid]: 'WIFI-ANTIGO',
    [nomeSenha]: 'senha-antiga',
    [nomeCanal]: '6',
    [nomeLigado]: 'true',
  };
  const recebidos = [];
  let reiniciou = 0;
  let falharProximoSet = false;
  let servidorChamado = null;
  let portaChamado = 0;
  // A senha da chamada é de escrita: começa vazia e passa a valer quando o ACS a grava, como no aparelho real.
  let senhaChamadoAtual = senhaChamado;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const env = (id, corpo) => `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soapenv:Header><cwmp:ID soapenv:mustUnderstand="1">${esc(id)}</cwmp:ID></soapenv:Header><soapenv:Body>${corpo}</soapenv:Body></soapenv:Envelope>`;
  const tag = (xml, nome) => new RegExp(`<(?:\\w+:)?${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${nome}>`, 'i').exec(xml)?.[1] ?? null;

  function informXml(evento, urlChamado) {
    const lista = [
      [`${raiz}.DeviceInfo.SoftwareVersion`, firmware],
      [`${raiz}.ManagementServer.ConnectionRequestURL`, urlChamado],
      [`${raiz}.ManagementServer.ConnectionRequestUsername`, usuarioChamado],
      [`${raiz}.DeviceInfo.ModelName`, modelo],
    ];
    const itens = lista.map(([n, v]) => `<ParameterValueStruct><Name>${esc(n)}</Name><Value xsi:type="xsd:string">${esc(v ?? '')}</Value></ParameterValueStruct>`).join('');
    return env('1', `<cwmp:Inform><DeviceId><Manufacturer>${esc(fabricante)}</Manufacturer><OUI>${esc(oui)}</OUI>`
      + `<ProductClass>${esc(modelo)}</ProductClass><SerialNumber>${esc(serial)}</SerialNumber></DeviceId>`
      + `<Event soapenv:arrayType="cwmp:EventStruct[1]"><EventStruct><EventCode>${esc(evento)}</EventCode><CommandKey></CommandKey></EventStruct></Event>`
      + `<MaxEnvelopes>1</MaxEnvelopes><CurrentTime>${new Date().toISOString()}</CurrentTime><RetryCount>0</RetryCount>`
      + `<ParameterList soapenv:arrayType="cwmp:ParameterValueStruct[${lista.length}]">${itens}</ParameterList></cwmp:Inform>`);
  }

  /** Responde o comando que o ACS mandou, como o firmware responderia. */
  function responder(xml) {
    const id = tag(tag(xml, 'Header') ?? '', 'ID') ?? '1';
    const corpo = tag(xml, 'Body') ?? '';
    const tipo = /<(?:\w+:)?([A-Za-z][\w.]*)(?:\s[^>]*)?>/.exec(corpo)?.[1];
    recebidos.push(tipo);
    if (tipo === 'SetParameterValues') {
      if (falharProximoSet) {
        falharProximoSet = false;
        return env(id, '<soapenv:Fault><faultcode>Client</faultcode><faultstring>CWMP fault</faultstring><detail>'
          + '<cwmp:Fault><FaultCode>9007</FaultCode><FaultString>Invalid parameter value</FaultString></cwmp:Fault></detail></soapenv:Fault>');
      }
      for (const m of corpo.matchAll(/<(?:\w+:)?ParameterValueStruct[^>]*>([\s\S]*?)<\/(?:\w+:)?ParameterValueStruct>/gi)) {
        const nome = tag(m[1], 'Name');
        const valor = tag(m[1], 'Value');
        if (!nome) continue;
        const limpo = String(valor ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
        parametros[nome] = limpo;
        if (/ConnectionRequestPassword$/.test(nome)) senhaChamadoAtual = limpo;
        if (/ConnectionRequestUsername$/.test(nome)) usuarioChamado = limpo;
      }
      return env(id, '<cwmp:SetParameterValuesResponse><Status>0</Status></cwmp:SetParameterValuesResponse>');
    }
    if (tipo === 'GetParameterValues') {
      const nomes = [...corpo.matchAll(/<(?:\w+:)?string>([\s\S]*?)<\/(?:\w+:)?string>/gi)].map((m) => m[1]);
      const itens = nomes.filter((n) => n in parametros)
        .map((n) => `<ParameterValueStruct><Name>${esc(n)}</Name><Value xsi:type="xsd:string">${esc(parametros[n])}</Value></ParameterValueStruct>`).join('');
      return env(id, `<cwmp:GetParameterValuesResponse><ParameterList soapenv:arrayType="cwmp:ParameterValueStruct[${nomes.length}]">${itens}</ParameterList></cwmp:GetParameterValuesResponse>`);
    }
    if (tipo === 'Reboot') { reiniciou += 1; return env(id, '<cwmp:RebootResponse></cwmp:RebootResponse>'); }
    if (tipo === 'FactoryReset') return env(id, '<cwmp:FactoryResetResponse></cwmp:FactoryResetResponse>');
    return env(id, '<soapenv:Fault><faultcode>Client</faultcode><faultstring>unsupported</faultstring></soapenv:Fault>');
  }

  return {
    parametros,
    recebidos,
    get reiniciou() { return reiniciou; },
    falharProximoSet() { falharProximoSet = true; },
    ssid: () => parametros[nomeSsid],
    senhaWifi: () => parametros[nomeSenha],
    canal: () => parametros[nomeCanal],

    /** Sobe o servidor do Connection Request (Digest) e devolve a URL que vai no Inform. */
    async ligarChamado(aoChamar) {
      servidorChamado = http.createServer((req, res) => {
        const autorizacao = req.headers.authorization ?? '';
        if (!/^Digest /i.test(autorizacao)) {
          res.writeHead(401, { 'WWW-Authenticate': `Digest realm="cpe", qop="auth", nonce="${crypto.randomBytes(8).toString('hex')}"` });
          return res.end();
        }
        const campos = Object.fromEntries([...autorizacao.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g)].map((m) => [m[1].toLowerCase(), m[2] ?? m[3]]));
        const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
        const ha1 = md5(`${usuarioChamado}:cpe:${senhaChamadoAtual}`);
        const ha2 = md5(`GET:${campos.uri}`);
        const esperado = campos.qop
          ? md5(`${ha1}:${campos.nonce}:${campos.nc}:${campos.cnonce}:${campos.qop}:${ha2}`)
          : md5(`${ha1}:${campos.nonce}:${ha2}`);
        if (campos.response !== esperado || campos.username !== usuarioChamado) {
          res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="cpe", qop="auth", nonce="x"' });
          return res.end();
        }
        res.writeHead(200).end();
        // Como um CPE de verdade: atendeu a chamada, abre a sessão com o ACS logo depois.
        setImmediate(() => aoChamar?.());
      });
      await new Promise((r) => servidorChamado.listen(0, '127.0.0.1', r));
      portaChamado = servidorChamado.address().port;
      return `http://127.0.0.1:${portaChamado}/cr`;
    },

    /**
     * A conversa inteira, do lado do aparelho: Inform, POST vazio, responde cada comando, para no 204.
     * Devolve quantos comandos recebeu nesta sessão.
     */
    async conversar(urlAcs, { usuario = 'acs', senha = 'senha-do-acs', evento = '2 PERIODIC', urlChamado = null } = {}) {
      const autorizacao = `Basic ${Buffer.from(`${usuario}:${senha}`).toString('base64')}`;
      let cookie = null;
      let comandos = 0;
      const enviar = async (corpo) => {
        const resp = await fetch(urlAcs, {
          method: 'POST',
          headers: { Authorization: autorizacao, 'Content-Type': 'text/xml; charset=utf-8', ...(cookie ? { Cookie: cookie } : {}) },
          body: corpo,
        });
        const definido = resp.headers.get('set-cookie');
        if (definido) cookie = definido.split(';')[0];
        return { status: resp.status, texto: resp.status === 204 ? '' : await resp.text() };
      };
      const cr = urlChamado ?? (portaChamado ? `http://127.0.0.1:${portaChamado}/cr` : null);
      let r = await enviar(informXml(evento, cr));
      if (r.status === 401) return { autorizado: false, comandos: 0 };
      // Depois do InformResponse, o aparelho manda um POST vazio pedindo o que houver.
      r = await enviar('');
      while (r.status === 200 && r.texto) {
        comandos += 1;
        r = await enviar(responder(r.texto));
        if (comandos > 20) break;
      }
      return { autorizado: true, comandos, encerrou: r.status === 204 };
    },

    fechar: () => (servidorChamado ? new Promise((r) => servidorChamado.close(r)) : Promise.resolve()),
  };
}

module.exports = { criarCpeFalso };
