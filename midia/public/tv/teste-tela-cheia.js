// Diagnóstico de tela cheia (ver teste-tela-cheia.html). Fica fora da página porque a política de
// segurança do sistema só deixa rodar script de arquivo do próprio servidor.
var registro = document.getElementById('registro');
var linhas = [];
function anotar(t) {
  var h = new Date();
  linhas.unshift(('0' + h.getMinutes()).slice(-2) + ':' + ('0' + h.getSeconds()).slice(-2) + '  ' + t);
  linhas = linhas.slice(0, 26);
  registro.textContent = linhas.join('\n');
}
function estado() {
  var cheia = document.fullscreenElement || document.webkitFullscreenElement || document.webkitCurrentFullScreenElement;
  document.getElementById('estado').textContent = (cheia ? 'EM TELA CHEIA' : 'fora da tela cheia')
    + ' · permitido: ' + (document.fullscreenEnabled === undefined ? (document.webkitFullscreenEnabled === undefined ? '?' : document.webkitFullscreenEnabled) : document.fullscreenEnabled)
    + ' · janela ' + innerWidth + 'x' + innerHeight + ' · tela ' + screen.width + 'x' + screen.height;
}
function resultado(nome, r) {
  if (r && typeof r.then === 'function') {
    anotar(nome + ': pedido enviado (aguardando)');
    r.then(function () { anotar(nome + ': ACEITO'); estado(); }, function (e) { anotar(nome + ': RECUSADO — ' + (e && (e.message || e.name) || e)); estado(); });
  } else {
    anotar(nome + ': pedido enviado (sem resposta)');
    setTimeout(estado, 800);
  }
}
function tentar(nome, fn) {
  try { resultado(nome, fn()); } catch (e) { anotar(nome + ': ERRO — ' + (e && e.message || e)); }
}
var raiz = document.documentElement;
document.getElementById('b1').onclick = function () {
  tentar('1', function () { return raiz.requestFullscreen ? raiz.requestFullscreen() : (anotar('1: navegador sem requestFullscreen'), undefined); });
};
document.getElementById('b2').onclick = function () {
  tentar('2', function () { return raiz.requestFullscreen ? raiz.requestFullscreen({ navigationUI: 'hide' }) : (anotar('2: navegador sem requestFullscreen'), undefined); });
};
document.getElementById('b3').onclick = function () {
  tentar('3', function () {
    if (raiz.webkitRequestFullscreen) return raiz.webkitRequestFullscreen();
    if (raiz.webkitRequestFullScreen) return raiz.webkitRequestFullScreen();
    anotar('3: navegador sem webkitRequestFullscreen');
  });
};
document.getElementById('b4').onclick = function () {
  var c = document.body;
  tentar('4', function () { return c.requestFullscreen ? c.requestFullscreen() : (c.webkitRequestFullscreen ? c.webkitRequestFullscreen() : undefined); });
};
document.getElementById('b5').onclick = function () {
  var v = document.getElementById('video');
  tentar('5', function () {
    if (v.requestFullscreen) return v.requestFullscreen();
    if (v.webkitEnterFullscreen) return v.webkitEnterFullscreen();
    if (v.webkitRequestFullscreen) return v.webkitRequestFullscreen();
    anotar('5: sem tela cheia de vídeo');
  });
};
document.addEventListener('dblclick', function (e) {
  if (e.target.tagName === 'BUTTON') return;
  tentar('dois cliques', function () { return raiz.requestFullscreen ? raiz.requestFullscreen() : (raiz.webkitRequestFullscreen && raiz.webkitRequestFullscreen()); });
});
['pointerdown', 'mousedown', 'click', 'dblclick', 'touchend', 'keydown'].forEach(function (ev) {
  document.addEventListener(ev, function (e) {
    anotar('recebido: ' + ev + (e.key ? ' tecla=' + e.key : '') + (e.target && e.target.id ? ' em ' + e.target.id : ''));
  }, true);
});
['fullscreenchange', 'webkitfullscreenchange'].forEach(function (ev) {
  document.addEventListener(ev, function () { anotar('mudou: ' + ev); estado(); });
});
['fullscreenerror', 'webkitfullscreenerror'].forEach(function (ev) {
  document.addEventListener(ev, function () { anotar('ERRO do navegador: ' + ev); });
});
anotar('navegador: ' + navigator.userAgent);
estado();
document.getElementById('b1').focus();
