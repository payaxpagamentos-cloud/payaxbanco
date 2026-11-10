'use strict';

/*
 * Dados FICTÍCIOS de tráfego e Anti-DDoS para a organização demonstrativa (provedor "Conecta Fibra").
 * Usa só blocos de documentação (RFC 5737 / RFC 3849): 203.0.113.0/24, 198.51.100.0/24, 192.0.2.128/26 e 2001:db8::/32.
 * Configuração pela API (mesmas validações da operação); séries históricas direto no banco, como o coletor gravaria.
 */

const { agora, proximoNumero } = require('./db');

const LOGINS = ['ana.souza', 'bruno.lima', 'carla.mendes', 'diego.alves', 'elaine.rocha', 'fabio.nunes', 'gabriela.reis', 'heitor.campos', 'iris.moura', 'joao.pereira',
  'karina.dias', 'leandro.vaz', 'marcia.teles', 'nicolas.freitas', 'olivia.prado', 'paulo.barros', 'quiteria.luz', 'rodrigo.paz', 'sabrina.cruz', 'tiago.melo',
  'ursula.gomes', 'vitor.sales', 'wesley.porto', 'yasmin.leal', 'zeca.antunes', 'padaria.sol', 'clinica.vida', 'escola.saber', 'mercado.bom', 'oficina.ze'];

