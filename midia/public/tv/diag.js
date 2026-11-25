/*
 * Vai Mídia — aviso de erro na própria tela da TV.
 *
 * Escrito no JavaScript mais antigo possível, de propósito, e carregado ANTES do player: se o navegador
 * da TV for velho demais para entender o player (ou se algo quebrar no meio), em vez de tela preta
 * aparece uma linha pequena no canto dizendo o que houve. Com uma foto dessa linha dá para consertar.
 */
(function () {
  var mostrados = 0;
  var sumir = null;
  function mostrar(texto) {
    try {
      if (mostrados >= 4) return;
      // Com o player rodando, o aviso fica só meio minuto: tempo de fotografar, sem ficar na tela do cliente.
      clearTimeout(sumir);
      sumir = setTimeout(function () {
        var c = document.getElementById('diag-erro');
        if (c && window.vaimidiaVivo && c.parentNode) { c.parentNode.removeChild(c); mostrados = 0; }
      }, 30000);
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
    // "Script error." sem arquivo é erro de fora da nossa página (o próprio navegador da TV, uma extensão):
    // não diz nada e não é do player. Com o player rodando, não vai para a tela do cliente.
    if (ev && !ev.filename && /^Script error\.?$/i.test(String(ev.message || '')) ) return;
    var onde = ev && ev.filename ? ' (' + String(ev.filename).split('/').pop().split('?')[0] + ':' + ev.lineno + ')' : '';
    mostrar((ev && ev.message ? ev.message : 'arquivo do player nao carregou') + onde);
  }, true);
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    mostrar('promessa: ' + (r && (r.message || r.name) ? (r.message || r.name) : String(r)));
  });
  window.vaimidiaDiag = mostrar;

  /*
   * Vigia. O player avisa que está vivo (window.vaimidiaVivo) assim que começa a rodar. Se em 15 segundos
   * ele não avisou, a TV ficaria preta — então esta página, sozinha, sem ninguém digitar nada:
   *   1. escreve na tela o que sabe sobre o navegador e o que está guardado (para uma foto);
   *   2. apaga o que o navegador guardou (páginas antigas, programação, ordem de giro) e abre de novo.
   * A limpeza só acontece uma vez a cada 10 minutos, para não ficar em círculo; o pareamento é mantido.
   */
  function simNao(v) { return v ? 'sim' : 'NAO'; }
  function relatorio() {
    var l = [];
    try {
      l.push('Navegador: ' + navigator.userAgent);
      l.push('Tela: ' + screen.width + 'x' + screen.height + ' janela ' + window.innerWidth + 'x' + window.innerHeight);
      var sup = (window.CSS && CSS.supports) ? function (a, b) { return simNao(CSS.supports(a, b)); } : function () { return '?'; };
      l.push('CSS: inset ' + sup('inset', '0') + ' | min() ' + sup('width', 'min(1vh, 1vw)') + ' | calc(var) ' + sup('width', 'calc(var(--x) * 2)') + ' | object-fit ' + sup('object-fit', 'cover'));
      l.push('JS: fetch ' + simNao(typeof fetch === 'function') + ' | AbortController ' + simNao(typeof AbortController === 'function')
        + ' | replaceChildren ' + simNao(!!Element.prototype.replaceChildren) + ' | service worker ' + simNao('serviceWorker' in navigator)
        + (navigator.serviceWorker && navigator.serviceWorker.controller ? ' (controlando)' : ''));
      var grade = null;
      try { grade = JSON.parse(localStorage.getItem('midia.tv.grade')); } catch (e) { grade = null; }
      l.push('Guardado: pareada ' + simNao(!!localStorage.getItem('midia.tv.token')) + ' | programacao ' + simNao(!!grade)
        + ' | giro ' + (grade && grade.tela ? grade.tela.giro : '-') + ' | giro.tentando ' + simNao(!!localStorage.getItem('midia.tv.giro.tentando'))
        + ' | giro.falhou ' + simNao(!!localStorage.getItem('midia.tv.giro.falhou')));
      l.push('Player: arquivo ' + simNao(!!window.vaimidiaCarregou) + ' | rodando ' + simNao(!!window.vaimidiaVivo));
    } catch (e) { l.push('relatorio: ' + (e && e.message)); }
    return l.join('\n');
  }
  function limpar(depois) {
    var passos = [];
    try {
      var chaves = ['midia.tv.grade', 'midia.tv.vistos', 'midia.tv.giro.tentando', 'midia.tv.giro.falhou', 'midia.tv.codigo'];
      for (var i = 0; i < chaves.length; i++) localStorage.removeItem(chaves[i]);
    } catch (e) { /* segue */ }
    try {
      if ('serviceWorker' in navigator && navigator.serviceWorker.getRegistrations) {
        passos.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
          var u = []; for (var i = 0; i < regs.length; i++) u.push(regs[i].unregister()); return Promise.all(u);
        }).then(null, function () {}));
      }
      if (window.caches && caches.keys) {
        passos.push(caches.keys().then(function (nomes) {
          var u = []; for (var i = 0; i < nomes.length; i++) u.push(caches.delete(nomes[i])); return Promise.all(u);
        }).then(null, function () {}));
      }
    } catch (e) { /* segue */ }
    if (window.Promise && passos.length) Promise.all(passos).then(depois, depois); else depois();
  }
  setTimeout(function () {
    if (window.vaimidiaVivo) return;
    mostrados = 0;
    var ultima = 0;
    try { ultima = Number(localStorage.getItem('midia.tv.autolimpeza')) || 0; } catch (e) { ultima = 0; }
    var jaLimpou = ultima && (new Date().getTime() - ultima) < 600000;
    mostrar('O PLAYER NAO INICIOU NESTA TV.\n' + relatorio() + '\n'
      + (jaLimpou ? 'A limpeza automatica ja foi feita e nao resolveu. Mande uma foto desta tela para o suporte.'
        : 'Limpando o que esta guardado e abrindo de novo em 12 segundos...'));
    if (jaLimpou) return;
    try { localStorage.setItem('midia.tv.autolimpeza', String(new Date().getTime())); } catch (e) { /* segue */ }
    setTimeout(function () { limpar(function () { location.replace(location.pathname + '?limpo=' + new Date().getTime()); }); }, 12000);
  }, 15000);
  // Informação do navegador, para a foto dizer com quem estamos falando.
  window.vaimidiaNavegador = (navigator.userAgent.match(/(Chrome|Chromium|Version|Web0S|Tizen)\/[\d.]+/g) || []).join(' ');
}());
