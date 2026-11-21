/*
 * Portal do assinante.
 *
 * Aplicação própria, sem nada do painel interno: quem entra aqui é cliente, quase sempre pelo celular, e
 * não deve baixar o código de um sistema de operação que jamais vai abrir.
 *
 * Duas regras que valem em toda a tela:
 *
 * 1. O QUE ELE PRECISA VEM PRIMEIRO. Valor em aberto e botão de copiar o PIX acima da dobra. Quem abre
 *    isto às onze da noite quer pagar e voltar a ter internet, não navegar.
 * 2. NADA DE JARGÃO. O servidor já traduz o estado do serviço para a linguagem do cliente; aqui não se
 *    acrescenta termo interno nenhum.
 */

const BASE = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const CHAVE = 'portal.sessao';
const raiz = document.getElementById('app');

const sessao = {
  get() { try { return JSON.parse(localStorage.getItem(CHAVE)); } catch { return null; } },
  set(d) { try { localStorage.setItem(CHAVE, JSON.stringify(d)); } catch { /* sem armazenamento: vale esta aba */ } },
  limpar() { try { localStorage.removeItem(CHAVE); } catch { /* ignora */ } },
};

async function api(metodo, caminho, corpo) {
  const s = sessao.get();
  const resp = await fetch(`${BASE}/api/portal${caminho}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(s?.token ? { Authorization: `Bearer ${s.token}` } : {}) },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => { throw new Error('Sem conexão. Verifique a sua internet e tente de novo.'); });
  if (resp.status === 401 && s?.token) { sessao.limpar(); desenhar(); throw new Error('Sua sessão expirou. Entre de novo.'); }
  if (resp.status === 204) return null;
  const dados = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(dados?.erro || 'Não foi possível concluir agora.');
  return dados;
}

/* ---------------- Montagem ---------------- */

function el(tag, attrs = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const f of filhos.flat(Infinity)) if (f !== null && f !== undefined && f !== false) e.append(f instanceof Node ? f : String(f));
  return e;
}
const limpar = (alvo, ...f) => { alvo.replaceChildren(...f.flat(Infinity).filter(Boolean)); return alvo; };

const real = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const dinheiro = (c) => real.format((c ?? 0) / 100);
const data = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '—');
const competencia = (c) => (c ? `${String(c).slice(5, 7)}/${String(c).slice(0, 4)}` : null);

function nota(texto, erro = false) {
  document.querySelector('.p-nota')?.remove();
  const n = el('div', { class: `p-nota${erro ? ' erro' : ''}`, role: 'status' }, texto);
  document.body.append(n);
  setTimeout(() => n.remove(), 4500);
}

const marca = () => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 72 44');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<defs><linearGradient id="pf" x1="6" y1="5" x2="65" y2="42" gradientUnits="userSpaceOnUse">
      <stop stop-color="#8ff0c2"/><stop offset=".4" stop-color="#29d78e"/><stop offset="1" stop-color="#009659"/></linearGradient>
    <linearGradient id="pd" x1="25" y1="12" x2="40" y2="39" gradientUnits="userSpaceOnUse">
      <stop stop-color="#087949"/><stop offset="1" stop-color="#004c34"/></linearGradient></defs>
    <path d="M3 39 16 8c1-3 3-5 7-5h5l12 29-6 11h-8L19 25l-6 15H4c-1 0-2 0-1-1Z" fill="url(#pf)"/>
    <path d="m25 4 12 29 7-16 9 21-5 5H34L18 5c2-2 5-2 7-1Z" fill="url(#pd)"/>
    <path d="M36 34 48 8c1-3 3-5 6-5h7l12 37c0 1 0 2-2 2H59l-6-19-8 17c-2 4-7 4-9 2l-4-8h4Z" fill="url(#pf)"/>`;
  return s;
};

/* ---------------- Entrada ---------------- */

function telaEntrada(modo = 'entrar') {
  const aviso = el('div', { class: 'p-aviso erro', role: 'alert' });
  const documento = el('input', { type: 'text', inputmode: 'numeric', autocomplete: 'username', placeholder: 'Somente números', required: true });
  const codigo = el('input', { type: 'text', autocapitalize: 'characters', autocomplete: 'one-time-code', placeholder: 'Código de 8 letras e números', required: true });
  const senha = el('input', { type: 'password', autocomplete: modo === 'entrar' ? 'current-password' : 'new-password', required: true, minlength: '8' });
  const botao = el('button', { class: 'p-botao', type: 'submit' }, modo === 'entrar' ? 'Entrar' : 'Criar a minha senha');

  const form = el('form', { class: 'p-cartao' },
    el('label', { class: 'p-campo' }, el('span', {}, 'CPF ou CNPJ'), documento),
    modo === 'ativar' ? el('label', { class: 'p-campo' }, el('span', {}, 'Código recebido'), codigo,
      el('span', { class: 'p-ajuda' }, 'O código é enviado pelo seu provedor e vale uma vez.')) : null,
    el('label', { class: 'p-campo' }, el('span', {}, modo === 'entrar' ? 'Senha' : 'Escolha uma senha'), senha,
      modo === 'ativar' ? el('span', { class: 'p-ajuda' }, 'Pelo menos 8 caracteres.') : null),
    aviso, botao);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    aviso.textContent = '';
    botao.disabled = true;
    const rotuloOriginal = botao.textContent;
    botao.textContent = 'Aguarde…';
    try {
      const corpo = { documento: documento.value, senha: senha.value, ...(modo === 'ativar' ? { codigo: codigo.value } : {}) };
      const r = await api('POST', modo === 'entrar' ? '/entrar' : '/ativar', corpo);
      sessao.set({ token: r.token, nome: r.nome });
      desenhar();
    } catch (err) {
      aviso.textContent = err.message;
      senha.value = '';
      senha.focus();
    } finally { botao.disabled = false; botao.textContent = rotuloOriginal; }
  });

  limpar(raiz, el('div', { class: 'p-entrada' },
    el('div', { class: 'p-topo' }, marca(), el('div', { class: 'p-marca' }, 'manager', el('small', {}, 'PROVEDOR'))),
    el('h1', {}, modo === 'entrar' ? 'Minha conta' : 'Primeiro acesso'),
    el('p', { class: 'p-fraco' }, modo === 'entrar'
      ? 'Segunda via, situação do serviço e atendimento.'
      : 'Use o código que o seu provedor enviou para criar a sua senha.'),
    form,
    el('button', { class: 'p-trocar', type: 'button', onclick: () => telaEntrada(modo === 'entrar' ? 'ativar' : 'entrar') },
      modo === 'entrar' ? 'Primeiro acesso ou esqueci a senha' : 'Já tenho senha'),
    modo === 'ativar'
      ? el('p', { class: 'p-fraco p-centro' }, 'Não recebeu o código? Fale com o seu provedor: ele gera um novo na hora.')
      : null));
  documento.focus();
}

