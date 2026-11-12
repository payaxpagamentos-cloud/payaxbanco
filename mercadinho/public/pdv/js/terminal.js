import { api, pareamento } from './api.js';
import { el, $, limpar, dinheiro, qtd, icone, toast, acao, fotoProduto } from '../../js/ui.js';
import { criarVitrine } from '../../vitrine/vitrine.js';

/**
 * Terminal do balcão — a única tela que o cliente usa.
 * Ele passa os produtos no leitor, confere o que pegou e paga (PIX, cartão ou conta do morador).
 * Não há login, não há menu e não há como chegar ao resto do sistema por aqui.
 */
const estado = { inicio: null, venda: null, tela: 'loja', dados: null, catalogo: null, categoria: 'todas', busca: '', destaque: null };
const SEGUNDOS_INATIVO = 90;
const SEGUNDOS_AVISO = 20;

const app = () => $('#app');
const pintar = (...filhos) => {
  fecharVitrine(); // qualquer troca de tela tira a vitrine da frente
  naEspera = false;
  limpar(app(), el('div', { class: 'terminal-tela' }, ...filhos));
};

/* ---------- marca ---------- */
/** Logo da loja. Para trocar, substitua public/img/binho-logo.png pelo logo de vocês. */
const logo = (classe) => el('img', { class: classe, src: '../img/binho-logo.png', alt: estado.inicio?.mercado.nome ?? 'Mercado Binho' });

/* ---------- cabeçalho ---------- */
const topo = (passo) => el('header', { class: 'terminal-topo' },
  el('div', { class: 'marca-loja' },
    logo('logo-topo'),
    estado.inicio?.mercado.condominio ? el('span', { class: 'condominio' }, estado.inicio.mercado.condominio) : null),
  passo ? el('span', { class: 'passo' }, passo) : null);

/* ---------- relógio de inatividade ---------- */
let timerInatividade;
let timerAviso;
function pararRelogio() {
  clearTimeout(timerInatividade);
  clearInterval(timerAviso);
  document.querySelector('.inatividade')?.remove();
}
/** Com o carrinho aberto, a tela volta sozinha ao início se o cliente for embora. */
function reiniciarRelogio() {
  pararRelogio();
  if (!estado.venda || estado.tela === 'fim' || estado.tela === 'pareamento') return;
  timerInatividade = setTimeout(avisarInatividade, (SEGUNDOS_INATIVO - SEGUNDOS_AVISO) * 1000);
}
function avisarInatividade() {
  let restam = SEGUNDOS_AVISO;
  const contador = el('strong', { class: 'display', style: 'font-size: 34px' }, String(restam));
  const aviso = el('div', { class: 'inatividade' }, el('div', { class: 'cartao' },
    el('h2', {}, 'Você ainda está aí?'),
    el('p', { class: 'mudo' }, 'Sem resposta, a compra será cancelada em'),
    contador,
    el('button', { class: 'btn primario grande', onclick: () => { pararRelogio(); reiniciarRelogio(); } }, 'Continuar comprando')));
  document.body.append(aviso);
  timerAviso = setInterval(async () => {
    restam -= 1;
    contador.textContent = String(restam);
    if (restam <= 0) {
      pararRelogio();
      await cancelarCompra({ silencioso: true });
    }
  }, 1000);
}

/* ---------- vitrine: quando ninguém está comprando ---------- */
/**
 * Com a tela de espera parada pelo tempo configurado, a vitrine (ofertas, produtos, vídeos) cobre a tela.
 * Ela some com um toque — ou quando alguém passa um produto no leitor, e aí a compra já começa direto.
 */
const vitrine = criarVitrine({ modo: 'tablet' });
let timerVitrine;
let sobreposicao = null;
let naEspera = false; // só a tela "Passe o produto no leitor" chama a vitrine (a lista sem código, não)

function fecharVitrine() {
  clearTimeout(timerVitrine);
  if (!sobreposicao) return;
  vitrine.parar();
  sobreposicao.remove();
  sobreposicao = null;
}

function agendarVitrine() {
  clearTimeout(timerVitrine);
  const cfg = vitrine.dados?.tablet;
  if (!cfg?.ligada || sobreposicao || !naEspera || estado.venda?.itens?.length) return;
  timerVitrine = setTimeout(abrirVitrine, cfg.ocioso_segundos * 1000);
}

function abrirVitrine() {
  if (sobreposicao || !naEspera || estado.venda?.itens?.length) return;
  // O clique fecha a vitrine sem chegar ao botão que está embaixo dela.
  sobreposicao = el('div', { class: 'vitrine-sobre', onclick: (e) => { e.stopPropagation(); fecharVitrine(); agendarVitrine(); } }, vitrine.elemento);
  document.body.append(sobreposicao);
  vitrine.iniciar();
}

