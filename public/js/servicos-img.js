import { raw } from './ui.js';

/*
 * Imagem de cada serviço monitorado (menu Segurança): ilustração em SVG sobre um fundo colorido.
 * O ponto no canto mostra a situação (no ar, degradado, fora do ar).
 */

const CORES = {
  banqueiro: ['#1d4ed8', '#3b82f6'],
  internet_banking: ['#0369a1', '#0ea5e9'],
  site: ['#4338ca', '#818cf8'],
  api: ['#0f172a', '#334155'],
  banco_dados: ['#047857', '#10b981'],
  bradesco: ['#b91c1c', '#ef4444'],
  antifraude: ['#7c2d12', '#f97316'],
  backup: ['#6d28d9', '#a78bfa'],
};

const DESENHOS = {
  // Monitor com menu lateral e gráfico (sistema da equipe).
  banqueiro: `<rect x="12" y="15" width="40" height="27" rx="3"/><path d="M26 49h12M32 42v7"/><path d="M19 15v27" opacity=".55"/>
    <path d="M24 35l6-6 5 4 9-9" /><circle cx="44" cy="24" r="1.6" fill="#fff"/>`,
  // Celular com saldo e PIX.
  internet_banking: `<rect x="21" y="10" width="22" height="44" rx="4"/><path d="M29 14h6"/><path d="M27 24h10" opacity=".6"/>
    <path d="M32 31l5 5-5 5-5-5z"/><circle cx="32" cy="49" r="1.4" fill="#fff"/>`,
  // Janela do navegador com o globo.
  site: `<rect x="10" y="14" width="44" height="36" rx="4"/><path d="M10 22h44"/><circle cx="15" cy="18" r="1" fill="#fff"/><circle cx="19" cy="18" r="1" fill="#fff"/>
    <circle cx="32" cy="36" r="9"/><path d="M23 36h18M32 27c-4 5-4 13 0 18M32 27c4 5 4 13 0 18"/>`,
  // Rack de servidores.
  api: `<rect x="14" y="12" width="36" height="11" rx="2.5"/><rect x="14" y="26.5" width="36" height="11" rx="2.5"/><rect x="14" y="41" width="36" height="11" rx="2.5"/>
    <circle cx="20" cy="17.5" r="1.4" fill="#4ade80" stroke="none"/><circle cx="20" cy="32" r="1.4" fill="#4ade80" stroke="none"/><circle cx="20" cy="46.5" r="1.4" fill="#4ade80" stroke="none"/>
    <path d="M30 17.5h14M30 32h14M30 46.5h14" opacity=".6"/>`,
  // Cilindro de banco de dados.
  banco_dados: `<ellipse cx="32" cy="17" rx="15" ry="5.5"/><path d="M17 17v30c0 3 6.7 5.5 15 5.5s15-2.5 15-5.5V17"/>
    <path d="M17 27c0 3 6.7 5.5 15 5.5s15-2.5 15-5.5M17 37c0 3 6.7 5.5 15 5.5s15-2.5 15-5.5" opacity=".7"/>`,
  // Prédio de banco com colunas.
  bradesco: `<path d="M12 25L32 13l20 12z"/><path d="M14 25h36M14 49h36M11 53h42"/><path d="M19 29v16M27 29v16M37 29v16M45 29v16"/>`,
  // Escudo com radar.
  antifraude: `<path d="M32 10l17 6v13c0 11-7.5 19-17 23-9.5-4-17-12-17-23V16z"/><circle cx="32" cy="31" r="7" opacity=".7"/><circle cx="32" cy="31" r="1.8" fill="#fff"/>
    <path d="M32 31l7-7"/>`,
  // Nuvem com cópia de segurança.
  backup: `<path d="M20 44h25a9 9 0 0 0 1-17.9A12 12 0 0 0 23 25a9.5 9.5 0 0 0-3 19z"/><path d="M32 29v12M27 34l5-5 5 5"/>`,
};

/** Imagem do serviço. `status`: ok | degradado | fora | null. */
export function imagemServico(chave, status, tamanho = 56) {
  const [c1, c2] = CORES[chave] ?? ['#334155', '#64748b'];
  const id = `g-${chave}-${tamanho}`;
  const ponto = { ok: '#22c55e', degradado: '#f59e0b', fora: '#ef4444' }[status] ?? '#94a3b8';
  return raw(`<span class="serv-img serv-${status ?? 'nd'}" style="width:${tamanho}px;height:${tamanho}px">
    <svg viewBox="0 0 64 64" width="${tamanho}" height="${tamanho}" aria-hidden="true">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
      <rect width="64" height="64" rx="16" fill="url(#${id})"/>
      <g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${DESENHOS[chave] ?? ''}</g>
    </svg><span class="serv-ponto" style="background:${ponto}"></span></span>`);
}
