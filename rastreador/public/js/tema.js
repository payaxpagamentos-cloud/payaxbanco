// Aplica o tema salvo antes de desenhar a página (evita piscar o tema errado).
try { document.documentElement.dataset.tema = localStorage.getItem('rastreador.tema') || 'claro'; } catch { /* padrão: claro */ }
