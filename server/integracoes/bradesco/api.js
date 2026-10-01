'use strict';

/*
 * Cliente da API PIX do Bradesco (conta PJ PAY AX).
 * A cobrança imediata, a consulta de PIX recebidos e o webhook seguem o padrão "API Pix" do Banco Central,
 * comum a todos os bancos. A autenticação usa OAuth2 (client_credentials) com certificado da empresa (mTLS).
 * Confirme URLs, escopos e formato do token no portal Bradesco Developers antes de ir para produção.
 */
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const { centavosParaDecimal, ErroBradesco } = require('./util');

class ApiBradesco {
  constructor(cfg) {
    const faltando = ['tokenUrl', 'pixBaseUrl', 'clientId', 'clientSecret', 'chavePix'].filter((k) => !cfg[k]);
    if (faltando.length) throw new Error(`Integração Bradesco (${cfg.modo}) sem configuração: ${faltando.join(', ')}`);
    this.cfg = cfg;
    this.modo = cfg.modo;
    this.token = null;
    this.expiraEm = 0;
    this.agente = cfg.certificado
      ? new https.Agent({ pfx: fs.readFileSync(cfg.certificado), passphrase: cfg.senhaCertificado, keepAlive: true })
      : undefined;
  }

  requisicao(metodo, url, { corpo, cabecalhos = {} } = {}) {
    const alvo = new URL(url);
    const modulo = alvo.protocol === 'http:' ? http : https;
    const dados = corpo === undefined ? undefined : (typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
    return new Promise((resolve, reject) => {
      const req = modulo.request(alvo, {
        method: metodo,
        agent: alvo.protocol === 'https:' ? this.agente : undefined,
        timeout: 20_000,
        headers: {
          Accept: 'application/json',
          ...(dados ? { 'Content-Type': typeof corpo === 'string' ? 'application/x-www-form-urlencoded' : 'application/json', 'Content-Length': Buffer.byteLength(dados) } : {}),
          ...cabecalhos,
        },
      }, (res) => {
        let texto = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { texto += c; });
        res.on('end', () => {
          let json = null;
          try { json = texto ? JSON.parse(texto) : null; } catch { /* resposta não JSON */ }
          if (res.statusCode >= 400) {
            const msg = json?.detail || json?.title || json?.message || json?.error_description || `HTTP ${res.statusCode}`;
            return reject(new ErroBradesco(`Bradesco: ${msg}`, res.statusCode === 404 ? 404 : 502, json));
          }
          resolve(json);
        });
      });
      req.on('timeout', () => req.destroy(new ErroBradesco('Bradesco não respondeu a tempo.', 504)));
      req.on('error', (e) => reject(e instanceof ErroBradesco ? e : new ErroBradesco(`Falha de conexão com o Bradesco: ${e.message}`, 502)));
      if (dados) req.write(dados);
      req.end();
    });
  }

  async obterToken() {
    if (this.token && Date.now() < this.expiraEm) return this.token;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    const r = await this.requisicao('POST', this.cfg.tokenUrl, {
      corpo: 'grant_type=client_credentials',
      cabecalhos: { Authorization: `Basic ${basic}` },
    });
    this.token = r.access_token;
    this.expiraEm = Date.now() + Math.max(30, (r.expires_in ?? 300) - 60) * 1000;
    return this.token;
  }

  async pix(metodo, caminho, corpo) {
    const token = await this.obterToken();
    return this.requisicao(metodo, `${this.cfg.pixBaseUrl.replace(/\/$/, '')}${caminho}`, { corpo, cabecalhos: { Authorization: `Bearer ${token}` } });
  }

  async criarCobranca({ txid, valorCentavos, expiracaoSegundos, solicitacao }) {
    const r = await this.pix('PUT', `/cob/${txid}`, {
      calendario: { expiracao: expiracaoSegundos },
      valor: { original: centavosParaDecimal(valorCentavos) },
      chave: this.cfg.chavePix,
      solicitacaoPagador: solicitacao?.slice(0, 140),
    });
    return { txid: r.txid, status: r.status, pixCopiaECola: r.pixCopiaECola };
  }

  async consultarCobranca(txid) { return this.pix('GET', `/cob/${txid}`); }

  async pixRecebidos({ inicio, fim = new Date() }) {
    const todos = [];
    for (let pagina = 0; pagina < 50; pagina++) {
      const q = new URLSearchParams({ inicio: inicio.toISOString(), fim: fim.toISOString(), 'paginacao.paginaAtual': String(pagina) });
      const r = await this.pix('GET', `/pix?${q}`);
      todos.push(...(r?.pix ?? []));
      if (!r?.parametros?.paginacao || pagina + 1 >= r.parametros.paginacao.quantidadeDePaginas) break;
    }
    return todos;
  }

  async configurarWebhook(url) { return this.pix('PUT', `/webhook/${encodeURIComponent(this.cfg.chavePix)}`, { webhookUrl: url }); }

  // Envio de PIX, saldo e extrato usam APIs próprias do Bradesco (fora do padrão do Banco Central).
  // Serão implementados com a documentação técnica recebida no credenciamento.
  async enviarPix() { throw new ErroBradesco('Envio de PIX pelo Bradesco ainda não habilitado: aguardando a documentação da API de pagamentos.', 501); }
  async saldo() { throw new ErroBradesco('Consulta de saldo pelo Bradesco ainda não habilitada: aguardando a documentação da API de extrato.', 501); }
  async extrato() { throw new ErroBradesco('Extrato do Bradesco ainda não habilitado: aguardando a documentação da API de extrato.', 501); }
}

module.exports = { ApiBradesco };