// Leitor ou teclado: fecha a vitrine antes de o código ser lido (fase de captura), sem engolir a tecla.
document.addEventListener('keydown', () => { if (sobreposicao) fecharVitrine(); agendarVitrine(); }, true);
document.addEventListener('pointerdown', () => { if (!sobreposicao) agendarVitrine(); });
// Parado e sem a vitrine na tela, de tempos em tempos confere se a administração mudou algo.
setInterval(() => {
  if (sobreposicao || estado.venda?.itens?.length) return;
  vitrine.carregar().then(agendarVitrine);
  atualizarCatalogo();
}, 5 * 60 * 1000);

/* ---------- leitor de código de barras ---------- */
let buffer = '';
let ultimaTecla = 0;
document.addEventListener('keydown', (e) => {
  if (estado.tela === 'pareamento') return;
  const focado = document.activeElement?.tagName;
  if (focado === 'INPUT' || focado === 'TEXTAREA') return; // o cliente está digitando em um campo
  const agora = Date.now();
  if (agora - ultimaTecla > 1200) buffer = '';
  ultimaTecla = agora;
  if (e.key === 'Enter') {
    const codigo = buffer.trim();
    buffer = '';
    if (codigo.length >= 4) adicionarPorCodigo(codigo);
    return;
  }
  if (e.key.length === 1 && /[\w-]/.test(e.key)) buffer += e.key;
});
['pointerdown', 'keydown'].forEach((evento) => document.addEventListener(evento, () => reiniciarRelogio()));

/* ---------- carrinho ---------- */
async function garantirVenda() {
  if (!estado.venda) estado.venda = await api.post('/venda', {});
  return estado.venda;
}

function adicionarPorCodigo(codigo) {
  return naFila(async () => {
  try {
    await garantirVenda();
    estado.venda = await api.post(`/venda/${estado.venda.id}/itens`, { codigo });
    estado.destaque = estado.venda.itens.at(-1)?.produto_id ?? null;
    estado.tela = 'loja';
    montar();
  } catch (err) {
    toast(err.message, 'erro');
  }
  });
}

function adicionarProduto(produto, quantidade = 1) {
  return naFila(async () => {
  await garantirVenda();
  estado.venda = await api.post(`/venda/${estado.venda.id}/itens`, { produto_id: produto.id, quantidade });
  estado.destaque = produto.id;
  estado.tela = 'loja';
  montar();
  });
}

async function cancelarCompra({ silencioso = false } = {}) {
  if (estado.venda) {
    try { await api.post(`/venda/${estado.venda.id}/cancelar`, {}); } catch { /* já encerrada */ }
  }
  estado.venda = null;
  estado.tela = 'loja';
  montar();
  if (!silencioso) toast('Compra cancelada.');
}

/* ---------- telas ---------- */
function telaPareamento(erro) {
  pintar(topo('Configuração'),
    el('div', { class: 'terminal-corpo' }, el('div', { class: 'espera' }, el('div', { class: 'cartao', style: 'max-width: 460px; width: 100%' },
      el('h1', { style: 'font-size: 26px' }, 'Terminal não configurado'),
      el('p', { class: 'mudo' }, 'Peça à administração o código de pareamento deste terminal e digite abaixo.'),
      el('form', { class: 'form', onsubmit: async (e) => {
        e.preventDefault();
        const codigo = e.target.codigo.value;
        await acao(e.target.querySelector('button'), async () => {
          const r = await api.post('/parear', { codigo });
          pareamento.set(r);
          await iniciar();
        });
      } },
      el('label', { class: 'campo' }, 'Código', el('input', { name: 'codigo', placeholder: 'XXXX-XXXX', autofocus: true, autocomplete: 'off', style: 'text-align: center; font-size: 24px; letter-spacing: .2em' })),
      erro ? el('p', { class: 'etiqueta erro' }, erro) : null,
      el('button', { class: 'btn primario grande' }, 'Parear terminal'))))));
}

/* ---------- tela de compras: catálogo + "Sua compra" na mesma tela ---------- */
/**
 * O cliente bipa no leitor ou toca no + do produto; a lista da direita mostra o que já pegou, com − e +.
 * É uma tela só, do primeiro produto até "Ir para pagamento". Sem cliente, a vitrine cobre a tela.
 */
