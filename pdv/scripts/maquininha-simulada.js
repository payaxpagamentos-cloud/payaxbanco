'use strict';

/**
 * Maquininha de mentira: responde às cobranças do PDV como se fosse o aparelho, para você testar o balcão
 * e o totem antes de a maquininha de verdade chegar (ou para treinar a equipe sem passar cartão).
 *
 *   node scripts/maquininha-simulada.js <endereço do PDV> <chave da maquininha> [opções]
 *
 * Opções:
 *   --demora 4        segundos "passando o cartão" antes de responder (padrão 4)
 *   --negar           recusa todas as cobranças
 *   --alternar        aprova a primeira, nega a segunda, e assim por diante
 *   --ignorar         não responde nada (para ver a cobrança expirar no PDV)
 *   --nsu 123456      NSU fixo (padrão: sorteado)
 *
 * A chave sai no painel, em Maquininhas. Use só em ambiente de teste: cada cobrança aprovada aqui
 * vira um recebimento de verdade no PDV, com baixa no IXC configurado.
 */

const [, , enderecoPdv, chave, ...resto] = process.argv;
const opcao = (nome, padrao = null) => {
  const i = resto.indexOf(`--${nome}`);
  return i >= 0 ? (resto[i + 1]?.startsWith('--') || resto[i + 1] === undefined ? true : resto[i + 1]) : padrao;
};
const tem = (nome) => resto.includes(`--${nome}`);

if (!enderecoPdv || !chave) {
  console.error('Uso: node scripts/maquininha-simulada.js <endereço do PDV> <chave da maquininha> [--demora 4] [--negar] [--alternar] [--ignorar]');
  process.exit(1);
}

const base = `${enderecoPdv.replace(/\/+$/, '')}/api/integracao/terminal`;
const cabecalhos = { 'X-Api-Key': chave, 'Content-Type': 'application/json' };
const demoraMs = Math.max(0, Number(opcao('demora', 4)) * 1000);
const bandeiras = ['VISA', 'MASTERCARD', 'ELO', 'HIPERCARD'];
const sorteio = (lista) => lista[Math.floor(Math.random() * lista.length)];
const numero = (n) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');
const reais = (c) => `R$ ${((c ?? 0) / 100).toFixed(2).replace('.', ',')}`;
let atendidas = 0;

async function responder(cobranca) {
  atendidas += 1;
  const negar = tem('negar') || (tem('alternar') && atendidas % 2 === 0);
  console.log(`  ${cobranca.forma}${cobranca.parcelas > 1 ? ` ${cobranca.parcelas}x` : ''} · ${reais(cobranca.valor_centavos)} · ref ${cobranca.referencia}`);
  if (tem('ignorar')) return console.log('  (ignorando, como se a maquininha tivesse travado)');
  await new Promise((r) => setTimeout(r, demoraMs));
  const corpo = negar
    ? { referencia: cobranca.referencia, status: 'negada', mensagem: 'Cartão recusado pelo emissor (simulação)' }
    : { referencia: cobranca.referencia, status: 'aprovada', nsu: String(opcao('nsu', numero(6))), autorizacao: numero(6), bandeira: sorteio(bandeiras), cartao_final: numero(4) };
  const resp = await fetch(`${base}/resultado`, { method: 'POST', headers: cabecalhos, body: JSON.stringify(corpo) });
  const dados = await resp.json().catch(() => ({}));
  console.log(resp.ok ? `  → ${dados.status}${dados.nsu ? ` · NSU ${dados.nsu}` : ''}` : `  → erro ${resp.status}: ${dados.erro ?? ''}`);
}

(async () => {
  const quem = await fetch(base, { headers: cabecalhos }).catch(() => null);
  if (!quem?.ok) {
    console.error(`Não foi possível falar com o PDV (${quem?.status ?? 'sem conexão'}). Confira o endereço e a chave.`);
    process.exit(1);
  }
  const { terminal, empresa } = await quem.json();
  console.log(`Maquininha simulada "${terminal.nome}" (${terminal.adquirente}) de ${empresa.nome}.`);
  console.log(`Respondendo em ${demoraMs / 1000}s · ${tem('ignorar') ? 'sem responder' : tem('negar') ? 'negando tudo' : tem('alternar') ? 'aprova/nega alternado' : 'aprovando tudo'}. Ctrl+C para parar.\n`);
  for (;;) {
    try {
      const r = await fetch(`${base}/cobranca`, { headers: cabecalhos });
      if (r.status === 200) await responder(await r.json());
      else if (r.status === 401) throw new Error('chave inválida ou revogada');
    } catch (err) {
      console.error(`Falha: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
})();
