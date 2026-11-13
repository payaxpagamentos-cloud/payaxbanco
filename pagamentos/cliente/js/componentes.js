/*
 * Peças do Internet Bank. O que distingue daqui para um painel administrativo:
 *
 *  - o CARTÃO DA CONTA é a primeira coisa da tela, com o saldo grande e o número da conta,
 *    e tem o botão de esconder o saldo (todo banco tem, e não é enfeite: serve para olhar em público);
 *  - a LINHA DO TEMPO junta os lançamentos de um mesmo recebimento num movimento só. Em vez de três
 *    linhas crípticas ("crédito 100", "tarifa bancária -2,50", "tarifa PayAx -1,00"), um movimento: "Você recebeu
 *    R$ 96,50", e quem quiser abre e vê de onde veio e o que saiu. É o split explicado, não escondido.
 */
import { el, icone, dinheiro, data, R, selo } from '../comum/ui.js';

const CHAVE_SALDO = 'payax.saldo.oculto';
const oculto = () => { try { return localStorage.getItem(CHAVE_SALDO) === '1'; } catch { return false; } };
const guardarOculto = (v) => { try { localStorage.setItem(CHAVE_SALDO, v ? '1' : '0'); } catch { /* sem armazenamento */ } };

/** Marca da PayAx desenhada, para o canto do cartão. */
function simboloCartao() {
  const s = icone('dinheiro');
  s.setAttribute('viewBox', '0 0 32 32');
  s.innerHTML = '<path d="M9 23V9h6.5a4.2 4.2 0 0 1 0 8.4H12" stroke-width="2.6"/><path d="m18.5 23 5-14" stroke-width="2.6"/>';
  return s;
}

/**
 * Cartão da conta: saldo, o que está retido, número da conta e o botão de esconder.
 * @param {{saldo, disponivel, agencia, conta, retencao_dias, acoes}} d
 */
export function cartaoConta({ saldo, disponivel, agencia, conta, retencao_dias, acoes = [] }) {
  const valor = el('div', { class: 'saldo-valor num' });
  const olho = el('button', { class: 'olho', type: 'button', 'aria-label': 'Mostrar ou esconder o saldo' });

  const pintar = () => {
    const esconder = oculto();
    valor.classList.toggle('oculto', esconder);
    valor.textContent = esconder ? '•••••••' : dinheiro(saldo.disponivel_centavos);
    olho.replaceChildren(icone(esconder ? 'olho' : 'olho-fechado'));
    olho.setAttribute('aria-pressed', String(esconder));
  };
  olho.addEventListener('click', () => { guardarOculto(!oculto()); pintar(); });
  pintar();

  const item = (rotulo, conteudo) => el('div', { class: 'item' }, el('span', {}, rotulo), el('strong', {}, conteudo));

  return el('section', { class: 'cartao-conta', 'aria-label': 'Sua conta na PayAx' },
    el('div', { class: 'topo-cartao' },
      el('div', {},
        el('div', { class: 'rotulo' }, 'Saldo disponível'),
        valor),
      olho),
    el('div', { class: 'faixa' },
      item(`A liberar (D+${retencao_dias ?? 1} útil)`, oculto() ? '•••' : dinheiro(saldo.a_liberar_centavos)),
      disponivel ? item('Em transferência', oculto() ? '•••' : dinheiro(disponivel.em_transito_centavos)) : null,
      item('Saldo total', oculto() ? '•••' : dinheiro(saldo.total_centavos))),
    agencia && conta
      ? el('div', { class: 'numero-conta' },
        el('div', {}, 'Agência', el('strong', {}, agencia)),
        el('div', {}, 'Conta', el('strong', {}, conta)),
        el('div', { class: 'marca-cartao' }, simboloCartao(), 'PAYAX'))
      : null,
    acoes.length ? el('div', { style: 'margin-top:18px;display:flex;gap:8px;flex-wrap:wrap' }, acoes) : null);
}

