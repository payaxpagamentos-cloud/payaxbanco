import { raw } from './ui.js';

/**
 * Barras por período (empilhadas ou lado a lado), desenhadas em SVG com a mesma escala para marcas e eixos.
 * `series`: [{ chave, cor, rotulo }]; `pontos`: [{ rotulo, ...valores }].
 */
export function barras(pontos, series, { empilhar = false, altura = 220, titulo = '', cadaRotulo } = {}) {
  const W = 720, H = altura, M = { t: 12, r: 12, b: 28, l: 36 };
  const total = (p) => (empilhar ? series.reduce((a, s) => a + (p[s.chave] || 0), 0) : Math.max(...series.map((s) => p[s.chave] || 0)));
  const max = Math.max(1, ...pontos.map(total));
  const topo = Math.max(4, Math.ceil(max / 4) * 4);
  const larg = (W - M.l - M.r) / pontos.length;
  const y = (v) => M.t + (H - M.t - M.b) * (1 - v / topo);
  const passo = cadaRotulo ?? Math.ceil(pontos.length / 12);
  const grade = [0, 0.25, 0.5, 0.75, 1].map((f) => `<line class="grade" x1="${M.l}" x2="${W - M.r}" y1="${y(topo * f)}" y2="${y(topo * f)}"/>
    <text x="${M.l - 8}" y="${y(topo * f) + 4}" text-anchor="end">${topo * f}</text>`).join('');
  const marcas = pontos.map((p, i) => {
    const x = M.l + i * larg;
    const dica = `${p.rotulo}: ${series.map((s) => `${s.rotulo} ${p[s.chave] || 0}`).join(' · ')}`;
    let corpo = '';
    if (empilhar) {
      const b = Math.max(2, larg - 6);
      let acumulado = 0;
      for (const s of series) {
        const v = p[s.chave] || 0;
        if (v) corpo += `<rect x="${x + (larg - b) / 2}" y="${y(acumulado + v)}" width="${b}" height="${y(acumulado) - y(acumulado + v)}" fill="${s.cor}"/>`;
        acumulado += v;
      }
    } else {
      const b = Math.max(1.5, (larg - 4) / series.length - 1);
      series.forEach((s, k) => {
        const v = p[s.chave] || 0;
        corpo += `<rect x="${x + 2 + k * (b + 1)}" y="${y(v)}" width="${b}" height="${y(0) - y(v)}" rx="2" fill="${s.cor}"/>`;
      });
    }
    return `<g><title>${dica}</title>${corpo}${i % passo === 0 ? `<text x="${x + larg / 2}" y="${H - 8}" text-anchor="middle">${p.rotulo}</text>` : ''}</g>`;
  }).join('');
  return raw(`<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${titulo}">${grade}${marcas}</svg>`);
}
