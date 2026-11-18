'use strict';

/**
 * Prepara **todos** os aplicativos da PLAY TECH VIP para o servidor de vocês, de uma vez:
 *
 *   node scripts/empacotar-apps.js https://play.seudominio.com.br
 *
 * O que ele faz em cada um:
 *   Samsung (Tizen) e LG (webOS) — monta o pacote com a interface dentro do aparelho.
 *   Android TV (TCL, Google TV)  — escreve o endereço do servidor no projeto.
 *   Android celular e tablet     — idem.
 *   iPhone e iPad                — idem, no arquivo Swift.
 *   App instalável (PWA)         — nada a fazer: ele é servido pelo próprio servidor.
 *
 * Depois, cada loja tem a sua ferramenta — o passo a passo está em APPS.md.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const raiz = path.join(__dirname, '..');
const servidor = String(process.argv[2] || '').replace(/\/+$/, '');

if (!servidor || !/^https?:\/\//.test(servidor)) {
  console.error('Informe o endereço do servidor. Exemplo:\n  node scripts/empacotar-apps.js https://play.seudominio.com.br');
  process.exit(1);
}
if (servidor.startsWith('http://')) {
  console.warn('Atenção: TVs, iPhone e Android exigem HTTPS. Use https em produção.\n');
}

/** Troca um trecho num arquivo, avisando quando o alvo não existe mais. */
function trocar(arquivo, procurar, trocarPor, oQue) {
  const caminho = path.join(raiz, arquivo);
  if (!fs.existsSync(caminho)) {
    console.log(`  —  ${oQue}: ${arquivo} não encontrado (pulando)`);
    return false;
  }
  const antes = fs.readFileSync(caminho, 'utf8');
  const depois = antes.replace(procurar, trocarPor);
  if (antes === depois) {
    console.log(`  —  ${oQue}: nada a trocar em ${path.basename(arquivo)} (o endereço já está lá?)`);
    return false;
  }
  fs.writeFileSync(caminho, depois);
  console.log(`  ✓  ${oQue}`);
  return true;
}

console.log(`Configurando os apps para ${servidor}\n`);

// ---- Samsung e LG: a interface vai dentro do aparelho (usa o empacotador das TVs).
console.log('TVs Samsung e LG');
try {
  const saida = execFileSync(process.execPath, [path.join(__dirname, 'empacotar-tv.js'), servidor], { encoding: 'utf8' });
  for (const linha of saida.trim().split('\n').slice(0, 2)) console.log(`  ✓  ${linha}`);
} catch (err) {
  console.log(`  ✗  falhou: ${err.message.split('\n')[0]}`);
}

// ---- Android TV: o endereço fica em strings.xml, com o modo TV ligado.
console.log('\nAndroid TV (TCL, Google TV)');
trocar('tv-apps/android-tv/app/src/main/res/values/strings.xml',
  /<string name="servidor">[^<]*<\/string>/,
  `<string name="servidor">${servidor}/?tv=1</string>`,
  'endereço do servidor no projeto do Android TV');

// ---- Android celular e tablet.
console.log('\nAndroid celular e tablet');
trocar('celular-apps/android/app/src/main/res/values/strings.xml',
  /<string name="servidor">[^<]*<\/string>/,
  `<string name="servidor">${servidor}/</string>`,
  'endereço do servidor no projeto Android');

// ---- iPhone e iPad.
console.log('\niPhone e iPad');
trocar('celular-apps/ios/PlayTechVip/Servidor.swift',
  /let SERVIDOR = "[^"]*"/,
  `let SERVIDOR = "${servidor}/"`,
  'endereço do servidor no projeto iOS');

console.log(`
Pronto. Agora é empacotar em cada loja:

  Samsung    tizen build-web -- tv-apps/samsung-tizen/dist
             tizen package -t wgt -s <perfil> -- tv-apps/samsung-tizen/dist/.buildResult
  LG         ares-package tv-apps/lg-webos/dist
  Android TV cd tv-apps/android-tv && ./gradlew assembleRelease
  Android    cd celular-apps/android && ./gradlew assembleRelease   (ou bundleRelease para a Play)
  iPhone     cd celular-apps/ios && xcodegen generate && open PlayTechVip.xcodeproj

O app instalável (PWA) já está no ar junto com o servidor: o assinante abre ${servidor}
no celular e escolhe "Instalar". O passo a passo de cada loja está em APPS.md.`);
