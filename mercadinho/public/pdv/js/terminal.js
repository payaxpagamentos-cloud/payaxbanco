import { api, pareamento } from './api.js';
import { el, $, limpar, dinheiro, qtd, icone, toast, acao } from '../../js/ui.js';

/**
 * Terminal do balcão — a única tela que o cliente usa.
 * Ele passa os produtos no leitor, confere o que pegou e paga (PIX, cartão ou conta do morador).
 * Não há login, não há menu e não há como chegar ao resto do sistema por aqui.
 */
const estado = { inicio: null, venda: null, tela: 'espera', dados: null };
const SEGUNDOS_INATIVO = 90;
const SEGUNDOS_AVISO = 20;

const app = () => $('#app');
const pintar = (...filhos) => limpar(app(), el('div', { class: 'terminal-tela' }, ...filhos));

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

async function adicionarPorCodigo(codigo) {
  try {
    await garantirVenda();
    estado.venda = await api.post(`/venda/${estado.venda.id}/itens`, { codigo });
    estado.tela = 'compra';
    montar();
  } catch (err) {
    toast(err.message, 'erro');
  }
}

async function adicionarProduto(produto, quantidade = 1) {
  await garantirVenda();
  estado.venda = await api.post(`/venda/${estado.venda.id}/itens`, { produto_id: produto.id, quantidade });
  estado.tela = 'compra';
  montar();
}