/** Linha de atalhos — as três ou quatro coisas que a pessoa realmente veio fazer. */
export const acoesRapidas = (itens) => el('div', { class: 'acoes-rapidas' }, itens.filter(Boolean).map((a) => {
  const conteudo = [el('span', { class: 'bolha' }, icone(a.ic)), el('span', {}, a.titulo, a.descricao ? el('small', {}, a.descricao) : null)];
  return a.href
    ? el('a', { class: 'acao-rapida', href: a.href, 'aria-disabled': a.desabilitado ? 'true' : null }, conteudo)
    : el('button', { class: 'acao-rapida', type: 'button', onclick: a.onclick, 'aria-disabled': a.desabilitado ? 'true' : null }, conteudo);
}));

// ---------------------------------------------------------------- Linha do tempo
const TIPOS_RECEBIMENTO = ['credito_liquidacao', 'tarifa_banco', 'comissao'];
// Ordem fixa dos descontos, para a trilha contar sempre a mesma história: o custo do banco antes da nossa parte.
const ORDEM_DESCONTO = { tarifa_banco: 1, tarifa_emissao: 2, taxa_repasse: 3, comissao: 4 };
const porOrdem = (a, b) => (ORDEM_DESCONTO[a.tipo] ?? 9) - (ORDEM_DESCONTO[b.tipo] ?? 9);

/**
 * Junta os lançamentos num movimento por fato: um recebimento (crédito + as duas tarifas) vira
 * um item só; uma transferência (repasse + tarifa) também. O resto fica como está.
 */
export function agruparMovimentos(lancamentos) {
  const grupos = new Map();
  const ordem = [];
  for (const l of lancamentos) {
    const chave = l.boleto_id && TIPOS_RECEBIMENTO.includes(l.tipo) ? `b${l.boleto_id}:${l.data_competencia}`
      : l.repasse_id && ['repasse', 'taxa_repasse'].includes(l.tipo) ? `r${l.repasse_id}`
        : `l${l.id}`;
    if (!grupos.has(chave)) {
      grupos.set(chave, { chave, partes: [], data: l.data_competencia, liberacao: l.data_liberacao, valor: 0, boleto_id: l.boleto_id ?? null });
      ordem.push(chave);
    }
    const g = grupos.get(chave);
    g.partes.push(l);
    g.valor += l.valor_centavos;
    if (l.data_liberacao > g.liberacao) g.liberacao = l.data_liberacao;
  }
  return ordem.map((c) => montar(grupos.get(c)));
}

