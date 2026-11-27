// Aplica um conteúdo pronto (ex.: campanha) ao RASCUNHO do painel.
// Uso: node scripts/aplicar-conteudo.mjs conteudo/black-friday.json
// Só as seções presentes no arquivo são trocadas (banners, planos etc.). Nada vai ao ar sozinho:
// confira em "Ver prévia" no painel e clique em "Publicar".
import { readFile } from 'node:fs/promises';
import { openStore } from '../server/store.mjs';
import { validateConfig } from '../server/validation.mjs';
const arquivo = process.argv[2];
if (!arquivo) { console.error('Informe o arquivo. Exemplo: node scripts/aplicar-conteudo.mjs conteudo/black-friday.json'); process.exit(1); }
let novo;
try { novo = JSON.parse(await readFile(arquivo, 'utf8')); } catch (e) { console.error(`Não foi possível ler ${arquivo}: ${e.message}`); process.exit(1); }
const store = openStore();
try {
  const rascunho = store.read('draft');
  const config = structuredClone(rascunho.config);
  const secoes = Object.keys(novo).filter(k => !k.startsWith('_'));
  for (const k of secoes) config[k] = novo[k];
  const conferido = validateConfig(config);
  store.save(conferido, rascunho.revision);
  console.log(`Rascunho atualizado (${secoes.join(', ')}).`);
  console.log('Agora abra o painel, confira em "Ver prévia" e clique em "Publicar" para colocar no ar.');
} catch (e) {
  console.error('Conteúdo não aplicado: ' + e.message); process.exitCode = 1;
} finally { store.db.close(); }
