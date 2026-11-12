'use strict';

/**
 * Homologação do IXC: confere, contra o IXC do provedor, tudo o que o PDV precisa — conexão, token,
 * busca de cliente, contratos, faturas em aberto e (se você mandar) a baixa e o estorno de uma fatura de teste.
 *
 * Rode na rede do provedor, com um IXC de HOMOLOGAÇÃO. Nada é gravado no PDV: é só um teste do IXC.
 *
 *   node scripts/homologar-ixc.js <endereço do IXC> <token id:hash> [opções]
 *
 * Opções:
 *   --cpf 529.982.247-25     procura o cliente por CPF/CNPJ (sem isso, pega um cliente qualquer)
 *   --cliente 1234           usa direto o código do cliente no IXC
 *   --baixar 98765           BAIXA esta fatura (use uma fatura de teste!) e confere o resultado
 *   --tipo-recebimento 3     id do tipo de recebimento do IXC usado na baixa
 *   --conta 2                id da conta/caixa do IXC usado na baixa
 *   --estornar               depois da baixa, reabre a fatura (volta ao estado anterior)
 *   --http                   aceita IXC em http:// (só para servidor na rede interna)
 *
 * No fim sai um resumo com o que passou, o que falhou e os NOMES DOS CAMPOS que o seu IXC devolveu —
 * é isso que a gente precisa conferir quando alguma versão do IXC usa nome diferente.
 */

const { criarIxc, ErroIxc } = require('../server/lib/ixc');

const args = process.argv.slice(2);
const opcao = (nome, padrao = null) => {
  const i = args.indexOf(`--${nome}`);
  return i >= 0 ? (args[i + 1]?.startsWith('--') ? true : args[i + 1] ?? true) : padrao;
};
const temOpcao = (nome) => args.includes(`--${nome}`);
const [url, token] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]?.startsWith('--') && args[i - 1] !== '--estornar' && args[i - 1] !== '--http'));

if (!url || !token) {
  console.error('Uso: node scripts/homologar-ixc.js <endereço do IXC> <token id:hash> [--cpf ... | --cliente ...] [--baixar <fatura>] [--estornar]');
  process.exit(1);
}
if (!/^https:\/\//i.test(url) && !temOpcao('http')) {
  console.error('O endereço deve começar com https://. Para um IXC na rede interna, acrescente --http.');
  process.exit(1);
}

const ixc = criarIxc({ url, token, timeoutMs: 15_000 });
const resultados = [];
const reais = (c) => `R$ ${((c ?? 0) / 100).toFixed(2).replace('.', ',')}`;

async function passo(nome, fn) {
  process.stdout.write(`• ${nome}… `);
  try {
    const r = await fn();
    console.log('OK');
    resultados.push([true, nome]);
    return r;
  } catch (err) {
    console.log('FALHOU');
    console.log(`    ${err instanceof ErroIxc ? err.message : err.message}`);
    resultados.push([false, `${nome} — ${err.message}`]);
    return null;
  }
}

