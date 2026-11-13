import { api, ir, pode } from '../app.js';
import { qs } from '../../comum/api.js';
import {
  el, montar,
   cartao, tabela, paginacao, campo, lerForm, modal, confirmar, toast, acao, aviso, selo, copiar,
  dinheiro, numero, data, documento, linhaDigitavel, hojeIso, somarDias, primeiroDiaMes, R, icone,
} from '../../comum/ui.js';
import { barraSplit } from '../../comum/graficos.js';

/** Lista de boletos de todos os clientes, com emissão e detalhe. */
export default async function boletos({ alvo, params, query, recarregar }) {
  if (params[0]) return detalheBoleto(alvo, params[0], recarregar);

  const filtros = {
    busca: query.busca ?? '', situacao: query.situacao ?? '', cliente_id: query.cliente_id ?? '',
    campo_data: query.campo_data ?? 'vencimento', de: query.de ?? '', ate: query.ate ?? '', pagina: Number(query.pagina) || 1,
  };
  const aplicar = (mudanca) => ir(`#/boletos${qs({ ...filtros, ...mudanca, pagina: mudanca.pagina ?? 1 })}`);

  const clientes = pode('clientes.ver') ? (await api.get('/clientes?por_pagina=200')).itens : [];
  const lista = await api.get(`/boletos${qs(filtros)}`);

  const form = el('form', { class: 'filtros', onsubmit: (e) => { e.preventDefault(); aplicar(lerForm(form)); } },
    campo({ nome: 'busca', rotulo: 'Buscar', valor: filtros.busca, ajuda: 'Pagador, CPF/CNPJ, documento ou nosso número', atributos: { placeholder: 'Ex.: Maria, 123.456…' } }),
    campo({ nome: 'cliente_id', rotulo: 'Cliente', tipo: 'select', valor: filtros.cliente_id,
      opcoes: [['', 'Todos'], ...clientes.map((c) => [c.id, c.nome_fantasia || c.razao_social])] }),
    campo({ nome: 'situacao', rotulo: 'Situação', tipo: 'select', valor: filtros.situacao,
      opcoes: [['', 'Todas'], ['a_vencer', 'A vencer'], ['vencido', 'Vencidos'], ['liquidado', 'Liquidados'], ['baixado', 'Baixados'], ['falha', 'Falha no registro']] }),
    campo({ nome: 'campo_data', rotulo: 'Período por', tipo: 'select', valor: filtros.campo_data,
      opcoes: [['vencimento', 'Vencimento'], ['emissao', 'Emissão'], ['pagamento', 'Pagamento']] }),
    campo({ nome: 'de', rotulo: 'De', tipo: 'date', valor: filtros.de }),
    campo({ nome: 'ate', rotulo: 'Até', tipo: 'date', valor: filtros.ate }),
    el('button', { class: 'botao', type: 'submit' }, icone('busca'), 'Filtrar'));

  montar(alvo, 
    el('div', { class: 'cabecalho-tela' },
      el('div', {}, el('h1', {}, 'Boletos'), el('p', {}, `${numero(lista.total)} título(s) encontrado(s)`)),
      el('div', { class: 'acoes' },
        el('button', { class: 'botao sec', onclick: (e) => acao(e.currentTarget, () => api.baixar(`/boletos/export.csv${qs(filtros)}`, 'boletos.csv')) }, icone('baixar'), 'CSV'),
        pode('boletos.emitir') ? el('button', { class: 'botao', onclick: () => emitir(clientes, recarregar) }, icone('mais'), 'Emitir boleto') : null)),
    form,
    tabela({
      colunas: [
        { titulo: 'Nosso número', conteudo: (b) => el('span', {}, el('span', { class: 'forte num' }, b.nosso_numero_formatado),
          el('span', { class: 'sub' }, b.seu_numero ? `Doc. ${b.seu_numero}` : R.origem[b.origem] ?? b.origem)) },
        { titulo: 'Cliente', conteudo: (b) => el('span', {}, b.nome_fantasia || b.razao_social) },
        { titulo: 'Pagador', conteudo: (b) => el('span', {}, b.pagador_nome, el('span', { class: 'sub' }, documento(b.pagador_documento))) },
        { titulo: 'Vencimento', dir: true, conteudo: (b) => el('span', {}, data(b.vencimento),
          b.pago_em ? el('span', { class: 'sub' }, `pago ${data(b.pago_em)}`) : null) },
        { titulo: 'Valor', dir: true, conteudo: (b) => el('strong', {}, dinheiro(b.pago_valor_centavos ?? b.valor_centavos)) },
        { titulo: 'Situação', conteudo: (b) => selo(b.situacao_visivel) },
      ],
      itens: lista.itens,
      vazio: 'Nenhum boleto com esses filtros.',
      aoClicar: (b) => ir(`#/boletos/${b.id}`),
      rodape: paginacao(lista, (p) => aplicar({ pagina: p })),
    }),
  );

  if (query.novo && pode('boletos.emitir')) emitir(clientes, recarregar);
}