async function cancelarCompra({ silencioso = false } = {}) {
  if (estado.venda) {
    try { await api.post(`/venda/${estado.venda.id}/cancelar`, {}); } catch { /* já encerrada */ }
  }
  estado.venda = null;
  estado.tela = 'espera';
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

function telaEspera() {
  pintar(topo('Passo 1 de 2'),
    el('div', { class: 'terminal-corpo' },
      el('div', { class: 'espera' }, el('div', { class: 'conteudo-espera' },
        logo('logo-espera'),
        el('div', { class: 'alvo-leitor' }, icone('busca')),
        el('h1', {}, 'Passe o produto no ', el('em', {}, 'leitor')),
        el('p', {}, 'Um de cada vez. O que você passar aparece aqui na tela — no fim, é só escolher como pagar.'),
        el('button', { class: 'btn grande', style: 'max-width: 380px', onclick: telaSemCodigo }, icone('produtos'), 'Produto sem código de barras')))));
}

function telaCompra() {
  const venda = estado.venda;
  const itens = venda?.itens ?? [];
  pintar(topo('Passo 1 de 2'),
    el('div', { class: 'terminal-corpo' }, el('div', { class: 'compra' },
      el('section', { class: 'cartao lista' },
        el('div', { class: 'cabecalho' },
          el('h2', { style: 'margin: 0' }, 'Sua compra'),
          el('span', { class: 'mudo' }, `${itens.length} item(ns)`)),
        el('div', { class: 'itens' }, itens.length
          ? itens.map((i, indice) => el('div', { class: `item-compra${indice === itens.length - 1 ? ' item-novo' : ''}` },
            el('div', { class: 'crescer' },
              el('div', { class: 'nome' }, i.descricao),
              el('div', { class: 'detalhe' }, `${qtd(i.qtd_mil, i.unidade)} × ${dinheiro(i.preco_centavos)}`)),
            el('span', { class: 'valor' }, dinheiro(i.total_centavos)),
            el('button', { class: 'btn icone perigo', 'aria-label': `Tirar ${i.descricao}`, onclick: async (e) => {
              await acao(e.currentTarget, async () => {
                estado.venda = await api.delete(`/venda/${venda.id}/itens/${i.id}`);
                if (!estado.venda.itens.length) { estado.tela = 'espera'; }
                montar();
              });
            } }, icone('lixeira'))))
          : el('div', { class: 'vazio' }, 'Passe o primeiro produto no leitor.'))),

      el('aside', { class: 'resumo' },
        el('div', { class: 'cartao' },
          el('div', { class: 'rotulo-total' }, 'Total a pagar'),
          el('div', { class: 'valor-total' }, dinheiro(venda?.total_centavos ?? 0))),
        el('button', { class: 'btn primario enorme', disabled: !itens.length, onclick: () => { estado.tela = 'pagamento'; montar(); } }, icone('dinheiro'), 'Pagar'),
        el('button', { class: 'btn grande', onclick: telaSemCodigo }, icone('produtos'), 'Produto sem código'),
        el('button', { class: 'btn grande perigo', onclick: () => cancelarCompra() }, 'Cancelar compra'),
        el('p', { class: 'pequeno mudo centro' }, 'Continue passando os produtos no leitor para incluir mais itens.')))));
}

/** Hortifrúti, padaria e granel: o cliente escolhe na tela, porque não há código para bipar. */
async function telaSemCodigo() {
  const produtos = await api.get('/produtos/sem-codigo');
  pintar(topo('Escolher produto'),
    el('div', { class: 'terminal-corpo' },
      el('div', { class: 'linha entre' },
        el('h1', {}, 'Produtos sem código'),
        el('button', { class: 'btn grande', style: 'width: auto', onclick: montar }, icone('voltar'), 'Voltar')),
      produtos.length
        ? el('div', { class: 'grade-produtos' }, produtos.map((p) => el('button', { class: 'cartao-produto', onclick: () => escolherProduto(p) },
          el('span', { class: 'cat' }, p.categoria ?? 'Outros'),
          el('span', { class: 'nome' }, p.nome),
          el('span', { class: 'preco' }, `${dinheiro(p.preco_centavos)}${p.pesavel ? ` / ${p.unidade}` : ''}`))))
        : el('div', { class: 'cartao' }, el('div', { class: 'vazio' }, 'Todos os produtos têm código de barras. Passe no leitor.'))));
}

async function escolherProduto(produto) {
  if (!produto.pesavel) return acaoSegura(() => adicionarProduto(produto, 1));
  // Pesável: o cliente informa o peso que a balança mostrou.
  teclado({
    titulo: produto.nome,
    descricao: `${dinheiro(produto.preco_centavos)} por ${produto.unidade}. Digite o peso indicado na balança.`,
    decimal: true,
    sufixo: produto.unidade,
    aoConfirmar: (valor) => acaoSegura(() => adicionarProduto(produto, valor)),
    aoVoltar: telaSemCodigo,
  });
}

const acaoSegura = async (fn) => {
  try { await fn(); } catch (err) { toast(err.message, 'erro'); }
};

/* ---------- pagamento ---------- */
function telaPagamento() {
  const formas = estado.inicio.formas;
  const opcao = (chave, rotulo, nota, simbolo, aoTocar) => (formas[chave]
    ? el('button', { class: 'opcao-pagamento', onclick: aoTocar }, el('span', { class: 'circulo' }, icone(simbolo)), rotulo, el('small', {}, nota))
    : null);

  pintar(topo('Passo 2 de 2'),
    el('div', { class: 'terminal-corpo' },
      el('div', { class: 'linha entre' },
        el('div', {}, el('h1', { style: 'margin-bottom: 4px' }, 'Como você quer pagar?'),
          el('p', { class: 'mudo', style: 'margin: 0' }, `Total de ${dinheiro(estado.venda.total_centavos)}`)),
        el('button', { class: 'btn grande', style: 'width: auto', onclick: () => { estado.tela = 'compra'; montar(); } }, icone('voltar'), 'Voltar')),
      el('div', { class: 'escolha-pagamento' },
        opcao('pix', 'PIX', 'Leia o QR Code com o banco', 'pix', telaPix),
        opcao('debito', 'Cartão', 'Débito ou crédito na maquininha', 'cartao', () => telaCartao()),
        opcao('fiado', 'Minha conta', 'Vai para a fatura do mês', 'moradores', () => telaConta()))));
}

async function telaPix() {
  pintar(topo('Pagamento'), el('div', { class: 'terminal-corpo' }, el('div', { class: 'cartao painel-pagar' },
    el('div', { class: 'girando' }), el('p', { class: 'mudo' }, 'Gerando o QR Code…'))));
  try {
    const pix = await api.post(`/venda/${estado.venda.id}/pix`, {});
    pintar(topo('Pagamento'),
      el('div', { class: 'terminal-corpo' }, el('div', { class: 'cartao painel-pagar' },
        el('h1', { style: 'margin: 0' }, 'Pague com PIX'),
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

function telaCartao() {
  const maquininha = estado.inicio.maquininhas[0];
  const botao = (forma, rotulo, parcelas = 1) => el('button', { class: 'btn primario enorme', style: 'max-width: 440px', onclick: () => cobrarCartao(forma, parcelas) },
    icone('cartao'), rotulo);
  pintar(topo('Pagamento'), el('div', { class: 'terminal-corpo' }, el('div', { class: 'cartao painel-pagar' },
    el('h1', { style: 'margin: 0' }, 'Pagamento no cartão'),
    el('div', { class: 'valor' }, dinheiro(estado.venda.total_centavos)),
    el('p', { class: 'mudo', style: 'margin: 0' }, maquininha ? `Vamos enviar a cobrança para a ${maquininha.nome}.` : 'Nenhuma maquininha disponível.'),
    botao('debito', 'Débito'),
    botao('credito', 'Crédito à vista'),
    el('div', { class: 'linha', style: 'justify-content: center' },
      [2, 3].map((n) => el('button', { class: 'btn grande', style: 'width: auto', onclick: () => cobrarCartao('credito', n) }, `Crédito ${n}x`))),
    el('button', { class: 'btn grande', style: 'max-width: 440px', onclick: () => { estado.tela = 'pagamento'; montar(); } }, 'Escolher outra forma'))));
}

/** Manda a cobrança para a maquininha e acompanha até aprovar, negar ou o cliente desistir. */
async function cobrarCartao(forma, parcelas) {
  const maquininha = estado.inicio.maquininhas[0];
  if (!maquininha) return toast('Nenhuma maquininha disponível. Escolha outra forma.', 'erro');
  let cancelado = false;
  const mostrar = (texto, extra = null) => pintar(topo('Pagamento'), el('div', { class: 'terminal-corpo' }, el('div', { class: 'cartao painel-pagar' },
    el('div', { class: 'aguardando' }, el('div', { class: 'girando' }), el('h2', { style: 'margin: 0' }, texto),
      el('p', { class: 'mudo' }, 'Siga as instruções na maquininha: insira ou aproxime o cartão.')),
    el('div', { class: 'valor' }, dinheiro(estado.venda.total_centavos)),
    extra)));
  mostrar('Enviando para a maquininha…');

  try {
    let cobranca = await api.post(`/venda/${estado.venda.id}/cartao`, { maquininha_id: maquininha.id, forma, parcelas });
    mostrar('Aguardando o cartão…', el('button', { class: 'btn grande perigo', style: 'max-width: 380px', onclick: () => { cancelado = true; estado.tela = 'pagamento'; montar(); } }, 'Desistir'));
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
function teclado({ titulo, descricao, aoConfirmar, aoVoltar, senha = false, decimal = false, sufixo = '' }) {
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
  pintar(topo('Pagamento'), el('div', { class: 'terminal-corpo' }, el('div', { class: 'cartao painel-pagar' },
    el('h1', { style: 'margin: 0' }, titulo),
    el('p', { class: 'mudo', style: 'margin: 0' }, descricao),
    senha ? pontos : visor,
    el('div', { class: 'teclado-numerico' },
      ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => tecla({ rotulo: n, valor: n })),
      decimal ? tecla({ rotulo: ',', valor: ',' }) : tecla({ rotulo: '←', valor: 'apagar', classe: 'apagar' }),
      tecla({ rotulo: '0', valor: '0' }),
      decimal ? tecla({ rotulo: '←', valor: 'apagar', classe: 'apagar' }) : tecla({ rotulo: 'OK', valor: 'ok', classe: 'confirmar' })),
    decimal ? el('button', { class: 'btn primario enorme', style: 'max-width: 340px', onclick: () => valor && aoConfirmar(valor) }, 'Confirmar') : null,
    el('button', { class: 'btn grande', style: 'max-width: 340px', onclick: aoVoltar }, icone('voltar'), 'Voltar'))));
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
  estado.tela = 'espera';
  montar();
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
  if (estado.venda?.itens?.length) return telaCompra();
  return telaEspera();
}

async function iniciar() {
  if (!pareamento.get()?.token) return telaPareamento();
  try {
    estado.inicio = await api.get('/inicio');
    document.title = `Caixa — ${estado.inicio.mercado.nome}`;
    estado.venda = await api.get('/venda');
    estado.tela = estado.venda?.itens?.length ? 'compra' : 'espera';
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
