'use strict';

const { agora, transacao, lerConfig } = require('../db');
const { distancia, dentroCerca } = require('./geo');
const { alertar, TIPOS } = require('./alertas');
const { local } = require('./datas');

// Eventos informados pelo próprio equipamento que viram alerta.
const EVENTOS = ['panico', 'bateria_desconectada', 'bateria_baixa', 'violacao'];
// O mesmo evento repetido nesse intervalo (o equipamento reenvia o alarme) não gera outro alerta.
const REPETICAO_EVENTO_MS = 2 * 60_000;
// Salto entre posições só é descartado se for maior que isso (evita descartar pequenas correções do GPS).
const SALTO_MINIMO_M = 1000;
// Tempo máximo entre duas posições somado ao horímetro (equipamento desligado não conta como motor ligado).
const LIGADO_MAX_S = 600;

const numeroOuNulo = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

/** Conta a mensagem recebida no dia (dashboard e diagnóstico). */
function contar(db, protocolo) {
  db.prepare(`INSERT INTO recepcao_diaria (data, protocolo, mensagens) VALUES (?, ?, 1)
    ON CONFLICT (data, protocolo) DO UPDATE SET mensagens = mensagens + 1`).run(local().data, protocolo);
}

function registrarDesconhecido(db, imei, protocolo, ip) {
  const t = agora();
  db.prepare(`INSERT INTO desconhecidos (imei, protocolo, ip, primeiro_contato, ultimo_contato) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (imei) DO UPDATE SET protocolo = excluded.protocolo, ip = excluded.ip, ultimo_contato = excluded.ultimo_contato, mensagens = mensagens + 1`)
    .run(String(imei).slice(0, 40), protocolo, ip ?? null, t, t);
}

/** Fora do horário de uso da empresa ('HH:MM' a 'HH:MM', que pode virar a noite, nos dias da semana permitidos). */
function foraDoHorario(instante, empresa) {
  if (!empresa.horario_inicio || !empresa.horario_fim) return false;
  const l = local(instante);
  if (!String(empresa.dias_uso ?? '').includes(String(l.diaSemana))) return true;
  const min = l.hora * 60 + l.minuto;
  const [a, b] = [empresa.horario_inicio, empresa.horario_fim].map((h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3)));
  return a <= b ? !(min >= a && min < b) : !(min >= a || min < b);
}

/** Alerta de evento do equipamento, sem repetir o mesmo enquanto ele reenvia o alarme. */
function alertarEvento(db, veiculo, evento, pos) {
  const recente = db.prepare('SELECT 1 FROM alertas WHERE veiculo_id = ? AND tipo = ? AND ocorrido_em >= ?')
    .get(veiculo.id, evento, new Date(Date.parse(pos.gps_em ?? agora()) - REPETICAO_EVENTO_MS).toISOString());
  if (!recente) alertar(db, veiculo, evento, `${TIPOS[evento]} (${veiculo.placa}).`, pos);
}

/** Entrada e saída das cercas da empresa que valem para o veículo. A primeira posição só registra onde ele está. */
function verificarCercas(db, veiculo, pos) {
  const cercas = db.prepare(`SELECT c.* FROM cercas c WHERE c.empresa_id = ? AND c.ativa = 1
    AND (NOT EXISTS (SELECT 1 FROM cerca_veiculos x WHERE x.cerca_id = c.id) OR EXISTS (SELECT 1 FROM cerca_veiculos x WHERE x.cerca_id = c.id AND x.veiculo_id = ?))`)
    .all(veiculo.empresa_id, veiculo.id);
  const estado = db.prepare('SELECT dentro FROM cerca_estado WHERE cerca_id = ? AND veiculo_id = ?');
  const gravar = db.prepare(`INSERT INTO cerca_estado (cerca_id, veiculo_id, dentro, desde) VALUES (?, ?, ?, ?)
    ON CONFLICT (cerca_id, veiculo_id) DO UPDATE SET dentro = excluded.dentro, desde = excluded.desde`);
  for (const c of cercas) {
    const dentro = dentroCerca(pos, c) ? 1 : 0;
    const antes = estado.get(c.id, veiculo.id);
    if (antes && antes.dentro === dentro) continue;
    gravar.run(c.id, veiculo.id, dentro, pos.gps_em);
    if (!antes) continue;
    if (dentro && c.alertar_entrada) alertar(db, veiculo, 'cerca_entrada', `${veiculo.placa} entrou na cerca ${c.nome}.`, pos);
    if (!dentro && c.alertar_saida) alertar(db, veiculo, 'cerca_saida', `${veiculo.placa} saiu da cerca ${c.nome}.`, pos);
  }
}

