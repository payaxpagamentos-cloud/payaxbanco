'use strict';

/**
 * Dados de exemplo para conhecer o PDV sem um IXC ligado: uma empresa com duas lojas, três PDVs,
 * maquininhas, equipe e alguns dias de movimento (inclusive baixas pendentes e uma divergência).
 *
 *   npm run seed            (acrescenta ao banco atual)
 */

const { abrir, agora, transacao } = require('./db');
const { hashSenha } = require('./lib/senha');
const { salvarConfig } = require('./lib/ixcEmpresa');
const { criar } = require('./lib/recebimentos');
const { abrir: abrirCaixa, fechar: fecharCaixa, movimentar } = require('./lib/caixa');
const { gerarChaveTerminal } = require('./lib/contas');
const { registrarManual } = require('./lib/maquininha');
const { hoje, somarDias } = require('./lib/datas');

const SENHA = 'pdv2026';
const CLIENTES = [
  ['3001', 'MARIA DA SILVA', '52998224725'], ['3002', 'JOAO SOUZA', '11144477735'], ['3003', 'ANA PEREIRA LIMA', '39053344705'],
  ['3004', 'CARLOS EDUARDO ROCHA', '16899535009'], ['3005', 'MERCEARIA BOM PRECO LTDA', '11444777000161'],
];
const sorteio = (lista) => lista[Math.floor(Math.random() * lista.length)];