/* ---------------- Conta ---------------- */

async function telaConta() {
  limpar(raiz, cabecalho(), el('p', { class: 'p-fraco p-centro' }, 'Carregando…'));
  let d;
  try { d = await api('GET', '/me'); } catch (err) { return limpar(raiz, cabecalho(), el('div', { class: 'p-aviso erro' }, err.message)); }

  const aba = el('div', { class: 'p-aba', role: 'tablist' });
  const corpo = el('div');
  const abas = [['conta', 'Minha conta'], ['faturas', 'Faturas'], ['atendimento', 'Atendimento']];
  let atual = 'conta';
  const trocar = (id) => {
    atual = id;
    for (const b of aba.children) b.setAttribute('aria-selected', String(b.dataset.id === id));
    if (id === 'faturas') return abaFaturas(corpo);
    if (id === 'atendimento') return abaAtendimento(corpo, d);
    return abaConta(corpo, d);
  };
  for (const [id, rotulo] of abas) {
    const b = el('button', { role: 'tab', 'aria-selected': String(id === atual), onclick: () => trocar(id) }, rotulo);
    b.dataset.id = id;
    aba.append(b);
  }

  limpar(raiz, cabecalho(d), aba, corpo);
  trocar('conta');
}

const cabecalho = (d) => el('div', { class: 'p-topo' },
  marca(), el('div', { class: 'p-marca' }, 'manager', el('small', {}, d?.provedor ?? 'PROVEDOR')),
  el('button', { class: 'p-sair', onclick: () => { sessao.limpar(); desenhar(); } }, 'Sair'));

