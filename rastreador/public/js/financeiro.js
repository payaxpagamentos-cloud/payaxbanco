/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/
/**
 * Financeiro da Gestão de Frota: resumo com o fluxo de caixa, contas a pagar, contas a receber, contas e caixas (com
 * transferências), resultado por categoria e o cadastro de categorias.
 */
import { api, qs } from './api.js';
import { el, limpar, dinheiro, inteiro, data, placa, toast, modal, formModal, confirmar, campo, area, marcar, escolha, etiqueta,
  reaisCampo, centavos, hojeLocal, somarDias, icone } from './ui.js';
import { cartao, indicador, tabela, td, botao, botaoIcone, acoesTopo } from './comum.js';

const base = (ctx) => `/empresas/${ctx.empresaId}/gestao/financeiro`;
const pode = (ctx) => !ctx.somenteLeitura;
const ir = (ctx, tela) => { location.hash = `#/empresa/${ctx.empresaId}/${tela}`; };
const SITUACAO = { aberto: ['em aberto', 'info'], hoje: ['vence hoje', 'aviso'], vencido: ['vencida', 'erro'], pago: ['paga', 'ok'], cancelado: ['cancelada', ''] };
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const nomeMes = (m) => `${MESES[Number(m.slice(5, 7)) - 1]}/${m.slice(2, 4)}`;
/** Texto de cada lado: o que muda entre pagar e receber. */
const LADO = {
  pagar: { titulo: 'Contas a pagar', nova: 'Nova conta a pagar', pessoa: 'Fornecedor / favorecido', feito: 'paga', baixar: 'Pagar', baixa: 'Registrar pagamento', quando: 'Pago em', valorFeito: 'Valor pago', pagas: 'Pagas', tela: 'fin-pagar' },
  receber: { titulo: 'Contas a receber', nova: 'Nova conta a receber', pessoa: 'Cliente / pagador', feito: 'recebida', baixar: 'Receber', baixa: 'Registrar recebimento', quando: 'Recebido em', valorFeito: 'Valor recebido', pagas: 'Recebidas', tela: 'fin-receber' },
};
const rotuloSituacao = (l) => (l.situacao === 'pago' ? [LADO[l.tipo].feito, 'ok'] : SITUACAO[l.situacao]);
const valorCor = (c) => el('span', { class: c < 0 ? 'texto-erro' : '' }, dinheiro(c));

const semModulo = (ctx, err) => limpar(ctx.conteudo, cartao('Financeiro', el('p', { class: 'mudo' }, err.message)));
async function tela(ctx, fn) {
  try { await fn(); } catch (err) { if (err.status === 403) semModulo(ctx, err); else throw err; }
}
const veiculosDa = async (ctx) => (await api.get(`/empresas/${ctx.empresaId}/gestao/veiculos`)).filter((x) => x.ativo);
const nomeVeiculo = (x) => `${placa(x.placa)}${x.descricao ? ` · ${x.descricao}` : ''}`;