const semAcento = (t) => String(t ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const ehCodigo = (t) => /^\d{4,14}$/.test(String(t).trim());
/**
 * Tudo o que mexe na compra entra numa fila: dois toques rápidos no + viram dois itens, um depois do
 * outro — e nunca duas compras abertas ao mesmo tempo.
 */
let fila = Promise.resolve();
const naFila = (fn) => { fila = fila.then(fn, fn); return fila; };

const contarItens = (itens) => itens.reduce((n, i) => n + (i.pesavel ? 1 : Math.round(i.qtd_mil / 1000)), 0);
const formasAceitas = () => {
  const f = estado.inicio?.formas ?? {};
  return [f.pix && 'Pix', f.debito && 'Débito', f.credito && 'Crédito', f.fiado && 'Minha conta'].filter(Boolean).join(' • ');
};

function telaLoja() {
  // Já montada: só a lista da compra muda (a grade não pisca a cada produto).
  if (document.querySelector('.loja')) return atualizarCarrinho();

  const busca = el('input', {
    type: 'search', class: 'campo-busca', placeholder: 'Bipe o produto ou busque pelo nome', autocomplete: 'off', enterkeyhint: 'search', 'aria-label': 'Buscar produto',
    oninput: () => { estado.busca = busca.value; desenharGrade(); },
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const texto = busca.value.trim();
      // O leitor também "digita" aqui quando o campo está selecionado: número comprido é código de barras.
      if (ehCodigo(texto)) { busca.value = ''; estado.busca = ''; desenharGrade(); adicionarPorCodigo(texto); return; }
      const achados = filtrar();
      if (achados.length === 1 && !achados[0].esgotado) escolherProduto(achados[0]);
    },
  });

  pintar(
    el('header', { class: 'loja-topo' },
      logo('logo-topo'),
      el('h1', {}, 'Escolha seus produtos'),
      el('button', { class: 'btn-ajuda', type: 'button', onclick: abrirAjuda }, icone('ajuda'), 'Ajuda')),
    el('div', { class: 'loja' },
      el('section', { class: 'loja-catalogo' },
        el('label', { class: 'busca-loja' },
          el('span', { class: 'ico-leitor' }, icone('codigobarras')),
          el('span', { class: 'divisoria', 'aria-hidden': 'true' }),
          icone('busca'), busca),
        el('div', { class: 'chips', id: 'chips' }),
        el('div', { class: 'grade-loja', id: 'grade' })),
      el('aside', { class: 'painel-compra', id: 'carrinho' })));
  desenharChips();
  desenharGrade();
  atualizarCarrinho();
}

function filtrar() {
  const lista = estado.catalogo?.produtos ?? [];
  const termo = semAcento(estado.busca).trim();
  return lista.filter((p) => (estado.categoria === 'todas' || p.categoria_id === estado.categoria)
    && (!termo || semAcento(p.nome).includes(termo) || (p.codigo_barras ?? '').startsWith(termo)));
}

function desenharChips() {
  const caixa = $('#chips');
  if (!caixa) return;
  const chip = (id, nome) => el('button', {
    type: 'button', class: `chip${estado.categoria === id ? ' ativa' : ''}`,
    onclick: () => { estado.categoria = id; desenharChips(); desenharGrade(); $('#grade').scrollTop = 0; },
  }, nome);
  limpar(caixa, chip('todas', 'Todos'), (estado.catalogo?.categorias ?? []).map((c) => chip(c.id, c.nome)));
}

function desenharGrade() {
  const grade = $('#grade');
  if (!grade) return;
  const lista = filtrar();
  limpar(grade, lista.length
    ? lista.map((p) => el('div', {
      class: `card-loja${p.esgotado ? ' esgotado' : ''}`, role: 'button', tabindex: p.esgotado ? -1 : 0, 'aria-label': `${p.nome}, ${dinheiro(p.preco_centavos)}`,
      onclick: () => { if (!p.esgotado) escolherProduto(p); },
    },
    el('div', { class: 'card-foto' }, fotoProduto(p, { classe: 'foto-produto cartaz' })),
    el('div', { class: 'card-info' },
      el('div', { class: 'card-nome' }, p.nome),
      el('div', { class: 'card-sub' }, p.pesavel ? `preço por ${p.unidade}` : (p.categoria ?? ''))),
    // Preço e + numa faixa na largura toda do cartão: cabe mesmo com três colunas numa tela de 1366 px.
    el('div', { class: 'card-rodape' },
      el('div', { class: 'card-preco' },
        p.preco_cheio_centavos ? el('s', {}, dinheiro(p.preco_cheio_centavos)) : null,
        el('strong', { class: p.preco_cheio_centavos ? 'oferta' : '' }, dinheiro(p.preco_centavos), p.pesavel ? el('small', {}, `/${p.unidade}`) : null)),
      p.esgotado
        ? el('span', { class: 'tag-esgotado' }, 'Esgotado')
        : el('span', { class: 'mais', 'aria-hidden': 'true' }, icone('mais')))))
    : el('div', { class: 'vazio' }, estado.busca ? `Nenhum produto com "${estado.busca}".` : 'Nenhum produto nesta categoria.'));
}

