/**
 * Começar a tocar sozinho, mesmo com o navegador bloqueando.
 *
 * Todo navegador de celular bloqueia reprodução automática COM SOM. O código antigo pedia
 * `video.play()` e engolia a recusa em silêncio — por isso o canal abria parado, com a seta de
 * play no meio, e a pessoa tinha de tocar para começar. Ninguém abre um canal de TV para
 * apertar play depois.
 *
 * O caminho que funciona é conhecido e é o que toda plataforma de vídeo faz: tocar MUDO, que é
 * sempre permitido, e tirar o mudo em seguida. Na prática o som volta, porque houve gesto (a
 * pessoa tocou no canal). Quando o navegador segura o som mesmo assim, o canal fica no ar mudo
 * e quem está assistindo recebe um convite para tocar na tela — melhor que imagem parada, e
 * resolve com um toque.
 *
 * Mora num arquivo só dele para poder ser testado num navegador de verdade com a reprodução
 * automática bloqueada, que é a situação do iPhone.
 */

/** Quanto acompanhar o vídeo para ter certeza de que ele está mesmo tocando. */
const CONFERIR_MS = 1500;
const PASSO_MS = 150;

const esperar = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Está tocando DE VERDADE?
 *
 * No iPhone o `play()` pode resolver com sucesso e o sistema pausar o vídeo logo em seguida —
 * a promessa não rejeita, mas o canal fica parado. Conferir uma vez, logo depois, não pega
 * esse caso: a pausa chega atrasada. Por isso aqui se acompanha por um tempo, e basta um
 * instante pausado para saber que não vingou.
 *
 * Pausa que a própria pessoa pediu não conta — senão o código brigaria com quem quer pausar.
 */
async function tocandoDeVerdade(video, { ms = CONFERIR_MS, pausouDeProposito = () => false } = {}) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    await esperar(PASSO_MS);
    if (pausouDeProposito()) return true;
    if (video.paused) return false;
  }
  return !video.paused;
}

/**
 * @param video            o elemento <video>
 * @param aoPrecisarDeToque chamado quando o canal está no ar MAS mudo, e só um toque devolve o som
 * @param aoVoltarOSom      chamado quando o som está valendo (para tirar o convite da tela)
 * @param cancelado         () => bool — o player já fechou? não insista
 * @returns true se a reprodução começou (com som ou mudo), false se nem mudo foi
 */
export async function iniciarReproducao(video, {
  aoPrecisarDeToque = null,
  aoVoltarOSom = null,
  cancelado = () => false,
  pausouDeProposito = () => false,
  conferirMs = CONFERIR_MS,
} = {}) {
  if (cancelado()) return false;
  const conferir = () => tocandoDeVerdade(video, { ms: conferirMs, pausouDeProposito });

  // 1. Do jeito certo: com som. Funciona no computador e sempre que já houve gesto.
  //
  // Não basta o `play()` não dar erro. No iPhone ele resolve e o sistema pausa logo depois —
  // era assim que o canal ficava parado, com a seta de play no meio, sem erro nenhum e sem nem
  // mostrar o aviso de som. Por isso a reprodução é acompanhada antes de dar por boa.
  try {
    await video.play();
    if (await conferir()) { aoVoltarOSom?.(); return true; }
  } catch { /* bloqueado: vai pelo mudo */ }

  if (cancelado() || pausouDeProposito()) return false;

  // 2. Mudo, que é o que nenhum navegador bloqueia.
  const queriaComSom = !video.muted;
  video.muted = true;
  try {
    await video.play();
  } catch {
    return false;        // nem mudo o navegador deixou: aí o problema é outro, e o vigia cuida
  }
  if (!await conferir()) return false;
  if (!queriaComSom || cancelado()) return true;

  // 3. No ar, mudo. Agora devolve o som — e confere de novo, porque tirar o mudo é exatamente
  // o que faz o iPhone pausar.
  video.muted = false;
  if (await conferir() && !video.muted) { aoVoltarOSom?.(); return true; }

  // O som não vingou. Melhor canal no ar mudo, com um convite de um toque, que tela parada.
  if (cancelado() || pausouDeProposito()) return true;
  video.muted = true;
  video.play().catch(() => {});
  aoPrecisarDeToque?.();
  return true;
}
