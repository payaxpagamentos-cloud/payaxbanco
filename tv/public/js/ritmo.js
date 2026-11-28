/**
 * Reconstrói a reserva de um canal ao vivo que começou com pouca.
 *
 * Canal frio é liberado com 6 s de vídeo para o assinante não esperar, e isso tem preço: ele
 * começa a tocar com 2,5 a 6 s de reserva, contra os 20 s de um canal que já estava no ar. Num
 * ao vivo a reserva não cresce sozinha — o servidor produz um segundo de vídeo por segundo e o
 * player consome um segundo por segundo. Quem começa perto da ponta fica perto da ponta.
 *
 * A saída é consumir um pouco menos do que chega: com a reserva baixa, o vídeo toca a 95% da
 * velocidade. Ninguém percebe 5% (o navegador mantém o tom da voz), e a cada minuto assim o
 * player fica 3 s mais longe da ponta. Chegando à reserva boa, volta ao normal.
 *
 * Só mexe em canal ao vivo, só enquanto está tocando, e devolve a velocidade normal ao parar.
 * Se o assinante mudar a velocidade por conta própria, isto não briga com ele.
 */

export const RITMO_LENTO = 0.95;

/**
 * @param {HTMLVideoElement} video
 * @param {{ baixaS?: number, boaS?: number, intervaloMs?: number }} [opcoes]
 *   baixaS: abaixo disto desacelera; boaS: a partir disto volta ao normal (a distância entre os
 *   dois evita ficar ligando e desligando em cima da linha).
 * @returns {() => void} para de cuidar e devolve a velocidade normal
 */
export function cuidarDaReserva(video, { baixaS = 6, boaS = 9, intervaloMs = 1000 } = {}) {
  let lento = false;

  const reserva = () => {
    try {
      const b = video.buffered;
      return b.length ? b.end(b.length - 1) - video.currentTime : 0;
    } catch { return 0; }
  };

  const conferir = () => {
    // Pausado ou ainda carregando: não há o que ajustar, e mexer na velocidade aqui só atrapalha.
    if (video.paused || video.readyState < 3) return;
    // Velocidade que não é nem a normal nem a nossa: alguém escolheu. Fica como está.
    if (video.playbackRate !== 1 && video.playbackRate !== RITMO_LENTO) return;
    const r = reserva();
    if (!lento && r < baixaS) { lento = true; video.playbackRate = RITMO_LENTO; }
    else if (lento && r >= boaS) { lento = false; video.playbackRate = 1; }
  };

  const relogio = setInterval(conferir, intervaloMs);
  relogio?.unref?.();
  return () => {
    clearInterval(relogio);
    if (lento && video.playbackRate === RITMO_LENTO) video.playbackRate = 1;
    lento = false;
  };
}
