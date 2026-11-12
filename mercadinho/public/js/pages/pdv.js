import { api } from '../api.js';
import { el, $, limpar, dinheiro, emReais, paraCentavos, qtd, icone, toast, modal, confirmar, acao, etiqueta, FORMAS, dataHora } from '../ui.js';

/**
 * Frente de caixa. O operador bipa o código (ou digita o nome), confere o carrinho e recebe.
 * Atalhos: F2 finaliza, F3 volta para o leitor, F8 cancela a venda.
 */
/** Rótulos curtos dos botões de pagamento (os nomes completos ficam no resto do sistema). */
const ATALHOS = { dinheiro: 'Dinheiro', pix: 'PIX', debito: 'Débito', credito: 'Crédito', fiado: 'Conta do morador' };

export default async function pdv({ alvo, usuario, definirTitulo }) {
  let caixa = await api.get('/caixa/atual');
  let venda = caixa ? await api.get('/pdv/venda') : null;
  let maquininhas = [];
  try { maquininhas = await api.get('/pdv/maquininhas'); } catch { maquininhas = []; }

  const aoTeclar = (e) => {
    if (e.key === 'F2' && venda?.itens?.length) { e.preventDefault(); receber(); }
    if (e.key === 'F3') { e.preventDefault(); $('#leitor')?.focus(); }
    if (e.key === 'F8' && venda) { e.preventDefault(); cancelarVenda(); }
  };
  document.addEventListener('keydown', aoTeclar);

  /* ---------- caixa fechado ---------- */
  async function telaSemCaixa() {
    definirTitulo('PDV', 'Abra o caixa para começar a vender');
    limpar(alvo, el('section', { class: 'cartao', style: 'max-width: 520px' },
      el('h2', {}, 'O caixa está fechado'),
      el('p', { class: 'mudo' }, 'Informe quanto há de troco na gaveta para abrir o caixa e liberar as vendas.'),
      el('form', { class: 'form', onsubmit: async (e) => {
        e.preventDefault();
        await acao(e.target.querySelector('button'), async () => {
          const r = await api.post('/caixa/abrir', { abertura: e.target.abertura.value || '0' });
          caixa = r;
          venda = null;
          toast('Caixa aberto. Boas vendas!');
          desenhar();
        });
      } },
      el('label', { class: 'campo' }, 'Troco inicial (R$)', el('input', { name: 'abertura', inputmode: 'decimal', value: '100,00', autofocus: true })),
      el('button', { class: 'btn primario grande' }, icone('caixa'), 'Abrir o caixa'))));
  }

  /* ---------- carrinho ---------- */
  async function garantirVenda() {
    if (!venda) venda = await api.post('/pdv/venda', {});
    return venda;
  }

  async function adicionar(produto_id, quantidade = 1) {
    await garantirVenda();
    venda = await api.post(`/pdv/vendas/${venda.id}/itens`, { produto_id, quantidade });
    desenhar();
    $('#leitor').value = '';
    $('#leitor').focus();
    return venda;
  }

  /** Produto pesável: o operador digita o peso (ou o valor em reais) antes de entrar no carrinho. */
  const pedirPeso = (produto) => modal(`${produto.nome}`, (fechar) => {
    const peso = el('input', { inputmode: 'decimal', placeholder: '0,350', autofocus: true });
    const valor = el('input', { inputmode: 'decimal', placeholder: '0,00' });
    const sincronizar = (origem) => {
      if (origem === 'peso') valor.value = emReais(Math.round((paraCentavos(peso.value) / 100) * produto.preco_centavos / 10) * 10 / 10);
      else peso.value = (paraCentavos(valor.value) / produto.preco_centavos).toFixed(3).replace('.', ',');
    };
    peso.addEventListener('input', () => sincronizar('peso'));
    valor.addEventListener('input', () => sincronizar('valor'));
    return el('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); fechar(peso.value); } },
      el('p', { class: 'mudo' }, `${dinheiro(produto.preco_centavos)} por ${produto.unidade}`),
      el('div', { class: 'duas' },
        el('label', { class: 'campo' }, `Peso (${produto.unidade})`, peso),
        el('label', { class: 'campo' }, 'Ou o valor (R$)', valor)),
      el('div', { class: 'linha fim' },
        el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
        el('button', { class: 'btn primario' }, 'Adicionar')));
  });

  async function escolher(produto) {
    if (produto.pesavel) {
      const peso = await pedirPeso(produto);
      if (!peso) return;
      return adicionar(produto.id, peso);
    }
    return adicionar(produto.id, 1);
  }

  /** Esconde a lista de sugestões (ela só aparece quando há algo para mostrar). */
  function fecharSugestoes() {
    const caixaSugestoes = $('#sugestoes');
    if (caixaSugestoes) { limpar(caixaSugestoes); caixaSugestoes.classList.add('oculto'); }
  }

  /** Busca enquanto o operador digita; código bipado entra direto no carrinho. */
  async function buscar(termo) {
    const caixaSugestoes = $('#sugestoes');
    if (!termo || termo.length < 2) return fecharSugestoes();
    const achados = await api.get(`/produtos/busca?termo=${encodeURIComponent(termo)}`);
    caixaSugestoes.classList.remove('oculto');
    limpar(caixaSugestoes, achados.length
      ? achados.map((p) => el('button', { type: 'button', onclick: () => { fecharSugestoes(); escolher(p); } },
        el('span', { class: 'crescer' }, el('div', { class: 'destaque' }, p.nome),
          el('div', { class: 'pequeno mudo' }, `${p.codigo_barras ?? 'sem código'} · saldo ${qtd(p.estoque_mil, p.unidade)}`)),
        el('strong', {}, dinheiro(p.preco_centavos))))
      : el('div', { class: 'vazio pequeno' }, 'Nenhum produto encontrado.'));
    return achados;
  }

  async function aoEnviarLeitor(e) {
    e.preventDefault();
    const termo = $('#leitor').value.trim();
    if (!termo) return;
    const achados = await api.get(`/produtos/busca?termo=${encodeURIComponent(termo)}`);
    if (!achados.length) return toast('Produto não encontrado.', 'erro');
    if (achados.length === 1) { fecharSugestoes(); return escolher(achados[0]); }
    return buscar(termo);
  }

  const alterarQuantidade = (item) => modal(item.descricao, (fechar) => {
    const campo = el('input', { inputmode: 'decimal', value: qtd(item.qtd_mil), autofocus: true });
    return el('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); fechar(campo.value); } },
      el('label', { class: 'campo' }, `Quantidade (${item.unidade})`, campo),
      el('div', { class: 'linha fim' },
        el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
        el('button', { class: 'btn primario' }, 'Alterar')));
  });

  async function desconto() {
    const atual = emReais(venda.desconto_centavos);
    const valor = await modal('Desconto na venda', (fechar) => {
      const campo = el('input', { inputmode: 'decimal', value: atual, autofocus: true });
      return el('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); fechar(campo.value); } },
        el('p', { class: 'mudo' }, `Subtotal de ${dinheiro(venda.subtotal_centavos)}.`),
        el('label', { class: 'campo' }, 'Desconto (R$)', campo),
        el('div', { class: 'linha fim' },
          el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
          el('button', { class: 'btn primario' }, 'Aplicar')));
    });
    if (valor === null) return;
    venda = await api.patch(`/pdv/vendas/${venda.id}`, { desconto: valor || '0' });
    desenhar();
  }

  async function escolherMorador() {
    const escolhido = await modal('Lançar na conta de quem?', (fechar) => {
      const lista = el('div', { class: 'coluna', style: 'max-height: 50vh; overflow-y: auto' });
      const carregar = async (busca = '') => {
        const moradores = await api.get(`/moradores?busca=${encodeURIComponent(busca)}`);
        limpar(lista, moradores.length ? moradores.map((m) => el('button', {
          type: 'button', class: 'btn fantasma', style: 'justify-content: space-between; width: 100%',
          onclick: () => fechar(m),
        }, el('span', {}, `${m.nome} · ${m.bloco}/${m.unidade}`),
        el('span', { class: 'pequeno mudo' }, `disponível ${dinheiro(m.disponivel_centavos)}`))) : el('div', { class: 'vazio' }, 'Nenhum morador encontrado.'));
      };
      carregar();
      return [
        el('input', { placeholder: 'Buscar por nome, bloco ou apartamento', autofocus: true, oninput: (e) => carregar(e.target.value) }),
        lista,
        el('div', { class: 'linha fim' },
          el('button', { class: 'btn fantasma', onclick: () => fechar({ id: null }) }, 'Sem morador'),
          el('button', { class: 'btn', onclick: () => fechar() }, 'Voltar')),
      ];
    });
    if (escolhido === null) return;
    venda = await api.patch(`/pdv/vendas/${venda.id}`, { morador_id: escolhido.id });
    desenhar();
  }

  async function cancelarVenda() {
    if (!venda) return;
    const motivo = await modal('Cancelar a venda', (fechar) => {
      const campo = el('input', { placeholder: 'Ex.: cliente desistiu', autofocus: true });
      return el('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); fechar(campo.value.trim() || 'Cancelada no caixa'); } },
        el('p', { class: 'mudo' }, 'A venda sai do caixa e os itens voltam para o estoque.'),
        el('label', { class: 'campo' }, 'Motivo', campo),
        el('div', { class: 'linha fim' },
          el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
          el('button', { class: 'btn perigo' }, 'Cancelar a venda')));
    });
    if (!motivo) return;
    await api.post(`/pdv/vendas/${venda.id}/cancelar`, { motivo });
    venda = null;
    toast('Venda cancelada.');
    desenhar();
  }

  /* ---------- recebimento ---------- */
  async function receber() {
    if (!venda?.itens.length) return toast('Adicione itens antes de receber.', 'erro');
    const pagamentos = [];
    const concluida = await modal(`Receber ${dinheiro(venda.total_centavos)}`, (fechar) => {
      let forma = 'dinheiro';
      const painel = el('div', { class: 'coluna' });
      const listaPagamentos = el('div', { class: 'coluna' });
      const falta = () => venda.total_centavos - pagamentos.reduce((s, p) => s + p.valor_centavos, 0);

      const botaoFinalizar = el('button', { class: 'btn primario grande', onclick: async (e) => {
        await acao(e.target, async () => {
          const paga = await api.post(`/pdv/vendas/${venda.id}/finalizar`, {
            pagamentos: pagamentos.map((p) => ({ forma: p.forma, valor: emReais(p.valor_centavos), recebido: p.recebido_centavos ? emReais(p.recebido_centavos) : undefined, transacao_id: p.transacao_id })),
          });
          fechar(paga);
        });
      } }, 'Finalizar venda');

      const atualizar = () => {
        const restante = falta();
        botaoFinalizar.disabled = restante !== 0;
        botaoFinalizar.textContent = restante === 0 ? 'Finalizar venda' : `Falta ${dinheiro(restante)}`;
        limpar(listaPagamentos, pagamentos.map((p, i) => el('div', { class: 'linha entre' },
          el('span', {}, etiqueta(FORMAS[p.forma], 'ok'), p.troco_centavos ? el('span', { class: 'pequeno mudo' }, ` troco ${dinheiro(p.troco_centavos)}`) : null),
          el('span', { class: 'linha' }, el('strong', { class: 'num' }, dinheiro(p.valor_centavos)),
            el('button', { class: 'btn icone fantasma', title: 'Remover', onclick: () => { pagamentos.splice(i, 1); atualizar(); montar(); } }, icone('x'))))));
        montar();
      };

      const adicionarPagamento = (p) => { pagamentos.push(p); atualizar(); };

      function montar() {
        const restante = Math.max(0, falta());
        const campoValor = el('input', { inputmode: 'decimal', value: emReais(restante) });
        let conteudo;

        if (forma === 'dinheiro') {
          const recebido = el('input', { inputmode: 'decimal', value: emReais(restante), autofocus: true });
          const troco = el('div', { class: 'indicador', style: 'padding: 10px 0' }, el('span', { class: 'rotulo' }, 'Troco'), el('span', { class: 'valor' }, dinheiro(0)));
          const calcular = () => {
            const t = paraCentavos(recebido.value) - paraCentavos(campoValor.value);
            troco.querySelector('.valor').textContent = dinheiro(Math.max(0, t));
          };
          recebido.addEventListener('input', calcular);
          campoValor.addEventListener('input', calcular);
          calcular();
          const atalho = (centavos) => el('button', { class: 'btn pequeno', type: 'button', onclick: () => { recebido.value = emReais(centavos); calcular(); } }, dinheiro(centavos));
          conteudo = el('div', { class: 'coluna' },
            el('div', { class: 'duas' },
              el('label', { class: 'campo' }, 'Valor do pagamento', campoValor),
              el('label', { class: 'campo' }, 'Dinheiro recebido', recebido)),
            el('div', { class: 'linha' }, [restante, 2000, 5000, 10000, 20000].filter((v, i, a) => v > 0 && a.indexOf(v) === i).map(atalho)),
            troco,
            el('button', { class: 'btn azul', type: 'button', onclick: () => {
              const valor = paraCentavos(campoValor.value);
              const rec = paraCentavos(recebido.value);
              if (valor <= 0) return toast('Informe o valor.', 'erro');
              if (rec < valor) return toast('O dinheiro recebido é menor que o valor.', 'erro');
              adicionarPagamento({ forma, valor_centavos: valor, recebido_centavos: rec, troco_centavos: rec - valor });
            } }, 'Lançar dinheiro'));
        }

        if (forma === 'pix') {
          const area = el('div', { class: 'coluna' });
          conteudo = el('div', { class: 'coluna' },
            el('label', { class: 'campo' }, 'Valor do pagamento', campoValor),
            el('button', { class: 'btn azul', type: 'button', onclick: async (e) => {
              await acao(e.target, async () => {
                const r = await api.post(`/pdv/vendas/${venda.id}/pix`, { valor: campoValor.value });
                limpar(area,
                  el('img', { src: r.qrcode, alt: 'QR Code do PIX', style: 'width: 220px; height: 220px; border-radius: 14px; align-self: center; background: #fff; padding: 8px' }),
                  el('textarea', { readonly: true, onclick: (ev) => ev.target.select() }, r.copia_e_cola),
                  el('button', { class: 'btn primario', type: 'button', onclick: () => adicionarPagamento({ forma: 'pix', valor_centavos: r.valor_centavos }) }, icone('check'), 'Recebi o PIX'));
              });
            } }, icone('pix'), 'Gerar QR Code'),
            area);
        }

        if (forma === 'debito' || forma === 'credito') {
          const seletor = el('select', { name: 'maquininha' }, maquininhas.map((m) => el('option', { value: m.id }, `${m.nome} (${m.provedor})`)));
          const parcelas = el('select', { name: 'parcelas' }, Array.from({ length: 12 }, (_, i) => el('option', { value: i + 1 }, i === 0 ? 'À vista' : `${i + 1}x`)));
          const estado = el('div', { class: 'coluna' });
          conteudo = el('div', { class: 'coluna' },
            el('label', { class: 'campo' }, 'Valor do pagamento', campoValor),
            el('div', { class: 'duas' },
              el('label', { class: 'campo' }, 'Maquininha', seletor),
              forma === 'credito' ? el('label', { class: 'campo' }, 'Parcelas', parcelas) : null),
            maquininhas.length ? el('button', { class: 'btn azul', type: 'button', onclick: (e) => cobrarNoCartao(e.target, forma, seletor.value, forma === 'credito' ? Number(parcelas.value) : 1, campoValor.value, estado, adicionarPagamento) }, icone('cartao'), 'Cobrar na maquininha')
              : el('p', { class: 'etiqueta aviso' }, 'Nenhuma maquininha cadastrada nas configurações.'),
            estado);
        }

        if (forma === 'fiado') {
          conteudo = el('div', { class: 'coluna' },
            venda.morador_id
              ? el('p', { class: 'mudo' }, `Vai para a conta de ${venda.morador} (${venda.bloco}/${venda.unidade}), com acerto na fatura do mês.`)
              : el('p', { class: 'etiqueta aviso' }, 'Escolha o morador antes de lançar na conta.'),
            el('label', { class: 'campo' }, 'Valor do pagamento', campoValor),
            el('button', { class: 'btn azul', type: 'button', disabled: !venda.morador_id, onclick: () => {
              const valor = paraCentavos(campoValor.value);
              if (valor <= 0) return toast('Informe o valor.', 'erro');
              adicionarPagamento({ forma: 'fiado', valor_centavos: valor });
            } }, 'Lançar na conta'));
        }

        limpar(painel,
          el('div', { class: 'formas' }, Object.entries(ATALHOS).map(([chave, rotulo]) => el('button', {
            type: 'button', class: `forma${forma === chave ? ' ativa' : ''}`,
            onclick: () => { forma = chave; montar(); },
          }, icone(chave === 'dinheiro' ? 'dinheiro' : chave === 'pix' ? 'pix' : chave === 'fiado' ? 'moradores' : 'cartao'), rotulo))),
          conteudo);
      }

      atualizar();
      return [
        el('div', { class: 'linha entre' },
          el('div', {}, el('div', { class: 'mudo pequeno' }, `Venda #${venda.id} · ${venda.itens.length} item(ns)`),
            el('div', { class: 'total' }, dinheiro(venda.total_centavos))),
          venda.desconto_centavos ? etiqueta(`desconto ${dinheiro(venda.desconto_centavos)}`, 'info') : null),
        listaPagamentos,
        painel,
        el('div', { class: 'linha fim', style: 'margin-top: 8px' },
          el('button', { class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
          botaoFinalizar),
      ];
    }, { largo: true });

    if (!concluida) return;
    venda = null;
    toast(`Venda #${concluida.id} finalizada.`);
    desenhar();
    mostrarCupom(concluida.id);
  }

  /** Conversa com a maquininha: envia a cobrança e fica consultando até aprovar, negar ou o operador desistir. */
  async function cobrarNoCartao(botao, forma, maquininha_id, parcelas, valor, area, aoAprovar) {
    await acao(botao, async () => {
      limpar(area, el('div', { class: 'linha' }, el('div', { class: 'girando' }), el('span', { class: 'mudo' }, 'Enviando para a maquininha…')));
      let t = await api.post(`/pdv/vendas/${venda.id}/cartao`, { maquininha_id, forma, parcelas, valor });
      const mostrar = (texto, tom) => limpar(area, el('p', { class: `etiqueta ${tom}` }, texto));
      let tentativas = 0;
      while (t.status === 'pendente' && tentativas < 60) {
        limpar(area,
          el('div', { class: 'linha' }, el('div', { class: 'girando' }), el('span', { class: 'mudo' }, 'Peça o cartão ao cliente e aguarde a maquininha…')),
          el('button', { class: 'btn pequeno perigo', type: 'button', onclick: async () => { await api.post(`/pdv/cartao/${t.id}/cancelar`, {}); tentativas = 999; } }, 'Cancelar cobrança'));
        await new Promise((r) => setTimeout(r, 2000));
        t = await api.get(`/pdv/cartao/${t.id}`);
        tentativas++;
      }
      if (t.status === 'aprovada') {
        mostrar(`Aprovada · ${t.bandeira ?? 'cartão'} · NSU ${t.nsu ?? '—'}`, 'ok');
        aoAprovar({ forma, valor_centavos: t.valor_centavos, transacao_id: t.id });
        return;
      }
      mostrar(`Cobrança ${t.status}. ${t.mensagem ?? ''}`.trim(), 'erro');
    });
  }

  async function mostrarCupom(id) {
    const c = await api.get(`/pdv/vendas/${id}/cupom`);
    const linha = (esq, dir) => `${esq}${' '.repeat(Math.max(1, 38 - esq.length - dir.length))}${dir}`;
    const texto = [
      c.mercado.nome.toUpperCase(),
      c.mercado.condominio, c.mercado.endereco, c.mercado.cnpj ? `CNPJ ${c.mercado.cnpj}` : '',
      '-'.repeat(38),
      `VENDA #${c.venda.id}`, dataHora(c.venda.fechada_em), c.venda.morador ? `Morador: ${c.venda.morador} (${c.venda.bloco}/${c.venda.unidade})` : '',
      '-'.repeat(38),
      ...c.venda.itens.map((i) => `${i.descricao}\n  ${qtd(i.qtd_mil, i.unidade)} x ${dinheiro(i.preco_centavos)}${linha('', dinheiro(i.total_centavos))}`),
      '-'.repeat(38),
      linha('SUBTOTAL', dinheiro(c.venda.subtotal_centavos)),
      c.venda.desconto_centavos ? linha('DESCONTO', `-${dinheiro(c.venda.desconto_centavos)}`) : '',
      linha('TOTAL', dinheiro(c.venda.total_centavos)),
      '',
      ...c.venda.pagamentos.map((p) => linha(FORMAS[p.forma], dinheiro(p.valor_centavos)) + (p.troco_centavos ? `\n${linha('TROCO', dinheiro(p.troco_centavos))}` : '')),
      '-'.repeat(38),
      c.observacao, 'Obrigado pela preferência!',
    ].filter(Boolean).join('\n');

    await modal('Cupom da venda', (fechar) => [
      el('pre', { class: 'cupom' }, texto),
      el('div', { class: 'linha fim' },
        el('button', { class: 'btn fantasma', onclick: () => fechar() }, 'Fechar'),
        el('button', { class: 'btn', onclick: () => window.print() }, icone('impressora'), 'Imprimir')),
    ]);
  }

  /* ---------- tela ---------- */
  function desenhar() {
    if (!caixa) return telaSemCaixa();
    definirTitulo('PDV', `Caixa #${caixa.caixa.id} · ${usuario.nome} · F2 recebe, F3 busca, F8 cancela`);
    const itens = venda?.itens ?? [];

    limpar(alvo, el('div', { class: 'pdv' },
      el('section', { class: 'coluna' },
        el('div', { class: 'cartao' },
          el('form', { class: 'leitor', style: 'position: relative', onsubmit: aoEnviarLeitor },
            icone('busca'),
            el('input', {
              id: 'leitor', autocomplete: 'off', autofocus: true,
              placeholder: 'Bipe o código de barras ou digite o nome do produto',
              oninput: (e) => buscar(e.target.value.trim()),
            }),
            el('div', { class: 'sugestoes cartao oculto', id: 'sugestoes' }))),

        el('div', { class: 'cartao' },
          el('div', { class: 'linha entre' },
            el('h2', {}, 'Carrinho'),
            el('span', { class: 'mudo pequeno' }, venda ? `Venda #${venda.id}` : 'Nenhuma venda aberta')),
          el('div', { class: 'itens' }, itens.length
            ? el('table', {}, el('tbody', {}, itens.map((i) => el('tr', {},
              el('td', {}, el('div', { class: 'destaque' }, i.descricao),
                el('div', { class: 'pequeno mudo' }, `${qtd(i.qtd_mil, i.unidade)} × ${dinheiro(i.preco_centavos)}`)),
              el('td', { class: 'direita num destaque' }, dinheiro(i.total_centavos)),
              el('td', { class: 'direita', style: 'width: 92px' },
                el('button', { class: 'btn icone fantasma', title: 'Alterar quantidade', onclick: async () => {
                  const nova = await alterarQuantidade(i);
                  if (!nova) return;
                  venda = await api.patch(`/pdv/vendas/${venda.id}/itens/${i.id}`, { quantidade: nova });
                  desenhar();
                } }, icone('editar')),
                el('button', { class: 'btn icone fantasma', title: 'Remover', onclick: async () => {
                  venda = await api.delete(`/pdv/vendas/${venda.id}/itens/${i.id}`);
                  desenhar();
                } }, icone('lixeira')))))))
            : el('div', { class: 'vazio' }, el('span', { class: 'icone' }, '🛒'), 'Bipe o primeiro produto para começar.')))),

      el('aside', { class: 'coluna' },
        el('div', { class: 'cartao' },
          el('div', { class: 'total' }, dinheiro(venda?.total_centavos ?? 0), el('small', {}, `${itens.length} item(ns) no carrinho`)),
          venda?.desconto_centavos ? el('p', { class: 'pequeno' }, etiqueta(`desconto de ${dinheiro(venda.desconto_centavos)}`, 'info')) : null,
          el('div', { class: 'coluna', style: 'margin-top: 14px' },
            el('button', { class: 'btn primario grande', disabled: !itens.length, onclick: receber }, icone('dinheiro'), 'Receber (F2)'),
            el('div', { class: 'linha' },
              el('button', { class: 'btn crescer', disabled: !venda, onclick: desconto }, 'Desconto'),
              el('button', { class: 'btn crescer', disabled: !venda, onclick: escolherMorador }, icone('moradores'), venda?.morador ? 'Trocar morador' : 'Morador')),
            el('button', { class: 'btn perigo fantasma', disabled: !venda, onclick: cancelarVenda }, 'Cancelar venda (F8)'))),

        venda?.morador ? el('div', { class: 'cartao' },
          el('h3', {}, 'Comprando na conta'),
          el('div', { class: 'destaque' }, venda.morador),
          el('div', { class: 'mudo pequeno' }, `Bloco ${venda.bloco} · unidade ${venda.unidade}`)) : null,

        el('div', { class: 'cartao' },
          el('div', { class: 'linha entre' }, el('h3', {}, 'Caixa'), etiqueta('aberto', 'ok')),
          el('div', { class: 'linha entre pequeno' }, el('span', { class: 'mudo' }, 'Vendas'), el('strong', {}, `${caixa.vendas} · ${dinheiro(caixa.total_centavos)}`)),
          el('div', { class: 'linha entre pequeno' }, el('span', { class: 'mudo' }, 'Dinheiro na gaveta'), el('strong', { class: 'num' }, dinheiro(caixa.dinheiro_esperado_centavos))),
          el('a', { class: 'btn pequeno', href: '#/caixa', style: 'margin-top: 10px' }, 'Sangria, suprimento e fechamento')))));

    fecharSugestoes();
    $('#leitor').focus();
  }

  if (!caixa) telaSemCaixa();
  else {
    caixa = await api.get('/caixa/atual');
    desenhar();
  }
  return () => document.removeEventListener('keydown', aoTeclar);
}
