'use strict';

/**
 * Canais de TV aberta: nome, canal virtual, categoria e onde fica o sinal de cada emissora.
 *
 * Cada canal entra no ar assim que a operação cadastrar o endereço dele em Canais, de um
 * destes dois jeitos:
 *   `hls`   — a lista .m3u8 do sinal (a da emissora, a da afiliada da praça ou a do encoder
 *             próprio de quem opera a retransmissora);
 *   `embed` — o endereço do player oficial e público da emissora, quando ela já transmite
 *             aberto na internet (o player dela entra na tela, com os anúncios dela).
 *
 * A lista abaixo já deixa tudo cadastrado: número, categoria, grupo e onde procurar o sinal.
 */

// canal virtual, nome, categoria, grupo, onde fica o sinal, id na lista pública (para o logo)
const CANAIS_ABERTOS = [
  [2, 'TV Cultura', 'aberta', 'Fundação Padre Anchieta',
    'Transmite aberto no site cmais.com.br/aovivo e no canal oficial do YouTube — dá para usar a fonte "embed" direto.', 'TVCultura.br'],
  [4, 'SBT', 'aberta', 'Grupo Silvio Santos',
    'Sinal pela emissora ou pela afiliada da praça. O SBT News transmite aberto no YouTube e serve como fonte "embed".', null],
  [5, 'TV Globo', 'aberta', 'Grupo Globo',
    'Sinal pela emissora ou pela afiliada da praça (quem opera retransmissora costuma ter o endereço do próprio encoder).', 'RedeGlobo.br'],
  [7, 'Record', 'aberta', 'Grupo Record',
    'Sinal pela emissora ou pela afiliada da praça. O R7 e o Record News transmitem faixas abertas na internet.', 'Record.br'],
  [9, 'RedeTV!', 'aberta', 'Rede TV!',
    'Sinal pela emissora. O portal da RedeTV! transmite programas ao vivo que servem como fonte "embed".', 'RedeTV.br'],
  [11, 'TV Gazeta', 'aberta', 'Fundação Cásper Líbero',
    'Transmite aberto no próprio site e no YouTube oficial — fonte "embed" direto.', 'TVGazeta.br'],
  [13, 'Band', 'aberta', 'Grupo Bandeirantes',
    'Transmite aberto em band.uol.com.br/tv-ao-vivo e no YouTube oficial — fonte "embed" direto.', 'Band.br'],
  [21, 'Rede Brasil', 'aberta', 'Rede Brasil de Televisão',
    'Sinal pela emissora; rede de alcance menor, costuma liberar o endereço rápido.', 'RedeBrasil.br'],
  [28, 'TV Brasil', 'aberta', 'EBC — Empresa Brasil de Comunicação',
    'Emissora pública federal: transmite aberto em tvbrasil.ebc.com.br/aovivo e no YouTube oficial, e a EBC cede conteúdo.', 'TVBrasil.br'],
  [32, 'TV Aparecida', 'religioso', 'Rede Aparecida',
    'Transmite aberto no site e no YouTube oficial — fonte "embed" direto.', 'TVAparecida.br'],
  [38, 'Rede Vida', 'religioso', 'Rede Vida',
    'Transmite aberto no site e no YouTube oficial — fonte "embed" direto.', 'RedeVida.br'],
  [42, 'Record News', 'noticias', 'Grupo Record',
    'Canal de notícias com transmissão aberta no YouTube oficial — fonte "embed" direto.', 'RecordNews.br'],
  [48, 'SBT News', 'noticias', 'Grupo Silvio Santos',
    'Canal de notícias 24 horas, com transmissão aberta no YouTube oficial — fonte "embed" direto.', 'SBTNews.br'],
  [60, 'BandNews TV', 'noticias', 'Grupo Bandeirantes',
    'Transmite faixas abertas no portal e no YouTube oficial — fonte "embed" direto.', 'BandNews.br'],
  [70, 'Jovem Pan News', 'noticias', 'Jovem Pan',
    'Transmite 24 horas no YouTube oficial — fonte "embed" direto.', 'JovemPanNews.br'],
];

/**
 * Os números seguem a grade de São Paulo. O canal virtual muda de praça para praça
 * (a Globo é 5 em São Paulo e 4 no Rio): a operação ajusta depois de importar.
 */
const AVISO_NUMEROS = 'Os números seguem a grade de São Paulo. Em outras praças, ajuste o número de cada canal.';

module.exports = { CANAIS_ABERTOS, AVISO_NUMEROS };
