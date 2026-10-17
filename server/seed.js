'use strict';

// Dados de demonstração: equipe, quatro empresas na carteira e cerca de quatro meses de movimento.
// Uso: npm run seed (não faz nada se já houver empresas cadastradas).

const { abrir, transacao } = require('./db');
const { hashSenha } = require('./lib/senha');
const { prepararEmpresa } = require('./lib/carteira');
const lanc = require('./lib/lancamentos');
const conc = require('./lib/conciliacao');
const { hoje, somarDias, somarMeses, inicioMes } = require('./lib/datas');
const aprovacao = require('./lib/aprovacao');
const cobranca = require('./lib/cobranca');
const docs = require('./lib/documentos');
const orc = require('./lib/orcamento');

const db = abrir();
if (db.prepare('SELECT COUNT(*) AS n FROM empresas').get().n) {
  console.log('[Ativa BPO] Já existem empresas cadastradas: seed ignorado.');
  process.exit(0);
}

// Números pseudoaleatórios reprodutíveis.
let semente = 20260101;
const aleatorio = () => ((semente = (semente * 1103515245 + 12345) % 2147483648) / 2147483648);
const entre = (a, b) => Math.round(a + (b - a) * aleatorio());

function cnpj(base12) {
  const calc = (b) => {
    const pesos = b.length === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2];
    const r = pesos.reduce((a, p, i) => a + Number(b[i]) * p, 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = calc(base12);
  return `${base12}${d1}${calc(base12 + d1)}`;
}

const dia = hoje();
const SENHA = 'bpo2026';
const usuario = (nome, email, perfil) => Number(db.prepare('INSERT INTO usuarios (nome, email, senha_hash, perfil) VALUES (?, ?, ?, ?)').run(nome, email, hashSenha(SENHA), perfil).lastInsertRowid);

const EMPRESAS = [
  { razao: 'Pão Quente Panificadora Ltda', fantasia: 'Padaria Pão Quente', base: '112223330001', plano: 'completo', mensal: 180000, analista: 'rafael', receita: [2000000, 2800000], semanal: true,
    clientes: ['Vendas balcão (maquininha)', 'Mercado Bom Preço', 'Café da Esquina'], fornecedores: ['Moinho Sul Farinhas', 'Laticínios Serra Azul', 'Distribuidora Doce Vida'], cmv: 0.38 },
  { razao: 'Clínica Sorriso Odontologia S/S', fantasia: 'Clínica Sorriso', base: '345678900001', plano: 'premium', mensal: 260000, analista: 'juliana', receita: [4500000, 6500000], semanal: true,
    clientes: ['Particulares (cartão)', 'OdontoPrev Convênio', 'Amil Dental'], fornecedores: ['Dental Cremer', 'Laboratório Prótese Arte', 'Esterilize Serviços'], cmv: 0.18 },
  { razao: 'TechNova Sistemas Ltda', fantasia: 'TechNova', base: '271828180001', plano: 'premium', mensal: 320000, analista: 'juliana', receita: [22000000, 32000000], semanal: false,
    clientes: ['Grupo Vale Verde', 'Construtora Alfa', 'Rede Farma Mais', 'Escola Saber'], fornecedores: ['AWS Brasil', 'Freelancer Dev Ltda', 'Google Workspace'], cmv: 0.22 },
  { razao: 'Auto Mecânica Rota 66 ME', fantasia: 'Oficina Rota 66', base: '314159260001', plano: 'essencial', mensal: 95000, analista: 'rafael', receita: [1800000, 3000000], semanal: true, implantacao: true,
    clientes: ['Clientes balcão', 'Locadora Rodar', 'Frota Express'], fornecedores: ['Autopeças Central', 'Lubrificantes Max', 'Tintas Car'], cmv: 0.42 },
];

// Despesas fixas mensais: [categoria, descrição, dia de vencimento, faixa em fração da receita esperada].
const DESPESAS_FIXAS = [
  ['Aluguel e condomínio', 'Aluguel', 5, [0.06, 0.09]],
  ['Energia, água e internet', 'Energia elétrica', 12, [0.01, 0.02]],
  ['Salários e encargos', 'Folha de pagamento', 5, [0.18, 0.24]],
  ['Pró-labore', 'Pró-labore dos sócios', 5, [0.06, 0.09]],
  ['Software e sistemas', 'Sistema de gestão', 15, [0.003, 0.008]],
  ['Contabilidade e BPO', 'Mensalidade Ativa BPO', 10, null],
  ['Marketing e publicidade', 'Anúncios online', 20, [0.01, 0.03]],
];

const ids = transacao(db, () => {
  const ids = {
    supervisor: usuario('Carla Mendes', 'supervisor@ativabpo.com.br', 'supervisor'),
    rafael: usuario('Rafael Souza', 'rafael@ativabpo.com.br', 'analista'),
    juliana: usuario('Juliana Costa', 'juliana@ativabpo.com.br', 'analista'),
  };
  const req = { usuario: { id: ids.supervisor } };
  const inicio = inicioMes(somarMeses(dia, -4));

  for (const e of EMPRESAS) {
    const empresaId = Number(db.prepare(`INSERT INTO empresas (razao_social, nome_fantasia, cnpj, email, responsavel, analista_id, plano, mensalidade_centavos,
      dia_vencimento, inicio_contrato, status, observacoes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 10, ?, ?, ?)`)
      .run(e.razao, e.fantasia, cnpj(e.base), `financeiro@${e.fantasia.toLowerCase().replace(/[^a-z]/g, '')}.com.br`, 'Sócio administrador',
        ids[e.analista], e.plano, e.mensal, inicio, e.implantacao ? 'implantacao' : 'ativa',
        'Escopo: contas a pagar e a receber, conciliação diária, fluxo de caixa e DRE mensal até o dia 8.').lastInsertRowid);
    prepararEmpresa(db, empresaId, ids[e.analista]);
    const cat = Object.fromEntries(db.prepare('SELECT nome, id FROM categorias WHERE empresa_id = ?').all(empresaId).map((c) => [c.nome, c.id]));
    const contato = (tipo, nome) => Number(db.prepare('INSERT INTO contatos (empresa_id, tipo, nome) VALUES (?, ?, ?)').run(empresaId, tipo, nome).lastInsertRowid);
    const clientes = e.clientes.map((n) => contato('cliente', n));
    const fornecedores = e.fornecedores.map((n) => contato('fornecedor', n));
    const conta = (descricao, banco, saldo) => Number(db.prepare(`INSERT INTO contas_bancarias (empresa_id, descricao, banco, agencia, numero, saldo_inicial_centavos, data_saldo_inicial)
      VALUES (?, ?, ?, '0001', ?, ?, ?)`).run(empresaId, descricao, banco, String(entre(10000, 99999)), saldo, somarDias(inicio, -1)).lastInsertRowid);
    const receitaEsperada = ((e.receita[0] + e.receita[1]) / 2) * (e.semanal ? 4 : 1);
    const movimento = conta('Conta movimento', 'Banco do Brasil', Math.round(receitaEsperada * 0.4));
    const reserva = conta('Reserva', 'Itaú', Math.round(receitaEsperada * 0.2));

    const lancar = (tipo, descricao, categoria, valor, vencimento, contatoId) => {
      const [id] = lanc.criar(db, req, empresaId, { tipo, descricao, categoria_id: cat[categoria], valor_centavos: valor, vencimento, contato_id: contatoId ?? null, conta_bancaria_id: movimento });
      // Passado: baixado (às vezes com atraso e juros); alguns ficam vencidos para a rotina do analista.
      if (vencimento < dia && aleatorio() > 0.06) {
        const atraso = aleatorio() > 0.85 ? entre(1, 4) : 0;
        const data = somarDias(vencimento, atraso) < dia ? somarDias(vencimento, atraso) : vencimento;
        lanc.baixar(db, req, empresaId, id, { data, conta_bancaria_id: movimento, juros_centavos: tipo === 'pagar' && atraso ? Math.round(valor * 0.0033 * atraso) : 0 });
      }
    };

    for (let m = 0; m <= 6; m++) {
      const mesBase = somarMeses(inicio, m);
      if (mesBase > somarMeses(dia, 2)) break;
      let receitaMes = 0;
      // Receitas: semanais (varejo) ou mensais por contrato (serviços).
      if (e.semanal) {
        for (let s = 0; s < 4; s++) {
          const v = entre(...e.receita);
          receitaMes += v;
          lancar('receber', `Vendas da semana ${s + 1}`, e.base.startsWith('3456') ? 'Prestação de serviços' : 'Venda de produtos', v, somarDias(mesBase, 6 + s * 7), clientes[s % clientes.length]);
        }
      } else {
        for (const c of clientes) {
          const v = Math.round(entre(...e.receita) / clientes.length);
          receitaMes += v;
          lancar('receber', 'Mensalidade de licenças e suporte', 'Prestação de serviços', v, somarDias(mesBase, entre(4, 14)), c);
        }
      }
      // Custos variáveis e impostos proporcionais à receita.
      lancar('pagar', 'Compra de insumos', e.base.startsWith('2718') ? 'Serviços terceirizados' : 'Compra de mercadorias', Math.round(receitaMes * e.cmv), somarDias(mesBase, 14), fornecedores[0]);
      lancar('pagar', 'DAS Simples Nacional', 'Impostos sobre vendas (Simples, ISS, ICMS)', Math.round(receitaMes * 0.06), somarDias(mesBase, 19));
      for (const [categoria, descricao, d, faixa] of DESPESAS_FIXAS) {
        const v = faixa ? entre(receitaEsperada * faixa[0], receitaEsperada * faixa[1]) : e.mensal;
        lancar('pagar', descricao, categoria, v, somarDias(mesBase, d - 1), categoria === 'Marketing e publicidade' ? fornecedores[2] : null);
      }
      lancar('pagar', 'Tarifa pacote de serviços', 'Tarifas bancárias', 4990, somarDias(mesBase, 1));
    }
    // Compra parcelada de equipamento.
    lanc.criar(db, req, empresaId, { tipo: 'pagar', descricao: 'Equipamento novo', categoria_id: cat['Investimentos em imobilizado'], valor_centavos: Math.round(receitaEsperada * 0.3),
      parcelas: 6, vencimento: somarDias(inicioMes(dia), 24), contato_id: fornecedores[1] });
    lanc.transferir(db, req, empresaId, { origem_id: movimento, destino_id: reserva, valor_centavos: Math.round(receitaEsperada * 0.05), data: somarDias(dia, -20), descricao: 'Aplicação na reserva' });

    // Extrato do banco dos últimos 40 dias: baixas no sistema + rendimento e tarifa extra que ainda não foram lançados.
    const desde = somarDias(dia, -40);
    const movs = db.prepare('SELECT * FROM movimentos WHERE conta_bancaria_id = ? AND data >= ? ORDER BY data').all(movimento, desde);
    const linhas = movs.filter((mv) => mv.data < somarDias(dia, -1) || aleatorio() > 0.5)
      .map((mv) => [mv.data, mv.valor_centavos, mv.descricao.toUpperCase(), `M${mv.id}`]);
    linhas.push([somarDias(dia, -3), entre(1500, 9000), 'RENDIMENTO APLIC AUTOMATICA', `R${empresaId}`]);
    linhas.push([somarDias(dia, -2), -entre(800, 2500), 'TARIFA TED', `T${empresaId}`]);
    const ofx = `OFXHEADER:100\nDATA:OFXSGML\n\n<OFX><BANKTRANLIST>\n${linhas.map(([d, v, memo, id]) =>
      `<STMTTRN>\n<DTPOSTED>${d.replace(/-/g, '')}\n<TRNAMT>${(v / 100).toFixed(2)}\n<FITID>${id}\n<MEMO>${memo}\n</STMTTRN>`).join('\n')}\n</BANKTRANLIST></OFX>`;
    conc.importar(db, req, empresaId, { conta_bancaria_id: movimento, conteudo: ofx, arquivo: 'extrato-demo.ofx' });
    // Concilia o que é mais antigo; a última semana fica para o analista.
    const pendentes = db.prepare("SELECT x.id, x.valor_centavos, x.conta_bancaria_id, x.data FROM extrato x WHERE x.conta_bancaria_id = ? AND x.status = 'pendente' AND x.data < ?")
      .all(movimento, somarDias(dia, -7));
    for (const x of pendentes) {
      const { movimentos } = conc.candidatos(db, empresaId, x);
      if (movimentos.length) conc.conciliarMovimento(db, req, empresaId, x.id, movimentos[0].id);
    }
    // A rotina mensal mais próxima fica atrasada para aparecer no painel.
    db.prepare("UPDATE tarefas SET vencimento = ? WHERE id = (SELECT MIN(id) FROM tarefas WHERE empresa_id = ?)").run(somarDias(dia, -2), empresaId);
  }
  return ids;
});

// ---------- Módulos de gestão: responsáveis e Portal, aprovação, cobrança, documentos, orçamento, fechamento ----------
const SENHA_PORTAL = 'portal2026';
transacao(db, () => {
  const req = { usuario: { id: ids.supervisor } };
  const reqAnalista = (empresaId) => ({ usuario: { id: db.prepare('SELECT analista_id FROM empresas WHERE id = ?').get(empresaId).analista_id } });
  const empresas = db.prepare('SELECT * FROM empresas ORDER BY id').all();
  const cat = (empresaId, nome) => db.prepare('SELECT id FROM categorias WHERE empresa_id = ? AND nome = ?').get(empresaId, nome).id;
  const RESPONSAVEIS = [
    ['Marta Lima', 'Sócia administradora', 'marta@paoquente.com.br'],
    ['Dr. Paulo Andrade', 'Diretor clínico', 'paulo@clinicasorriso.com.br'],
    ['Renata Okada', 'CFO', 'renata@technova.com.br'],
    ['Sérgio Rota', 'Proprietário', 'sergio@rota66.com.br'],
  ];
  for (const [i, e] of empresas.entries()) {
    const [nome, cargo, email] = RESPONSAVEIS[i];
    // Responsável com acesso ao Portal (senha já definitiva na demonstração) e um contato só para relatórios.
    db.prepare(`INSERT INTO responsaveis (empresa_id, nome, cargo, email, telefone, acesso_portal, senha_hash, precisa_trocar_senha, pode_aprovar, limite_aprovacao_centavos)
      VALUES (?, ?, ?, ?, ?, 1, ?, 0, 1, ?)`).run(e.id, nome, cargo, email, `1199${String(1000000 + i * 1111).slice(0, 7)}`, hashSenha(SENHA_PORTAL), i === 2 ? 5_000_000 : -1);
    db.prepare("INSERT INTO responsaveis (empresa_id, nome, cargo, email, recebe_relatorios) VALUES (?, 'Contador externo', 'Contabilidade', ?, 1)").run(e.id, `contabil+${e.id}@escritorio.com.br`);
    db.prepare("UPDATE empresas SET aprovacao_ativa = 1, aprovacao_acima_centavos = 300000, chave_pix_cobranca = ? WHERE id = ?").run(e.cnpj, e.id);

    // Códigos contábeis para a exportação.
    db.prepare("UPDATE contas_bancarias SET conta_contabil = CASE descricao WHEN 'Conta movimento' THEN '1.1.1.02' ELSE '1.1.1.03' END WHERE empresa_id = ?").run(e.id);
    const codigos = { 'Venda de produtos': '3.1.1.01', 'Prestação de serviços': '3.1.1.02', 'Compra de mercadorias': '4.1.1.01', 'Salários e encargos': '4.2.1.01',
      'Aluguel e condomínio': '4.2.2.01', 'Energia, água e internet': '4.2.2.02', 'Impostos sobre vendas (Simples, ISS, ICMS)': '3.2.1.01', 'Tarifas bancárias': '4.3.1.01' };
    for (const [n, c] of Object.entries(codigos)) db.prepare('UPDATE categorias SET conta_contabil = ? WHERE empresa_id = ? AND nome = ?').run(c, e.id, n);

    // Pagamentos novos passando pela aprovação: um em conferência e um aguardando o cliente.
    const conta = db.prepare("SELECT id FROM contas_bancarias WHERE empresa_id = ? AND descricao = 'Conta movimento'").get(e.id).id;
    const fornecedor = db.prepare("SELECT id FROM contatos WHERE empresa_id = ? AND tipo = 'fornecedor' ORDER BY id LIMIT 1").get(e.id).id;
    const [emConferencia] = lanc.criar(db, reqAnalista(e.id), e.id, { tipo: 'pagar', descricao: 'Compra extra de estoque', valor_centavos: 850_000,
      vencimento: somarDias(dia, 4), categoria_id: cat(e.id, 'Compra de mercadorias'), contato_id: fornecedor, conta_bancaria_id: conta, documento: 'NF 4521' });
    const [paraAprovar] = lanc.criar(db, reqAnalista(e.id), e.id, { tipo: 'pagar', descricao: 'Manutenção de equipamentos', valor_centavos: 420_000,
      vencimento: somarDias(dia, 3), categoria_id: cat(e.id, 'Serviços terceirizados'), conta_bancaria_id: conta, documento: 'NF 991' });
    aprovacao.conferir(db, req, e.id, paraAprovar, 'NF e dados bancários conferidos.');
    void emConferencia;

    // Documentos de exemplo (PDF mínimo), um ligado ao pagamento.
    const pdf = (titulo) => Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length ${44 + titulo.length}>>stream\nBT /F1 14 Tf 20 60 Td (${titulo}) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF`);
    docs.salvar(db, e.id, pdf('Contrato de prestacao de servicos BPO'), { nome: 'contrato-ativa-bpo.pdf', tipo: 'contrato' }, { usuario_id: ids.supervisor });
    docs.salvar(db, e.id, pdf('NF 991 - Manutencao'), { nome: 'nf-991.pdf', tipo: 'nota', lancamento_id: paraAprovar }, { responsavel_id: db.prepare('SELECT id FROM responsaveis WHERE empresa_id = ? AND acesso_portal = 1').get(e.id).id });

    // Rateio entre dois centros de custo.
    const centros = ['Operação', 'Administrativo'].map((n) => Number(db.prepare('INSERT INTO centros_custo (empresa_id, nome) VALUES (?, ?)').run(e.id, n).lastInsertRowid));
    lanc.criar(db, req, e.id, { tipo: 'pagar', descricao: 'Internet e telefonia', valor_centavos: 48_000, vencimento: somarDias(dia, 8), categoria_id: cat(e.id, 'Energia, água e internet'),
      conta_bancaria_id: conta, rateio: [{ centro_custo_id: centros[0], percentual: 60 }, { centro_custo_id: centros[1], percentual: 40 }] });

    // Clientes em atraso para a rotina de cobrança.
    const clientes = db.prepare("SELECT id FROM contatos WHERE empresa_id = ? AND tipo = 'cliente' ORDER BY id").all(e.id).map((c) => c.id);
    const receita = cat(e.id, i === 1 || i === 2 ? 'Prestação de serviços' : 'Venda de produtos');
    [[12, 0.04], [38, 0.03], [75, 0.02], [5, 0.025]].forEach(([atraso, fator], k) => {
      const base = db.prepare("SELECT AVG(valor_centavos) AS m FROM lancamentos WHERE empresa_id = ? AND tipo = 'receber'").get(e.id).m;
      lanc.criar(db, req, e.id, { tipo: 'receber', descricao: k === 3 ? 'Venda a prazo' : 'Fornecimento faturado', valor_centavos: Math.round(base * fator * 10),
        vencimento: somarDias(dia, -atraso), categoria_id: receita, contato_id: clientes[k % clientes.length],
        conta_bancaria_id: conta, documento: `Fat. ${1200 + k}` });
    });
    // A oficina tem uma compra grande programada que o caixa não cobre: alerta de falta de caixa.
    if (i === 3) {
      lanc.criar(db, reqAnalista(e.id), e.id, { tipo: 'pagar', descricao: 'Elevador automotivo (sinal)', valor_centavos: 15_000_000, vencimento: somarDias(dia, 12),
        categoria_id: cat(e.id, 'Investimentos em imobilizado'), contato_id: fornecedor, conta_bancaria_id: conta });
    }

    // Cobrança: registros, uma promessa e o lembrete.
    const devedor = db.prepare(`SELECT l.id, l.contato_id, l.valor_centavos FROM lancamentos l WHERE l.empresa_id = ? AND l.tipo = 'receber' AND l.status = 'aberto'
      AND l.vencimento < ? AND l.contato_id IS NOT NULL ORDER BY l.vencimento LIMIT 1`).get(e.id, dia);
    if (devedor) {
      cobranca.registrarContato(db, reqAnalista(e.id), e.id, { contato_id: devedor.contato_id, lancamento_id: devedor.id, canal: 'whatsapp', descricao: 'Lembrete enviado; cliente pediu a segunda via do boleto.' });
      cobranca.registrarPromessa(db, reqAnalista(e.id), e.id, { contato_id: devedor.contato_id, lancamento_id: devedor.id, data_prometida: somarDias(dia, 2), valor_centavos: devedor.valor_centavos, observacao: 'Prometeu pagar via PIX.' });
    }

    // Orçamento do ano pela média dos últimos meses, com 5% de reajuste.
    orc.sugerir(db, e.id, dia.slice(0, 4), 5);
    db.prepare('DELETE FROM orcamentos WHERE empresa_id = ? AND mes < ?').run(e.id, e.inicio_contrato.slice(0, 7));

    // Conversa com o cliente.
    const resp = db.prepare('SELECT id FROM responsaveis WHERE empresa_id = ? AND acesso_portal = 1').get(e.id).id;
    const msg = db.prepare('INSERT INTO mensagens (empresa_id, autor, usuario_id, responsavel_id, texto, lida_em) VALUES (?, ?, ?, ?, ?, ?)');
    msg.run(e.id, 'equipe', e.analista_id, null, `Olá! O fechamento do mês passado está pronto. A DRE já está disponível em Relatórios.`, new Date().toISOString());
    msg.run(e.id, 'cliente', null, resp, 'Obrigado! Enviei a NF 991 da manutenção pelo Portal. Podem programar o pagamento?', null);

    // Fechamento: o mês retrasado fechado; o mês passado em andamento.
    const retrasado = somarMeses(dia, -2).slice(0, 7);
    for (const etapa of ['conciliacao', 'vencidos', 'aprovacoes', 'classificacao', 'dre', 'envio']) {
      db.prepare('INSERT INTO fechamentos (empresa_id, mes, etapa, usuario_id, observacao) VALUES (?, ?, ?, ?, ?)').run(e.id, retrasado, etapa, e.analista_id, 'Demonstração');
    }
    db.prepare("INSERT INTO fechamentos (empresa_id, mes, etapa, usuario_id) VALUES (?, ?, 'fechado', ?)").run(e.id, retrasado, ids.supervisor);
    const passado = somarMeses(dia, -1).slice(0, 7);
    for (const etapa of ['classificacao', 'vencidos'].slice(0, i % 3)) {
      db.prepare('INSERT INTO fechamentos (empresa_id, mes, etapa, usuario_id, observacao) VALUES (?, ?, ?, ?, ?)').run(e.id, passado, etapa, e.analista_id, 'Revisado');
    }
  }
  // Alçada: Juliana aprova até R$ 5.000,00.
  db.prepare('UPDATE usuarios SET alcada_aprovacao_centavos = 500000 WHERE id = ?').run(ids.juliana);
});

console.log('[Ativa BPO] Dados de demonstração criados.');
console.log(`  supervisor@ativabpo.com.br, rafael@ativabpo.com.br e juliana@ativabpo.com.br — senha "${SENHA}"`);
console.log(`  Portal do Cliente (/portal/): marta@paoquente.com.br, paulo@clinicasorriso.com.br, renata@technova.com.br, sergio@rota66.com.br — senha "${SENHA_PORTAL}"`);
