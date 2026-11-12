import { api } from '../api.js';
import { el, $, limpar, dinheiro, emReais, percentual, dataHora, icone, tabela, modal, toast, acao, etiqueta, lerForm, opcoes, confirmar, PERFIS } from '../ui.js';

const PROVEDORES = {
  simulado: 'Simulada (testes) — aprova tudo sem maquininha de verdade',
  ponte: 'Ponte TEF no caixa — pinpad ligado ao computador (PayGo, Elgin, Stone SDK…)',
  mercadopago: 'Mercado Pago Point — maquininha inteligente pela internet',
};

/** Configurações da loja, maquininhas de cartão, usuários e auditoria. */
export default async function configuracoes({ alvo, usuario, definirTitulo }) {
  const ehAdmin = usuario.perfil === 'admin';
  let aba = 'loja';

  function desenhar() {
    definirTitulo('Configurações', 'Loja, maquininhas e equipe');
    limpar(alvo,
      el('div', { class: 'abas' }, [['loja', 'Loja'], ['terminais', 'Terminais'], ['maquininhas', 'Maquininhas'], ...(ehAdmin ? [['usuarios', 'Usuários']] : []), ['auditoria', 'Auditoria']].map(([chave, rotulo]) =>
        el('button', { class: aba === chave ? 'ativa' : '', onclick: () => { aba = chave; desenhar(); } }, rotulo))),
      el('div', { id: 'corpo' }));
    recarregar();
  }

  async function recarregar() {
    const corpo = $('#corpo');
    if (aba === 'loja') return loja(corpo);
    if (aba === 'terminais') return terminais(corpo);
    if (aba === 'maquininhas') return maquininhas(corpo);
    if (aba === 'usuarios') return usuarios(corpo);
    return auditoria(corpo);
  }

  /* ---------- loja ---------- */
  async function loja(corpo) {
    const c = await api.get('/admin/config');
    limpar(corpo, el('section', { class: 'cartao', style: 'max-width: 780px' },
      el('form', { class: 'form', onsubmit: async (e) => {
        e.preventDefault();
        const d = lerForm(e.target);
        await acao(e.target.querySelector('button'), async () => {
          await api.patch('/admin/config', {
            nome_mercado: d.nome_mercado, condominio: d.condominio, cnpj: d.cnpj, endereco: d.endereco,
            pix_chave: d.pix_chave, pix_recebedor: d.pix_recebedor, pix_cidade: d.pix_cidade,
            limite_fiado_padrao_centavos: Math.round(Number(String(d.limite_fiado_padrao).replace(/\./g, '').replace(',', '.')) * 100),
            vencimento_fatura_dia: Number(d.vencimento_fatura_dia),
            alerta_validade_dias: Number(d.alerta_validade_dias),
            margem_padrao_bp: Math.round(Number(String(d.margem_padrao).replace(',', '.')) * 100),
            permitir_estoque_negativo: e.target.permitir_estoque_negativo.checked,
            terminal_pix: e.target.terminal_pix.checked,
            terminal_cartao: e.target.terminal_cartao.checked,
            terminal_conta: e.target.terminal_conta.checked,
            terminal_segundos_fim: Number(d.terminal_segundos_fim),
          });
          toast('Configurações salvas.');
        });
      } },
      el('h2', {}, 'Identificação'),
      el('div', { class: 'duas' },
        el('label', { class: 'campo' }, 'Nome do mercadinho', el('input', { name: 'nome_mercado', value: c.nome_mercado, required: true })),
        el('label', { class: 'campo' }, 'Condomínio', el('input', { name: 'condominio', value: c.condominio }))),
      el('div', { class: 'duas' },
        el('label', { class: 'campo' }, 'CNPJ', el('input', { name: 'cnpj', value: c.cnpj })),
        el('label', { class: 'campo' }, 'Endereço', el('input', { name: 'endereco', value: c.endereco }))),

      el('h2', {}, 'PIX'),
      el('p', { class: 'pequeno mudo', style: 'margin-top: -8px' }, 'A chave abaixo é usada no QR Code do PDV. O dinheiro cai direto na conta do mercadinho.'),
      el('label', { class: 'campo' }, 'Chave PIX', el('input', { name: 'pix_chave', value: c.pix_chave, placeholder: 'e-mail, telefone, CNPJ ou chave aleatória' })),
      el('div', { class: 'duas' },
        el('label', { class: 'campo' }, 'Nome do recebedor', el('input', { name: 'pix_recebedor', value: c.pix_recebedor, maxlength: 25 })),
        el('label', { class: 'campo' }, 'Cidade', el('input', { name: 'pix_cidade', value: c.pix_cidade, maxlength: 15 }))),

      el('h2', {}, 'Regras do dia a dia'),
      el('div', { class: 'duas' },
        el('label', { class: 'campo' }, 'Limite padrão da conta do morador (R$)', el('input', { name: 'limite_fiado_padrao', inputmode: 'decimal', value: emReais(c.limite_fiado_padrao_centavos) })),
        el('label', { class: 'campo' }, 'Dia de vencimento da fatura', el('input', { name: 'vencimento_fatura_dia', type: 'number', min: 1, max: 28, value: c.vencimento_fatura_dia }))),
      el('div', { class: 'duas' },
        el('label', { class: 'campo' }, 'Avisar validade com (dias)', el('input', { name: 'alerta_validade_dias', type: 'number', min: 1, max: 365, value: c.alerta_validade_dias })),
        el('label', { class: 'campo' }, 'Margem sugerida nas compras (%)', el('input', { name: 'margem_padrao', inputmode: 'decimal', value: (c.margem_padrao_bp / 100).toString().replace('.', ',') }))),
      el('label', { class: 'marcador' }, el('input', { type: 'checkbox', name: 'permitir_estoque_negativo', checked: c.permitir_estoque_negativo ? true : null }),
        'Deixar vender sem saldo no estoque (usar só enquanto o cadastro está sendo ajustado)'),

      el('h2', {}, 'Terminal do cliente'),
      el('p', { class: 'pequeno mudo', style: 'margin-top: -8px' }, 'Formas de pagamento que o terminal do balcão oferece. Dinheiro não entra: não há quem dê troco.'),
      el('label', { class: 'marcador' }, el('input', { type: 'checkbox', name: 'terminal_pix', checked: c.terminal_pix ? true : null }), 'PIX (QR Code na tela)'),
      el('label', { class: 'marcador' }, el('input', { type: 'checkbox', name: 'terminal_cartao', checked: c.terminal_cartao ? true : null }), 'Cartão na maquininha'),
      el('label', { class: 'marcador' }, el('input', { type: 'checkbox', name: 'terminal_conta', checked: c.terminal_conta ? true : null }), 'Conta do morador (com senha de 4 números)'),
      el('label', { class: 'campo' }, 'Segundos na tela de "compra concluída"', el('input', { name: 'terminal_segundos_fim', type: 'number', min: 3, max: 120, value: c.terminal_segundos_fim })),
      el('button', { class: 'btn primario' }, icone('check'), 'Salvar configurações'))));
  }

  /* ---------- terminais do balcão ---------- */
  async function terminais(corpo) {
    const lista = await api.get('/admin/terminais');
    limpar(corpo, el('section', { class: 'cartao' },
      el('div', { class: 'linha entre' },
        el('h2', {}, 'Terminais de autoatendimento'),
        el('button', { class: 'btn primario', onclick: novoTerminal }, icone('mais'), 'Novo terminal')),
      el('p', { class: 'pequeno mudo' }, 'O terminal é a tela do balcão em que o próprio cliente passa os produtos e paga. '
        + 'Abra o endereço do sistema com /pdv no fim (por exemplo, https://seu-dominio/mercadinho/pdv/) no aparelho e digite o código de pareamento uma única vez.'),
      tabela([
        { titulo: 'Terminal', celula: (t) => el('span', {}, el('div', { class: 'destaque' }, t.nome),
          el('div', { class: 'pequeno mudo' }, t.pareado_em ? `pareado em ${dataHora(t.pareado_em)}` : 'aguardando pareamento')) },
        { titulo: 'Último uso', celula: (t) => dataHora(t.ultimo_uso) },
        { titulo: 'Compras', direita: true, celula: (t) => t.vendas },
        { titulo: 'Situação', direita: true, celula: (t) => etiqueta(t.ativo ? 'ativo' : 'desativado', t.ativo ? 'ok' : 'erro') },
        { titulo: '', direita: true, celula: (t) => el('span', { class: 'linha fim' },
          el('button', { class: 'btn pequeno', onclick: (e) => { e.stopPropagation(); novoCodigo(t); } }, 'Novo código'),
          el('button', { class: 'btn pequeno', onclick: async (e) => {
            e.stopPropagation();
            if (t.ativo && !await confirmar('Desativar o terminal?', 'O aparelho para de funcionar na hora e precisa de um código novo para voltar.', 'Desativar', true)) return;
            await api.patch(`/admin/terminais/${t.id}`, { ativo: !t.ativo });
            recarregar();
          } }, t.ativo ? 'Desativar' : 'Ativar')) },
      ], lista, { vazio: 'Nenhum terminal cadastrado ainda.' })));
  }

  const mostrarCodigo = (nome, codigo) => modal('Código de pareamento', (fechar) => [
    el('p', { class: 'mudo' }, `Digite este código no terminal "${nome}". Ele aparece uma única vez — se perder, gere outro.`),
    el('div', { class: 'cartao sem-brilho centro', style: 'padding: 26px' },
      el('div', { class: 'display', style: 'font-size: 38px; letter-spacing: .18em' }, codigo)),
    el('p', { class: 'pequeno mudo' }, 'No aparelho do balcão, abra o endereço do sistema terminado em /pdv/ e informe o código.'),
    el('div', { class: 'linha fim' }, el('button', { class: 'btn primario', onclick: () => fechar() }, 'Anotei')),
  ]);

  const novoTerminal = () => modal('Novo terminal', (fechar) => el('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      await acao(e.target.querySelector('button[type=submit]'), async () => {
        const r = await api.post('/admin/terminais', lerForm(e.target));
        fechar();
        recarregar();
        mostrarCodigo(r.terminal.nome, r.codigo);
      });
    },
  },
  el('label', { class: 'campo' }, 'Nome', el('input', { name: 'nome', required: true, autofocus: true, placeholder: 'Ex.: Balcão do mercadinho' })),
  el('div', { class: 'linha fim' },
    el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
    el('button', { type: 'submit', class: 'btn primario' }, 'Cadastrar'))));

  const novoCodigo = async (t) => {
    if (!await confirmar('Gerar um código novo?', `O terminal "${t.nome}" para de funcionar até ser pareado de novo com o código novo.`, 'Gerar código')) return;
    const r = await api.post(`/admin/terminais/${t.id}/codigo`, {});
    recarregar();
    mostrarCodigo(t.nome, r.codigo);
  };

  /* ---------- maquininhas ---------- */
  async function maquininhas(corpo) {
    const lista = await api.get('/admin/maquininhas');
    const transacoes = await api.get('/admin/transacoes?limite=30');
    limpar(corpo,
      el('section', { class: 'cartao' },
        el('div', { class: 'linha entre' },
          el('h2', {}, 'Maquininhas de cartão'),
          el('button', { class: 'btn primario', onclick: () => editarMaquininha() }, icone('mais'), 'Nova maquininha')),
        el('p', { class: 'pequeno mudo' }, 'O PDV manda a cobrança para a maquininha e só fecha a venda quando a operação é aprovada. A taxa e o prazo informados aqui viram o recebível no financeiro.'),
        tabela([
          { titulo: 'Maquininha', celula: (m) => el('span', {}, el('div', { class: 'destaque' }, m.nome), el('div', { class: 'pequeno mudo' }, m.identificador ?? m.url ?? '—')) },
          { titulo: 'Tipo', celula: (m) => etiqueta(m.provedor, m.provedor === 'simulado' ? 'aviso' : 'info') },
          { titulo: 'Débito', direita: true, celula: (m) => `${percentual(m.taxa_debito_bp)} · D+${m.prazo_debito_dias}` },
          { titulo: 'Crédito', direita: true, celula: (m) => `${percentual(m.taxa_credito_bp)} · D+${m.prazo_credito_dias}` },
          { titulo: 'Parcelado', direita: true, celula: (m) => percentual(m.taxa_parcelado_bp) },
          { titulo: 'Aprovadas', direita: true, celula: (m) => m.aprovadas },
          { titulo: '', direita: true, celula: (m) => el('span', { class: 'linha fim' },
            el('button', { class: 'btn pequeno', onclick: async (e) => {
              e.stopPropagation();
              await acao(e.target, async () => {
                const r = await api.post(`/admin/maquininhas/${m.id}/testar`, {});
                toast(r.mensagem);
              });
            } }, 'Testar'),
            m.ativa ? etiqueta('ativa', 'ok') : etiqueta('desativada')) },
        ], lista, { aoClicar: editarMaquininha, vazio: 'Nenhuma maquininha cadastrada.' })),
      el('section', { class: 'cartao' },
        el('h2', {}, 'Últimas cobranças no cartão'),
        tabela([
          { titulo: 'Quando', celula: (t) => dataHora(t.criada_em) },
          { titulo: 'Maquininha', celula: (t) => t.maquininha },
          { titulo: 'Venda', celula: (t) => (t.venda_id ? `#${t.venda_id}` : '—') },
          { titulo: 'Forma', celula: (t) => `${t.forma}${t.parcelas > 1 ? ` ${t.parcelas}x` : ''}` },
          { titulo: 'Valor', direita: true, celula: (t) => dinheiro(t.valor_centavos) },
          { titulo: 'Taxa', direita: true, celula: (t) => dinheiro(t.taxa_centavos) },
          { titulo: 'Líquido', direita: true, celula: (t) => dinheiro(t.liquido_centavos) },
          { titulo: 'Situação', direita: true, celula: (t) => etiqueta(t.status, t.status === 'aprovada' ? 'ok' : t.status === 'pendente' ? 'aviso' : 'erro') },
        ], transacoes, { vazio: 'Nenhuma cobrança registrada.' })));
  }

  const editarMaquininha = (m = null) => modal(m ? 'Editar maquininha' : 'Nova maquininha', (fechar) => {
    const provedor = el('select', { name: 'provedor' }, opcoes(Object.entries(PROVEDORES).map(([id, nome]) => ({ id, nome })), { selecionado: m?.provedor ?? 'simulado' }));
    const ajuda = el('p', { class: 'pequeno mudo' });
    const campoUrl = el('label', { class: 'campo' }, 'Endereço da ponte TEF', el('input', { name: 'url', value: m?.url ?? '', placeholder: 'http://127.0.0.1:9090' }));
    const campoSerie = el('label', { class: 'campo' }, 'Número de série / device id', el('input', { name: 'identificador', value: m?.identificador ?? '' }));
    const campoToken = el('label', { class: 'campo' }, 'Token de acesso', el('input', { name: 'token', type: 'password', placeholder: m?.tem_token ? 'já cadastrado — preencha para trocar' : 'cole aqui' }));
    const atualizar = () => {
      const p = provedor.value;
      campoUrl.classList.toggle('oculto', p !== 'ponte');
      campoSerie.classList.toggle('oculto', p === 'ponte');
      campoToken.classList.toggle('oculto', p === 'simulado');
      ajuda.textContent = {
        simulado: 'Toda cobrança é aprovada na hora. Use para treinar a equipe e testar o fluxo do caixa.',
        ponte: 'O sistema chama um agente HTTP instalado no computador do caixa, que conversa com o pinpad. O protocolo esperado está no README.',
        mercadopago: 'Informe o número de série da Point e o token de acesso da conta. A cobrança aparece na tela da maquininha.',
      }[p];
    };
    provedor.addEventListener('change', atualizar);
    setTimeout(atualizar);
    return el('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      const d = lerForm(e.target);
      if (!d.token) delete d.token;
      if (m) d.ativa = e.target.ativa.checked;
      await acao(e.target.querySelector('button[type=submit]'), async () => {
        if (m) await api.patch(`/admin/maquininhas/${m.id}`, d);
        else await api.post('/admin/maquininhas', d);
        toast('Maquininha salva.');
        fechar();
        recarregar();
      });
    } },
    el('label', { class: 'campo' }, 'Nome', el('input', { name: 'nome', required: true, value: m?.nome ?? '', placeholder: 'Ex.: Maquininha do caixa 1', autofocus: true })),
    el('label', { class: 'campo' }, 'Tipo', provedor),
    ajuda,
    campoUrl, campoSerie, campoToken,
    el('h3', {}, 'Taxas e prazos da adquirente'),
    el('div', { class: 'tres' },
      el('label', { class: 'campo' }, 'Débito (%)', el('input', { name: 'taxa_debito_bp', type: 'number', step: 1, value: m?.taxa_debito_bp ?? 149 })),
      el('label', { class: 'campo' }, 'Crédito (%)', el('input', { name: 'taxa_credito_bp', type: 'number', step: 1, value: m?.taxa_credito_bp ?? 349 })),
      el('label', { class: 'campo' }, 'Parcelado (%)', el('input', { name: 'taxa_parcelado_bp', type: 'number', step: 1, value: m?.taxa_parcelado_bp ?? 449 }))),
    el('p', { class: 'pequeno mudo' }, 'Informe as taxas em pontos-base: 349 = 3,49%.'),
    el('div', { class: 'duas' },
      el('label', { class: 'campo' }, 'Prazo do débito (dias)', el('input', { name: 'prazo_debito_dias', type: 'number', min: 0, value: m?.prazo_debito_dias ?? 1 })),
      el('label', { class: 'campo' }, 'Prazo do crédito (dias)', el('input', { name: 'prazo_credito_dias', type: 'number', min: 0, value: m?.prazo_credito_dias ?? 30 }))),
    m ? el('label', { class: 'marcador' }, el('input', { type: 'checkbox', name: 'ativa', checked: m.ativa ? true : null }), 'Maquininha ativa no PDV') : null,
    el('div', { class: 'linha fim' },
      el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
      el('button', { type: 'submit', class: 'btn primario' }, 'Salvar')));
  });

  /* ---------- usuários ---------- */
  async function usuarios(corpo) {
    const lista = await api.get('/admin/usuarios');
    limpar(corpo, el('section', { class: 'cartao' },
      el('div', { class: 'linha entre' },
        el('h2', {}, 'Equipe'),
        el('button', { class: 'btn primario', onclick: () => editarUsuario() }, icone('mais'), 'Novo usuário')),
      tabela([
        { titulo: 'Nome', celula: (u) => el('span', {}, el('div', { class: 'destaque' }, u.nome), el('div', { class: 'pequeno mudo' }, u.email)) },
        { titulo: 'Perfil', celula: (u) => etiqueta(PERFIS[u.perfil] ?? u.perfil, u.perfil === 'admin' ? 'info' : null) },
        { titulo: 'Morador', celula: (u) => u.morador ?? '—' },
        { titulo: 'Último acesso', celula: (u) => dataHora(u.ultimo_acesso) },
        { titulo: '', direita: true, celula: (u) => (u.ativo ? etiqueta('ativo', 'ok') : etiqueta('inativo', 'erro')) },
      ], lista, { aoClicar: (u) => (u.perfil === 'morador' ? toast('O acesso do morador é editado na ficha dele.') : editarUsuario(u)) })));
  }

  const editarUsuario = (u = null) => modal(u ? `Editar ${u.nome}` : 'Novo usuário', (fechar) => el('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      const d = lerForm(e.target);
      if (u) { d.ativo = e.target.ativo.checked; if (!d.senha) delete d.senha; }
      await acao(e.target.querySelector('button[type=submit]'), async () => {
        if (u) await api.patch(`/admin/usuarios/${u.id}`, d);
        else await api.post('/admin/usuarios', d);
        toast('Usuário salvo.');
        fechar();
        recarregar();
      });
    },
  },
  el('label', { class: 'campo' }, 'Nome', el('input', { name: 'nome', required: true, value: u?.nome ?? '', autofocus: true })),
  u ? null : el('label', { class: 'campo' }, 'E-mail', el('input', { name: 'email', type: 'email', required: true })),
  el('div', { class: 'duas' },
    el('label', { class: 'campo' }, 'Telefone', el('input', { name: 'telefone', inputmode: 'tel', value: u?.telefone ?? '' })),
    el('label', { class: 'campo' }, 'Perfil', el('select', { name: 'perfil' }, opcoes(
      Object.entries(PERFIS).filter(([id]) => id !== 'morador').map(([id, nome]) => ({ id, nome })), { selecionado: u?.perfil ?? 'caixa' })))),
  el('label', { class: 'campo' }, u ? 'Nova senha (deixe em branco para manter)' : 'Senha', el('input', { name: 'senha', type: 'text', minlength: 8, required: !u, placeholder: 'mínimo de 8 caracteres' })),
  u ? el('label', { class: 'marcador' }, el('input', { type: 'checkbox', name: 'ativo', checked: u.ativo ? true : null }), 'Usuário ativo') : null,
  el('p', { class: 'pequeno mudo' }, 'Gerente vê tudo menos usuários; caixa opera o PDV; estoquista cuida de produtos e compras.'),
  el('div', { class: 'linha fim' },
    el('button', { type: 'button', class: 'btn fantasma', onclick: () => fechar() }, 'Voltar'),
    el('button', { type: 'submit', class: 'btn primario' }, 'Salvar'))));

  /* ---------- auditoria ---------- */
  async function auditoria(corpo) {
    const lista = await api.get('/admin/auditoria?limite=200');
    limpar(corpo, el('section', { class: 'cartao' },
      el('h2', {}, 'O que foi feito no sistema'),
      tabela([
        { titulo: 'Quando', celula: (a) => dataHora(a.criado_em) },
        { titulo: 'Quem', celula: (a) => a.usuario ?? '—' },
        { titulo: 'Ação', celula: (a) => etiqueta(a.acao) },
        { titulo: 'Detalhes', celula: (a) => a.detalhes ?? '—' },
      ], lista, { vazio: 'Nada registrado ainda.' })));
  }

  desenhar();
}