/**
 * Mensagem de um rastreador, já traduzida do protocolo:
 * { imei, protocolo, ip?, lat?, lng?, velocidade_kmh?, curso?, altitude?, satelites?, ignicao?, tensao?, evento?, bloqueado?, gps_em?, valido? }.
 * Sem posição válida (só estado ou alarme), atualiza a comunicação, a ignição e os alertas.
 * Devolve { status, veiculo_id? }: gravada, repetida, descartada, sem_posicao, desconhecido, sem_veiculo ou empresa_bloqueada.
 */
function receber(db, m) {
  const cfg = lerConfig(db);
  return transacao(db, () => {
    contar(db, m.protocolo);
    const r = db.prepare('SELECT * FROM rastreadores WHERE imei = ?').get(String(m.imei ?? ''));
    if (!r) {
      registrarDesconhecido(db, m.imei, m.protocolo, m.ip);
      return { status: 'desconhecido' };
    }
    const t = agora();
    db.prepare('UPDATE rastreadores SET ultima_comunicacao = ?, ultimo_ip = COALESCE(?, ultimo_ip) WHERE id = ?').run(t, m.ip ?? null, r.id);
    const v = db.prepare(`SELECT v.*, e.status AS empresa_status, e.alertar_ignicao, e.horario_inicio, e.horario_fim, e.dias_uso
      FROM veiculos v JOIN empresas e ON e.id = v.empresa_id WHERE v.rastreador_id = ?`).get(r.id);
    if (!v || !v.ativo) return { status: 'sem_veiculo', rastreador_id: r.id };
    if (v.empresa_status !== 'ativa') return { status: 'empresa_bloqueada', rastreador_id: r.id };

    // Hora da posição: a do equipamento, se for plausível (relógio adiantado mais de 10 min ou antes de 2010 vira a hora de chegada).
    const gps = Date.parse(m.gps_em ?? '');
    const gpsOk = Number.isFinite(gps) && gps <= Date.now() + 10 * 60_000 && gps >= Date.parse('2010-01-01');
    const gpsEm = gpsOk ? new Date(gps).toISOString() : t;
    const lat = numeroOuNulo(m.lat);
    const lng = numeroOuNulo(m.lng);
    const temPosicao = m.valido !== false && lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
    const velocidade = Math.max(0, Math.min(400, numeroOuNulo(m.velocidade_kmh) ?? 0));
    const ignicao = typeof m.ignicao === 'boolean' ? (m.ignicao ? 1 : 0) : null;
    const tensao = numeroOuNulo(m.tensao);
    const evento = EVENTOS.includes(m.evento) ? m.evento : null;
    // Mensagem mais nova que a última posição (as antigas, reenviadas da memória do equipamento, só entram no histórico).
    const nova = !v.posicao_em || gpsEm > v.posicao_em;
    const pos = { lat: temPosicao ? lat : v.lat, lng: temPosicao ? lng : v.lng, velocidade_kmh: velocidade, gps_em: gpsEm };

    const mudar = { comunicacao_em: t, sem_comunicacao_alertado: 0 };
    let status = 'sem_posicao';

    if (temPosicao) {
      let somaM = 0;
      let ligadoS = 0;
      if (nova && v.posicao_em && v.lat !== null) {
        const dt = (Date.parse(gpsEm) - Date.parse(v.posicao_em)) / 1000;
        const d = distancia({ lat: v.lat, lng: v.lng }, { lat, lng });
        if (d > SALTO_MINIMO_M && (d / Math.max(dt, 1)) * 3.6 > cfg.velocidade_max_plausivel_kmh) {
          db.prepare('UPDATE veiculos SET comunicacao_em = ?, sem_comunicacao_alertado = 0 WHERE id = ?').run(t, v.id);
          return { status: 'descartada', veiculo_id: v.id };
        }
        // Parado, o GPS oscila alguns metros: só soma com o veículo andando ou num deslocamento claro.
        if (velocidade >= 3 || d >= 50) somaM = Math.round(d);
        if (v.ignicao === 1) ligadoS = Math.round(Math.min(dt, LIGADO_MAX_S));
      }
      const ins = db.prepare(`INSERT OR IGNORE INTO posicoes (veiculo_id, lat, lng, velocidade_kmh, curso, altitude, satelites, ignicao, tensao, evento, gps_em, recebido_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(v.id, lat, lng, velocidade, numeroOuNulo(m.curso) === null ? null : Math.round(Number(m.curso)) % 360,
        numeroOuNulo(m.altitude), numeroOuNulo(m.satelites), ignicao, tensao, evento ?? (m.evento ? String(m.evento).slice(0, 40) : null), gpsEm, t);
      if (!ins.changes) {
        db.prepare('UPDATE veiculos SET comunicacao_em = ?, sem_comunicacao_alertado = 0 WHERE id = ?').run(t, v.id);
        return { status: 'repetida', veiculo_id: v.id };
      }
      status = 'gravada';
      db.prepare(`INSERT INTO uso_diario (veiculo_id, data, distancia_m, ligado_s, velocidade_max_kmh, posicoes) VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT (veiculo_id, data) DO UPDATE SET distancia_m = distancia_m + excluded.distancia_m, ligado_s = ligado_s + excluded.ligado_s,
          velocidade_max_kmh = MAX(velocidade_max_kmh, excluded.velocidade_max_kmh), posicoes = posicoes + 1`)
        .run(v.id, local(gpsEm).data, somaM, ligadoS, velocidade);
      if (nova) {
        Object.assign(mudar, { lat, lng, velocidade_kmh: velocidade, posicao_em: gpsEm, hodometro_m: v.hodometro_m + somaM, horimetro_s: v.horimetro_s + ligadoS });
        if (numeroOuNulo(m.curso) !== null) mudar.curso = Math.round(Number(m.curso)) % 360;
        // Excesso de velocidade: avisa ao passar do limite e de novo só depois de voltar abaixo dele.
        if (v.limite_velocidade_kmh > 0) {
          if (velocidade > v.limite_velocidade_kmh && !v.em_excesso) {
            alertar(db, v, 'velocidade', `${v.placa} a ${Math.round(velocidade)} km/h (limite ${v.limite_velocidade_kmh} km/h).`, pos);
            mudar.em_excesso = 1;
          } else if (velocidade <= v.limite_velocidade_kmh && v.em_excesso) {
            mudar.em_excesso = 0;
          }
        }
        verificarCercas(db, v, pos);
      }
    }

    if (nova || !temPosicao) {
      if (ignicao !== null) {
        if (v.ignicao !== null && ignicao !== v.ignicao && v.alertar_ignicao) {
          alertar(db, v, ignicao ? 'ignicao_ligada' : 'ignicao_desligada', `${v.placa}: ignição ${ignicao ? 'ligada' : 'desligada'}.`, pos);
        }
        mudar.ignicao = ignicao;
      }
      // Uso fora do horário: uma vez por vez que o veículo é ligado (sem sinal de ignição, conta o veículo andando).
      const ligado = ignicao !== null ? ignicao === 1 : (temPosicao && velocidade >= 10);
      if (ligado && !v.fora_horario_alertado && foraDoHorario(gpsEm, v)) {
        alertar(db, v, 'fora_horario', `${v.placa} em uso fora do horário permitido.`, pos);
        mudar.fora_horario_alertado = 1;
      } else if (ignicao === 0 || (v.fora_horario_alertado && !foraDoHorario(gpsEm, v))) {
        mudar.fora_horario_alertado = 0;
      }
      if (tensao !== null) mudar.tensao = tensao;
      if (typeof m.bloqueado === 'boolean') mudar.bloqueado = m.bloqueado ? 1 : 0;
    }
    if (evento) alertarEvento(db, v, evento, pos);

    const campos = Object.keys(mudar);
    db.prepare(`UPDATE veiculos SET ${campos.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...campos.map((k) => mudar[k]), v.id);
    return { status, veiculo_id: v.id, rastreador_id: r.id };
  });
}

/**
 * Situação do veículo no mapa: sem_sinal (não comunica há mais de `onlineMin`), movimento, ligado (parado com a ignição ligada),
 * parado ou sem_posicao.
 */
function situacao(v, onlineMin, agoraMs = Date.now()) {
  if (!v.posicao_em) return 'sem_posicao';
  if (!v.comunicacao_em || agoraMs - Date.parse(v.comunicacao_em) > onlineMin * 60_000) return 'sem_sinal';
  if ((v.velocidade_kmh ?? 0) >= 3) return 'movimento';
  return v.ignicao === 1 ? 'ligado' : 'parado';
}

module.exports = { receber, situacao, foraDoHorario, EVENTOS };
