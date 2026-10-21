'use strict';

/**
 * Dados de demonstração: uma rota de terminação, três empresas com ramais, filas, URA, números, contatos, uma campanha
 * e o histórico de chamadas do mês (algumas em curso agora). Senha de todos os usuários: demo12345. Não use em produção.
 */
const { abrir, agora, lerConfig } = require('./db');
const { hashSenha } = require('./lib/senha');
const { senhaSip } = require('./lib/contas');
const { classificar, tarifar, custo } = require('./lib/chamadas');

const db = abrir();
if (db.prepare('SELECT 1 FROM empresas').get()) {
  console.log('[PABX] Já existem empresas: a demonstração não foi criada de novo.');
  process.exit(0);
}

const cfg = lerConfig(db);
const senha = hashSenha('demo12345');
const tronco = Number(db.prepare(`INSERT INTO troncos (nome, host, porta, usuario, senha, canais, custo_fixo_centavos, custo_movel_centavos, custo_internacional_centavos, criado_em)
  VALUES ('Operadora Principal', 'sip.operadora.exemplo', 5060, 'conta123', 'troque', 60, 4, 12, 90, ?)`).run(agora()).lastInsertRowid);

// Sorteio previsível (a mesma demonstração toda vez).
let semente = 42;
const sorte = () => { semente = (semente * 1103515245 + 12345) % 2 ** 31; return semente / 2 ** 31; };
const escolher = (lista) => lista[Math.floor(sorte() * lista.length)];

const EMPRESAS = [
  { nome: 'Cobrança Rápida Ltda', tipo: 'discador', ramais: 10, canais: 15, disco: 5120, email: 'cliente@cobranca.demo', chamadasDia: 40 },
  { nome: 'Clínica Bem Viver', tipo: 'pabx', ramais: 3, canais: 4, disco: 100_000, email: 'cliente@clinica.demo', chamadasDia: 12 },
  { nome: 'Loja Central Atendimento', tipo: 'callcenter', ramais: 2, canais: 3, disco: 100_000, email: 'cliente@loja.demo', chamadasDia: 6 },
];
const NOMES = ['Ana Souza', 'Bruno Lima', 'Carla Dias', 'Diego Alves', 'Elisa Rocha', 'Fábio Nunes', 'Gabi Costa', 'Hugo Melo', 'Íris Prado', 'João Reis'];
const TELEFONES = ['11987654321', '1133224455', '21998877665', '1140041234', '31991234567', '11955554444', '4130302020', '11912340000'];

