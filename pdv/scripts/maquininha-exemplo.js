'use strict';

/**
 * Exemplo do aplicativo que roda na maquininha (modo "agente").
 *
 * Ele faz três coisas, em repetição:
 *   1. pergunta ao PDV se há cobrança esperando este aparelho;
 *   2. manda passar o cartão (aqui, só simula: troque pelo SDK da adquirente);
 *   3. devolve o resultado ao PDV, com NSU, autorização e bandeira.
 *
 * Uso:
 *   node maquininha-exemplo.js https://SEU-DOMINIO/pdv pdv_<prefixo>_<segredo>
 *
 * Numa maquininha de verdade (Stone, PagBank, Cielo LIO, Mercado Pago, GetNet...),
 * troque `passarCartao` pela chamada do SDK do aparelho e mantenha o resto igual.
 * Guarde a chave no armazenamento seguro do aplicativo: ela vale para esta maquininha.
 */

const [, , enderecoPdv, chave] = process.argv;
if (!enderecoPdv || !chave) {
  console.error('Uso: node maquininha-exemplo.js <endereço do PDV> <chave da maquininha>');
  process.exit(1);
}

const base = `${enderecoPdv.replace(/\/+$/, '')}/api/integracao/terminal`;
const cabecalhos = { 'X-Api-Key': chave, 'Content-Type': 'application/json' };
const INTERVALO_MS = 2000;

/** Troque esta função pela chamada do SDK da maquininha. */
async function passarCartao(cobranca) {
  console.log(`  → passe o cartão: ${(cobranca.valor_centavos / 100).toFixed(2)} em ${cobranca.forma}${cobranca.parcelas > 1 ? ` ${cobranca.parcelas}x` : ''}`);
  await new Promise((r) => setTimeout(r, 3000));
  return {
    status: 'aprovada', // ou 'negada' / 'cancelada'
    nsu: String(Math.floor(Math.random() * 999999)).padStart(6, '0'),
    autorizacao: String(Math.floor(Math.random() * 999999)).padStart(6, '0'),
    bandeira: 'VISA',
    cartao_final: '1234',
    mensagem: 'Transação aprovada',
  };
}

async function umaVolta() {
  const resp = await fetch(`${base}/cobranca`, { headers: cabecalhos });
  if (resp.status === 204) return;
  if (resp.status === 401) throw new Error('Chave da maquininha inválida ou revogada.');
  if (!resp.ok) throw new Error(`O PDV respondeu ${resp.status}.`);
  const cobranca = await resp.json();
  console.log(`Cobrança ${cobranca.referencia}`);

  let resultado;
  try {
    resultado = await passarCartao(cobranca);
  } catch (err) {
    resultado = { status: 'negada', mensagem: String(err.message).slice(0, 200) };
  }
  // Devolve o resultado. Se a maquininha ficar sem rede, repita este POST: o PDV aceita
  // o mesmo resultado de novo (e só recusa se alguém já tiver encerrado a cobrança de outro jeito).
  const envio = await fetch(`${base}/resultado`, {
    method: 'POST', headers: cabecalhos, body: JSON.stringify({ referencia: cobranca.referencia, ...resultado }),
  });
  const dados = await envio.json().catch(() => ({}));
  console.log(`  ← ${envio.ok ? dados.status : `erro ${envio.status}: ${dados.erro ?? ''}`}`);
}

(async () => {
  const quem = await fetch(`${base}`, { headers: cabecalhos });
  if (!quem.ok) {
    console.error(`Não foi possível falar com o PDV (${quem.status}). Confira o endereço e a chave.`);
    process.exit(1);
  }
  const { terminal, empresa } = await quem.json();
  console.log(`Maquininha "${terminal.nome}" (${terminal.adquirente}) de ${empresa.nome}. Esperando cobranças…`);
  for (;;) {
    try {
      await umaVolta();
    } catch (err) {
      console.error(`Falha: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, INTERVALO_MS));
  }
})();
