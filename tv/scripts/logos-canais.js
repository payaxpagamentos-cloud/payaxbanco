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
  // Logo que já estava no banco antes desta medição existir: mede agora. É o que decide se a
  // tela põe fundo claro atrás dele — sem isso, metade dos logos continua sumindo no preto.
  // TODOS os logos salvos, não só os sem medida: a regra de medição mudou (passou a olhar o
  // canal mais forte em vez da luminância, para cor saturada não ser confundida com cor
  // escura), e valor medido pela regra antiga está errado. Medir de novo custa alguns segundos.
  const semMedida = db.prepare('SELECT id, nome FROM canais WHERE logo_midia_id IS NOT NULL').all();
  if (semMedida.length) {
    console.log(`Medindo de novo a claridade de ${semMedida.length} logo(s) salvos…`);
    let medidos = 0;
    for (const c of semMedida) if (logos.medirDoCanal(db, c.id) !== null) medidos += 1;
    console.log(`  ${medidos} medido(s).\n`);
  }

  const quantos = db.prepare(`SELECT COUNT(*) AS n FROM canais ${forcar ? '' : 'WHERE logo_midia_id IS NULL'}`).get().n;
  if (!quantos) {
    console.log('Todos os canais já têm logo. Use --forcar para buscar de novo.');
    return;
  }

  console.log(`Buscando o logo de ${quantos} canal(is). Leva alguns minutos…\n`);
  const r = await logos.aplicarEmTodos(db, {
    forcar,
    // Uma linha por canal, na hora: é como se sabe que está andando. A linha "tentando" é
    // reescrita por cima quando o canal termina — um canal que esgota prazo e repete leva mais
    // de dois minutos, e sem ela o terminal fica mudo e parece travado.
    aoAndar: ({ i, total, canal, resultado, erro, host, hostDesistido }) => {
      const posicao = `  [${String(i).padStart(3)}/${total}] `;
      if (resultado === 'tentando') {
        if (process.stdout.isTTY) process.stdout.write(`${posicao}\x1b[2m…      ${canal}\x1b[0m`);
        return;
      }
      if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K');
      const marca = resultado === 'ok' ? '\x1b[32mok     \x1b[0m'
        : resultado === 'sem-logo' ? '\x1b[33msem logo\x1b[0m'
          : resultado === 'pulado' ? '\x1b[33mpulado \x1b[0m' : '\x1b[31merro   \x1b[0m';
      const cauda = resultado === 'pulado' ? ` — ${host} está recusando; fica para a próxima rodada` : (erro ? ` — ${erro}` : '');
      console.log(`${posicao}${marca} ${canal}${cauda}`);
      if (hostDesistido) {
        console.log(`\n  \x1b[33m${hostDesistido} recusou ${5} vezes seguidas: parando de pedir a ele nesta rodada.\x1b[0m`);
        console.log('  Os canais que dependem dele ficam para a próxima — os outros seguem normalmente.\n');
      }
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
  if (r.hosts_bloqueados?.length) {
    console.log(`\n\x1b[33mQuem hospeda bloqueou este servidor: ${r.hosts_bloqueados.join(', ')}.\x1b[0m`);
    console.log('É bloqueio por ENDEREÇO, não por imagem: depois de muitos pedidos seguidos, o host fecha');
    console.log('a porta para o IP inteiro e responde na hora, sem adiantar esperar nem tentar de novo agora.');
    console.log('(A lista pública guarda 79% dos logos de canais brasileiros no imgur, que faz exatamente isso.)');
    if (r.pulados) console.log(`\n${r.pulados} canal(is) nem chegaram a ser pedidos, para não gastar hora à toa.`);
    console.log('\nO que fazer, em ordem:');
    console.log('  1. Rode este mesmo comando daqui a algumas horas — ele só mexe em quem ainda está sem logo,');
    console.log('     então vai direto no que faltou, sem refazer nada.');
    console.log('  2. Nos canais que a operação não quer esperar, envie a imagem da emissora pelo painel:');
    console.log('     Canais → Editar → logo. É o caminho que não depende de ninguém de fora.');
  }
  console.log(`\nResultado: ${r.com_logo.length} com logo, ${r.sem_logo.length} sem, ${r.falharam.length} com erro${r.pulados ? `, ${r.pulados} adiado(s)` : ''}.`);
  const faltando = db.prepare('SELECT COUNT(*) AS n FROM canais WHERE logo_midia_id IS NULL').get().n;
  if (faltando) console.log(`Ainda sem logo no total: ${faltando} canal(is).`);
})().catch((err) => {
  console.error('Falhou:', err.message);
  process.exit(1);
}).finally(() => db.close());