function abaConta(corpo, d) {
  const c = d.contratos[0];
  limpar(corpo,
    c ? el('div', { class: 'p-cartao' },
      el('div', { class: 'p-estado' },
        el('div', { class: `p-bolha ${c.conexao.situacao}` }),
        el('div', {}, el('strong', {}, c.conexao.titulo),
          c.conexao.detalhe ? el('p', {}, c.conexao.detalhe) : null)),
      c.conexao.acao === 'chamado'
        ? el('button', { class: 'p-botao secundario', onclick: () => abrirChamado() }, 'Abrir um chamado')
        : null) : null,

    d.em_aberto.faturas
      ? el('div', { class: 'p-cartao' },
        el('h2', {}, 'Em aberto'),
        el('div', { class: 'p-valor' }, dinheiro(d.em_aberto.valor_centavos),
          el('small', {}, ` em ${d.em_aberto.faturas} fatura${d.em_aberto.faturas > 1 ? 's' : ''}`)),
        d.em_aberto.vencidas
          ? el('div', { class: 'p-aviso', style: 'margin-top:12px' }, `${d.em_aberto.vencidas} vencida${d.em_aberto.vencidas > 1 ? 's' : ''}. `
            + 'Pague pelo PIX e a liberação é automática.')
          : null,
        el('button', { class: 'p-botao', onclick: () => { document.querySelector('.p-aba button:nth-child(2)').click(); } }, 'Ver e pagar'))
      : el('div', { class: 'p-cartao p-centro' }, el('h2', {}, 'Nada em aberto'),
        el('p', { class: 'p-fraco', style: 'margin:0' }, 'Suas faturas estão em dia.')),

    c ? el('div', { class: 'p-cartao' },
      el('h2', {}, 'Meu plano'),
      el('div', { class: 'p-linha' }, el('span', {}, 'Plano'), el('b', {}, c.plano)),
      c.download_mbps ? el('div', { class: 'p-linha' }, el('span', {}, 'Velocidade'),
        el('b', {}, `${c.download_mbps} Mbps${c.upload_mbps ? ` / ${c.upload_mbps} Mbps` : ''}`)) : null,
      el('div', { class: 'p-linha' }, el('span', {}, 'Mensalidade'), el('b', {}, dinheiro(c.mensalidade_centavos))),
      el('div', { class: 'p-linha' }, el('span', {}, 'Vence todo dia'), el('b', {}, c.dia_vencimento)),
      el('div', { class: 'p-linha' }, el('span', {}, 'Contrato'), el('b', {}, `#${c.numero}`))) : null,

    el('div', { class: 'p-cartao' },
      el('h2', {}, 'Meus dados'),
      el('div', { class: 'p-linha' }, el('span', {}, 'Nome'), el('b', {}, d.assinante.nome)),
      el('div', { class: 'p-linha' }, el('span', {}, 'E-mail'), el('b', {}, d.assinante.email ?? '—')),
      el('div', { class: 'p-linha' }, el('span', {}, 'Telefone'), el('b', {}, d.assinante.telefone ?? '—')),
      el('button', { class: 'p-botao discreto', onclick: () => editarContato(d) }, 'Alterar contato'),
      el('button', { class: 'p-botao discreto', onclick: () => trocarSenha() }, 'Trocar a senha')));
}

