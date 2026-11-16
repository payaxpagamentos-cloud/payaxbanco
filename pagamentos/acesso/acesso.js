/*
 * PAY AX — ativação do acesso à Área do Cliente.
 * O código do link vem depois do "#" (não vai ao servidor no endereço nem em "Referer") e é enviado só no corpo.
 */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const mostrar = (nome) => {
    for (const s of ['carregando', 'erro', 'ativar', 'pronto']) $(`[data-${s}]`).hidden = s !== nome;
  };
  // Mesma origem e mesmo prefixo da página (/ativar dentro do sistema, ou a raiz em acesso.payax.com.br).
  const prefixo = location.pathname.replace(/\/ativar\/?$/, '').replace(/\/$/, '');
  const token = new URLSearchParams(location.hash.slice(1)).get('t') || '';
  // Tira o código da barra de endereço (e do histórico) assim que lido.
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);

  async function postar(caminho, corpo) {
    let r;
    try {
      r = await fetch(`${prefixo}/api/publico/ativacao${caminho}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), credentials: 'omit', cache: 'no-store',
      });
    } catch {
      throw Object.assign(new Error('Sem conexão com a PAY AX. Verifique a internet e tente de novo.'), { status: 0 });
    }
    const d = await r.json().catch(() => ({}));
    if (r.status === 429) throw Object.assign(new Error('Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.'), { status: 429 });
    if (!r.ok) throw Object.assign(new Error(d.erro || 'Não foi possível concluir agora.'), { status: r.status });
    return d;
  }
  const falhar = (msg) => { $('[data-erro-texto]').textContent = msg; mostrar('erro'); };

  async function copiar(texto, botao) {
    try { await navigator.clipboard.writeText(texto); } catch {
      const t = Object.assign(document.createElement('textarea'), { value: texto });
      document.body.append(t); t.select(); document.execCommand('copy'); t.remove();
    }
    const antes = botao.textContent;
    botao.textContent = 'Copiado';
    setTimeout(() => { botao.textContent = antes; }, 1600);
  }

  // ------------------------------------------------------------------ senha
  const form = $('[data-form]');
  const senha = form.elements.senha;
  const confirmacao = form.elements.confirmacao;
  const msg = $('[data-msg]');
  const regras = {
    tamanho: (s) => s.length >= 8,
    letra: (s) => /[A-Za-z]/.test(s),
    numero: (s) => /\d/.test(s),
  };
  const conferirRegras = () => {
    for (const [k, f] of Object.entries(regras)) $(`[data-regra="${k}"]`).classList.toggle('ok', f(senha.value));
  };
  senha.addEventListener('input', () => { $('[data-gerada]').hidden = true; conferirRegras(); });

  const verSenha = (ver) => {
    senha.type = ver ? 'text' : 'password';
    confirmacao.type = ver ? 'text' : 'password';
    $('[data-olho]').setAttribute('aria-pressed', String(ver));
    $('[data-olho]').setAttribute('aria-label', ver ? 'Esconder senha' : 'Mostrar senha');
  };
  $('[data-olho]').addEventListener('click', () => verSenha(senha.type === 'password'));

  /** Senha forte e fácil de digitar: 4 blocos de 4, sem letras e números que se confundem (0/O, 1/l/I). */
  function gerarSenha() {
    const letras = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
    const numeros = '23456789';
    const todos = letras + numeros;
    const sorteio = (alfabeto) => {
      const limite = 256 - (256 % alfabeto.length);
      for (;;) {
        const b = crypto.getRandomValues(new Uint8Array(1))[0];
        if (b < limite) return alfabeto[b % alfabeto.length];
      }
    };
    for (;;) {
      const s = Array.from({ length: 16 }, () => sorteio(todos)).join('');
      if (/\d/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s)) return s.match(/.{4}/g).join('-');
    }
  }
  $('[data-gerar]').addEventListener('click', () => {
    const s = gerarSenha();
    senha.value = s;
    confirmacao.value = s;
    verSenha(true);
    conferirRegras();
    $('[data-gerada]').hidden = false;
    msg.hidden = true;
  });
  $('[data-copiar-senha]').addEventListener('click', (e) => copiar(senha.value, e.currentTarget));

  // CNPJ com máscara.
  const cnpj = form.elements.cnpj;
  cnpj.addEventListener('input', () => {
    const d = cnpj.value.replace(/\D/g, '').slice(0, 14);
    cnpj.value = d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.hidden = true;
    const erro = (t, campo) => { msg.textContent = t; msg.hidden = false; campo?.focus(); };
    if (cnpj.value.replace(/\D/g, '').length !== 14) return erro('Informe o CNPJ da empresa (14 números).', cnpj);
    if (!Object.values(regras).every((f) => f(senha.value))) return erro('A senha precisa ter pelo menos 8 caracteres, com letras e números.', senha);
    if (senha.value !== confirmacao.value) return erro('As duas senhas não são iguais.', confirmacao);
    const botao = $('[data-enviar]');
    botao.disabled = true;
    botao.textContent = 'Ativando…';
    try {
      const d = await postar('', { token, cnpj: cnpj.value, senha: senha.value });
      senha.value = '';
      confirmacao.value = '';
      $('[data-codigo-final]').textContent = d.codigo_usuario;
      $('[data-entrar]').href = d.entrar_em;
      mostrar('pronto');
      $('[data-pronto]').focus();
    } catch (err) {
      if (err.status === 410 || err.status === 404) falhar(err.message);
      else erro(err.message);
    } finally {
      botao.disabled = false;
      botao.textContent = 'Criar senha e ativar acesso';
    }
  });

  // ------------------------------------------------------------------ início
  (async () => {
    if (!token) return falhar('Este endereço não traz o código de ativação. Abra o link exatamente como a PAY AX enviou.');
    try {
      const d = await postar('/consultar', { token });
      $('[data-nome]').textContent = String(d.nome || '').split(' ')[0];
      $('[data-empresa]').textContent = d.empresa;
      $('[data-protocolo]').textContent = d.protocolo || '—';
      $('[data-conta]').textContent = d.conta || '—';
      $('[data-codigo]').textContent = d.codigo_usuario;
      $('[data-cnpj-dica]').textContent = d.cnpj_mascarado.slice(0, 2);
      $('[data-validade]').textContent = new Date(d.expira_em).toLocaleDateString('pt-BR');
      $('[data-copiar-codigo]').addEventListener('click', (ev) => copiar(d.codigo_usuario, ev.currentTarget));
      mostrar('ativar');
      cnpj.focus();
    } catch (err) {
      falhar(err.message);
    }
  })();
})();
