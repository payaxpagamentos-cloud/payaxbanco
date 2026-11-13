'use strict';

/*
 * Dados de demonstração: equipe, contas, preços, três clientes, boletos ao longo de dois meses,
 * liquidações com split e repasses. Use só em ambiente de desenvolvimento.
 *
 *   npm run demo
 */
const config = require('./config');
const { abrir, agora, transacao } = require('./db');
const { hashSenha } = require('./lib/senha');
const boletosLib = require('./lib/boletos');
const repassesLib = require('./lib/repasses');
const datas = require('./lib/datas');

if (config.producao) throw new Error('O gerador de demonstração não roda em produção.');

const db = abrir();
const hoje = datas.dataLocal(config.fusoPadrao);
const aleatorio = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const escolher = (lista) => lista[aleatorio(0, lista.length - 1)];

const NOMES = ['Ana Beatriz Ramos', 'Carlos Eduardo Lima', 'Marcos Vinícius Souza', 'Juliana Prado', 'Roberto Carvalho',
  'Fernanda Dias', 'Paulo Henrique Nunes', 'Camila Figueiredo', 'Ricardo Teixeira', 'Patrícia Moreira',
  'Sandro Almeida', 'Letícia Barbosa', 'Eduardo Vasques', 'Mariana Rocha', 'Thiago Marinho'];
const CPFS = ['11144477735', '52998224725', '87748248800', '15350946056', '39053344705'];

