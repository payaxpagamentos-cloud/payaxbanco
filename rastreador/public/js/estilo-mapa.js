/**
 * Visual moderno para o mapa de ruas, aplicado sobre o estilo padrão (OpenFreeMap "Liberty"), no jeito dos aplicativos de navegação:
 * fundo claro, ruas brancas com contorno fino, avenidas e rodovias em amarelo, parques verdes, água azul, prédios planos e
 * nomes em cinza-escuro com contorno branco. Só vale para o estilo padrão; um estilo próprio no .env é usado como vier.
 */
const C = {
  fundo: '#F1F3F4',
  residencial: '#ECEEF0',
  parque: '#CEEAD6',
  mata: '#C3E3C9',
  hospital: '#FCE8E6',
  escola: '#F3F1E7',
  agua: '#A9D5F7',
  predio: '#E1E4E8',
  predioContorno: '#D0D5DB',
  rua: '#FFFFFF',
  ruaContorno: '#DADDE1',
  avenida: '#FFFFFF',
  avenidaContorno: '#CFD3D9',
  principal: '#FFE7A0',
  principalContorno: '#E9C770',
  rodovia: '#FBD372',
  rodoviaContorno: '#E0AE45',
  trilho: '#C5C9CF',
  texto: '#3C4043',
  textoSuave: '#5F6368',
  contornoTexto: '#FFFFFF',
};

/** Cor de cada camada pela identificação dela no estilo (a ordem importa: o mais específico primeiro). */
const REGRAS = [
  [/motorway.*casing/, 'line-color', C.rodoviaContorno],
  [/motorway/, 'line-color', C.rodovia],
  [/(trunk_primary|_link).*casing/, 'line-color', C.principalContorno],
  [/(trunk_primary|_link)$/, 'line-color', C.principal],
  [/secondary_tertiary.*casing/, 'line-color', C.avenidaContorno],
  [/secondary_tertiary$/, 'line-color', C.avenida],
  [/(minor|street|service_track).*casing/, 'line-color', C.ruaContorno],
  [/(minor|street|service_track)$/, 'line-color', C.rua],
  [/(major|transit)_rail/, 'line-color', C.trilho],
  [/^waterway/, 'line-color', C.agua],
];

export function modernizar(estilo) {
  const s = structuredClone(estilo);
  // Prédios planos (o 3D cinza deixa o mapa pesado e esconde as ruas).
  s.layers = s.layers.filter((l) => l.type !== 'fill-extrusion' && l.id !== 'park_outline');
  for (const l of s.layers) {
    l.paint ??= {};
    const p = l.paint;
    if (l.type === 'background') p['background-color'] = C.fundo;
    if (l.id === 'water') p['fill-color'] = C.agua;
    if (l.id === 'park') Object.assign(p, { 'fill-color': C.parque, 'fill-opacity': 0.95, 'fill-outline-color': C.parque });
    if (/landcover_(wood|grass)/.test(l.id)) Object.assign(p, { 'fill-color': C.mata, 'fill-opacity': 0.6 });
    if (/landuse_(pitch|track|cemetery)/.test(l.id)) p['fill-color'] = C.parque;
    if (l.id === 'landuse_residential') Object.assign(p, { 'fill-color': C.residencial, 'fill-opacity': 0.6 });
    if (l.id === 'landuse_hospital') p['fill-color'] = C.hospital;
    if (l.id === 'landuse_school') p['fill-color'] = C.escola;
    if (l.id === 'building') Object.assign(p, { 'fill-color': C.predio, 'fill-outline-color': C.predioContorno });
    if (l.type === 'line') {
      const r = REGRAS.find(([re]) => re.test(l.id));
      if (r) p[r[1]] = r[2];
    }
    if (l.type === 'symbol' && l.layout?.['text-field']) {
      const nomeRua = l.id.startsWith('highway-name');
      Object.assign(p, {
        'text-color': /water/.test(l.id) ? '#3E6FA8' : nomeRua || /^poi/.test(l.id) ? C.textoSuave : C.texto,
        'text-halo-color': C.contornoTexto, 'text-halo-width': 1.6, 'text-halo-blur': 0.2,
      });
    }
  }
  return s;
}

/**
 * Satélite híbrido, como o dos aplicativos de mapa: a foto aérea embaixo e, por cima, as rodovias e avenidas em destaque suave,
 * os nomes de bairros, ruas e lugares (com os ícones) em branco com contorno escuro.
 */
export function hibrido(estilo, satelite) {
  const s = structuredClone(estilo);
  s.sources = { ...s.sources, satelite: { type: 'raster', tiles: [satelite.tiles], tileSize: 256, maxzoom: 19 } };
  const vias = s.layers.filter((l) => l.type === 'line' && /^road_(motorway|trunk_primary|secondary_tertiary|link)$|^bridge_(motorway|trunk_primary)$/.test(l.id))
    .map((l) => ({ ...l, paint: { ...l.paint, 'line-color': /secondary_tertiary/.test(l.id) ? '#FFFFFF' : '#F6D27A', 'line-opacity': /secondary_tertiary/.test(l.id) ? 0.3 : 0.5 } }));
  // Nomes de bairros e cidades maiores, como no satélite dos aplicativos de mapa.
  const tamanhoLugar = { label_other: [11, 12, 16, 17], label_village: [10, 12, 16, 18], label_town: [8, 13, 14, 20], label_city: [8, 14, 14, 22] };
  const nomes = s.layers.filter((l) => l.type === 'symbol').map((l) => {
    const t = tamanhoLugar[l.id];
    return {
      ...l,
      layout: t ? { ...l.layout, 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], t[0], t[1], t[2], t[3]], 'text-letter-spacing': 0.08 }
        : l.layout,
      paint: { ...l.paint, 'text-color': /^highway-name/.test(l.id) ? '#F1F3F4' : '#FFFFFF', 'text-halo-color': 'rgba(0,0,0,0.8)', 'text-halo-width': 1.7, 'text-halo-blur': 0.3 },
    };
  });
  s.layers = [{ id: 'satelite', type: 'raster', source: 'satelite', paint: { 'raster-fade-duration': 150 } }, ...vias, ...nomes];
  return s;
}
