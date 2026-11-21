'use strict';

/*
 * Ambiente demonstrativo: cria uma organização SEPARADA, marcada como demonstração (a interface mostra o selo
 * "Ambiente demonstrativo"), com pessoas, placas, endereços, valores e medições FICTÍCIOS. Não toca nas outras organizações.
 * Os dados entram pela própria API (com as mesmas validações da operação). Recusa rodar em produção sem NETWORK_PERMITIR_DEMO=1.
 *
 *   npm run demo            → acessos: demo@managerprovedor.local (e os demais perfis) / senha demo12345
 */

const config = require('./config');
if (config.producao && process.env.NETWORK_PERMITIR_DEMO !== '1') {
  console.error('Recusado: NODE_ENV=production. Use um banco separado para demonstração (ou defina NETWORK_PERMITIR_DEMO=1 conscientemente).');
  process.exit(1);
}
const { abrir, agora } = require('./db');
const { criarApp } = require('./app');
const { criarOrganizacao } = require('./lib/organizacoes');
const { hashSenha } = require('./lib/senha');
const { processarAmostra } = require('./lib/noc');
const fat = require('./lib/faturamento');
const cob = require('./lib/cobranca');

const SENHA = 'demo12345';
const SENHA_PORTAL = 'portal12345';
const db = abrir();
if (db.prepare("SELECT 1 FROM usuarios WHERE email = 'demo@managerprovedor.local'").get()) {
  console.log('A organização demonstrativa já existe (demo@managerprovedor.local).');
  process.exit(0);
}
const org = criarOrganizacao(db, { nome: 'Provedor Demonstração', demonstracao: true });
db.prepare("UPDATE organizacoes SET nome = 'Provedor Demonstração · Praia Grande' WHERE id = ?").run(org);
const PERFIS = { demo: 'admin', 'gestor.demo': 'gestor', 'noc.demo': 'noc', 'frota.demo': 'frota', 'lucas.demo': 'tecnico', 'rafael.demo': 'tecnico', 'bruno.demo': 'tecnico',
  'comissoes.demo': 'comissoes', 'financeiro.demo': 'financeiro', 'tv.demo': 'consulta' };
const NOMES = { demo: 'Adriano Almeida', 'gestor.demo': 'Gestão Operacional', 'noc.demo': 'Operador NOC', 'frota.demo': 'Gestão de Frota', 'lucas.demo': 'Lucas Oliveira',
  'rafael.demo': 'Rafael Santos', 'bruno.demo': 'Bruno Costa', 'comissoes.demo': 'Conferência', 'financeiro.demo': 'Financeiro', 'tv.demo': 'Painel TV' };
