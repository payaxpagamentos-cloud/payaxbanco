import { api, BASE, enviarImagem } from '../api.js';
import { el, limpar, campo, area, marcar, lerForm, toast, acao, icone, FORMAS, dataHora } from '../ui.js';

const FORMAS_LISTA = Object.keys(FORMAS);

/** Configurações da empresa: ligação com o IXC, multa e juros, desconto, caixa e comprovante. */
export async function telaConfiguracoes(ctx) {
  const base = `/empresas/${ctx.empresaId}`;
  const cartaoIxc = el('div', { class: 'cartao' });
  const cartaoRegras = el('div', { class: 'cartao' });
  const cartaoComprovante = el('div', { class: 'cartao' });
  const cartaoCliente = el('div', { class: 'cartao' });
  const cartaoAuditoria = el('div', { class: 'cartao' });
  limpar(ctx.conteudo, el('div', { class: 'coluna' }, cartaoIxc, cartaoRegras, cartaoComprovante, cartaoCliente, cartaoAuditoria));
  const somenteLeitura = !ctx.administra;

  async function carregar() {
    const c = await api.get(`${base}/configuracoes`);

    // ---- IXC ----
    const formIxc = el('form', { class: 'form' },
      el('div', { class: 'duas' },
        campo('Endereço do IXC', { name: 'ixc_url', value: c.ixc_url ?? '', placeholder: 'https://ixc.seuprovedor.com.br', disabled: somenteLeitura }),
        campo(c.ixc_token_definido ? 'Token (deixe vazio para manter o atual)' : 'Token do IXC (id:hash)',
          { name: 'ixc_token', type: 'password', autocomplete: 'new-password', disabled: somenteLeitura })),
      el('div', { class: 'duas' },
        campo('Conta/caixa no IXC (id, opcional)', { name: 'ixc_conta_id', value: c.ixc_conta_id ?? '', disabled: somenteLeitura }),
        marcar('Integração ligada', { name: 'ixc_ativo', checked: c.ixc_ativo, disabled: somenteLeitura })),
      marcar('Baixar a fatura no IXC assim que o recebimento é confirmado', { name: 'baixa_automatica', checked: c.baixa_automatica, disabled: somenteLeitura }),
      el('fieldset', {}, el('legend', {}, 'Tipo de recebimento no IXC por forma de pagamento'),
        el('p', { class: 'pequeno mudo' }, 'Informe o id do tipo de recebimento cadastrado no IXC. Em branco, a baixa vai sem o tipo.'),
        el('div', { class: 'tres' }, FORMAS_LISTA.map((f) => campo(FORMAS[f], { name: `tipo_${f}`, value: c.ixc_tipos_recebimento[f] ?? '', maxlength: 20, disabled: somenteLeitura })))));

    const salvarIxc = el('button', { class: 'btn primario' }, 'Salvar IXC');
    const testar = el('button', { class: 'btn', type: 'button' }, icone('sincronizar'), 'Testar conexão');
    testar.addEventListener('click', () => acao(testar, async () => {
      const r = await api.post(`${base}/configuracoes/ixc/testar`, {});
      toast(r.mensagem);
    }));
    formIxc.append(el('div', { class: 'linha entre' }, testar, somenteLeitura ? null : salvarIxc));
    formIxc.addEventListener('submit', (e) => {
      e.preventDefault();
      acao(salvarIxc, async () => {
        const d = lerForm(formIxc);
        await api.patch(`${base}/configuracoes`, {
          ixc_url: d.ixc_url, ixc_ativo: d.ixc_ativo, ixc_conta_id: d.ixc_conta_id, baixa_automatica: d.baixa_automatica,
          ...(d.ixc_token ? { ixc_token: d.ixc_token } : {}),
          ixc_tipos_recebimento: Object.fromEntries(FORMAS_LISTA.map((f) => [f, d[`tipo_${f}`]])),
        });
        toast('Configuração do IXC salva.');
        await carregar();
      });
    });
    limpar(cartaoIxc, el('h2', {}, 'IXC Provedor'),
      el('p', { class: 'mudo' }, 'O PDV consulta clientes e faturas no IXC e devolve a baixa de cada título recebido. O token é de um usuário do IXC criado só para o PDV (Configurações › Usuários › Token) e fica guardado cifrado.'),
      formIxc);

    // ---- Regras do balcão ----
    const formRegras = el('form', { class: 'form' },
      el('div', { class: 'tres' },
        campo('Multa por atraso (%)', { name: 'multa_percentual', inputmode: 'decimal', value: c.multa_percentual, disabled: somenteLeitura }),
        campo('Juros ao mês (%)', { name: 'juros_mes_percentual', inputmode: 'decimal', value: c.juros_mes_percentual, disabled: somenteLeitura }),
        campo('Desconto máximo (%)', { name: 'desconto_max_percentual', inputmode: 'decimal', value: c.desconto_max_percentual, disabled: somenteLeitura })),
      marcar('Exigir caixa aberto para receber', { name: 'exigir_caixa', checked: c.exigir_caixa, disabled: somenteLeitura }),
      marcar('Permitir recebimento sem fatura do IXC (avulso)', { name: 'permitir_avulso', checked: c.permitir_avulso, disabled: somenteLeitura }));
    const salvarRegras = el('button', { class: 'btn primario' }, 'Salvar regras');
    if (!somenteLeitura) formRegras.append(el('div', { class: 'linha entre' }, el('span', {}), salvarRegras));
    formRegras.addEventListener('submit', (e) => {
      e.preventDefault();
      acao(salvarRegras, async () => {
        await api.patch(`${base}/configuracoes`, lerForm(formRegras));
        toast('Regras salvas.');
        await carregar();
      });
    });
    limpar(cartaoRegras, el('h2', {}, 'Regras do balcão'),
      el('p', { class: 'mudo' }, 'A multa entra uma vez e os juros são proporcionais aos dias de atraso. O PDV mostra o valor já corrigido na hora de receber.'),
      formRegras);

    // ---- Comprovante ----
    const formComp = el('form', { class: 'form' },
      area('Cabeçalho (nome e dados que saem no topo)', { name: 'comprovante_cabecalho', rows: 3, maxlength: 300, disabled: somenteLeitura }, c.comprovante_cabecalho ?? ''),
      area('Rodapé', { name: 'comprovante_rodape', rows: 2, maxlength: 300, disabled: somenteLeitura }, c.comprovante_rodape ?? ''));
    const salvarComp = el('button', { class: 'btn primario' }, 'Salvar comprovante');
    if (!somenteLeitura) formComp.append(el('div', { class: 'linha entre' }, el('span', {}), salvarComp));
    formComp.addEventListener('submit', (e) => {
      e.preventDefault();
      acao(salvarComp, async () => {
        await api.patch(`${base}/configuracoes`, lerForm(formComp));
        toast('Comprovante salvo.');
        await carregar();
      });
    });
    limpar(cartaoComprovante, el('h2', {}, 'Comprovante do balcão'), el('p', { class: 'mudo' }, 'Texto impresso na bobina acima e abaixo dos valores.'), formComp);

    // ---- Tela do cliente ----
    const endereco = (u, padrao = '') => {
      const v2 = (u || padrao).trim();
      return !v2 ? '' : v2.startsWith('http') ? v2 : `${BASE}/${v2.replace(/^\//, '')}`;
    };
    /** Campo de imagem: pré-visualização, envio do arquivo e, para quem preferir, o endereço digitado. */
    const campoImagem = (tipo, rotulo, dica, valor, padrao, estilo) => {
      const previa2 = el('img', { src: endereco(valor, padrao), alt: rotulo, style: estilo, hidden: !endereco(valor, padrao) });
      const texto = el('input', { name: tipo === 'logo' ? 'logo_url' : 'autoatendimento_fundo', value: valor ?? '', placeholder: padrao || 'https://…',
        maxlength: 300, disabled: somenteLeitura, oninput: (e) => { previa2.src = endereco(e.target.value, padrao); previa2.hidden = !previa2.src; } });
      const arquivo = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true, onchange: async (e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        await acao(null, async () => {
          const r = await enviarImagem(`${base}/configuracoes/imagens/${tipo}`, f);
          toast('Imagem enviada.');
          texto.value = r.url;
          previa2.src = `${endereco(r.url)}?v=${Date.now()}`;
          previa2.hidden = false;
        });
      } });
      return el('div', { class: 'campo' }, rotulo,
        el('div', { class: 'pequeno mudo', style: 'font-weight:400;margin-bottom:6px' }, dica),
        previa2, texto, arquivo,
        somenteLeitura ? null : el('div', { class: 'linha', style: 'gap:8px;margin-top:8px' },
          el('button', { type: 'button', class: 'btn pequeno', onclick: () => arquivo.click() }, icone('baixar'), 'Enviar imagem'),
          valor ? el('button', { type: 'button', class: 'btn pequeno', onclick: () => { texto.value = ''; previa2.src = endereco('', padrao); previa2.hidden = !previa2.src; } }, 'Usar o padrão') : null));
    };

    const formCliente = el('form', { class: 'form' },
      campoImagem('logo', 'Logo da tela do cliente', 'PNG, JPEG ou WebP (até 5 MB). Também aceita um endereço https.',
        c.logo_url, 'img/logo-cliente.png', 'max-width:280px;max-height:90px;object-fit:contain;background:#fff;border:1px solid var(--border);border-radius:10px;padding:10px'),
      campoImagem('fundo', 'Imagem de fundo (propaganda)', 'A arte que fica atrás do painel de vidro, na tela inteira. Sem imagem, a tela usa o fundo azul do sistema.',
        c.autoatendimento_fundo, '', 'max-width:280px;max-height:150px;object-fit:cover;border:1px solid var(--border);border-radius:10px'),
      marcar('A arte de fundo já tem a marca do provedor (não repetir o logo na tela)',
        { name: 'autoatendimento_fundo_marca', checked: c.autoatendimento_fundo_marca, disabled: somenteLeitura }),
      el('div', { class: 'duas' },
        campo('Chamada (título grande)', { name: 'autoatendimento_titulo', value: c.autoatendimento_titulo ?? '', maxlength: 80, disabled: somenteLeitura,
          placeholder: 'Sua casa mais conectada.' }),
        campo('Frase abaixo da chamada', { name: 'autoatendimento_subtitulo', value: c.autoatendimento_subtitulo ?? '', maxlength: 120, disabled: somenteLeitura,
          placeholder: 'Internet para todos os seus momentos.' })),
      campo('Recado na tela do cliente (opcional)', { name: 'autoatendimento_mensagem', value: c.autoatendimento_mensagem ?? '', maxlength: 200, disabled: somenteLeitura,
        placeholder: 'Ex.: Pague aqui com cartão. Dúvidas? Chame o atendente.' }));
    const salvarCliente = el('button', { class: 'btn primario' }, 'Salvar tela do cliente');
    if (!somenteLeitura) formCliente.append(el('div', { class: 'linha entre' }, el('span', {}), salvarCliente));
    formCliente.addEventListener('submit', (e) => {
      e.preventDefault();
      acao(salvarCliente, async () => {
        await api.patch(`${base}/configuracoes`, lerForm(formCliente));
        toast('Tela do cliente salva.');
        await carregar();
      });
    });
    limpar(cartaoCliente, el('h2', {}, 'Tela do cliente (autoatendimento)'),
      el('p', { class: 'mudo' }, 'É a tela virada para quem vai pagar: o cliente digita o CPF/CNPJ, escolhe as faturas e passa o cartão na maquininha. Ligue a tela em Lojas, PDVs e usuários, no PDV onde ela vai ficar.'),
      formCliente);

    // ---- Auditoria ----
    if (ctx.supervisiona) {
      const { itens } = await api.get(`${base}/configuracoes/auditoria?limite=80`);
      limpar(cartaoAuditoria, el('h2', {}, 'Últimas ações no sistema'),
        el('table', { class: 'tabela' }, el('tbody', {}, itens.map((a) => el('tr', {},
          el('td', { class: 'pequeno mudo' }, dataHora(a.criado_em)),
          el('td', {}, a.usuario_nome ?? 'sistema'),
          el('td', {}, a.acao.replace(/_/g, ' ')),
          el('td', { class: 'pequeno mudo' }, a.detalhes ? JSON.stringify(a.detalhes) : ''))))));
    } else {
      limpar(cartaoAuditoria);
    }
    if (c.atualizado_em) cartaoIxc.append(el('p', { class: 'pequeno mudo' }, `Última alteração: ${dataHora(c.atualizado_em)}`));
  }

  await carregar();
}
