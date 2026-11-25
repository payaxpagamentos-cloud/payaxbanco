/**
 * Cartazes da vitrine da tela de entrada.
 *
 * São as artes de demonstração que vieram no pacote de desenho, recortadas em arquivos
 * próprios e convertidas para WebP. Servem para a tela de entrada ter o visual aprovado
 * mesmo com o catálogo ainda vazio.
 *
 * ATENÇÃO: são imitações de cartazes de filmes de grandes estúdios, geradas por IA. Servem
 * para apresentação; **não devem ficar no ar quando a plataforma abrir ao público**, porque a
 * operação não tem licença desses títulos. Para passar aos cartazes do catálogo do cliente,
 * troque uma linha em entrada.js: use `r.vitrine` (que /api/publico já devolve) no lugar de
 * CARTAZES_DEMO. O carrossel aceita as duas listas sem mudar mais nada.
 */
export const CARTAZES_DEMO = [
  { id: 'duna-parte-dois', nome: 'Duna: Parte Dois', arquivo: 'duna-parte-dois.webp' },
  { id: 'missao-impossivel', nome: 'Missão Impossível', arquivo: 'missao-impossivel.webp' },
  { id: 'a-procura-da-felicidade', nome: 'À Procura da Felicidade', arquivo: 'a-procura-da-felicidade.webp' },
  { id: 'divertida-mente-2', nome: 'Divertida Mente 2', arquivo: 'divertida-mente-2.webp' },
  { id: 'interestelar', nome: 'Interestelar', arquivo: 'interestelar.webp' },
  { id: 'gladiador', nome: 'Gladiador', arquivo: 'gladiador.webp' },
  { id: 'avatar', nome: 'Avatar', arquivo: 'avatar.webp' },
  { id: 'jurassic-park', nome: 'Jurassic Park', arquivo: 'jurassic-park.webp' },
];