const ids = {};
for (const [k, perfil] of Object.entries(PERFIS)) {
  ids[k] = Number(db.prepare('INSERT INTO usuarios (organizacao_id, nome, email, senha_hash, perfil, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
    .run(org, NOMES[k], `${k}@managerprovedor.local`, hashSenha(SENHA), perfil, agora()).lastInsertRowid);
}

const servidor = criarApp(db).listen(0, async () => {
  const base = `http://127.0.0.1:${servidor.address().port}/api`;
  const tokens = {};
  const req = async (quem, metodo, caminho, corpo) => {
    tokens[quem] ??= (await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${quem}@managerprovedor.local`, senha: SENHA }) })).json()).token;
    const r = await fetch(base + caminho, { method: metodo, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[quem]}` }, body: corpo ? JSON.stringify(corpo) : undefined });
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${metodo} ${caminho}: ${r.status} ${JSON.stringify(d)}`);
    return d;
  };
  const post = (q, c, b) => req(q, 'POST', c, b);
  /** Envia um arquivo de texto cru (o retorno do banco não é JSON). */
  const postTexto = async (quem, caminho, texto, nome) => {
    const r = await fetch(base + caminho, { method: 'POST', body: texto,
      headers: { 'Content-Type': 'text/plain', 'X-Nome-Arquivo': nome, Authorization: `Bearer ${tokens[quem]}` } });
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`POST ${caminho}: ${r.status} ${JSON.stringify(d)}`);
    return d;
  };
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a1b30000000049454e44ae426082', 'hex');
  const anexar = async (quem, recurso, id) => (await (await fetch(`${base}/anexos?recurso=${recurso}&recurso_id=${id}`, { method: 'POST',
    headers: { Authorization: `Bearer ${tokens[quem]}`, 'X-Nome-Arquivo': 'foto-demo.png' }, body: PNG })).json());
  const dias = (n) => new Date(Date.now() + n * 86400_000);
  const dia = (n) => dias(n).toISOString().slice(0, 10);
  const horas = (n) => new Date(Date.now() + n * 3600_000).toISOString();

  try {
    // Equipe
    const tec = {};
    for (const [k, esp, reg] of [['lucas.demo', 'Instalação e reparo', 'Ocian, Mirim'], ['rafael.demo', 'Fibra óptica e fusão', 'Tupi, Aviação'], ['bruno.demo', 'Instalação e reparo', 'Mirim, Ocian']]) {
      tec[k] = (await post('demo', '/equipe/tecnicos', { nome: NOMES[k], usuario_id: ids[k], especialidades: esp, regioes: reg, equipe: 'Campo' })).id;
    }
    tec.diego = (await post('demo', '/equipe/tecnicos', { nome: 'Diego Almeida', especialidades: 'Manutenção de rede', regioes: 'Todas' })).id;

    // Rede: POP, OLT, CEOs, CTOs e ligações (coordenadas de exemplo em Praia Grande/SP).
    const pop = await post('noc.demo', '/rede/ativos', { tipo: 'pop', codigo: 'POP-PG-01', nome: 'POP Centro', bairro: 'Boqueirão', endereco: 'Rua Exemplo, 100', lat: -24.0035, lng: -46.4135 });
    const olt = await post('noc.demo', '/rede/equipamentos', { tipo: 'olt', nome: 'OLT-PG-01', ativo_id: pop.id, fabricante: 'Exemplo', modelo: 'GPON 16P', monitoramento_id: 'olt-pg-01' });
    await post('noc.demo', '/rede/equipamentos', { tipo: 'roteador', nome: 'RT-BORDA-01', ativo_id: pop.id, monitoramento_id: 'rt-borda-01' });
    const cabo = await post('noc.demo', '/rede/cabos', { codigo: 'CB-AS80-48F', fibras: 48, tipo: 'AS-80', comprimento_m: 3200 });
    const cabo12 = await post('noc.demo', '/rede/cabos', { codigo: 'CB-AS80-12F', fibras: 12, tipo: 'AS-80', comprimento_m: 900 });
    const ceo1 = await post('noc.demo', '/rede/ativos', { tipo: 'ceo', codigo: 'CEO-OCN-003', bairro: 'Ocian', endereco: 'Av. Exemplo, 520', capacidade: 48, bandejas: 4, lat: -24.0062, lng: -46.4252 });
    const ceo2 = await post('noc.demo', '/rede/ativos', { tipo: 'ceo', codigo: 'CEO-TUP-001', bairro: 'Tupi', capacidade: 24, bandejas: 2, lat: -24.0035, lng: -46.4368 });
    await post('noc.demo', '/rede/enlaces', { origem_id: ceo1.id, destino_id: pop.id, cabo_id: cabo.id, fibras: '1-12' });
    await post('noc.demo', '/rede/enlaces', { origem_id: ceo2.id, destino_id: pop.id, cabo_id: cabo.id, fibras: '13-24' });
    const ctos = [];
    for (const [codigo, bairro, pon, lat, lng, alim, ocup] of [
      ['CTO-OCN-024', 'Ocian', '1/1/4', -24.0098, -46.4231, ceo1, 14], ['CTO-MRM-014', 'Mirim', '1/1/5', -24.0075, -46.4176, ceo1, 12],
      ['CTO-TUP-008', 'Tupi', '1/1/3', -24.0012, -46.4432, ceo2, 10], ['CTO-AVI-011', 'Aviação', '1/1/2', -24.0071, -46.4405, ceo2, 7]]) {
      const c = await post('noc.demo', '/rede/ativos', { tipo: 'cto', codigo, bairro, capacidade: 16, splitter: '1:16', equipamento_id: olt.id, pon, lat, lng, endereco: `Rua Exemplo de ${bairro}` });
      await post('noc.demo', '/rede/enlaces', { origem_id: c.id, destino_id: alim.id, cabo_id: cabo12.id });
      const portas = db.prepare('SELECT id FROM portas_rede WHERE ativo_id = ? ORDER BY numero').all(c.id);
      for (let i = 0; i < ocup; i++) await post('noc.demo', `/rede/portas/${portas[i].id}/ocupar`, { cliente_ref: `DEMO-${codigo.slice(4, 7)}-${String(i + 1).padStart(3, '0')}`, onu_ref: `ONU-${i + 1}` });
      ctos.push(c);
    }
    const ceoDet = db.prepare('SELECT id FROM bandejas WHERE ceo_id = ? ORDER BY numero').all(ceo1.id);
    for (let f = 1; f <= 6; f++) await post('noc.demo', `/rede/ativos/${ceo1.id}/fusoes`, { bandeja_id: ceoDet[0].id, a: { cabo_id: cabo.id, tubo: 1, fibra: f }, b: { cabo_id: cabo12.id, tubo: 1, fibra: f } });
    await post('noc.demo', `/rede/ativos/${ctos[3].id}/inspecao`, { status_operacional: 'operacional', evidencia: 'Vistoria de exemplo: caixa fechada, conectores limpos.' });

    // Monitoramento: coletor e amostras simuladas (degradação na PON 1/1/5 ainda aberta e um evento resolvido no histórico).
    await post('demo', '/noc/regras', { nome: 'Potência óptica baixa', metrica: 'optical_rx_dbm', comparacao: 'menor', limiar: -27, limiar_recuperacao: -25, confirmacoes: 2, severidade: 'alta' });
    await post('demo', '/noc/coletores', { nome: 'Coletor demonstrativo' });
    const eq = db.prepare('SELECT * FROM equipamentos WHERE id = ?').get(olt.id);
    const rt = db.prepare("SELECT * FROM equipamentos WHERE monitoramento_id = 'rt-borda-01' AND organizacao_id = ?").get(org);
    let n = 0;
    const amostra = (e, metrica, valor, em, ponto = null, unidade = null) => {
      const a = { origem_evento_id: `demo-${++n}`, fonte: 'coletor-demonstrativo', alvo_id: e.monitoramento_id, ponto, metrica, valor, unidade, observado_em: em };
      db.prepare(`INSERT INTO amostras (organizacao_id, fonte, origem_evento_id, equipamento_id, alvo_id, ponto, metrica, valor, unidade, observado_em, recebido_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(org, a.fonte, a.origem_evento_id, e.id, a.alvo_id, ponto, metrica, valor, unidade, em, agora());
      processarAmostra(db, org, a, e);
    };
    for (let m = 24 * 60; m >= 0; m -= 30) {
      const em = new Date(Date.now() - m * 60_000).toISOString();
      amostra(eq, 'disponibilidade', 1, em);
      amostra(rt, 'disponibilidade', m > 600 && m <= 660 ? 0 : 1, em);
      amostra(eq, 'optical_rx_dbm', m <= 60 ? Math.round((-28.1 - (60 - m) / 100) * 10) / 10 : m > 300 && m <= 400 ? -27.6 : -22.4, em, '1/1/5', 'dBm');
    }
    await post('noc.demo', '/noc/incidentes', { titulo: 'Rompimento de fibra informado pelo campo · Ocian', severidade: 'critica', ativo_id: ctos[0].id, causa_provavel: 'Poste abalroado (relato do campo)' });

    // Frota
    const veic = {};
    for (const [placa, marca, modelo, ano, comb, tanque, odo, resp] of [
      ['FRT2A41', 'Fiat', 'Strada', 2024, 'flex', 55, 48240, 'lucas.demo'], ['GKV8B32', 'Fiat', 'Fiorino', 2023, 'flex', 50, 62450, null],
      ['EQP4C17', 'Chevrolet', 'S10', 2024, 'diesel', 76, 32180, 'rafael.demo'], ['HBL1D09', 'Chevrolet', 'Onix', 2025, 'flex', 44, 22810, 'bruno.demo']]) {
      veic[placa] = await post('frota.demo', '/frota/veiculos', { placa, marca, modelo, ano, combustivel: comb, tanque_litros: tanque, odometro_km: odo, categoria: modelo === 'Onix' ? 'passeio' : 'utilitario' });
      if (resp) await post('frota.demo', `/frota/veiculos/${veic[placa].id}/responsavel`, { tecnico_id: tec[resp], motivo: 'Escala demonstrativa' });
    }
    const oficina = await post('frota.demo', '/frota/fornecedores', { nome: 'Oficina Exemplo', tipo: 'oficina', telefone: '13999990000', especialidades: 'Mecânica geral, freios' });
    const lava = await post('frota.demo', '/frota/fornecedores', { nome: 'Lava-rápido Exemplo', tipo: 'lavagem' });
    await post('frota.demo', '/frota/fornecedores', { nome: 'Posto Exemplo', tipo: 'posto' });
    for (const [placa, item, d, k, ud, uk] of [['FRT2A41', 'oleo', 180, 10000, -120, 39500], ['FRT2A41', 'pneus', 365, 40000, -200, 20000], ['GKV8B32', 'oleo', 180, 10000, -170, 52600],
      ['EQP4C17', 'revisao', 365, 20000, -90, 20000], ['HBL1D09', 'oleo', 180, 10000, -40, 18000]]) {
      await post('frota.demo', '/manutencao/planos', { veiculo_id: veic[placa].id, item, intervalo_dias: d, intervalo_km: k, ultima_data: dia(ud), ultimo_km: uk });
    }
    const planoFiorino = db.prepare("SELECT id FROM planos_preventivos WHERE veiculo_id = ? AND item = 'oleo'").get(veic.GKV8B32.id).id;
    let o = await post('frota.demo', '/manutencao/ordens', { veiculo_id: veic.GKV8B32.id, tipo: 'preventiva', plano_id: planoFiorino, descricao: 'Troca de óleo e filtros', fornecedor_id: oficina.id,
      custo_previsto: '420,00', data_planejada: dia(0), indisponivel_inicio: dia(0), indisponivel_fim: dia(1) });
    for (const st of ['aprovado', 'em_execucao']) o = await post('frota.demo', `/manutencao/ordens/${o.id}/status`, { status: st, versao: o.versao });
    let l = await post('frota.demo', '/manutencao/ordens', { veiculo_id: veic.EQP4C17.id, tipo: 'lavagem', lavagem_tipo: 'completa', descricao: 'Lavagem completa', fornecedor_id: lava.id, data_planejada: dia(-3) });
    l = await post('frota.demo', `/manutencao/ordens/${l.id}/status`, { status: 'concluido', custo_realizado: '80,00', versao: l.versao });
    await post('frota.demo', '/manutencao/ordens', { veiculo_id: veic.FRT2A41.id, tipo: 'preventiva', descricao: 'Revisão dos 50.000 km', fornecedor_id: oficina.id, data_planejada: dia(4), km_planejado: 50000 });
    await post('frota.demo', `/frota/veiculos/${veic.HBL1D09.id}/documentos`, { tipo: 'licenciamento', numero: 'DEMO-0001', vencimento: dia(12) });

    // Abastecimentos com dois ciclos de tanque cheio na Strada.
    let odo = 47200;
    for (const [h, litros, preco, cheio] of [[-240, '42,5', '5,79', true], [-170, '15', '5,85', false], [-120, '30,2', '5,89', true], [-48, '38,0', '5,92', true]]) {
      odo += 300 + Math.round(Math.abs(h));
      await post('frota.demo', '/combustivel/abastecimentos', { veiculo_id: veic.FRT2A41.id, tecnico_id: tec['lucas.demo'], data_hora: horas(h), combustivel: 'gasolina', odometro_km: Math.min(odo, 48240),
        litros, preco_litro: preco, tanque_cheio: cheio, posto: 'Posto Exemplo' });
    }
    await post('frota.demo', '/combustivel/abastecimentos', { veiculo_id: veic.EQP4C17.id, tecnico_id: tec['rafael.demo'], data_hora: horas(-30), combustivel: 'diesel', odometro_km: 32180, litros: '60', preco_litro: '6,19', tanque_cheio: true });

    // Comissões (valores de exemplo) e chamados em vários estados.
    for (const [tipo, nome, valor, extra] of [['instalacao', 'Instalação', '60,00', {}], ['reparo', 'Reparo', '35,00', {}], ['fusao', 'Fusão', '7,50', { modo: 'por_unidade', campo_unidade: 'fibras_fundidas' }]]) {
      await post('comissoes.demo', '/equipe/regras', { tipo_servico: tipo, nome, valor, ...extra });
    }
    const criar = (b) => post('gestor.demo', '/chamados', b);
    const atribuir = async (c, t, v) => post('gestor.demo', `/chamados/${c.id}/atribuir`, { tecnico_id: tec[t], veiculo_id: v ? veic[v].id : null, versao: c.versao, aceitar_conflito: true });
    const inc = db.prepare("SELECT id FROM incidentes WHERE organizacao_id = ? AND origem = 'manual'").get(org).id;
    await criar({ tipo: 'reparo', titulo: 'Rompimento de fibra na CTO-OCN-024', prioridade: 'critica', ativo_id: ctos[0].id, incidente_id: inc, prazo: horas(4) });
    let c2 = await criar({ tipo: 'manutencao_rede', titulo: 'Verificar sinal degradado na PON 1/1/5', prioridade: 'alta', ativo_id: ctos[1].id, prazo: horas(8) });
    c2 = await atribuir(c2, 'bruno.demo', 'HBL1D09');
    c2 = await req('bruno.demo', 'POST', `/chamados/${c2.id}/iniciar-rota`, { versao: c2.versao });
    let c3 = await criar({ tipo: 'instalacao', titulo: 'Instalação residencial', prioridade: 'media', bairro: 'Tupi', cliente_ref: 'DEMO-CLI-9001', ativo_id: ctos[2].id, agendado_para: horas(2), prazo: horas(26) });
    c3 = await atribuir(c3, 'rafael.demo', 'EQP4C17');
    c3 = await req('rafael.demo', 'POST', `/chamados/${c3.id}/iniciar`, { versao: c3.versao });
    await criar({ tipo: 'vistoria', titulo: 'Vistoria preventiva CEO-TUP-001', prioridade: 'baixa', ativo_id: ceo2.id, agendado_para: horas(30) });
    // Um reparo concluído e aprovado (gera comissão aguardando aprovação) e uma instalação em validação.
    let c4 = await criar({ tipo: 'reparo', titulo: 'Cliente sem conexão · drop rompido', prioridade: 'alta', bairro: 'Mirim', cliente_ref: 'DEMO-MRM-004' });
    c4 = await atribuir(c4, 'lucas.demo', 'FRT2A41');
    c4 = await req('lucas.demo', 'POST', `/chamados/${c4.id}/iniciar`, { versao: c4.versao });
    const f4 = await anexar('lucas.demo', 'chamado', c4.id);
    for (const [k, b] of [['potencia_antes', { valor: '-31,2' }], ['potencia_depois', { valor: '-19,6' }], ['causa', { valor: 'Drop rompido na fachada' }], ['foto', { anexo_id: f4.id }]]) {
      await req('lucas.demo', 'PUT', `/chamados/${c4.id}/checklist/${k}`, b);
    }
    c4 = await req('lucas.demo', 'GET', `/chamados/${c4.id}`);
    c4 = await req('lucas.demo', 'POST', `/chamados/${c4.id}/concluir`, { versao: c4.versao, observacao: 'Drop substituído' });
    await post('gestor.demo', `/chamados/${c4.id}/validar`, { decisao: 'aprovar', versao: c4.versao });
    let c5 = await criar({ tipo: 'instalacao', titulo: 'Instalação empresarial', prioridade: 'media', bairro: 'Aviação', ativo_id: ctos[3].id });
    c5 = await atribuir(c5, 'lucas.demo', 'FRT2A41');
    c5 = await req('lucas.demo', 'POST', `/chamados/${c5.id}/iniciar`, { versao: c5.versao });
    const f5 = await anexar('lucas.demo', 'chamado', c5.id);
    for (const [k, b] of [['porta', { valor: 'Porta 8' }], ['potencia_final', { valor: '-18,9' }], ['teste_final', { valor: true }], ['foto', { anexo_id: f5.id }]]) {
      await req('lucas.demo', 'PUT', `/chamados/${c5.id}/checklist/${k}`, b);
    }
    c5 = await req('lucas.demo', 'GET', `/chamados/${c5.id}`);
    await req('lucas.demo', 'POST', `/chamados/${c5.id}/concluir`, { versao: c5.versao });


    /*
     * Assinantes, contratos e financeiro. As competências são calculadas a partir de hoje, então a demonstração
     * sempre tem um mês fechado, um mês corrente, faturas pagas, faturas vencidas e serviço cortado pela régua.
     */
    const HOJE = dia(0);
    const C_ATUAL = fat.competenciaDe(HOJE);
    const C_ANTERIOR = fat.somarMeses(C_ATUAL, -1);
    const C_RETRASADA = fat.somarMeses(C_ATUAL, -2);
    const fin = (c, b) => post('financeiro.demo', c, b);

    const planos = {};
    for (const [chave, b] of Object.entries({
      f300: { nome: 'Fibra 300', tipo: 'internet', tecnologia: 'fibra', download_mbps: 300, upload_mbps: 150, mensalidade: '89,90', instalacao: '150,00', fidelidade_meses: 12 },
      f500: { nome: 'Fibra 500', tipo: 'internet', tecnologia: 'fibra', download_mbps: 500, upload_mbps: 250, mensalidade: '109,90', instalacao: '150,00', fidelidade_meses: 12 },
      f700: { nome: 'Fibra 700 + Wi-Fi 6', tipo: 'internet', tecnologia: 'fibra', download_mbps: 700, upload_mbps: 350, mensalidade: '149,90', instalacao: '0,00', fidelidade_meses: 12 },
      combo: { nome: 'Combo Fibra 500 + Voz', tipo: 'combo', tecnologia: 'fibra', download_mbps: 500, upload_mbps: 250, mensalidade: '129,90', instalacao: '99,00', fidelidade_meses: 12 },
      empresarial: { nome: 'Empresarial 600 dedicado', tipo: 'internet', tecnologia: 'fibra', download_mbps: 600, upload_mbps: 600, mensalidade: '399,00', instalacao: '450,00' },
    })) planos[chave] = await fin('/planos', b);

    // Portas livres das CTOs, para o contrato ocupar o ponto de verdade na planta.
    const livres = db.prepare(`SELECT id FROM portas_rede WHERE ativo_id IN (${ctos.map(() => '?').join(',')}) AND situacao = 'livre' AND em_uso = 1
      ORDER BY ativo_id, numero`).all(...ctos.map((c) => c.id));

    // [nome, documento, tipo, telefone, bairro, rua, numero, plano, dia de vencimento, ativação, situação final]
    const CARTEIRA = [
      ['Maria Souza Lima', '390.533.447-05', 'pf', '13991110001', 'Ocian', 'Rua das Gaivotas', '120', 'f500', 20, `${C_ANTERIOR}-08`, 'ativo'],
      ['José Carlos Pereira', '111.444.777-35', 'pf', '13991110002', 'Mirim', 'Av. dos Jacarandás', '455', 'f300', 10, dia(-200), 'ativo'],
      ['Ana Paula Rodrigues', '529.982.247-25', 'pf', '13991110003', 'Tupi', 'Rua dos Corais', '78', 'f700', 5, dia(-420), 'ativo'],
      ['Padaria Pão Quente ME', '45.997.418/0001-53', 'pj', '1334440004', 'Aviação', 'Av. Central', '1020', 'empresarial', 10, dia(-150), 'inadimplente'],
      ['Carlos Eduardo Dias', '693.419.080-78', 'pf', '13991110005', 'Ocian', 'Rua das Pitangueiras', '33', 'combo', 15, dia(-95), 'inadimplente'],
      ['Fernanda Alves Costa', '040.981.520-96', 'pf', '13991110006', 'Mirim', 'Rua do Farol', '610', 'f300', 25, dia(-60), 'ativo'],
      ['Mercado Bom Preço Ltda', '19.131.243/0001-97', 'pj', '1334440007', 'Tupi', 'Rua do Comércio', '240', 'combo', 10, dia(-30), 'ativo'],
      ['Roberto Nunes Teixeira', '370.527.980-77', 'pf', '13991110008', 'Aviação', 'Rua das Acácias', '12', 'f500', 20, null, 'implantacao'],
      ['Luciana Martins Reis', '818.233.740-26', 'pf', '13991110009', 'Ocian', 'Rua das Hortênsias', '505', 'f300', 10, dia(-380), 'cancelado'],
    ];
    const carteira = [];
    for (const [nome, documento, tipo, telefone, bairro, rua, numero, plano, venc, ativacao, destino] of CARTEIRA) {
      const cto = ctos[carteira.length % ctos.length];
      /*
       * Endereço do assinante perto da caixa que o atende, que é como fica no mundo real: a casinha do mapa
       * cai a uma quadra da CTO, não em cima dela. O desvio é determinístico para a demonstração ser sempre
       * igual. Dois contratos ficam DE PROPÓSITO sem coordenada, para a aba "Fora do mapa" ter o que mostrar
       * — todo provedor tem cadastro assim, e o mapa não pode escondê-los.
       */
      const i = carteira.length;
      const semCoordenada = i === 6 || i === 7;
      const ponto = semCoordenada ? {} : {
        latitude: Number((cto.lat + ((i % 3) - 1) * 0.0011 + (i % 2 ? 0.0004 : -0.0004)).toFixed(6)),
        longitude: Number((cto.lng + ((i % 4) - 1.5) * 0.0013).toFixed(6)),
      };
      const a = await fin('/assinantes', { tipo, nome, documento, telefone, email: `${nome.split(' ')[0].toLowerCase()}@exemplo.com`,
        cep: '11701000', logradouro: rua, numero, bairro, cidade: 'Praia Grande', uf: 'SP', consentimento: true, ...ponto });
      // Uma porta livre por contrato: a reserva acompanha o contrato mesmo antes de o serviço ser ativado.
      const portaId = livres[carteira.length]?.id;
      const c = await fin('/contratos', { assinante_id: a.id, plano_id: planos[plano].id, dia_vencimento: venc,
        cto_id: cto.id, porta_id: portaId, ...ponto });
      if (ativacao) await fin(`/contratos/${c.id}/ativar`, { ativacao, porta_id: portaId });
      carteira.push({ assinante: a, contrato: c, destino, plano });
    }

    // Serviços adicionais e um desconto de fidelidade, com vigência por competência.
    await fin(`/contratos/${carteira[0].contrato.id}/itens`, { descricao: 'Streaming parceiro', tipo: 'sva', valor: '19,90', inicio: C_ANTERIOR });
    await fin(`/contratos/${carteira[2].contrato.id}/itens`, { descricao: 'Aluguel de roteador Wi-Fi 6', tipo: 'equipamento', valor: '15,00', inicio: C_RETRASADA });
    await fin(`/contratos/${carteira[2].contrato.id}/itens`, { descricao: 'Desconto fidelidade', tipo: 'desconto', valor: '10,00', inicio: C_RETRASADA });
    await fin(`/contratos/${carteira[6].contrato.id}/itens`, { descricao: 'Ponto adicional', tipo: 'ponto_adicional', valor: '29,90', inicio: C_ATUAL });

    // Régua de cobrança da operação.
    for (const r of [
      { nome: 'Lembrete antes do vencimento', dias: -3, acao: 'avisar', canal: 'whatsapp', texto: 'Sua fatura vence em 3 dias. Qualquer dúvida, estamos à disposição.' },
      { nome: 'Aviso de atraso', dias: 1, acao: 'avisar', canal: 'whatsapp', texto: 'Identificamos que sua fatura venceu ontem. O serviço segue ativo durante a carência.' },
      { nome: 'Corte por inadimplência', dias: 7, acao: 'bloquear' },
      { nome: 'Indicar para cancelamento', dias: 45, acao: 'indicar_cancelamento' },
    ]) await fin('/cobranca/regras', r);

    // Faturamento dos três meses e baixa de quem está em dia.
    for (const competencia of [C_RETRASADA, C_ANTERIOR, C_ATUAL]) await fin('/faturamento/ciclos', { competencia });
    const inadimplentes = new Set(carteira.filter((x) => x.destino === 'inadimplente').map((x) => x.contrato.id));
    for (const f of db.prepare(`SELECT * FROM faturas WHERE organizacao_id = ? AND situacao = 'aberta' ORDER BY vencimento`).all(org)) {
      if (inadimplentes.has(f.contrato_id) || f.vencimento > HOJE) continue;
      await fin(`/faturamento/faturas/${f.id}/pagamentos`, { forma: f.numero % 3 === 0 ? 'boleto' : 'pix', data: f.vencimento });
    }
    // Uma fatura em dia com pagamento parcial, para a tela mostrar o saldo remanescente.
    const parcial = db.prepare(`SELECT * FROM faturas WHERE organizacao_id = ? AND contrato_id = ? AND situacao = 'aberta' ORDER BY vencimento LIMIT 1`)
      .get(org, carteira[5].contrato.id);
    if (parcial) await fin(`/faturamento/faturas/${parcial.id}/pagamentos`, { valor: '40,00', forma: 'pix', data: HOJE });

    // Cobrança avulsa de uma visita técnica.
    await fin('/faturamento/faturas', { assinante_id: carteira[1].assinante.id, vencimento: dia(8),
      itens: [{ descricao: 'Visita técnica a pedido do assinante', valor: '80,00' }], observacoes: 'Mudança de ponto dentro do imóvel.' });

    // A régua roda e corta quem passou da carência; um dos cortados recebe desbloqueio de confiança.
    const execucao = cob.rotinaDiaria(db, org, HOJE);
    const cortado = db.prepare("SELECT * FROM contratos WHERE organizacao_id = ? AND situacao = 'bloqueado' ORDER BY id LIMIT 1").get(org);
    if (cortado) {
      await post('financeiro.demo', `/cobranca/contratos/${cortado.id}/confianca`, { dias: 3, motivo: 'Assinante informou pagamento para esta semana.' })
        .catch(() => { /* sem bloqueio por inadimplência: segue sem confiança */ });
    }
    // Contrato encerrado, para o histórico de churn existir.
    const encerrado = carteira.find((x) => x.destino === 'cancelado');
    if (encerrado) await fin(`/contratos/${encerrado.contrato.id}/cancelar`, { motivo: 'Mudança para outra cidade', data: dia(-20) });

    /*
     * Cobrança bancária. A conta é cadastrada com um convênio de demonstração e fica marcada como layout
     * NÃO conferido — que é o estado real de qualquer provedor antes de pagar o primeiro boleto de teste.
     * O PIX sai para toda fatura em aberto (depende só da chave); o boleto sai para parte delas, vai na
     * remessa, e um retorno do banco fica aguardando conferência, para a tela de conferência ter o que mostrar.
     */
    const conta = await post('demo', '/cobrancas/contas', {
      nome: 'Itaú cobrança', banco: '341', agencia: '0912', conta: '34567', conta_dv: '8', carteira: '109', convenio: '34567',
      beneficiario_nome: 'Provedor Demonstração LTDA', beneficiario_documento: '11.222.333/0001-81',
      beneficiario_endereco: 'Av. das Fibras, 1000', beneficiario_cidade: 'PONTA GROSSA', beneficiario_uf: 'PR', beneficiario_cep: '84010-000',
      chave_pix: 'financeiro@provedor-demo.com.br', chave_pix_tipo: 'email',
      emite_boleto: true, emite_pix: true, padrao: true,
      observacoes: 'Convênio de demonstração. Nenhum boleto daqui foi conferido com o banco.',
    });
    const emAberto = db.prepare("SELECT * FROM faturas WHERE organizacao_id = ? AND situacao IN ('aberta','parcial') ORDER BY vencimento").all(org);
    const comBoleto = [];
    for (const [i, f] of emAberto.entries()) {
      await fin(`/cobrancas/faturas/${f.id}/emitir`, { tipo: 'pix', conta_id: conta.id });
      if (i % 2 === 0) comBoleto.push(await fin(`/cobrancas/faturas/${f.id}/emitir`, { tipo: 'boleto', conta_id: conta.id }));
    }
    const remessa = comBoleto.length ? await fin('/cobrancas/remessas', { conta_id: conta.id }) : null;

    // Retorno de mentira, montado nas posições do CNAB 400, com dois títulos liquidados e um registro sem par.
    if (comBoleto.length >= 2) {
      const ddmmaa = (iso) => `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(2, 4)}`;
      const linha = (c) => {
        const l = Array(400).fill(' ');
        const por = (de, ate, v) => { const t = String(v).slice(0, ate - de + 1).padStart(ate - de + 1, '0'); for (let i = 0; i < t.length; i++) l[de - 1 + i] = t[i]; };
        l[0] = '1';
        por(38, 62, c.nosso_numero); por(109, 110, c.ocorrencia); por(111, 116, ddmmaa(HOJE));
        por(117, 126, c.documento); por(147, 152, ddmmaa(c.vencimento)); por(153, 165, c.valor_centavos);
        por(254, 266, c.valor_pago_centavos ?? c.valor_centavos); por(267, 279, c.juros_centavos ?? 0); por(296, 301, ddmmaa(HOJE));
        return l.join('');
      };
      const cabeca = Array(400).fill(' ');
      cabeca[0] = '0';
      for (let i = 0; i < 3; i++) cabeca[76 + i] = '341'[i];
      for (let i = 0; i < 6; i++) cabeca[94 + i] = ddmmaa(HOJE)[i];
      const numeroDe = (id) => db.prepare('SELECT numero FROM faturas WHERE id = ?').get(id).numero;
      const arquivo = [cabeca.join(''),
        linha({ nosso_numero: `${comBoleto[0].nosso_numero}${comBoleto[0].nosso_numero_dv ?? ''}`, ocorrencia: '06',
          documento: numeroDe(comBoleto[0].fatura_id), vencimento: comBoleto[0].vencimento, valor_centavos: comBoleto[0].valor_centavos }),
        linha({ nosso_numero: `${comBoleto[1].nosso_numero}${comBoleto[1].nosso_numero_dv ?? ''}`, ocorrencia: '02',
          documento: numeroDe(comBoleto[1].fatura_id), vencimento: comBoleto[1].vencimento, valor_centavos: comBoleto[1].valor_centavos }),
        // Um registro que não casa com nada: é assim que a tela mostra o que NÃO deve ser aplicado.
        linha({ nosso_numero: '999999', ocorrencia: '06', documento: '999999', vencimento: HOJE, valor_centavos: 7890 }),
        `${'9'}${' '.repeat(399)}`].join('\r\n');
      await postTexto('financeiro.demo', '/cobrancas/retornos', arquivo, 'CB341DEMO.RET');
    }

    /*
     * Provisionamento: o concentrador fica cadastrado com driver e papel, mas SEM acesso de gerência — não há
     * equipamento de verdade para apontar, e inventar um endereço faria a tela mentir. Os serviços são criados
     * com login e ONU, e aparecem como "nunca lidos": é exatamente o que o sistema mostra antes do primeiro contato.
     */
    const bras = await post('noc.demo', '/rede/equipamentos', { tipo: 'roteador', nome: 'BRAS-PG-01', ativo_id: pop.id, fabricante: 'MikroTik', modelo: 'CCR2004' });
    db.prepare("UPDATE equipamentos SET driver = 'mikrotik_routeros', papel = 'concentrador' WHERE id = ?").run(bras.id);
    let provisionados = 0;
    for (const x of carteira) {
      // Contrato cancelado não recebe provisionamento, e o que está em implantação ainda não tem serviço.
      if (x.destino === 'cancelado' || x.destino === 'implantacao') continue;
      const primeiro = x.assinante.nome.split(' ')[0].toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');
      await req('financeiro.demo', 'PUT', `/provisionamento/contratos/${x.contrato.id}/servico`, {
        concentrador_id: bras.id, tipo_acesso: 'pppoe', login: `${primeiro}.${x.contrato.numero}`,
        pon: `1/1/${(provisionados % 4) + 2}`, onu_serial: `ALCL${String(10000 + provisionados * 137).padStart(8, '0')}`,
      });
      provisionados += 1;
    }

    /*
     * ACS e aparelhos dos assinantes. O ACS fica configurado e os CPEs aparecem como se já tivessem ligado
     * uma vez — que é o estado real de quem acabou de apontar a base para o ACS. Nenhum aparelho é inventado
     * com credencial de chamada: sem ela, a tela diz corretamente que a mudança espera o contato do aparelho.
     */
    await req('demo', 'PUT', '/cpes/acs', { usuario: 'acs', senha: 'senha-do-acs-demonstrativa', url: 'https://demonstracao.exemplo/network/api/acs' });
    const MODELOS_CPE = [['Intelbras', 'TWIBAM GPON', 'tr098'], ['Huawei', 'EG8145V5', 'tr098'], ['ZTE', 'F670L', 'tr181'], ['Nokia', 'G-1425G-A', 'tr181']];
    let aparelhos = 0;
    for (const x of carteira) {
      const servico = db.prepare('SELECT id FROM servicos WHERE contrato_id = ?').get(x.contrato.id);
      if (!servico || aparelhos >= 5) continue;
      const [fabricante, modeloCpe, dados] = MODELOS_CPE[aparelhos % MODELOS_CPE.length];
      const raiz = dados === 'tr181' ? 'Device' : 'InternetGatewayDevice';
      const wlan = dados === 'tr181' ? 'Device.WiFi.SSID.1.SSID' : `${raiz}.LANDevice.1.WLANConfiguration.1.SSID`;
      const canal = dados === 'tr181' ? 'Device.WiFi.Radio.1.Channel' : `${raiz}.LANDevice.1.WLANConfiguration.1.Channel`;
      const serial = `${fabricante.slice(0, 2).toUpperCase()}${String(480000 + aparelhos * 7919)}`;
      db.prepare(`INSERT INTO cpes (organizacao_id, serial, oui, classe, fabricante, modelo, versao_firmware, modelo_dados,
        url_chamado, usuario_chamado, ip, servico_id, ultimo_contato, ultimo_evento, informs, parametros, lido_em, criado_em)
        VALUES (?, ?, '00259E', ?, ?, ?, ?, ?, ?, 'acs', ?, ?, ?, '2 PERIODIC', ?, ?, ?, ?)`)
        .run(org, serial, modeloCpe, fabricante, modeloCpe, `${1 + aparelhos}.${3 + aparelhos}.2`, dados,
          `http://100.64.${aparelhos}.${10 + aparelhos}:7547/cr`, `100.64.${aparelhos}.${10 + aparelhos}`, servico.id,
          horas(-(2 + aparelhos)), 3 + aparelhos,
          JSON.stringify({ [wlan]: `PROVEDOR-${x.assinante.nome.split(' ')[0].toUpperCase()}`, [canal]: String(1 + aparelhos * 5),
            [`${raiz}.DeviceInfo.UpTime`]: String(86400 * (1 + aparelhos)) }),
          horas(-(2 + aparelhos)), horas(-(2 + aparelhos)));
      aparelhos += 1;
    }

    /*
     * Estado de conexão da demonstração.
     *
     * Em produção isto NUNCA é escrito à mão: vem da varredura das sessões do concentrador. Aqui o
     * concentrador é de mentira e não há equipamento para varrer, então as leituras são gravadas como se a
     * varredura tivesse acabado de rodar — e o console diz isso, para ninguém confundir demonstração com medição.
     *
     * A carteira fica com um de cada caso que o mapa precisa saber distinguir: no ar, caído, cortado por
     * inadimplência, nunca lido e leitura velha.
     */
    const agoraIso = new Date().toISOString();
    const horasAtras = (h) => new Date(Date.now() - h * 3600_000).toISOString();
    const ESTADOS_DEMO = [
      // [índice na carteira, conectado, há quantas horas foi lido, quedas hoje]
      [0, 1, 0.05, 0], [1, 0, 0.05, 2], [2, 1, 0.05, 1], [3, 0, 0.05, 0], [4, 1, 0.05, 0], [5, 1, 30, 0],
    ];
    let comLeitura = 0;
    for (const [i, conectado, horas, quedas] of ESTADOS_DEMO) {
      const alvo = carteira[i];
      const servico = alvo && db.prepare('SELECT * FROM servicos WHERE contrato_id = ?').get(alvo.contrato.id);
      if (!servico) continue;
      const lido = horasAtras(horas);
      db.prepare(`UPDATE servicos SET conectado = ?, conexao_em = ?, conexao_desde = ?, conexao_ip = ?,
        quedas_hoje = ?, quedas_dia = ?, estado_real = ?, lido_em = ? WHERE id = ?`)
        .run(conectado, lido, horasAtras(horas + 3), conectado ? `100.64.0.${10 + i}` : null, quedas, HOJE,
          JSON.stringify({ presente: true, login: servico.login, situacao: 'liberado', conectado: Boolean(conectado) }), lido, servico.id);
      comLeitura += 1;
      // Quedas das últimas horas, para o histórico e o mapa de calor terem o que mostrar.
      for (let q = 0; q < quedas; q++) {
        const caiuEm = horasAtras(horas + 2 + q * 5);
        const voltouEm = horasAtras(horas + 2 + q * 5 - 0.4);
        const posicao = db.prepare('SELECT latitude, longitude FROM contratos WHERE id = ?').get(alvo.contrato.id);
        const gravar = db.prepare(`INSERT INTO conexao_eventos (organizacao_id, servico_id, contrato_id, evento, conectado, duracao_s, ip, lat, lng, em)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        gravar.run(org, servico.id, alvo.contrato.id, 'caiu', 0, 3600 * 6, null, posicao?.latitude ?? null, posicao?.longitude ?? null, caiuEm);
        gravar.run(org, servico.id, alvo.contrato.id, 'voltou', 1, 1440, `100.64.0.${10 + i}`, posicao?.latitude ?? null, posicao?.longitude ?? null, voltouEm);
      }
    }
    const semMapa = db.prepare(`SELECT COUNT(*) AS n FROM contratos c JOIN assinantes a ON a.id = c.assinante_id
      WHERE c.organizacao_id = ? AND c.situacao <> 'cancelado' AND COALESCE(c.latitude, a.latitude) IS NULL`).get(org).n;
    void agoraIso;

    /*
     * Contabilidade: plano padrão, contabilização automática ligada e o histórico do financeiro trazido.
     * Nada é inventado aqui — os lançamentos saem das faturas e baixas que a demonstração já criou.
     */
    await post('demo', '/contabil/plano/padrao', {});
    await req('demo', 'PUT', '/contabil/automatica', { ligada: true });
    const contab = await post('financeiro.demo', '/contabil/pendencias/contabilizar', {});
    // Algumas despesas da operação, para a DRE ter os dois lados e o orçado ter o que comparar.
    const contaDe = (codigo) => db.prepare('SELECT id FROM plano_contas WHERE organizacao_id = ? AND codigo = ?').get(org, codigo).id;
    for (const [codDebito, valor, historico] of [
      ['5.1.01', '4.500,00', 'Trânsito IP do mês'],
      ['5.2.01', '18.400,00', 'Folha de pagamento'],
      ['5.3.02', '1.250,00', 'Energia elétrica do POP'],
      ['5.4.01', '2.100,00', 'Combustível da frota'],
      ['5.3.04', '900,00', 'Honorários contábeis'],
    ]) {
      await post('financeiro.demo', '/contabil/lancamentos', {
        data: dia(-6), historico,
        partidas: [{ conta_id: contaDe(codDebito), tipo: 'D', valor }, { conta_id: contaDe('1.1.02'), tipo: 'C', valor }],
      });
    }
    // Orçamento da competência, para a tela de orçado × realizado mostrar diferença de verdade.
    await req('financeiro.demo', 'PUT', '/contabil/orcamento', { itens: [
      { conta_id: contaDe('4.1.01'), competencia: C_ATUAL, valor: '32.000,00' },
      { conta_id: contaDe('5.1.01'), competencia: C_ATUAL, valor: '4.000,00' },
      { conta_id: contaDe('5.2.01'), competencia: C_ATUAL, valor: '18.000,00' },
      { conta_id: contaDe('5.3.02'), competencia: C_ATUAL, valor: '1.400,00' },
      { conta_id: contaDe('5.4.01'), competencia: C_ATUAL, valor: '1.800,00' },
    ] });
    const bal = await req('financeiro.demo', 'GET', `/contabil/balancete?de=${C_ATUAL}&ate=${C_ATUAL}`);

    /*
     * Portal do assinante: um acesso já ativo, para abrir o portal e olhar, e um convite em aberto,
     * para a equipe ver na ficha como fica um primeiro acesso ainda não usado. O código do convite só
     * existe em claro neste instante — no banco fica o resumo criptográfico dele.
     */
    const comFatura = db.prepare(`SELECT a.id, a.documento, a.nome FROM faturas f JOIN assinantes a ON a.id = f.assinante_id
      WHERE f.organizacao_id = ? AND f.situacao IN ('aberta','parcial') ORDER BY f.vencimento LIMIT 1`).get(org);
    const convite = await post('demo', `/assinantes/${comFatura.id}/portal/convite`, {});
    const ativacao = await fetch(`${base}/portal/ativar`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documento: comFatura.documento, codigo: convite.codigo, senha: SENHA_PORTAL }) });
    if (!ativacao.ok) throw new Error(`ativar portal: ${ativacao.status} ${await ativacao.text()}`);
    const emEspera = carteira.find((x) => x.assinante.id !== comFatura.id);
    const conviteAberto = await post('demo', `/assinantes/${emEspera.assinante.id}/portal/convite`, {});

    console.log(`Carteira demonstrativa: ${carteira.length} assinantes, ${execucao.regua.bloqueios} corte(s) pela régua, ${execucao.regua.avisos} aviso(s) preparado(s).`);
    console.log(`TR-069: ACS configurado e ${aparelhos} aparelho(s) de assinante registrados (sem credencial de chamada: a tela diz que a mudança espera o contato do aparelho).`);
    console.log(`Provisionamento: ${provisionados} serviço(s) no concentrador BRAS-PG-01 (sem acesso de gerência: nenhum equipamento real foi inventado).`);
    console.log(`Cobrança bancária: ${emAberto.length} PIX e ${comBoleto.length} boleto(s) emitidos${remessa ? `, remessa ${remessa.arquivo}` : ''} `
      + '· 1 retorno aguardando conferência · layout do boleto NÃO conferido com o banco (é o que vale para qualquer convênio novo).');

    console.log('Organização demonstrativa criada. Acessos (senha demo12345):');
    for (const [k, p] of Object.entries(PERFIS)) console.log(`  ${k}@managerprovedor.local  (${p})`);
    console.log(`Panorama: ${comLeitura} serviço(s) com estado de conexão gravado COMO SE a varredura tivesse rodado agora `
      + `(não há concentrador real para varrer) · ${semMapa} contrato(s) sem coordenada, de propósito, para a aba "Fora do mapa".`);
    console.log(`Contabilidade: plano padrão, automática ligada, ${contab.faturas} fatura(s) e ${contab.pagamentos} baixa(s) `
      + `contabilizadas a partir do próprio financeiro · balancete de ${C_ATUAL} ${bal.fecha ? 'fecha' : 'NÃO FECHA'}.`);
    console.log(`Portal do assinante em /portal/ : ${comFatura.nome} entra com o documento ${comFatura.documento} e a senha ${SENHA_PORTAL} `
      + `· ${emEspera.assinante.nome} tem convite em aberto (código ${conviteAberto.codigo}, vence ${conviteAberto.expira_em}).`);
    console.log('Rastreador e Downdetector ficam não configurados: não há conexão real inventada.');
  } catch (err) {
    console.error('Falha ao criar a demonstração:', err.message);
    process.exitCode = 1;
  } finally {
    servidor.close();
  }
});