function montar(g) {
  const tipos = g.partes.map((p) => p.tipo);
  const credito = g.partes.find((p) => p.tipo === 'credito_liquidacao');
  const repasse = g.partes.find((p) => p.tipo === 'repasse');
  const unico = g.partes[0];

  if (credito) {
    return {
      ...g,
      genero: 'recebimento',
      icone: 'dinheiro',
      tom: 'credito',
      titulo: credito.pagador_nome ? `Recebimento de ${credito.pagador_nome}` : 'Recebimento',
      subtitulo: credito.seu_numero ? `Documento ${credito.seu_numero}` : `Boleto ${credito.nosso_numero ?? ''}`.trim(),
      bruto: credito.valor_centavos,
      descontos: g.partes.filter((p) => p.valor_centavos < 0).sort(porOrdem),
    };
  }
  if (repasse) {
    return {
      ...g,
      genero: 'transferencia',
      icone: 'pix',
      tom: 'debito',
      titulo: 'Transferência para a sua conta',
      subtitulo: repasse.descricao.replace(/^Repasse PIX #\d+ · /, 'PIX para ') || 'PIX',
      descontos: g.partes.filter((p) => p.tipo === 'taxa_repasse'),
    };
  }
  const neutros = { tarifa_emissao: 'taxa', estorno: 'neutro', ajuste: 'neutro' };
  return {
    ...g,
    genero: unico.tipo,
    icone: unico.tipo === 'tarifa_emissao' ? 'boleto' : unico.valor_centavos >= 0 ? 'dinheiro' : 'troca',
    tom: neutros[unico.tipo] ?? (unico.valor_centavos >= 0 ? 'credito' : 'debito'),
    titulo: unico.tipo_nome,
    subtitulo: unico.descricao,
    descontos: [],
  };
}

/** Um movimento da linha do tempo, com o detalhe do split quando faz sentido abrir. */
function movimento(m, { aoAbrirBoleto = null, hoje }) {
  const abrivel = m.genero === 'recebimento' || m.descontos.length > 0;
  const valor = el('span', { class: `valor ${m.valor >= 0 ? 'credito' : 'debito'}` },
    `${m.valor >= 0 ? '+' : '−'} ${dinheiro(Math.abs(m.valor))}`);

  const retido = m.liberacao > hoje;
  const linha = el('button', {
    class: `mov${abrivel ? ' abrivel' : ''}`,
    type: 'button',
    'aria-expanded': abrivel ? 'false' : null,
  },
  el('span', { class: `icone-mov ${m.tom}` }, icone(m.icone)),
  el('span', { class: 'corpo' },
    el('strong', {}, m.titulo),
    el('small', {}, [m.subtitulo, retido ? `liberação em ${data(m.liberacao)}` : null].filter(Boolean).join(' · '))),
  valor,
  abrivel ? el('span', { class: 'seta' }, icone('seta')) : null);

  if (!abrivel) return [linha];

  const detalhe = el('div', { class: 'detalhe-mov', hidden: true });
  const passo = (cor, texto, v, classe = '') => el('div', { class: `passo ${classe}` },
    el('span', { class: 'marca-passo', style: cor ? `background:${cor}` : 'background:transparent' }),
    el('span', { class: 'texto' }, texto),
    el('span', { class: 'num' }, dinheiro(v)));

  detalhe.append(el('div', { class: 'trilha' },
    m.bruto ? passo('var(--serie-1)', 'O pagador pagou', m.bruto) : null,
    ...m.descontos.map((d) => passo(d.tipo === 'comissao' ? 'var(--serie-3)' : 'var(--serie-2)', d.tipo_nome, d.valor_centavos)),
    passo(null, m.genero === 'transferencia' ? 'Saiu da sua conta' : 'Entrou na sua conta', m.valor, 'total')));

  if (m.boleto_id && aoAbrirBoleto) {
    detalhe.append(el('div', { class: 'rodape' },
      el('button', { class: 'botao sec pequeno', type: 'button', onclick: () => aoAbrirBoleto(m.boleto_id) }, icone('boleto'), 'Ver o boleto')));
  }

  linha.addEventListener('click', () => {
    const abrindo = detalhe.hidden;
    detalhe.hidden = !abrindo;
    linha.setAttribute('aria-expanded', String(abrindo));
  });
  return [linha, detalhe];
}

/**
 * Linha do tempo agrupada por dia, com o resultado de cada dia ao lado da data.
 * @param {{lancamentos, hoje, aoAbrirBoleto, vazio}} opcoes
 */
export function linhaTempo({ lancamentos, hoje, aoAbrirBoleto = null, limite = null, vazio = 'Nenhum movimento no período.' }) {
  // Agrupa primeiro e corta depois: cortar lançamentos soltos partiria um recebimento ao meio,
  // deixando a tarifa órfã na tela sem o crédito que a originou.
  let movimentos = agruparMovimentos(lancamentos);
  if (limite) movimentos = movimentos.slice(0, limite);
  if (!movimentos.length) return el('p', { class: 'vazio' }, vazio);

  const porDia = new Map();
  for (const m of movimentos) {
    if (!porDia.has(m.data)) porDia.set(m.data, []);
    porDia.get(m.data).push(m);
  }

  const caixa = el('div', { class: 'linha-tempo' });
  for (const [dia, lista] of [...porDia.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
    const total = lista.reduce((s, m) => s + m.valor, 0);
    caixa.append(el('div', { class: 'dia-tempo' },
      el('span', {}, dia === hoje ? 'Hoje' : data(dia)),
      el('span', { class: 'saldo-dia' }, `${total >= 0 ? '+' : '−'} ${dinheiro(Math.abs(total))} no dia`)));
    for (const m of lista) caixa.append(...movimento(m, { aoAbrirBoleto, hoje }));
  }
  return caixa;
}
