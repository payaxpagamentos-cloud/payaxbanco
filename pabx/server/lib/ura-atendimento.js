'use strict';

const uraLib = require('./ura');
const { ErroNegocio } = require('./erros');

/**
 * Liga a URA inteligente ao mundo: lê o IXC, lê os alertas de rede e devolve o roteiro
 * que a central telefônica vai falar.
 *
 * Os alertas de rede NÃO moram aqui. Eles são cadastrados no ZOE Atende, que é onde a equipe
 * declara a falha, e são lidos pela API de integração dele. Guardar uma cópia no PABX criaria
 * duas verdades sobre a mesma falha — e, no dia em que divergissem, a ZOE do WhatsApp e a do
 * telefone contariam histórias diferentes para o mesmo cliente.
 */

/** Alertas de rede que pegam este cliente, lidos do ZOE Atende. Falha na leitura não derruba a ligação. */
async function alertasDoCliente(cfg, { documento = null, clienteId = null }, { buscar = fetch, prazoMs = 4000 } = {}) {
  if (!cfg?.alertas_url || !cfg?.alertas_chave) return [];
  const parar = AbortSignal.timeout(prazoMs);
  const q = new URLSearchParams();
  if (documento) q.set('documento', documento);
  if (clienteId) q.set('cliente', clienteId);
  try {
    const r = await buscar(`${String(cfg.alertas_url).replace(/\/+$/, '')}/api/integracao/alertas?${q}`, {
      headers: { 'X-Api-Key': cfg.alertas_chave }, signal: parar,
    });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d?.alertas) ? d.alertas : [];
  } catch {
    // A URA continua: sem alerta ela só deixa de dizer que já sabe da falha, o resto funciona.
    return [];
  }
}

/**
 * Atende a chegada da ligação numa URA inteligente.
 *
 * `ixc` é o cliente já pronto (ou null quando a integração está desligada). Sem IXC, a URA
 * inteligente se comporta como a clássica, em vez de deixar a ligação no vazio.
 */
async function atender(db, empresa, ura, { telefone = null, cfg = null, ixc = null, hoje = undefined } = {}) {
  if (ura.tipo !== 'inteligente' || !ixc) {
    return { ...uraLib.abertura(ura, { identificado: false, situacoes: [] }), ura: { id: ura.id, nome: ura.nome }, identificado: false };
  }

  let cliente = null;
  try {
    const achados = telefone ? await ixc.clientesPorTelefone(telefone) : [];
    // Mais de um cadastro no mesmo telefone: não dá para adivinhar de quem é a ligação.
    if (achados.length === 1) [cliente] = achados;
  } catch {
    cliente = null;
  }

  if (!cliente) {
    return { ...uraLib.abertura(ura, { identificado: false, situacoes: [] }), ura: { id: ura.id, nome: ura.nome }, identificado: false };
  }

  const dados = await lerSituacao(cliente, { cfg, ixc });
  const situacoes = uraLib.detectar(dados, hoje ? { hoje } : {});
  return {
    ...uraLib.abertura(ura, { identificado: true, situacoes }),
    ura: { id: ura.id, nome: ura.nome },
    identificado: true,
    // O id do cliente volta para a central guardar na ligação; nome e contrato só depois de confirmar.
    cliente_id: String(cliente.id),
    situacoes: situacoes.map((s) => s.chave),
  };
}

/** Tudo o que define a situação do cliente, lido em paralelo. Um recurso que falhar não derruba os outros. */
async function lerSituacao(cliente, { cfg, ixc }) {
  const tentar = async (fn) => { try { return await fn(); } catch { return []; } };
  const [contratos, faturas, logins, alertas] = await Promise.all([
    tentar(() => ixc.contratos(cliente.id)),
    tentar(() => ixc.faturasAbertas(cliente.id)),
    tentar(() => (ixc.logins ? ixc.logins(cliente.id) : [])),
    alertasDoCliente(cfg, { documento: cliente.cnpj_cpf ?? null, clienteId: String(cliente.id) }),
  ]);
  return { contratos, faturas, logins, alertas };
}

/** Depois que a central confirmou a identidade: o roteiro que pode falar do contrato. */
async function aposConfirmar(db, empresa, ura, { clienteId, cfg = null, ixc = null, hoje = undefined } = {}) {
  if (!ixc) throw new ErroNegocio('A integração com o IXC não está ligada.');
  const cliente = await ixc.clientePorId(clienteId);
  if (!cliente) throw new ErroNegocio('Cliente não encontrado no IXC.');
  const dados = await lerSituacao(cliente, { cfg, ixc });
  const situacoes = uraLib.detectar(dados, hoje ? { hoje } : {});
  const nome = String(cliente.razao ?? cliente.fantasia ?? '').trim().split(/\s+/)[0] || null;
  return {
    ...uraLib.aposConfirmar(ura, { situacoes, primeiroNome: nome }),
    ura: { id: ura.id, nome: ura.nome },
    situacoes: situacoes.map((s) => s.chave),
  };
}

module.exports = { atender, aposConfirmar, alertasDoCliente, lerSituacao };
