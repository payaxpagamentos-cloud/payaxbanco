import { api, pode } from '../app.js';
import { fichaPreco, formPreco } from './precos-comum.js';
import {
  el, montar, cartao, tabela, campo, lerForm, modal, toast, acao, aviso, selo, dinheiro, numero,
  percentual, data, documento, hojeIso, icone
} from '../../comum/ui.js';

const nomeBanco = (lista, codigo) => lista.find((b) => b.codigo === String(codigo).padStart(3, '0'))?.nome ?? `Banco ${codigo}`;

/** Nossas contas no banco e a tabela de preços padrão da plataforma. */
export default async function contas({ alvo, recarregar }) {
  const [c, p] = await Promise.all([api.get('/contas'), api.get('/contas/precos-padrao')]);
  const v = p.vigente;
  const par = (rot, val) => el('div', { class: 'par' }, el('span', { class: 'rot' }, rot), el('span', { class: 'val' }, val));

  montar(alvo, 
    el('div', { class: 'cabecalho-tela' },
      el('div', {}, el('h1', {}, 'Contas e preços'),
        el('p', {}, 'Os boletos de todos os clientes são registrados no convênio da PAY AX no banco; cada um leva o cliente como beneficiário final.')),
      pode('*') ? el('div', { class: 'acoes' }, el('button', { class: 'botao', onclick: () => editarConta(null, recarregar, c.bancos) }, icone('mais'), 'Nova conta')) : null),

    c.modo_banco === 'simulador'
      ? aviso('O banco está em modo SIMULADOR: os boletos são registrados localmente, com código de barras e QR válidos, mas o banco não é chamado. Configure as credenciais em Integrações para usar o ambiente real.', 'aviso')
      : aviso(`Conectado ao banco no ambiente de ${c.ambiente}.`, 'info'),
    el('p', { class: 'sub', style: 'margin-top:8px' }, 'Bancos homologados: ', c.bancos.filter((b) => b.homologado).map((b) => b.nome).join(', '),
      '. Em homologação: ', c.bancos.filter((b) => !b.homologado).map((b) => b.nome).join(', '), '.'),

    el('div', { style: 'margin-top:14px' }, tabela({
      colunas: [
        { titulo: 'Conta', conteudo: (x) => el('span', {}, el('span', { class: 'forte' }, x.apelido),
          el('span', { class: 'sub' }, `${nomeBanco(c.bancos, x.banco)} · Ag. ${x.agencia}${x.agencia_dv ? `-${x.agencia_dv}` : ''} · C/C ${x.conta}${x.conta_dv ? `-${x.conta_dv}` : ''} · carteira ${x.carteira}`)) },
        { titulo: 'Beneficiário', conteudo: (x) => el('span', {}, x.beneficiario_nome, el('span', { class: 'sub' }, documento(x.beneficiario_documento))) },
        { titulo: 'Chave PIX (Bolepix)', conteudo: (x) => x.pix_chave ?? el('span', { style: 'color:var(--vermelho)' }, 'sem chave') },
        { titulo: 'Tarifa do banco', dir: true, conteudo: (x) => el('span', {}, `Boleto ${dinheiro(x.custo_liquidacao_centavos ?? 0)}`,
          el('span', { class: 'sub' }, `Bolepix ${dinheiro(x.custo_bolepix_centavos ?? x.custo_liquidacao_centavos ?? 0)}`)) },
        { titulo: 'Boletos', dir: true, conteudo: (x) => numero(x.boletos) },
        { titulo: 'Faixa restante', dir: true, conteudo: (x) => el('span', { style: x.faixa_restante < 1000 ? 'color:var(--vermelho);font-weight:600' : '' }, numero(x.faixa_restante)) },
        { titulo: 'Situação', conteudo: (x) => el('span', {}, selo(x.ativa ? 'ativo' : 'suspenso', { ativo: ['Ativa', 'ok'], suspenso: ['Inativa', 'neutra'] }),
          x.padrao ? el('span', { class: 'sub' }, 'padrão') : null) },
      ],
      itens: c.itens,
      vazio: 'Nenhuma conta bancária cadastrada: sem ela não é possível emitir boletos.',
      aoClicar: pode('*') ? (x) => editarConta(x, recarregar, c.bancos) : null,
    })),

    el('div', { style: 'margin-top:18px' }, cartao('Tabela de preços padrão da plataforma',
      el('div', {},
        el('p', { style: 'color:var(--texto-2);font-size:13px;margin-bottom:12px' },
          'Vale para os clientes que não têm tabela própria. Cada cliente pode ter a sua em Clientes → Preços.'),
        fichaPreco(v)),
      pode('precos.editar') ? el('button', { class: 'botao', onclick: () => editarPrecoPadrao(v, recarregar) }, 'Nova tabela padrão') : null)),
  );
}