async function abaFaturas(corpo) {
  limpar(corpo, el('p', { class: 'p-fraco p-centro' }, 'Carregando…'));
  let faturas;
  try { faturas = await api('GET', '/faturas'); } catch (err) { return limpar(corpo, el('div', { class: 'p-aviso erro' }, err.message)); }
  if (!faturas.length) return limpar(corpo, el('div', { class: 'p-cartao p-centro' }, el('p', { class: 'p-fraco', style: 'margin:0' }, 'Nenhuma fatura ainda.')));

  limpar(corpo, el('div', { class: 'p-cartao' }, faturas.map((f) => {
    const aberta = ['aberta', 'parcial'].includes(f.situacao);
    const vencida = aberta && f.encargos?.dias_atraso > 0;
    const saldo = f.valor_centavos - f.pago_centavos;
    return el('div', { class: 'p-fatura' },
      el('div', { class: 'p-info' },
        el('b', {}, dinheiro(aberta ? saldo : f.valor_centavos)),
        el('span', {}, `${competencia(f.competencia) ?? 'Avulsa'} · vence ${data(f.vencimento)}`),
        // Multa e juros aparecem SEPARADOS: o valor da fatura não muda, e o cliente precisa ver por quê.
        vencida ? el('span', { style: 'color:var(--vermelho)' }, ` · ${f.encargos.dias_atraso} dia(s) de atraso, `
          + `${dinheiro(f.encargos.multa_centavos + f.encargos.juros_centavos)} de multa e juros`) : null),
      aberta
        ? el('button', { class: 'p-etq ' + (vencida ? 'vencida' : 'aberta'), style: 'border:0',
          onclick: (e) => segundaVia(f, e.currentTarget) }, 'Pagar')
        : el('span', { class: 'p-etq paga' }, f.situacao === 'paga' ? 'Paga' : f.situacao));
  })));
}

async function segundaVia(fatura, botao) {
  botao.disabled = true;
  const original = botao.textContent;
  botao.textContent = '…';
  try {
    const r = await api('POST', `/faturas/${fatura.id}/segunda-via`);
    mostrarPagamento(r);
  } catch (err) { nota(err.message, true); } finally { botao.disabled = false; botao.textContent = original; }
}

