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
      campo({ nome: 'mensagem', rotulo: 'Mensagem padrão no boleto', valor: cfg.mensagem ?? '', atributos: { maxlength: 160 } })),

    el('h3', { style: 'margin:22px 0 4px' }, 'Entrega do boleto (quando é a PAY AX que monta)'),
    el('p', { style: 'margin:0 0 10px;font-size:12.5px;color:var(--texto-3)' }, 'O sistema do cliente continua gerando a fatura e cobrando. O boleto da PAY AX chega ao atendimento e ao assinante pelos caminhos abaixo. Ligue um de cada vez, depois de o diagnóstico confirmar que o sistema do cliente aceita.'),
    el('div', { class: 'linha-form cols-3' },
      campo({ nome: 'gravar_link', rotulo: 'Gravar o link do PDF no título', tipo: 'select', valor: cfg.gravar_link ? '1' : '0', opcoes: [['0', 'Não'], ['1', 'Sim (campo "Link gateway")']],
        ajuda: 'O atendimento abre o boleto pelo próprio título' }),
      campo({ nome: 'anexar_pdf', rotulo: 'Guardar o PDF no sistema do cliente', tipo: 'select', valor: cfg.anexar_pdf ?? 'nao',
        opcoes: [['nao', 'Não'], ['cliente', 'Nos arquivos do cliente'], ['titulo', 'Nos arquivos da fatura (se o diagnóstico aceitar)']],
        ajuda: 'O atendimento anexa o arquivo na conversa, sem link' }),
      campo({ nome: 'acompanhar', rotulo: 'Acompanhar a fatura', tipo: 'select', valor: cfg.acompanhar === false ? '0' : '1', opcoes: [['1', 'Sim'], ['0', 'Não']],
        ajuda: 'Fatura cancelada, alterada ou paga por outro meio: o boleto é baixado (e reemitido, se mudou)' })),

    el('h3', { style: 'margin:22px 0 4px' }, 'E-mail com o boleto em PDF anexado'),
    el('p', { style: 'margin:0 0 10px;font-size:12.5px;color:var(--texto-3)' }, 'Sai pelo servidor de e-mail do próprio cliente, em nome dele, quando o banco confirma o registro. Sem link: o PDF vai anexado.'),
    el('div', { class: 'linha-form cols-3' },
      campo({ nome: 'email_ativo', rotulo: 'Enviar por e-mail', tipo: 'select', valor: cfg.email?.ativo ? '1' : '0', opcoes: [['0', 'Não'], ['1', 'Sim']] }),
      campo({ nome: 'email_host', rotulo: 'Servidor de e-mail (SMTP)', valor: cfg.email?.host ?? '', atributos: { placeholder: 'smtp.provedor.com.br' } }),
      campo({ nome: 'email_porta', rotulo: 'Porta', tipo: 'select', valor: String(cfg.email?.porta ?? 587), opcoes: [['587', '587 (padrão)'], ['465', '465 (SSL)'], ['2525', '2525'], ['25', '25']] }),
      campo({ nome: 'email_remetente', rotulo: 'E-mail remetente', valor: cfg.email?.remetente ?? '', atributos: { placeholder: 'financeiro@provedor.com.br' } }),
      campo({ nome: 'email_nome', rotulo: 'Nome do remetente', valor: cfg.email?.nome ?? '', ajuda: 'Vazio = o nome fantasia do cliente' }),
      campo({ nome: 'email_usuario', rotulo: 'Usuário do e-mail', valor: cfg.email?.usuario ?? '', ajuda: 'Vazio = o próprio e-mail remetente' }),
      campo({ nome: 'email_senha', rotulo: 'Senha do e-mail', tipo: 'password', ajuda: cfg.email?.host ? 'Deixe vazio para manter a senha atual' : 'Fica cifrada, como o token' })),

    el('h3', { style: 'margin:22px 0 4px' }, 'Baixa no sistema do cliente'),
    el('div', { class: 'linha-form' },
      campo({ nome: 'baixa_conta', rotulo: 'Conta para a baixa (ID)', valor: cfg.baixa_conta ?? '', ajuda: 'Vazio = a conta da carteira de cobrança do título' }),
      campo({ nome: 'baixa_planejamento', rotulo: 'Planejamento analítico (ID)', valor: cfg.baixa_planejamento ?? '', ajuda: 'Vazio = o do próprio título' })));
  const botao = el('button', { class: 'botao' }, 'Salvar');
  botao.addEventListener('click', () => acao(botao, async () => {
    await api.put(`/integracoes/ixc/${cliente.id}`, lerForm(form));
    m.fechar();
    toast('Sistema do cliente configurado.', 'ok');
    recarregar();
  }));
  const m = modal({ titulo: `Sistema de gestão · ${cliente.nome_fantasia || cliente.razao_social}`, largo: true,
    corpo: [cfg.entrega_alerta ? aviso(cfg.entrega_alerta, 'erro') : null,
      aviso('O token é cifrado antes de ser gravado. Use um usuário técnico só para a PAY AX no sistema do cliente.', 'info'), form],
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

/**
 * Diagnóstico da ligação com o sistema do cliente, num título de TESTE: mostra, passo a passo, o que o sistema
 * dele aceita (ler, gravar o nosso número e o link, anexar o PDF). Só grava o que for marcado.
 */
export function diagnosticarSistema(cliente) {
  const form = el('form', { onsubmit: (e) => e.preventDefault() },
    el('div', { class: 'linha-form' },
      campo({ nome: 'titulo_id', rotulo: 'Título de teste no sistema do cliente (ID)', obrigatorio: true, ajuda: 'O número da fatura de teste (Contas a receber → ID)', atributos: { inputmode: 'numeric' } })),
    el('div', { class: 'linha-form cols-3', style: 'margin-top:12px' },
      campo({ nome: 'gravar_nosso_numero', rotulo: 'Gravar o nosso número', tipo: 'select', valor: '0', opcoes: [['0', 'Não testar'], ['1', 'Testar']] }),
      campo({ nome: 'gravar_link', rotulo: 'Gravar o link do PDF', tipo: 'select', valor: '0', opcoes: [['0', 'Não testar'], ['1', 'Testar']] }),
      campo({ nome: 'anexar_cliente', rotulo: 'Anexar PDF no cliente', tipo: 'select', valor: '0', opcoes: [['0', 'Não testar'], ['1', 'Testar']] }),
      campo({ nome: 'anexar_titulo', rotulo: 'Anexar PDF na fatura', tipo: 'select', valor: '0', opcoes: [['0', 'Não testar'], ['1', 'Testar']] })));
  const saida = el('div', { style: 'margin-top:14px' });
  const botao = el('button', { class: 'botao' }, icone('atualizar'), 'Rodar o diagnóstico');
  botao.addEventListener('click', () => acao(botao, async () => {
    saida.replaceChildren(el('p', { style: 'font-size:12.5px;color:var(--texto-3)' }, 'Falando com o sistema do cliente…'));
    const r = await api.post(`/integracoes/ixc/${cliente.id}/diagnostico`, lerForm(form));
    saida.replaceChildren(...r.passos.map((p) => el('div', { style: 'padding:8px 0;border-top:1px solid var(--borda, #e3e6ea)' },
      el('strong', { style: `color:${p.ok ? '#17803d' : '#b42318'}` }, `${p.ok ? '✔' : '✖'} ${p.passo}`),
      el('div', { style: 'margin-top:2px;word-break:break-word' }, p.detalhe ?? ''),
      p.dados ? el('pre', { style: 'margin:6px 0 0;font-size:12px;white-space:pre-wrap;word-break:break-word;opacity:.85' },
        Object.entries(p.dados).map(([k, v]) => `${k}: ${v === null || v === '' ? '—' : v}`).join('\n')) : null)));
  }));
  const m = modal({ titulo: `Diagnóstico do sistema · ${cliente.nome_fantasia || cliente.razao_social}`, largo: true,
    corpo: [aviso('Use um título de TESTE. "Ler" não muda nada; cada teste de gravação altera só aquele título, e o resultado é conferido na hora. Depois, confira também na tela do sistema do cliente.', 'aviso'), form, saida],
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Fechar'), botao] });
}
