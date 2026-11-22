(function () {
  'use strict';
  const config = window.VAI_CONFIG || {};

  /*
   * Ligação com o sistema da VAI MÍDIA (pasta midia/ deste repositório).
   * Quando o próprio servidor publica o site, o endereço da API vem pronto em <body data-api>.
   * Hospedado fora, o site tenta os caminhos prováveis uma vez só e, se não achar, segue
   * funcionando como pacote estático: briefing para baixar, copiar e mandar no WhatsApp.
   */
  const candidatosApi = [document.body.dataset.api, '../api/', '/midia/api/', '/api/']
    .filter(Boolean).map(x => new URL(x, location.href).href);
  let apiPromessa = null;
  function api() {
    apiPromessa = apiPromessa || (async () => {
      for (const base of candidatosApi) {
        try { if ((await fetch(new URL('publico', base))).ok) return base; } catch { /* tenta o próximo */ }
      }
      return null;
    })();
    return apiPromessa;
  }
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  let resizeFrame = 0;

  // Apenas enquadramento no navegador: o arquivo visual aprovado não é alterado.
  function framePhoto(frame) {
    const image = $('img', frame);
    const crop = (frame.dataset.crop || '').split(',').map(Number);
    if (!image || crop.length !== 4 || crop.some(n => !Number.isFinite(n))) return;
    const [x, y, width, height] = crop;
    if (width <= 0 || height <= 0) return;
    // Cada foto tem o tamanho dela (os atributos width/height do <img>), e o recorte é em cima dele.
    const sourceWidth = Number(image.getAttribute('width')) || image.naturalWidth;
    const sourceHeight = Number(image.getAttribute('height')) || image.naturalHeight;
    if (!sourceWidth || !sourceHeight) return;
    const box = frame.getBoundingClientRect();
    const scale = Math.max(box.width / width, box.height / height);
    image.style.width = (sourceWidth * scale) + 'px';
    image.style.height = (sourceHeight * scale) + 'px';
    image.style.left = ((box.width - width * scale) / 2 - x * scale) + 'px';
    image.style.top = ((box.height - height * scale) / 2 - y * scale) + 'px';
  }
  function frameAll() { $$('.photo-window').forEach(framePhoto); }
  frameAll();
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(entries => entries.forEach(entry => framePhoto(entry.target)));
    $$('.photo-window').forEach(frame => observer.observe(frame));
  } else {
    window.addEventListener('resize', () => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(frameAll); });
  }
  window.addEventListener('load', frameAll, { once: true });

  /*
   * A rede em números. Vem da API do painel, então o site nunca mostra um número desatualizado;
   * com a rede ainda vazia (ou sem API por perto), a faixa simplesmente não aparece.
   */
  (async () => {
    const base = await api();
    if (!base) return;
    try {
      const dados = await fetch(new URL('publico/rede', base)).then(r => (r.ok ? r.json() : null));
      if (!dados || !dados.telas) return;
      const faixa = $('#rede-numeros');
      Object.entries(dados).forEach(([chave, valor]) => {
        const alvo = $('[data-numero="' + chave + '"]', faixa);
        if (alvo) alvo.textContent = Number(valor || 0).toLocaleString('pt-BR');
      });
      faixa.hidden = false;
    } catch { /* sem números, o site segue igual */ }
  })();

  const menu = $('#mobile-menu');
  const menuToggle = $('.menu-toggle');
  function closeMenu() { menu.hidden = true; menuToggle.setAttribute('aria-expanded', 'false'); menuToggle.setAttribute('aria-label', 'Abrir menu'); }
  menuToggle.addEventListener('click', () => {
    const open = menu.hidden;
    menu.hidden = !open;
    menuToggle.setAttribute('aria-expanded', String(open));
    menuToggle.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
  });
  $$('a,button', menu).forEach(item => item.addEventListener('click', closeMenu));
  document.addEventListener('click', event => { if (!$('.site-header').contains(event.target)) closeMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !menu.hidden) { closeMenu(); menuToggle.focus(); } });
  window.matchMedia('(min-width: 851px)').addEventListener('change', event => { if (event.matches) closeMenu(); });

  /*
   * Cada aba tem o par de fotos dela: clicar troca as DUAS de cima. A foto grande de baixo é fixa —
   * ela abre o bloco do formato e não fica competindo com o par.
   * O recorte (x, y, largura, altura) é sobre o arquivo original, feito no navegador.
   */
  const foto = (arquivo, largura, altura, alt, legenda) => ({ src: 'assets/fotos/' + arquivo, w: largura, h: altura, alt, legenda });
  const formats = {
    shopping: {
      name: 'Shopping', checkbox: 'Shopping', title: 'Sua marca no caminho das pessoas.',
      description: 'Campanhas digitais que entram na rotina de quem passeia, encontra e consome.',
      locations: 'Corredores, entradas e áreas de circulação.',
      content: 'Lançamentos, ofertas e campanhas institucionais.',
      fotos: [
        foto('shopping-corredor.webp', 1400, 876, 'Totem da rede no corredor de um shopping, aplicação ilustrativa.', 'A tela no caminho de quem passa.'),
        foto('restaurante.webp', 1400, 933, 'Totem da rede na entrada de um restaurante de shopping, aplicação ilustrativa.', 'Na praça de alimentação, na hora da escolha.'),
      ],
    },
    elevadores: {
      name: 'Elevadores', checkbox: 'Elevadores', title: 'Presença em cada trajeto.',
      description: 'Uma mensagem bem apresentada pode fazer parte dos pequenos deslocamentos do dia.',
      locations: 'Prédios residenciais e edifícios comerciais.',
      content: 'Campanhas, serviços locais e comunicação do condomínio.',
      fotos: [
        foto('elevador-dentro.webp', 1400, 933, 'Passageiro olhando a tela da rede dentro do elevador, aplicação ilustrativa.', 'Dentro do elevador, a atenção é toda da tela.'),
        foto('elevador-hall.webp', 1400, 933, 'Tela da rede no hall dos elevadores de um edifício, aplicação ilustrativa.', 'E na espera, antes de entrar.'),
      ],
    },
    tv: {
      name: 'TVs indoor', checkbox: 'TVs indoor', title: 'A mensagem no ambiente certo.',
      description: 'Telas que aproximam marcas dos momentos de pausa, convivência e consumo.',
      locations: 'Restaurantes, cafés, academias, farmácias e salas de espera.',
      content: 'Ofertas, vídeos curtos e comunicação institucional.',
      fotos: [
        foto('restaurante-tv.webp', 1400, 933, 'TV da rede com anúncio de restaurante acima do balcão, aplicação ilustrativa.', 'No restaurante, na hora de escolher o prato.'),
        foto('academia.webp', 1400, 933, 'TV da rede com anúncio de bebida esportiva em uma academia, aplicação ilustrativa.', 'Na academia, entre uma série e outra.'),
      ],
    },
    outdoor: {
      name: 'Outdoor', checkbox: 'Outdoor digital', title: 'A avenida inteira vê.',
      description: 'Painel digital de rua: alcance de massa para quem passa de carro, de moto ou a pé.',
      locations: 'Avenidas e corredores de tráfego.',
      content: 'Campanhas de marca, promoções e datas comemorativas.',
      fotos: [
        foto('outdoor.webp', 1400, 933, 'Painel digital da rede em uma avenida movimentada, aplicação ilustrativa.', 'Na avenida, no caminho de todo mundo.'),
        foto('outdoor-noite.webp', 1400, 933, 'Painel digital da rede aceso no fim da tarde, em avenida de tráfego intenso, aplicação ilustrativa.', 'E aceso, quando a cidade volta para casa.'),
      ],
    },
    recepcoes: {
      name: 'Recepções', checkbox: 'Recepções e totens', title: 'Receba bem. Comunique melhor.',
      description: 'Totens e telas que integram a campanha à experiência de visitantes e clientes.',
      locations: 'Clínicas, hotéis, escritórios e áreas comuns.',
      content: 'Campanhas de marca, serviços e informações do espaço.',
      fotos: [
        foto('clinica.webp', 1400, 933, 'Tela da rede na recepção de uma clínica, aplicação ilustrativa.', 'Na sala de espera, com tempo para ler.'),
        foto('lobby.webp', 1400, 933, 'Totem da rede no lobby de um edifício corporativo, aplicação ilustrativa.', 'No lobby, quem entra já vê.'),
      ],
    },
  };
  let currentFormat = 'shopping';
  const tabs = $$('[role="tab"]');
  function selectFormat(key, focusTab, rolar = false) {
    if (!formats[key]) return;
    currentFormat = key;
    const data = formats[key];
    tabs.forEach(tab => { const active = tab.dataset.format === key; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; if (active && focusTab) tab.focus(); });
    $('#format-panel').setAttribute('aria-labelledby', 'tab-' + key);
    $('#format-name').textContent = data.name;
    $('#format-title').textContent = data.title;
    $('#format-description').textContent = data.description;
    $('#format-locations').textContent = data.locations;
    $('#format-content').textContent = data.content;
    // As fotos de cima são o que muda ao trocar de aba. Formato com uma foto só ocupa a linha inteira.
    // Trocar de aba não pode deixar metade da foto fora da tela.
    if (rolar) requestAnimationFrame(() => $('.gallery-pair').scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    const umaFoto = data.fotos.length < 2;
    $('#figura-b').hidden = umaFoto;
    $('.gallery-pair').classList.toggle('uma', umaFoto);
    [['#foto-a', '#legenda-a'], ['#foto-b', '#legenda-b']].forEach(([janela, legenda], i) => {
      const f = data.fotos[i];
      const quadro = $(janela);
      if (!f || !quadro) return;
      const img = $('img', quadro);
      if (img.getAttribute('src') !== f.src) {
        img.setAttribute('src', f.src);
        img.setAttribute('width', f.w);
        img.setAttribute('height', f.h);
      }
      img.alt = f.alt;
      $(legenda).textContent = f.legenda;
    });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectFormat(tab.dataset.format, false, true));
    tab.addEventListener('keydown', event => {
      let next = index;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault(); selectFormat(tabs[next].dataset.format, true, true);
    });
  });

  const dialog = $('#brief-dialog');
  const form = $('#brief-form');
  const result = $('#brief-result');
  let returnFocus = null;
  let briefing = '';
  let lastObjectUrl = null;
  function openBrief(trigger, intent, format) {
    returnFocus = trigger;
    form.hidden = false; result.hidden = true;
    $('#form-error').hidden = true;
    const intended = intent === 'parceiro' ? 'parceiro' : 'anunciante';
    form.elements.intent.value = intended;
    if (format) { $$('input[name="formatos"]', form).forEach(input => { input.checked = input.value === format; }); }
    if (intended === 'parceiro') form.elements.objetivo.value = 'Apresentar meu espaço';
    else if (form.elements.objetivo.value === 'Apresentar meu espaço') form.elements.objetivo.value = '';
    $('#brief-title').textContent = intended === 'parceiro' ? 'Vamos conhecer seu espaço.' : 'Vamos planejar sua campanha.';
    closeMenu();
    if (!dialog.open) dialog.showModal();
    document.body.classList.add('dialog-open');
    form.elements.empresa.focus();
  }
  $$('[data-open-brief]').forEach(button => button.addEventListener('click', () => openBrief(button, button.dataset.intent)));
  $('#choose-format').addEventListener('click', event => openBrief(event.currentTarget, 'anunciante', formats[currentFormat].checkbox));
  $('.close-dialog').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target !== dialog) return; const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); });
  dialog.addEventListener('close', () => { document.body.classList.remove('dialog-open'); if (returnFocus && returnFocus.isConnected) returnFocus.focus(); });
  $$('input[name="intent"]', form).forEach(input => input.addEventListener('change', () => {
    const partner = form.elements.intent.value === 'parceiro';
    $('#brief-title').textContent = partner ? 'Vamos conhecer seu espaço.' : 'Vamos planejar sua campanha.';
    if (partner) form.elements.objetivo.value = 'Apresentar meu espaço';
    else if (form.elements.objetivo.value === 'Apresentar meu espaço') form.elements.objetivo.value = '';
  }));
  $$('input[name="formatos"]', form).forEach(input => input.addEventListener('change', () => { $('#form-error').hidden = true; }));
  // O número pode vir do config.js (site avulso) ou das Configurações do painel, que é onde a equipe mexe.
  let whatsapp = String(config.whatsapp || '').replace(/\D/g, '');
  let validWhatsapp = /^[1-9]\d{9,14}$/.test(whatsapp);
  (async () => {
    const base = await api();
    if (base) {
      const link = $('#painel-link');
      if (link) link.href = new URL('../', base).href;
      if (validWhatsapp) return;
      try {
        const publico = await fetch(new URL('publico', base)).then(r => (r.ok ? r.json() : null));
        const numero = String(publico && publico.whatsapp || '').replace(/\D/g, '');
        const completo = numero.length === 10 || numero.length === 11 ? '55' + numero : numero;
        if (/^[1-9]\d{9,14}$/.test(completo)) { whatsapp = completo; validWhatsapp = true; }
      } catch { /* sem WhatsApp configurado, o botão continua escondido */ }
    }
  })();
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const selected = data.getAll('formatos');
    if (!selected.length) { $('#form-error').hidden = false; $('input[name="formatos"]', form).focus(); return; }
    const isPartner = data.get('intent') === 'parceiro';
    briefing = [
      'VAI MÍDIA | ' + (isPartner ? 'Apresentação de espaço' : 'Briefing de campanha'),
      '',
      'Empresa ou marca: ' + String(data.get('empresa')).trim(),
      'Cidade / região: ' + String(data.get('cidade')).trim(),
      'Objetivo: ' + data.get('objetivo'),
      'Período: ' + data.get('periodo'),
      'Formatos: ' + selected.join(', '),
      '',
      'Detalhes: ' + (String(data.get('detalhes') || '').trim() || 'A definir'),
      '',
      'Pontos, disponibilidade e condições sujeitos à proposta comercial.'
    ].join('\n');
    $('#brief-preview').textContent = briefing;
    $('#result-title').textContent = isPartner ? 'A apresentação do seu espaço está pronta.' : 'Seu briefing está pronto.';
    $('#result-status').textContent = '';
    const send = $('#send-whatsapp');
    send.hidden = !validWhatsapp;
    if (validWhatsapp) send.href = 'https://wa.me/' + whatsapp + '?text=' + encodeURIComponent(briefing);
    form.hidden = true; result.hidden = false;
    $('#download-brief').focus();
    enviarParaEquipe(data, selected, isPartner);
  });

  /*
   * Manda o pedido para o CRM da VAI MÍDIA: ele entra como lead com origem "site", já com o
   * briefing na primeira anotação. Se não houver API por perto (site estático), nada quebra —
   * o visitante continua com o resumo para baixar, copiar ou mandar no WhatsApp.
   */
  async function enviarParaEquipe(data, formatos, isPartner) {
    const status = $('#result-status');
    const email = String(data.get('email') || '').trim();
    const telefone = String(data.get('telefone') || '').trim();
    if (!email && !telefone) {
      status.textContent = 'Deixe um e-mail ou um WhatsApp para a equipe responder — ou use os botões acima.';
      return;
    }
    const base = await api();
    if (!base) return;
    status.textContent = 'Enviando para a equipe…';
    try {
      const resposta = await fetch(new URL('contato', base), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nome: String(data.get('empresa')).trim(),
          // No CRM, quem quer anunciar é lead de anunciante; quem oferece o espaço é lead de ponto.
          tipo: isPartner ? 'ponto' : 'anunciante',
          contato: String(data.get('contato') || '').trim(),
          email,
          telefone,
          cidade: String(data.get('cidade')).trim(),
          mensagem: [
            data.get('objetivo'),
            'Período: ' + data.get('periodo'),
            'Formatos: ' + formatos.join(', '),
            String(data.get('detalhes') || '').trim()
          ].filter(Boolean).join(' · ').slice(0, 500)
        })
      });
      const corpo = await resposta.json().catch(() => ({}));
      status.textContent = resposta.ok
        ? (corpo.mensagem || 'Recebemos o seu contato. A equipe responde em breve.')
        : 'Não conseguimos enviar agora: ' + (corpo.erro || 'tente de novo') + '. Use os botões acima para compartilhar o resumo.';
    } catch {
      status.textContent = 'Sem conexão com o servidor agora. Baixe ou copie o resumo e mande para a equipe.';
    }
  }
  $('#download-brief').addEventListener('click', () => {
    if (!briefing) return;
    if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
    lastObjectUrl = URL.createObjectURL(new Blob(['\ufeff' + briefing], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = lastObjectUrl; anchor.download = 'VAI_MIDIA_Briefing.txt'; document.body.appendChild(anchor); anchor.click(); anchor.remove();
    $('#result-status').textContent = 'Briefing preparado para download.';
  });
  $('#copy-brief').addEventListener('click', async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(briefing);
      else { const textarea = document.createElement('textarea'); textarea.value = briefing; textarea.style.position = 'fixed'; textarea.style.left = '-9999px'; dialog.appendChild(textarea); textarea.select(); const ok = document.execCommand('copy'); textarea.remove(); if (!ok) throw new Error('clipboard-unavailable'); }
      $('#result-status').textContent = 'Resumo copiado.';
    } catch { $('#result-status').textContent = 'Use “Baixar briefing” para salvar o resumo.'; }
  });
  $('#edit-brief').addEventListener('click', () => { result.hidden = true; form.hidden = false; form.elements.empresa.focus(); });
  window.addEventListener('pagehide', () => { if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl); });

  const email = String(config.email || '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { const link = $('#official-email'); link.href = 'mailto:' + email; link.textContent = email; link.hidden = false; }
  try { if (config.instagramUrl) { const url = new URL(config.instagramUrl); if (url.protocol === 'https:' && (url.hostname === 'instagram.com' || url.hostname === 'www.instagram.com')) { $('#official-instagram').href = url.href; $('#official-instagram').hidden = false; } } } catch { /* Link permanece oculto sem endereço válido. */ }
  /*
   * O canonical e a imagem de prévia saíram daqui e foram para o <head> do HTML: quem monta a
   * prévia do link (WhatsApp, Instagram, Google) lê a página crua, sem rodar JavaScript.
   */
})();
