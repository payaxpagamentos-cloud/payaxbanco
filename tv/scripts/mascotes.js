#!/usr/bin/env node
'use strict';

/**
 * Gera os mascotes da PLAY TECH VIP — as fotos de perfil do assinante.
 *
 *   node scripts/mascotes.js
 *
 * São personagens PRÓPRIOS, desenhados aqui em SVG. Nada de personagem de estúdio: além de ser
 * violação de direito autoral e de marca, Apple e Google reprovam o app na revisão por isso, e
 * é das causas mais comuns de reprovação em app de streaming.
 *
 * SVG porque fica nítido do avatar de 32px da barra até o de 150px da TV, pesa alguns KB e
 * pode ser servido direto, sem passar pela mídia do painel.
 */

const fs = require('node:fs');
const path = require('node:path');

const DESTINO = path.join(__dirname, '..', 'public', 'img', 'mascotes');

/** Cada mascote: fundo, pelo, detalhe e o que desenhar além da cabeça. */
const MASCOTES = [
  { id: 'leao', nome: 'Leão', fundo: '#F2A33C', pelo: '#F6C57A', detalhe: '#C9712A', juba: true, orelha: 'redonda' },
  { id: 'raposa', nome: 'Raposa', fundo: '#E8663C', pelo: '#F08A5D', detalhe: '#7A2E12', focinho: 'longo', orelha: 'pontuda' },
  { id: 'panda', nome: 'Panda', fundo: '#4FB3A6', pelo: '#F4F4F6', detalhe: '#2A2A30', olheira: true, orelha: 'redonda', orelhaCor: '#2A2A30' },
  { id: 'coruja', nome: 'Coruja', fundo: '#7B6CD9', pelo: '#A79BE8', detalhe: '#3C3270', oculos: true, bico: true, tufo: true },
  { id: 'gato', nome: 'Gato', fundo: '#5AA7E8', pelo: '#8FC6F2', detalhe: '#23496E', bigode: true, orelha: 'pontuda' },
  { id: 'robo', nome: 'Robô', fundo: '#8E8E96', pelo: '#D7D7DE', detalhe: '#3A3A42', antena: true, quadrado: true },
  { id: 'astronauta', nome: 'Astronauta', fundo: '#2F3A8C', pelo: '#EDEFF5', detalhe: '#1B2250', capacete: true },
  { id: 'dino', nome: 'Dino', fundo: '#52B45C', pelo: '#7FD188', detalhe: '#2C6A33', espinhos: true, focinho: 'longo' },
  { id: 'urso', nome: 'Urso', fundo: '#A9714A', pelo: '#C98F63', detalhe: '#5E3A22', orelha: 'redonda', focinho: 'curto' },
  { id: 'pinguim', nome: 'Pinguim', fundo: '#3C6E9E', pelo: '#2B2B33', detalhe: '#F6B93B', barriga: true, bico: true },
  { id: 'tigre', nome: 'Tigre', fundo: '#E8912F', pelo: '#F5B15A', detalhe: '#4A2A10', listras: true, orelha: 'redonda' },
  { id: 'alien', nome: 'Alien', fundo: '#43B07A', pelo: '#6FD9A3', detalhe: '#1E5C3C', olhoGrande: true, antena: true },
];

/** Cabeça redonda ou quadrada, com as orelhas do bicho. */
function cabeca(m) {
  const partes = [];
  const orelhaCor = m.orelhaCor ?? m.pelo;

  if (m.juba) {
    // Juba: doze pontas em volta, que é o que faz o leão ser leão à primeira vista.
    const pontas = Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * Math.PI * 2;
      return `<circle cx="${(80 + Math.cos(a) * 36).toFixed(1)}" cy="${(84 + Math.sin(a) * 36).toFixed(1)}" r="13" fill="${m.detalhe}"/>`;
    });
    partes.push(...pontas);
  }
  if (m.tufo) {
    partes.push(`<path d="M52 56 L62 34 L74 54 Z" fill="${m.pelo}"/>`, `<path d="M108 56 L98 34 L86 54 Z" fill="${m.pelo}"/>`);
  }
  if (m.espinhos) {
    partes.push(`<path d="M80 30 L88 48 L72 48 Z" fill="${m.detalhe}"/>`,
      `<path d="M58 40 L66 56 L50 54 Z" fill="${m.detalhe}"/>`, `<path d="M102 40 L94 56 L110 54 Z" fill="${m.detalhe}"/>`);
  }
  if (m.antena) {
    partes.push(`<path d="M80 44 L80 26" stroke="${m.detalhe}" stroke-width="5" stroke-linecap="round"/>`,
      `<circle cx="80" cy="22" r="8" fill="${m.detalhe}"/>`);
  }
  if (m.orelha === 'pontuda') {
    partes.push(`<path d="M44 66 L50 30 L76 50 Z" fill="${orelhaCor}"/>`, `<path d="M116 66 L110 30 L84 50 Z" fill="${orelhaCor}"/>`);
    partes.push(`<path d="M52 60 L55 42 L68 52 Z" fill="${m.detalhe}" opacity=".45"/>`,
      `<path d="M108 60 L105 42 L92 52 Z" fill="${m.detalhe}" opacity=".45"/>`);
  }
  if (m.orelha === 'redonda') {
    partes.push(`<circle cx="48" cy="52" r="16" fill="${orelhaCor}"/>`, `<circle cx="112" cy="52" r="16" fill="${orelhaCor}"/>`);
  }

  partes.push(m.quadrado
    ? `<rect x="40" y="48" width="80" height="76" rx="22" fill="${m.pelo}"/>`
    : `<ellipse cx="80" cy="86" rx="42" ry="40" fill="${m.pelo}"/>`);

  if (m.capacete) {
    partes.push(`<ellipse cx="80" cy="86" rx="46" ry="44" fill="#9FD8FF" opacity=".28"/>`,
      `<ellipse cx="80" cy="86" rx="46" ry="44" fill="none" stroke="#CDE8FF" stroke-width="4"/>`,
      `<path d="M50 70 Q62 58 78 58" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" opacity=".7"/>`);
  }
  if (m.barriga) partes.push(`<ellipse cx="80" cy="96" rx="26" ry="28" fill="#F4F4F6"/>`);
  if (m.listras) {
    partes.push(`<path d="M62 56 L68 70" stroke="${m.detalhe}" stroke-width="5" stroke-linecap="round"/>`,
      `<path d="M98 56 L92 70" stroke="${m.detalhe}" stroke-width="5" stroke-linecap="round"/>`,
      `<path d="M80 50 L80 64" stroke="${m.detalhe}" stroke-width="5" stroke-linecap="round"/>`);
  }
  if (m.olheira) {
    partes.push(`<ellipse cx="64" cy="82" rx="14" ry="16" fill="${m.detalhe}"/>`,
      `<ellipse cx="96" cy="82" rx="14" ry="16" fill="${m.detalhe}"/>`);
  }
  if (m.oculos) {
    partes.push(`<circle cx="64" cy="84" r="17" fill="#fff" opacity=".92"/>`, `<circle cx="96" cy="84" r="17" fill="#fff" opacity=".92"/>`,
      `<circle cx="64" cy="84" r="17" fill="none" stroke="${m.detalhe}" stroke-width="4"/>`,
      `<circle cx="96" cy="84" r="17" fill="none" stroke="${m.detalhe}" stroke-width="4"/>`);
  }
  return partes.join('\n    ');
}