function atualizarCarrinho() {
  const painel = $('#carrinho');
  if (!painel) return;
  const venda = estado.venda;
  const itens = venda?.itens ?? [];
  const n = contarItens(itens);

  const passo = (i) => el('div', { class: 'passo-qtd' },
    el('button', { type: 'button', 'aria-label': `Tirar um ${i.descricao}`, onclick: () => mudarQuantidade(i, -1) }, '−'),
    el('span', { class: 'num' }, String(Math.round(i.qtd_mil / 1000))),
    el('button', { type: 'button', 'aria-label': `Mais um ${i.descricao}`, onclick: () => mudarQuantidade(i, 1) }, '+'));

  limpar(painel,
    el('div', { class: 'painel-cabecalho' },
      el('h2', {}, 'Sua compra'),
      n ? el('span', { class: 'contador-itens' }, `${n} ${n === 1 ? 'item' : 'itens'}`) : null),
    el('div', { class: 'lista-carrinho' }, itens.length
      ? itens.map((i) => el('div', { class: `item-carrinho${i.produto_id === estado.destaque ? ' item-novo' : ''}` },
        fotoProduto(i, { classe: 'foto-produto' }),
        el('div', { class: 'crescer' },
          el('div', { class: 'nome' }, i.descricao),
          el('div', { class: 'detalhe' }, i.pesavel ? `${qtd(i.qtd_mil, i.unidade)} × ${dinheiro(i.preco_centavos)}` : `${dinheiro(i.preco_centavos)} cada`),
          i.pesavel
            ? el('button', { type: 'button', class: 'tirar', onclick: () => mudarQuantidade(i, -Infinity) }, 'Tirar')
            : passo(i)),
        el('span', { class: 'valor num' }, dinheiro(i.total_centavos))))
      : el('div', { class: 'carrinho-vazio' }, el('span', { class: 'alvo-leitor' }, icone('codigobarras')),
        el('p', {}, 'Passe o código de barras no leitor ou toque no ', el('strong', {}, '+'), ' do produto.'))),
    el('div', { class: 'painel-rodape' },
      el('div', { class: 'linha-total' }, el('span', {}, 'Total'), el('strong', { class: 'num' }, dinheiro(venda?.total_centavos ?? 0))),
      el('button', { class: 'btn primario enorme', disabled: !itens.length, onclick: () => { estado.tela = 'pagamento'; montar(); } },
        'Ir para pagamento', icone('seta-direita')),
      el('p', { class: 'formas-aceitas' }, formasAceitas()),
      el('button', { type: 'button', class: 'cancelar-compra', disabled: !itens.length, onclick: confirmarCancelamento }, 'Cancelar compra')));

  painel.querySelector('.item-novo')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  estado.destaque = null;
  // Carrinho vazio = ninguém comprando: a vitrine pode voltar depois do tempo configurado.
  naEspera = !itens.length;
  if (naEspera) agendarVitrine(); else clearTimeout(timerVitrine);
}

function mudarQuantidade(item, delta) {
  return naFila(async () => {
  try {
    // A quantidade vem da compra atual (e não do botão), porque outro toque na fila pode ter mudado.
    const atual = estado.venda?.itens?.find((i) => i.id === item.id);
    if (!atual) return;
    const nova = Math.round(atual.qtd_mil / 1000) + delta;
    estado.destaque = nova > 0 ? item.produto_id : null;
    estado.venda = nova > 0 && !item.pesavel
      ? await api.patch(`/venda/${estado.venda.id}/itens/${item.id}`, { quantidade: nova })
      : await api.delete(`/venda/${estado.venda.id}/itens/${item.id}`);
    montar();
  } catch (err) {
    toast(err.message, 'erro');
  }
  });
}

/** Janela por cima da tela (ajuda e confirmação). Toque fora fecha. */
function janela(conteudo) {
  const fechar = () => caixa.remove();
  const caixa = el('div', { class: 'sobreposicao', onclick: (e) => { if (e.target === caixa) fechar(); } },
    el('div', { class: 'cartao janela' }, ...conteudo(fechar)));
  document.body.append(caixa);
  return fechar;
}

function abrirAjuda() {
  janela((fechar) => [
    el('h2', {}, 'Como comprar'),
    el('ol', { class: 'passos-ajuda' },
      el('li', {}, 'Passe o código de barras do produto no leitor. Ele entra sozinho na sua compra.'),
      el('li', {}, 'Fruta, pão ou granel? Ache na lista e toque no +. Se for por peso, digite o que a balança mostrou.'),
      el('li', {}, 'Confira a lista à direita. Use − e + para mudar a quantidade.'),
      el('li', {}, `Toque em "Ir para pagamento" e pague: ${formasAceitas()}.`)),
    el('p', { class: 'mudo' }, 'Algum problema? Fale com a administração do condomínio.'),
    el('button', { class: 'btn primario grande', type: 'button', onclick: fechar }, 'Entendi'),
  ]);
}

