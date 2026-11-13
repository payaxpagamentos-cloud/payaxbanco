import { api, ir, pode } from '../app.js';
import { qs } from '../../comum/api.js';
import {
  el, montar, cartao, tabela, paginacao, campo, lerForm, modal, confirmar, toast, acao, aviso, selo, copiar, autoPreencher,
  dinheiro, numero, data, documento, linhaDigitavel, hojeIso, somarDias, R, icone
} from '../../comum/ui.js';
import { barraSplit } from '../../comum/graficos.js';

export default async function boletos({ alvo, params, query, recarregar }) {
  if (params[0]) return detalhe(alvo, params[0], recarregar);

  const f = { busca: query.busca ?? '', situacao: query.situacao ?? '', campo_data: query.campo_data ?? 'vencimento',
    de: query.de ?? '', ate: query.ate ?? '', pagina: Number(query.pagina) || 1 };
  const lista = await api.get(`/boletos${qs(f)}`);
  const form = el('form', { class: 'filtros', onsubmit: (e) => { e.preventDefault(); ir(`#/boletos${qs({ ...f, ...lerForm(form), pagina: 1 })}`); } },
    campo({ nome: 'busca', rotulo: 'Buscar', valor: f.busca, atributos: { placeholder: 'Pagador, CPF/CNPJ ou documento' } }),
    campo({ nome: 'situacao', rotulo: 'Situação', tipo: 'select', valor: f.situacao,
      opcoes: [['', 'Todas'], ['a_vencer', 'A vencer'], ['vencido', 'Vencidos'], ['liquidado', 'Pagos'], ['baixado', 'Baixados']] }),
    campo({ nome: 'campo_data', rotulo: 'Período por', tipo: 'select', valor: f.campo_data,
      opcoes: [['vencimento', 'Vencimento'], ['emissao', 'Emissão'], ['pagamento', 'Pagamento']] }),
    campo({ nome: 'de', rotulo: 'De', tipo: 'date', valor: f.de }),
    campo({ nome: 'ate', rotulo: 'Até', tipo: 'date', valor: f.ate }),
    el('button', { class: 'botao', type: 'submit' }, icone('busca'), 'Filtrar'));

  montar(alvo, 
    el('div', { class: 'cabecalho-tela' },
      el('div', {}, el('h1', {}, 'Meus boletos'), el('p', {}, `${numero(lista.total)} título(s)`)),
      el('div', { class: 'acoes' },
        el('button', { class: 'botao sec', onclick: (e) => acao(e.currentTarget, () => api.baixar(`/boletos/export.csv${qs(f)}`, 'meus-boletos.csv')) }, icone('baixar'), 'CSV'),
        pode('boletos.emitir') ? el('button', { class: 'botao', onclick: () => emitir(recarregar) }, icone('mais'), 'Emitir boleto') : null)),
    form,
    tabela({
      colunas: [
        { titulo: 'Pagador', conteudo: (b) => el('span', {}, el('span', { class: 'forte' }, b.pagador_nome), el('span', { class: 'sub' }, documento(b.pagador_documento))) },
        { titulo: 'Documento', conteudo: (b) => el('span', {}, b.seu_numero ?? '—', el('span', { class: 'sub num' }, b.nosso_numero_formatado)) },
        { titulo: 'Vencimento', dir: true, conteudo: (b) => el('span', {}, data(b.vencimento), b.pago_em ? el('span', { class: 'sub' }, `pago ${data(b.pago_em)}`) : null) },
        { titulo: 'Valor', dir: true, conteudo: (b) => el('strong', {}, dinheiro(b.pago_valor_centavos ?? b.valor_centavos)) },
        { titulo: 'Situação', conteudo: (b) => selo(b.situacao_visivel) },
      ],
      itens: lista.itens,
      vazio: 'Nenhum boleto com esses filtros.',
      aoClicar: (b) => ir(`#/boletos/${b.id}`),
      rodape: paginacao(lista, (p) => ir(`#/boletos${qs({ ...f, pagina: p })}`)),
    }),
  );
  if (query.novo && pode('boletos.emitir')) emitir(recarregar);
}

