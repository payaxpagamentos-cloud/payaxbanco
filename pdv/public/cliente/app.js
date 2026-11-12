/**
 * Tela do cliente (autoatendimento). Fica virada para quem vai pagar:
 * o cliente digita o CPF/CNPJ, escolhe as faturas, passa o cartão na maquininha e leva o comprovante.
 *
 * A tela guarda só a chave do PDV (uma vez, na ativação). Nenhum dado de cliente fica no aparelho,
 * e a tela volta sozinha ao início depois de um tempo parada.
 */

const BASE = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const CHAVE = 'pdv.cliente.chave';
const PARADA_MS = 60_000;   // volta à tela de espera depois de parado
const FIM_MS = 25_000;      // tempo que o comprovante fica na tela
const DIGITANDO_MS = 120_000; // enquanto o cliente está digitando, espera mais

const raiz = document.getElementById('tela');
let chave = null;
let abertura = null;
let estado = {};
let relogioParada = null;
let pararEspera = null;

// ---------- ferramentas ----------
function el(tag, attrs = {}, ...filhos) {
  const e = tag === 'svg' || tag === 'path' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.setAttribute('class', v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled') e[k] = !!v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const f of filhos.flat(Infinity)) if (f !== null && f !== undefined && f !== false) e.append(f instanceof Node ? f : String(f));
  return e;
}
const real = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const dinheiro = (c) => real.format((c ?? 0) / 100 || 0);
const dataBr = (d) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '');
const digitos = (t) => String(t ?? '').replace(/\D/g, '');

/** CPF/CNPJ com a máscara aparecendo enquanto o cliente digita. */
function mascara(d) {
  if (d.length <= 11) {
    return d.replace(/^(\d{3})(\d{0,3})(\d{0,3})(\d{0,2}).*/, (_, a, b, c, e) =>
      a + (b ? `.${b}` : '') + (c ? `.${c}` : '') + (e ? `-${e}` : ''));
  }
  return d.slice(0, 14).replace(/^(\d{2})(\d{0,3})(\d{0,3})(\d{0,4})(\d{0,2}).*/, (_, a, b, c, e, f) =>
    a + (b ? `.${b}` : '') + (c ? `.${c}` : '') + (e ? `/${e}` : '') + (f ? `-${f}` : ''));
}

