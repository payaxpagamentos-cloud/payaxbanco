'use strict';

/**
 * Liga os canais cadastrados à grade de um provedor de EPG (arquivo XMLTV) e importa a
 * programação de verdade — a que sai nos jornais e no guia da TV.
 *
 *   node scripts/epg-mapear.js <url-do-xmltv>     casa os canais pelo nome e importa
 *   node scripts/epg-mapear.js <url> --so-mapear  só casa, sem importar
 *   node scripts/epg-mapear.js --listar <url>     mostra os canais do arquivo
 *
 * O identificador de cada canal no XMLTV fica guardado em `canais.id_epg`, então a
 * importação diária (Configurações → grade automática) passa a casar sozinha.
 *
 * O provedor é escolha da operação: vale o arquivo que a emissora fornece, o de um serviço
 * contratado ou um público. Este script não embute nenhum endereço.
 */

const zlib = require('node:zlib');
const { abrir, agora, gravarConfig } = require('../server/db');
const epg = require('../server/lib/epg');
const { mesmoCanal } = require('../server/lib/listas-publicas');

const args = process.argv.slice(2);
const soListar = args.includes('--listar');
const soMapear = args.includes('--so-mapear');
const url = args.find((a) => /^https?:\/\//.test(a));

if (!url) {
  console.error('Informe o endereço do XMLTV. Exemplo:\n  node scripts/epg-mapear.js https://provedor/grade.xml.gz');
  process.exit(1);
}

const db = abrir();

/**
 * Nome do canal sem a praça e sem os marcadores do provedor:
 * "São Paulo/SP  Globo HD" vira "Globo". A comparação em si é a mesma regra da lista
 * pública, que não deixa "Rede Brasil" virar "TV Brasil".
 */
const limpar = (nome) => String(nome ?? '')
  .replace(/^[A-Za-zÀ-ÿ\s]+\/[A-Za-z]{2}\s*/, '')
  .replace(/\b(HD|SD|4K|UHD|espelho|alternativo)\b/gi, '')
  .replace(/[¹²³]/g, '')
  .replace(/\(\s*\)/g, '')
  .trim();

async function baixar(endereco) {
  const resp = await fetch(endereco, { redirect: 'follow', headers: { 'User-Agent': 'PLAYTECHVIP/1.0' }, signal: AbortSignal.timeout(180_000) });
  if (!resp.ok) throw new Error(`O provedor respondeu ${resp.status}.`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const gzip = buf[0] === 0x1f && buf[1] === 0x8b;
  return (gzip ? zlib.gunzipSync(buf) : buf).toString('utf8');
}

(async () => {
  console.log('Baixando a grade…');
  const xml = await baixar(url);
  const doArquivo = [...xml.matchAll(/<channel id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/g)].map((m) => ({
    id: m[1],
    nome: ((/<display-name[^>]*>([\s\S]*?)<\/display-name>/.exec(m[2]) ?? [])[1] ?? '').trim(),
  }));
  const programasPorCanal = new Map();
  for (const m of xml.matchAll(/<programme[^>]*channel="([^"]+)"/g)) {
    programasPorCanal.set(m[1], (programasPorCanal.get(m[1]) ?? 0) + 1);
  }
  console.log(`${doArquivo.length} canal(is) e ${[...programasPorCanal.values()].reduce((a, b) => a + b, 0)} programas no arquivo.`);

  if (soListar) {
    for (const c of doArquivo) console.log(`  ${String(programasPorCanal.get(c.id) ?? 0).padStart(5)}  ${c.id}  | ${c.nome}`);
    return;
  }

  // Para cada canal nosso, o candidato com o mesmo nome e a grade mais cheia.
  const nossos = db.prepare('SELECT id, nome, numero, id_epg FROM canais ORDER BY numero').all();
  const atualizar = db.prepare('UPDATE canais SET id_epg = ?, atualizado_em = ? WHERE id = ?');
  let casados = 0;
  for (const nosso of nossos) {
    const candidatos = doArquivo
      .filter((c) => mesmoCanal(limpar(c.nome), nosso.nome))
      .sort((a, b) => (programasPorCanal.get(b.id) ?? 0) - (programasPorCanal.get(a.id) ?? 0));
    const escolhido = candidatos[0];
    if (!escolhido) { console.log(`  —  ${nosso.nome}: sem correspondente no arquivo`); continue; }
    atualizar.run(escolhido.id, agora(), nosso.id);
    casados += 1;
    console.log(`  ✓  ${nosso.nome.padEnd(16)} → ${escolhido.nome} (${programasPorCanal.get(escolhido.id) ?? 0} programas)`);
  }
  console.log(`\n${casados} de ${nossos.length} canal(is) ligados à grade.`);

  if (soMapear) return;

  const r = epg.importarXmltv(db, xml, { substituir: true });
  gravarConfig(db, { epg_url: url, epg_importado_em: agora() });
  console.log(`Grade importada: ${r.importados} programa(s), ${r.removidos} substituído(s), ${r.ignorados} de canais que não temos.`);
  console.log('O endereço ficou salvo em Configurações: a plataforma reimporta sozinha uma vez por dia.');
})().catch((err) => {
  console.error('Falhou:', err.message);
  process.exit(1);
});