function confirmarCancelamento() {
  janela((fechar) => [
    el('h2', {}, 'Cancelar a compra?'),
    el('p', { class: 'mudo' }, 'Todos os itens saem da lista. Nada é cobrado.'),
    el('div', { class: 'linha', style: 'justify-content: center' },
      el('button', { class: 'btn grande', style: 'width: auto', type: 'button', onclick: fechar }, 'Continuar comprando'),
      el('button', { class: 'btn grande perigo', style: 'width: auto', type: 'button', onclick: () => { fechar(); cancelarCompra(); } }, 'Cancelar compra')),
  ]);
}

/** Recarrega o catálogo (preço, oferta e estoque mudam ao longo do dia). Falhou? Fica com o que tinha. */
async function atualizarCatalogo() {
  try {
    estado.catalogo = await api.get('/catalogo');
    if (document.querySelector('.loja')) { desenharChips(); desenharGrade(); }
  } catch { /* segue com o catálogo anterior */ }
}

async function escolherProduto(produto) {
  if (!produto.pesavel) return acaoSegura(() => adicionarProduto(produto, 1));
  // Pesável: o cliente informa o peso que a balança mostrou.
  teclado({
    titulo: produto.nome,
    descricao: `${dinheiro(produto.preco_centavos)} por ${produto.unidade}. Digite o peso indicado na balança.`,
    acima: fotoProduto(produto, { classe: 'foto-produto grande' }),
    decimal: true,
    sufixo: produto.unidade,
    passo: 'Peso na balança',
    aoConfirmar: (valor) => acaoSegura(() => adicionarProduto(produto, valor)),
    aoVoltar: montar,
  });
}

const acaoSegura = async (fn) => {
  try { await fn(); } catch (err) { toast(err.message, 'erro'); }
};

/* ---------- pagamento ---------- */
/**
 * Uma tela, três caminhos: débito e crédito vão direto para a maquininha e o PIX mostra o QR.
 * A conta do morador só aparece se a loja tiver ligado essa forma nas configurações.
 */
function telaPagamento() {
  const formas = estado.inicio.formas;
  const opcoes = [
    formas.debito && { rotulo: 'Cartão de débito', nota: 'Insira ou aproxime o cartão na maquininha', simbolo: 'cartao', aoTocar: () => cobrarCartao('debito') },
    formas.credito && { rotulo: 'Cartão de crédito', nota: 'Insira ou aproxime o cartão na maquininha', simbolo: 'cartao', aoTocar: () => cobrarCartao('credito') },
    formas.pix && { rotulo: 'PIX', nota: 'Leia o QR Code no aplicativo do seu banco', simbolo: 'pix', aoTocar: telaPix },
    formas.fiado && { rotulo: 'Minha conta', nota: 'Vai para a fatura do mês do seu apartamento', simbolo: 'moradores', aoTocar: telaConta },
  ].filter(Boolean);

  pintar(topo('Passo 2 de 2'),
    el('div', { class: 'terminal-corpo' },
      el('div', { class: 'linha entre' },
        el('div', {},
          el('h1', { style: 'margin-bottom: 6px' }, 'Como você quer pagar?'),
          el('p', { class: 'mudo', style: 'margin: 0; font-size: 19px' }, `Total de ${dinheiro(estado.venda.total_centavos)}`)),
        el('button', { class: 'btn grande', style: 'width: auto', onclick: () => { estado.tela = 'loja'; montar(); } }, icone('voltar'), 'Voltar')),
      opcoes.length
        ? el('div', { class: 'escolha-pagamento' }, opcoes.map((o) => el('button', { class: 'opcao-pagamento', onclick: o.aoTocar },
          el('span', { class: 'circulo' }, icone(o.simbolo)), o.rotulo, el('small', {}, o.nota))))
        : el('div', { class: 'cartao' }, el('div', { class: 'vazio' }, 'Nenhuma forma de pagamento disponível. Chame a administração.'))));
}

