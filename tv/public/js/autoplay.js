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

/** Quanto esperar, depois de tirar o mudo, para ver se o navegador deixou. */
const ESPERA_SOM_MS = 150;

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
  esperaSomMs = ESPERA_SOM_MS,
} = {}) {
  if (cancelado()) return false;
  // 1. Do jeito certo: com som. Funciona no computador e sempre que já houve gesto.
  try {
    await video.play();
    aoVoltarOSom?.();
    return true;
  } catch { /* bloqueado: vai pelo mudo */ }

  if (cancelado()) return false;
  const queriaComSom = !video.muted;
  video.muted = true;
  try {
    await video.play();
  } catch {
    return false;        // nem mudo o navegador deixou: aí o problema é outro, e o vigia cuida
  }
  if (!queriaComSom || cancelado()) return true;

  // 2. No ar, mudo. Agora devolve o som.
  video.muted = false;
  await new Promise((r) => { setTimeout(r, esperaSomMs); });
  if (cancelado()) return true;

  // Tirar o mudo pode fazer o navegador pausar de novo. Só então vale incomodar a pessoa.
  if (video.paused || video.muted) {
    video.muted = true;
    video.play().catch(() => {});
    aoPrecisarDeToque?.();
  } else {
    aoVoltarOSom?.();
  }
  return true;
}