async function main() {
  if (db.prepare('SELECT COUNT(*) AS n FROM clientes').get().n) {
    console.log('O banco já tem clientes. Apague o arquivo em data/ para gerar a demonstração do zero.');
    return;
  }

  // Equipe
  for (const [nome, email, perfil] of [
    ['Renata Financeiro', 'renata@payax.local', 'financeiro'],
    ['Diego Operação', 'diego@payax.local', 'operacao'],
    ['Sócia Consulta', 'consulta@payax.local', 'consulta'],
  ]) {
    db.prepare('INSERT INTO usuarios (nome, email, senha_hash, perfil, senha_provisoria, criado_em) VALUES (?, ?, ?, ?, 0, ?)')
      .run(nome, email, hashSenha('payax2026'), perfil, agora());
  }

  // Nossa conta no Bradesco
  const contaId = db.prepare(`INSERT INTO contas_bancarias (apelido, agencia, agencia_dv, conta, conta_dv, cedente, carteira,
      beneficiario_nome, beneficiario_documento, beneficiario_endereco, beneficiario_cidade, beneficiario_uf, beneficiario_cep,
      pix_chave, pix_tipo, custo_emissao_centavos, custo_liquidacao_centavos, custo_pix_centavos, padrao, criado_em)
    VALUES ('Bradesco · conta gráfica', '3391', '7', '0006688', '4', '1234567', '09',
      'PayAx Pagamentos LTDA', '12345678000195', 'Av. Presidente Kennedy, 1200', 'Praia Grande', 'SP', '11704000',
      '12345678000195', 'cnpj', 0, 190, 50, 1, ?) RETURNING id`).get(agora()).id;

  // Tabela padrão da plataforma
  db.prepare(`INSERT INTO precos (cliente_id, vigencia_inicio, tarifa_emissao_centavos, tarifa_liquidacao_centavos,
      percentual_ppm, comissao_minima_centavos, tarifa_repasse_centavos, observacao, criado_em)
    VALUES (NULL, ?, 0, 290, 25000, 150, 0, 'Tabela padrão da plataforma', ?)`)
    .run(datas.somarDias(hoje, -120), agora());

  const CLIENTES = [
    { razao: 'Alfa Net Telecom LTDA', fantasia: 'Alfa Net', cnpj: '11122233000183', cidade: 'Praia Grande', uf: 'SP', titulos: 46, preco: { pct: 23500, tarifa: 250, min: 100 } },
    { razao: 'Beta Fibra Provedor LTDA', fantasia: 'Beta Fibra', cnpj: '19131243000197', cidade: 'Santos', uf: 'SP', titulos: 28, preco: { pct: 19000, tarifa: 320, min: 200 } },
    { razao: 'Gama Conecta Internet LTDA', fantasia: 'Gama Conecta', cnpj: '22233344000183', cidade: 'São Vicente', uf: 'SP', titulos: 17, preco: null },
  ];

  for (const c of CLIENTES) {
    const id = db.prepare(`INSERT INTO clientes (razao_social, nome_fantasia, cnpj, email, telefone, responsavel,
        cep, endereco, numero, bairro, cidade, uf, situacao, pix_tipo, pix_chave, pix_titular, pix_documento,
        retencao_dias, repasse_automatico, repasse_minimo_centavos, repasse_limite_aprovacao_centavos, limite_boleto_centavos, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, '11700000', 'Rua das Palmeiras', '450', 'Centro', ?, ?, 'ativo', 'cnpj', ?, ?, ?, 1, 1, 5000, 2000000, 1000000, ?)
      RETURNING id`).get(c.razao, c.fantasia, c.cnpj, `financeiro@${c.fantasia.toLowerCase().replace(/\s/g, '')}.com.br`,
      '13991234567', 'Financeiro', c.cidade, c.uf, c.cnpj, c.razao, c.cnpj, agora()).id;

    if (c.preco) {
      db.prepare(`INSERT INTO precos (cliente_id, vigencia_inicio, tarifa_emissao_centavos, tarifa_liquidacao_centavos,
          percentual_ppm, comissao_minima_centavos, tarifa_repasse_centavos, observacao, criado_em)
        VALUES (?, ?, 0, ?, ?, ?, 0, 'Tabela negociada', ?)`)
        .run(id, datas.somarDias(hoje, -90), c.preco.tarifa, c.preco.pct, c.preco.min, agora());
    }

    db.prepare(`INSERT INTO usuarios_cliente (cliente_id, nome, email, senha_hash, perfil, senha_provisoria, criado_em)
      VALUES (?, ?, ?, ?, 'admin', 0, ?)`)
      .run(id, `Financeiro ${c.fantasia}`, `financeiro@${c.fantasia.toLowerCase().replace(/\s/g, '')}.com.br`, hashSenha('cliente2026'), agora());

    const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(id);
    let liquidados = 0;

    for (let i = 0; i < c.titulos; i++) {
      const diasAtras = aleatorio(0, 58);
      const emissao = datas.somarDias(hoje, -diasAtras);
      const vencimento = datas.somarDias(emissao, aleatorio(5, 20));
      const valor = aleatorio(6990, 29990);
      const out = await boletosLib.emitir(db, {
        cliente,
        dados: {
          tipo: Math.random() < 0.75 ? 'bolepix' : 'boleto',
          valor_centavos: valor, emissao, vencimento,
          seu_numero: `FAT-${String(1000 + i)}`,
          pagador_nome: escolher(NOMES),
          pagador_documento: escolher(CPFS),
          pagador_cidade: c.cidade,
          pagador_uf: c.uf,
          pagador_bairro: 'Centro',
          pagador_endereco: 'Rua das Acácias',
          pagador_numero: String(aleatorio(10, 900)),
          pagador_cep: '11700000',
          juros_mes: '1',
          multa: '2',
          mensagem: 'Referente ao plano de internet.',
        },
      });
      // Cerca de 70% dos títulos já vencidos foram pagos.
      if (vencimento <= hoje && Math.random() < 0.72) {
        const pago = datas.somarDias(vencimento, aleatorio(-3, 2));
        boletosLib.liquidar(db, out.id, {
          pago_em: pago > hoje ? hoje : pago,
          valor_pago_centavos: valor,
          meio: Math.random() < 0.45 ? 'pix' : 'boleto',
        }, { origem: 'demonstracao' });
        liquidados += 1;
      }
    }
    console.log(`[PayAx] ${c.fantasia}: ${c.titulos} boletos, ${liquidados} liquidados.`);
  }

  // Repasses: roda a rotina para os saldos já liberados e deixa um esperando aprovação.
  const r = await repassesLib.rotinaAutomatica(db);
  console.log(`[PayAx] Repasses: ${r.enviados} enviado(s), ${r.aguardando} aguardando aprovação.`);

  console.log('\nAcesse:');
  console.log(`  Backoffice      http://localhost:${config.port}${config.basePath}/     admin@payax.local / ${config.admin.senha}`);
  console.log(`  Internet Bank   http://localhost:${config.port}${config.clientePath}/  financeiro@alfanet.com.br / cliente2026`);
  console.log('  Equipe: renata@ (financeiro), diego@ (operação), consulta@payax.local — senha payax2026');
}

main().catch((err) => { console.error(err); process.exit(1); });
