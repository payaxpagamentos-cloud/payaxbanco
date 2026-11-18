'use strict';

/**
 * Põe os canais abertos no ar com **sinal de demonstração**, para apresentar a plataforma
 * com a grade cheia — e desliga tudo de volta com um comando.
 *
 *   node scripts/demo-canais.js            (liga e preenche a grade de hoje)
 *   node scripts/demo-canais.js --desligar (volta ao estado de entrega: todos desligados)
 *
 * O sinal é um fluxo público de teste. NENHUMA emissora é transmitida: na operação de verdade,
 * cada canal recebe o endereço que a emissora fornece, em Canais.
 */

const { abrir, agora, hoje, somarDias } = (() => {
  const db = require('../server/db');
  const datas = require('../server/lib/datas');
  return { abrir: db.abrir, agora: db.agora, hoje: datas.hoje, somarDias: datas.somarDias };
})();

const SINAL_DEMO = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
const AVISO = 'SINAL DE DEMONSTRAÇÃO ligado para apresentação. Troque pelo endereço que a emissora fornece antes de ir ao ar.';

const GRADE = {
  aberta: [['Bom Dia Brasil', 120], ['Encontro', 90], ['Sessão da Tarde', 120], ['Jornal Local', 60],
    ['Novela das Seis', 60], ['Jornal Nacional', 45], ['Novela das Nove', 60], ['Show da Noite', 90], ['Cinema de Madrugada', 150]],
  noticias: [['Primeiro Giro', 60], ['Manhã Informativa', 120], ['Bolsa e Mercado', 60], ['Jornal da Tarde', 60],
    ['Entrevista da Semana', 60], ['Jornal das Seis', 60], ['Mesa Redonda', 60], ['Plantão da Noite', 120], ['Madrugada Informativa', 120]],
  religioso: [['Santa Missa', 60], ['Palavra de Fé', 60], ['Terço da Tarde', 60], ['Jornal Diário', 60],
    ['Momento de Oração', 60], ['Programa da Noite', 90], ['Vigília', 120], ['Madrugada de Fé', 150]],
  variedades: [['Clipes da Manhã', 120], ['Sessão da Tarde', 120], ['Show da Noite', 90], ['Cinema de Madrugada', 120]],
};

const db = abrir();
const desligar = process.argv.includes('--desligar');

if (desligar) {
  const n = db.prepare(`UPDATE canais SET ativo = 0, url_hls = NULL, observacao = replace(observacao, ? || ' ', ''), atualizado_em = ?
    WHERE id_publico IS NOT NULL`).run(AVISO, agora()).changes;
  db.prepare("DELETE FROM programas WHERE canal_id IN (SELECT id FROM canais WHERE id_publico IS NOT NULL)").run();
  console.log(`${n} canal(is) de volta ao estado de entrega: desligados, sem sinal e sem grade.`);
  process.exit(0);
}

const canais = db.prepare('SELECT id, nome, categoria FROM canais WHERE id_publico IS NOT NULL ORDER BY numero').all();
const ligar = db.prepare(`UPDATE canais SET ativo = 1, fonte = 'hls', url_hls = ?, relay = 1,
  observacao = ? || ' ' || COALESCE(observacao, ''), atualizado_em = ? WHERE id = ?`);
const inserirPrograma = db.prepare(`INSERT OR IGNORE INTO programas (canal_id, titulo, subtitulo, descricao, inicio, fim, categoria, classificacao, ao_vivo, criado_em)
  VALUES (?, ?, NULL, ?, ?, ?, ?, 0, ?, ?)`);

let programas = 0;
for (const [i, c] of canais.entries()) {
  ligar.run(SINAL_DEMO, AVISO, agora(), c.id);
  db.prepare('DELETE FROM programas WHERE canal_id = ?').run(c.id);
  const modelo = GRADE[c.categoria] ?? GRADE.aberta;
  for (const d of [-1, 0, 1]) {
    let inicio = new Date(`${somarDias(hoje(), d)}T06:00:00-03:00`).getTime();
    let k = i % modelo.length;
    while (inicio < new Date(`${somarDias(hoje(), d + 1)}T06:00:00-03:00`).getTime()) {
      const [titulo, minutos] = modelo[k % modelo.length];
      const fim = inicio + minutos * 60_000;
      inserirPrograma.run(c.id, titulo, `${titulo} no ${c.nome}.`, new Date(inicio).toISOString(), new Date(fim).toISOString(),
        c.categoria, /jornal|giro|plantão|mesa|bolsa|entrevista/i.test(titulo) ? 1 : 0, agora());
      programas += 1;
      inicio = fim;
      k += 1;
    }
  }
}

console.log(`${canais.length} canal(is) no ar com sinal de demonstração, ${programas} programas na grade.`);
console.log('Para voltar ao estado de entrega: node scripts/demo-canais.js --desligar');