function semear(db) {
  if (db.prepare("SELECT 1 FROM empresas WHERE nome = 'Provedor Exemplo'").get()) {
    console.log('O seed já foi aplicado neste banco.');
    return;
  }
  const empresaId = transacao(db, () => {
    const e = db.prepare("INSERT INTO empresas (nome, documento, email, telefone, criada_em) VALUES ('Provedor Exemplo', '11444777000161', 'financeiro@provedorexemplo.com.br', '1133224455', ?)").run(agora());
    const id = Number(e.lastInsertRowid);
    const lojas = ['Matriz · Centro', 'Filial · Bairro Novo'].map((nome) =>
      Number(db.prepare('INSERT INTO lojas (empresa_id, nome, endereco, criada_em) VALUES (?, ?, ?, ?)').run(id, nome, 'Rua das Flores, 100', agora()).lastInsertRowid));
    const pdvs = [[lojas[0], 'Caixa 1'], [lojas[0], 'Caixa 2'], [lojas[1], 'Caixa 1']].map(([loja, nome]) =>
      Number(db.prepare('INSERT INTO pdvs (empresa_id, loja_id, nome, criado_em) VALUES (?, ?, ?, ?)').run(id, loja, nome, agora()).lastInsertRowid));
    const usuario = (nome, email, perfil, lojaId) => Number(db.prepare(
      'INSERT INTO usuarios (nome, email, senha_hash, perfil, empresa_id, loja_id, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(nome, email, hashSenha(SENHA), perfil, id, lojaId, agora()).lastInsertRowid);
    const gerente = usuario('Patrícia Gerente', 'gerente@provedorexemplo.com.br', 'admin', null);
    const supervisor = usuario('Sérgio Supervisor', 'supervisor@provedorexemplo.com.br', 'supervisor', null);
    const caixa1 = usuario('Camila Caixa', 'caixa@provedorexemplo.com.br', 'operador', lojas[0]);
    const caixa2 = usuario('Bruno Balcão', 'balcao@provedorexemplo.com.br', 'operador', lojas[1]);

    salvarConfig(db, id, {
      multa_percentual: 2, juros_mes_percentual: 1, desconto_max_percentual: 5, exigir_caixa: true, permitir_avulso: true,
      comprovante_cabecalho: 'PROVEDOR EXEMPLO LTDA\nRua das Flores, 100 · Centro\n(11) 3322-4455',
      comprovante_rodape: 'Obrigado! Dúvidas: (11) 3322-4455',
    });

    for (const [nome, adquirente, modo, loja, pdv] of [
      ['Maquininha Caixa 1', 'stone', 'agente', lojas[0], pdvs[0]],
      ['Maquininha Caixa 2', 'cielo', 'manual', lojas[0], pdvs[1]],
      ['Maquininha Filial', 'pagbank', 'agente', lojas[1], pdvs[2]],
    ]) {
      const t = db.prepare('INSERT INTO terminais (empresa_id, loja_id, pdv_id, nome, adquirente, modo, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, loja, pdv, nome, adquirente, modo, agora());
      if (modo !== 'manual') gerarChaveTerminal(db, Number(t.lastInsertRowid));
    }
    return { id, lojas, pdvs, gerente, supervisor, caixa1, caixa2 };
  });

  const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(empresaId.id);
  const operadores = [
    { id: empresaId.caixa1, nome: 'Camila Caixa', perfil: 'operador', loja_id: empresaId.lojas[0], pdv: empresaId.pdvs[0] },
    { id: empresaId.caixa2, nome: 'Bruno Balcão', perfil: 'operador', loja_id: empresaId.lojas[1], pdv: empresaId.pdvs[2] },
  ];
  let fatura = 8000;
  let total = 0;

  for (let dia = 3; dia >= 0; dia--) {
    const data = somarDias(hoje(), -dia);
    for (const op of operadores) {
      const caixa = abrirCaixa(db, { empresa, usuario: op, pdvId: op.pdv, fundoCentavos: 10_000 });
      db.prepare('UPDATE caixas SET data = ? WHERE id = ?').run(data, caixa.id);
      const atendimentos = 3 + Math.floor(Math.random() * 4);
      for (let i = 0; i < atendimentos; i++) {
        const [codigo, nome, documento] = sorteio(CLIENTES);
        const valor = [7990, 9990, 11990, 14990, 19990][Math.floor(Math.random() * 5)];
        const vencimento = somarDias(data, -Math.floor(Math.random() * 40));
        const atraso = Math.max(0, Math.floor((Date.parse(data) - Date.parse(vencimento)) / 86_400_000));
        const acrescimo = atraso > 0 ? Math.round(valor * 0.02) + Math.round((valor * 1 * atraso) / 3000) : 0;
        const formas = sorteio([['dinheiro'], ['pix'], ['debito'], ['credito'], ['dinheiro', 'pix']]);
        const totalRecebimento = valor + acrescimo;
        const parte = Math.round(totalRecebimento / formas.length);
        const terminal = db.prepare('SELECT id FROM terminais WHERE empresa_id = ? AND loja_id = ? LIMIT 1').get(empresa.id, op.loja_id);
        const pagamentos = formas.map((forma, k) => {
          const valorPagamento = k === formas.length - 1 ? totalRecebimento - parte * (formas.length - 1) : parte;
          if (forma !== 'debito' && forma !== 'credito') return { forma, valor_centavos: valorPagamento };
          // No exemplo, o cartão entra como cobrança já aprovada (como numa maquininha sem integração).
          const cobranca = registrarManual(db, {
            empresa, terminalId: terminal.id, forma, valorCentavos: valorPagamento, parcelas: forma === 'credito' ? 1 + Math.floor(Math.random() * 3) : 1,
            operadorId: op.id, caixaId: caixa.id, nsu: String(100000 + Math.floor(Math.random() * 899999)),
            autorizacao: String(100000 + Math.floor(Math.random() * 899999)), bandeira: sorteio(['VISA', 'MASTERCARD', 'ELO']), cartaoFinal: String(1000 + Math.floor(Math.random() * 8999)),
          });
          return { forma, valor_centavos: valorPagamento, transacao_id: cobranca.id };
        });
        const r = criar(db, {
          empresa,
          usuario: op,
          dados: {
            cliente_ixc_id: codigo, cliente_nome: nome, cliente_documento: documento,
            titulos: [{ fatura_ixc_id: String(fatura++), contrato_ixc_id: `7${codigo}`, documento: `${fatura}/1`, vencimento, valor_centavos: valor, acrescimo_centavos: acrescimo }],
            pagamentos,
          },
        });
        db.prepare('UPDATE recebimentos SET data = ? WHERE id = ?').run(data, r.id);
        total += totalRecebimento;
        // A maioria já foi baixada no IXC; algumas de hoje continuam esperando, uma deu erro.
        const sorte = Math.random();
        if (dia === 0 && sorte < 0.2) {
          // fica pendente
        } else if (dia === 0 && sorte < 0.3) {
          db.prepare("UPDATE recebimentos SET ixc_status = 'erro', ixc_erro = 'O IXC não respondeu a tempo.', ixc_tentativas = 3 WHERE id = ?").run(r.id);
          db.prepare("UPDATE recebimento_titulos SET ixc_status = 'erro', ixc_erro = 'O IXC não respondeu a tempo.' WHERE recebimento_id = ?").run(r.id);
        } else {
          db.prepare("UPDATE recebimentos SET ixc_status = 'baixado', conferencia = 'conferido', conferido_em = ? WHERE id = ?").run(agora(), r.id);
          db.prepare("UPDATE recebimento_titulos SET ixc_status = 'baixado', ixc_baixado_em = ?, ixc_situacao = 'recebido', ixc_valor_centavos = total_centavos, ixc_data_pagamento = ? WHERE recebimento_id = ?")
            .run(agora(), data, r.id);
        }
      }
      const naGaveta = db.prepare("SELECT COALESCE(SUM(p.valor_centavos), 0) AS s FROM pagamentos p JOIN recebimentos r ON r.id = p.recebimento_id WHERE r.caixa_id = ? AND p.forma = 'dinheiro'").get(caixa.id).s;
      if (naGaveta > 30_000) movimentar(db, { empresa, usuario: op, caixaId: caixa.id, tipo: 'sangria', valorCentavos: 20_000, motivo: 'Retirada para o cofre' });
      if (dia > 0) {
        const resumo = db.prepare("SELECT COALESCE(SUM(p.valor_centavos), 0) AS dinheiro FROM pagamentos p JOIN recebimentos r ON r.id = p.recebimento_id WHERE r.caixa_id = ? AND p.forma = 'dinheiro'").get(caixa.id);
        const contagem = { dinheiro: 10_000 + resumo.dinheiro - (db.prepare("SELECT COALESCE(SUM(valor_centavos), 0) AS s FROM movimentos_caixa WHERE caixa_id = ? AND tipo = 'sangria'").get(caixa.id).s) };
        fecharCaixa(db, { empresa, usuario: op, caixaId: caixa.id, contagem });
        db.prepare('UPDATE caixas SET fechado_em = ? WHERE id = ?').run(`${data}T21:00:00.000Z`, caixa.id);
      }
    }
  }

  // Uma divergência de exemplo: fatura que voltou a ficar em aberto no IXC.
  const alvo = db.prepare("SELECT r.id, r.numero, r.data, r.valor_centavos, t.id AS titulo_id, t.fatura_ixc_id FROM recebimentos r JOIN recebimento_titulos t ON t.recebimento_id = r.id WHERE r.empresa_id = ? AND r.ixc_status = 'baixado' ORDER BY r.id LIMIT 1").get(empresaId.id);
  if (alvo) {
    db.prepare("UPDATE recebimentos SET conferencia = 'divergente' WHERE id = ?").run(alvo.id);
    db.prepare("UPDATE recebimento_titulos SET ixc_situacao = 'aberto', ixc_valor_centavos = 0, ixc_data_pagamento = NULL WHERE id = ?").run(alvo.titulo_id);
    db.prepare(`INSERT INTO divergencias (empresa_id, recebimento_id, titulo_id, data, tipo, detalhes, valor_pdv_centavos, valor_ixc_centavos, criado_em)
      VALUES (?, ?, ?, ?, 'nao_baixado', ?, ?, 0, ?)`)
      .run(empresaId.id, alvo.id, alvo.titulo_id, alvo.data, `Fatura ${alvo.fatura_ixc_id} está como "aberto" no IXC, mas foi recebida no PDV.`, alvo.valor_centavos, agora());
  }

  console.log(`Seed pronto: empresa "Provedor Exemplo" com ${db.prepare('SELECT COUNT(*) AS n FROM recebimentos').get().n} recebimentos (${(total / 100).toFixed(2)}).`);
  console.log(`Acessos (senha ${SENHA}): gerente@, supervisor@, caixa@ e balcao@provedorexemplo.com.br`);
}

if (require.main === module) {
  const db = abrir();
  semear(db);
}

module.exports = { semear };