/** Olhos, focinho e boca — é o que dá a expressão. */
function rosto(m) {
  const partes = [];
  const r = m.olhoGrande ? 13 : 7;
  const y = m.oculos || m.olheira ? 84 : 82;
  partes.push(`<circle cx="64" cy="${y}" r="${r}" fill="#1B1B22"/>`, `<circle cx="96" cy="${y}" r="${r}" fill="#1B1B22"/>`);
  partes.push(`<circle cx="${67}" cy="${y - 3}" r="${r / 3}" fill="#fff"/>`, `<circle cx="${99}" cy="${y - 3}" r="${r / 3}" fill="#fff"/>`);

  if (m.bico) {
    partes.push(`<path d="M80 92 L72 104 L88 104 Z" fill="${m.detalhe}"/>`);
  } else if (m.focinho === 'longo') {
    partes.push(`<ellipse cx="80" cy="104" rx="20" ry="14" fill="${m.detalhe}" opacity=".25"/>`,
      `<ellipse cx="80" cy="99" rx="7" ry="5" fill="#1B1B22"/>`,
      `<path d="M80 103 Q80 110 72 112" stroke="#1B1B22" stroke-width="3" fill="none" stroke-linecap="round"/>`,
      `<path d="M80 103 Q80 110 88 112" stroke="#1B1B22" stroke-width="3" fill="none" stroke-linecap="round"/>`);
  } else if (!m.quadrado && !m.capacete) {
    partes.push(`<ellipse cx="80" cy="98" rx="7" ry="5" fill="#1B1B22"/>`,
      `<path d="M72 108 Q80 114 88 108" stroke="#1B1B22" stroke-width="3.5" fill="none" stroke-linecap="round"/>`);
  } else {
    partes.push(`<path d="M70 106 Q80 114 90 106" stroke="#1B1B22" stroke-width="4" fill="none" stroke-linecap="round"/>`);
  }

  if (m.bigode) {
    for (const [x1, x2, dy] of [[46, 32, -4], [46, 32, 4], [114, 128, -4], [114, 128, 4]]) {
      partes.push(`<path d="M${x1} ${100 + dy} L${x2} ${98 + dy * 2}" stroke="${m.detalhe}" stroke-width="3" stroke-linecap="round"/>`);
    }
  }
  // Bochechas: o detalhe que faz o personagem parecer simpático em vez de sério.
  partes.push(`<ellipse cx="52" cy="98" rx="8" ry="5" fill="#FF8A8A" opacity=".35"/>`,
    `<ellipse cx="108" cy="98" rx="8" ry="5" fill="#FF8A8A" opacity=".35"/>`);
  return partes.join('\n    ');
}

// O id do gradiente leva o nome do mascote. Com id repetido, colocar vários na mesma página
// faz todos usarem o gradiente do primeiro — e sai a coleção inteira da mesma cor.
const svg = (m) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" role="img" aria-label="${m.nome}">
  <defs>
    <linearGradient id="fundo-${m.id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${m.fundo}"/>
      <stop offset="1" stop-color="${m.detalhe}"/>
    </linearGradient>
  </defs>
  <rect width="160" height="160" rx="34" fill="url(#fundo-${m.id})"/>
  <g>
    ${cabeca(m)}
    ${rosto(m)}
  </g>
</svg>
`;

fs.mkdirSync(DESTINO, { recursive: true });
for (const m of MASCOTES) fs.writeFileSync(path.join(DESTINO, `${m.id}.svg`), svg(m));

// A lista que o app usa para montar o seletor.
const lista = MASCOTES.map(({ id, nome, fundo }) => ({ id, nome, cor: fundo }));
fs.writeFileSync(path.join(DESTINO, 'mascotes.json'), `${JSON.stringify(lista, null, 2)}\n`);
console.log(`${MASCOTES.length} mascotes em ${path.relative(process.cwd(), DESTINO)}`);
