/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/
/**
 * Pausa dos efeitos contínuos (gradiente fluido, órbita, pulsos): o botão do topo liga e desliga, e a escolha fica lembrada no
 * navegador. Com "reduzir movimento" no sistema, começa pausado (e o CSS já tira as animações).
 */
const CHAVE = 'rastreador.efeitos';
const raiz = document.documentElement;

function inicial() {
  try {
    const salvo = localStorage.getItem(CHAVE);
    if (salvo) return salvo === 'pausados';
  } catch { /* sem armazenamento */ }
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}
raiz.classList.toggle('efeitos-pausados', inicial());

export const efeitosPausados = () => raiz.classList.contains('efeitos-pausados');
export function alternarEfeitos() {
  const pausar = !efeitosPausados();
  raiz.classList.toggle('efeitos-pausados', pausar);
  try { localStorage.setItem(CHAVE, pausar ? 'pausados' : 'ativos'); } catch { /* só nesta página */ }
  return pausar;
}
