/**
 * Vigia da reprodução: nada pode ficar travado.
 *
 * O travamento que o assinante vê quase nunca vem acompanhado de um erro. O vídeo simplesmente
 * para de avançar: o buffer acabou, um pedaço sumiu, a ponta do ao vivo ficou para trás. Em
 * nenhum desses casos o navegador dispara 'error', então quem só escuta erro não percebe nada.
 *
 * E no iPhone é pior: lá o HLS é nativo, o hls.js nem entra em campo, e a recuperação dele não
 * existe. Era o caso do canal que parava com a rodinha girando para sempre.
 *
 * Daí este vigia, que não depende de motor nenhum: ele olha o relógio do vídeo. Se o tempo não
 * anda enquanto deveria andar, ele aplica os remédios em ordem, esperando cada vez mais entre
 * um e outro — para um canal realmente fora do ar não virar martelo no servidor.
 *
 * Mora num arquivo só dele para poder ser testado com um <video> e um HLS de verdade, sem subir
 * a plataforma inteira. Era a única parte do player que não dava para provar que funciona.
 */

/** Espera antes da próxima tentativa: 2s, 4s, 8s… até o teto. */
export const esperaDoPasso = (passo, teto = 20_000) => Math.min(2000 * (2 ** (passo - 1)), teto);

/**
 * @param video      elemento <video> a vigiar
 * @param remedios   o que tentar, em ordem. O último se repete enquanto for preciso.
 * @param aoVivo     canal ao vivo NÃO desiste: a origem pode voltar a qualquer momento, e tela
 *                   de erro num canal de TV é pior que uma espera com aviso.
 * @param aoMudar    ({ estado, passo }) para a tela mostrar rodinha, "Reconectando…" ou limpar.
 *                   estado: 'travado' | 'tentando' | 'voltou' | 'desistiu'
 */
export function vigiarReproducao(video, {
  remedios = [],
  aoVivo = false,
  aoMudar = null,
  paradoMs = 6000,
  intervaloMs = 2000,
  tentativasAteDesistir = 6,
  tetoEsperaMs = 20_000,
  recuperadoMs = 8000,
  agora = () => Date.now(),
} = {}) {
  let tempoVisto = -1;
  let paradoDesde = 0;
  let andandoDesde = 0;
  let passo = 0;
  let proximaAcaoEm = 0;
  let aplicando = false;
  let parado = false;
  let desistiu = false;

  async function aplicarRemedio() {
    if (aplicando || parado) return;
    aplicando = true;
    passo += 1;
    proximaAcaoEm = agora() + esperaDoPasso(passo, tetoEsperaMs);
    paradoDesde = 0;
    andandoDesde = 0;
    aoMudar?.({ estado: 'tentando', passo });
    try {
      const remedio = remedios[Math.min(passo, remedios.length) - 1];
      await remedio?.({ passo });
    } catch { /* remédio que falha é só mais um que não resolveu: o próximo vem na sequência */ } finally {
      // O remédio costuma mexer no relógio do vídeo (pular para a ponta do ao vivo, recarregar
      // do zero). Essa mexida NÃO é o vídeo andando: tomar a posição nova como ponto de partida
      // é o que impede a batida seguinte de ler o salto como recuperação. Antes isto zerava a
      // contagem e a escada de remédios nunca passava do primeiro degrau.
      tempoVisto = video.currentTime;
      paradoDesde = 0;
      aplicando = false;
    }
  }

  function bater() {
    if (parado || desistiu) return;
    // Pausado de propósito, buscando outra posição ou acabou: não é travamento.
    if (video.paused || video.seeking || video.ended) { tempoVisto = video.currentTime; paradoDesde = 0; return; }
    const t = video.currentTime;
    if (t > tempoVisto + 0.05) {                       // andou
      tempoVisto = t;
      paradoDesde = 0;
      if (!passo) return;                              // nunca esteve travado: nada a fazer
      // Só se declara recuperado depois de andar um tempo seguido. Canal que toca dois segundos
      // e trava de novo é o caso comum de origem ruim; zerar a contagem a cada suspiro faria a
      // escada recomeçar do primeiro degrau para sempre, sem nunca chegar no remédio que resolve.
      if (!andandoDesde) { andandoDesde = agora(); return; }
      if (agora() - andandoDesde < recuperadoMs) return;
      passo = 0;
      proximaAcaoEm = 0;
      andandoDesde = 0;
      aoMudar?.({ estado: 'voltou', passo: 0 });
      return;
    }
    andandoDesde = 0;                                  // parou de novo: o avanço não se sustentou
    if (!paradoDesde) { paradoDesde = agora(); aoMudar?.({ estado: 'travado', passo }); return; }
    if (agora() - paradoDesde < paradoMs || agora() < proximaAcaoEm) return;
    // Sob demanda tem fim: depois de tanta tentativa o filme não vai voltar, e a pessoa precisa
    // de uma saída em vez de uma rodinha eterna. Ao vivo não desiste.
    if (!aoVivo && passo >= tentativasAteDesistir) { desistiu = true; aoMudar?.({ estado: 'desistiu', passo }); return; }
    aplicarRemedio();
  }

  const relogio = setInterval(bater, intervaloMs);
  // No Node (testes) um intervalo aberto segura o processo de pé para sempre; no navegador não
  // existe `unref`. Sem isto, um teste que falha antes de chamar `parar()` deixa a suíte pendurada.
  relogio?.unref?.();
  return {
    parar() { parado = true; clearInterval(relogio); },
    /** Chamado por quem já sabe que deu erro (hls.js fatal, evento 'error' do vídeo). */
    forcar() { if (!parado && !desistiu && agora() >= proximaAcaoEm) aplicarRemedio(); },
    /** "Tentar de novo" na tela de erro: volta tudo ao começo. */
    rearmar() { passo = 0; proximaAcaoEm = 0; paradoDesde = 0; andandoDesde = 0; tempoVisto = -1; desistiu = false; },
    get passo() { return passo; },
    get desistiu() { return desistiu; },
    bater,                                             // exposto para o teste não depender do relógio
  };
}
