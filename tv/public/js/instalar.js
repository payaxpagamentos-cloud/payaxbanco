/**
 * Instalação no celular: o app vira um ícone na tela inicial e abre em tela cheia,
 * sem barra de navegador — no Android pelo próprio navegador, no iPhone pelo "Adicionar
 * à Tela de Início". Também registra o service worker, que guarda os arquivos do app.
 */

import { el, icone, modal, toast } from './ui.js';

let convite = null;          // evento do Android/Chrome, guardado até o assinante pedir
let jaRegistrou = false;

/** O app já está aberto como aplicativo (instalado)? */
export const instalado = () => window.matchMedia('(display-mode: standalone)').matches
  || window.matchMedia('(display-mode: fullscreen)').matches
  || window.navigator.standalone === true;

const ehIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const ehCelular = () => window.matchMedia('(max-width: 900px)').matches || navigator.maxTouchPoints > 1;

/** Guarda o convite de instalação do Android para usar quando o assinante quiser. */
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  convite = e;
});

window.addEventListener('appinstalled', () => {
  convite = null;
  try { localStorage.setItem('playtechvip.instalado', '1'); } catch { /* sem armazenamento */ }
});

/**
 * Liga o service worker. Só funciona em https (ou localhost) — fora disso o navegador
 * não registra, e o app continua normal, só sem o cache.
 */
export function registrarServiceWorker() {
  if (jaRegistrou || !('serviceWorker' in navigator)) return;
  jaRegistrou = true;
  const base = new URL('..', import.meta.url);
  // Se já havia um service worker no comando, a troca de controlador significa versão nova.
  // Na primeira visita não há nenhum, e aí a troca é só a instalação — não recarrega.
  const jaTinhaControlador = Boolean(navigator.serviceWorker.controller);
  let recarregando = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!jaTinhaControlador || recarregando) return;
    // Não interrompe quem está assistindo: nesse caso a versão nova entra ao sair do player.
    if ([...document.querySelectorAll('video')].some((v) => !v.paused && !v.ended)) return;
    recarregando = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('sw.js', base), { scope: base.pathname }).then((reg) => {
      // Versão nova publicada: o service worker novo assume na hora e a página se recarrega
      // uma vez sozinha, senão a aba continuaria mostrando os arquivos da versão anterior.
      reg.addEventListener('updatefound', () => {
        const novo = reg.installing;
        novo?.addEventListener('statechange', () => {
          if (novo.state === 'installed' && navigator.serviceWorker.controller) novo.postMessage('assumir');
        });
      });
    }).catch(() => { /* navegador sem suporte ou sem https: segue sem cache */ });
  });
}

/** Passo a passo do iPhone, que não tem instalação automática. */
function comoNoIphone() {
  modal('Instalar no iPhone', () => [
    el('p', { class: 'mudo' }, 'O iPhone instala pelo próprio Safari, em dois toques:'),
    el('ol', { style: 'margin:0 0 4px 18px;line-height:1.9' },
      el('li', {}, 'Toque em ', el('strong', {}, 'Compartilhar'), ' (o quadrado com a seta para cima).'),
      el('li', {}, 'Escolha ', el('strong', {}, 'Adicionar à Tela de Início'), '.'),
      el('li', {}, 'Confirme em ', el('strong', {}, 'Adicionar'), '.')),
    el('p', { class: 'pequeno mudo' }, 'O ícone da PLAY TECH VIP fica na tela do celular e o app abre em tela cheia.'),
  ]);
}

/** Abre a instalação: no Android pelo convite do navegador, no iPhone pelo passo a passo. */
export async function instalar() {
  if (convite) {
    convite.prompt();
    const { outcome } = await convite.userChoice;
    convite = null;
    if (outcome === 'accepted') toast('Instalando o app…');
    return;
  }
  if (ehIOS()) { comoNoIphone(); return; }
  toast('Use o menu do navegador e escolha "Instalar aplicativo".');
}

/** Dá para oferecer a instalação neste aparelho? */
export const podeInstalar = () => !instalado() && (Boolean(convite) || (ehIOS() && ehCelular()));

/** Botão para a janela da conta (ou null, quando não cabe oferecer). */
export function botaoInstalar(aoClicar) {
  if (!podeInstalar()) return null;
  return el('button', {
    class: 'btn bloco vazio',
    onclick: () => { aoClicar?.(); instalar(); },
  }, 'Instalar o app no celular');
}

/**
 * Convite discreto, uma vez só: aparece no rodapé da tela depois que o assinante
 * já está dentro, e não volta se ele dispensar.
 */
export function convidarUmaVez() {
  if (!podeInstalar()) return;
  let dispensado = false;
  try { dispensado = localStorage.getItem('playtechvip.convite-app') === 'nao'; } catch { /* ignora */ }
  if (dispensado) return;

  const fechar = () => {
    faixa.remove();
    try { localStorage.setItem('playtechvip.convite-app', 'nao'); } catch { /* ignora */ }
  };
  const faixa = el('div', { class: 'convite-app' },
    el('img', { src: new URL('../img/icone-192.png', import.meta.url).pathname, alt: '', width: 36, height: 36 }),
    el('div', { class: 'texto' },
      el('strong', {}, 'Instale o app'),
      el('div', { class: 'pequeno mudo' }, 'Ícone na tela inicial.')),
    el('button', { class: 'btn pequeno primario', onclick: () => { fechar(); instalar(); } }, 'Instalar'),
    el('button', { class: 'btn pequeno vazio icone', title: 'Agora não', onclick: fechar }, icone('fechar', 16)));
  document.body.append(faixa);
  setTimeout(() => faixa.classList.add('aberto'), 50);
}
