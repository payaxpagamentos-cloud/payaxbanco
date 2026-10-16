'use strict';

// Dados de demonstração: equipe, quatro empresas na carteira e cerca de quatro meses de movimento.
// Uso: npm run seed (não faz nada se já houver empresas cadastradas).

const { abrir, transacao } = require('./db');
const { hashSenha } = require('./lib/senha');
const { prepararEmpresa } = require('./lib/carteira');
const lanc = require('./lib/lancamentos');
const conc = require('./lib/conciliacao');
const { hoje, somarDias, somarMeses, inicioMes } = require('./lib/datas');

const db = abrir();
if (db.prepare('SELECT COUNT(*) AS n FROM empresas').get().n) {
  console.log('[PAY AX BPO] Já existem empresas cadastradas: seed ignorado.');
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
  ['Contabilidade e BPO', 'Mensalidade BPO PAY AX', 10, null],
  ['Marketing e publicidade', 'Anúncios online', 20, [0.01, 0.03]],
];

transacao(db, () => {
  const ids = {
    supervisor: usuario('Carla Mendes', 'supervisor@bpo.payax.com.br', 'supervisor'),
    rafael: usuario('Rafael Souza', 'rafael@bpo.payax.com.br', 'analista'),
    juliana: usuario('Juliana Costa', 'juliana@bpo.payax.com.br', 'analista'),
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
    const movimento = conta('Conta movimento', 'PAY AX', Math.round(receitaEsperada * 0.4));
    const reserva = conta('Reserva', 'PAY AX', Math.round(receitaEsperada * 0.2));

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
});

console.log('[PAY AX BPO] Dados de demonstração criados.');
console.log(`  supervisor@bpo.payax.com.br, rafael@bpo.payax.com.br e juliana@bpo.payax.com.br — senha "${SENHA}"`);
