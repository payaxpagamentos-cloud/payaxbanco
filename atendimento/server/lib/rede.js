'use strict';

const net = require('node:net');
const dns = require('node:dns');
const { ErroNegocio } = require('./erros');

/**
 * Para onde a plataforma aceita fazer chamadas em nome de uma empresa (ferramentas da ZOE, IXC).
 *
 * Quem cadastra a URL é o administrador da empresa: sem esta trava, ele poderia apontar a
 * "ferramenta" para o próprio servidor da ZOE (whisper, painel interno), para a rede do provedor de
 * nuvem (169.254.169.254 entrega credenciais da máquina) ou para a rede interna, e ler a resposta
 * pelo botão de teste. Loopback, link-local, multicast e os disfarces em IPv6 (::ffff:127.0.0.1,
 * NAT64) ficam sempre bloqueados; faixas privadas (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7)
 * só com ATEND_REDE_INTERNA=1 — para o IXC instalado na rede do próprio provedor.
 */

// Uma lista por família: o BlockList do Node casa IPv4 com regras de IPv4 mapeado em IPv6, e a regra
// "::ffff:0:0/96" numa lista só bloquearia todo IPv4 da internet.
const lista = (faixas, tipo) => { const l = new net.BlockList(); for (const [ip, bits] of faixas) l.addSubnet(ip, bits, tipo); return l; };
const sempre4 = lista([['0.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['192.0.0.0', 24], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]], 'ipv4');
// ::/96 cobre :: e ::1; 64:ff9b::/96 é NAT64; fe80::/10 link-local; ff00::/8 multicast.
const sempre6 = lista([['::', 96], ['64:ff9b::', 96], ['fe80::', 10], ['ff00::', 8]], 'ipv6');
const privadas4 = lista([['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10]], 'ipv4');
const privadas6 = lista([['fc00::', 7]], 'ipv6');

/** "::ffff:7f00:1" ou "::ffff:127.0.0.1" → "127.0.0.1" (o disfarce comum para passar por IPv6). */
function ipv4Mapeado(ip) {
  const m = ip.toLowerCase().match(/^::ffff:(?:0:)?(.+)$/);
  if (!m) return null;
  if (net.isIPv4(m[1])) return m[1];
  const g = m[1].split(':');
  if (g.length !== 2 || !g.every((x) => /^[0-9a-f]{1,4}$/.test(x))) return null;
  const [a, b] = g.map((x) => parseInt(x, 16));
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

const permitirInterna = () => process.env.ATEND_REDE_INTERNA === '1';

/** O IP cai numa faixa proibida? */
function ipBloqueado(ip, { interna = permitirInterna() } = {}) {
  if (!net.isIP(ip)) return true;
  const v4 = net.isIPv4(ip) ? ip : ipv4Mapeado(ip);
  if (v4) return sempre4.check(v4, 'ipv4') || (!interna && privadas4.check(v4, 'ipv4'));
  return sempre6.check(ip, 'ipv6') || (!interna && privadas6.check(ip, 'ipv6'));
}

const modulo = {
  /** Resolve o nome em todos os IPs. Trocável nos testes (os hosts de teste não existem no DNS). */
  resolver: (host) => dns.promises.lookup(host, { all: true, verbatim: true }),
};

/**
 * Confere a URL antes de a plataforma chamar: https, e nenhum IP do nome em faixa proibida.
 * Use junto com `redirect: 'error'` no fetch — senão um redirecionamento leva para onde quiser.
 */
async function validarDestino(url, { interna = permitirInterna(), oQue = 'O endereço' } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new ErroNegocio(`${oQue} não é uma URL válida.`, 422); }
  if (u.protocol !== 'https:') throw new ErroNegocio(`${oQue} precisa começar com https://.`, 422);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let ips;
  if (net.isIP(host)) ips = [host];
  else {
    try { ips = (await modulo.resolver(host)).map((x) => x.address); } catch { throw new ErroNegocio(`${oQue} não foi encontrado (DNS): ${host}.`, 422); }
  }
  if (!ips.length || ips.some((ip) => ipBloqueado(ip, { interna }))) {
    throw new ErroNegocio(`${oQue} aponta para a rede interna, que a plataforma não acessa por segurança.`
      + (interna ? '' : ' Se o sistema fica na rede do provedor, o administrador do servidor pode liberar com ATEND_REDE_INTERNA=1.'), 422);
  }
  return u;
}

modulo.validarDestino = validarDestino;
modulo.ipBloqueado = ipBloqueado;
module.exports = modulo;
