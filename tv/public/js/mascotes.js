/**
 * Mascotes da PLAY TECH VIP — as fotos de perfil.
 *
 * Personagens próprios, desenhados em SVG (scripts/mascotes.js os gera). A lista fica aqui, e
 * não vem da API, porque são arquivos entregues com o app: não mudam por instalação e assim a
 * tela de perfis monta sem esperar resposta de rede.
 */

export const MASCOTES = [
  { id: 'leao', nome: 'Leão' },
  { id: 'raposa', nome: 'Raposa' },
  { id: 'panda', nome: 'Panda' },
  { id: 'coruja', nome: 'Coruja' },
  { id: 'gato', nome: 'Gato' },
  { id: 'robo', nome: 'Robô' },
  { id: 'astronauta', nome: 'Astronauta' },
  { id: 'dino', nome: 'Dino' },
  { id: 'urso', nome: 'Urso' },
  { id: 'pinguim', nome: 'Pinguim' },
  { id: 'tigre', nome: 'Tigre' },
  { id: 'alien', nome: 'Alien' },
];

/** Endereço do arquivo. Id desconhecido cai no primeiro, para nunca sobrar moldura vazia. */
export function urlMascote(id) {
  const existe = MASCOTES.some((m) => m.id === id);
  return new URL(`../img/mascotes/${existe ? id : MASCOTES[0].id}.svg`, import.meta.url).pathname;
}