async function telaPix() {
  pintar(topo('Pagamento'), el('div', { class: 'terminal-corpo' }, el('div', { class: 'cartao painel-pagar' },
    el('div', { class: 'girando' }), el('p', { class: 'mudo' }, 'Gerando o QR Code…'))));
  try {
    const pix = await api.post(`/venda/${estado.venda.id}/pix`, {});
    pintar(topo('Pagamento'),
      el('div', { class: 'terminal-corpo' }, el('div', { class: 'cartao painel-pagar' },
        el('h1', {}, 'Pague com PIX'),
        el('p', { class: 'mudo', style: 'margin: 0' }, 'Abra o aplicativo do seu banco e leia o código.'),
        el('img', { class: 'qr', src: pix.qrcode, alt: 'QR Code do PIX' }),
        el('div', { class: 'valor' }, dinheiro(pix.valor_centavos)),
        el('div', { class: 'copia-cola' }, pix.copia_e_cola),
        el('button', { class: 'btn primario enorme', style: 'max-width: 440px', onclick: (e) => acao(e.currentTarget, async () => {
          const venda = await api.post(`/venda/${estado.venda.id}/finalizar`, { pagamentos: [{ forma: 'pix', valor: (pix.valor_centavos / 100).toFixed(2).replace('.', ',') }] });
          concluir(venda);
        }) }, icone('check'), 'Já paguei'),
        el('button', { class: 'btn grande', style: 'max-width: 440px', onclick: () => { estado.tela = 'pagamento'; montar(); } }, 'Escolher outra forma'))));
  } catch (err) {
    toast(err.message, 'erro');
    estado.tela = 'pagamento';
    montar();
  }
}

/** Manda a cobrança para a maquininha e acompanha até aprovar, negar ou o cliente desistir. */
async function cobrarCartao(forma) {
  const maquininha = estado.inicio.maquininhas[0];
  const nome = forma === 'debito' ? 'Cartão de débito' : 'Cartão de crédito';
  if (!maquininha) return toast('Nenhuma maquininha disponível. Escolha outra forma.', 'erro');
  let cancelado = false;
  const mostrar = (texto, extra = null) => pintar(topo('Pagamento'), el('div', { class: 'terminal-corpo' }, el('div', { class: 'cartao painel-pagar' },
    el('div', { class: 'aguardando' },
      el('div', { class: 'girando' }),
      el('h1', {}, texto),
      el('p', { class: 'mudo', style: 'margin: 0' }, `${nome} · siga as instruções na maquininha.`)),
    el('div', { class: 'valor' }, dinheiro(estado.venda.total_centavos)),
    extra)));
  mostrar('Enviando para a maquininha…');

  try {
    let cobranca = await api.post(`/venda/${estado.venda.id}/cartao`, { maquininha_id: maquininha.id, forma, parcelas: 1 });
    mostrar('Passe o cartão', el('button', { class: 'btn grande', style: 'max-width: 380px', onclick: () => { cancelado = true; estado.tela = 'pagamento'; montar(); } }, 'Escolher outra forma'));
    let tentativas = 0;
    while (cobranca.status === 'pendente' && tentativas < 60 && !cancelado) {
      await new Promise((r) => setTimeout(r, 2000));
      cobranca = await api.get(`/cartao/${cobranca.id}`);
      tentativas += 1;
    }
    if (cancelado) return;
    if (cobranca.status !== 'aprovada') {
      toast(`Pagamento ${cobranca.status}. Tente de novo ou escolha outra forma.`, 'erro');
      estado.tela = 'pagamento';
      return montar();
    }
    const venda = await api.post(`/venda/${estado.venda.id}/finalizar`, {
      pagamentos: [{ forma, valor: (cobranca.valor_centavos / 100).toFixed(2).replace('.', ','), transacao_id: cobranca.id }],
    });
    return concluir(venda);
  } catch (err) {
    toast(err.message, 'erro');
    estado.tela = 'pagamento';
    return montar();
  }
}

/* ---------- conta do morador ---------- */
function telaConta() {
  teclado({
    titulo: 'Compra na sua conta',
    descricao: 'Digite o número do seu apartamento.',
    aoVoltar: () => { estado.tela = 'pagamento'; montar(); },
    aoConfirmar: async (unidade) => {
      try {
        const moradores = await api.get(`/unidade/${encodeURIComponent(unidade)}/moradores`);
        escolherMorador(moradores, unidade);
      } catch (err) {
        toast(err.message, 'erro');
        telaConta();
      }
    },
  });
}

function escolherMorador(moradores, unidade) {
  pintar(topo('Pagamento'), el('div', { class: 'terminal-corpo' }, el('div', { class: 'cartao painel-pagar' },
    el('h1', { style: 'margin: 0' }, `Unidade ${unidade}`),
    el('p', { class: 'mudo', style: 'margin: 0' }, 'Quem está comprando?'),
    el('div', { class: 'coluna', style: 'width: min(440px, 100%)' }, moradores.map((m) => el('button', {
      class: 'btn grande', disabled: !m.pode_usar,
      onclick: () => pedirSenha(m),
    }, m.nome, m.pode_usar ? null : el('span', { class: 'pequeno mudo' }, ' (sem senha cadastrada)')))),
    el('button', { class: 'btn grande', style: 'max-width: 440px', onclick: telaConta }, icone('voltar'), 'Trocar de unidade'))));
}

