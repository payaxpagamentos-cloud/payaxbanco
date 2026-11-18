'use strict';

/**
 * Registro da TV aberta brasileira: nome, canal virtual, categoria e onde a emissora
 * publica o sinal oficial.
 *
 * IMPORTANTE — como o sinal entra na PLAY TV:
 *   Nenhuma emissora publica um endereço HLS livre para retransmissão. Para cada canal,
 *   a operação precisa de UMA destas três coisas, e cadastra em Canais:
 *     1. `hls`   — o endereço .m3u8 que a emissora (ou a afiliada local) fornece por contrato
 *                  de distribuição, ou o sinal do encoder próprio de quem é afiliado;
 *     2. `embed` — o endereço do player oficial e público da emissora (por exemplo, a
 *                  transmissão ao vivo do canal verificado no YouTube). Aqui a PLAY TV
 *                  **não retransmite nada**: ela abre o player da própria emissora, com os
 *                  anúncios dela, como faz qualquer site que incorpora o vídeo;
 *     3. nada    — o canal fica cadastrado e desligado até o sinal chegar.
 *
 * Esta lista já deixa tudo cadastrado (número, categoria, região e o lembrete de onde pedir
 * o sinal). O que falta em cada linha é só o endereço.
 */

// canal virtual, nome, categoria, grupo, site oficial, observação para a operação
const CANAIS_ABERTOS = [
  [2, 'TV Cultura', 'aberta', 'Fundação Padre Anchieta', 'https://cmais.com.br/aovivo',
    'Emissora pública paulista. A Fundação Padre Anchieta transmite ao vivo no site e no canal oficial do YouTube: use o endereço do player oficial (fonte "embed") ou peça o sinal pela área de relacionamento.'],
  [4, 'SBT', 'aberta', 'Grupo Silvio Santos', 'https://www.sbt.com.br',
    'Sinal por contrato de distribuição com o SBT ou com a afiliada local. O SBT News (jornalismo) tem transmissão ao vivo pública no YouTube, que serve como fonte "embed".'],
  [5, 'TV Globo', 'aberta', 'Grupo Globo', 'https://globoplay.globo.com/agora-na-globo/',
    'O sinal ao vivo da Globo é distribuído pelo Globoplay e exige contrato com o Grupo Globo (ou com a afiliada da sua praça). Não há endereço público para retransmitir.'],
  [7, 'Record', 'aberta', 'Grupo Record', 'https://www.r7.com',
    'Sinal por contrato com a Record (ou com a afiliada local). Em 2026 a Record também passou a distribuir o canal ao vivo por serviços pagos, o que indica que a liberação é comercial.'],
  [9, 'RedeTV!', 'aberta', 'Rede TV!', 'https://www.redetv.uol.com.br',
    'Sinal por contrato com a RedeTV!. O site publica trechos e programas ao vivo em algumas faixas, que podem ser usados como fonte "embed".'],
  [11, 'TV Gazeta', 'aberta', 'Fundação Cásper Líbero', 'https://www.tvgazeta.com.br',
    'Emissora paulista. Transmite ao vivo no próprio site e no YouTube: dá para usar a fonte "embed".'],
  [13, 'Band', 'aberta', 'Grupo Bandeirantes', 'https://www.band.uol.com.br/tv-ao-vivo',
    'A Band publica transmissões ao vivo no próprio portal e no YouTube (fonte "embed"). Para retransmitir o sinal, contrato com o Grupo Bandeirantes.'],
  [21, 'Rede Brasil', 'aberta', 'Rede Brasil de Televisão', 'https://www.redebrasil.tv.br',
    'Rede nacional de alcance menor; costuma liberar o sinal por contrato direto.'],
  [28, 'TV Brasil', 'aberta', 'EBC — Empresa Brasil de Comunicação', 'https://tvbrasil.ebc.com.br/aovivo',
    'Emissora pública federal (EBC). Transmite ao vivo no site e no YouTube oficial, e a EBC tem política de cessão de conteúdo: é o caminho mais curto para um canal aberto de verdade na plataforma.'],
  [32, 'TV Aparecida', 'religioso', 'Rede Aparecida', 'https://www.tvaparecida.com.br',
    'Transmite ao vivo no site e no YouTube oficial (fonte "embed").'],
  [38, 'Rede Vida', 'religioso', 'Rede Vida', 'https://www.redevida.com.br',
    'Transmite ao vivo no site e no YouTube oficial (fonte "embed").'],
  [42, 'Record News', 'noticias', 'Grupo Record', 'https://recordnews.r7.com',
    'Canal de notícias da Record, com transmissão ao vivo pública no YouTube (fonte "embed").'],
  [48, 'SBT News', 'noticias', 'Grupo Silvio Santos', 'https://sbtnews.sbt.com.br',
    'Canal linear de notícias do SBT, no ar desde dezembro de 2025, com transmissão ao vivo pública no YouTube (fonte "embed").'],
  [60, 'BandNews TV', 'noticias', 'Grupo Bandeirantes', 'https://www.band.uol.com.br/bandnews',
    'Canal de notícias do Grupo Bandeirantes, com faixas ao vivo públicas no portal e no YouTube (fonte "embed").'],
  [70, 'Jovem Pan News', 'noticias', 'Jovem Pan', 'https://jovempan.com.br',
    'Transmite 24 horas no YouTube oficial (fonte "embed").'],
];

/**
 * Os números de canal variam por cidade (o canal virtual da Globo é 5 em São Paulo e 4 no Rio,
 * por exemplo). A operação ajusta em Canais depois de importar.
 */
const AVISO_NUMEROS = 'Os números seguem a grade de São Paulo. Em outras praças, ajuste o número de cada canal.';

module.exports = { CANAIS_ABERTOS, AVISO_NUMEROS };
