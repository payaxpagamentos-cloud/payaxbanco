#!/usr/bin/env node
'use strict';
// Adiciona (uma vez) o cabeçalho de direito autoral nos fontes. Idempotente: não duplica se já houver.
const fs = require('node:fs');
const path = require('node:path');
const ANO = new Date().getFullYear();
const TITULAR = process.env.RASTREADOR_TITULAR || 'Adriano Almeida';
const H = `Rastreador de Veículos — © ${ANO} ${TITULAR}. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).`;
const raizes = ['server', 'public/js', 'public/motorista', 'scripts'];
let n = 0;
const marca = 'Todos os direitos reservados';
for (const raiz of raizes) {
  for (const f of listar(path.join(__dirname, '..', raiz))) {
    if (!/\.(js)$/.test(f) || /\.min\.js$/.test(f)) continue;
    let txt = fs.readFileSync(f, 'utf8');
    if (txt.includes(marca)) continue;
    const bloco = `/*\n ${H.split('\n').map((l) => l.trim()).join('\n ')}\n*/\n`;
    // Preserva 'use strict' e shebang no topo.
    if (txt.startsWith('#!')) { const i = txt.indexOf('\n') + 1; txt = txt.slice(0, i) + bloco + txt.slice(i); }
    else if (/^'use strict';/.test(txt)) txt = txt.replace(/^'use strict';\n/, `'use strict';\n${bloco}`);
    else txt = bloco + txt;
    fs.writeFileSync(f, txt);
    n++;
  }
}
console.log(`Cabeçalho aplicado em ${n} arquivo(s).`);
function listar(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listar(p)); else out.push(p);
  }
  return out;
}
