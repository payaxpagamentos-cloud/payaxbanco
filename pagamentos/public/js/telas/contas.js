import { api, pode } from '../app.js';
import {
  el, montar, cartao, tabela, campo, lerForm, modal, toast, acao, aviso, selo, dinheiro, numero,
  percentual, data, documento, hojeIso, icone
} from '../../comum/ui.js';

/** Nossas contas no banco e a tabela de preços padrão da plataforma. */
export default async function contas({ alvo, recarregar }) {
  const [c, p] = await Promise.all([api.get('/contas'), api.get('/contas/precos-padrao')]);
  const v = p.vigente;
  const par = (rot, val) => el('div', { class: 'par' }, el('span', { class: 'rot' }, rot), el('span', { class: 'val' }, val));

  montar(alvo, 
    el('div', { class: 'cabecalho-tela' },
      el('div', {}, el('h1', {}, 'Contas e preços'),
        el('p', {}, 'Os boletos de todos os clientes são registrados na nossa conta (modelo de conta gráfica).')),
      pode('*') ? el('div', { class: 'acoes' }, el('button', { class: 'botao', onclick: () => editarConta(null, recarregar) }, icone('mais'), 'Nova conta')) : null),

    c.modo_banco === 'simulador'
      ? aviso('O banco está em modo SIMULADOR: os boletos são registrados localmente, com código de barras e QR válidos, mas o Bradesco não é chamado. Configure as credenciais em Integrações para usar o ambiente real.', 'aviso')
      : aviso(`Conectado ao Bradesco no ambiente de ${c.ambiente}.`, 'info'),

    el('div', { style: 'margin-top:14px' }, tabela({
      colunas: [
        { titulo: 'Conta', conteudo: (x) => el('span', {}, el('span', { class: 'forte' }, x.apelido),
          el('span', { class: 'sub' }, `Ag. ${x.agencia}${x.agencia_dv ? `-${x.agencia_dv}` : ''} · C/C ${x.conta}${x.conta_dv ? `-${x.conta_dv}` : ''} · carteira ${x.carteira}`)) },
        { titulo: 'Beneficiário', conteudo: (x) => el('span', {}, x.beneficiario_nome, el('span', { class: 'sub' }, documento(x.beneficiario_documento))) },
        { titulo: 'Chave PIX (Bolepix)', conteudo: (x) => x.pix_chave ?? el('span', { style: 'color:var(--vermelho)' }, 'sem chave') },
        { titulo: 'Boletos', dir: true, conteudo: (x) => numero(x.boletos) },
        { titulo: 'Faixa restante', dir: true, conteudo: (x) => el('span', { style: x.faixa_restante < 1000 ? 'color:var(--vermelho);font-weight:600' : '' }, numero(x.faixa_restante)) },
        { titulo: 'Situação', conteudo: (x) => el('span', {}, selo(x.ativa ? 'ativo' : 'suspenso', { ativo: ['Ativa', 'ok'], suspenso: ['Inativa', 'neutra'] }),
          x.padrao ? el('span', { class: 'sub' }, 'padrão') : null) },
      ],
      itens: c.itens,
      vazio: 'Nenhuma conta bancária cadastrada: sem ela não é possível emitir boletos.',
      aoClicar: pode('*') ? (x) => editarConta(x, recarregar) : null,
    })),

    el('div', { style: 'margin-top:18px' }, cartao('Tabela de preços padrão da plataforma',
      el('div', {},
        el('p', { style: 'color:var(--texto-2);font-size:13px;margin-bottom:12px' },
          'Vale para os clientes que não têm tabela própria. Cada cliente pode ter a sua em Clientes → Preços.'),
        el('div', { class: 'pares' },
          par('Tarifa de emissão', dinheiro(v.tarifa_emissao_centavos)),
          par('Tarifa de liquidação', dinheiro(v.tarifa_liquidacao_centavos)),
          par('Comissão', percentual(v.percentual_ppm)),
          par('Comissão mínima', dinheiro(v.comissao_minima_centavos)),
          par('Comissão máxima', v.comissao_maxima_centavos === null ? 'sem teto' : dinheiro(v.comissao_maxima_centavos)),
          par('Tarifa do repasse', dinheiro(v.tarifa_repasse_centavos)),
          par('Vigente desde', data(v.vigencia_inicio)))),
      pode('precos.editar') ? el('button', { class: 'botao', onclick: () => editarPrecoPadrao(v, recarregar) }, 'Nova tabela padrão') : null)),
  );
}