async function demoTrafego(db, org, post) {
  // Configuração pela API (perfil NOC)
  const res = await post('noc.demo', '/ddos/grupos', { nome: 'Clientes residenciais', descricao: 'IPs públicos dos planos residenciais', prefixos: ['203.0.113.0/24', '2001:db8:100::/40'],
    mitigacao_modo: 'manual', mitigacao_tipo: 'flowspec' });
  const corp = await post('noc.demo', '/ddos/grupos', { nome: 'Corporativos', descricao: 'Blocos dedicados de empresas', prefixos: ['198.51.100.0/24'], mitigacao_modo: 'manual', mitigacao_tipo: 'flowspec' });
  const serv = await post('noc.demo', '/ddos/grupos', { nome: 'Servidores e infraestrutura', descricao: 'DNS, portal, monitoramento', prefixos: ['192.0.2.128/26'],
    mitigacao_modo: 'desligada', mitigacao_tipo: 'flowspec' });
  for (const g of [res, corp, serv]) await post('noc.demo', `/ddos/grupos/${g.id}/limites-sugeridos`, {});
  await post('noc.demo', '/ddos/nunca-bloquear', { prefixo: '192.0.2.130', motivo: 'DNS recursivo do provedor' });
  await post('noc.demo', '/ddos/nunca-bloquear', { prefixo: '192.0.2.131', motivo: 'DNS recursivo secundário' });
  await post('noc.demo', '/ddos/nunca-bloquear', { prefixo: '198.51.100.10', motivo: 'Hospital Municipal (cliente crítico)' });
  await post('noc.demo', '/trafego/exportadores', { nome: 'Borda 01 · Huawei NE8000', ip: '10.255.0.1', papel: 'borda', taxa_amostragem: 1000 });
  await post('noc.demo', '/trafego/exportadores', { nome: 'BRAS Centro · MikroTik CCR', ip: '10.255.0.2', papel: 'bras', taxa_amostragem: 1 });
  await post('noc.demo', '/trafego/nas', { nome: 'BRAS Centro', ip: '10.255.0.2', segredo: 'segredo-ficticio-da-demonstracao' });

  const t = agora();
  const agoraMs = Date.now();
  db.prepare("UPDATE exportadores_fluxo SET ultimo_pacote = ?, formato = CASE papel WHEN 'borda' THEN 'NetFlow v9' ELSE 'IPFIX' END, pacotes = 1840211, fluxos = 52310994 WHERE organizacao_id = ?")
    .run(t, org);
  db.prepare('UPDATE radius_nas SET ultimo_pacote = ?, pacotes = 18233 WHERE organizacao_id = ?').run(t, org);

  // Curva diária: pico às 21 h, vale às 5 h. Entrada ~ 4,2 Gbps no pico; saída ~ 12% da entrada.
  const curva = (ms) => {
    const h = (new Date(ms).getUTCHours() - 3 + 24) % 24 + new Date(ms).getUTCMinutes() / 60;
    return 0.25 + 0.75 * (0.5 + 0.5 * Math.cos(((h - 21) / 24) * 2 * Math.PI));
  };
  const insMin = db.prepare(`INSERT OR REPLACE INTO trafego_minuto (organizacao_id, minuto, grupo_id, direcao, bytes, pacotes, fluxos, bytes_tcp, bytes_udp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const grupos = [[res.id, 3.4e9], [corp.id, 0.7e9], [serv.id, 0.1e9]];
  db.exec('BEGIN');
  for (let m = 24 * 60; m >= 1; m--) {
    const ms = agoraMs - m * 60_000;
    const minuto = new Date(ms).toISOString().slice(0, 16);
    for (const [gid, pico] of grupos) {
      const ruido = 0.92 + Math.random() * 0.16;
      const entrada = (pico * curva(ms) * ruido * 60) / 8;
      const saida = entrada * (gid === serv.id ? 1.4 : 0.12);
      insMin.run(org, minuto, gid, 'entrada', entrada, entrada / 1100, entrada / 90_000, entrada * 0.72, entrada * 0.26);
      insMin.run(org, minuto, gid, 'saida', saida, saida / 400, saida / 30_000, saida * 0.8, saida * 0.18);
    }
  }
  // IPs por hora (7 dias) e sessões RADIUS
  const insHora = db.prepare(`INSERT OR REPLACE INTO trafego_ip_hora (organizacao_id, hora, ip, direcao, grupo_id, bytes, pacotes, fluxos) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insSessao = db.prepare(`INSERT INTO sessoes_assinantes (organizacao_id, login, ip, ipv6_delegado, nas_ip, sessao_id, mac, nas_porta, inicio, fim, ultima_atualizacao,
    bytes_entrada, bytes_saida, motivo_fim, fonte) VALUES (?, ?, ?, ?, '10.255.0.2', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'radius')`);
  LOGINS.forEach((login, i) => {
    const corporativo = i >= 25;
    const ip = corporativo ? `198.51.100.${20 + i}` : `203.0.113.${10 + i * 3}`;
    const peso = (corporativo ? 4 : 1) * (0.3 + ((i * 37) % 10) / 6);
    for (let h = 7 * 24; h >= 1; h--) {
      const ms = agoraMs - h * 3600_000;
      const hora = `${new Date(ms).toISOString().slice(0, 13)}:00`;
      const b = 3600 * (peso * 25e6 * curva(ms) * (0.8 + Math.random() * 0.4)) / 8;
      insHora.run(org, hora, ip, 'entrada', corporativo ? corp.id : res.id, b, b / 1100, b / 80_000);
      insHora.run(org, hora, ip, 'saida', corporativo ? corp.id : res.id, b * 0.1, (b * 0.1) / 400, b / 200_000);
    }
    const mac = `02:CF:00:${(i >> 8).toString(16).padStart(2, '0')}:${(i & 255).toString(16).padStart(2, '0')}:${((i * 7) & 255).toString(16).padStart(2, '0')}`.toUpperCase();
    const v6 = i % 3 === 0 ? null : `2001:db8:100:${(0x1000 + i * 256).toString(16)}::/56`;
    // Sessão anterior encerrada (queda de energia) e a sessão atual
    const ini1 = new Date(agoraMs - (3 + (i % 4)) * 86400_000).toISOString();
    const fim1 = new Date(agoraMs - (1 + (i % 2)) * 86400_000 - i * 600_000).toISOString();
    insSessao.run(org, login, ip, v6, `D-${1000 + i}`, mac, `ether1/vlan${100 + (i % 4)}`, ini1, fim1, fim1, 9.1e9 * peso, 1.1e9 * peso, i % 5 === 0 ? 'Perda de portadora' : 'Pedido do usuário');
    if (i !== 7) insSessao.run(org, login, ip, v6, `D-${2000 + i}`, mac, `ether1/vlan${100 + (i % 4)}`, fim1, null, t, 4.2e9 * peso, 0.5e9 * peso, null);
  });
  db.exec('COMMIT');

  // Ataques encerrados: amplificação DNS (bloqueada por FlowSpec, aprovada pelo NOC), SYN flood corporativo e um assinante atacando para fora.
  const noc = db.prepare("SELECT id FROM usuarios WHERE email = 'noc.demo@managernetwork.local'").get().id;
  const ataque = ({ alvo, grupo, direcao, vetor, metrica, limite, janela, sev, iniH, durMin, picoBps, picoPps, origens, portasO, portasD, protos, total }) => {
    const ini = agoraMs - iniH * 3600_000;
    const fim = ini + durMin * 60_000;
    const id = Number(db.prepare(`INSERT INTO ataques (organizacao_id, numero, grupo_id, alvo, alvo_tipo, versao_ip, direcao, vetor, metrica, limite, janela_s, severidade, status,
      inicio, fim, ultima_atualizacao, atual_bps, atual_pps, pico_bps, pico_pps, pico_fps, total_bytes, origens, portas_origem, portas_destino, protocolos, motivo_encerramento, criado_em)
      VALUES (?, ?, ?, ?, 'ip', 4, ?, ?, ?, ?, ?, ?, 'encerrado', ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(org, proximoNumero(db, org, 'ataque'), grupo, alvo, direcao, vetor, metrica,
      limite, janela, sev, new Date(ini).toISOString(), new Date(fim).toISOString(), new Date(fim).toISOString(), picoBps, picoPps, picoPps / 40, total,
      JSON.stringify(origens), JSON.stringify(portasO), JSON.stringify(portasD), JSON.stringify(protos), 'Tráfego abaixo de 80% do limite por 120 s.', new Date(ini).toISOString()).lastInsertRowid);
    const serie = db.prepare('INSERT INTO ataque_serie (ataque_id, em, bps, pps) VALUES (?, ?, ?, ?)');
    for (let s = 0; s <= durMin * 6; s++) {
      const x = s / (durMin * 6);
      const forma = Math.min(1, x * 8) * (x > 0.85 ? (1 - x) / 0.15 : 1) * (0.85 + Math.random() * 0.15);
      serie.run(id, new Date(ini + s * 10_000).toISOString(), picoBps * forma, picoPps * forma);
    }
    const ev = db.prepare('INSERT INTO ataque_eventos (ataque_id, tipo, detalhes, usuario_id, em) VALUES (?, ?, ?, ?, ?)');
    ev.run(id, 'inicio', JSON.stringify({ metrica, medido: picoBps * 0.6, limite, janela_s: janela }), null, new Date(ini).toISOString());
    return { id, ini, fim, ev };
  };
  const top = (pref, n, total) => Array.from({ length: n }, (_, i) => ({ chave: `${pref}.${11 + i * 17}`, bytes: total * (0.3 / (i + 1)), pkts: (total * (0.3 / (i + 1))) / 1200 }));

  const a1 = ataque({ alvo: '203.0.113.46', grupo: res.id, direcao: 'entrada', vetor: 'Amplificação DNS (UDP 53)', metrica: 'bps', limite: 1e9, janela: 10, sev: 'critica', iniH: 26, durMin: 18,
    picoBps: 6.8e9, picoPps: 710_000, origens: top('192.0.2', 10, 7.1e11), portasO: [{ chave: '17/53', bytes: 6.9e11, pkts: 5.7e8 }], portasD: [{ chave: '17/27015', bytes: 2.1e11, pkts: 1.7e8 }],
    protos: [{ chave: 17, bytes: 7.0e11, pkts: 5.8e8 }, { chave: 6, bytes: 1e10, pkts: 1e7 }], total: 7.1e11 });
  const m1 = Number(db.prepare(`INSERT INTO mitigacoes (organizacao_id, ataque_id, tipo, prefixo, versao_ip, regra, status, origem, duracao_min, solicitada_em, aprovada_em, aprovada_por,
    ativada_em, expira_em, retirada_em, motivo_retirada, criado_em) VALUES (?, ?, 'flowspec', '203.0.113.46/32', 4, ?, 'retirada', 'automatica', 30, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(org, a1.id, JSON.stringify({ destino: '203.0.113.46/32', protocolo: 17, porta_origem: 53, acao: 'descartar' }), new Date(a1.ini + 10_000).toISOString(),
      new Date(a1.ini + 95_000).toISOString(), noc, new Date(a1.ini + 95_000).toISOString(), new Date(a1.ini + 1_895_000).toISOString(), new Date(a1.ini + 1_895_000).toISOString(),
      'Retirada automática: prazo da ação terminou.', new Date(a1.ini + 10_000).toISOString()).lastInsertRowid);
  a1.ev.run(a1.id, 'mitigacao_aguardando_aprovacao', JSON.stringify({ mitigacao: m1, descricao: 'FlowSpec em 203.0.113.46/32 (UDP, porta de origem 53, descartar)' }), null, new Date(a1.ini + 10_000).toISOString());
  a1.ev.run(a1.id, 'mitigacao_aprovada', JSON.stringify({ mitigacao: m1, descricao: 'FlowSpec em 203.0.113.46/32 (UDP, porta de origem 53, descartar)' }), noc, new Date(a1.ini + 95_000).toISOString());
  a1.ev.run(a1.id, 'comentario', 'Cliente jogando online; ataque típico de partida. Avisado pelo WhatsApp do suporte.', noc, new Date(a1.ini + 300_000).toISOString());
  a1.ev.run(a1.id, 'fim', 'Tráfego abaixo de 80% do limite por 120 s.', null, new Date(a1.fim).toISOString());
  a1.ev.run(a1.id, 'mitigacao_retirada', JSON.stringify({ mitigacao: m1, motivo: 'Retirada automática: prazo da ação terminou.' }), null, new Date(a1.ini + 1_895_000).toISOString());

  const a2 = ataque({ alvo: '198.51.100.44', grupo: corp.id, direcao: 'entrada', vetor: 'SYN flood', metrica: 'syn_pps', limite: 50_000, janela: 5, sev: 'alta', iniH: 75, durMin: 7,
    picoBps: 0.9e9, picoPps: 1_400_000, origens: top('198.18.0', 10, 4e10), portasO: [], portasD: [{ chave: '6/443', bytes: 4e10, pkts: 6e8 }],
    protos: [{ chave: 6, bytes: 4e10, pkts: 6e8 }], total: 4e10 });
  a2.ev.run(a2.id, 'mitigacao_recusada', JSON.stringify({ motivo: 'Cliente tem proteção própria no firewall; acompanhado pelo NOC.' }), noc, new Date(a2.ini + 120_000).toISOString());
  a2.ev.run(a2.id, 'fim', 'Tráfego abaixo de 80% do limite por 120 s.', null, new Date(a2.fim).toISOString());

  const a3 = ataque({ alvo: '203.0.113.31', grupo: res.id, direcao: 'saida', vetor: 'UDP flood', metrica: 'pps', limite: 100_000, janela: 10, sev: 'alta', iniH: 50, durMin: 40,
    picoBps: 0.35e9, picoPps: 260_000, origens: [{ chave: '198.18.77.9', bytes: 1e11, pkts: 9e7 }], portasO: [{ chave: '17/40112', bytes: 1e11, pkts: 9e7 }],
    portasD: [{ chave: '17/80', bytes: 1e11, pkts: 9e7 }], protos: [{ chave: 17, bytes: 1e11, pkts: 9e7 }], total: 1e11 });
  a3.ev.run(a3.id, 'comentario', 'Câmera IP do assinante com malware. Orientado a trocar a senha e atualizar o firmware.', noc, new Date(a3.ini + 1_200_000).toISOString());
  a3.ev.run(a3.id, 'fim', 'Tráfego abaixo de 80% do limite por 120 s.', null, new Date(a3.fim).toISOString());
}

module.exports = { demoTrafego };
