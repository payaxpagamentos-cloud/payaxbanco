'use strict';

/**
 * Total do abastecimento em centavos = litros × preço por litro, arredondado para o centavo mais próximo
 * (meio centavo arredonda para cima). Litros em mL e preço em milésimos de real: a conta é feita só com inteiros.
 */
const totalCentavos = (ml, milesimos) => Math.floor((ml * milesimos + 5000) / 10000);

/** Preço médio ponderado por litro (milésimos de real) = soma dos valores ÷ soma dos litros. */
const precoMedio = (lista) => {
  const ml = lista.reduce((a, x) => a + x.litros_ml, 0);
  const c = lista.reduce((a, x) => a + x.total_centavos, 0);
  return ml ? Math.round((c * 10 * 1000) / ml) : null;
};

/**
 * Ciclos de consumo de UM veículo: entre dois abastecimentos de tanque cheio, distância entre os odômetros dos fechamentos
 * ÷ litros adicionados depois do primeiro fechamento (inclui os parciais até o segundo cheio, inclusive). O volume do
 * primeiro fechamento não entra. Sem dois fechamentos válidos, não há ciclo (dados insuficientes).
 */
function ciclos(lancamentos) {
  const l = [...lancamentos].sort((a, b) => a.odometro_km - b.odometro_km || a.data_hora.localeCompare(b.data_hora));
  const r = [];
  let inicio = -1;
  for (let i = 0; i < l.length; i++) {
    if (!l[i].tanque_cheio) continue;
    if (inicio >= 0) {
      const trecho = l.slice(inicio + 1, i + 1);
      const distancia = l[i].odometro_km - l[inicio].odometro_km;
      const ml = trecho.reduce((a, x) => a + x.litros_ml, 0);
      const custo = trecho.reduce((a, x) => a + x.total_centavos, 0);
      if (distancia > 0 && ml > 0) {
        r.push({
          de_id: l[inicio].id, ate_id: l[i].id, de_km: l[inicio].odometro_km, ate_km: l[i].odometro_km, de_em: l[inicio].data_hora, ate_em: l[i].data_hora,
          distancia_km: distancia, litros_ml: ml, custo_centavos: custo, lancamentos: trecho.length,
          km_por_litro: Math.round((distancia * 1000 * 100) / ml) / 100, custo_km_centavos: Math.round((custo / distancia) * 100) / 100,
        });
      }
    }
    inicio = i;
  }
  return r;
}

/** Resumo dos ciclos válidos: consumo e custo de combustível por km (não é custo operacional total). */
function resumoCiclos(cs) {
  if (!cs.length) return { situacao: 'dados_insuficientes', mensagem: 'Dados insuficientes: são necessários dois abastecimentos de tanque cheio.' };
  const dist = cs.reduce((a, c) => a + c.distancia_km, 0);
  const ml = cs.reduce((a, c) => a + c.litros_ml, 0);
  const custo = cs.reduce((a, c) => a + c.custo_centavos, 0);
  return { situacao: 'ok', ciclos: cs.length, distancia_km: dist, litros_ml: ml, km_por_litro: Math.round((dist * 1000 * 100) / ml) / 100,
    custo_combustivel_km_centavos: Math.round((custo / dist) * 100) / 100 };
}

module.exports = { totalCentavos, precoMedio, ciclos, resumoCiclos };
