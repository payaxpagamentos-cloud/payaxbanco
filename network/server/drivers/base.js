'use strict';

const net = require('node:net');
const crypto = require('node:crypto');
const config = require('../config');

/*
 * Base dos drivers de equipamento.
 *
 * O contrato é o mesmo para todo fabricante. O que muda de um para outro é o driver, e o que um driver
 * não sabe fazer ele declara em `capacidades` — o sistema recusa a ação com o motivo em vez de fingir
 * que executou. É isso que permite acrescentar fabricante sem tocar no núcleo.
 *
 * CONTRATO (todos os métodos recebem `ctx` com { equipamento, credencial, pedir, log }):
 *   identificar(ctx)                     -> { modelo, versao, detalhe }        confirma alcance e credencial
 *   ler(ctx, servico)                    -> { presente, situacao, ... }        estado real, como o equipamento conta
 *   aplicar(ctx, servico, desejado)      -> { mudancas: [...] }                cria ou ajusta o acesso
 *   cortar(ctx, servico, { motivo })     -> { mudancas: [...] }                derruba e impede reconexão
 *   religar(ctx, servico)                -> { mudancas: [...] }
 *   remover(ctx, servico)                -> { mudancas: [...] }                contrato cancelado
 *   configurarWifi(ctx, servico, wifi)   -> { mudancas: [...] }                SSID, senha e canal no CPE
 *
 * Em ensaio (dry-run) o driver recebe `ctx.ensaio === true`: ele calcula tudo e descreve as mudanças em
 * `mudancas`, sem escrever no equipamento. Toda tela de ensaio mostra exatamente essa lista.
 */

class ErroEquipamento extends Error {
  constructor(mensagem, estado = 'falha', { permanente = false, status = null, semSuporte = false } = {}) {
    super(mensagem);
    this.estado = estado;
    this.permanente = permanente;
    this.status = status;
    this.semSuporte = semSuporte;
  }
}

/*
 * Endereço de gerência de equipamento. Diferente dos conectores de dados (que falam com a internet e por isso
 * bloqueiam a rede interna), aqui a rede interna é exatamente o lugar onde o equipamento vive: um concentrador
 * em 10.0.0.1 é o caso normal, não um ataque. O que continua barrado é o que apontaria para o próprio servidor
 * ou para fora da rede de gerência: loopback, link-local e multicast. Quem cadastra é o administrador.
 */
function validarHost(host) {
  const h = String(host ?? '').trim().replace(/^\[|\]$/g, '');
  if (!h) throw new ErroEquipamento('Informe o endereço de gerência do equipamento.', 'nao_configurado', { permanente: true });
  if (/[/\\\s]/.test(h)) throw new ErroEquipamento('O endereço é só o host ou IP, sem caminho nem espaços.', 'nao_configurado', { permanente: true });
  if (net.isIP(h)) {
    if (net.isIPv4(h)) {
      const [a, b] = h.split('.').map(Number);
      if (a === 127 && !config.equipamentoLoopback) throw new ErroEquipamento('127.x aponta para o próprio servidor, não para o equipamento. Se o serviço roda mesmo nesta máquina, defina NETWORK_EQUIPAMENTO_LOOPBACK=1.', 'nao_configurado', { permanente: true });
      if (a === 0 || a >= 224) throw new ErroEquipamento('Endereço IPv4 inválido para gerência.', 'nao_configurado', { permanente: true });
      if (a === 169 && b === 254) throw new ErroEquipamento('169.254.x é link-local: o equipamento precisa de um IP de gerência.', 'nao_configurado', { permanente: true });
    } else {
      const x = h.toLowerCase();
      if ((x === '::1' && !config.equipamentoLoopback) || x === '::' || x.startsWith('fe80')) throw new ErroEquipamento('Endereço IPv6 inválido para gerência.', 'nao_configurado', { permanente: true });
    }
    return h;
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(h) || h.length > 253) {
    throw new ErroEquipamento('Endereço de gerência inválido.', 'nao_configurado', { permanente: true });
  }
  if (h.toLowerCase() === 'localhost' && !config.equipamentoLoopback) throw new ErroEquipamento('localhost aponta para o próprio servidor, não para o equipamento.', 'nao_configurado', { permanente: true });
  return h;
}