function pedirSenha(morador) {
  teclado({
    titulo: morador.nome,
    descricao: 'Digite sua senha de 4 números.',
    senha: true,
    aoVoltar: telaConta,
    aoConfirmar: async (pin) => {
      try {
        const r = await api.post(`/venda/${estado.venda.id}/conta`, { morador_id: morador.id, pin });
        confirmarConta(r.morador);
      } catch (err) {
        toast(err.message, 'erro');
        pedirSenha(morador);
      }
    },
  });
}

function confirmarConta(morador) {
  pintar(topo('Pagamento'), el('div', { class: 'terminal-corpo' }, el('div', { class: 'cartao painel-pagar' },
    el('h1', { style: 'margin: 0' }, `Olá, ${morador.nome.split(' ')[0]}!`),
    el('p', { class: 'mudo', style: 'margin: 0' }, `Bloco ${morador.bloco} · unidade ${morador.unidade}`),
    el('div', { class: 'valor' }, dinheiro(estado.venda.total_centavos)),
    el('p', { class: 'mudo', style: 'margin: 0' }, `Disponível na sua conta: ${dinheiro(morador.disponivel_centavos)}`),
    el('button', { class: 'btn primario enorme', style: 'max-width: 440px', onclick: (e) => acao(e.currentTarget, async () => {
      const venda = await api.post(`/venda/${estado.venda.id}/finalizar`, {
        pagamentos: [{ forma: 'fiado', valor: (estado.venda.total_centavos / 100).toFixed(2).replace('.', ',') }],
      });
      concluir(venda);
    }) }, icone('check'), 'Lançar na minha conta'),
    el('button', { class: 'btn grande', style: 'max-width: 440px', onclick: () => { estado.tela = 'pagamento'; montar(); } }, 'Escolher outra forma'))));
}

/* ---------- teclado numérico ---------- */
function teclado({ titulo, descricao, aoConfirmar, aoVoltar, acima = null, senha = false, decimal = false, sufixo = '', passo = 'Pagamento' }) {
  let valor = '';
  const visor = el('div', { class: 'visor vazio' });
  const pontos = el('div', { class: 'pontos-pin' });

  const desenhar = () => {
    if (senha) {
      limpar(pontos, Array.from({ length: Math.max(4, valor.length) }, (_, i) => el('span', { class: i < valor.length ? 'cheio' : '' })));
      return;
    }
    visor.className = `visor${valor ? '' : ' vazio'}`;
    visor.textContent = valor ? `${valor}${sufixo ? ` ${sufixo}` : ''}` : (decimal ? 'digite o peso' : 'digite o número');
  };

  const tecla = (t) => el('button', { type: 'button', class: t.classe ?? '', onclick: () => {
    if (t.valor === 'apagar') valor = valor.slice(0, -1);
    else if (t.valor === 'ok') { if (valor) aoConfirmar(valor); return; }
    else if (valor.length < (senha ? 8 : 7)) valor += t.valor;
    desenhar();
  } }, t.rotulo);

  desenhar();
  // Deitado, as informações ficam à esquerda e o teclado à direita: tudo cabe sem rolar.
  pintar(topo(passo), el('div', { class: 'terminal-corpo' }, el('div', { class: 'cartao painel-teclado' },
    el('div', { class: 'teclado-info' },
      acima,
      el('h1', { style: 'margin: 0' }, titulo),
      el('p', { class: 'mudo', style: 'margin: 0' }, descricao),
      senha ? pontos : visor,
      decimal ? el('button', { class: 'btn primario enorme', onclick: () => valor && aoConfirmar(valor) }, 'Confirmar') : null,
      el('button', { class: 'btn grande', onclick: aoVoltar }, icone('voltar'), 'Voltar')),
    el('div', { class: 'teclado-numerico' },
      ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => tecla({ rotulo: n, valor: n })),
      decimal ? tecla({ rotulo: ',', valor: ',' }) : tecla({ rotulo: '←', valor: 'apagar', classe: 'apagar' }),
      tecla({ rotulo: '0', valor: '0' }),
      decimal ? tecla({ rotulo: '←', valor: 'apagar', classe: 'apagar' }) : tecla({ rotulo: 'OK', valor: 'ok', classe: 'confirmar' })))));
}

/* ---------- fim ---------- */
function concluir(venda) {
  estado.venda = null;
  estado.tela = 'fim';
  estado.dados = venda;
  pararRelogio();
  montar();
}

