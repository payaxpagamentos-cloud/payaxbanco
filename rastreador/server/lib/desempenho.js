'use strict';

const { intervalo } = require('./datas');

/**
 * Nota do motorista (0 a 100) e custo em reais por veículo, num período.
 * Descontos: excesso de velocidade (por alerta e por minuto acima do limite), uso fora do horário, motor ligado parado
 * (mais de 5 min seguidos) e variações bruscas de velocidade (estimadas entre posições próximas: o J16 não mede a freada).
 * Custo: km ÷ consumo médio × preço do combustível + horas paradas com o motor ligado × litros por hora × preço.
 */
const OCIOSO_MIN_S = 5 * 60;
const BRUSCO_KMH = 25;
const BRUSCO_JANELA_S = 8;
const LIGADO_MAX_S = 600;

function analisarPosicoes(pontos, limite) {
  let ociosoS = 0;
  let acimaS = 0;
  let bruscos = 0;
  let trecho = 0;
  for (let i = 1; i < pontos.length; i++) {
    const a = pontos[i - 1];
    const b = pontos[i];
    const dt = Math.min(LIGADO_MAX_S, (Date.parse(b.gps_em) - Date.parse(a.gps_em)) / 1000);
    if (dt <= 0) continue;
    if (a.ignicao === 1 && a.velocidade_kmh < 3) {
      trecho += dt;
    } else {
      if (trecho >= OCIOSO_MIN_S) ociosoS += trecho;
      trecho = 0;
    }
    if (limite > 0 && a.velocidade_kmh > limite) acimaS += dt;
    if (dt <= BRUSCO_JANELA_S && Math.abs(b.velocidade_kmh - a.velocidade_kmh) >= BRUSCO_KMH) bruscos++;
  }
  if (trecho >= OCIOSO_MIN_S) ociosoS += trecho;
  return { ocioso_s: Math.round(ociosoS), acima_s: Math.round(acimaS), bruscos };
}

function nota({ excessos, acima_s, fora_horario, ocioso_s, bruscos }) {
  const desc = {
    velocidade: Math.min(40, excessos * 4 + (acima_s / 60) * 0.5),
    horario: Math.min(20, fora_horario * 5),
    ociosidade: Math.min(20, (ocioso_s / 3600) * 4),
    bruscos: Math.min(20, bruscos * 2),
  };
  const total = Object.values(desc).reduce((s, x) => s + x, 0);
  return { nota: Math.max(0, Math.round(100 - total)), descontos: Object.fromEntries(Object.entries(desc).map(([k, x]) => [k, Math.round(x * 10) / 10])) };
}

/** Desempenho de cada veículo da empresa e o ranking dos motoristas (o motorista fixo de cada veículo). */
function calcular(db, empresaId, de, ate) {
  const [ini, fim] = intervalo(de, ate);
  const empresa = db.prepare('SELECT preco_combustivel_centavos, ocioso_l_h FROM empresas WHERE id = ?').get(empresaId);
  const preco = (empresa?.preco_combustivel_centavos ?? 0) / 100;
  const veiculos = db.prepare(`SELECT v.id, v.placa, v.descricao, v.consumo_km_l, v.limite_velocidade_kmh, v.motorista_id, m.nome AS motorista
    FROM veiculos v LEFT JOIN motoristas m ON m.id = v.motorista_id WHERE v.empresa_id = ? AND v.ativo = 1 ORDER BY v.placa`).all(empresaId);
  const uso = db.prepare('SELECT COALESCE(SUM(distancia_m), 0) AS m, COALESCE(SUM(ligado_s), 0) AS s, COALESCE(MAX(velocidade_max_kmh), 0) AS vmax FROM uso_diario WHERE veiculo_id = ? AND data BETWEEN ? AND ?');
  const alertas = db.prepare('SELECT tipo, COUNT(*) AS n FROM alertas WHERE veiculo_id = ? AND ocorrido_em >= ? AND ocorrido_em < ? GROUP BY tipo');
  const posicoes = db.prepare('SELECT velocidade_kmh, ignicao, gps_em FROM posicoes WHERE veiculo_id = ? AND gps_em >= ? AND gps_em < ? ORDER BY gps_em');
  const lista = veiculos.map((x) => {
    const u = uso.get(x.id, de, ate);
    const al = Object.fromEntries(alertas.all(x.id, ini, fim).map((a) => [a.tipo, a.n]));
    const p = analisarPosicoes(posicoes.all(x.id, ini, fim), x.limite_velocidade_kmh);
    const n = nota({ excessos: al.velocidade ?? 0, acima_s: p.acima_s, fora_horario: al.fora_horario ?? 0, ocioso_s: p.ocioso_s, bruscos: p.bruscos });
    const km = u.m / 1000;
    const litros = x.consumo_km_l ? km / x.consumo_km_l : null;
    const litrosOciosos = (p.ocioso_s / 3600) * (empresa?.ocioso_l_h ?? 0.8);
    const custo = preco && litros !== null ? { combustivel: litros * preco, ocioso: litrosOciosos * preco } : null;
    return {
      id: x.id, placa: x.placa, descricao: x.descricao, motorista_id: x.motorista_id, motorista: x.motorista,
      km: Math.round(km * 10) / 10, ligado_s: u.s, velocidade_max_kmh: u.vmax, ...p, excessos: al.velocidade ?? 0, fora_horario: al.fora_horario ?? 0,
      alertas: Object.values(al).reduce((s, k) => s + k, 0), ...n,
      litros: litros === null ? null : Math.round((litros + litrosOciosos) * 10) / 10,
      custo_centavos: custo ? Math.round((custo.combustivel + custo.ocioso) * 100) : null,
      custo_ocioso_centavos: custo ? Math.round(custo.ocioso * 100) : null,
    };
  });
  // Ranking: um motorista com mais de um veículo soma os números e tira a nota do conjunto.
  const porMotorista = new Map();
  for (const x of lista.filter((y) => y.motorista_id)) {
    const m = porMotorista.get(x.motorista_id) ?? { motorista_id: x.motorista_id, nome: x.motorista, veiculos: [], km: 0, excessos: 0, acima_s: 0, fora_horario: 0, ocioso_s: 0, bruscos: 0, custo_centavos: 0 };
    m.veiculos.push(x.placa);
    for (const k of ['km', 'excessos', 'acima_s', 'fora_horario', 'ocioso_s', 'bruscos']) m[k] += x[k];
    m.custo_centavos += x.custo_centavos ?? 0;
    porMotorista.set(x.motorista_id, m);
  }
  const ranking = [...porMotorista.values()].map((m) => ({ ...m, km: Math.round(m.km * 10) / 10, ...nota(m) })).sort((a, b) => b.nota - a.nota || a.nome.localeCompare(b.nome, 'pt-BR'));
  const comCusto = lista.filter((x) => x.custo_centavos !== null);
  return {
    de, ate, preco_combustivel_centavos: empresa?.preco_combustivel_centavos ?? 0, veiculos: lista, ranking,
    totais: {
      km: Math.round(lista.reduce((s, x) => s + x.km, 0) * 10) / 10,
      custo_centavos: comCusto.length ? comCusto.reduce((s, x) => s + x.custo_centavos, 0) : null,
      custo_ocioso_centavos: comCusto.length ? comCusto.reduce((s, x) => s + x.custo_ocioso_centavos, 0) : null,
      nota_media: ranking.length ? Math.round(ranking.reduce((s, x) => s + x.nota, 0) / ranking.length) : null,
      sem_consumo: lista.filter((x) => !x.consumo_km_l).length,
    },
  };
}

module.exports = { calcular, analisarPosicoes, nota };