// ---------- Resumo e fluxo de caixa ----------
async function telaResumo(ctx) {
  await tela(ctx, async () => {
    const r = await api.get(`${base(ctx)}/resumo`);
    const linhaConta = (l) => el('tr', { class: 'clicavel', onclick: () => ir(ctx, LADO[l.tipo].tela) },
      td(data(l.vencimento), 'sem-quebra'), td(l.tipo === 'pagar' ? etiqueta('a pagar', 'erro') : etiqueta('a receber', 'ok')),
      td([l.descricao, el('div', { class: 'pequeno mudo' }, [l.pessoa ?? l.fornecedor, l.placa ? placa(l.placa) : null].filter(Boolean).join(' · '))]),
      td(dinheiro(l.valor_centavos), 'dir num'), td(etiqueta(...rotuloSituacao(l))));
    limpar(ctx.conteudo, el('div', { class: 'coluna', style: 'gap:18px' },
      el('div', { class: 'grade' },
        indicador('Saldo em contas', valorCor(r.saldo_centavos), `${inteiro(r.contas.length)} conta(s) e caixa(s)`, r.saldo_centavos < 0 ? 'erro' : '', 'carteira'),
        indicador('A receber', dinheiro(r.receber.aberto_centavos), r.receber.vencido_centavos ? `${dinheiro(r.receber.vencido_centavos)} em atraso` : `${dinheiro(r.receber.proximos7_centavos)} nos próximos 7 dias`, r.receber.vencido_centavos ? 'aviso' : 'ok', 'check'),
        indicador('A pagar', dinheiro(r.pagar.aberto_centavos), r.pagar.vencido_centavos ? `${dinheiro(r.pagar.vencido_centavos)} vencido` : `${dinheiro(r.pagar.proximos7_centavos)} nos próximos 7 dias`, r.pagar.vencido_centavos ? 'erro' : '', 'alertas'),
        indicador('Recebido no mês', dinheiro(r.mes.recebido_centavos), 'entradas com baixa', '', 'dashboard'),
        indicador('Pago no mês', dinheiro(r.mes.pago_centavos), 'saídas com baixa', '', 'relatorios'),
        indicador('Resultado do mês', valorCor(r.mes.resultado_centavos), 'recebido menos pago', r.mes.resultado_centavos < 0 ? 'erro' : 'ok', 'rota')),
      r.pendencias_frota && pode(ctx) ? el('p', { class: 'aviso', style: 'margin:0' },
        `A frota tem ${inteiro(r.pendencias_frota)} despesa(s) que ainda não estão no contas a pagar (ordens de serviço, documentos e multas). `,
        el('a', { href: `#/empresa/${ctx.empresaId}/fin-pagar` }, 'Trazer para o contas a pagar')) : null,
      cartao('Vencidas e próximos 15 dias', tabela(['Vencimento', 'Tipo', 'Conta', '>Valor', 'Situação'], r.proximos.map(linhaConta), 'Nada vencido nem a vencer nos próximos 15 dias.')),
      cartao('Fluxo de caixa por mês',
        tabela(['Mês', '>Recebido', '>Pago', '>A receber', '>A pagar', '>Saldo previsto'], r.meses.map((m) => el('tr', { class: m.mes === hojeLocal().slice(0, 7) ? 'linha-atual' : '' },
          td(el('strong', {}, nomeMes(m.mes))), td(dinheiro(m.recebido_centavos), 'dir num'), td(dinheiro(m.pago_centavos), 'dir num'),
          td(dinheiro(m.a_receber_centavos), 'dir num'), td(dinheiro(m.a_pagar_centavos), 'dir num'),
          td(m.saldo_previsto_centavos === null ? '—' : el('strong', {}, valorCor(m.saldo_previsto_centavos)), 'dir num'))), 'Sem movimento.'),
        el('p', { class: 'pequeno mudo', style: 'margin:10px 0 0' }, 'Recebido e pago: o que já teve baixa no mês. A receber e a pagar: o que vence no mês e ainda está em aberto (no mês atual, entra também o que está atrasado). Saldo previsto: o saldo de hoje mais o que vai entrar, menos o que vai sair.')),
      cartao('Contas e caixas', tabela(['Conta', 'Tipo', '>Saldo'], r.contas.map((c) => el('tr', {}, td(el('strong', {}, c.nome)), td(c.nome_tipo), td(valorCor(c.saldo_centavos), 'dir num'))), 'Nenhuma conta cadastrada.'))));
  });
}

