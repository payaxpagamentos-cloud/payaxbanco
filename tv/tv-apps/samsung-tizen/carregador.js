/**
 * Abre a PLAY TV no servidor configurado. Antes de sair daqui, registra as teclas de mídia
 * do controle remoto (cada fabricante exige que o app peça por elas).
 */
(function carregar() {
  var aviso = document.getElementById('aviso');
  var rodinha = document.getElementById('rodinha');
  var tentar = document.getElementById('tentar');
  var servidor = (window.PLAYTV_SERVIDOR || '').replace(/\/+$/, '');

  function falhar(texto) {
    rodinha.style.display = 'none';
    aviso.textContent = texto;
    tentar.style.display = '';
    tentar.focus();
  }

  if (!servidor || servidor.indexOf('SEU-DOMINIO') >= 0) {
    return falhar('Antes de instalar, abra o arquivo config.js do app e troque PLAYTV_SERVIDOR pelo endereço do seu servidor.');
  }

  // Samsung (Tizen): sem registrar, as teclas de mídia não chegam ao app.
  try {
    if (window.tizen && window.tizen.tvinputdevice) {
      var teclas = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaRewind', 'MediaFastForward'];
      for (var i = 0; i < teclas.length; i++) {
        try { window.tizen.tvinputdevice.registerKey(teclas[i]); } catch (e) { /* tecla não existe neste modelo */ }
      }
    }
  } catch (e) { /* segue sem as teclas de mídia */ }

  // Confere se o servidor responde antes de navegar (evita a tela branca da TV).
  var destino = servidor + '/?tv=1';
  var pronto = false;
  var requisicao = new XMLHttpRequest();
  requisicao.open('GET', servidor + '/api/saude', true);
  requisicao.timeout = 12000;
  requisicao.onload = function () {
    pronto = true;
    if (requisicao.status >= 200 && requisicao.status < 400) window.location.replace(destino);
    else falhar('O servidor respondeu ' + requisicao.status + '. Confira o endereço em config.js.');
  };
  requisicao.onerror = function () { if (!pronto) falhar('Não conseguimos falar com ' + servidor + '. Confira a internet da TV e o endereço.'); };
  requisicao.ontimeout = function () { if (!pronto) falhar('O servidor demorou para responder. Tente de novo.'); };
  requisicao.send();

  tentar.onclick = function () {
    tentar.style.display = 'none';
    rodinha.style.display = '';
    aviso.textContent = 'Conectando…';
    carregar();
  };
}());
