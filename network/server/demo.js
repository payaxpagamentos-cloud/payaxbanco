'use strict';

/*
 * Ambiente demonstrativo: cria uma organização SEPARADA, marcada como demonstração (a interface mostra o selo
 * "Ambiente demonstrativo"), com pessoas, placas, endereços, valores e medições FICTÍCIOS. Não toca nas outras organizações.
 * Os dados entram pela própria API (com as mesmas validações da operação). Recusa rodar em produção sem NETWORK_PERMITIR_DEMO=1.
 *
 *   npm run demo            → acessos: demo@managernetwork.local (e os demais perfis) / senha demo12345
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
const { demoTrafego } = require('./demo-trafego');

const SENHA = 'demo12345';
const db = abrir();
if (db.prepare("SELECT 1 FROM usuarios WHERE email = 'demo@managernetwork.local'").get()) {
  console.log('A organização demonstrativa já existe (demo@managernetwork.local).');
  process.exit(0);
}
const org = criarOrganizacao(db, { nome: 'Conecta Fibra', demonstracao: true });
db.prepare("UPDATE organizacoes SET nome = 'Conecta Fibra · Praia Grande' WHERE id = ?").run(org);
const PERFIS = { demo: 'admin', 'gestor.demo': 'gestor', 'noc.demo': 'noc', 'frota.demo': 'frota', 'lucas.demo': 'tecnico', 'rafael.demo': 'tecnico', 'bruno.demo': 'tecnico',
  'comissoes.demo': 'comissoes', 'tv.demo': 'consulta' };
const NOMES = { demo: 'Adriano Almeida', 'gestor.demo': 'Gestão Operacional', 'noc.demo': 'Operador NOC', 'frota.demo': 'Gestão de Frota', 'lucas.demo': 'Lucas Oliveira',
  'rafael.demo': 'Rafael Santos', 'bruno.demo': 'Bruno Costa', 'comissoes.demo': 'Conferência', 'tv.demo': 'Painel TV' };
const ids = {};
for (const [k, perfil] of Object.entries(PERFIS)) {
  ids[k] = Number(db.prepare('INSERT INTO usuarios (organizacao_id, nome, email, senha_hash, perfil, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
    .run(org, NOMES[k], `${k}@managernetwork.local`, hashSenha(SENHA), perfil, agora()).lastInsertRowid);
}

const servidor = criarApp(db).listen(0, async () => {
  const base = `http://127.0.0.1:${servidor.address().port}/api`;
  const tokens = {};
  const req = async (quem, metodo, caminho, corpo) => {
    tokens[quem] ??= (await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${quem}@managernetwork.local`, senha: SENHA }) })).json()).token;
    const r = await fetch(base + caminho, { method: metodo, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[quem]}` }, body: corpo ? JSON.stringify(corpo) : undefined });
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${metodo} ${caminho}: ${r.status} ${JSON.stringify(d)}`);
    return d;
  };
  const post = (q, c, b) => req(q, 'POST', c, b);
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

    // Tráfego, Anti-DDoS e sessões dos assinantes (fictícios)
    await demoTrafego(db, org, post);

    console.log('Organização demonstrativa "Conecta Fibra" criada. Acessos (senha demo12345):');
    for (const [k, p] of Object.entries(PERFIS)) console.log(`  ${k}@managernetwork.local  (${p})`);
    console.log('Rastreador, Downdetector e canais de aviso ficam não configurados: não há conexão real inventada.');
    console.log('Para ver a detecção ao vivo: cadastre o exportador 127.0.0.1 (borda), rode "npm run coletor-rede" e "ATAQUE=dns ALVO=203.0.113.10 npm run simulador".');
  } catch (err) {
    console.error('Falha ao criar a demonstração:', err.message);
    process.exitCode = 1;
  } finally {
    servidor.close();
  }
});