// ---------- Contas a pagar e a receber (a mesma tela, dos dois lados) ----------
function telaContas(tipo) {
  const L = LADO[tipo];
  return async (ctx) => {
    await tela(ctx, async () => {
      const [cat, veiculos, fornecedores] = await Promise.all([api.get(`${base(ctx)}/catalogos`), veiculosDa(ctx),
        tipo === 'pagar' ? api.get(`/empresas/${ctx.empresaId}/gestao/fornecedores`) : []]);
      const categorias = cat.categorias.filter((c) => c.ativo && c.tipo === (tipo === 'pagar' ? 'despesa' : 'receita'));
      const contas = cat.contas.filter((c) => c.ativo);
      const hoje = hojeLocal();
      let status = 'aberto';
      const FILTROS = { aberto: 'Em aberto', vencido: 'Vencidas', pago: L.pagas, todos: 'Todas' };
      const chips = el('div', { class: 'chips' });
      const lista = el('div');
      const total = el('div');
      const opcoes = (l, vazio) => ({ '': vazio, ...Object.fromEntries(l.map((x) => [x.id, x.nome])) });

      const form = (l) => formModal(l ? `Editar · ${l.descricao}` : L.nova, (f) => {
        const modo = l ? null : escolha('Repetição', 'modo', { unica: 'Conta única', parcelado: 'Parcelado: divide o valor em parcelas mensais', recorrente: 'Todo mês: repete o mesmo valor' }, 'unica');
        const vezes = l ? null : campo('Quantas vezes', { name: 'parcelas', type: 'number', min: 2, max: 60, value: 2 });
        const ajustar = () => { if (!modo) return; const m = f.modo?.value ?? 'unica'; vezes.classList.toggle('oculto', m === 'unica'); vezes.firstChild.textContent = m === 'parcelado' ? 'Número de parcelas' : 'Por quantos meses'; };
        modo?.querySelector('select').addEventListener('change', ajustar);
        queueMicrotask(ajustar);
        return [
          campo('Descrição', { name: 'descricao', required: true, maxlength: 160, value: l?.descricao ?? '', placeholder: tipo === 'pagar' ? 'Ex.: Aluguel do galpão' : 'Ex.: Frete São Paulo – Campinas' }),
          el('div', { class: 'duas' },
            campo(l || !modo ? 'Valor (R$)' : 'Valor (R$): o total, se for parcelado', { name: 'valor', required: true, inputmode: 'decimal', maxlength: 14, value: l ? reaisCampo(l.valor_centavos) : '', placeholder: '0,00' }),
            campo(l ? 'Vencimento' : 'Vencimento (da primeira)', { name: 'vencimento', type: 'date', required: true, value: l?.vencimento ?? hoje })),
          modo ? el('div', { class: 'duas' }, modo, vezes) : null,
          el('div', { class: 'duas' },
            campo(L.pessoa, { name: 'pessoa', maxlength: 120, value: l?.pessoa ?? '' }),
            escolha('Categoria', 'categoria_id', opcoes(categorias, 'Sem categoria'), l?.categoria_id ?? '')),
          el('div', { class: 'duas' },
            escolha('Veículo (opcional)', 'veiculo_id', { '': 'Não é de um veículo', ...Object.fromEntries(veiculos.map((x) => [x.id, nomeVeiculo(x)])) }, l?.veiculo_id ?? ''),
            tipo === 'pagar' ? escolha('Fornecedor cadastrado (opcional)', 'fornecedor_id', opcoes(fornecedores.filter((x) => x.ativo !== 0), 'Nenhum'), l?.fornecedor_id ?? '')
              : campo('Nº da nota ou do documento', { name: 'documento', maxlength: 40, value: l?.documento ?? '' })),
          tipo === 'pagar' ? campo('Nº da nota ou do boleto', { name: 'documento', maxlength: 40, value: l?.documento ?? '' }) : null,
          area('Observação', { name: 'observacao', maxlength: 300, rows: 2 }, l?.observacao ?? ''),
        ];
      }, async (d) => {
        const corpo = { ...d, tipo, valor_centavos: centavos(d.valor) };
        delete corpo.valor;
        if (!corpo.valor_centavos || corpo.valor_centavos < 1) throw new Error('Informe o valor.');
        if (l) return api.put(`${base(ctx)}/lancamentos/${l.id}`, corpo);
        if ((corpo.modo ?? 'unica') === 'unica') delete corpo.parcelas;
        return api.post(`${base(ctx)}/lancamentos`, corpo);
      }, { largo: true });

      const baixar = (l) => {
        if (!contas.length) return toast('Cadastre uma conta ou caixa em "Contas e caixas" antes de registrar a baixa.', true);
        return formModal(`${L.baixa} · ${l.descricao}`, () => [
          el('p', { class: 'mudo', style: 'margin:0' }, `Vencimento ${data(l.vencimento)} · valor ${dinheiro(l.valor_centavos)}`),
          el('div', { class: 'duas' }, campo(L.quando, { name: 'data', type: 'date', required: true, max: hoje, value: hoje }),
            campo(`${L.valorFeito} (R$, com juros ou desconto)`, { name: 'valor', required: true, inputmode: 'decimal', maxlength: 14, value: reaisCampo(l.valor_centavos) })),
          el('div', { class: 'duas' }, escolha(tipo === 'pagar' ? 'Saiu de qual conta' : 'Entrou em qual conta', 'conta_id', Object.fromEntries(contas.map((c) => [c.id, `${c.nome} · saldo ${dinheiro(c.saldo_centavos)}`])), contas[0].id),
            escolha('Forma', 'forma', { '': 'Não informar', ...cat.formas }, '')),
        ], (d) => api.post(`${base(ctx)}/lancamentos/${l.id}/baixar`, { data: d.data, conta_id: d.conta_id, forma: d.forma, valor_pago_centavos: centavos(d.valor) }), { rotulo: L.baixa });
      };

      const trazerDaFrota = async () => {
        const pend = await api.get(`${base(ctx)}/frota`);
        if (!pend.length) return toast('A frota não tem despesa fora do contas a pagar.');
        const grupos = [...new Set(pend.map((x) => x.grupo))];
        const r = await formModal('Trazer despesas da frota', () => [
          el('p', { class: 'mudo', style: 'margin:0' }, 'Marque o que entra no contas a pagar. Cada item entra uma vez só; ao registrar o pagamento, o documento ou a multa também fica como pago na frota.'),
          grupos.map((g) => el('fieldset', {}, el('legend', {}, g), pend.filter((x) => x.grupo === g).map((x) =>
            marcar(`${x.placa ? `${placa(x.placa)} · ` : ''}${x.descricao} · ${dinheiro(x.valor_centavos)} · vence ${data(x.vencimento)}`, { name: `i:${x.origem}:${x.origem_id}`, checked: true })))),
        ], (d) => api.post(`${base(ctx)}/frota`, { itens: Object.entries(d).filter(([k, v]) => k.startsWith('i:') && v).map(([k]) => ({ origem: k.split(':')[1], origem_id: Number(k.split(':')[2]) })) }),
        { rotulo: 'Trazer os marcados', largo: true });
        if (r) { toast(`${r.criadas} conta(s) a pagar criada(s).`); carregar(); }
      };

      async function carregar() {
        limpar(chips, Object.entries(FILTROS).map(([k, t]) => el('button', { type: 'button', class: `chip${k === status ? ' on' : ''}`, onclick: () => { status = k; carregar(); } }, t)));
        // Pagas: as do mês; as outras: tudo o que estiver naquela situação.
        const periodo = status === 'pago' ? { de: `${hoje.slice(0, 7)}-01`, ate: hoje } : status === 'todos' ? { de: somarDias(hoje, -90), ate: somarDias(hoje, 365) } : {};
        const r = await api.get(`${base(ctx)}/lancamentos${qs({ tipo, status, ...periodo })}`);
        limpar(total, el('div', { class: 'grade', style: 'margin-bottom:18px' },
          indicador(FILTROS[status], dinheiro(r.totais.total_centavos), `${inteiro(r.totais.quantidade)} conta(s)${status === 'pago' ? ' neste mês' : ''}`, '', 'carteira'),
          status === 'pago' ? null : indicador('Vencidas', dinheiro(r.totais.vencido_centavos), tipo === 'pagar' ? 'em atraso para pagar' : 'em atraso para receber', r.totais.vencido_centavos ? 'erro' : 'ok', 'alertas'),
          status === 'pago' ? null : indicador('Vencem hoje', dinheiro(r.totais.hoje_centavos), 'com vencimento hoje', r.totais.hoje_centavos ? 'aviso' : '', 'relatorios')));
        limpar(lista, tabela(['Vencimento', 'Descrição', L.pessoa.split(' / ')[0], 'Categoria', '>Valor', 'Situação', '^Ações'], r.itens.map((l) => el('tr', {},
          td([data(l.vencimento), l.status === 'pago' ? el('div', { class: 'pequeno mudo' }, `${L.feito} em ${data(l.pago_em)}`) : null], 'sem-quebra'),
          td([l.descricao, el('div', { class: 'pequeno mudo' }, [l.parcelas > 1 ? `${l.parcela}/${l.parcelas}` : null, l.placa ? placa(l.placa) : null, l.documento ? `nº ${l.documento}` : null,
            l.origem !== 'manual' ? 'veio da frota' : null].filter(Boolean).join(' · '))]),
          td(l.pessoa ?? l.fornecedor ?? '—'), td(l.categoria ?? '—'),
          td([dinheiro(l.status === 'pago' ? l.valor_pago_centavos : l.valor_centavos), l.status === 'pago' && l.valor_pago_centavos !== l.valor_centavos ? el('div', { class: 'pequeno mudo' }, `de ${dinheiro(l.valor_centavos)}`) : null,
            l.status === 'pago' && l.conta ? el('div', { class: 'pequeno mudo' }, l.conta) : null], 'dir num'),
          td(etiqueta(...rotuloSituacao(l))),
          el('td', { class: 'acoes' }, pode(ctx) ? (l.status === 'aberto' ? [
            botao(L.baixar, 'primario', async () => { if (await baixar(l)) { toast(`Conta ${L.feito}.`); carregar(); } }),
            botaoIcone('editar', 'Editar', async () => { if (await form(l)) { toast('Conta salva.'); carregar(); } }),
            botaoIcone('lixo', 'Excluir', async () => {
              const todas = l.parcelas > 1 && await confirmar('Excluir as outras também?', `Esta é a ${l.parcela}ª de ${l.parcelas}. Excluir todas as que ainda estão em aberto, ou só esta?`, 'Todas em aberto');
              if (!todas && !await confirmar('Excluir conta', `Excluir "${l.descricao}" de ${dinheiro(l.valor_centavos)}?`, 'Excluir')) return;
              await api.del(`${base(ctx)}/lancamentos/${l.id}${todas ? '?todas=1' : ''}`);
              toast('Conta excluída.'); carregar();
            }, 'perigo')] : botao('Estornar', '', async () => {
            if (!await confirmar('Estornar a baixa', `"${l.descricao}" volta a ficar em aberto e o valor sai do saldo da conta.`, 'Estornar')) return;
            await api.post(`${base(ctx)}/lancamentos/${l.id}/estornar`, {});
            toast('Baixa estornada.'); carregar();
          })) : null))),
        status === 'aberto' ? `Nenhuma ${L.titulo.toLowerCase().replace('contas', 'conta')} em aberto.` : 'Nenhuma conta com esse filtro.'));
      }
      limpar(ctx.conteudo,
        acoesTopo(chips, pode(ctx) ? el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap' },
          tipo === 'pagar' ? el('button', { class: 'btn', onclick: trazerDaFrota }, icone('baixar'), 'Trazer da frota') : null,
          el('button', { class: 'btn primario', onclick: async () => { if (await form(null)) { toast('Conta lançada.'); carregar(); } } }, L.nova)) : null),
        total, cartao(null, lista));
      await carregar();
    });
  };
}

