// Aplica o tema salvo antes de desenhar a página (evita piscar o tema errado).
try { document.documentElement.dataset.tema = localStorage.getItem('pabx.tema') || 'escuro'; } catch { /* padrão: escuro */ }
