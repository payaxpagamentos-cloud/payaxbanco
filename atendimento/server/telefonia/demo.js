'use strict';
/**
 * Telefonia da demonstração: liga a telefonia da empresa de exemplo com uma operadora, um ramal
 * para cada pessoa da equipe (o mesmo número em Usuários › Ramal), as filas no telefone, uma URA
 * inteligente, o número principal e o histórico de chamadas do mês. Roda dentro da transação do seed.
 */
const crypto = require('node:crypto');
const { agora, lerConfig } = require('../db');
const { classificar, tarifar, custo } = require('./chamadas');

const TELEFONES = ['11987654321', '1133224455', '21998877665', '1140041234', '31991234567', '11955554444', '4130302020', '11912340000'];

function semearTelefonia(db, empresaId, filaId, equipe) {
  const cfg = lerConfig(db);
  let semente = 42; // sorteio previsível: a mesma demonstração toda vez
  const sorte = () => { semente = (semente * 1103515245 + 12345) % 2 ** 31; return semente / 2 ** 31; };
  const escolher = (lista) => lista[Math.floor(sorte() * lista.length)];

  const tronco = Number(db.prepare(`INSERT INTO pabx_troncos (nome, host, porta, usuario, senha, canais, custo_fixo_centavos, custo_movel_centavos, custo_internacional_centavos, criado_em)
    VALUES ('Operadora Principal', 'sip.operadora.exemplo', 5060, 'conta123', 'troque', 60, 4, 12, 90, ?)`).run(agora()).lastInsertRowid);
  db.prepare(`UPDATE empresas SET telefonia_ativa = 1, telefonia_tipo = 'callcenter', limite_ramais = 10, limite_canais = 10, disco_mb = 5120, tts_limite = 1000, stt_limite = 500,
      tarifa_fixo_centavos = ?, tarifa_movel_centavos = ?, tarifa_internacional_centavos = ?, tronco_id = ?, gravar_chamadas = 1 WHERE id = ?`)
    .run(cfg.tarifa_fixo_centavos || 6, cfg.tarifa_movel_centavos || 18, cfg.tarifa_internacional_centavos || 120, tronco, empresaId);
  const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(empresaId);

  // Um ramal por pessoa da equipe, ligado ao usuário.
  const ramais = [];
  for (const [k, p] of equipe.entries()) {
    const numero = String(1001 + k);
    const online = k < 2 ? 1 : 0;
    const id = Number(db.prepare(`INSERT INTO pabx_ramais (empresa_id, numero, nome, senha_sip, online, registro_em, registro_ip, registro_agente, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ZOE (painel)', ?)`).run(empresaId, numero, p.nome, crypto.randomBytes(12).toString('base64url'), online,
      online ? agora() : null, online ? `200.150.10.${10 + k}` : null, agora()).lastInsertRowid);
    db.prepare('UPDATE usuarios SET ramal = ? WHERE id = ?').run(numero, p.id);
    ramais.push(id);
  }
  // As filas do WhatsApp atendem também o telefone.
  for (const nome of ['Atendimento', 'Financeiro', 'Suporte técnico']) {
    for (const rid of ramais) db.prepare('INSERT OR IGNORE INTO pabx_fila_ramais (fila_id, ramal_id) VALUES (?, ?)').run(filaId.get(nome), rid);
  }
  const ura = Number(db.prepare(`INSERT INTO pabx_uras (empresa_id, nome, mensagem, opcoes, tipo, criada_em) VALUES (?, 'Principal', ?, ?, 'inteligente', ?)`)
    .run(empresaId, 'Olá, você ligou para o Fibra Mais. Para suporte técnico, digite 1. Para o financeiro, digite 2. Para outros assuntos, digite 3.',
      JSON.stringify([
        { digito: '1', destino_tipo: 'fila', destino_id: filaId.get('Suporte técnico') },
        { digito: '2', destino_tipo: 'fila', destino_id: filaId.get('Financeiro') },
        { digito: '3', destino_tipo: 'fila', destino_id: filaId.get('Atendimento') },
      ]), agora()).lastInsertRowid);
  const did = Number(db.prepare("INSERT INTO pabx_numeros (numero, descricao, tronco_id, empresa_id, destino_tipo, destino_id, criado_em) VALUES ('1130001000', 'Número principal', ?, ?, 'ura', ?, ?)")
    .run(tronco, empresaId, ura, agora()).lastInsertRowid);
  db.prepare("INSERT INTO pabx_numeros (numero, descricao, tronco_id, criado_em) VALUES ('1130001001', 'Reserva', ?, ?)").run(tronco, agora());

  // Histórico do mês: chamadas em horário comercial.
  const ins = db.prepare(`INSERT INTO pabx_chamadas (empresa_id, uid, direcao, origem, destino, tipo_destino, ramal_id, numero_id, tronco_id, status, inicio, atendida_em, fim,
    duracao_s, tarifado_s, custo_centavos, gravacao_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const hoje = new Date();
  let seq = 0;
  for (let dia = hoje.getDate() - 1; dia >= 0; dia--) {
    for (let k = 0; k < 18; k++) {
      const inicio = new Date(hoje);
      inicio.setDate(hoje.getDate() - dia);
      inicio.setHours(8 + Math.floor(sorte() * 10), Math.floor(sorte() * 60), Math.floor(sorte() * 60), 0);
      if (inicio > hoje) continue;
      const direcao = escolher(['entrada', 'entrada', 'entrada', 'saida', 'interna']);
      const idx = Math.floor(sorte() * ramais.length);
      const ramal = String(1001 + idx);
      const externo = escolher(TELEFONES);
      const [origem, destino] = direcao === 'entrada' ? [externo, ramal] : direcao === 'saida' ? [ramal, externo] : [ramal, String(1001 + ((idx + 1) % ramais.length))];
      const status = sorte() < 0.75 ? 'atendida' : escolher(['nao_atendida', 'ocupado', 'nao_atendida']);
      const espera = 3 + Math.floor(sorte() * 25);
      const dur = status === 'atendida' ? 20 + Math.floor(sorte() * 400) : 0;
      const atendida = status === 'atendida' ? new Date(inicio.getTime() + espera * 1000) : null;
      const fim = new Date(inicio.getTime() + (espera + dur) * 1000);
      const tipo = direcao === 'saida' ? classificar(destino) : 'interno';
      const tarifado = direcao === 'saida' ? tarifar(dur, cfg.cadencia_inicial_s, cfg.cadencia_s) : 0;
      ins.run(empresaId, `demo-${++seq}`, direcao, origem, destino, tipo, ramais[idx], direcao === 'entrada' ? did : null, direcao === 'saida' ? tronco : null,
        status, inicio.toISOString(), atendida?.toISOString() ?? null, fim.toISOString(), dur, tarifado, custo(empresa, tipo, tarifado), status === 'atendida' ? dur * 16_000 : 0);
    }
  }
  // Uma ligação em curso agora.
  const inicio = new Date(Date.now() - 95_000).toISOString();
  ins.run(empresaId, 'demo-agora', 'entrada', '11987654321', '1001', 'interno', ramais[0], did, null, 'em_curso', inicio, inicio, null, 0, 0, 0, 0);
  db.prepare("INSERT INTO pabx_uso_recursos (empresa_id, recurso, quantidade, criado_em) VALUES (?, 'tts', 160, ?), (?, 'stt', 45, ?)").run(empresaId, agora(), empresaId, agora());
  return { ramais: ramais.length, chamadas: seq };
}

module.exports = { semearTelefonia };