function telaFim() {
  const venda = estado.dados;
  let restam = estado.inicio?.segundos_fim ?? 12;
  const contagem = el('div', { class: 'contagem' }, `Voltando ao início em ${restam}s`);
  const formas = { pix: 'PIX', debito: 'cartão de débito', credito: 'cartão de crédito', fiado: 'conta do morador', dinheiro: 'dinheiro' };

  pintar(topo('Pronto'),
    el('div', { class: 'terminal-corpo' }, el('div', { class: 'fim' }, el('div', {},
      el('div', { class: 'selo-ok' }, icone('check')),
      el('h1', {}, 'Compra concluída!'),
      el('p', { class: 'mudo', style: 'font-size: 19px' }, `${dinheiro(venda.total_centavos)} · ${venda.pagamentos.map((p) => formas[p.forma] ?? p.forma).join(' + ')}`),
      venda.morador ? el('p', { class: 'mudo' }, `Lançado na conta de ${venda.morador} — unidade ${venda.unidade}.`) : null,
      el('p', { class: 'mudo' }, 'Obrigado pela preferência!'),
      el('div', { class: 'linha', style: 'justify-content: center; margin-top: 18px' },
        el('button', { class: 'btn grande', style: 'width: auto', onclick: verCupom }, icone('impressora'), 'Ver o cupom'),
        el('button', { class: 'btn primario grande', style: 'width: auto', onclick: voltarAoInicio }, 'Nova compra')),
      contagem))));

  clearInterval(timerAviso);
  timerAviso = setInterval(() => {
    restam -= 1;
    contagem.textContent = `Voltando ao início em ${restam}s`;
    if (restam <= 0) voltarAoInicio();
  }, 1000);
}

function voltarAoInicio() {
  clearInterval(timerAviso);
  estado.dados = null;
  estado.tela = 'loja';
  estado.busca = '';
  estado.categoria = 'todas';
  montar();
  atualizarCatalogo(); // estoque e preços mudaram com a venda
}

async function verCupom() {
  clearInterval(timerAviso);
  const c = await api.get(`/venda/${estado.dados.id}/cupom`);
  const linha = (esq, dir) => `${esq}${' '.repeat(Math.max(1, 38 - esq.length - dir.length))}${dir}`;
  const texto = [
    c.mercado.nome.toUpperCase(), c.mercado.condominio, c.mercado.endereco,
    '-'.repeat(38), `COMPRA #${c.venda.id}`, new Date(c.venda.fechada_em).toLocaleString('pt-BR'), '-'.repeat(38),
    ...c.venda.itens.map((i) => `${i.descricao}\n  ${qtd(i.qtd_mil, i.unidade)} x ${dinheiro(i.preco_centavos)}${linha('', dinheiro(i.total_centavos))}`),
    '-'.repeat(38), linha('TOTAL', dinheiro(c.venda.total_centavos)),
    ...c.venda.pagamentos.map((p) => linha(p.forma.toUpperCase(), dinheiro(p.valor_centavos))),
    '-'.repeat(38), c.observacao, 'Obrigado pela preferência!',
  ].filter(Boolean).join('\n');

  pintar(topo('Cupom'), el('div', { class: 'terminal-corpo' }, el('div', { class: 'cartao painel-pagar' },
    el('pre', { class: 'cupom', style: 'text-align: left; max-width: 420px' }, texto),
    el('div', { class: 'linha', style: 'justify-content: center' },
      el('button', { class: 'btn grande', style: 'width: auto', onclick: () => window.print() }, icone('impressora'), 'Imprimir'),
      el('button', { class: 'btn primario grande', style: 'width: auto', onclick: voltarAoInicio }, 'Concluir')))));
}

/* ---------- partida ---------- */
function montar() {
  reiniciarRelogio();
  if (estado.tela === 'fim') return telaFim();
  if (estado.tela === 'pagamento') return telaPagamento();
  return telaLoja();
}

async function iniciar() {
  if (!pareamento.get()?.token) return telaPareamento();
  try {
    [estado.inicio, estado.catalogo, estado.venda] = await Promise.all([api.get('/inicio'), api.get('/catalogo'), api.get('/venda')]);
    vitrine.carregar().then(agendarVitrine); // sem esperar: a vitrine não pode atrasar a compra
    document.title = `Autoatendimento — ${estado.inicio.mercado.nome}`;
    estado.tela = 'loja';
    montar();
  } catch (err) {
    if (!pareamento.get()?.token) return telaPareamento(err.message);
    pintar(topo(), el('div', { class: 'terminal-corpo' }, el('div', { class: 'espera' }, el('div', { class: 'cartao', style: 'max-width: 460px' },
      el('h2', {}, 'Terminal fora do ar'),
      el('p', { class: 'mudo' }, err.message),
      el('button', { class: 'btn primario grande', onclick: iniciar }, 'Tentar de novo')))));
  }
  return undefined;
}

window.addEventListener('terminal:despareado', () => { estado.venda = null; telaPareamento('Este terminal foi desativado pela administração.'); });
iniciar();
