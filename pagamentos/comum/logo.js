/*
 * Envio do logo que aparece na ficha do boleto. A imagem é reduzida no próprio navegador (até 600 × 200 px)
 * e vai como PNG — ou JPEG, se o PNG passar do limite —, para caber no limite do servidor (200 KB).
 */
import { el, acao, toast } from './ui.js';

const LIMITE = 200 * 1024;

function lerArquivo(arquivo) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    r.readAsDataURL(arquivo);
  });
}

function carregar(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('A imagem não abriu. Use PNG ou JPEG.'));
    img.src = src;
  });
}

/** Reduz a imagem e devolve um data URI PNG (ou JPEG, se o PNG ficar grande demais). */
async function preparar(arquivo) {
  if (!/^image\/(png|jpeg)$/.test(arquivo.type)) throw new Error('Envie o logo em PNG ou JPEG.');
  const img = await carregar(await lerArquivo(arquivo));
  const escala = Math.min(1, 600 / img.naturalWidth, 200 / img.naturalHeight);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * escala));
  c.height = Math.max(1, Math.round(img.naturalHeight * escala));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const tamanho = (uri) => Math.ceil((uri.length - uri.indexOf(',') - 1) * 0.75);
  let uri = c.toDataURL('image/png');
  if (tamanho(uri) > LIMITE) {
    // JPEG não tem transparência: pinta o fundo de branco antes.
    const j = document.createElement('canvas');
    j.width = c.width; j.height = c.height;
    const g = j.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, j.width, j.height); g.drawImage(c, 0, 0);
    uri = j.toDataURL('image/jpeg', 0.85);
  }
  if (tamanho(uri) > LIMITE) throw new Error('O logo ficou grande demais. Envie uma imagem mais simples.');
  return uri;
}

/**
 * Bloco "Logo no boleto": prévia, enviar e remover.
 * @param {{ atual: string|null, editavel: boolean, salvar: (imagem: string|null) => Promise<void> }} o
 */
export function blocoLogo({ atual, editavel, salvar }) {
  const previa = atual
    ? el('img', { src: atual, alt: 'Logo atual', style: 'max-height:64px;max-width:240px;object-fit:contain;display:block' })
    : el('span', { style: 'color:var(--texto-3);font-size:13px' }, 'Sem logo: o boleto mostra só o nome da empresa.');
  const entrada = el('input', { type: 'file', accept: 'image/png,image/jpeg', hidden: true });
  const enviar = el('button', { class: 'botao sec', type: 'button', onclick: () => entrada.click() }, atual ? 'Trocar logo' : 'Enviar logo');
  entrada.addEventListener('change', () => {
    const arquivo = entrada.files?.[0];
    entrada.value = '';
    if (arquivo) acao(enviar, async () => { await salvar(await preparar(arquivo)); toast('Logo salvo: já aparece nos boletos.', 'ok'); });
  });
  const remover = atual && editavel
    ? el('button', { class: 'botao sec', type: 'button', onclick: (e) => acao(e.currentTarget, async () => { await salvar(null); toast('Logo removido.', 'ok'); }) }, 'Remover')
    : null;
  return el('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap' },
    el('div', { style: 'display:grid;gap:6px' }, previa,
      el('small', { style: 'color:var(--texto-3)' }, 'Aparece no topo do boleto, ao lado de "Cobrança de". PNG ou JPEG; reduzido automaticamente.')),
    editavel ? el('div', { style: 'display:flex;gap:8px' }, enviar, remover, entrada) : null);
}