async function api(metodo, caminho, corpo) {
  const resp = await fetch(`${BASE}/api/autoatendimento${caminho}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': chave ?? '' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  if (resp.status === 401) { apagarChave(); throw new Error('Esta tela precisa ser ativada de novo. Chame o atendente.'); }
  if (!resp.ok) {
    let msg = 'Não foi possível concluir. Chame o atendente.';
    try { msg = (await resp.json()).erro || msg; } catch { /* sem corpo */ }
    throw new Error(msg);
  }
  return resp.status === 204 ? null : resp.json();
}

const guardarChave = (v) => { chave = v; try { localStorage.setItem(CHAVE, v); } catch { /* sem armazenamento */ } };
const apagarChave = () => { chave = null; try { localStorage.removeItem(CHAVE); } catch { /* ignora */ } };

/** Volta ao início depois de um tempo parada (ninguém fica vendo a fatura do outro). */
function contarParada(ms = PARADA_MS) {
  clearTimeout(relogioParada);
  relogioParada = setTimeout(() => espera(), ms);
}
const semParada = () => clearTimeout(relogioParada);
for (const evento of ['pointerdown', 'keydown']) document.addEventListener(evento, () => { if (relogioParada) contarParada(); });

/** O logo pode ser um arquivo publicado junto com o PDV ou um endereço https. */
const urlLogo = (u) => (!u ? `${BASE}/img/logo-cliente.png` : /^https?:\/\//i.test(u) ? u : `${BASE}/${String(u).replace(/^\//, '')}`);

/**
 * Totem: tela cheia, sem menu do navegador e sem deixar o monitor apagar.
 * Só dá para pedir tela cheia a partir de um toque do cliente — por isso o pedido sai no primeiro toque.
 */
let telaCheiaPedida = false;
async function modoTotem() {
  if (!telaCheiaPedida) {
    telaCheiaPedida = true;
    try { await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }); } catch { /* o navegador pode recusar */ }
  }
  try { await navigator.wakeLock?.request('screen'); } catch { /* sem suporte: o monitor do totem costuma ser configurado no sistema */ }
}
document.addEventListener('contextmenu', (e) => e.preventDefault());

const marca = () => el('div', { class: 'marca' },
  el('span', { class: 'pilula' }, el('img', { src: urlLogo(abertura?.logo_url), alt: abertura?.empresa?.nome ?? 'Logo',
    onerror: (e) => { e.target.src = `${BASE}/img/logo-cliente.png`; } })),
  abertura?.loja ? el('div', { class: 'loja' }, `${abertura.loja}${abertura.pdv ? ` · ${abertura.pdv.nome}` : ''}`) : null);

const svg = (d, attrs = {}) => el('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...attrs },
  [].concat(d).map((caminho) => el('path', { d: caminho })));

/** Chamada do provedor: título, frase e o desenho da casa conectada. */
const chamada = () => el('div', { class: 'chamada' },
  el('div', {}, el('h1', {}, abertura?.titulo ?? 'Sua casa mais conectada.'),
    el('p', {}, abertura?.subtitulo ?? 'Internet para todos os seus momentos.')),
  el('div', { class: 'arte' }, el('svg', { viewBox: '0 0 120 100', fill: 'none' },
    el('path', { d: 'M86 30a16 16 0 0 1 22 0', stroke: '#8FD0FF', 'stroke-width': '5', 'stroke-linecap': 'round' }),
    el('path', { d: 'M80 22a26 26 0 0 1 34 0', stroke: '#8FD0FF', 'stroke-width': '5', 'stroke-linecap': 'round', opacity: '.75' }),
    el('path', { d: 'M74 14a36 36 0 0 1 46 0', stroke: '#8FD0FF', 'stroke-width': '5', 'stroke-linecap': 'round', opacity: '.45' }),
    el('path', { d: 'M97 36a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z', fill: '#8FD0FF' }),
    el('path', { d: 'M10 60 44 34l34 26v30a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4z', fill: '#F4F9FF' }),
    el('path', { d: 'M4 62 44 31l40 31', stroke: '#1C6FD6', 'stroke-width': '6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    el('path', { d: 'M34 94V72h20v22', fill: '#F2801E' }),
    el('path', { d: 'M18 66h10v10H18zM60 66h10v10H60z', fill: '#9CC9F5' }),
    el('path', { d: 'M62 30h8v12l-8-6z', fill: '#1C6FD6' }))));

const ajudaRodape = () => el('div', { class: 'rodape-ajuda' },
  svg(['M4 14v-2a8 8 0 0 1 16 0v2', 'M4 14h3v6H5a1 1 0 0 1-1-1zM20 14h-3v6h2a1 1 0 0 0 1-1z', 'M17 20a4 4 0 0 1-4 2h-1']),
  'Precisa de ajuda? Chame o atendente.');

const brilhos = () => el('div', { class: 'brilhos' }, el('i'), el('i'), el('i'), el('i'));

const desenhar = (...partes) => raiz.replaceChildren(brilhos(), marca(), chamada(), ...partes.flat(Infinity).filter(Boolean), ajudaRodape());

/** Passos do atendimento: 1 CPF · 2 Fatura · 3 Pagamento. */
function passos(atual) {
  const nomes = ['CPF', 'Fatura', 'Pagamento'];
  const partes = [];
  nomes.forEach((nome, i) => {
    const n = i + 1;
    if (i) partes.push(el('span', { class: `traco${atual > n - 1 ? ' feito' : ''}` }));
    partes.push(el('span', { class: `passo${atual === n ? ' on' : atual > n ? ' feito' : ''}` },
      el('span', { class: 'n' }, String(n)), nome));
  });
  return el('div', { class: 'passos' }, partes);
}

/** Formas de pagamento aceitas, mostradas embaixo do teclado. */
function formasAceitas() {
  const icones = {
    pix: 'M12 2.5 21.5 12 12 21.5 2.5 12zM8 12l4 4 4-4-4-4z',
    debito: 'M2 6h20v12H2zM2 10h20M6 15h4',
    credito: 'M2 6h20v12H2zM2 10h20M6 15h4',
  };
  const nomes = { pix: 'Pix', debito: 'Débito', credito: 'Crédito' };
  const ordem = ['pix', 'debito', 'credito'];
  const lista = ordem.filter((f) => (abertura?.formas ?? []).includes(f));
  if (!lista.length) return null;
  const partes = [];
  lista.forEach((f, i) => {
    if (i) partes.push(el('span', { class: 'ponto' }));
    partes.push(el('span', {}, svg(icones[f]), nomes[f]));
  });
  return el('div', { class: 'formas-aceitas' }, partes);
}

// ---------- ativação ----------
function telaAtivacao(erro) {
  semParada();
  const campo = el('input', { placeholder: 'pdv_xxxxxxxx_...', autocomplete: 'off', spellcheck: 'false' });
  const botao = el('button', { class: 'btn principal largo' }, 'Ativar esta tela');
  const form = el('form', { class: 'painel', onsubmit: async (e) => {
    e.preventDefault();
    botao.disabled = true;
    guardarChave(campo.value.trim());
    try {
      await iniciar();
    } catch (err) {
      apagarChave();
      botao.disabled = false;
      telaAtivacao(err.message);
    }
  } },
  el('h2', {}, 'Tela do cliente'),
  el('p', { class: 'ajuda' }, 'Esta tela ainda não está ativada. O administrador gera a chave em Lojas, PDVs e usuários › Tela do cliente.'),
  erro ? el('div', { class: 'erro-caixa' }, erro) : null,
  el('label', { class: 'campo' }, 'Chave do PDV', campo),
  botao);
  desenhar(form);
  campo.focus();
}

// ---------- 0. espera: o que fica na tela do totem entre um cliente e outro ----------
function espera() {
  semParada();
  document.onkeydown = null;
  estado = {};
  const comecar = () => { modoTotem(); inicio(); };
  const painel = el('div', { class: 'painel espera', role: 'button', tabindex: '0', onclick: comecar,
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ' || /^\d$/.test(e.key)) comecar(); } },
  el('h2', {}, 'Pague sua fatura aqui'),
  el('p', { class: 'ajuda' }, 'Em poucos toques, com cartão ou Pix.'),
  abertura?.mensagem ? el('div', { class: 'recado' }, abertura.mensagem) : null,
  el('div', { class: 'toque' }, el('span', { class: 'aro' }), el('span', { class: 'dedo' },
    svg('M9 11V5.5a1.5 1.5 0 0 1 3 0V11m0-2a1.5 1.5 0 0 1 3 0v2m0-1a1.5 1.5 0 0 1 3 0v4a6 6 0 0 1-6 6h-1.5a5 5 0 0 1-4-2l-2.5-3.5a1.6 1.6 0 0 1 2.4-2L9 14'))),
  el('div', { class: 'btn principal largo' }, 'Toque para começar', svg('M5 12h14M13 6l6 6-6 6', { class: 'seta' })),
  formasAceitas());
  desenhar(painel);
  painel.focus();
}

// ---------- 1. início: digitar o documento ----------
function inicio() {
  estado = { documento: '' };
  contarParada(DIGITANDO_MS);
  const visor = el('div', { class: 'valor vazio' }, '000.000.000-00');
  const continuar = el('button', { class: 'btn principal largo', disabled: true },
    'Consultar faturas', svg('M5 12h14M13 6l6 6-6 6', { class: 'seta' }));
  const aviso = el('div');

  const atualizar = () => {
    const d = estado.documento;
    visor.textContent = d ? mascara(d) : '000.000.000-00';
    visor.className = `valor${d ? '' : ' vazio'}`;
    continuar.disabled = !(d.length === 11 || d.length === 14);
  };
  const digitar = (n) => { if (estado.documento.length < 14) { estado.documento += n; atualizar(); } };
  const apagar = () => { estado.documento = estado.documento.slice(0, -1); atualizar(); };

  const teclado = el('div', { class: 'teclado' },
    ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => el('button', { type: 'button', onclick: () => digitar(n) }, n)),
    el('button', { type: 'button', class: 'acao', onclick: () => { estado.documento = ''; atualizar(); } }, 'Limpar'),
    el('button', { type: 'button', onclick: () => digitar('0') }, '0'),
    el('button', { type: 'button', class: 'acao', 'aria-label': 'Apagar', onclick: apagar },
      svg(['M9 5h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9L2 12z', 'M18 9l-6 6M12 9l6 6'], { viewBox: '0 0 24 24' })));

  continuar.addEventListener('click', async () => {
    continuar.disabled = true;
    continuar.textContent = 'Procurando…';
    try {
      const r = await api('POST', '/faturas', { documento: estado.documento });
      if (!r.encontrado) {
        aviso.replaceChildren(el('div', { class: 'aviso' }, 'Não encontramos este CPF/CNPJ. Confira os números ou procure o atendente.'));
        continuar.replaceChildren('Consultar faturas', svg('M5 12h14M13 6l6 6-6 6', { class: 'seta' }));
        continuar.disabled = false;
        return;
      }
      telaFaturas(r);
    } catch (err) {
      aviso.replaceChildren(el('div', { class: 'erro-caixa' }, err.message));
      continuar.replaceChildren('Consultar faturas', svg('M5 12h14M13 6l6 6-6 6', { class: 'seta' }));
      continuar.disabled = false;
    }
  });

  // Teclado físico também funciona (muitos balcões têm um).
  const teclas = (e) => {
    if (/^\d$/.test(e.key)) digitar(e.key);
    else if (e.key === 'Backspace') apagar();
    else if (e.key === 'Enter' && !continuar.disabled) continuar.click();
    else if (e.key === 'Escape') { estado.documento = ''; atualizar(); }
  };
  document.onkeydown = teclas;

  const campoDoc = el('div', { class: 'campo-doc' },
    el('span', { class: 'ic' }, svg(['M3 5h18v14H3z', 'M7 10h3v4H7z', 'M13 10h4M13 14h4'])),
    el('span', { class: 'divisoria' }),
    el('div', { class: 'corpo' }, el('div', { class: 'rotulo' }, 'CPF ou CNPJ do titular'), visor));

  desenhar(el('div', { class: 'painel' },
    passos(1),
    el('h2', {}, 'Pague sua fatura aqui'),
    el('p', { class: 'ajuda' }, 'Digite o CPF do titular para começar.'),
    abertura?.mensagem ? el('div', { class: 'recado' }, abertura.mensagem) : null,
    campoDoc, teclado, aviso, continuar, formasAceitas()));
}

// ---------- 2. faturas do cliente ----------
function telaFaturas(dados) {
  document.onkeydown = null;
  contarParada();
  estado = { ...estado, cliente: dados.cliente, faturas: dados.faturas, escolhidas: new Set(dados.faturas.map((f) => f.id)) };
  if (!dados.faturas.length) {
    desenhar(el('div', { class: 'painel' },
      passos(2),
      el('div', { class: 'selo' }, svg('M5 12.5l5 5 9-10', { 'stroke-width': '3.5' })),
      el('h2', {}, 'Tudo em dia!'),
      el('p', { class: 'ajuda' }, `${dados.cliente.nome}, não há faturas em aberto para este CPF/CNPJ.`),
      el('button', { class: 'btn largo', onclick: () => espera() }, 'Voltar ao início')));
    contarParada(20_000);
    return;
  }

  const lista = el('div');
  const total = el('strong', {});
  const pagar = el('button', { class: 'btn principal largo' }, 'Pagar');
  const somar = () => estado.faturas.filter((f) => estado.escolhidas.has(f.id)).reduce((s, f) => s + f.total_centavos, 0);
  const atualizar = () => {
    total.textContent = dinheiro(somar());
    pagar.disabled = !estado.escolhidas.size || !abertura.maquininha;
    pagar.replaceChildren(estado.escolhidas.size ? `Pagar ${dinheiro(somar())}` : 'Escolha uma fatura',
      estado.escolhidas.size ? svg('M5 12h14M13 6l6 6-6 6', { class: 'seta' }) : null);
  };

  for (const f of estado.faturas) {
    const marcado = estado.escolhidas.has(f.id);
    const linha = el('label', { class: `fatura${marcado ? ' on' : ''}` },
      el('input', { type: 'checkbox', checked: marcado, onchange: (e) => {
        if (e.target.checked) { estado.escolhidas.add(f.id); linha.classList.add('on'); } else { estado.escolhidas.delete(f.id); linha.classList.remove('on'); }
        atualizar();
      } }),
      el('div', { class: 'corpo' },
        el('strong', {}, `Vencimento ${dataBr(f.vencimento)}`),
        el('span', {}, f.dias_atraso > 0 ? el('span', { class: 'atrasada' }, `${f.dias_atraso} dia(s) em atraso`) : 'Em dia',
          f.documento ? ` · ${f.documento}` : '')),
      el('div', { class: 'valor' }, dinheiro(f.total_centavos),
        f.acrescimo_centavos ? el('small', {}, `inclui ${dinheiro(f.acrescimo_centavos)} de multa e juros`) : null));
    lista.append(linha);
  }
  atualizar();
  pagar.addEventListener('click', () => telaFormas(somar()));

  desenhar(el('div', { class: 'painel' },
    passos(2),
    el('h2', {}, `Olá, ${dados.cliente.nome}`),
    el('p', { class: 'ajuda' }, `CPF/CNPJ ${dados.cliente.documento} · escolha o que deseja pagar`),
    lista,
    el('div', { class: 'total' }, el('span', {}, 'Total'), total),
    !abertura.maquininha ? el('div', { class: 'aviso' }, 'Nenhuma maquininha ligada nesta tela. Procure o atendente para pagar.') : null,
    pagar,
    el('button', { class: 'btn largo', onclick: () => espera() }, 'Cancelar')));
}

// ---------- 3. forma de pagamento ----------
function telaFormas(valor) {
  contarParada();
  const icones = { debito: 'M2 6h20v12H2zM2 10h20M6 15h4', credito: 'M2 6h20v12H2zM2 10h20M6 15h4', pix: 'M12 2.5 21.5 12 12 21.5 2.5 12zM8 12l4 4 4-4-4-4z' };
  const botao = (forma, rotulo, extra) => el('button', { class: 'btn azul largo', onclick: () => escolher(forma) },
    svg(icones[forma], { class: 'seta' }),
    el('span', {}, rotulo, extra ? el('div', { class: 'rodape', style: 'color:rgba(255,255,255,.8)' }, extra) : null));
  const escolher = async (forma) => {
    if (forma === 'credito') return telaParcelas(valor);
    await cobrar(forma, valor, 1);
  };
  desenhar(el('div', { class: 'painel' },
    passos(3),
    el('h2', {}, 'Como quer pagar?'),
    el('div', { class: 'total' }, el('span', {}, 'Total a pagar'), el('strong', {}, dinheiro(valor))),
    abertura.formas.includes('debito') ? botao('debito', 'Cartão de débito') : null,
    abertura.formas.includes('credito') ? botao('credito', 'Cartão de crédito', 'à vista ou parcelado') : null,
    abertura.formas.includes('pix') ? botao('pix', 'PIX', 'pelo leitor da maquininha') : null,
    el('button', { class: 'btn largo', onclick: () => telaFaturas({ cliente: estado.cliente, faturas: estado.faturas }) }, 'Voltar')));
}

function telaParcelas(valor) {
  contarParada();
  const opcoes = [];
  for (let n = 1; n <= 12; n++) {
    if (n > 1 && Math.round(valor / n) < 500) break; // não oferece parcela menor que R$ 5,00
    opcoes.push(el('button', { class: 'btn azul largo', onclick: () => cobrar('credito', valor, n) },
      el('span', {}, n === 1 ? 'À vista' : `${n}x de ${dinheiro(Math.round(valor / n))}`, n > 1 ? el('div', { class: 'rodape' }, `total ${dinheiro(valor)}`) : null)));
  }
  desenhar(el('div', { class: 'painel' },
    passos(3),
    el('h2', {}, 'Em quantas vezes?'),
    el('p', { class: 'ajuda' }, 'O parcelamento segue as regras da sua operadora de cartão.'),
    opcoes,
    el('button', { class: 'btn largo', onclick: () => telaFormas(valor) }, 'Voltar')));
}

// ---------- 4. maquininha ----------
async function cobrar(forma, valor, parcelas) {
  semParada();
  desenhar(el('div', { class: 'painel' }, passos(3), el('div', { class: 'esperando' },
    el('div', { class: 'ondas' }, el('i'), el('i'), el('i')), el('h2', {}, 'Enviando para a maquininha…'))));
  let cobranca;
  try {
    cobranca = await api('POST', '/cobrancas', { forma, valor_centavos: valor, parcelas });
  } catch (err) {
    return telaErro(err.message, valor);
  }
  telaEsperando(cobranca, valor, forma, parcelas);
}

function telaEsperando(cobranca, valor, forma, parcelas) {
  const situacao = el('h2', {}, 'Siga na maquininha');
  const detalhe = el('p', { class: 'ajuda' }, forma === 'pix' ? 'Leia o QR Code na maquininha para pagar.' : 'Insira, aproxime ou passe o cartão na maquininha.');
  const cancelar = el('button', { class: 'btn largo' }, 'Cancelar pagamento');
  cancelar.addEventListener('click', async () => {
    cancelar.disabled = true;
    pararEspera?.();
    try { await api('POST', `/cobrancas/${cobranca.id}/cancelar`); } catch { /* segue */ }
    telaFaturas({ cliente: estado.cliente, faturas: estado.faturas });
  });

  desenhar(el('div', { class: 'painel' },
    passos(3),
    el('div', { class: 'esperando' }, el('div', { class: 'ondas' }, el('i'), el('i'), el('i')), situacao, detalhe,
      el('div', { class: 'total' }, el('span', {}, parcelas > 1 ? `${parcelas}x` : 'Total'), el('strong', {}, dinheiro(valor)))),
    cancelar));

  // Pergunta ao PDV de dois em dois segundos como está a cobrança.
  let parado = false;
  let timer;
  pararEspera = () => { parado = true; clearTimeout(timer); };
  const ciclo = async () => {
    if (parado) return;
    try {
      const t = await api('GET', `/cobrancas/${cobranca.id}`);
      if (t.status === 'aprovada') { pararEspera(); return concluir(t); }
      if (['negada', 'cancelada', 'expirada'].includes(t.status)) {
        pararEspera();
        return telaErro(t.status === 'negada' ? `Pagamento não aprovado${t.mensagem ? `: ${t.mensagem}` : '.'}` : 'A cobrança foi encerrada na maquininha.', valor);
      }
      if (t.status === 'enviada') situacao.textContent = 'Passe o cartão na maquininha';
    } catch (err) {
      pararEspera();
      return telaErro(err.message, valor);
    }
    timer = setTimeout(ciclo, 2000);
  };
  ciclo();
}

// ---------- 5. fim ----------
async function concluir(cobranca) {
  desenhar(el('div', { class: 'painel' }, passos(3), el('div', { class: 'esperando' },
    el('div', { class: 'ondas' }, el('i'), el('i'), el('i')), el('h2', {}, 'Pagamento aprovado!'), el('p', { class: 'ajuda' }, 'Registrando o recibo…'))));
  let recibo;
  try {
    recibo = await api('POST', '/recebimentos', {
      transacao_id: cobranca.id,
      cliente_ixc_id: estado.cliente.id,
      faturas: [...estado.escolhidas],
    });
  } catch (err) {
    // O cartão passou: o cliente não pode sair sem registro, então chamamos o atendente com os dados na tela.
    return telaErro(`${err.message} O pagamento foi aprovado no cartão (NSU ${cobranca.nsu ?? '—'}): mostre esta tela ao atendente.`, cobranca.valor_centavos, true);
  }
  desenhar(el('div', { class: 'painel' },
    passos(3),
    el('div', { class: 'selo' }, svg('M5 12.5l5 5 9-10', { 'stroke-width': '3.5' })),
    el('h2', {}, 'Pagamento concluído'),
    el('p', { class: 'ajuda' }, `Recibo nº ${recibo.numero} · ${dinheiro(recibo.valor_centavos)}`),
    el('div', { class: 'total' }, el('span', {}, 'Faturas pagas'), el('strong', {}, String(recibo.titulos.length))),
    el('pre', { class: 'comprovante' }, recibo.comprovante),
    el('div', { class: 'linha' },
      el('button', { class: 'btn', onclick: () => window.print() }, 'Imprimir'),
      el('button', { class: 'btn principal', onclick: () => espera() }, 'Concluir', svg('M5 12h14M13 6l6 6-6 6', { class: 'seta' }))),
    el('p', { class: 'rodape' }, 'Guarde seu comprovante. Obrigado!')));
  contarParada(FIM_MS);
}

function telaErro(mensagem, valor, chamarAtendente = false) {
  desenhar(el('div', { class: 'painel' },
    el('div', { class: 'selo erro' }, svg('M7 7l10 10M17 7L7 17', { 'stroke-width': '3.5' })),
    el('h2', {}, chamarAtendente ? 'Chame o atendente' : 'Não deu certo'),
    el('p', { class: 'ajuda' }, mensagem),
    valor ? el('div', { class: 'total' }, el('span', {}, 'Valor'), el('strong', {}, dinheiro(valor))) : null,
    el('div', { class: 'linha' },
      estado.faturas?.length && !chamarAtendente
        ? el('button', { class: 'btn', onclick: () => telaFaturas({ cliente: estado.cliente, faturas: estado.faturas }) }, 'Tentar de novo')
        : null,
      el('button', { class: 'btn principal', onclick: () => espera() }, 'Voltar ao início'))));
  contarParada(chamarAtendente ? 180_000 : 45_000);
}

// ---------- entrada ----------
async function iniciar() {
  abertura = await api('GET', '/');
  if (!abertura.ixc_pronto) {
    desenhar(el('div', { class: 'painel' },
      el('h2', {}, 'Atendimento indisponível'),
      el('p', { class: 'ajuda' }, 'A consulta de faturas está fora do ar neste momento. Procure o atendente.')));
    return;
  }
  espera();
}

try { chave = localStorage.getItem(CHAVE); } catch { chave = null; }
// A chave também pode vir no endereço da tela (…/cliente/#pdv_xxxx_yyyy), para ativar sem teclado.
if (location.hash.startsWith('#pdv_')) {
  guardarChave(location.hash.slice(1));
  history.replaceState(null, '', location.pathname);
}
if (!chave) telaAtivacao();
else iniciar().catch((err) => telaAtivacao(err.message));