(async () => {
  console.log(`\nHomologação do IXC para o PDV\n${'='.repeat(34)}\nEndereço: ${url}\n`);

  await passo('Conexão e token (lista um cliente)', () => ixc.testar());

  let cliente = null;
  if (opcao('cliente')) {
    cliente = await passo(`Cliente pelo código ${opcao('cliente')}`, async () => {
      const c = await ixc.clientePorId(String(opcao('cliente')));
      if (!c) throw new Error('não encontrado');
      return c;
    });
  } else if (opcao('cpf')) {
    cliente = await passo(`Cliente pelo CPF/CNPJ ${opcao('cpf')}`, async () => {
      const lista = await ixc.clientesPorDocumento(String(opcao('cpf')));
      if (!lista.length) throw new Error('nenhum cliente com este CPF/CNPJ (confira se o IXC guarda com pontuação)');
      return lista[0];
    });
  }
  if (cliente) console.log(`    ${cliente.nome} · código ${cliente.id} · doc ${cliente.documento}`);

  if (cliente) {
    const contratos = await passo('Contratos do cliente', () => ixc.contratos(cliente.id));
    for (const c of contratos ?? []) console.log(`    contrato ${c.id} · ${c.plano ?? 'sem plano'} · acesso ${c.acesso}`);

    const faturas = await passo('Faturas em aberto do cliente', () => ixc.faturasAbertas(cliente.id));
    for (const f of (faturas ?? []).slice(0, 5)) {
      console.log(`    fatura ${f.id} · vence ${f.vencimento} · ${reais(f.aberto_centavos)} · situação ${f.situacao}`);
    }
    if (faturas && !faturas.length) console.log('    (nenhuma fatura em aberto — use um cliente devedor para testar a baixa)');
  }

  // Nomes dos campos que a sua versão do IXC devolve: é o que a gente compara com o que o PDV espera.
  const faturaId = opcao('baixar') || null;
  if (faturaId) {
    const antes = await passo(`Fatura ${faturaId} antes da baixa`, async () => {
      const f = await ixc.fatura(String(faturaId));
      if (!f) throw new Error('fatura não encontrada');
      return f;
    });
    if (antes) {
      console.log(`    situação ${antes.situacao} · valor ${reais(antes.valor_centavos)} · aberto ${reais(antes.aberto_centavos)}`);
      const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
      const baixa = await passo('BAIXA da fatura (como o PDV faz)', () => ixc.baixar({
        faturaId: antes.id,
        valorCentavos: antes.aberto_centavos,
        dataPagamento: hoje,
        tipoRecebimento: opcao('tipo-recebimento'),
        contaId: opcao('conta'),
        historico: 'Homologação do PDV',
      }));
      if (baixa) console.log(`    resposta do IXC: ${baixa.mensagem}`);

      const depois = await passo('Confere a fatura depois da baixa', async () => {
        const f = await ixc.fatura(String(faturaId));
        if (!f) throw new Error('fatura sumiu depois da baixa');
        if (f.situacao !== 'recebido') throw new Error(`o IXC ainda mostra a fatura como "${f.situacao}" (a baixa não pegou)`);
        return f;
      });
      if (depois) {
        console.log(`    situação ${depois.situacao} · recebido ${reais(depois.recebido_centavos)} · pagamento ${depois.pagamento ?? '(sem data)'}`);
        if (Math.abs(depois.recebido_centavos - antes.aberto_centavos) > 1) {
          console.log(`    ATENÇÃO: o IXC gravou ${reais(depois.recebido_centavos)} e o PDV mandou ${reais(antes.aberto_centavos)} — o campo de valor pode ter outro nome nesta versão.`);
        }
      }

      if (temOpcao('estornar')) {
        await passo('Estorno (reabre a fatura)', () => ixc.estornar({ faturaId: antes.id, valorCentavos: antes.aberto_centavos, historico: 'Estorno da homologação' }));
        const volta = await ixc.fatura(String(faturaId)).catch(() => null);
        if (volta) console.log(`    situação agora: ${volta.situacao} · aberto ${reais(volta.aberto_centavos)}`);
      } else {
        console.log('    (a fatura ficou BAIXADA no IXC — rode de novo com --estornar para reabrir)');
      }
    }
  } else {
    console.log('\n(nenhuma baixa testada: acrescente --baixar <id de uma fatura de teste> para testar a baixa)');
  }

  const falhas = resultados.filter(([ok]) => !ok);
  console.log(`\n${'='.repeat(34)}\n${resultados.length - falhas.length} de ${resultados.length} verificações passaram.`);
  if (falhas.length) {
    console.log('\nO que falhou:');
    for (const [, nome] of falhas) console.log(`  ✖ ${nome}`);
    console.log('\nMande esta saída para quem cuida do PDV: os nomes de recurso e campo ficam todos em server/lib/ixc.js.');
    process.exit(2);
  }
  console.log('\nTudo certo: o PDV consegue consultar e baixar faturas neste IXC.');
})().catch((err) => {
  console.error(`\nErro inesperado: ${err.message}`);
  process.exit(1);
});