/** Esconde senha e token em qualquer texto que vá para log, erro ou auditoria. */
function limparSegredo(texto, ...segredos) {
  let t = String(texto ?? '');
  for (const s of segredos) if (s && String(s).length >= 3) t = t.split(String(s)).join('«oculto»');
  return t.replace(/("?(?:password|senha|secret|token|key)"?\s*[:=]\s*)("[^"]*"|\S+)/gi, '$1«oculto»').slice(0, 500);
}

/**
 * Chamada HTTP(S) ao equipamento.
 *
 * Usa node:http(s) direto em vez de fetch porque a conferência de TLS precisa ser decidida POR EQUIPAMENTO:
 * certificado autoassinado é o normal em OLT e concentrador, e desligar a conferência global (a variável de
 * ambiente) deixaria sem verificação qualquer outra conexão que acontecesse ao mesmo tempo no servidor.
 * Aqui a opção vai na requisição, e só nela.
 */
function http(ctx, { metodo = 'GET', caminho, corpo = null, aceita = 'application/json' }) {
  const { equipamento } = ctx;
  const host = validarHost(equipamento.host);
  const seguro = equipamento.protocolo ? equipamento.protocolo === 'https' : equipamento.porta !== 80;
  const transporte = seguro ? require('node:https') : require('node:http');
  const dados = corpo === null ? null : Buffer.from(JSON.stringify(corpo));
  const cabecalhos = { Accept: aceita, 'User-Agent': 'ManagerNetwork/1.0' };
  if (equipamento.usuario) cabecalhos.Authorization = `Basic ${Buffer.from(`${equipamento.usuario}:${ctx.credencial ?? ''}`).toString('base64')}`;
  if (dados) { cabecalhos['Content-Type'] = 'application/json'; cabecalhos['Content-Length'] = dados.length; }

  return new Promise((resolver, rejeitar) => {
    const req = transporte.request({
      host, port: equipamento.porta || (seguro ? 443 : 80), path: caminho, method: metodo, headers: cabecalhos,
      timeout: config.equipamentoTimeoutMs,
      ...(seguro ? { rejectUnauthorized: Boolean(equipamento.verificar_tls), servername: net.isIP(host) ? undefined : host } : {}),
    }, (resp) => {
      const partes = [];
      let tamanho = 0;
      resp.on('data', (p) => {
        tamanho += p.length;
        // Resposta descomunal costuma ser a página de login do equipamento, não a API: corta e explica.
        if (tamanho > 8_000_000) { req.destroy(); rejeitar(new ErroEquipamento('O equipamento respondeu um corpo grande demais para uma chamada de gerência.', 'incompativel', { permanente: true })); return; }
        partes.push(p);
      });
      resp.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        const status = resp.statusCode;
        if (status === 401 || status === 403) {
          rejeitar(new ErroEquipamento(`O equipamento recusou a credencial (HTTP ${status}). Confira usuário e senha de gerência.`, 'sem_permissao', { permanente: true, status }));
          return;
        }
        if (status === 404) { resolver({ status, dados: null }); return; }
        if (status >= 300 && status < 400) {
          rejeitar(new ErroEquipamento(`O equipamento redirecionou (HTTP ${status}); confira o endereço e a porta da API.`, 'incompativel', { permanente: true, status }));
          return;
        }
        if (status >= 400) {
          let detalhe = texto;
          try { const j = JSON.parse(texto); detalhe = j.message ?? j.detail ?? j.error ?? texto; } catch { /* resposta não é JSON */ }
          rejeitar(new ErroEquipamento(`O equipamento respondeu HTTP ${status}: ${limparSegredo(detalhe, ctx.credencial)}`, 'falha', { status }));
          return;
        }
        if (!texto) { resolver({ status, dados: null }); return; }
        try { resolver({ status, dados: JSON.parse(texto) }); } catch {
          rejeitar(new ErroEquipamento('O equipamento não respondeu JSON onde o driver esperava JSON. Confira se a API REST está ligada e se o driver é o certo para este modelo.', 'incompativel', { permanente: true }));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new ErroEquipamento(`O equipamento não respondeu em ${config.equipamentoTimeoutMs / 1000} s.`, 'falha')); });
    req.on('error', (err) => {
      if (err instanceof ErroEquipamento) { rejeitar(err); return; }
      const codigo = err.code || err.message;
      if (/CERT|SELF_SIGNED|ALT_NAME|UNABLE_TO_VERIFY/i.test(String(codigo))) {
        rejeitar(new ErroEquipamento('O certificado do equipamento não foi aceito. Desligue a conferência de TLS para este equipamento ou instale um certificado válido nele.', 'falha', { permanente: true }));
        return;
      }
      rejeitar(new ErroEquipamento(`Não foi possível falar com o equipamento (${codigo}).`, 'falha'));
    });
    if (dados) req.write(dados);
    req.end();
  });
}

const novoErroId = () => crypto.randomBytes(5).toString('hex');

module.exports = { ErroEquipamento, validarHost, limparSegredo, http, novoErroId };