function mostrarPagamento(r) {
  const copiar = async (texto, oque) => {
    try { await navigator.clipboard.writeText(texto); nota(`${oque} copiado. Cole no aplicativo do seu banco.`); }
    catch { nota('Selecione o código na tela para copiar.', true); }
  };
  const caixa = el('div', { class: 'p-cartao' },
    el('h2', {}, `Fatura #${r.fatura.numero}`, el('span', { class: 'p-fraco' }, ` · vence ${data(r.fatura.vencimento)}`)),
    el('div', { class: 'p-valor' }, dinheiro(r.fatura.valor_centavos)),
    r.pix ? el('div', {},
      el('button', { class: 'p-botao', onclick: () => copiar(r.pix.brcode, 'Código PIX') }, 'Copiar código PIX'),
      el('div', { class: 'p-codigo' }, r.pix.brcode)) : null,
    r.boleto ? el('div', {},
      el('button', { class: 'p-botao secundario', onclick: () => copiar(r.boleto.linha_digitavel, 'Código de barras') }, 'Copiar código de barras'),
      el('div', { class: 'p-codigo' }, r.boleto.linha_digitavel)) : null,
    !r.pix && !r.boleto ? el('div', { class: 'p-aviso' }, 'Fale com o seu provedor para receber a segunda via.') : null,
    el('button', { class: 'p-botao discreto', onclick: () => document.querySelector('.p-aba button:nth-child(2)').click() }, 'Voltar'));
  limpar(document.querySelector('.p-app > div:last-child'), caixa);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function abaAtendimento(corpo, d) {
  limpar(corpo, el('p', { class: 'p-fraco p-centro' }, 'Carregando…'));
  let chamados;
  try { chamados = await api('GET', '/chamados'); } catch (err) { return limpar(corpo, el('div', { class: 'p-aviso erro' }, err.message)); }
  limpar(corpo,
    el('div', { class: 'p-cartao' },
      el('h2', {}, 'Precisa de ajuda?'),
      el('p', { class: 'p-fraco', style: 'margin:0 0 4px' }, 'Descreva o que está acontecendo e a equipe entra em contato.'),
      el('button', { class: 'p-botao', onclick: () => abrirChamado() }, 'Abrir um chamado')),
    chamados.length
      ? el('div', { class: 'p-cartao' }, el('h2', {}, 'Meus chamados'), chamados.map((ch) => el('div', { class: 'p-fatura' },
        el('div', { class: 'p-info' }, el('b', {}, `#${ch.numero}`),
          el('span', {}, ch.descricao ?? ch.titulo),
          el('span', {}, ` · aberto em ${data(ch.criado_em)}`)),
        el('span', { class: `p-etq ${ch.status === 'aprovado' ? 'paga' : ''}` }, ROTULO_STATUS[ch.status] ?? ch.status))))
      : null);
  void d;
}

const ROTULO_STATUS = {
  aberto: 'Recebido', atribuido: 'Com técnico', em_rota: 'A caminho', em_execucao: 'Em atendimento',
  em_validacao: 'Em conferência', aprovado: 'Concluído', retornado: 'Reaberto', cancelado: 'Cancelado',
};

function abrirChamado() {
  const texto = el('textarea', { rows: '4', required: true, maxlength: '1000',
    style: 'width:100%;border:1px solid var(--borda);border-radius:12px;padding:12px;font-size:16px;font-family:inherit',
    placeholder: 'Exemplo: a internet cai toda noite por volta das 20h, em todos os aparelhos.' });
  const aviso = el('div', { class: 'p-aviso erro' });
  const enviar = el('button', { class: 'p-botao', type: 'submit' }, 'Enviar');
  const form = el('form', { class: 'p-cartao' },
    el('h2', {}, 'Abrir um chamado'),
    el('label', { class: 'p-campo' }, el('span', {}, 'O que está acontecendo?'), texto),
    aviso, enviar,
    el('button', { class: 'p-botao discreto', type: 'button', onclick: () => telaConta() }, 'Cancelar'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    enviar.disabled = true;
    try {
      const r = await api('POST', '/chamados', { descricao: texto.value });
      nota(`Chamado #${r.numero} aberto. A equipe entra em contato.`);
      telaConta();
    } catch (err) { aviso.textContent = err.message; } finally { enviar.disabled = false; }
  });
  limpar(document.querySelector('.p-app > div:last-child'), form);
  texto.focus();
}

function editarContato(d) {
  const email = el('input', { type: 'email', value: d.assinante.email ?? '', autocomplete: 'email' });
  const telefone = el('input', { type: 'tel', value: d.assinante.telefone ?? '', autocomplete: 'tel' });
  const aviso = el('div', { class: 'p-aviso erro' });
  const form = el('form', { class: 'p-cartao' },
    el('h2', {}, 'Alterar contato'),
    el('label', { class: 'p-campo' }, el('span', {}, 'E-mail'), email),
    el('label', { class: 'p-campo' }, el('span', {}, 'Telefone'), telefone),
    el('p', { class: 'p-fraco' }, 'Para mudar o endereço de instalação, fale com o provedor: a mudança exige visita técnica.'),
    aviso,
    el('button', { class: 'p-botao', type: 'submit' }, 'Salvar'),
    el('button', { class: 'p-botao discreto', type: 'button', onclick: () => telaConta() }, 'Cancelar'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('PATCH', '/contato', { email: email.value || null, telefone: telefone.value || null }); nota('Contato atualizado.'); telaConta(); }
    catch (err) { aviso.textContent = err.message; }
  });
  limpar(document.querySelector('.p-app > div:last-child'), form);
}

function trocarSenha() {
  const atual = el('input', { type: 'password', autocomplete: 'current-password', required: true });
  const nova = el('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8' });
  const aviso = el('div', { class: 'p-aviso erro' });
  const form = el('form', { class: 'p-cartao' },
    el('h2', {}, 'Trocar a senha'),
    el('label', { class: 'p-campo' }, el('span', {}, 'Senha atual'), atual),
    el('label', { class: 'p-campo' }, el('span', {}, 'Nova senha'), nova, el('span', { class: 'p-ajuda' }, 'Pelo menos 8 caracteres.')),
    aviso,
    el('button', { class: 'p-botao', type: 'submit' }, 'Salvar'),
    el('button', { class: 'p-botao discreto', type: 'button', onclick: () => telaConta() }, 'Cancelar'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', '/senha', { atual: atual.value, nova: nova.value }); nota('Senha alterada.'); telaConta(); }
    catch (err) { aviso.textContent = err.message; }
  });
  limpar(document.querySelector('.p-app > div:last-child'), form);
}

/* ---------------- Início ---------------- */

function desenhar() {
  if (sessao.get()?.token) return telaConta();
  return telaEntrada('entrar');
}
desenhar();
