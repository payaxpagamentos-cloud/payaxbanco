/*
 * Vai Mídia — aviso de erro na própria tela da TV.
 *
 * Escrito no JavaScript mais antigo possível, de propósito, e carregado ANTES do player: se o navegador
 * da TV for velho demais para entender o player (ou se algo quebrar no meio), em vez de tela preta
 * aparece uma linha pequena no canto dizendo o que houve. Com uma foto dessa linha dá para consertar.
 */
(function () {
  var mostrados = 0;
  function mostrar(texto) {
    try {
      if (mostrados >= 4) return;
      mostrados += 1;
      var caixa = document.getElementById('diag-erro');
      if (!caixa) {
        caixa = document.createElement('div');
        caixa.id = 'diag-erro';
        caixa.style.cssText = 'position:fixed;left:8px;top:8px;right:8px;z-index:99;font:14px/1.35 monospace;color:#fff;'
          + 'background:rgba(120,20,20,.92);padding:8px 10px;border-radius:6px;white-space:pre-wrap;word-break:break-all';
        (document.body || document.documentElement).appendChild(caixa);
      }
      caixa.textContent = (caixa.textContent ? caixa.textContent + '\n' : 'Vai Midia - erro no player (mande uma foto desta tela):\n') + texto;
    } catch (e) { /* nada a fazer */ }
  }
  window.addEventListener('error', function (ev) {
    // Erro de imagem ou de vídeo não é erro do player: esses o próprio player trata.
    if (ev && ev.target && ev.target !== window && ev.target.tagName && ev.target.tagName !== 'SCRIPT') return;
    var onde = ev && ev.filename ? ' (' + String(ev.filename).split('/').pop().split('?')[0] + ':' + ev.lineno + ')' : '';
    mostrar((ev && ev.message ? ev.message : 'arquivo do player nao carregou') + onde);
  }, true);
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    mostrar('promessa: ' + (r && (r.message || r.name) ? (r.message || r.name) : String(r)));
  });
  window.vaimidiaDiag = mostrar;
  // Informação do navegador, para a foto dizer com quem estamos falando.
  window.vaimidiaNavegador = (navigator.userAgent.match(/(Chrome|Chromium|Version|Web0S|Tizen)\/[\d.]+/g) || []).join(' ');
}());
