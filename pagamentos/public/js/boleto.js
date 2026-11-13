/* Botão "Copiar código PIX" da ficha de compensação (fora do HTML por causa da CSP). */
document.getElementById('copiar')?.addEventListener('click', async (e) => {
  const emv = document.getElementById('emv')?.textContent?.trim();
  if (!emv) return;
  try {
    await navigator.clipboard.writeText(emv);
    e.target.textContent = 'Código copiado!';
  } catch {
    const s = document.getSelection();
    const r = document.createRange();
    r.selectNodeContents(document.getElementById('emv'));
    s.removeAllRanges();
    s.addRange(r);
    e.target.textContent = 'Selecione e copie';
  }
  setTimeout(() => { e.target.textContent = 'Copiar código PIX'; }, 2500);
});