function emitir(recarregar) {
  const previa = el('div', { class: 'aviso info' }, 'Informe o valor para ver quanto você recebe.');
  const form = el('form', { onsubmit: (e) => e.preventDefault() },
    el('div', { class: 'linha-form' },
      campo({ nome: 'tipo', rotulo: 'Tipo', tipo: 'select', valor: 'bolepix', opcoes: Object.entries(R.tipoBoleto) }),
      campo({ nome: 'valor', rotulo: 'Valor (R$)', tipo: 'dinheiro', obrigatorio: true, atributos: { placeholder: '0,00' } }),
      campo({ nome: 'vencimento', rotulo: 'Vencimento', tipo: 'date', valor: somarDias(hojeIso(), 7), obrigatorio: true }),
      campo({ nome: 'seu_numero', rotulo: 'Nº do documento', ajuda: 'Seu controle (opcional)' })),
    el('h3', { style: 'font-size:14px;margin:14px 0 8px' }, 'Quem vai pagar'),
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
    el('h3', { style: 'font-size:14px;margin:14px 0 8px' }, 'Se atrasar'),
    el('div', { class: 'linha-form' },
      campo({ nome: 'juros_mes', rotulo: 'Juros ao mês (%)', valor: '1' }),
      campo({ nome: 'multa', rotulo: 'Multa (%)', valor: '2' }),
      campo({ nome: 'desconto', rotulo: 'Desconto por antecipação (R$)', tipo: 'dinheiro' }),
      campo({ nome: 'desconto_ate', rotulo: 'Desconto até', tipo: 'date' })),
    el('div', { style: 'margin-top:12px' }, campo({ nome: 'mensagem', rotulo: 'Mensagem no boleto', atributos: { maxlength: 160 } })),
    el('div', { style: 'margin-top:14px' }, previa));


  // Consulta automática: CEP preenche o endereço; CNPJ do pagador traz razão social e endereço.
  autoPreencher(form, api, { tipo: 'cep', campo: 'pagador_cep', mapa: {
    pagador_endereco: 'endereco', pagador_bairro: 'bairro', pagador_cidade: 'cidade', pagador_uf: 'uf',
  } });
  autoPreencher(form, api, { tipo: 'cnpj', campo: 'pagador_documento', mapa: {
    pagador_nome: 'razao_social', pagador_cep: 'cep', pagador_endereco: 'endereco', pagador_numero: 'numero',
    pagador_bairro: 'bairro', pagador_cidade: 'cidade', pagador_uf: 'uf',
  } });

  let pendente = null;
  const atualizar = () => {
    const d = lerForm(form);
    if (!d.valor) return;
    clearTimeout(pendente);
    pendente = setTimeout(async () => {
      try {
        const s = await api.post('/boletos/simular', { valor: d.valor });
        previa.className = 'cartao';
        previa.replaceChildren(el('div', { class: 'corpo' },
          el('h3', { style: 'font-size:13.5px;margin-bottom:8px' }, `Se for pago, você recebe ${dinheiro(s.liquido_centavos)}`),
          barraSplit({
            total: s.bruto_centavos,
            partes: [
              { rotulo: 'Você recebe', valor: s.liquido_centavos },
              { rotulo: 'Tarifa bancária', valor: s.tarifa_banco_centavos },
              { rotulo: 'Tarifa PayAx', valor: s.comissao_centavos },
            ],
          })));
      } catch { /* valor incompleto */ }
    }, 350);
  };
  form.addEventListener('input', atualizar);

  const botao = el('button', { class: 'botao' }, icone('boleto'), 'Emitir boleto');
  botao.addEventListener('click', () => acao(botao, async () => {
    const b = await api.post('/boletos', lerForm(form));
    m.fechar();
    toast(`Boleto ${b.nosso_numero_formatado} emitido.`, 'ok');
    ir(`#/boletos/${b.id}`);
    recarregar?.();
  }));
  const m = modal({ titulo: 'Emitir boleto', largo: true, corpo: form,
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao] });
}

