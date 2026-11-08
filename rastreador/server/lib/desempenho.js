'use strict';

const { intervalo } = require('./datas');
const { distancia } = require('./geo');
const condutores = require('./condutores');

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

/** Km de um trecho pelas posições (deslocamentos de verdade: andando ou mais de 50 m entre pontos). */
function kmPosicoes(pontos) {
  let m = 0;
  for (let i = 1; i < pontos.length; i++) {
    const d = distancia(pontos[i - 1], pontos[i]);
    if (pontos[i].velocidade_kmh >= 3 || d > 50) m += d;
  }
  return m / 1000;
}

const ARRED = (x) => Math.round(x * 10) / 10;

/**
 * Desempenho de cada veículo da empresa e o ranking dos motoristas. O motorista de cada trecho vem do QR code (quem assumiu o
 * veículo); sem registro, é o motorista fixo do cadastro. O consumo real sai dos abastecimentos lançados no app, quando houver.
 */
function calcular(db, empresaId, de, ate) {
  const [ini, fim] = intervalo(de, ate);
  const empresa = db.prepare('SELECT preco_combustivel_centavos, ocioso_l_h FROM empresas WHERE id = ?').get(empresaId);
  const preco = (empresa?.preco_combustivel_centavos ?? 0) / 100;
  const ociosoLh = empresa?.ocioso_l_h ?? 0.8;
  const veiculos = db.prepare(`SELECT v.id, v.placa, v.descricao, v.consumo_km_l, v.limite_velocidade_kmh, v.motorista_id, m.nome AS motorista
    FROM veiculos v LEFT JOIN motoristas m ON m.id = v.motorista_id WHERE v.empresa_id = ? AND v.ativo = 1 ORDER BY v.placa`).all(empresaId);
  const nomes = new Map(db.prepare('SELECT id, nome FROM motoristas WHERE empresa_id = ?').all(empresaId).map((m) => [m.id, m.nome]));
  const uso = db.prepare('SELECT COALESCE(SUM(distancia_m), 0) AS m, COALESCE(SUM(ligado_s), 0) AS s, COALESCE(MAX(velocidade_max_kmh), 0) AS vmax FROM uso_diario WHERE veiculo_id = ? AND data BETWEEN ? AND ?');
  const alertas = db.prepare('SELECT tipo, COUNT(*) AS n FROM alertas WHERE veiculo_id = ? AND ocorrido_em >= ? AND ocorrido_em < ? GROUP BY tipo');
  const posicoes = db.prepare('SELECT lat, lng, velocidade_kmh, ignicao, gps_em FROM posicoes WHERE veiculo_id = ? AND gps_em >= ? AND gps_em < ? ORDER BY gps_em');
  const ocorr = db.prepare(`SELECT tipo, mensagem, ocorrido_em, lat, lng FROM alertas WHERE veiculo_id = ? AND ocorrido_em >= ? AND ocorrido_em < ?
    AND tipo IN ('velocidade', 'fora_horario') ORDER BY ocorrido_em DESC LIMIT 10`);
  const abast = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(litros), 0) AS litros, COALESCE(SUM(valor_centavos), 0) AS valor FROM abastecimentos WHERE veiculo_id = ? AND criado_em >= ? AND criado_em < ?');
  const custoDe = (km, consumo, ocioso) => {
    const litros = consumo ? km / consumo : null;
    const litrosOciosos = (ocioso / 3600) * ociosoLh;
    return { litros, litrosOciosos, custo: preco && litros !== null ? { combustivel: litros * preco, ocioso: litrosOciosos * preco } : null };
  };

  const trechosMotorista = []; // contribuição de cada motorista (por veículo e trecho)
  const lista = veiculos.map((x) => {
    const u = uso.get(x.id, de, ate);
    const al = Object.fromEntries(alertas.all(x.id, ini, fim).map((a) => [a.tipo, a.n]));
    const pts = posicoes.all(x.id, ini, fim);
    const p = analisarPosicoes(pts, x.limite_velocidade_kmh);
    const n = nota({ excessos: al.velocidade ?? 0, acima_s: p.acima_s, fora_horario: al.fora_horario ?? 0, ocioso_s: p.ocioso_s, bruscos: p.bruscos });
    const km = u.m / 1000;
    const ab = abast.get(x.id, ini, fim);
    const consumoReal = ab.litros > 0 && km > 0 ? km / ab.litros : null;
    const consumo = consumoReal ?? x.consumo_km_l;
    const c = custoDe(km, consumo, p.ocioso_s);
    const tr = condutores.trechos(db, x, ini, fim);
    if (tr.length === 1 && tr[0].motorista_id === x.motorista_id) {
      if (x.motorista_id) {
        trechosMotorista.push({ motorista_id: x.motorista_id, placa: x.placa, km, excessos: al.velocidade ?? 0, acima_s: p.acima_s, fora_horario: al.fora_horario ?? 0,
          ocioso_s: p.ocioso_s, bruscos: p.bruscos, custo_centavos: c.custo ? Math.round((c.custo.combustivel + c.custo.ocioso) * 100) : 0, ocorrencias: ocorr.all(x.id, ini, fim) });
      }
    } else {
      for (const t of tr.filter((y) => y.motorista_id)) {
        const ptsT = pts.filter((q) => q.gps_em >= t.inicio && q.gps_em < t.fim);
        const pt = analisarPosicoes(ptsT, x.limite_velocidade_kmh);
        const alT = Object.fromEntries(alertas.all(x.id, t.inicio, t.fim).map((a) => [a.tipo, a.n]));
        const kmT = kmPosicoes(ptsT);
        const ct = custoDe(kmT, consumo, pt.ocioso_s);
        trechosMotorista.push({ motorista_id: t.motorista_id, placa: x.placa, km: kmT, excessos: alT.velocidade ?? 0, acima_s: pt.acima_s, fora_horario: alT.fora_horario ?? 0,
          ocioso_s: pt.ocioso_s, bruscos: pt.bruscos, custo_centavos: ct.custo ? Math.round((ct.custo.combustivel + ct.custo.ocioso) * 100) : 0, ocorrencias: ocorr.all(x.id, t.inicio, t.fim) });
      }
    }
    const atual = condutores.atual(db, x.id);
    return {
      id: x.id, placa: x.placa, descricao: x.descricao, motorista_id: atual?.motorista_id ?? x.motorista_id, motorista: atual?.nome ?? x.motorista, consumo_km_l: x.consumo_km_l,
      consumo_real_km_l: consumoReal === null ? null : ARRED(consumoReal), abastecimentos: ab.n, litros_abastecidos: ARRED(ab.litros), abastecido_centavos: ab.valor,
      km: ARRED(km), ligado_s: u.s, velocidade_max_kmh: u.vmax, ...p, excessos: al.velocidade ?? 0, fora_horario: al.fora_horario ?? 0,
      alertas: Object.values(al).reduce((s2, k) => s2 + k, 0), ...n,
      litros: c.litros === null ? null : ARRED(c.litros + c.litrosOciosos),
      custo_centavos: c.custo ? Math.round((c.custo.combustivel + c.custo.ocioso) * 100) : null,
      custo_ocioso_centavos: c.custo ? Math.round(c.custo.ocioso * 100) : null,
    };
  });
  // Ranking: soma os trechos de cada motorista (em um ou mais veículos) e tira a nota do conjunto.
  const porMotorista = new Map();
  for (const t of trechosMotorista) {
    const m = porMotorista.get(t.motorista_id) ?? { motorista_id: t.motorista_id, nome: nomes.get(t.motorista_id) ?? 'Motorista', veiculos: [], km: 0, excessos: 0, acima_s: 0,
      fora_horario: 0, ocioso_s: 0, bruscos: 0, custo_centavos: 0, ocorrencias: [] };
    if (!m.veiculos.includes(t.placa)) m.veiculos.push(t.placa);
    for (const k of ['km', 'excessos', 'acima_s', 'fora_horario', 'ocioso_s', 'bruscos', 'custo_centavos']) m[k] += t[k];
    m.ocorrencias.push(...t.ocorrencias.map((o) => ({ ...o, placa: t.placa })));
    porMotorista.set(t.motorista_id, m);
  }
  const ranking = [...porMotorista.values()].map((m) => ({
    ...m, km: ARRED(m.km), ocorrencias: m.ocorrencias.sort((a, b) => b.ocorrido_em.localeCompare(a.ocorrido_em)).slice(0, 10), ...nota(m),
  })).sort((a, b) => b.nota - a.nota || a.nome.localeCompare(b.nome, 'pt-BR'));
  const comCusto = lista.filter((x) => x.custo_centavos !== null);
  return {
    de, ate, preco_combustivel_centavos: empresa?.preco_combustivel_centavos ?? 0, veiculos: lista, ranking,
    totais: {
      km: ARRED(lista.reduce((s2, x) => s2 + x.km, 0)),
      custo_centavos: comCusto.length ? comCusto.reduce((s2, x) => s2 + x.custo_centavos, 0) : null,
      custo_ocioso_centavos: comCusto.length ? comCusto.reduce((s2, x) => s2 + x.custo_ocioso_centavos, 0) : null,
      abastecido_centavos: lista.reduce((s2, x) => s2 + x.abastecido_centavos, 0),
      litros_abastecidos: ARRED(lista.reduce((s2, x) => s2 + x.litros_abastecidos, 0)),
      nota_media: ranking.length ? Math.round(ranking.reduce((s2, x) => s2 + x.nota, 0) / ranking.length) : null,
      sem_consumo: lista.filter((x) => !x.consumo_km_l && !x.consumo_real_km_l).length,
    },
  };
}

/** Dicas para o motorista a partir dos descontos da nota (o que mais pesou primeiro). */
function dicas(m) {
  const d = m.descontos ?? {};
  const lista = [];
  if (d.velocidade) lista.push({ pontos: d.velocidade, texto: `Excesso de velocidade: ${m.excessos} vez(es) acima do limite. Respeite o limite do veículo para recuperar até ${Math.round(d.velocidade)} pontos.` });
  if (d.horario) lista.push({ pontos: d.horario, texto: `Uso fora do horário: ${m.fora_horario} vez(es). Combine com o gestor antes de usar o veículo fora do horário.` });
  if (d.ociosidade) lista.push({ pontos: d.ociosidade, texto: 'Motor ligado parado por muito tempo. Desligue o motor nas paradas de mais de 5 minutos: economiza combustível.' });
  if (d.bruscos) lista.push({ pontos: d.bruscos, texto: `${m.bruscos} variação(ões) brusca(s) de velocidade. Acelere e freie com suavidade.` });
  if (!lista.length) lista.push({ pontos: 0, texto: 'Nenhum desconto no período. Continue assim!' });
  return lista.sort((a, b) => b.pontos - a.pontos);
}

module.exports = { calcular, analisarPosicoes, nota, dicas, kmPosicoes };
