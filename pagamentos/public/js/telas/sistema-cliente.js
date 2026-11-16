/*
 * Sistema de gestão do CLIENTE (o que ele usa — hoje, os homologados: IXC): configurar, testar e importar,
 * tudo a partir do cadastro do cliente. Na tela, sempre "o sistema"; o nome dele aparece onde é escolhido.
 */
import { api } from '../app.js';
import { el, campo, lerForm, modal, toast, acao, aviso, numero, hojeIso, somarDias, R, icone } from '../../comum/ui.js';

/** Sistemas de gestão homologados pela PAY AX. */
const SISTEMAS = [{ id: 'ixc', nome: 'IXC Provedor' }];
export const nomeSistema = (id) => SISTEMAS.find((x) => x.id === (id ?? 'ixc'))?.nome ?? 'IXC Provedor';

export async function testarSistema(cliente, recarregar) {
  const r = await api.post(`/integracoes/ixc/${cliente.id}/testar`, {});
  toast(`Sistema conectado · ${numero(r.clientes)} cliente(s) na base.`, 'ok');
  recarregar();
}

export function configurarSistema(cliente, atual, recarregar) {
  const cfg = atual?.config ?? {};
  const form = el('form', { onsubmit: (e) => e.preventDefault() },
    el('div', { class: 'linha-form' },
      campo({ nome: 'sistema', rotulo: 'Sistema de gestão', tipo: 'select', valor: cfg.sistema ?? 'ixc', opcoes: SISTEMAS.map((x) => [x.id, x.nome]),
        ajuda: 'Só os sistemas homologados pela PAY AX' }),
      campo({ nome: 'url', rotulo: 'Endereço do sistema', valor: cfg.url ?? '', obrigatorio: true, ajuda: 'Ex.: https://ixc.provedor.com.br' }),
      campo({ nome: 'token', rotulo: 'Token de acesso', tipo: 'password', ajuda: atual?.configurada ? 'Deixe vazio para manter o token atual' : 'Gerado no sistema do cliente (IXC: Configurações → Usuários → Token)' })),
    el('div', { class: 'linha-form cols-3', style: 'margin-top:12px' },
      campo({ nome: 'tipo_padrao', rotulo: 'Tipo do boleto', tipo: 'select', valor: cfg.tipo_padrao ?? 'bolepix', opcoes: Object.entries(R.tipoBoleto) }),
      campo({ nome: 'juros_mes', rotulo: 'Juros ao mês (%)', valor: cfg.juros_mes ?? 1, ajuda: 'Máximo 1% ao mês' }),
      campo({ nome: 'multa', rotulo: 'Multa (%)', valor: cfg.multa ?? 2, ajuda: 'Máximo 2% (Código de Defesa do Consumidor)' }),
      campo({ nome: 'dias_a_frente', rotulo: 'Importar vencimentos até (dias)', tipo: 'number', valor: cfg.dias_a_frente ?? 10 }),
      campo({ nome: 'importacao_automatica', rotulo: 'Importação automática', tipo: 'select', valor: cfg.importacao_automatica ? '1' : '0', opcoes: [['0', 'Desligada'], ['1', 'Ligada (a cada 15 minutos)']] }),
      campo({ nome: 'anotar_no_ixc', rotulo: 'Gravar o boleto no título do sistema', tipo: 'select', valor: cfg.anotar_no_ixc === false ? '0' : '1', opcoes: [['1', 'Sim'], ['0', 'Não']] })),
    el('div', { class: 'linha-form cols-3', style: 'margin-top:12px' },
      campo({ nome: 'numeracao', rotulo: 'Quem monta e envia o boleto', tipo: 'select', valor: cfg.numeracao ?? 'payax',
        opcoes: [['ixc', 'O sistema do cliente (layout dele; a PAY AX só registra)'], ['payax', 'A PAY AX (ficha da PAY AX)']],
        ajuda: 'Pelo sistema do cliente, o boleto só é registrado se o código dele for igual ao calculado pelo banco.' }),
      campo({ nome: 'faixa_inicio', rotulo: 'Nosso número: início da faixa', valor: cfg.faixa_inicio ?? '', ajuda: 'A mesma da carteira PAY AX no sistema' }),
      campo({ nome: 'faixa_fim', rotulo: 'Nosso número: fim da faixa', valor: cfg.faixa_fim ?? '', ajuda: 'Faixa só deste cliente' })),
    el('div', { class: 'linha-form', style: 'margin-top:12px' },
      campo({ nome: 'carteiras', rotulo: 'Carteira de cobrança PAY AX no sistema (ID)', valor: (cfg.carteiras ?? []).join(', '),
        ajuda: 'Só os títulos desta carteira viram boleto. Vazio = todas (cuidado se o provedor tiver outro banco ou gateway).',
        atributos: { placeholder: 'Ex.: 12' } }),
      campo({ nome: 'mensagem', rotulo: 'Mensagem padrão no boleto', valor: cfg.mensagem ?? '', atributos: { maxlength: 160 } })));
  const botao = el('button', { class: 'botao' }, 'Salvar');
  botao.addEventListener('click', () => acao(botao, async () => {
    await api.put(`/integracoes/ixc/${cliente.id}`, lerForm(form));
    m.fechar();
    toast('Sistema do cliente configurado.', 'ok');
    recarregar();
  }));
  const m = modal({ titulo: `Sistema de gestão · ${cliente.nome_fantasia || cliente.razao_social}`, largo: true,
    corpo: [aviso('O token é cifrado antes de ser gravado. Use um usuário técnico só para a PAY AX no sistema do cliente.', 'info'), form],
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao] });
}

export function importarSistema(cliente, recarregar) {
  const form = el('form', { class: 'linha-form', onsubmit: (e) => e.preventDefault() },
    campo({ nome: 'de', rotulo: 'Vencimento de', tipo: 'date', valor: hojeIso() }),
    campo({ nome: 'ate', rotulo: 'até', tipo: 'date', valor: somarDias(hojeIso(), 10) }),
    campo({ nome: 'limite', rotulo: 'Máximo de títulos', tipo: 'number', valor: 200 }));
  const botao = el('button', { class: 'botao' }, icone('importar'), 'Importar e emitir');
  botao.addEventListener('click', () => acao(botao, async () => {
    const r = await api.post(`/integracoes/ixc/${cliente.id}/importar`, lerForm(form));
    m.fechar();
    toast(`${r.criados} boleto(s) emitido(s) · ${r.ignorados} ignorado(s) · ${r.erros} erro(s).`, r.erros ? 'erro' : 'ok');
    recarregar();
  }));
  const m = modal({ titulo: `Importar títulos do sistema · ${cliente.nome_fantasia || cliente.razao_social}`,
    corpo: [aviso('Cada título em aberto no sistema do cliente vira um boleto. Títulos já importados são ignorados, então pode rodar quantas vezes quiser.', 'info'), form],
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao] });
}