async function detalhe(alvo, id, recarregar) {
  const b = await api.get(`/boletos/${id}`);
  const par = (rot, val, classe = '') => el('div', { class: 'par' }, el('span', { class: 'rot' }, rot), el('span', { class: `val ${classe}` }, val));

  montar(alvo, 
    el('div', { class: 'cabecalho-tela' },
      el('div', {},
        el('a', { class: 'botao sutil', href: '#/boletos' }, icone('voltar'), 'Meus boletos'),
        el('h1', {}, `${b.pagador_nome}`),
        el('p', {}, `${R.tipoBoleto[b.tipo]} · nosso número ${b.nosso_numero_formatado} · emitido em ${data(b.emissao)}`)),
      el('div', { class: 'acoes' },
        el('button', { class: 'botao', onclick: (e) => acao(e.currentTarget, () => api.abrirPagina(`/boletos/${b.id}/ficha`)) }, icone('imprimir'), 'Ver / imprimir boleto'),
        el('button', { class: 'botao sec', onclick: (e) => acao(e.currentTarget, async () => {
          const l = await api.get(`/boletos/${b.id}/link`);
          await copiar(l.url ?? `${location.origin}${l.caminho}`, 'Link copiado — é só enviar ao pagador.');
        }) }, icone('copiar'), 'Copiar link para o pagador'),
        b.situacao === 'registrado' && pode('boletos.baixar')
          ? el('button', { class: 'botao sec', onclick: async (e) => {
            const r = await confirmar({ titulo: 'Cancelar boleto', texto: 'O título deixa de poder ser pago. Não dá para desfazer.', confirmarTexto: 'Cancelar boleto', perigo: true, campoMotivo: true });
            if (r) acao(e.currentTarget, async () => { await api.post(`/boletos/${b.id}/baixa`, r); toast('Boleto cancelado.', 'ok'); recarregar(); });
          } }, 'Cancelar boleto') : null)),

    el('div', { class: 'grade duas' },
      cartao('Título', el('div', { class: 'pares' },
        par('Situação', selo(b.situacao_visivel)),
        par('Valor', dinheiro(b.valor_centavos), 'grande'),
        par('Vencimento', data(b.vencimento)),
        par('Valor a pagar hoje', dinheiro(b.atualizado.valor_centavos)),
        b.atualizado.dias_atraso ? par('Atraso', `${b.atualizado.dias_atraso} dia(s)`) : null,
        b.pago_em ? par('Pago em', `${data(b.pago_em)} · ${dinheiro(b.pago_valor_centavos)}`) : null,
        par('Documento', b.seu_numero ?? '—'))),
      cartao('Pagador', el('div', { class: 'pares' },
        par('Nome', b.pagador_nome),
        par('CPF/CNPJ', documento(b.pagador_documento)),
        par('E-mail', b.pagador_email ?? '—'),
        par('Telefone', b.pagador_telefone ?? '—'),
        par('Cidade', [b.pagador_cidade, b.pagador_uf].filter(Boolean).join('/') || '—')))),

    el('div', { style: 'margin-top:14px' }, cartao('Códigos para o pagador',
      el('div', { style: 'display:grid;gap:10px' },
        el('div', {}, el('span', { class: 'rot', style: 'font-size:11.5px;color:var(--texto-3);font-weight:600' }, 'LINHA DIGITÁVEL'),
          el('div', { class: 'codigo num' }, linhaDigitavel(b.linha_digitavel)),
          el('button', { class: 'botao sutil pequeno', onclick: () => copiar(b.linha_digitavel, 'Linha digitável copiada.') }, icone('copiar'), 'Copiar')),
        b.pix_emv ? el('div', {}, el('span', { class: 'rot', style: 'font-size:11.5px;color:var(--texto-3);font-weight:600' }, 'PIX COPIA E COLA'),
          el('div', { class: 'codigo' }, b.pix_emv),
          el('button', { class: 'botao sutil pequeno', onclick: () => copiar(b.pix_emv, 'Código PIX copiado.') }, icone('copiar'), 'Copiar')) : null))),

    el('div', { style: 'margin-top:14px' }, cartao(b.split.previsto ? 'Quanto você recebe se for pago' : 'Quanto você recebeu',
      el('div', {},
        barraSplit({
          total: b.split.bruto_centavos,
          partes: [
            { rotulo: 'Você recebe', valor: b.split.liquido_centavos },
            { rotulo: 'Tarifa bancária', valor: b.split.tarifa_banco_centavos },
            { rotulo: 'Tarifa PayAx', valor: b.split.comissao_centavos },
          ],
        }),
        b.lancamentos.length ? el('div', { style: 'margin-top:12px' }, tabela({
          colunas: [
            { titulo: 'Lançamento', conteudo: (l) => l.descricao },
            { titulo: 'Liberação', conteudo: (l) => data(l.data_liberacao) },
            { titulo: 'Valor', dir: true, conteudo: (l) => el('strong', { style: l.valor_centavos < 0 ? 'color:var(--vermelho)' : 'color:var(--verde-texto)' }, dinheiro(l.valor_centavos)) },
          ],
          itens: b.lancamentos,
        })) : el('p', { style: 'margin-top:10px;color:var(--texto-3);font-size:13px' }, 'O crédito entra na sua conta quando o pagador pagar.')))),
  );
}