function editarConta(c, recarregar) {
  const novo = !c;
  const reais = (v) => (v === null || v === undefined ? '' : (v / 100).toFixed(2).replace('.', ','));
  const form = el('form', { onsubmit: (e) => e.preventDefault() },
    el('div', { class: 'linha-form' },
      campo({ nome: 'apelido', rotulo: 'Apelido da conta', valor: c?.apelido ?? '', obrigatorio: true }),
      campo({ nome: 'agencia', rotulo: 'Agência', valor: c?.agencia ?? '', obrigatorio: true }),
      campo({ nome: 'agencia_dv', rotulo: 'DV ag.', valor: c?.agencia_dv ?? '' }),
      campo({ nome: 'conta', rotulo: 'Conta', valor: c?.conta ?? '', obrigatorio: true }),
      campo({ nome: 'conta_dv', rotulo: 'DV conta', valor: c?.conta_dv ?? '' }),
      campo({ nome: 'cedente', rotulo: 'Código do beneficiário', valor: c?.cedente ?? '', obrigatorio: true }),
      campo({ nome: 'carteira', rotulo: 'Carteira', valor: c?.carteira ?? '09', ajuda: '09 = com registro' })),
    el('h3', { style: 'font-size:14px;margin:14px 0 8px' }, 'Beneficiário impresso no boleto'),
    el('div', { class: 'linha-form' },
      campo({ nome: 'beneficiario_nome', rotulo: 'Razão social', valor: c?.beneficiario_nome ?? '', obrigatorio: true }),
      campo({ nome: 'beneficiario_documento', rotulo: 'CNPJ', valor: c?.beneficiario_documento ?? '', obrigatorio: true }),
      campo({ nome: 'beneficiario_endereco', rotulo: 'Endereço', valor: c?.beneficiario_endereco ?? '' }),
      campo({ nome: 'beneficiario_cidade', rotulo: 'Cidade', valor: c?.beneficiario_cidade ?? '' }),
      campo({ nome: 'beneficiario_uf', rotulo: 'UF', valor: c?.beneficiario_uf ?? '', atributos: { maxlength: 2 } }),
      campo({ nome: 'beneficiario_cep', rotulo: 'CEP', valor: c?.beneficiario_cep ?? '' })),
    el('h3', { style: 'font-size:14px;margin:14px 0 8px' }, 'Bolepix e faixa de nosso número'),
    el('div', { class: 'linha-form' },
      campo({ nome: 'pix_chave', rotulo: 'Chave PIX da conta', valor: c?.pix_chave ?? '', ajuda: 'Usada no QR Code do Bolepix' }),
      campo({ nome: 'nosso_numero_inicial', rotulo: 'Início da faixa', tipo: 'number', valor: c?.nosso_numero_inicial ?? 1 }),
      campo({ nome: 'nosso_numero_final', rotulo: 'Fim da faixa', tipo: 'number', valor: c?.nosso_numero_final ?? 99999999999 })),
    el('h3', { style: 'font-size:14px;margin:14px 0 8px' }, 'Custo que o banco nos cobra (base da margem)'),
    el('div', { class: 'linha-form' },
      campo({ nome: 'custo_emissao', rotulo: 'Por boleto registrado (R$)', tipo: 'dinheiro', valor: reais(c?.custo_emissao_centavos ?? 0) }),
      campo({ nome: 'custo_liquidacao', rotulo: 'Por boleto liquidado (R$)', tipo: 'dinheiro', valor: reais(c?.custo_liquidacao_centavos ?? 0) }),
      campo({ nome: 'custo_pix', rotulo: 'Por PIX enviado (R$)', tipo: 'dinheiro', valor: reais(c?.custo_pix_centavos ?? 0) })),
    novo ? null : el('div', { class: 'linha-form', style: 'margin-top:12px' },
      campo({ nome: 'ativa', rotulo: 'Situação', tipo: 'select', valor: String(c.ativa), opcoes: [['1', 'Ativa'], ['0', 'Inativa']] }),
      campo({ nome: 'padrao', rotulo: 'Conta padrão', tipo: 'select', valor: String(c.padrao), opcoes: [['0', 'Não'], ['1', 'Sim']] })));

  const botao = el('button', { class: 'botao' }, novo ? 'Cadastrar conta' : 'Salvar');
  botao.addEventListener('click', () => acao(botao, async () => {
    const d = lerForm(form);
    if (novo) await api.post('/contas', d);
    else await api.patch(`/contas/${c.id}`, { ...d, versao: c.versao });
    m.fechar();
    toast(novo ? 'Conta cadastrada.' : 'Conta atualizada.', 'ok');
    recarregar();
  }));
  const m = modal({ titulo: novo ? 'Nova conta bancária' : `Conta ${c.apelido}`, largo: true, corpo: form,
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao] });
}

function editarPrecoPadrao(atual, recarregar) {
  const reais = (v) => (v === null || v === undefined ? '' : (v / 100).toFixed(2).replace('.', ','));
  const form = el('form', { class: 'linha-form', onsubmit: (e) => e.preventDefault() },
    campo({ nome: 'vigencia_inicio', rotulo: 'Vigente a partir de', tipo: 'date', valor: hojeIso(), obrigatorio: true }),
    campo({ nome: 'tarifa_emissao', rotulo: 'Tarifa de emissão (R$)', tipo: 'dinheiro', valor: reais(atual.tarifa_emissao_centavos) }),
    campo({ nome: 'tarifa_liquidacao', rotulo: 'Tarifa de liquidação (R$)', tipo: 'dinheiro', valor: reais(atual.tarifa_liquidacao_centavos) }),
    campo({ nome: 'percentual', rotulo: 'Comissão (%)', valor: ((atual.percentual_ppm || 0) / 10000).toString().replace('.', ',') }),
    campo({ nome: 'comissao_minima', rotulo: 'Comissão mínima (R$)', tipo: 'dinheiro', valor: reais(atual.comissao_minima_centavos) }),
    campo({ nome: 'comissao_maxima', rotulo: 'Comissão máxima (R$)', tipo: 'dinheiro', valor: reais(atual.comissao_maxima_centavos) }),
    campo({ nome: 'tarifa_repasse', rotulo: 'Tarifa do repasse (R$)', tipo: 'dinheiro', valor: reais(atual.tarifa_repasse_centavos) }));
  const botao = el('button', { class: 'botao' }, 'Salvar tabela padrão');
  botao.addEventListener('click', () => acao(botao, async () => {
    await api.post('/contas/precos-padrao', lerForm(form));
    m.fechar();
    toast('Tabela padrão atualizada.', 'ok');
    recarregar();
  }));
  const m = modal({ titulo: 'Tabela de preços padrão', largo: true, corpo: form,
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao] });
}
