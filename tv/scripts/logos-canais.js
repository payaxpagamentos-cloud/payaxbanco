#!/usr/bin/env node
'use strict';

/**
 * Busca o logo de cada emissora e põe nos canais.
 *
 *   node scripts/logos-canais.js            # só quem ainda não tem logo
 *   node scripts/logos-canais.js --forcar   # refaz todos
 *
 * É o mesmo que o botão "Buscar logos das emissoras" do painel faz; existe como script para
 * rodar nos 116 canais de uma vez sem deixar a tela aberta esperando — leva alguns minutos,
 * porque há uma pausa entre os canais (quem hospeda as imagens limita a frequência).
 *
 * Precisa de internet no servidor. Canal sem logo na lista pública aparece no fim: nesses,
 * envie a imagem oficial pelo cadastro do canal no painel.
 */

const { abrir } = require('../server/db');
const logos = require('../server/lib/logos');

const forcar = process.argv.includes('--forcar');
const db = abrir();

(async () => {
  const quantos = db.prepare(`SELECT COUNT(*) AS n FROM canais ${forcar ? '' : 'WHERE logo_midia_id IS NULL'}`).get().n;
  if (!quantos) {
    console.log('Todos os canais já têm logo. Use --forcar para buscar de novo.');
    return;
  }
  console.log(`Buscando o logo de ${quantos} canal(is). Leva alguns minutos…\n`);
  const r = await logos.aplicarEmTodos(db, {
    forcar,
    // Uma linha por canal, na hora: é como se sabe que está andando.
    aoAndar: ({ i, total, canal, resultado, erro }) => {
      const marca = resultado === 'ok' ? '\x1b[32mok     \x1b[0m'
        : resultado === 'sem-logo' ? '\x1b[33msem logo\x1b[0m' : '\x1b[31merro   \x1b[0m';
      console.log(`  [${String(i).padStart(3)}/${total}] ${marca} ${canal}${erro ? ` — ${erro}` : ''}`);
    },
  });

  if (r.sem_logo.length) {
    console.log(`\n${r.sem_logo.length} canal(is) sem logo na lista pública:`);
    console.log(`  ${r.sem_logo.join(', ')}`);
    console.log('  Nesses, envie a imagem oficial da emissora pelo cadastro do canal (painel → Canais → Editar).');
  }
  if (r.falharam.length) {
    console.log(`\n${r.falharam.length} falhou(aram) na busca:`);
    for (const f of r.falharam) console.log(`  ${f.canal}: ${f.erro}`);

    // Falha espalhada por canais diferentes mas concentrada num host só, toda com o mesmo
    // código, não é frequência: é a rede do servidor não deixando sair para aquele endereço.
    // Sem este recado, a pessoa roda o script cinco vezes achando que é questão de esperar.
    const porHost = {};
    for (const f of r.falharam) if (f.host) porHost[f.host] = (porHost[f.host] ?? 0) + 1;
    const [host, quantos] = Object.entries(porHost).sort((a, b) => b[1] - a[1])[0] ?? [];
    if (quantos >= 5 && r.falharam.every((f) => /respondeu 40[13]/.test(f.erro))) {
      console.log(`\nTodas as ${quantos} falhas são do mesmo endereço (${host}), e todas com o mesmo código.`);
      console.log('Isso não é limite de frequência: é a rede deste servidor não deixando sair para esse endereço.');
      console.log(`Rode no servidor para confirmar:  curl -I https://${host}/`);
      console.log('Se não passar, libere a saída para esse endereço — repetir o script não resolve.');
    }
  }
  console.log(`\nResultado: ${r.com_logo.length} com logo, ${r.sem_logo.length} sem, ${r.falharam.length} com erro.`);
})().catch((err) => {
  console.error('Falhou:', err.message);
  process.exit(1);
}).finally(() => db.close());
