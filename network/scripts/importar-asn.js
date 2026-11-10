'use strict';

/*
 * Importa a base pública IP → ASN usada na tela Conteúdo, para reconhecer de onde vem o tráfego quando o roteador não exporta
 * o ASN no flow. Formato do iptoasn.com (arquivo ip2asn-combined.tsv ou .tsv.gz, IPv4 e IPv6):
 *   inicio <tab> fim <tab> ASN <tab> país <tab> descrição
 *
 *   wget https://iptoasn.com/data/ip2asn-combined.tsv.gz
 *   npm run importar-asn -- ip2asn-combined.tsv.gz
 *
 * Substitui a base inteira. O coletor de rede passa a usar a nova base em até 10 s. Atualize uma vez por semana.
 */

const fs = require('node:fs');
const zlib = require('node:zlib');
const readline = require('node:readline');
const path = require('node:path');
const { abrir } = require('../server/db');
const { importarBase } = require('../server/lib/conteudo');

(async () => {
  const arquivo = process.argv[2];
  if (!arquivo || !fs.existsSync(arquivo)) {
    console.error('Uso: npm run importar-asn -- caminho/ip2asn-combined.tsv[.gz]');
    process.exit(1);
  }
  let entrada = fs.createReadStream(arquivo);
  if (arquivo.endsWith('.gz')) entrada = entrada.pipe(zlib.createGunzip());
  const linhas = [];
  for await (const l of readline.createInterface({ input: entrada, crlfDelay: Infinity })) linhas.push(l);
  const db = abrir(undefined, { semAdmin: true });
  const r = importarBase(db, linhas, path.basename(arquivo));
  console.log(`Base IP → ASN importada: ${r.faixas} faixas, ${r.asns} ASNs.`);
  db.close();
})().catch((err) => { console.error('Falha na importação:', err.message); process.exit(1); });