/** Formulário de emissão, com a prévia do split antes de confirmar. */
export function emitir(clientes, recarregar, clienteFixo = null) {
  const previa = el('div', { class: 'aviso info' }, 'Informe o valor para ver como ficará o split.');
  const form = el('form', { onsubmit: (e) => e.preventDefault() },
    el('div', { class: 'linha-form' },
      clienteFixo ? null : campo({ nome: 'cliente_id', rotulo: 'Cliente', tipo: 'select', obrigatorio: true,
        opcoes: clientes.filter((c) => c.situacao === 'ativo').map((c) => [c.id, c.nome_fantasia || c.razao_social]) }),
      campo({ nome: 'tipo', rotulo: 'Tipo', tipo: 'select', valor: 'bolepix', opcoes: Object.entries(R.tipoBoleto) }),
      campo({ nome: 'valor', rotulo: 'Valor (R$)', tipo: 'dinheiro', obrigatorio: true, atributos: { placeholder: '0,00' } }),
      campo({ nome: 'vencimento', rotulo: 'Vencimento', tipo: 'date', valor: somarDias(hojeIso(), 7), obrigatorio: true }),
      campo({ nome: 'seu_numero', rotulo: 'Nº do documento', ajuda: 'O seu controle (opcional)' })),
    el('h3', { style: 'font-size:14px;margin:14px 0 8px' }, 'Pagador'),
    el('div', { class: 'linha-form' },
      campo({ nome: 'pagador_nome', rotulo: 'Nome', obrigatorio: true }),
      campo({ nome: 'pagador_documento', rotulo: 'CPF/CNPJ', obrigatorio: true }),
      campo({ nome: 'pagador_email', rotulo: 'E-mail', tipo: 'email' }),
      campo({ nome: 'pagador_telefone', rotulo: 'Telefone' })),
    el('div', { class: 'linha-form', style: 'margin-top:12px' },
      campo({ nome: 'pagador_cep', rotulo: 'CEP' }),
      campo({ nome: 'pagador_endereco', rotulo: 'Endereço' }),
      campo({ nome: 'pagador_numero', rotulo: 'Número' }),
      campo({ nome: 'pagador_bairro', rotulo: 'Bairro' }),
      campo({ nome: 'pagador_cidade', rotulo: 'Cidade' }),
      campo({ nome: 'pagador_uf', rotulo: 'UF', atributos: { maxlength: 2, style: 'text-transform:uppercase' } })),
    el('h3', { style: 'font-size:14px;margin:14px 0 8px' }, 'Encargos e instruções'),
    el('div', { class: 'linha-form' },
      campo({ nome: 'juros_mes', rotulo: 'Juros ao mês (%)', valor: '1', ajuda: 'Pro rata die após o vencimento' }),
      campo({ nome: 'multa', rotulo: 'Multa (%)', valor: '2' }),
      campo({ nome: 'desconto', rotulo: 'Desconto (R$)', tipo: 'dinheiro' }),
      campo({ nome: 'desconto_ate', rotulo: 'Desconto até', tipo: 'date' })),
    el('div', { style: 'margin-top:12px' }, campo({ nome: 'mensagem', rotulo: 'Mensagem no boleto', atributos: { maxlength: 160 } })),
    el('div', { style: 'margin-top:14px' }, previa));

  let pendente = null;
  const atualizarPrevia = async () => {
    const d = lerForm(form);
    const clienteId = clienteFixo ?? d.cliente_id;
    if (!d.valor || !clienteId) return;
    clearTimeout(pendente);
    pendente = setTimeout(async () => {
      try {
        const s = await api.post('/boletos/simular', { cliente_id: Number(clienteId), valor: d.valor });
        previa.className = 'cartao';
        previa.replaceChildren(el('div', { class: 'corpo' },
          el('h3', { style: 'font-size:13.5px;margin-bottom:8px' }, 'Se este boleto for pago, o split fica assim'),
          barraSplit({
            total: s.bruto_centavos,
            partes: [
              { rotulo: 'Líquido do cliente', valor: s.liquido_centavos },
              { rotulo: 'Tarifa bancária', valor: s.tarifa_banco_centavos },
              { rotulo: 'Comissão PayAx', valor: s.comissao_centavos },
            ],
          })));
      } catch { /* valor ainda incompleto */ }
    }, 350);
  };
  form.addEventListener('input', atualizarPrevia);
  form.addEventListener('change', atualizarPrevia);

  const botao = el('button', { class: 'botao' }, icone('boleto'), 'Emitir boleto');
  botao.addEventListener('click', () => acao(botao, async () => {
    const d = lerForm(form);
    const b = await api.post('/boletos', { ...d, cliente_id: Number(clienteFixo ?? d.cliente_id) });
    m.fechar();
    toast(`Boleto ${b.nosso_numero_formatado} emitido.`, 'ok');
    ir(`#/boletos/${b.id}`);
    recarregar?.();
  }));
  const m = modal({ titulo: 'Emitir boleto', largo: true, corpo: form, acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao] });
  return m;
}

