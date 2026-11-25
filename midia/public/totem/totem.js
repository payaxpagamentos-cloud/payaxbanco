/*
 * Totem de senha. O aparelho abre pelo link gerado na tela Senhas (…/totem/?t=CHAVE); a chave fica
 * guardada, então depois basta abrir …/totem/. Nada de login: daqui só sai "tirar uma senha".
 * Escrito para navegador antigo de totem/tablet (sem módulos).
 */
(function () {
  'use strict';
  var CHAVE = 'midia.totem.chave';
  var $ = function (id) { return document.getElementById(id); };
  var parametros = new URLSearchParams(location.search);
  var chave = parametros.get('t');
  var imprimir = parametros.get('imprimir') === '1';
  try { if (chave) localStorage.setItem(CHAVE, chave); else chave = localStorage.getItem(CHAVE); } catch (e) { /* sem armazenamento */ }
  var api = '../api/totem/' + encodeURIComponent(chave || '');
  var cpf = '';
  var preferencial = false;
  var ocioso = null;
  var enviando = false;

  var telas = ['inicio', 'cpf', 'servico', 'senha', 'erro'];
  function mostrar(qual) {
    telas.forEach(function (t) { $('tela-' + t).hidden = t !== qual; });
    clearTimeout(ocioso);
    // Cliente desistiu no meio: a tela volta ao início sozinha (e o CPF digitado some).
    if (qual === 'cpf' || qual === 'servico') ocioso = setTimeout(reiniciar, 45000);
    if (qual === 'senha') ocioso = setTimeout(reiniciar, 12000);
  }
  function reiniciar() {
    cpf = ''; preferencial = false; enviando = false;
    $('preferencial').setAttribute('aria-pressed', 'false');
    $('erro-cpf').hidden = true; $('erro-servico').hidden = true;
    pintarCpf();
    mostrar('inicio');
  }

  function pedir(metodo, caminho, corpo) {
    return fetch(api + caminho, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.erro || d.mensagem || 'Não foi possível agora. Tente de novo.'); return d; }); });
  }

  // ---- CPF
  function cpfValido(c) {
    if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
    function digito(ate) { var s = 0; for (var i = 0; i < ate; i++) s += Number(c[i]) * (ate + 1 - i); var r = (s * 10) % 11; return r === 10 ? 0 : r; }
    return digito(9) === Number(c[9]) && digito(10) === Number(c[10]);
  }
  function pintarCpf() {
    var m = '___.___.___-__'.split('');
    var pos = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13];
    for (var i = 0; i < cpf.length; i++) m[pos[i]] = cpf[i];
    $('visor').textContent = m.join('');
    $('continuar').disabled = cpf.length !== 11;
  }
  function tecla(v) {
    $('erro-cpf').hidden = true;
    if (v === 'apagar') cpf = cpf.slice(0, -1);
    else if (v === 'limpar') cpf = '';
    else if (cpf.length < 11) cpf += v;
    pintarCpf();
    mostrar('cpf');
  }
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'limpar', '0', 'apagar'].forEach(function (v) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'tecla' + (v.length > 1 ? ' acao' : '');
    b.textContent = v === 'limpar' ? 'Limpar' : v === 'apagar' ? 'Apagar' : v;
    b.addEventListener('click', function () { tecla(v); });
    $('teclado').appendChild(b);
  });
  // Totem com teclado de verdade também serve.
  document.addEventListener('keydown', function (e) {
    if ($('tela-cpf').hidden) return;
    if (/^\d$/.test(e.key)) tecla(e.key);
    else if (e.key === 'Backspace') tecla('apagar');
    else if (e.key === 'Enter' && cpf.length === 11) $('continuar').click();
  });
  $('comecar').addEventListener('click', function () { mostrar('cpf'); });
  $('tela-inicio').addEventListener('click', function () { mostrar('cpf'); });
  $('voltar-cpf').addEventListener('click', reiniciar);
  $('continuar').addEventListener('click', function () {
    if (!cpfValido(cpf)) { $('erro-cpf').textContent = 'CPF inválido. Confira os números.'; $('erro-cpf').hidden = false; return; }
    mostrar('servico');
  });

  // ---- Atendimento
  $('voltar-servico').addEventListener('click', function () { mostrar('cpf'); });
  $('preferencial').addEventListener('click', function () {
    preferencial = !preferencial;
    $('preferencial').setAttribute('aria-pressed', String(preferencial));
    mostrar('servico');
  });
  function escolher(servico) {
    if (enviando) return;
    enviando = true;
    $('erro-servico').hidden = true;
    pedir('POST', '/senha', { cpf: cpf, servico: servico, preferencial: preferencial }).then(function (s) {
      $('senha').textContent = s.codigo;
      $('qual').textContent = s.servico + (s.preferencial ? ' · Preferencial' : '');
      $('aviso').textContent = s.guiche ? 'Dirija-se ao ' + s.guiche + '.'
        : 'Aguarde: sua senha será chamada na TV.' + (s.na_frente > 0 ? ' ' + s.na_frente + (s.na_frente === 1 ? ' pessoa' : ' pessoas') + ' na sua frente.' : '');
      cpf = '';
      mostrar('senha');
      if (imprimir) setTimeout(function () { try { window.print(); } catch (e) { /* sem impressora */ } }, 300);
    }).catch(function (e) {
      $('erro-servico').textContent = e.message; $('erro-servico').hidden = false;
    }).then(function () { enviando = false; });
  }
  $('concluir').addEventListener('click', reiniciar);

  // ---- Início
  function relogio() { $('relogio').textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
  relogio(); setInterval(relogio, 15000);

  function carregar() {
    if (!chave) { $('motivo').textContent = 'Abra o totem pelo link da tela Senhas do painel.'; mostrar('erro'); return; }
    pedir('GET', '').then(function (c) {
      $('ponto').textContent = c.ponto;
      $('plataforma').textContent = c.plataforma || 'Vai Mídia';
      var caixa = $('servicos');
      caixa.textContent = '';
      caixa.className = 'servicos' + (c.servicos.length === 1 ? ' um' : '');
      c.servicos.forEach(function (nome) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'servico'; b.textContent = nome;
        b.addEventListener('click', function () { escolher(nome); });
        caixa.appendChild(b);
      });
      if (!$('tela-erro').hidden) mostrar('inicio');
    }).catch(function (e) {
      // Sem internet na hora de ligar: tenta de novo sozinho.
      if ($('servicos').children.length === 0) { $('motivo').textContent = e.message; mostrar('erro'); }
      setTimeout(carregar, 15000);
    });
  }
  mostrar('inicio');
  carregar();
  // Os atendimentos podem mudar no painel: o totem confere de tempos em tempos (quando está parado).
  setInterval(function () { if (!$('tela-inicio').hidden) carregar(); }, 300000);
})();