// ---------- Contas e caixas ----------
async function telaContasCaixas(ctx) {
  await tela(ctx, async () => {
    const corpo = el('div', { class: 'coluna', style: 'gap:18px' });
    const cat = await api.get(`${base(ctx)}/catalogos`);
    const form = (c) => formModal(c ? `Editar ${c.nome}` : 'Nova conta ou caixa', () => [
      el('div', { class: 'duas' }, campo('Nome', { name: 'nome', required: true, maxlength: 60, value: c?.nome ?? '', placeholder: 'Ex.: Banco do Brasil' }), escolha('Tipo', 'tipo', cat.tipos_conta, c?.tipo ?? 'banco')),
      campo('Saldo inicial (R$): quanto tinha quando começou a usar o sistema', { name: 'saldo', inputmode: 'decimal', maxlength: 15, value: c ? reaisCampo(c.saldo_inicial_centavos) : '0,00' }),
      c ? marcar('Conta ativa', { name: 'ativo', checked: Boolean(c.ativo) }) : null,
    ], (d) => {
      const txt = String(d.saldo ?? '').trim();
      const sinal = txt.startsWith('-') ? -1 : 1;
      const corpoReq = { nome: d.nome, tipo: d.tipo, ativo: d.ativo, saldo_inicial_centavos: sinal * (centavos(txt.replace('-', '')) ?? 0) };
      return c ? api.put(`${base(ctx)}/contas/${c.id}`, corpoReq) : api.post(`${base(ctx)}/contas`, corpoReq);
    });
    async function carregar() {
      const r = await api.get(`${base(ctx)}/contas`);
      const ativas = r.contas.filter((c) => c.ativo);
      const transferir = () => formModal('Transferência entre contas', () => [
        el('div', { class: 'duas' }, escolha('Sai de', 'de_conta_id', Object.fromEntries(ativas.map((c) => [c.id, `${c.nome} · ${dinheiro(c.saldo_centavos)}`])), ativas[0]?.id),
          escolha('Entra em', 'para_conta_id', Object.fromEntries(ativas.map((c) => [c.id, c.nome])), ativas[1]?.id)),
        el('div', { class: 'duas' }, campo('Valor (R$)', { name: 'valor', required: true, inputmode: 'decimal', maxlength: 14, placeholder: '0,00' }), campo('Data', { name: 'data', type: 'date', required: true, value: hojeLocal() })),
        campo('Observação', { name: 'observacao', maxlength: 200 }),
      ], (d) => api.post(`${base(ctx)}/transferencias`, { ...d, valor_centavos: centavos(d.valor) }), { rotulo: 'Transferir' });
      limpar(corpo,
        el('div', { class: 'grade' }, indicador('Saldo total', valorCor(ativas.reduce((s, c) => s + c.saldo_centavos, 0)), `${inteiro(ativas.length)} conta(s) ativa(s)`, '', 'carteira')),
        cartao(null, tabela(['Conta', 'Tipo', '>Saldo inicial', '>Saldo hoje', 'Situação', '^Ações'], r.contas.map((c) => el('tr', { class: c.ativo ? '' : 'inativo' },
          td(el('strong', {}, c.nome)), td(c.nome_tipo), td(dinheiro(c.saldo_inicial_centavos), 'dir num'), td(el('strong', {}, valorCor(c.saldo_centavos)), 'dir num'),
          td(c.ativo ? etiqueta('ativa', 'ok') : etiqueta('desativada')),
          el('td', { class: 'acoes' }, pode(ctx) ? botaoIcone('editar', 'Editar', async () => { if (await form(c)) { toast('Conta salva.'); carregar(); } }) : null))), 'Nenhuma conta cadastrada.')),
        cartao('Transferências entre contas', tabela(['Data', 'Saiu de', 'Entrou em', '>Valor', 'Observação', '^Ações'], r.transferencias.map((t) => el('tr', {},
          td(data(t.data), 'sem-quebra'), td(t.de_nome), td(t.para_nome), td(dinheiro(t.valor_centavos), 'dir num'), td(t.observacao ?? '—'),
          el('td', { class: 'acoes' }, pode(ctx) ? botaoIcone('lixo', 'Excluir', async () => {
            if (!await confirmar('Excluir transferência', `Desfazer a transferência de ${dinheiro(t.valor_centavos)} de ${t.de_nome} para ${t.para_nome}?`, 'Excluir')) return;
            await api.del(`${base(ctx)}/transferencias/${t.id}`); toast('Transferência excluída.'); carregar();
          }, 'perigo') : null))), 'Nenhuma transferência.'),
        pode(ctx) && ativas.length >= 2 ? el('div', { style: 'margin-top:12px' }, botao('Nova transferência', '', async () => { if (await transferir()) { toast('Transferência registrada.'); carregar(); } })) : null));
    }
    limpar(ctx.conteudo,
      acoesTopo(el('p', { class: 'mudo', style: 'margin:0' }, 'Onde o dinheiro está: caixa, bancos e cartões. O saldo muda sozinho a cada pagamento, recebimento e transferência.'),
        pode(ctx) ? el('button', { class: 'btn primario', onclick: async () => { if (await form(null)) { toast('Conta criada.'); carregar(); } } }, 'Nova conta ou caixa') : null),
      corpo);
    await carregar();
  });
}