/** Detalhe do boleto com código, split e ações. */
async function detalheBoleto(alvo, id, recarregar) {
  const b = await api.get(`/boletos/${id}`);
  const par = (rot, val, classe = '') => el('div', { class: 'par' }, el('span', { class: 'rot' }, rot), el('span', { class: `val ${classe}` }, val));

  const acoes = el('div', { class: 'acoes' },
    el('button', { class: 'botao sec', onclick: (e) => acao(e.currentTarget, () => api.abrirPagina(`/boletos/${b.id}/ficha`)) }, icone('imprimir'), 'Ficha / imprimir'),
    el('button', { class: 'botao sec', onclick: (e) => acao(e.currentTarget, async () => {
      const l = await api.get(`/boletos/${b.id}/link`);
      await copiar(l.url ?? `${location.origin}${l.caminho}`, 'Link do boleto copiado — envie ao pagador.');
    }) }, icone('copiar'), 'Copiar link'),
    b.situacao === 'registrado' && pode('boletos.baixar')
      ? el('button', { class: 'botao sec', onclick: async (e) => {
        const r = await confirmar({ titulo: 'Baixar boleto', texto: 'O título deixa de poder ser pago. Esta ação é informada ao banco.', confirmarTexto: 'Baixar', perigo: true, campoMotivo: true });
        if (r) acao(e.currentTarget, async () => { await api.post(`/boletos/${b.id}/baixa`, r); toast('Boleto baixado.', 'ok'); recarregar(); });
      } }, 'Baixar')
      : null,
    b.situacao !== 'liquidado' && pode('conciliacao.operar')
      ? el('button', { class: 'botao sec', onclick: () => liquidarManual(b, recarregar) }, icone('ok'), 'Registrar pagamento')
      : null,
    b.situacao === 'liquidado' && pode('conciliacao.operar')
      ? el('button', { class: 'botao sec', onclick: async (e) => {
        const r = await confirmar({ titulo: 'Estornar liquidação', texto: 'O crédito e os descontos voltam na conta gráfica do cliente como estorno.', confirmarTexto: 'Estornar', perigo: true, campoMotivo: true });
        if (r) acao(e.currentTarget, async () => { await api.post(`/boletos/${b.id}/estorno`, r); toast('Liquidação estornada.', 'ok'); recarregar(); });
      } }, 'Estornar')
      : null,
    pode('conciliacao.operar')
      ? el('button', { class: 'botao sec', onclick: (e) => acao(e.currentTarget, async () => {
        const r = await api.post(`/boletos/${b.id}/consultar`, {});
        toast(`Banco respondeu: ${r.consulta.situacao ?? 'sem situação'}${r.consulta.simulado ? ' (simulador)' : ''}.`);
        recarregar();
      }) }, icone('atualizar'), 'Consultar no banco')
      : null);

  montar(alvo, 
    el('div', { class: 'cabecalho-tela' },
      el('div', {},
        el('a', { class: 'botao sutil', href: '#/boletos' }, icone('voltar'), 'Boletos'),
        el('h1', {}, `Boleto ${b.nosso_numero_formatado}`),
        el('p', {}, `${R.tipoBoleto[b.tipo]} · ${b.cliente.nome_fantasia || b.cliente.razao_social} · emitido em ${data(b.emissao)}`)),
      acoes),

    b.situacao === 'falha' ? aviso(`O banco não registrou este título: ${b.erro_registro}`, 'erro') : null,

    el('div', { class: 'grade duas', style: 'margin-top:4px' },
      cartao('Título', el('div', { class: 'pares' },
        par('Situação', selo(b.situacao_visivel)),
        par('Valor', dinheiro(b.valor_centavos), 'grande'),
        par('Vencimento', data(b.vencimento)),
        par('Valor a pagar hoje', dinheiro(b.atualizado.valor_centavos)),
        b.atualizado.dias_atraso ? par('Atraso', `${b.atualizado.dias_atraso} dia(s) · multa ${dinheiro(b.atualizado.multa_centavos)} + juros ${dinheiro(b.atualizado.juros_centavos)}`) : null,
        b.pago_em ? par('Pago em', `${data(b.pago_em)} · ${dinheiro(b.pago_valor_centavos)} (${b.pago_meio === 'pix' ? 'PIX' : 'boleto'})`) : null,
        par('Documento', b.seu_numero ?? '—'),
        par('Origem', R.origem[b.origem] ?? b.origem))),
      cartao('Pagador', el('div', { class: 'pares' },
        par('Nome', b.pagador_nome),
        par('CPF/CNPJ', documento(b.pagador_documento)),
        par('E-mail', b.pagador_email ?? '—'),
        par('Telefone', b.pagador_telefone ?? '—'),
        par('Endereço', [b.pagador_endereco, b.pagador_numero].filter(Boolean).join(', ') || '—'),
        par('Cidade', [b.pagador_cidade, b.pagador_uf].filter(Boolean).join('/') || '—')))),

    el('div', { style: 'margin-top:14px' },
      cartao('Códigos de pagamento', el('div', { style: 'display:grid;gap:10px' },
        el('div', {}, el('span', { class: 'rot', style: 'font-size:11.5px;color:var(--texto-3);font-weight:600' }, 'LINHA DIGITÁVEL'),
          el('div', { class: 'codigo num' }, linhaDigitavel(b.linha_digitavel)),
          el('button', { class: 'botao sutil pequeno', onclick: () => copiar(b.linha_digitavel, 'Linha digitável copiada.') }, icone('copiar'), 'Copiar')),
        b.pix_emv ? el('div', {}, el('span', { class: 'rot', style: 'font-size:11.5px;color:var(--texto-3);font-weight:600' }, 'PIX COPIA E COLA (BOLEPIX)'),
          el('div', { class: 'codigo' }, b.pix_emv),
          el('button', { class: 'botao sutil pequeno', onclick: () => copiar(b.pix_emv, 'Código PIX copiado.') }, icone('copiar'), 'Copiar')) : null))),

    el('div', { style: 'margin-top:14px' },
      cartao(b.split.previsto ? 'Split previsto (se for pago pelo valor cheio)' : 'Split aplicado na liquidação',
        el('div', {},
          barraSplit({
            total: b.split.bruto_centavos,
            partes: [
              { rotulo: 'Líquido do cliente', valor: b.split.liquido_centavos },
              { rotulo: 'Tarifa bancária', valor: b.split.tarifa_banco_centavos },
              { rotulo: 'Comissão PayAx', valor: b.split.comissao_centavos },
            ],
          }),
          b.lancamentos.length
            ? el('div', { style: 'margin-top:12px' }, tabela({
              colunas: [
                { titulo: 'Lançamento', conteudo: (l) => l.descricao },
                { titulo: 'Competência', conteudo: (l) => data(l.data_competencia) },
                { titulo: 'Liberação', conteudo: (l) => data(l.data_liberacao) },
                { titulo: 'Valor', dir: true, conteudo: (l) => el('strong', { style: l.valor_centavos < 0 ? 'color:var(--vermelho)' : 'color:var(--verde-texto)' }, dinheiro(l.valor_centavos)) },
              ],
              itens: b.lancamentos,
            }))
            : el('p', { style: 'margin-top:10px;color:var(--texto-3);font-size:13px' }, 'Os lançamentos na conta gráfica do cliente são criados quando o título for liquidado.')))),
  );
}

function liquidarManual(b, recarregar) {
  const form = el('form', { class: 'linha-form', onsubmit: (e) => e.preventDefault() },
    campo({ nome: 'pago_em', rotulo: 'Data do crédito', tipo: 'date', valor: hojeIso(), obrigatorio: true }),
    campo({ nome: 'valor_pago', rotulo: 'Valor pago (R$)', tipo: 'dinheiro', valor: (b.valor_centavos / 100).toFixed(2).replace('.', ','), obrigatorio: true }),
    campo({ nome: 'meio', rotulo: 'Meio', tipo: 'select', valor: 'boleto', opcoes: [['boleto', 'Boleto'], ['pix', 'PIX (Bolepix)']] }));
  const botao = el('button', { class: 'botao' }, 'Registrar pagamento');
  botao.addEventListener('click', () => acao(botao, async () => {
    await api.post(`/boletos/${b.id}/liquidar`, lerForm(form));
    m.fechar();
    toast('Pagamento registrado e split aplicado.', 'ok');
    recarregar();
  }));
  const m = modal({
    titulo: 'Registrar pagamento manualmente',
    corpo: [aviso('Use quando o crédito chegou por fora do aviso automático do banco. O split é aplicado na hora.', 'aviso'), form],
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao],
  });
}
