import { el } from './ui.js';

/** Abas de Tráfego da rede (Visão geral, Consumo, Conteúdo): cada uma é uma rota, também presente no menu lateral. */
export function navTrafego(atual) {
  return el('nav', { class: 'abas', 'aria-label': 'Tráfego da rede' }, [['trafego', 'Visão geral'], ['consumo', 'Consumo'], ['conteudo', 'Conteúdo']]
    .map(([r, t]) => el('a', { href: `#/${r}`, class: 'aba-link', 'aria-current': r === atual ? 'page' : null }, t)));
}
