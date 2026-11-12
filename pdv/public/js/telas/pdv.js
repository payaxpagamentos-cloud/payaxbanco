import { api } from '../api.js';
import {
  el, limpar, dinheiro, centavos, reaisCampo, campo, escolha, formModal, modal, toast, acao, icone,
  FORMAS, FORMAS_CURTAS, ICONE_FORMA, dataBr, documento, repetir, perguntar,
} from '../ui.js';

const TECLAS_FORMA = { dinheiro: 'F2', pix: 'F3', debito: 'F4', credito: 'F5' };

/**
 * Balcão: busca o cliente no IXC, escolhe as faturas, recebe em uma ou mais formas de pagamento
 * (com a maquininha quando é cartão) e imprime o comprovante.
 */
export async function telaPdv(ctx) {
  const base = `/empresas/${ctx.empresaId}`;
  let inicial = await api.get(base);
  const estado = { cliente: null, contratos: [], faturas: [], escolhidas: new Set(), pagamentos: [], desconto: 0, avulso: null };

  const coluna = el('div', { class: 'coluna coluna-esquerda' });
  const pagamento = el('div', { class: 'coluna-pagamento' });
  limpar(ctx.conteudo, el('div', { class: 'pdv' }, coluna, pagamento));

  // ---------- Cabeçalho do caixa ----------
  function avisoCaixa() {
    if (inicial.caixa) {
      return el('div', { class: 'cartao', style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap' },
        el('div', {}, el('strong', {}, `Caixa aberto · ${inicial.caixa.pdv_nome ?? ''}`),
          el('div', { class: 'pequeno mudo' }, `Dinheiro em caixa: ${dinheiro(inicial.caixa.resumo.dinheiro_em_caixa_centavos)} · recebido hoje neste caixa: ${dinheiro(inicial.caixa.resumo.recebido_centavos)}`)),
        el('a', { class: 'btn', href: `#/empresa/${ctx.empresaId}/caixa` }, 'Ver caixa'));
    }
    const botao = el('button', { class: 'btn primario' }, 'Abrir caixa');
    botao.addEventListener('click', () => abrirCaixa());
    return el('div', { class: 'aviso-caixa' },
      el('span', {}, icone('alerta'), ' ', inicial.config.exigir_caixa ? 'Abra o caixa para começar a receber.' : 'Nenhum caixa aberto: os recebimentos ficam sem caixa.'),
      botao);
  }

  async function abrirCaixa() {
    const pdvs = inicial.pdvs.filter((p) => p.ativo);
    if (!pdvs.length) return toast('Nenhum PDV cadastrado. Fale com o administrador.', true);
    await formModal('Abrir caixa', () => [
      escolha('PDV', 'pdv_id', Object.fromEntries(pdvs.map((p) => [p.id, p.nome])), pdvs[0].id),
      campo('Fundo de troco (R$)', { name: 'fundo', inputmode: 'decimal', value: '0,00' }),
    ], async (d) => {
      await api.post(`${base}/caixa`, { pdv_id: Number(d.pdv_id), fundo_centavos: centavos(d.fundo) ?? 0 });
      inicial = await api.get(base);
      toast('Caixa aberto.');
      desenhar();
    }, { rotulo: 'Abrir' });
  }

  // ---------- Busca do cliente ----------
  const entrada = el('input', { placeholder: 'CPF/CNPJ, nome, telefone ou código do cliente', autofocus: true, autocomplete: 'off' });
  const resultados = el('div');
  const buscar = el('button', { class: 'btn primario' }, icone('buscar'), 'Buscar');
  const formBusca = el('form', { class: 'busca-cliente' }, entrada, buscar);
  formBusca.addEventListener('submit', (e) => {
    e.preventDefault();
    acao(buscar, async () => {
      const texto = entrada.value.trim();
      if (!texto) return;
      limpar(resultados, el('p', { class: 'mudo' }, 'Procurando no IXC…'));
      const { clientes } = await api.get(`${base}/clientes?busca=${encodeURIComponent(texto)}`);
      if (!clientes.length) return limpar(resultados, el('p', { class: 'mudo' }, 'Nenhum cliente encontrado com esses dados.'));
      if (clientes.length === 1) return escolherCliente(clientes[0].id);
      limpar(resultados, el('div', { class: 'tabela-wrap' }, el('table', { class: 'tabela' },
        el('tbody', {}, clientes.map((c) => el('tr', { class: 'clicavel', onclick: () => escolherCliente(c.id) },
          el('td', {}, el('strong', {}, c.nome), el('div', { class: 'pequeno mudo' }, [documento(c.documento), c.cidade].filter(Boolean).join(' · '))),
          el('td', { class: 'dir' }, el('span', { class: 'pequeno mudo' }, `código ${c.id}`))))))));
    });
  });

  async function escolherCliente(id) {
    limpar(resultados, el('p', { class: 'mudo' }, 'Carregando as faturas…'));
    try {
      const dados = await api.get(`${base}/clientes/${id}`);
      estado.cliente = dados.cliente;
      estado.contratos = dados.contratos;
      estado.faturas = dados.faturas;
      estado.ultimos = dados.ultimos_recebimentos;
      estado.escolhidas = new Set(dados.faturas.filter((f) => f.atraso.dias > 0).map((f) => f.id));
      if (!estado.escolhidas.size && dados.faturas.length) estado.escolhidas.add(dados.faturas[0].id);
      estado.pagamentos = [];
      estado.desconto = 0;
      estado.avulso = null;
      limpar(resultados);
      desenhar();
    } catch (err) {
      limpar(resultados, el('p', { class: 'aviso' }, err.message));
    }
  }

  function limparAtendimento() {
    estado.cliente = null;
    estado.faturas = [];
    estado.escolhidas.clear();
    estado.pagamentos = [];
    estado.desconto = 0;
    estado.avulso = null;
    entrada.value = '';
    limpar(resultados);
    desenhar();
    entrada.focus();
  }

  // ---------- Totais ----------
  const selecionadas = () => estado.faturas.filter((f) => estado.escolhidas.has(f.id));
  const totalTitulos = () => (estado.avulso ? estado.avulso.valor : selecionadas().reduce((s, f) => s + f.total_centavos, 0));
  const total = () => Math.max(0, totalTitulos() - estado.desconto);
  const pago = () => estado.pagamentos.reduce((s, p) => s + p.valor_centavos, 0);
  const falta = () => total() - pago();

  // ---------- Telas ----------
  function desenhar() {
    limpar(coluna, avisoCaixa(), cartaoCliente(), cartaoFaturas());
    limpar(pagamento, cartaoPagamento());
  }

  function cartaoCliente() {
    const c = el('div', { class: 'cartao' }, el('div', { class: 'passo' }, el('i', {}, '1'), 'Cliente'), formBusca, resultados);
    if (estado.cliente) {
      const semIxc = !estado.cliente.id;
      c.append(el('div', { class: 'cliente-escolhido', style: 'margin-top:14px' },
        el('div', {},
          el('div', { class: 'nome' }, semIxc ? 'Sem cliente do IXC' : estado.cliente.nome),
          el('div', { class: 'pequeno mudo' }, semIxc ? 'O nome de quem está pagando é pedido ao finalizar.'
            : [documento(estado.cliente.documento), estado.cliente.telefone, `código ${estado.cliente.id}`].filter(Boolean).join(' · ')),
          el('div', { class: 'contratos' }, estado.contratos.map((ct) => el('span', { class: `etiqueta ${ct.acesso === 'liberado' ? 'ok' : ct.ativo ? 'aviso' : ''}` },
            `${ct.plano ?? `Contrato ${ct.id}`} · ${(ct.acesso ?? '').replace(/_/g, ' ')}`)))),
        el('button', { class: 'btn', onclick: limparAtendimento }, semIxc ? 'Limpar' : 'Trocar cliente')));
      if (estado.ultimos?.length) {
        c.append(el('details', { style: 'margin-top:10px' }, el('summary', { class: 'pequeno mudo' }, 'Últimos recebimentos deste cliente no PDV'),
          el('div', { class: 'pequeno', style: 'margin-top:6px' }, estado.ultimos.map((u) => el('div', {},
            `${dataBr(u.data)} · ${dinheiro(u.valor_centavos)} · ${u.status === 'cancelado' ? 'cancelado' : u.ixc_status}`)))));
      }
    }
    return c;
  }

  function cartaoFaturas() {
    const c = el('div', { class: 'cartao' }, el('div', { class: 'passo' }, el('i', {}, '2'), 'Faturas a receber'));
    if (!estado.cliente) {
      c.append(el('p', { class: 'mudo' }, 'Escolha um cliente para ver as faturas em aberto no IXC.'));
      if (inicial.config.permitir_avulso) c.append(botaoAvulso());
      return c;
    }
    if (estado.avulso) {
      c.append(el('div', { class: 'fatura on' },
        el('div', { class: 'corpo' }, el('strong', {}, estado.avulso.descricao), el('div', { class: 'pequeno mudo' }, 'Recebimento avulso, sem fatura do IXC')),
        el('div', { class: 'valores' }, el('div', { class: 'total' }, dinheiro(estado.avulso.valor)))),
      el('button', { class: 'btn', style: 'margin-top:10px', onclick: () => { estado.avulso = null; estado.pagamentos = []; desenhar(); } }, 'Remover'));
      return c;
    }
    if (!estado.faturas.length) {
      c.append(el('p', { class: 'mudo' }, 'Este cliente não tem faturas em aberto no IXC.'));
      if (inicial.config.permitir_avulso) c.append(botaoAvulso());
      return c;
    }
    for (const f of estado.faturas) {
      const marcada = estado.escolhidas.has(f.id);
      const linha = el('label', { class: `fatura${marcada ? ' on' : ''}${f.atraso.dias > 0 ? ' vencida' : ''}` },
        el('input', { type: 'checkbox', checked: marcada, onchange: (e) => {
          if (e.target.checked) estado.escolhidas.add(f.id); else estado.escolhidas.delete(f.id);
          estado.pagamentos = [];
          desenhar();
        } }),
        el('div', { class: 'corpo' },
          el('strong', {}, `Fatura ${f.id}${f.documento ? ` · ${f.documento}` : ''}`),
          el('div', { class: 'pequeno mudo' }, [`vence ${dataBr(f.vencimento)}`, f.atraso.dias > 0 ? `${f.atraso.dias} dia(s) de atraso` : null, f.descricao].filter(Boolean).join(' · '))),
        el('div', { class: 'valores' },
          el('div', { class: 'total' }, dinheiro(f.total_centavos)),
          f.atraso.total_centavos ? el('div', { class: 'nota' }, `${dinheiro(f.aberto_centavos)} + ${dinheiro(f.atraso.total_centavos)} de multa e juros`) : null));
      c.append(linha);
    }
    if (inicial.config.permitir_avulso) c.append(botaoAvulso());
    return c;
  }

  function botaoAvulso() {
    return el('button', { class: 'btn', style: 'margin-top:12px', onclick: () => {
      formModal('Recebimento sem fatura', () => [
        campo('Descrição (o que está sendo recebido)', { name: 'descricao', required: true, maxlength: 200 }),
        campo('Valor (R$)', { name: 'valor', inputmode: 'decimal', required: true }),
      ], (d) => {
        const valor = centavos(d.valor);
        if (!valor || valor <= 0) throw new Error('Informe um valor maior que zero.');
        estado.avulso = { descricao: d.descricao, valor };
        estado.escolhidas.clear();
        estado.pagamentos = [];
        if (!estado.cliente) estado.cliente = { id: null, nome: '', documento: '', avulso: true };
        desenhar();
      }, { rotulo: 'Incluir' });
    } }, 'Receber sem fatura (avulso)');
  }

  function cartaoPagamento() {
    const c = el('div', { class: 'cartao' }, el('div', { class: 'passo' }, el('i', {}, '3'), 'Pagamento'));
    const t = total();
    c.append(el('div', { class: 'total-pagar' }, el('span', { class: 'mudo' }, 'Total a pagar'), el('span', { class: 'valor' }, dinheiro(t))));
    if (estado.desconto) c.append(el('div', { class: 'linha entre pequeno' }, el('span', {}, 'Desconto'), el('span', {}, `- ${dinheiro(estado.desconto)}`)));
    if (inicial.config.desconto_max_percentual > 0 && t > 0) {
      c.append(el('button', { class: 'btn', style: 'width:100%;margin-bottom:10px', onclick: () => pedirDesconto() },
        estado.desconto ? 'Alterar desconto' : `Dar desconto (até ${inicial.config.desconto_max_percentual}%)`));
    }

    if (estado.pagamentos.length) {
      c.append(el('div', { style: 'margin:8px 0' }, estado.pagamentos.map((p, i) => el('div', { class: 'pagamento-item' },
        el('div', {}, el('strong', {}, FORMAS_CURTAS[p.forma] + (p.parcelas > 1 ? ` ${p.parcelas}x` : '')),
          el('div', { class: 'detalhe' }, [p.nsu ? `NSU ${p.nsu}` : null, p.bandeira, p.recebido_centavos && p.recebido_centavos > p.valor_centavos ? `troco ${dinheiro(p.recebido_centavos - p.valor_centavos)}` : null].filter(Boolean).join(' · '))),
        el('div', { class: 'linha' }, el('strong', {}, dinheiro(p.valor_centavos)),
          el('button', { title: 'Remover', onclick: () => { estado.pagamentos.splice(i, 1); desenhar(); } }, '×'))))));
    }

    const restante = falta();
    c.append(el('div', { class: `total-pagar ${restante > 0 ? 'falta' : 'pago'}` },
      el('span', { class: 'mudo' }, restante > 0 ? 'Falta receber' : 'Recebido'),
      el('span', { class: 'valor' }, dinheiro(restante > 0 ? restante : pago()))));

    if (t > 0 && restante > 0) {
      c.append(el('div', { class: 'formas' }, Object.keys(FORMAS).map((forma) => el('button', {
        class: 'btn', onclick: () => adicionarPagamento(forma), title: TECLAS_FORMA[forma] ? `Atalho ${TECLAS_FORMA[forma]}` : undefined,
      }, icone(ICONE_FORMA[forma]), FORMAS_CURTAS[forma]))));
    }

    const finalizar = el('button', { class: 'btn primario largo', style: 'margin-top:12px;min-height:46px', disabled: !(t > 0 && restante === 0) }, 'Finalizar recebimento');
    finalizar.addEventListener('click', () => acao(finalizar, concluir));
    c.append(finalizar);
    if (t > 0) c.append(el('button', { class: 'btn', style: 'width:100%;margin-top:8px', onclick: () => limparAtendimento() }, 'Cancelar atendimento'));
    return c;
  }

  function pedirDesconto() {
    formModal('Desconto', () => [
      el('p', { class: 'mudo' }, `Máximo de ${inicial.config.desconto_max_percentual}% sobre o valor das faturas.`),
      campo('Desconto (R$)', { name: 'desconto', inputmode: 'decimal', value: reaisCampo(estado.desconto) }),
    ], (d) => {
      const valor = centavos(d.desconto) ?? 0;
      const maximo = Math.round((totalTitulos() * inicial.config.desconto_max_percentual) / 100);
      if (valor > maximo) throw new Error(`O desconto passa do limite (${dinheiro(maximo)}).`);
      estado.desconto = Math.max(0, valor);
      estado.pagamentos = [];
      desenhar();
    }, { rotulo: 'Aplicar' });
  }

  // ---------- Formas de pagamento ----------
  async function adicionarPagamento(forma) {
    const restante = falta();
    if (forma === 'debito' || forma === 'credito') return pagarComCartao(forma, restante);
    const dados = await formModal(`${FORMAS[forma]}`, () => [
      campo('Valor (R$)', { name: 'valor', inputmode: 'decimal', value: reaisCampo(restante), required: true }),
      forma === 'dinheiro' ? campo('Dinheiro recebido (R$)', { name: 'recebido', inputmode: 'decimal', placeholder: 'para calcular o troco' }) : null,
      forma !== 'dinheiro' ? campo('Identificação (opcional)', { name: 'nsu', maxlength: 30, placeholder: 'ex.: fim do ID do PIX' }) : null,
    ], (d) => {
      const valor = centavos(d.valor);
      if (!valor || valor <= 0) throw new Error('Informe um valor maior que zero.');
      if (valor > falta()) throw new Error('O valor passa do que falta receber.');
      const recebido = forma === 'dinheiro' && d.recebido ? centavos(d.recebido) : valor;
      if (recebido < valor) throw new Error('O dinheiro recebido é menor que o valor do pagamento.');
      return { forma, valor_centavos: valor, recebido_centavos: recebido, nsu: d.nsu || null, parcelas: 1 };
    }, { rotulo: 'Incluir' });
    if (!dados || dados === true) return;
    estado.pagamentos.push(dados);
    if (dados.forma === 'dinheiro' && dados.recebido_centavos > dados.valor_centavos) {
      toast(`Troco: ${dinheiro(dados.recebido_centavos - dados.valor_centavos)}`);
    }
    desenhar();
  }

  /** Cartão: cria a cobrança na maquininha e acompanha até aprovar (ou pede o NSU, se a maquininha é manual). */
  async function pagarComCartao(forma, restante) {
    const terminais = inicial.terminais ?? [];
    if (!terminais.length) return toast('Nenhuma maquininha cadastrada. Use o lançamento manual nas Configurações.', true);
    const escolha1 = await formModal(FORMAS[forma], () => [
      campo('Valor (R$)', { name: 'valor', inputmode: 'decimal', value: reaisCampo(restante), required: true }),
      escolha('Maquininha', 'terminal_id', Object.fromEntries(terminais.map((t) => [t.id, t.nome])), terminais[0].id),
      forma === 'credito' ? escolha('Parcelas', 'parcelas', Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, `${i + 1}x`])), 1) : null,
    ], (d) => {
      const valor = centavos(d.valor);
      if (!valor || valor <= 0) throw new Error('Informe um valor maior que zero.');
      if (valor > falta()) throw new Error('O valor passa do que falta receber.');
      return { valor, terminalId: Number(d.terminal_id), parcelas: Number(d.parcelas ?? 1) };
    }, { rotulo: 'Enviar à maquininha' });
    if (!escolha1 || escolha1 === true) return;
    const terminal = terminais.find((t) => t.id === escolha1.terminalId);

    if (terminal.modo === 'manual') {
      const manual = await formModal('Cartão passado na maquininha', () => [
        el('p', { class: 'mudo' }, `Passe ${dinheiro(escolha1.valor)} na maquininha "${terminal.nome}" e copie os dados do comprovante.`),
        campo('NSU', { name: 'nsu', required: true, maxlength: 30 }),
        campo('Autorização', { name: 'autorizacao', maxlength: 30 }),
        campo('Bandeira', { name: 'bandeira', maxlength: 30 }),
        campo('Final do cartão', { name: 'cartao_final', maxlength: 4, inputmode: 'numeric' }),
      ], async (d) => api.post(`${base}/cartao/cobrancas/manual`, {
        terminal_id: terminal.id, forma, valor_centavos: escolha1.valor, parcelas: escolha1.parcelas, ...d,
      }), { rotulo: 'Confirmar' });
      if (!manual || manual === true) return;
      estado.pagamentos.push({ forma, valor_centavos: manual.valor_centavos, parcelas: manual.parcelas, transacao_id: manual.id, nsu: manual.nsu, bandeira: manual.bandeira });
      desenhar();
      return;
    }

    let cobranca;
    try {
      cobranca = await api.post(`${base}/cartao/cobrancas`, { terminal_id: terminal.id, forma, valor_centavos: escolha1.valor, parcelas: escolha1.parcelas });
    } catch (err) {
      return toast(err.message, true);
    }
    const aprovada = await esperarCartao(cobranca, terminal);
    if (!aprovada) return;
    estado.pagamentos.push({
      forma, valor_centavos: aprovada.valor_centavos, parcelas: aprovada.parcelas, transacao_id: aprovada.id, nsu: aprovada.nsu, bandeira: aprovada.bandeira,
    });
    desenhar();
  }

  /** Espera a maquininha responder, mostrando a situação da cobrança. */
  function esperarCartao(cobranca, terminal) {
    return modal('Na maquininha', (fechar) => {
      const situacao = el('div', { class: 'aguardando' }, el('span', { class: 'bolinha' }), el('span', {}, 'Esperando a maquininha…'));
      const detalhe = el('p', { class: 'pequeno mudo' }, `${terminal.nome} · ${dinheiro(cobranca.valor_centavos)}${cobranca.parcelas > 1 ? ` em ${cobranca.parcelas}x` : ''} · ref. ${cobranca.referencia}`);
      const cancelar = el('button', { class: 'btn' }, 'Cancelar cobrança');
      cancelar.addEventListener('click', () => acao(cancelar, async () => {
        await api.post(`${base}/cartao/cobrancas/${cobranca.id}/cancelar`);
        parar();
        fechar(null);
      }));
      const parar = repetir(async () => {
        const t = await api.get(`${base}/cartao/cobrancas/${cobranca.id}`);
        if (t.status === 'pendente' || t.status === 'enviada') {
          situacao.lastChild.textContent = t.status === 'enviada' ? 'Passe o cartão na maquininha…' : 'Esperando a maquininha pegar a cobrança…';
          return;
        }
        parar();
        if (t.status === 'aprovada') { fechar(t); return; }
        limpar(situacao, el('span', {}, `Cobrança ${t.status}. ${t.mensagem ?? ''}`));
        situacao.className = 'aviso';
        setTimeout(() => fechar(null), 2500);
      }, 1500);
      return [situacao, detalhe, el('div', { class: 'linha entre' }, cancelar)];
    });
  }

  // ---------- Conclusão ----------
  async function concluir() {
    const corpo = {
      cliente_ixc_id: estado.cliente?.id ?? null,
      cliente_nome: estado.cliente?.nome || (await perguntar('Quem está pagando?', 'Nome do cliente')) || 'Consumidor',
      cliente_documento: estado.cliente?.documento ?? null,
      contrato_ixc_id: selecionadas()[0]?.contrato_id ?? null,
      pagamentos: estado.pagamentos.map((p) => ({
        forma: p.forma, valor_centavos: p.valor_centavos, recebido_centavos: p.recebido_centavos, transacao_id: p.transacao_id ?? null, nsu: p.nsu ?? null,
      })),
    };
    if (estado.avulso) {
      corpo.descricao = estado.avulso.descricao;
      corpo.valor_centavos = estado.avulso.valor - estado.desconto;
    } else {
      const lista = selecionadas();
      const desconto = estado.desconto;
      corpo.titulos = lista.map((f, i) => ({
        fatura_ixc_id: f.id,
        contrato_ixc_id: f.contrato_id,
        documento: f.documento,
        vencimento: f.vencimento,
        valor_centavos: f.aberto_centavos,
        acrescimo_centavos: f.atraso.total_centavos,
        // O desconto fica no primeiro título (o total do recebimento é o mesmo).
        desconto_centavos: i === 0 ? desconto : 0,
      }));
    }
    const r = await api.post(`${base}/recebimentos`, corpo);
    if (r.aviso) toast(r.aviso, true); else toast(`Recebimento ${r.numero} registrado.`);
    inicial = await api.get(base);
    await mostrarComprovante(r);
    limparAtendimento();
  }

  async function mostrarComprovante(recebimento) {
    const { texto } = await api.get(`${base}/recebimentos/${recebimento.id}/comprovante`);
    await modal(`Recebimento ${recebimento.numero} · ${dinheiro(recebimento.valor_centavos)}`, (fechar) => [
      el('div', { class: 'linha', style: 'gap:8px;margin-bottom:10px' },
        el('span', { class: `etiqueta ${recebimento.ixc_status === 'baixado' ? 'ok' : recebimento.ixc_status === 'avulso' ? '' : 'aviso'}` },
          recebimento.ixc_status === 'baixado' ? 'Baixado no IXC' : recebimento.ixc_status === 'avulso' ? 'Sem fatura no IXC' : 'Baixa pendente no IXC')),
      el('pre', { class: 'comprovante' }, texto),
      el('div', { class: 'linha entre', style: 'margin-top:12px' },
        el('button', { class: 'btn', onclick: () => fechar(null) }, 'Fechar'),
        el('button', { class: 'btn primario', onclick: () => window.print() }, icone('imprimir'), 'Imprimir')),
    ], { largo: true });
  }

  // Atalhos do balcão: F2 dinheiro, F3 PIX, F4 débito, F5 crédito, F8 finalizar.
  const atalhos = (e) => {
    if (document.querySelector('.modal-fundo')) return;
    const mapa = { F2: 'dinheiro', F3: 'pix', F4: 'debito', F5: 'credito' };
    if (mapa[e.key] && falta() > 0) { e.preventDefault(); adicionarPagamento(mapa[e.key]); }
    if (e.key === 'F8' && total() > 0 && falta() === 0) { e.preventDefault(); acao(null, concluir); }
  };
  document.addEventListener('keydown', atalhos);
  ctx.parar(() => document.removeEventListener('keydown', atalhos));

  desenhar();
  entrada.focus();
}