function editarConta(c, recarregar, bancos = []) {
  const novo = !c;
  const reais = (v) => (v === null || v === undefined ? '' : (v / 100).toFixed(2).replace('.', ','));
  const form = el('form', { onsubmit: (e) => e.preventDefault() },
    el('div', { class: 'linha-form' },
      campo({ nome: 'banco', rotulo: 'Banco', tipo: 'select', valor: String(c?.banco ?? '237').padStart(3, '0'),
        opcoes: bancos.map((b) => [b.codigo, b.homologado ? `${b.codigo} · ${b.nome}` : `${b.codigo} · ${b.nome} (em homologação)`]),
        ajuda: 'Só bancos homologados pela PAY AX podem ser usados' }),
      campo({ nome: 'apelido', rotulo: 'Apelido da conta', valor: c?.apelido ?? '', obrigatorio: true }),
      campo({ nome: 'agencia', rotulo: 'Agência', valor: c?.agencia ?? '', obrigatorio: true }),
      campo({ nome: 'agencia_dv', rotulo: 'DV ag.', valor: c?.agencia_dv ?? '' }),
      campo({ nome: 'conta', rotulo: 'Conta', valor: c?.conta ?? '', obrigatorio: true }),
      campo({ nome: 'conta_dv', rotulo: 'DV conta', valor: c?.conta_dv ?? '' }),
      campo({ nome: 'cedente', rotulo: 'Código da Empresa (convênio)', valor: c?.cedente ?? '', obrigatorio: true,
        ajuda: 'Fornecido pelo banco ao liberar a cobrança (no Bradesco, até 20 dígitos; vai no arquivo de remessa)' }),
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
      campo({ nome: 'rateio_contratado', rotulo: 'Como o cliente recebe', tipo: 'select', valor: String(c?.rateio_contratado ?? 0),
        opcoes: [['0', 'PIX da PAY AX (padrão)'], ['1', 'Rateio pelo banco (só com a autorização no convênio)']],
        ajuda: 'Use PIX. O rateio só depois de o banco liberar o serviço no convênio, e só para cliente com conta no mesmo banco.' }),
      campo({ nome: 'nosso_numero_inicial', rotulo: 'Início da faixa', tipo: 'number', valor: c?.nosso_numero_inicial ?? 1 }),
      campo({ nome: 'nosso_numero_final', rotulo: 'Fim da faixa', tipo: 'number', valor: c?.nosso_numero_final ?? 99999999999 })),
    el('h3', { style: 'font-size:14px;margin:14px 0 8px' }, 'Tarifa que o banco cobra da PAY AX'),
    el('p', { class: 'sub', style: 'margin:-4px 0 10px' }, 'É o nosso custo: o cliente paga a Tarifa Boleto ou a Tarifa Bolepix da tabela de preços, e a diferença é a margem da PAY AX.'),
    el('div', { class: 'linha-form' },
      campo({ nome: 'custo_liquidacao', rotulo: 'Por boleto pago', tipo: 'dinheiro', valor: reais(c?.custo_liquidacao_centavos ?? 0) }),
      campo({ nome: 'custo_bolepix', rotulo: 'Por Bolepix pago', tipo: 'dinheiro', valor: reais(c?.custo_bolepix_centavos), ajuda: 'Vazio = igual à do boleto' })),
    el('details', { style: 'margin-top:10px' },
      el('summary', { style: 'cursor:pointer;font-size:13px;color:var(--texto-2)' }, 'Outras tarifas do banco (só se o contrato cobrar)'),
      el('div', { class: 'linha-form', style: 'margin-top:10px' },
        campo({ nome: 'custo_emissao', rotulo: 'Por título registrado', tipo: 'dinheiro', valor: reais(c?.custo_emissao_centavos ?? 0) }),
        campo({ nome: 'custo_pix', rotulo: 'Por PIX enviado ao cliente', tipo: 'dinheiro', valor: reais(c?.custo_pix_centavos ?? 0) }),
        campo({ nome: 'custo_rateio', rotulo: 'Por rateio de crédito', tipo: 'dinheiro', valor: reais(c?.custo_rateio_centavos ?? 0) }))),
    novo ? null : el('div', { class: 'linha-form', style: 'margin-top:12px' },
      campo({ nome: 'ativa', rotulo: 'Situação', tipo: 'select', valor: String(c.ativa), opcoes: [['1', 'Ativa'], ['0', 'Inativa']] }),
      campo({ nome: 'padrao', rotulo: 'Conta padrão', tipo: 'select', valor: String(c.padrao), opcoes: [['0', 'Não'], ['1', 'Sim']] })));

  // Banco ainda em homologação aparece na lista, mas não pode ser escolhido.
  form.querySelectorAll('select[name="banco"] option').forEach((o) => { o.disabled = !bancos.find((b) => b.codigo === o.value)?.homologado; });
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
  const form = formPreco(atual);
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
