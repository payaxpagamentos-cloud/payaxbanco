'use strict';

const { somarDias, diasEntre } = require('./datas');

const ORDEM = { em_dia: 0, sem_dados: 0, proximo: 1, vencido: 2, critico: 3 };

/**
 * Situação de um plano preventivo pelo primeiro limite atingido (data ou quilometragem). Sem odômetro confiável,
 * avalia só a data e informa a limitação.
 */
function situacaoPlano(plano, veiculo, hoje) {
  const r = { situacao: 'em_dia', motivos: [], vence_em: null, vence_km: null, limitacao: null };
  const pior = (s) => { if (ORDEM[s] > ORDEM[r.situacao]) r.situacao = s; };
  if (plano.intervalo_dias) {
    r.vence_em = somarDias(plano.ultima_data, plano.intervalo_dias);
    const faltam = diasEntre(hoje, r.vence_em);
    r.dias_restantes = faltam;
    if (faltam < -plano.tolerancia_dias) { pior('critico'); r.motivos.push(`Venceu por data há ${-faltam} dia(s), fora da tolerância.`); }
    else if (faltam <= 0) { pior('vencido'); r.motivos.push(faltam === 0 ? 'Vence hoje pela data.' : `Venceu por data há ${-faltam} dia(s).`); }
    else if (faltam <= plano.antecedencia_dias) { pior('proximo'); r.motivos.push(`Vence por data em ${faltam} dia(s).`); }
  }
  if (plano.intervalo_km) {
    if (plano.ultimo_km === null || veiculo.odometro_km === null || veiculo.odometro_km === undefined) {
      r.limitacao = 'Sem odômetro confiável: a regra por quilometragem não pôde ser avaliada.';
      if (!plano.intervalo_dias) r.situacao = 'sem_dados';
    } else {
      r.vence_km = plano.ultimo_km + plano.intervalo_km;
      const faltam = r.vence_km - veiculo.odometro_km;
      r.km_restantes = faltam;
      if (faltam < -plano.tolerancia_km) { pior('critico'); r.motivos.push(`Passou ${-faltam} km do limite, fora da tolerância.`); }
      else if (faltam <= 0) { pior('vencido'); r.motivos.push(`Atingiu o limite de quilometragem (${r.vence_km} km).`); }
      else if (faltam <= plano.antecedencia_km) { pior('proximo'); r.motivos.push(`Faltam ${faltam} km para o limite.`); }
    }
  }
  return r;
}

// Fluxo das ordens. Lavagem não passa por orçamento.
const TRANSICOES = {
  padrao: {
    solicitado: ['orcado', 'cancelado'],
    orcado: ['aprovado', 'cancelado'],
    aprovado: ['agendado', 'em_execucao', 'cancelado'],
    agendado: ['em_execucao', 'cancelado'],
    em_execucao: ['concluido', 'cancelado'],
  },
  lavagem: {
    solicitado: ['agendado', 'em_execucao', 'concluido', 'cancelado'],
    agendado: ['em_execucao', 'concluido', 'cancelado'],
    em_execucao: ['concluido', 'cancelado'],
  },
};
const transicoes = (ordem) => TRANSICOES[ordem.tipo === 'lavagem' ? 'lavagem' : 'padrao'][ordem.status] ?? [];

module.exports = { situacaoPlano, transicoes };
