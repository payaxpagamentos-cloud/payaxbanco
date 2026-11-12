import { api } from '../api.js';
import { el, limpar, dinheiro, emReais, dataHora, icone, indicador, tabela, modal, toast, acao, etiqueta, lerForm, FORMAS, dataBr } from '../ui.js';

/** Abertura, conferência, sangria, suprimento e fechamento do caixa. */
export default async function caixa({ alvo, usuario, definirTitulo }) {
  async function desenhar() {
    const atual = await api.get('/caixa/atual');
    const historico = await api.get('/caixa/historico');
    const abertos = ['admin', 'gerente'].includes(usuario.perfil) ? await api.get('/caixa/abertos') : [];
    definirTitulo('Caixa', atual ? `Aberto desde ${dataHora(atual.caixa.aberto_em)}` : 'Nenhum caixa aberto no seu usuário');

    limpar(alvo,
      atual ? blocoAberto(atual) : blocoFechado(),
      abertos.length > 1 ? el('section', { class: 'cartao' },
        el('h2', {}, 'Outros caixas abertos agora'),
        tabela([
          { titulo: 'Caixa', celula: (c) => `#${c.caixa.id}` },
          { titulo: 'Operador', celula: (c) => c.caixa.operador },
          { titulo: 'Aberto em', celula: (c) => dataHora(c.caixa.aberto_em) },
          { titulo: 'Vendas', direita: true, celula: (c) => c.vendas },
          { titulo: 'Dinheiro', direita: true, celula: (c) => dinheiro(c.dinheiro_esperado_centavos) },
        ], abertos.filter((c) => c.caixa.id !== atual?.caixa.id))) : null,
      el('section', { class: 'cartao' },
        el('h2', {}, 'Caixas anteriores'),
        tabela([
          { titulo: 'Caixa', celula: (c) => `#${c.id}` },
          { titulo: 'Operador', celula: (c) => c.operador ?? '—' },
          { titulo: 'Abertura', celula: (c) => dataHora(c.aberto_em) },
          { titulo: 'Fechamento', celula: (c) => dataHora(c.fechado_em) },
          { titulo: 'Vendas', direita: true, celula: (c) => `${c.vendas} · ${dinheiro(c.total_centavos)}` },
          { titulo: 'Diferença', direita: true, celula: (c) => (c.status === 'aberto' ? etiqueta('aberto', 'ok')
            : el('span', { class: c.diferenca_centavos === 0 ? '' : c.diferenca_centavos > 0 ? 'positivo' : 'negativo' }, dinheiro(c.diferenca_centavos))) },
        ], historico, { aoClicar: (c) => detalhe(c.id), vazio: 'Nenhum caixa fechado ainda.' })));
  }

  const blocoFechado = () => el('section', { class: 'cartao', style: 'max-width: 520px' },
    el('h2', {}, 'Abrir o caixa'),
    el('p', { class: 'mudo' }, 'Conte o dinheiro do troco e informe o valor: ele entra como abertura e é cobrado na conferência do fechamento.'),
    el('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      await acao(e.target.querySelector('button'), async () => {
        await api.post('/caixa/abrir', lerForm(e.target));
        toast('Caixa aberto.');
        desenhar();
      });
    } },
    el('label', { class: 'campo' }, 'Troco inicial (R$)', el('input', { name: 'abertura', inputmode: 'decimal', value: '100,00', autofocus: true })),
    el('label', { class: 'campo' }, 'Observação', el('input', { name: 'observacao', placeholder: 'opcional' })),
    el('button', { class: 'btn primario grande' }, icone('caixa'), 'Abrir o caixa')));

  function blocoAberto(c) {
    return el('div', { class: 'coluna' },
      el('div', { class: 'grade' },
        indicador({ simbolo: 'dinheiro', rotulo: 'Dinheiro na gaveta', valor: dinheiro(c.dinheiro_esperado_centavos), nota: `abertura ${dinheiro(c.caixa.abertura_centavos)}` }),
        indicador({ simbolo: 'pdv', cor: 'azul', rotulo: 'Vendas', valor: dinheiro(c.total_centavos), nota: `${c.vendas} venda(s) · ticket ${dinheiro(c.ticket_medio_centavos)}` }),
        indicador({ simbolo: 'financeiro', rotulo: 'Lucro bruto', valor: dinheiro(c.lucro_centavos), tom: 'verde', nota: `custo ${dinheiro(c.custo_centavos)}` }),
        indicador({ simbolo: 'baixar', cor: 'ambar', rotulo: 'Sangrias', valor: dinheiro(c.sangrias_centavos), nota: `suprimentos ${dinheiro(c.suprimentos_centavos)}` })),

      el('div', { class: 'grade', style: 'grid-template-columns: repeat(auto-fit, minmax(320px, 1fr))' },
        el('section', { class: 'cartao' },
          el('h2', {}, 'Recebido por forma'),
          el('div', { class: 'coluna' }, Object.entries(FORMAS).map(([chave, rotulo]) => el('div', { class: 'linha entre' },
            el('span', { class: 'mudo' }, rotulo), el('strong', { class: 'num' }, dinheiro(c.por_forma[chave] ?? 0))))),
          c.trocos_centavos ? el('p', { class: 'pequeno mudo' }, `Trocos devolvidos: ${dinheiro(c.trocos_centavos)}`) : null),

        el('section', { class: 'cartao' },
          el('h2', {}, 'Movimentos do caixa'),
          el('div', { class: 'linha' },
            el('button', { class: 'btn pequeno', onclick: () => movimentar(c.caixa.id, 'suprimento') }, icone('mais'), 'Suprimento'),
            el('button', { class: 'btn pequeno', onclick: () => movimentar(c.caixa.id, 'sangria') }, icone('baixar'), 'Sangria')),
          tabela([
            { titulo: 'Hora', celula: (m) => dataHora(m.criado_em) },
            { titulo: 'Tipo', celula: (m) => etiqueta(m.tipo === 'sangria' ? 'Sangria' : 'Suprimento', m.tipo === 'sangria' ? 'aviso' : 'ok') },
            { titulo: 'Motivo', celula: (m) => m.motivo },
            { titulo: 'Valor', direita: true, celula: (m) => dinheiro(m.valor_centavos) },
          ], c.movimentos, { vazio: 'Nenhuma sangria ou suprimento.' }))),

      el('section', { class: 'cartao' },
        el('h2', {}, 'Fechar o caixa'),
        el('p', { class: 'mudo' }, 'Conte o dinheiro da gaveta e informe o total. O sistema compara com o esperado e registra a diferença.'),
        el('button', { class: 'btn primario', onclick: () => fechar(c) }, icone('check'), 'Conferir e fechar')));
  }

  const movimentar = (id, tipo) => modal(tipo === 'sangria' ? 'Sangria (retirada)' : 'Suprimento (entrada de troco)', (fechar) => el('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      await acao(e.target.querySelector('button[type=submit]'), async () => {
        await api.post(`/caixa/${id}/movimento`, { tipo, ...lerForm(e.target) });
        toast('Movimento registrado.');
        fechar();
        desenhar();
      });
    },
  },
  el('label', { class: 'campo' }, 'Valor (R$)', el('input', { name: 'valor', inputmode: 'decimal', required: true, autofocus: true })),
  el('label', { class: 'campo' }, 'Motivo', el('input', { name: 'motivo', required: true, placeholder: tipo === 'sangria' ? 'Ex.: retirada para o cofre' : 'Ex.: troco trazido da administração' })),
  el('div', { class: 'linha fim' },
    el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
    el('button', { type: 'submit', class: 'btn primario' }, 'Confirmar'))));

  const fechar = (c) => modal('Fechamento do caixa', (fecharModal) => {
    const campo = el('input', { name: 'informado', inputmode: 'decimal', value: emReais(c.dinheiro_esperado_centavos), autofocus: true });
    const diferenca = el('div', { class: 'indicador', style: 'padding: 8px 0' }, el('span', { class: 'rotulo' }, 'Diferença'), el('span', { class: 'valor' }, dinheiro(0)));
    const calcular = () => {
      const d = Math.round(Number(String(campo.value).replace(/\./g, '').replace(',', '.')) * 100) - c.dinheiro_esperado_centavos;
      const valor = diferenca.querySelector('.valor');
      valor.textContent = dinheiro(d);
      valor.className = `valor ${d === 0 ? '' : d > 0 ? 'verde' : 'vermelho'}`;
    };
    campo.addEventListener('input', calcular);
    calcular();
    return el('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      await acao(e.target.querySelector('button[type=submit]'), async () => {
        const r = await api.post(`/caixa/${c.caixa.id}/fechar`, lerForm(e.target));
        fecharModal();
        toast('Caixa fechado.');
        desenhar();
        detalhe(r.caixa.id);
      });
    } },
    el('div', { class: 'linha entre' }, el('span', { class: 'mudo' }, 'Esperado em dinheiro'), el('strong', { class: 'num' }, dinheiro(c.dinheiro_esperado_centavos))),
    el('label', { class: 'campo' }, 'Dinheiro contado (R$)', campo),
    diferenca,
    el('label', { class: 'campo' }, 'Observação', el('input', { name: 'observacao', placeholder: 'opcional' })),
    el('div', { class: 'linha fim' },
      el('button', { type: 'button', class: 'btn fantasma', onclick: () => fecharModal() }, 'Voltar'),
      el('button', { type: 'submit', class: 'btn primario' }, 'Fechar o caixa')));
  });

  async function detalhe(id) {
    const c = await api.get(`/caixa/${id}`);
    await modal(`Caixa #${c.caixa.id}`, () => [
      el('div', { class: 'grade' },
        indicador({ rotulo: 'Vendas', valor: dinheiro(c.total_centavos), nota: `${c.vendas} venda(s)` }),
        indicador({ rotulo: 'Esperado', valor: dinheiro(c.caixa.esperado_centavos ?? c.dinheiro_esperado_centavos) }),
        indicador({
          rotulo: 'Diferença', valor: dinheiro(c.caixa.diferenca_centavos ?? 0),
          tom: (c.caixa.diferenca_centavos ?? 0) === 0 ? null : c.caixa.diferenca_centavos > 0 ? 'verde' : 'vermelho',
        })),
      el('p', { class: 'mudo pequeno' }, `Operador ${c.caixa.operador ?? '—'} · abertura ${dataHora(c.caixa.aberto_em)} · fechamento ${dataHora(c.caixa.fechado_em)}`),
      el('h3', {}, 'Por forma de pagamento'),
      el('div', { class: 'coluna' }, Object.entries(FORMAS).map(([chave, rotulo]) => el('div', { class: 'linha entre' },
        el('span', { class: 'mudo' }, rotulo), el('strong', { class: 'num' }, dinheiro(c.por_forma[chave] ?? 0))))),
      c.caixa.observacao ? el('p', { class: 'pequeno mudo' }, c.caixa.observacao) : null,
    ], { largo: true });
  }

  await desenhar();
}
