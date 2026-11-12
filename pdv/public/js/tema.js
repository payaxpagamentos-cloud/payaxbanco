// Aplica o tema salvo antes de desenhar a página (evita piscar o tema errado).
try { document.documentElement.dataset.tema = localStorage.getItem('pdv.tema') || 'claro'; } catch { /* padrão: claro */ }