// ---------- Resultado (o que entrou e o que saiu, por categoria) ----------
async function telaResultado(ctx) {
  await tela(ctx, async () => {
    const hoje = hojeLocal();
    const mesPassado = somarDias(`${hoje.slice(0, 7)}-01`, -1);
    const PER = { mes: ['Este mês', `${hoje.slice(0, 7)}-01`, hoje], passado: ['Mês passado', `${mesPassado.slice(0, 7)}-01`, mesPassado], noventa: ['Últimos 90 dias', somarDias(hoje, -89), hoje], ano: ['Este ano', `${hoje.slice(0, 4)}-01-01`, hoje] };
    let periodo = 'mes';
    const chips = el('div', { class: 'chips' });
    const corpo = el('div', { class: 'coluna', style: 'gap:18px' });
    const quadro = (titulo, linhas, total, vazio) => cartao(titulo, tabela(['Categoria', '>Contas', '>Valor', '>Parte'], linhas.map((x) => el('tr', {},
      td(x.categoria), td(inteiro(x.quantidade), 'dir num'), td(dinheiro(x.total_centavos), 'dir num'), td(total ? `${Math.round((x.total_centavos / total) * 100)}%` : '—', 'dir num'))), vazio));
    async function carregar() {
      limpar(chips, Object.entries(PER).map(([k, [t]]) => el('button', { type: 'button', class: `chip${k === periodo ? ' on' : ''}`, onclick: () => { periodo = k; carregar(); } }, t)));
      const [, de, ate] = PER[periodo];
      const r = await api.get(`${base(ctx)}/resultado${qs({ de, ate })}`);
      limpar(corpo,
        el('div', { class: 'grade' },
          indicador('Receitas', dinheiro(r.receita_centavos), 'recebido no período', 'ok', 'check'),
          indicador('Despesas', dinheiro(r.despesa_centavos), 'pago no período', '', 'relatorios'),
          indicador('Resultado', valorCor(r.resultado_centavos), r.receita_centavos ? `margem de ${Math.round((r.resultado_centavos / r.receita_centavos) * 100)}%` : 'receitas menos despesas', r.resultado_centavos < 0 ? 'erro' : 'ok', 'rota')),
        quadro('Despesas por categoria', r.despesas, r.despesa_centavos, 'Nenhuma despesa paga no período.'),
        quadro('Receitas por categoria', r.receitas, r.receita_centavos, 'Nenhuma receita recebida no período.'),
        r.veiculos.length ? cartao('Por veículo', tabela(['Veículo', '>Receitas', '>Despesas', '>Resultado'], r.veiculos.map((x) => el('tr', {},
          td([el('strong', {}, placa(x.placa)), x.descricao ? el('div', { class: 'pequeno mudo' }, x.descricao) : null]), td(dinheiro(x.receita_centavos), 'dir num'),
          td(dinheiro(x.despesa_centavos), 'dir num'), td(el('strong', {}, valorCor(x.resultado_centavos)), 'dir num'))))) : null,
        el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Conta o que foi efetivamente pago e recebido no período (pela data da baixa), não o que venceu. "Por veículo" soma só as contas ligadas a um veículo.'));
    }
    limpar(ctx.conteudo, acoesTopo(chips), corpo);
    await carregar();
  });
}

// ---------- Categorias ----------
async function telaCategorias(ctx) {
  await tela(ctx, async () => {
    const corpo = el('div', { class: 'coluna', style: 'gap:18px' });
    const form = (c, tipo) => formModal(c ? `Editar ${c.nome}` : `Nova categoria de ${tipo === 'receita' ? 'receita' : 'despesa'}`, () => [
      campo('Nome', { name: 'nome', required: true, maxlength: 60, value: c?.nome ?? '' }),
      c ? marcar('Categoria ativa (desativada, some das listas e o histórico continua)', { name: 'ativo', checked: Boolean(c.ativo) }) : null,
    ], (d) => (c ? api.put(`${base(ctx)}/categorias/${c.id}`, d) : api.post(`${base(ctx)}/categorias`, { ...d, tipo })));
    async function carregar() {
      const l = await api.get(`${base(ctx)}/categorias`);
      const quadro = (titulo, tipo) => cartao(titulo, tabela(['Categoria', 'Situação', '^Ações'], l.filter((c) => c.tipo === tipo).map((c) => el('tr', { class: c.ativo ? '' : 'inativo' },
        td(c.nome), td(c.ativo ? etiqueta('ativa', 'ok') : etiqueta('desativada')),
        el('td', { class: 'acoes' }, pode(ctx) ? botaoIcone('editar', 'Editar', async () => { if (await form(c, tipo)) { toast('Categoria salva.'); carregar(); } }) : null))), 'Nenhuma categoria.'),
      pode(ctx) ? el('div', { style: 'margin-top:12px' }, botao('Nova categoria', '', async () => { if (await form(null, tipo)) { toast('Categoria criada.'); carregar(); } })) : null);
      limpar(corpo, el('div', { class: 'grade-dash' }, el('div', { class: 'c6' }, quadro('Despesas', 'despesa')), el('div', { class: 'c6' }, quadro('Receitas', 'receita'))));
    }
    limpar(ctx.conteudo, el('p', { class: 'mudo', style: 'margin:0 0 16px' }, 'As categorias separam as contas no resultado. O sistema já traz as mais comuns; renomeie, desative ou crie as suas.'), corpo);
    await carregar();
  });
}

export const TELAS_FINANCEIRO = {
  'fin-resumo': telaResumo, 'fin-pagar': telaContas('pagar'), 'fin-receber': telaContas('receber'),
  'fin-contas': telaContasCaixas, 'fin-resultado': telaResultado, 'fin-categorias': telaCategorias,
};
