/* Diagnóstico da TV (Vai Mídia). JavaScript antigo de propósito: tem de rodar em qualquer navegador. */
(function () {
  var saida = document.getElementById('saida');
  var linhas = [];
  function p(rotulo, valor) { linhas.push(rotulo + ': ' + valor); saida.textContent = linhas.join('\n'); }
  function tenta(fn) { try { return fn(); } catch (e) { return 'ERRO ' + (e && e.message); } }
  function simNao(v) { return v ? 'sim' : 'NAO'; }

  p('Navegador', navigator.userAgent);
  p('Tela', screen.width + 'x' + screen.height + ' | janela ' + window.innerWidth + 'x' + window.innerHeight);
  p('Endereco', location.href);

  // O que o player usa e nem todo navegador tem.
  // Cada arquivinho usa um pedaço da linguagem que o player usa. Se o navegador não entende, o arquivo nem roda.
  function testaArquivo(rotulo, arquivo, chave) {
    var s = document.createElement('script');
    s.src = arquivo + '?t=' + Date.now();
    s.onload = function () { p(rotulo, window[chave] === true ? 'sim' : 'NAO (o navegador nao entende)'); };
    s.onerror = function () { p(rotulo, 'arquivo nao carregou'); };
    document.body.appendChild(s);
  }
  testaArquivo('JS: ?. e ??', 'diag-t1.js', 'vmT1');
  testaArquivo('JS: numero 20_000', 'diag-t2.js', 'vmT2');
  testaArquivo('JS: async, ...resto, catch sem nome', 'diag-t3.js', 'vmT3');
  p('AbortController', simNao(typeof AbortController === 'function'));
  p('replaceChildren', simNao(!!Element.prototype.replaceChildren));
  p('fetch', simNao(typeof fetch === 'function'));
  var sup = (window.CSS && CSS.supports) ? function (a, b) { return simNao(CSS.supports(a, b)); } : function () { return '?'; };
  p('CSS inset', sup('inset', '0'));
  p('CSS min()', sup('width', 'min(1vh, 1vw)'));
  p('CSS calc(var)', sup('width', 'calc(var(--x) * 2)'));
  p('CSS object-fit', sup('object-fit', 'cover'));
  p('CSS transform', sup('transform', 'rotate(90deg)'));

  // O que está guardado nesta TV.
  p('Guardado', tenta(function () {
    var partes = [];
    var grade = null;
    try { grade = JSON.parse(localStorage.getItem('midia.tv.grade')); } catch (e) { grade = 'ilegivel'; }
    partes.push('pareada=' + simNao(!!localStorage.getItem('midia.tv.token')));
    partes.push('programacao=' + (grade && grade.grade ? (grade.grade.itens ? grade.grade.itens.length : 0) + ' itens' : (grade ? String(grade).slice(0, 20) : 'nenhuma')));
    partes.push('giro=' + (grade && grade.tela ? grade.tela.giro : '-'));
    partes.push('giro.tentando=' + simNao(!!localStorage.getItem('midia.tv.giro.tentando')));
    partes.push('giro.falhou=' + simNao(!!localStorage.getItem('midia.tv.giro.falhou')));
    return partes.join(' | ');
  }));

  p('Service worker', tenta(function () {
    if (!('serviceWorker' in navigator)) return 'nao existe neste navegador';
    navigator.serviceWorker.getRegistrations().then(function (regs) {
      p('  registros', regs.length + (regs.length ? ' (' + regs.map(function (r) { return r.scope; }).join(', ') + ')' : ''));
    }, function (e) { p('  registros', 'ERRO ' + e.message); });
    return navigator.serviceWorker.controller ? 'controlando esta pagina' : 'sem controle';
  }));
  if (window.caches && caches.keys) {
    caches.keys().then(function (nomes) { p('Caches', nomes.join(', ') || 'nenhum'); }, function (e) { p('Caches', 'ERRO ' + e.message); });
  } else { p('Caches', 'nao existe neste navegador'); }

  // Conversa com o servidor e com os arquivos do player.
  function baixa(rotulo, url) {
    if (typeof fetch !== 'function') { p(rotulo, 'sem fetch'); return; }
    var t0 = Date.now();
    fetch(url, { cache: 'no-store' }).then(function (r) {
      return r.text().then(function (texto) { p(rotulo, 'HTTP ' + r.status + ' | ' + texto.length + ' letras | ' + (Date.now() - t0) + ' ms'); return texto; });
    }, function (e) { p(rotulo, 'FALHOU: ' + e.message); });
  }
  baixa('Servidor (saude)', '../api/saude');
  baixa('Pagina do player', './?diag=' + Date.now());
  baixa('player.js', 'player.js?diag=' + Date.now());
  baixa('tv.css', 'tv.css?diag=' + Date.now());

  window.addEventListener('error', function (ev) {
    if (ev && ev.target && ev.target.tagName === 'SCRIPT') return; // os testes de arquivo já avisam
    p('ERRO na pagina', (ev.message || 'erro') + (ev.filename ? ' em ' + String(ev.filename).split('/').pop().split('?')[0] + ':' + ev.lineno : ''));
  }, true);

  function limparTudo(depois) {
    var passos = [];
    try {
      ['midia.tv.grade', 'midia.tv.vistos', 'midia.tv.giro.tentando', 'midia.tv.giro.falhou', 'midia.tv.codigo'].forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) { /* segue */ }
    if ('serviceWorker' in navigator) {
      passos.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
        return Promise.all(regs.map(function (r) { return r.unregister(); }));
      }).catch(function () {}));
    }
    if (window.caches && caches.keys) {
      passos.push(caches.keys().then(function (nomes) { return Promise.all(nomes.map(function (n) { return caches.delete(n); })); }).catch(function () {}));
    }
    Promise.all(passos).then(depois, depois);
  }
  document.getElementById('limpar').onclick = function () {
    p('Limpando', 'aguarde...');
    limparTudo(function () { location.href = './?limpo=' + Date.now(); });
  };
  document.getElementById('abrir').onclick = function () { location.href = './?abrir=' + Date.now(); };
  setTimeout(function () { try { document.getElementById('limpar').focus(); } catch (e) { /* sem foco */ } }, 300);
}());