for (const [i, d] of EMPRESAS.entries()) {
  const eid = Number(db.prepare(`INSERT INTO empresas (nome, tipo, email, limite_ramais, limite_canais, disco_mb, tts_limite, stt_limite,
      tarifa_fixo_centavos, tarifa_movel_centavos, tarifa_internacional_centavos, tronco_id, criada_em) VALUES (?, ?, ?, ?, ?, ?, 1000, 500, ?, ?, ?, ?, ?)`)
    .run(d.nome, d.tipo, d.email, d.ramais, d.canais, d.disco, cfg.tarifa_fixo_centavos, cfg.tarifa_movel_centavos, cfg.tarifa_internacional_centavos, tronco, agora())
    .lastInsertRowid);
  const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(eid);
  db.prepare("INSERT INTO usuarios (nome, email, senha_hash, perfil, empresa_id, criado_em) VALUES (?, ?, ?, 'cliente', ?, ?)").run(`Gestor ${d.nome.split(' ')[0]}`, d.email, senha, eid, agora());
  if (i === 0) db.prepare("INSERT INTO usuarios (nome, email, senha_hash, perfil, empresa_id, criado_em) VALUES ('Supervisora Carla', 'supervisor@cobranca.demo', ?, 'supervisor', ?, ?)").run(senha, eid, agora());

  const ramais = [];
  for (let k = 0; k < d.ramais; k++) {
    const online = sorte() < 0.6 ? 1 : 0;
    ramais.push(Number(db.prepare(`INSERT INTO ramais (empresa_id, numero, nome, senha_sip, online, registro_em, registro_ip, registro_agente, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Softphone', ?)`).run(eid, String(1000 + k + 1), NOMES[k % NOMES.length], senhaSip(), online, online ? agora() : null,
      online ? `200.150.10.${10 + k}` : null, agora()).lastInsertRowid));
  }
  const fila = Number(db.prepare("INSERT INTO filas (empresa_id, nome, criada_em) VALUES (?, 'Atendimento', ?)").run(eid, agora()).lastInsertRowid);
  for (const rid of ramais) db.prepare('INSERT INTO fila_ramais (fila_id, ramal_id) VALUES (?, ?)').run(fila, rid);
  db.prepare("INSERT INTO uras (empresa_id, nome, mensagem, opcoes, criada_em) VALUES (?, 'Principal', ?, ?, ?)")
    .run(eid, `Olá, você ligou para ${d.nome}. Para falar com o atendimento, digite 1.`, JSON.stringify([{ digito: '1', destino_tipo: 'fila', destino_id: fila }]), agora());
  const did = Number(db.prepare("INSERT INTO numeros (numero, descricao, tronco_id, empresa_id, destino_tipo, destino_id, criado_em) VALUES (?, 'Número principal', ?, ?, 'fila', ?, ?)")
    .run(`11300${String(eid).padStart(2, '0')}000`, tronco, eid, fila, agora()).lastInsertRowid);
  for (const [k, tel] of TELEFONES.slice(0, 4).entries()) {
    db.prepare('INSERT INTO contatos (empresa_id, nome, telefone, organizacao, criado_em) VALUES (?, ?, ?, ?, ?)').run(eid, `Cliente ${k + 1}`, tel, 'Exemplo S.A.', agora());
  }
  let campanha = null;
  if (d.tipo === 'discador') {
    campanha = Number(db.prepare("INSERT INTO campanhas (empresa_id, nome, modo, status, fila_id, canais, criada_em) VALUES (?, 'Cobrança outubro', 'progressivo', 'ativa', ?, 5, ?)")
      .run(eid, fila, agora()).lastInsertRowid);
    for (let k = 0; k < 120; k++) {
      db.prepare('INSERT INTO campanha_contatos (campanha_id, nome, telefone, status, tentativas) VALUES (?, ?, ?, ?, ?)')
        .run(campanha, `Devedor ${k + 1}`, `119${String(70000000 + k * 137).padStart(8, '0')}`, k < 45 ? escolher(['atendido', 'nao_atendido', 'ocupado']) : 'pendente', k < 45 ? 1 : 0);
    }
  }

  // Histórico do mês: chamadas de entrada, saída e internas em horário comercial.
  const ins = db.prepare(`INSERT INTO chamadas (empresa_id, uid, direcao, origem, destino, tipo_destino, ramal_id, numero_id, campanha_id, tronco_id, status, inicio, atendida_em, fim,
    duracao_s, tarifado_s, custo_centavos, gravacao_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const hoje = new Date();
  let seq = 0;
  db.exec('BEGIN');
  for (let dia = hoje.getDate() - 1; dia >= 0; dia--) {
    for (let k = 0; k < d.chamadasDia; k++) {
      const inicio = new Date(hoje);
      inicio.setDate(hoje.getDate() - dia);
      inicio.setHours(8 + Math.floor(sorte() * 10), Math.floor(sorte() * 60), Math.floor(sorte() * 60), 0);
      if (inicio > hoje) continue;
      const direcao = escolher(d.tipo === 'discador' ? ['saida', 'saida', 'saida', 'entrada'] : ['entrada', 'entrada', 'saida', 'interna']);
      const ramalIdx = Math.floor(sorte() * ramais.length);
      const ramal = String(1000 + ramalIdx + 1);
      const externo = escolher(TELEFONES);
      const [origem, destino] = direcao === 'entrada' ? [externo, ramal] : direcao === 'saida' ? [ramal, externo] : [ramal, String(1000 + ((ramalIdx + 1) % ramais.length) + 1)];
      const status = sorte() < 0.72 ? 'atendida' : escolher(['nao_atendida', 'ocupado', 'nao_atendida']);
      const espera = 3 + Math.floor(sorte() * 20);
      const dur = status === 'atendida' ? 15 + Math.floor(sorte() * 420) : 0;
      const atendida = status === 'atendida' ? new Date(inicio.getTime() + espera * 1000) : null;
      const fim = new Date(inicio.getTime() + (espera + dur) * 1000);
      const tipo = direcao === 'saida' ? classificar(destino) : 'interno';
      const tarifado = direcao === 'saida' ? tarifar(dur, cfg.cadencia_inicial_s, cfg.cadencia_s) : 0;
      ins.run(eid, `demo-${eid}-${++seq}`, direcao, origem, destino, tipo, ramais[ramalIdx], direcao === 'entrada' ? did : null,
        campanha && direcao === 'saida' && sorte() < 0.6 ? campanha : null, direcao === 'saida' ? tronco : null, status, inicio.toISOString(),
        atendida?.toISOString() ?? null, fim.toISOString(), dur, tarifado, custo(empresa, tipo, tarifado), status === 'atendida' ? dur * 16_000 : 0);
    }
  }
  // Algumas chamadas em curso agora.
  for (let k = 0; k < Math.min(3, ramais.length) - i; k++) {
    const inicio = new Date(Date.now() - (60 + k * 90) * 1000).toISOString();
    ins.run(eid, `demo-${eid}-agora-${k}`, 'saida', String(1001 + k), escolher(TELEFONES), 'movel', ramais[k], null, null, tronco, 'em_curso', inicio, inicio, null, 0, 0, 0, 0);
  }
  db.exec('COMMIT');
  db.prepare("INSERT INTO uso_recursos (empresa_id, recurso, quantidade, criado_em) VALUES (?, 'tts', ?, ?), (?, 'stt', ?, ?)").run(eid, 120 + i * 40, agora(), eid, 35 + i * 10, agora());
}

console.log(`[PABX] Demonstração pronta. Clientes: ${EMPRESAS.map((e) => e.email).join(', ')} · supervisor@cobranca.demo · senha demo12345`);
