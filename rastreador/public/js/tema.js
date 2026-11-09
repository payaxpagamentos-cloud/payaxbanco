/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/
// Aplica o tema salvo antes de desenhar a página (evita piscar o tema errado).
try { document.documentElement.dataset.tema = localStorage.getItem('rastreador.tema') || 'claro'; } catch { /* padrão: claro */ }
