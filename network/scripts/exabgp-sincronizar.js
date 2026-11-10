'use strict';

/*
 * Ponte entre o Manager Network e o ExaBGP do provedor. O ExaBGP roda este script como "process" e lê os comandos que ele
 * escreve na saída padrão (API de texto). O script consulta os anúncios ativos a cada 5 s e escreve só as diferenças:
 * "announce ..." para cada ação nova e "withdraw ..." para cada ação retirada.
 *
 * Configuração do ExaBGP (exemplo):
 *   process manager-network {
 *     run /usr/bin/node /opt/manager-network/scripts/exabgp-sincronizar.js;
 *     encoder text;
 *   }
 *   neighbor 10.0.0.1 { router-id 10.0.0.10; local-address 10.0.0.10; local-as 65000; peer-as 65000;
 *     family { ipv4 unicast; ipv6 unicast; ipv4 flow; ipv6 flow; }
 *     api { processes [ manager-network ]; } }
 *
 * Variáveis: NETWORK_URL (ex.: https://seu-dominio/network), NETWORK_BGP_TOKEN (token do coletor com escopo "bgp"),
 * INTERVALO_S (padrão 5), FALHA_RETIRAR_MIN (padrão 30).
 *
 * Segurança: se o Manager Network ficar inacessível, os anúncios atuais são mantidos (um ataque em andamento continua
 * bloqueado); depois de FALHA_RETIRAR_MIN minutos sem resposta, todos são retirados, para nenhum bloqueio ficar esquecido.
 */

const url = String(process.env.NETWORK_URL || '').replace(/\/+$/, '');
const token = process.env.NETWORK_BGP_TOKEN;
const intervalo = (Number(process.env.INTERVALO_S) || 5) * 1000;
const falhaRetirarMs = (Number(process.env.FALHA_RETIRAR_MIN) || 30) * 60_000;
if (!url || !token) {
  process.stderr.write('Defina NETWORK_URL e NETWORK_BGP_TOKEN (token do coletor com escopo bgp).\n');
  process.exit(1);
}

const anunciados = new Map(); // linha de anúncio → linha de retirada
let ultimoSucesso = Date.now();
const log = (m) => process.stderr.write(`[manager-network] ${new Date().toISOString()} ${m}\n`);
const escrever = (linha) => process.stdout.write(`${linha}\n`);

async function ciclo() {
  try {
    const r = await fetch(`${url}/api/coletor/bgp`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { anuncios } = await r.json();
    ultimoSucesso = Date.now();
    const atuais = new Map(anuncios.map((a) => [a.anunciar, a.retirar]));
    for (const [anuncio, retirada] of anunciados) {
      if (!atuais.has(anuncio)) { escrever(retirada); anunciados.delete(anuncio); log(`retirado: ${anuncio}`); }
    }
    for (const [anuncio, retirada] of atuais) {
      if (!anunciados.has(anuncio)) { escrever(anuncio); anunciados.set(anuncio, retirada); log(`anunciado: ${anuncio}`); }
    }
  } catch (err) {
    log(`falha ao consultar: ${err.message}`);
    if (anunciados.size && Date.now() - ultimoSucesso > falhaRetirarMs) {
      log(`sem resposta há mais de ${falhaRetirarMs / 60_000} min: retirando ${anunciados.size} anúncio(s) por segurança`);
      for (const retirada of anunciados.values()) escrever(retirada);
      anunciados.clear();
    }
  }
}

ciclo();
setInterval(ciclo, intervalo);
